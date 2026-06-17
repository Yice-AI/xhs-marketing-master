import os
import base64
import hashlib
import json
import requests
import time
import httpx
import uuid
from pathlib import Path
from openai import OpenAI, APIConnectionError, APITimeoutError, InternalServerError, RateLimitError
from typing import Optional, List, Callable, Dict, Any
import re
from datetime import datetime

from backend.config import settings

IMAGE_REQUEST_TIMEOUT_SECONDS = 300
IMAGE_RATE_LIMIT_RETRIES = 2
IMAGE_RATE_LIMIT_BACKOFF_SECONDS = 4
IMAGE_EDIT_TRANSIENT_RETRIES = 2
IMAGE_EDIT_TRANSIENT_BACKOFF_SECONDS = 12
LOGO_REPLACEMENT_EDIT_TIMEOUT_SECONDS = int(os.getenv("LOGO_REPLACEMENT_EDIT_TIMEOUT_SECONDS", "300"))
LOGO_REPLACEMENT_EDIT_RETRIES = int(os.getenv("LOGO_REPLACEMENT_EDIT_RETRIES", "0"))
TUZI_IMAGE_REQUEST_TIMEOUT_SECONDS = 300
TUZI_IMAGE_MAX_RETRIES = 4
TUZI_IMAGE_RETRY_BASE_DELAY_SECONDS = 8
TUZI_ASYNC_MAX_WAIT_SECONDS = 1800
TUZI_ASYNC_POLL_INTERVAL_SECONDS = 10
TUZI_ASYNC_POLL_REQUEST_TIMEOUT_SECONDS = 60
TUZI_ASYNC_ALLOWED_POLL_TIMEOUTS = 10
TUZI_ASYNC_DOWNLOAD_RETRIES = 3
TUZI_ASYNC_DOWNLOAD_TIMEOUT_SECONDS = 180
TUZI_QUEUE_FULL_MAX_RETRIES = 6
TUZI_QUEUE_FULL_BASE_DELAY_SECONDS = 15
KNOWN_UNAVAILABLE_IMAGE_MODELS = {
    "gemini-2.5-flash-image-preview",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
}
EDIT_RETRYABLE_ERROR_MARKERS = (
    "upstream",
    "bad gateway",
    "timeout",
    "timed out",
    "rate limit",
    "quota",
    "permission",
    "unauthorized",
    "forbidden",
    "503",
    "temporarily unavailable",
    "content safety service",
    "empty choices",
    "no image data",
    "returned no image",
    "no images",
)


def _is_gemini_image_model(model_name: Optional[str]) -> bool:
    normalized = (model_name or "").lower().strip()
    return "gemini" in normalized and "image" in normalized


def _backup_key_supports_image_model(model_name: Optional[str]) -> bool:
    # Current cloud backup keys do not have Gemini image permissions.
    return not _is_gemini_image_model(model_name)


def _normalize_image_model_list(*groups: Optional[List[str] | str]) -> List[str]:
    deduped: List[str] = []
    for group in groups:
        if not group:
            continue
        items = group if isinstance(group, list) else [group]
        for item in items:
            candidate = str(item or "").strip()
            if not candidate:
                continue
            normalized = candidate.lower()
            if normalized in KNOWN_UNAVAILABLE_IMAGE_MODELS:
                print(f"[ImageGenerator] Skip known unavailable image model: {candidate}")
                continue
            if candidate not in deduped:
                deduped.append(candidate)
    return deduped


def _build_effective_primary_key_pool(
    *,
    primary_api_key: str,
    configured_pool: Optional[List[str]],
    backup_same_model_api_key: str,
    primary_model: str,
) -> List[tuple[str, str]]:
    keys: List[tuple[str, str]] = []
    seen: set[str] = set()

    def add_key(api_key: str, slot: str) -> None:
        normalized = str(api_key or "").strip()
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        keys.append((normalized, slot))

    add_key(primary_api_key, "primary")
    for index, pooled_key in enumerate(configured_pool or [], start=1):
        add_key(pooled_key, f"pool:{index}")
    if _backup_key_supports_image_model(primary_model):
        add_key(backup_same_model_api_key, "backup")
    return keys


def build_image_candidate_chain(
    *,
    primary_model: str,
    primary_base_url: str,
    primary_api_key: str,
    primary_extra_models: Optional[List[str]] = None,
    backup_same_model_api_key: str = "",
    backup_same_model_base_url: str = "",
    fallback_models: Optional[List[str]] = None,
    fallback_api_key: str = "",
    fallback_base_url: str = "",
) -> List[Dict[str, str]]:
    candidates: List[Dict[str, str]] = []

    def add_candidate(model: str, base_url: str, api_key: str, key_slot: str = "") -> None:
        candidate_model = str(model or "").strip()
        candidate_base_url = str(base_url or "").strip()
        candidate_api_key = str(api_key or "").strip()
        if not candidate_model or not candidate_base_url or not candidate_api_key:
            return
        if any(
            existing["model"] == candidate_model
            and existing["base_url"] == candidate_base_url
            and existing["api_key"] == candidate_api_key
            for existing in candidates
        ):
            return
        candidate = {
            "model": candidate_model,
            "base_url": candidate_base_url,
            "api_key": candidate_api_key,
            "provider": ImageGenerator.resolve_provider(candidate_base_url),
        }
        if key_slot:
            candidate["key_slot"] = key_slot
        if candidate not in candidates:
            candidates.append(candidate)

    configured_primary_key_pool = [
        str(key or "").strip()
        for key in getattr(settings, "IMAGE_GEN_API_KEYS", [])
        if str(key or "").strip()
    ]
    primary_key_pool = _build_effective_primary_key_pool(
        primary_api_key=primary_api_key,
        configured_pool=configured_primary_key_pool,
        backup_same_model_api_key=backup_same_model_api_key,
        primary_model=primary_model,
    )
    if primary_key_pool:
        for pooled_key, key_slot in primary_key_pool:
            add_candidate(primary_model, primary_base_url, pooled_key, key_slot=key_slot)
    else:
        add_candidate(primary_model, primary_base_url, primary_api_key)

    for model_name in _normalize_image_model_list(primary_extra_models or []):
        if primary_key_pool:
            for pooled_key, key_slot in primary_key_pool:
                add_candidate(model_name, primary_base_url, pooled_key, key_slot=key_slot)
        else:
            add_candidate(model_name, primary_base_url, primary_api_key)

    if (
        backup_same_model_api_key.strip()
        and backup_same_model_api_key.strip() != primary_api_key.strip()
        and _backup_key_supports_image_model(primary_model)
    ):
        add_candidate(
            primary_model,
            backup_same_model_base_url or primary_base_url,
            backup_same_model_api_key,
        )

    fallback_uses_non_gemini_backup = (
        fallback_api_key.strip()
        and fallback_api_key.strip() != primary_api_key.strip()
        and fallback_api_key.strip() == backup_same_model_api_key.strip()
    )
    for model_name in _normalize_image_model_list(fallback_models or []):
        if fallback_uses_non_gemini_backup and not _backup_key_supports_image_model(model_name):
            print(f"[ImageGenerator] Skip fallback model on backup key without Gemini permission: {model_name}")
            continue
        add_candidate(
            model_name,
            fallback_base_url or primary_base_url,
            fallback_api_key or primary_api_key,
        )

    return candidates


class ImageGenerator:
    def __init__(self, api_key: str = None, base_url: str = None, model: str = None, provider: str = "custom"):
        self.api_key = api_key or settings.IMAGE_GEN_API_KEY
        self.base_url = base_url or settings.IMAGE_GEN_BASE_URL
        self.model = model or settings.IMAGE_GEN_MODEL
        self.last_edit_metadata: Dict[str, Any] = {}
        
        # 自动识别 provider
        if provider == "custom" and self.base_url:
            if "minimaxi.com" in self.base_url:
                self.provider = "minimax"
            elif "openrouter.ai" in self.base_url:
                self.provider = "openrouter"
            else:
                self.provider = "custom"
        else:
            self.provider = provider.lower()
        
        print(f"[ImageGenerator] Init with provider: {self.provider}, model: {self.model}, base_url: {self.base_url}")
        
        http_client = httpx.Client(
            http2=False,
            timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
            headers={"Accept-Encoding": "identity"},
            limits=httpx.Limits(max_keepalive_connections=5, max_connections=10)
        )
        
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
            default_headers={"Accept-Encoding": "identity"},
            http_client=http_client
        )

    @staticmethod
    def resolve_provider(base_url: Optional[str]) -> str:
        normalized = (base_url or "").lower()
        if "minimaxi.com" in normalized:
            return "minimax"
        if "openrouter.ai" in normalized:
            return "openrouter"
        if "tu-zi.com" in normalized:
            return "tuzi"
        return "custom"

    def _supports_chat_completions_image_generation(self, model_name: Optional[str] = None) -> bool:
        normalized_model = (model_name or self.model or "").lower().strip()
        if not normalized_model:
            return False
        return (
            _is_gemini_image_model(normalized_model)
            or
            "image-preview" in normalized_model
            or "flash-image" in normalized_model
            or "pro-image" in normalized_model
            or normalized_model.startswith("gemini-3-pro-image-preview")
            or normalized_model.startswith("gemini-2.5-flash-image")
        )

    def _sleep_after_rate_limit(self, attempt: int) -> None:
        delay = IMAGE_RATE_LIMIT_BACKOFF_SECONDS * attempt
        print(f"[ImageGenerator] Rate limited, sleeping {delay}s before retry...")
        time.sleep(delay)

    def _image_model_candidates(self) -> List[str]:
        configured = os.getenv("IMAGE_GEN_FALLBACK_MODELS", "").strip()
        env_candidates = [item.strip() for item in configured.split(",") if item.strip()]
        return _normalize_image_model_list(self.model, env_candidates)

    def _resolve_edit_candidates(self) -> List[Dict[str, str]]:
        primary_model = (getattr(settings, "IMAGE_EDIT_MODEL", "") or self.model or "").strip()
        primary_base_url = (getattr(settings, "IMAGE_EDIT_BASE_URL", "") or self.base_url or getattr(settings, "IMAGE_GEN_BASE_URL", "")).strip()
        primary_api_key = (
            getattr(settings, "IMAGE_EDIT_API_KEY", "")
            or self.api_key
            or getattr(settings, "IMAGE_GEN_API_KEY", "")
            or getattr(settings, "OPENROUTER_API_KEY", "")
            or getattr(settings, "ANTHROPIC_API_KEY", "")
        )
        backup_api_key = (
            getattr(settings, "IMAGE_GEN_BACKUP_API_KEY", "")
            or getattr(settings, "ANTHROPIC_BACKUP_API_KEY", "")
        )
        backup_base_url = (getattr(settings, "IMAGE_GEN_BACKUP_BASE_URL", "") or primary_base_url).strip()
        fallback_api_key = (
            getattr(settings, "IMAGE_GEN_FALLBACK_API_KEY", "")
            or backup_api_key
        )
        fallback_base_url = (
            getattr(settings, "IMAGE_GEN_FALLBACK_BASE_URL", "")
            or getattr(settings, "IMAGE_GEN_BACKUP_BASE_URL", "")
            or getattr(settings, "IMAGE_GEN_BASE_URL", "")
            or self.base_url
            or primary_base_url
        ).strip()
        fallback_models = _normalize_image_model_list(
            getattr(settings, "IMAGE_EDIT_FALLBACK_MODEL", "")
            or getattr(settings, "IMAGE2_GEN_MODEL", "")
            or primary_model
        )

        return build_image_candidate_chain(
            primary_model=primary_model,
            primary_base_url=primary_base_url,
            primary_api_key=primary_api_key,
            backup_same_model_api_key=backup_api_key,
            backup_same_model_base_url=backup_base_url,
            fallback_models=fallback_models,
            fallback_api_key=fallback_api_key,
            fallback_base_url=fallback_base_url,
        )

    def resolve_edit_candidates_for_task(
        self,
        candidate_offset_seed: Optional[str] = None,
        candidate_offset: Optional[int] = None,
    ) -> List[Dict[str, str]]:
        candidates = self._resolve_edit_candidates()
        if len(candidates) > 1:
            if candidate_offset is not None:
                offset = int(candidate_offset) % len(candidates)
            elif candidate_offset_seed:
                offset = int(hashlib.sha256(candidate_offset_seed.encode("utf-8")).hexdigest()[:8], 16) % len(candidates)
            else:
                offset = 0
            candidates = candidates[offset:] + candidates[:offset]
        return candidates

    def _is_retryable_edit_error(self, error: Exception | str) -> bool:
        text = str(error or "").lower()
        return any(marker in text for marker in EDIT_RETRYABLE_ERROR_MARKERS)

    def _should_retry_edit_without_supporting_images(self, error: Exception | str) -> bool:
        text = str(error or "").lower()
        return (
            "content safety service" in text
            or "safety service" in text
            or "temporarily unavailable" in text
            or "503" in text
        )

    def _should_retry_edit_with_safe_prompt(self, error: Exception | str) -> bool:
        text = str(error or "").lower()
        return (
            "content safety service" in text
            or "safety service" in text
        )

    def _is_transient_edit_error(self, error: Exception | str) -> bool:
        text = str(error or "").lower()
        return (
            "content safety service" in text
            or "safety service" in text
            or "temporarily unavailable" in text
            or "503" in text
            or "502" in text
            or "bad gateway" in text
            or "timeout" in text
            or "timed out" in text
            or "empty choices" in text
            or "no image data" in text
            or "returned no image" in text
            or "no images" in text
        )

    def _build_safe_edit_retry_prompt(self, aspect_ratio: str = "3:4") -> str:
        ratio = (aspect_ratio or "3:4").strip() or "3:4"
        return (
            f"Create one clean {ratio} Xiaohongshu business poster by editing Image 1. "
            "Keep the main visual identity from Image 1. "
            "If Image 2 is a logo, place that logo accurately and do not invent a different logo. "
            "Use Image 3 and later as reference screenshots or UI materials when present, "
            "turning them into clear product feature visuals. "
            "Use concise Chinese headline, short selling points, and a simple call to action. "
            "Do not include QR codes, barcodes, phone numbers, URLs, watermarks, or unsafe content."
        )

    def _get_datetime_filename(self) -> str:
        return datetime.now().strftime("%Y%m%d_%H%M%S")

    def _unique_suffix(self) -> str:
        return uuid.uuid4().hex[:8]

    def _extract_tuzi_async_asset_url(self, poll_data: dict) -> Optional[str]:
        if not isinstance(poll_data, dict):
            return None

        direct_fields = [
            "video_url",
            "image_url",
            "url",
        ]
        for field in direct_fields:
            value = poll_data.get(field)
            if isinstance(value, str) and value.strip():
                return value.strip()

        nested_data = poll_data.get("data")
        if isinstance(nested_data, dict):
            for field in direct_fields:
                value = nested_data.get(field)
                if isinstance(value, str) and value.strip():
                    return value.strip()

            output = nested_data.get("output")
            if isinstance(output, dict):
                for field in direct_fields:
                    value = output.get(field)
                    if isinstance(value, str) and value.strip():
                        return value.strip()

            video = nested_data.get("video")
            if isinstance(video, dict):
                value = video.get("url")
                if isinstance(value, str) and value.strip():
                    return value.strip()

        video = poll_data.get("video")
        if isinstance(video, dict):
            value = video.get("url")
            if isinstance(value, str) and value.strip():
                return value.strip()

        return None

    def _extract_tuzi_async_status(self, poll_data: dict) -> str:
        if not isinstance(poll_data, dict):
            return ""

        candidates = [
            poll_data.get("status"),
            poll_data.get("state"),
        ]

        nested_data = poll_data.get("data")
        if isinstance(nested_data, dict):
            candidates.extend([
                nested_data.get("status"),
                nested_data.get("state"),
                nested_data.get("task_status"),
            ])

        for value in candidates:
            if isinstance(value, str) and value.strip():
                return value.strip().lower()
        return ""

    def _emit_progress(self, callback: Optional[Callable[[Dict[str, Any]], None]], **payload: Any) -> None:
        if not callback:
            return
        try:
            callback(payload)
        except Exception as error:
            print(f"[ImageGenerator] progress callback error: {error}")

    def _normalize_tuzi_progress(self, progress: Any) -> int:
        if progress is None:
            return 0
        try:
            value = int(float(progress))
        except Exception:
            return 0
        return max(0, min(value, 100))

    def _tuzi_status_message(self, status: str, progress: Any = None) -> str:
        normalized_progress = self._normalize_tuzi_progress(progress)
        if status in {"queued", "pending"}:
            return "远端排队中"
        if status in {"running", "processing", "in_progress", "generating"}:
            if normalized_progress > 0:
                return f"正在生成（云端进度 {normalized_progress}%）"
            return "正在生成"
        if status in {"completed", "succeeded", "success", "done", "finished"}:
            return "已生成，正在保存图片"
        if status in {"failed", "error", "cancelled"}:
            return "云端生图失败"
        return "已提交到云端，正在处理中"

    def _is_tuzi_queue_full_error(self, poll_data: Any) -> bool:
        if not isinstance(poll_data, dict):
            return False
        error = poll_data.get("error")
        if not isinstance(error, dict):
            return False
        code = str(error.get("code") or "").strip()
        message = str(error.get("message") or "")
        return code == "2400013" or "队列已满" in message

    def _download_tuzi_async_asset(self, asset_url: str, output_path: Path, index: int) -> str:
        last_error: Optional[Exception] = None
        for attempt in range(1, TUZI_ASYNC_DOWNLOAD_RETRIES + 1):
            try:
                print(
                    f"[ImageGenerator] Downloading Tuzi async asset attempt {attempt}/{TUZI_ASYNC_DOWNLOAD_RETRIES}: "
                    f"{asset_url[:80]}..."
                )
                rimg = requests.get(asset_url, timeout=TUZI_ASYNC_DOWNLOAD_TIMEOUT_SECONDS)
                rimg.raise_for_status()
                image_bytes = rimg.content

                datetime_str = self._get_datetime_filename()
                filename = f"gen_tuzi_async_{datetime_str}_{index}_{self._unique_suffix()}.png"
                file_path = output_path / filename
                with open(file_path, "wb") as f:
                    f.write(image_bytes)
                print(f"[ImageGenerator] Saved Tuzi async image to {file_path}")
                return str(file_path)
            except Exception as error:
                last_error = error
                print(f"[ImageGenerator] Tuzi async asset download failed on attempt {attempt}: {error}")
                if attempt < TUZI_ASYNC_DOWNLOAD_RETRIES:
                    time.sleep(3)

        if last_error:
            raise last_error
        raise RuntimeError("Tuzi async 资源下载失败")

    def _tuzi_videos_endpoint(self) -> str:
        return f"{self.base_url.rstrip('/')}/videos"

    def _tuzi_headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
        }

    def _fetch_tuzi_async_task(self, task_id: str) -> Dict[str, Any]:
        endpoint = f"{self._tuzi_videos_endpoint()}/{task_id}"
        response = requests.get(
            endpoint,
            headers=self._tuzi_headers(),
            timeout=(20, TUZI_ASYNC_POLL_REQUEST_TIMEOUT_SECONDS),
        )
        response.raise_for_status()
        return response.json()

    def _download_tuzi_async_content(self, task_id: str, endpoint: str, headers: Dict[str, str], output_path: Path, index: int) -> Optional[str]:
        content_endpoint = f"{endpoint}/{task_id}/content"
        try:
            response = requests.get(
                content_endpoint,
                headers=headers,
                timeout=(20, TUZI_ASYNC_DOWNLOAD_TIMEOUT_SECONDS),
            )
            if response.status_code != 200:
                return None
            image_bytes = response.content
            if not image_bytes:
                return None
            return self._save_image_bytes(image_bytes, output_path, "gen_tuzi_async", index)
        except Exception as error:
            print(f"[ImageGenerator] Tuzi async content download failed: {error}")
            return None

    def _recover_tuzi_async_result(
        self,
        task_id: Optional[str],
        endpoint: str,
        headers: Dict[str, str],
        output_path: Path,
        index: int,
    ) -> Optional[str]:
        if not task_id:
            return None
        try:
            poll_data = self._fetch_tuzi_async_task(task_id)
        except Exception as error:
            print(f"[ImageGenerator] Tuzi async recover poll failed for {task_id}: {error}")
            return None

        status = self._extract_tuzi_async_status(poll_data)
        if status not in {"completed", "succeeded", "success", "done", "finished"}:
            return None

        image_url = self._extract_tuzi_async_asset_url(poll_data)
        if image_url:
            return self._download_tuzi_async_asset(image_url, output_path, index)
        return self._download_tuzi_async_content(task_id, endpoint, headers, output_path, index)

    def refresh_tuzi_async_task(
        self,
        task_id: str,
        output_dir: str,
        index: int = 0,
        existing_paths: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        existing_paths = [path for path in (existing_paths or []) if path]
        for existing_path in existing_paths:
            if Path(existing_path).exists():
                return {
                    "status": "completed",
                    "progress": 100,
                    "message": "Gemini 图片已保存",
                    "external_status": "completed",
                    "external_progress": 100,
                    "saved_files": existing_paths,
                }

        poll_data = self._fetch_tuzi_async_task(task_id)
        status = self._extract_tuzi_async_status(poll_data)
        progress = self._normalize_tuzi_progress(poll_data.get("progress"))

        if status in {"completed", "succeeded", "success", "done", "finished"}:
            image_url = self._extract_tuzi_async_asset_url(poll_data)
            saved_file: Optional[str] = None
            if image_url:
                saved_file = self._download_tuzi_async_asset(image_url, output_path, index)
            else:
                saved_file = self._download_tuzi_async_content(
                    task_id,
                    self._tuzi_videos_endpoint(),
                    self._tuzi_headers(),
                    output_path,
                    index,
                )
            if not saved_file:
                raise ValueError(f"Tuzi async 任务已完成但未返回可下载结果: {poll_data}")
            return {
                "status": "completed",
                "progress": 100,
                "message": "Gemini 图片已保存",
                "external_status": "completed",
                "external_progress": 100,
                "saved_files": [saved_file],
                "poll_data": poll_data,
            }

        if status in {"failed", "error", "cancelled"}:
            error = poll_data.get("error") if isinstance(poll_data, dict) else None
            error_message = error.get("message") if isinstance(error, dict) else None
            error_code = error.get("code") if isinstance(error, dict) else None
            return {
                "status": "failed",
                "progress": max(progress, 100),
                "message": error_message or "Gemini 生图失败",
                "external_status": status,
                "external_progress": progress,
                "last_remote_error_code": str(error_code) if error_code is not None else None,
                "poll_data": poll_data,
            }

        return {
            "status": "running",
            "progress": max(20, min(95, progress or 12)),
            "message": self._tuzi_status_message(status, progress),
            "external_status": status or "queued",
            "external_progress": progress,
            "poll_data": poll_data,
        }

    def _save_image_bytes(self, image_bytes: bytes, output_path: Path, prefix: str, index: int) -> str:
        datetime_str = self._get_datetime_filename()
        filename = f"{prefix}_{datetime_str}_{index}_{self._unique_suffix()}.png"
        file_path = output_path / filename
        with open(file_path, "wb") as f:
            f.write(image_bytes)
        return str(file_path)

    def _extract_tuzi_generate_content_image_bytes(self, response_data: Any) -> Optional[bytes]:
        if not isinstance(response_data, dict):
            return None
        candidates = response_data.get("candidates")
        if not isinstance(candidates, list):
            return None
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            content = candidate.get("content")
            if not isinstance(content, dict):
                continue
            parts = content.get("parts")
            if not isinstance(parts, list):
                continue
            for part in parts:
                if not isinstance(part, dict):
                    continue
                inline = part.get("inline_data") or part.get("inlineData")
                if isinstance(inline, dict):
                    data = inline.get("data")
                    if isinstance(data, str) and data.strip():
                        return base64.b64decode(data)
        return None

    def generate_via_tuzi_image_api(self, prompt: str, output_dir: str, count: int = 1,
                                    aspect_ratio: str = "3:4", model_override: Optional[str] = None,
                                    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> List[str]:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        saved_files: List[str] = []
        model_name = model_override or self.model
        endpoint = f"{self.base_url.rstrip('/').removesuffix('/v1')}/v1beta/models/{model_name}:generateContent"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        for i in range(count):
            last_error: Optional[Exception] = None
            for attempt in range(1, TUZI_IMAGE_MAX_RETRIES + 1):
                try:
                    self._emit_progress(
                        progress_callback,
                        stage="submitting_image_request",
                        status="running",
                        message=f"正在提交第 {i+1}/{count} 张图片生成请求",
                        progress=10,
                        retryable=True,
                    )
                    payload = {
                        "contents": [
                            {
                                "parts": [
                                    {
                                        "text": prompt,
                                    }
                                ]
                            }
                        ],
                        "generationConfig": {
                            "responseModalities": ["IMAGE", "TEXT"],
                            "imageConfig": {
                                "aspectRatio": aspect_ratio or "3:4",
                            },
                        },
                    }
                    response = requests.post(
                        endpoint,
                        headers=headers,
                        json=payload,
                        timeout=TUZI_IMAGE_REQUEST_TIMEOUT_SECONDS,
                    )
                    if response.status_code == 429:
                        raise RateLimitError(message="Rate limit exceeded", response=response, body=None)
                    if response.status_code != 200:
                        raise Exception(f"Tuzi image API Error {response.status_code}: {response.text[:500]}")

                    self._emit_progress(
                        progress_callback,
                        stage="generating_image",
                        status="running",
                        message=f"正在生成第 {i+1}/{count} 张图片",
                        progress=65,
                        retryable=True,
                    )

                    response_data = response.json()
                    image_bytes = self._extract_tuzi_generate_content_image_bytes(response_data)
                    if not image_bytes:
                        raise ValueError(f"Tuzi 图像接口未返回可用图片数据: {response_data}")

                    file_path = self._save_image_bytes(image_bytes, output_path, "gen_tuzi_image", i)
                    saved_files.append(file_path)
                    self._emit_progress(
                        progress_callback,
                        stage="saving_image",
                        status="completed",
                        message=f"第 {i+1}/{count} 张图片已生成并保存",
                        progress=100,
                        saved_files=saved_files.copy(),
                        retryable=False,
                    )
                    break
                except Exception as error:
                    last_error = error
                    error_text = str(error)
                    is_retryable = "429" in error_text or "529" in error_text or "队列已满" in error_text or "overloaded" in error_text.lower()
                    if attempt < TUZI_IMAGE_MAX_RETRIES and is_retryable:
                        backoff = TUZI_IMAGE_RETRY_BASE_DELAY_SECONDS * attempt
                        self._emit_progress(
                            progress_callback,
                            stage="retrying_image_request",
                            status="running",
                            message=f"Tuzi 图像接口繁忙，正在自动重试（第 {attempt} 次）",
                            progress=18,
                            retryable=True,
                            queue_retry_count=attempt,
                            last_remote_error_code="429_or_529",
                        )
                        time.sleep(backoff)
                        continue
                    raise error
            else:
                if last_error:
                    raise last_error

        return saved_files

    def _image_to_base64(self, image_path: str) -> tuple[str, str]:
        with open(image_path, "rb") as f:
            image_bytes = f.read()
        
        image_path_lower = image_path.lower()
        if image_path_lower.endswith('.png'):
            mime_type = "image/png"
        elif image_path_lower.endswith(('.jpg', '.jpeg')):
            mime_type = "image/jpeg"
        elif image_path_lower.endswith('.webp'):
            mime_type = "image/webp"
        else:
            mime_type = "image/png"
        
        image_base64 = base64.b64encode(image_bytes).decode("utf-8")
        return image_base64, mime_type

    def _extract_image_url_from_content(self, content: str) -> Optional[str]:
        # 兼容返回中包含 markdown/backticks/前缀符号的链接或 data URL
        if not content:
            return None
        sanitized = content.replace("`", " ").replace("! ", " ").strip()
        data_url_match = re.search(r"(data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+)", sanitized)
        if data_url_match:
            return re.sub(r"\s+", "", data_url_match.group(1))

        http_url_match = re.search(r'(https?://[^\s\)]+?\.(?:png|jpg|jpeg|webp))', sanitized, re.IGNORECASE)
        return http_url_match.group(1) if http_url_match else None

    def _image_bytes_from_source(self, image_source: str, *, timeout: int = 120) -> bytes:
        if image_source.startswith("data:image"):
            print("[ImageGenerator] Processing base64 image data URI...")
            try:
                _, encoded = image_source.split(",", 1)
                encoded = re.sub(r"\s+", "", encoded)
                missing_padding = len(encoded) % 4
                if missing_padding:
                    encoded += "=" * (4 - missing_padding)
                return base64.b64decode(encoded)
            except Exception as b64_err:
                raise ValueError(f"Invalid data URI image response: {b64_err}") from b64_err

        if image_source.startswith(("http://", "https://")):
            print(f"[ImageGenerator] Downloading image from URL: {image_source[:50]}...")
            rimg = requests.get(image_source, timeout=timeout)
            rimg.raise_for_status()
            return rimg.content

        raise ValueError(f"Unsupported image response source: {image_source[:80]}")

    def _get_backup_api_key(self) -> Optional[str]:
        return getattr(settings, "IMAGE_GEN_BACKUP_API_KEY", "") or getattr(settings, "ANTHROPIC_BACKUP_API_KEY", "")

    def _is_quota_exhausted_error(self, resp_or_error) -> bool:
        if isinstance(resp_or_error, Exception):
            error_text = str(resp_or_error).lower()
            return any(marker in error_text for marker in ["429", "quota", "exhausted", "额度", "额度耗尽"])
        if hasattr(resp_or_error, 'status_code'):
            if resp_or_error.status_code == 429:
                return True
            try:
                resp_data = resp_or_error.json()
                error_msg = resp_data.get("error", {})
                if isinstance(error_msg, dict):
                    message = error_msg.get("message", "").lower()
                    if any(marker in message for marker in ["quota", "exhausted", "额度"]):
                        return True
            except Exception:
                pass
        return False

    def generate_via_openai_compatible_chat_image(
        self,
        prompt: str,
        output_dir: str,
        count: int = 1,
        aspect_ratio: str = "1:1",
        image_size: str = "1K",
        model_override: Optional[str] = None,
        request_timeout_seconds: int = IMAGE_REQUEST_TIMEOUT_SECONDS,
    ) -> List[str]:
        if not self.api_key or self.api_key.strip() == "":
            raise ValueError("生图服务 API Key 未配置，请检查 ANTHROPIC_API_KEY、IMAGE_GEN_API_KEY 或 OPENROUTER_API_KEY。")
        
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        saved_files: List[str] = []

        endpoint = f"{self.base_url.rstrip('/')}/chat/completions"
        
        model_name = model_override or self.model

        print(f"[ImageGenerator] OpenAI-compatible image config:")
        print(f"  - API Key: {'已配置 (' + self.api_key[:15] + '...)' if len(self.api_key) > 15 else '未配置或过短'}")
        print(f"  - Endpoint: {endpoint}")
        print(f"  - Model: {model_name}")
        print(f"  - Count: {count}")
        print(f"  - Aspect Ratio: {aspect_ratio}")
        print(f"  - Image Size: {image_size}")

        payload = {
            "model": model_name,
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "modalities": ["image", "text"]
        }
        
        image_config = {}
        if aspect_ratio and aspect_ratio != "1:1":
            image_config["aspect_ratio"] = aspect_ratio
        if image_size and image_size != "1K":
            image_config["image_size"] = image_size
        
        if image_config:
            payload["image_config"] = image_config
            print(f"[ImageGenerator] Using image_config: {image_config}")

        backup_api_key = self._get_backup_api_key()
        use_backup_key = False

        tuzi_task_id: Optional[str] = None
        for i in range(count):
            tuzi_task_id = None
            try:
                resp = None
                last_rate_limit_error: Optional[RateLimitError] = None
                for attempt in range(1, IMAGE_RATE_LIMIT_RETRIES + 2):
                    current_api_key = backup_api_key if use_backup_key else self.api_key
                    current_headers = {
                        "Authorization": f"Bearer {current_api_key}",
                        "Content-Type": "application/json"
                    }
                    start_time = time.time()
                    print(
                        f"[ImageGenerator] Chat image request {i+1}/{count} starting... "
                        f"(attempt {attempt}/{IMAGE_RATE_LIMIT_RETRIES + 1}, key={'backup' if use_backup_key else 'primary'})"
                    )
                    resp = requests.post(
                        endpoint,
                        headers=current_headers,
                        json=payload,
                        timeout=request_timeout_seconds
                    )
                    duration = time.time() - start_time
                    print(
                        f"[ImageGenerator] Chat image request {i+1}/{count} finished in "
                        f"{duration:.2f}s (status {resp.status_code})"
                    )

                    if resp.status_code == 429:
                        last_rate_limit_error = RateLimitError(message="Rate limit exceeded", response=resp, body=None)
                        print(
                            f"[ImageGenerator] ⚠️ Chat image rate limit exceeded on "
                            f"attempt {attempt}/{IMAGE_RATE_LIMIT_RETRIES + 1}"
                        )
                        
                        is_quota_exhausted = self._is_quota_exhausted_error(resp)
                        if is_quota_exhausted and backup_api_key and not use_backup_key:
                            print(f"[ImageGenerator] 主 key 额度疑似耗尽，切换到备用 key 进行重试")
                            use_backup_key = True
                            continue
                        
                        if attempt <= IMAGE_RATE_LIMIT_RETRIES:
                            self._sleep_after_rate_limit(attempt)
                            continue
                        raise last_rate_limit_error

                    if resp.status_code == 503 or any(marker in resp.text.lower() for marker in ["每日额度", "已达每日", "额度上限", "configuration_error", "exhausted"]):
                        print(f"[ImageGenerator] ⚠️ Chat image quota exhaust detected (status {resp.status_code}), attempting backup key switch")
                        if backup_api_key and not use_backup_key:
                            use_backup_key = True
                            continue
                        print(f"[ImageGenerator] Chat image error response: {resp.text[:500]}")
                        raise Exception(f"Chat Completions Image API Error {resp.status_code}: {resp.text[:200]}")

                    if resp.status_code != 200:
                        print(f"[ImageGenerator] Chat image error response: {resp.text[:500]}")
                        raise Exception(f"Chat Completions Image API Error {resp.status_code}: {resp.text[:200]}")

                    break

                if resp is None:
                    if last_rate_limit_error:
                        raise last_rate_limit_error
                    raise RuntimeError("Chat image request did not return a response")

                try:
                    data = resp.json()
                except Exception as json_err:
                    print(f"[ImageGenerator] JSON Decode Error: {json_err}")
                    print(f"[ImageGenerator] Response Status: {resp.status_code}")
                    print(f"[ImageGenerator] Response Headers: {dict(resp.headers)}")
                    print(f"[ImageGenerator] Response Text (First 500 chars): {resp.text[:500]}")
                    raise ValueError(f"生图接口返回了无效的 JSON 响应。状态码: {resp.status_code}, 内容: {resp.text[:200]}")
                
                print(f"[ImageGenerator] Chat image response keys: {list(data.keys())}")
                choices = data.get("choices") or []
                if not choices:
                    print(f"[ImageGenerator] Empty choices! Full response data: {data}")
                    error_msg = data.get("error", {})
                    if error_msg:
                        print(f"[ImageGenerator] Chat image error: {error_msg}")
                    raise ValueError(f"生图接口未返回有效 choices。Error: {error_msg or 'Unknown'}")

                message = choices[0].get("message", {})
                images = message.get("images", [])
                content_image_url = self._extract_image_url_from_content(message.get("content", ""))
                
                print(f"[ImageGenerator] Message Keys: {list(message.keys())}")
                print(f"[ImageGenerator] Message Content (first 500 chars): {str(message)[:500]}")
                
                if not images:
                    if content_image_url:
                        images = [{"image_url": {"url": content_image_url}}]
                        print("[ImageGenerator] Falling back to image extracted from message.content")
                    else:
                        import json
                        print(f"[ImageGenerator] ❌ No images field! Full message: {json.dumps(message, indent=2, ensure_ascii=False)}")
                        raise ValueError(f"生图接口未返回 images 字段。Message content: {message.get('content', '')[:200]}")

                if len(images) > 1:
                    print(f"[ImageGenerator] Warning: response returned {len(images)} images, only saving the first one")

                for img_idx, img_obj in enumerate(images[:1]):
                    image_url = img_obj.get("image_url", {}).get("url", "")
                    
                    if not image_url:
                        print(f"[ImageGenerator] Warning: Empty image URL in response {i+1}, image {img_idx}")
                        continue
                    
                    if image_url.startswith("data:image"):
                        print(f"[ImageGenerator] Processing base64 image from chat/completions...")
                        header, encoded = image_url.split(",", 1)
                        image_bytes = base64.b64decode(encoded)
                    else:
                        print(f"[ImageGenerator] Downloading image from URL: {image_url[:50]}...")
                        
                        max_retries = 3
                        retry_delay = 2
                        image_bytes = None
                        
                        for retry in range(max_retries):
                            try:
                                if retry > 0:
                                    print(f"[ImageGenerator] Retry {retry}/{max_retries-1} after {retry_delay}s...")
                                    time.sleep(retry_delay)
                                
                                rimg = requests.get(image_url, timeout=180, stream=True)
                                rimg.raise_for_status()
                                
                                chunks = []
                                total_size = 0
                                for chunk in rimg.iter_content(chunk_size=8192):
                                    if chunk:
                                        chunks.append(chunk)
                                        total_size += len(chunk)
                                
                                image_bytes = b''.join(chunks)
                                print(f"[ImageGenerator] Downloaded {total_size} bytes successfully")
                                break
                                
                            except (requests.exceptions.ConnectionError, 
                                    requests.exceptions.ChunkedEncodingError,
                                    requests.exceptions.Timeout) as net_err:
                                print(f"[ImageGenerator] Network error on attempt {retry+1}/{max_retries}: {net_err}")
                                if retry == max_retries - 1:
                                    raise Exception(f"Failed to download image after {max_retries} attempts: {net_err}")
                            except requests.exceptions.HTTPError as http_err:
                                print(f"[ImageGenerator] HTTP error: {http_err}")
                                raise
                        
                        if image_bytes is None:
                            raise Exception("Failed to download image: no data received")

                    try:
                        from PIL import Image
                        from io import BytesIO
                        Image.open(BytesIO(image_bytes)).verify()
                        print(f"[ImageGenerator] Validated generated image integrity: OK")
                    except Exception as verify_err:
                        raise ValueError(f"生成图片损坏: {verify_err}")

                    datetime_str = self._get_datetime_filename()
                    filename = f"gen_gemini_{datetime_str}_{i}_{img_idx}_{self._unique_suffix()}.png"
                    file_path = output_path / filename

                    with open(file_path, "wb") as f:
                        f.write(image_bytes)
                    saved_files.append(str(file_path))
                    print(f"[ImageGenerator] Saved generated image to {file_path}")

            except RateLimitError as e:
                print(f"[ImageGenerator] ⚠️ Chat image rate limit exceeded: {e}")
                raise e
            except requests.exceptions.Timeout as e:
                raise TimeoutError(
                    f"图片生成超时，模型 {model_name} 在 {request_timeout_seconds} 秒内未返回结果"
                ) from e
            except Exception as e:
                print(f"[ImageGenerator] Chat image error on request {i+1}/{count}: {e}")
                import traceback
                traceback.print_exc()
                if saved_files:
                    print(f"[ImageGenerator] Warning: {len(saved_files)} images generated successfully before error")
                    print(f"[ImageGenerator] Continuing with partial results...")
                    continue
                else:
                    raise e

        return saved_files

    def generate_via_openrouter(self, prompt: str, output_dir: str, count: int = 1,
                                aspect_ratio: str = "1:1", image_size: str = "1K",
                                model_override: Optional[str] = None,
                                request_timeout_seconds: int = IMAGE_REQUEST_TIMEOUT_SECONDS) -> List[str]:
        return self.generate_via_openai_compatible_chat_image(
            prompt=prompt,
            output_dir=output_dir,
            count=count,
            aspect_ratio=aspect_ratio,
            image_size=image_size,
            model_override=model_override,
            request_timeout_seconds=request_timeout_seconds,
        )

    def generate_via_chat_async(self, prompt: str, output_dir: str, count: int = 1, stream: bool = False,
                                request_timeout_seconds: int = IMAGE_REQUEST_TIMEOUT_SECONDS) -> List[str]:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        saved_files: List[str] = []

        endpoint = f"{self.base_url.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
        }

        payload = {
            "model": self.model,
            "group": "default",
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "stream": bool(stream),
            "temperature": 0.7,
            "top_p": 1,
            "max_tokens": 4096
        }

        for i in range(count):
            tuzi_task_id: Optional[str] = None
            try:
                start_time = time.time()
                resp = requests.post(
                    endpoint,
                    headers=headers,
                    json=payload,
                    timeout=request_timeout_seconds
                )
                duration = time.time() - start_time
                print(f"[ImageGenerator] Chat async request {i+1}/{count} finished in {duration:.2f}s (status {resp.status_code})")

                if resp.status_code == 429:
                    raise RateLimitError(message="Rate limit exceeded", response=resp, body=None)
                elif resp.status_code != 200:
                    raise Exception(f"API Error {resp.status_code}: {resp.text[:200]}")

                data = resp.json()
                choices = data.get("choices") or []
                if not choices:
                    raise ValueError("Empty choices in chat response")

                content = choices[0].get("message", {}).get("content") or ""
                image_url = self._extract_image_url_from_content(content)

                if not image_url:
                    # 兼容可能直接返回 data/url 的情况
                    image_url = data.get("data", [{}])[0].get("url")

                if not image_url:
                    raise ValueError(f"Unable to extract image URL from content: {content[:200]}")

                print(f"[ImageGenerator] Downloading image from {image_url}")
                rimg = requests.get(image_url, timeout=120)
                rimg.raise_for_status()

                datetime_str = self._get_datetime_filename()
                filename = f"gen_async_{datetime_str}_{i}_{self._unique_suffix()}.png"
                file_path = output_path / filename

                image_bytes = rimg.content
                try:
                    from PIL import Image
                    from io import BytesIO
                    Image.open(BytesIO(image_bytes)).verify()
                    print(f"[ImageGenerator] Validated async image integrity: OK")
                except Exception as verify_err:
                    raise ValueError(f"Downloaded image corrupted: {verify_err}")

                with open(file_path, "wb") as f:
                    f.write(image_bytes)
                saved_files.append(str(file_path))
                print(f"[ImageGenerator] Saved async image to {file_path}")

            except RateLimitError as e:
                print(f"[ImageGenerator] ⚠️ Rate Limit Exceeded (chat async): {e}")
                raise e
            except requests.exceptions.Timeout as e:
                raise TimeoutError(
                    f"图片生成超时，模型 {self.model} 在 {request_timeout_seconds} 秒内未返回结果"
                ) from e
            except Exception as e:
                print(f"[ImageGenerator] Chat async error: {e}")
                import traceback
                traceback.print_exc()
                if not saved_files:
                    raise e

        return saved_files

    def generate_via_tuzi_async(self, prompt: str, output_dir: str, count: int = 1,
                                aspect_ratio: str = "3:4", model_override: Optional[str] = None,
                                progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None) -> List[str]:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        saved_files: List[str] = []

        endpoint = f"{self.base_url.rstrip('/')}/videos"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
        }
        model_name = model_override or self.model

        for i in range(count):
            tuzi_task_id: Optional[str] = None
            queue_retry_count = 0
            try:
                while True:
                    print(f"[ImageGenerator] Tuzi async create task {i+1}/{count}, model={model_name}, ratio={aspect_ratio}")
                    self._emit_progress(
                        progress_callback,
                        stage="creating",
                        status="running",
                        message="正在向 Gemini 提交生图任务",
                        progress=8,
                        external_status="submitting",
                        external_progress=0,
                        queue_retry_count=queue_retry_count,
                    )
                    create_resp = requests.post(
                        endpoint,
                        headers=headers,
                        files={
                            "model": (None, model_name),
                            "prompt": (None, prompt),
                            "size": (None, aspect_ratio or "3:4"),
                        },
                        timeout=IMAGE_REQUEST_TIMEOUT_SECONDS,
                    )
                    if create_resp.status_code == 429:
                        raise RateLimitError(message="Rate limit exceeded", response=create_resp, body=None)
                    if create_resp.status_code != 200:
                        raise Exception(f"Tuzi async API Error {create_resp.status_code}: {create_resp.text[:200]}")

                    create_data = create_resp.json()
                    task_id = create_data.get("id")
                    if not task_id:
                        raise ValueError(f"Tuzi async 未返回任务 id: {create_data}")
                    tuzi_task_id = str(task_id)
                    self._emit_progress(
                        progress_callback,
                        stage="submitted",
                        status="running",
                        message="已提交到 Gemini 队列，正在排队",
                        progress=15,
                        external_task_id=tuzi_task_id,
                        external_status="queued",
                        external_progress=0,
                        queue_retry_count=queue_retry_count,
                    )
                    break

                poll_endpoint = f"{endpoint}/{task_id}"
                start_time = time.time()
                poll_timeout_count = 0
                while True:
                    if time.time() - start_time > TUZI_ASYNC_MAX_WAIT_SECONDS:
                        self._emit_progress(
                            progress_callback,
                            stage="polling_timeout",
                            status="running",
                            message="图片任务仍在云端生成，可稍后继续查看",
                            progress=92,
                            external_task_id=tuzi_task_id,
                            external_status="running",
                            external_progress=99,
                            retryable=True,
                        )
                        return saved_files

                    try:
                        poll_resp = requests.get(
                            poll_endpoint,
                            headers=headers,
                            timeout=TUZI_ASYNC_POLL_REQUEST_TIMEOUT_SECONDS,
                        )
                    except requests.exceptions.Timeout:
                        poll_timeout_count += 1
                        print(
                            f"[ImageGenerator] Tuzi async poll timeout task={task_id}, "
                            f"timeout_count={poll_timeout_count}/{TUZI_ASYNC_ALLOWED_POLL_TIMEOUTS}"
                        )
                        if poll_timeout_count >= TUZI_ASYNC_ALLOWED_POLL_TIMEOUTS:
                            self._emit_progress(
                                progress_callback,
                                stage="polling_unstable",
                                status="running",
                                message="图片任务仍在云端生成，当前网络不稳定，可继续等待",
                                progress=90,
                                external_task_id=tuzi_task_id,
                                external_status="running",
                                external_progress=95,
                                retryable=True,
                            )
                            return saved_files
                        time.sleep(TUZI_ASYNC_POLL_INTERVAL_SECONDS)
                        continue

                    poll_timeout_count = 0
                    if poll_resp.status_code != 200:
                        raise Exception(f"Tuzi async 查询任务失败 {poll_resp.status_code}: {poll_resp.text[:200]}")

                    poll_data = poll_resp.json()
                    status = self._extract_tuzi_async_status(poll_data)
                    progress = poll_data.get("progress")
                    normalized_progress = self._normalize_tuzi_progress(progress)
                    print(f"[ImageGenerator] Tuzi async poll task={task_id}, status={status}, progress={progress}")
                    self._emit_progress(
                        progress_callback,
                        stage="polling",
                        status="running",
                        message=self._tuzi_status_message(status, progress),
                        progress=max(20, min(95, normalized_progress)),
                        external_task_id=tuzi_task_id,
                        external_status=status,
                        external_progress=normalized_progress,
                        retryable=True,
                    )

                    if status in {"completed", "succeeded", "success", "done", "finished"}:
                        image_url = self._extract_tuzi_async_asset_url(poll_data)
                        if not image_url:
                            downloaded_file = self._download_tuzi_async_content(tuzi_task_id, endpoint, headers, output_path, i)
                            if downloaded_file:
                                saved_files.append(downloaded_file)
                                self._emit_progress(
                                    progress_callback,
                                    stage="downloaded",
                                    status="completed",
                                    message="Gemini 图片已保存",
                                    progress=100,
                                    external_task_id=tuzi_task_id,
                                    external_status="completed",
                                    external_progress=100,
                                    saved_files=saved_files.copy(),
                                )
                                break
                            raise ValueError(f"Tuzi async 任务已完成但未返回图片地址: {poll_data}")
                        saved_files.append(self._download_tuzi_async_asset(image_url, output_path, i))
                        self._emit_progress(
                            progress_callback,
                            stage="downloaded",
                            status="completed",
                            message="Gemini 图片已保存",
                            progress=100,
                            external_task_id=tuzi_task_id,
                            external_status="completed",
                            external_progress=100,
                            saved_files=saved_files.copy(),
                        )
                        break

                    if status in {"failed", "error", "cancelled"}:
                        if self._is_tuzi_queue_full_error(poll_data):
                            queue_retry_count += 1
                            if queue_retry_count > TUZI_QUEUE_FULL_MAX_RETRIES:
                                raise RuntimeError("Tuzi 远端队列持续繁忙，自动重试已达到上限")
                            backoff_seconds = TUZI_QUEUE_FULL_BASE_DELAY_SECONDS * queue_retry_count
                            self._emit_progress(
                                progress_callback,
                                stage="queue_retrying",
                                status="running",
                                message=f"Tuzi 队列繁忙，正在自动重试抢占任务位（第 {queue_retry_count} 次）",
                                progress=18,
                                external_task_id=tuzi_task_id,
                                external_status="queue_full_retrying",
                                external_progress=0,
                                retryable=True,
                                queue_retry_count=queue_retry_count,
                                last_remote_error_code="2400013",
                            )
                            print(
                                f"[ImageGenerator] Tuzi queue full, retrying create after {backoff_seconds}s "
                                f"(attempt {queue_retry_count}/{TUZI_QUEUE_FULL_MAX_RETRIES})"
                            )
                            time.sleep(backoff_seconds)
                            tuzi_task_id = None
                            break
                        raise RuntimeError(f"Tuzi async 任务失败: {poll_data}")

                    time.sleep(TUZI_ASYNC_POLL_INTERVAL_SECONDS)

                if tuzi_task_id is None:
                    continue

            except RateLimitError:
                raise
            except requests.exceptions.Timeout as e:
                recovered_file = self._recover_tuzi_async_result(
                    task_id=tuzi_task_id,
                    endpoint=endpoint,
                    headers=headers,
                    output_path=output_path,
                    index=i,
                )
                if recovered_file:
                    saved_files.append(recovered_file)
                    self._emit_progress(
                        progress_callback,
                        stage="recovered",
                        status="completed",
                        message="Gemini 已生成完成，结果已补领保存",
                        progress=100,
                        external_task_id=tuzi_task_id,
                        external_status="completed",
                        external_progress=100,
                        saved_files=saved_files.copy(),
                        recovery_attempted=True,
                    )
                    continue

                self._emit_progress(
                    progress_callback,
                    stage="recoverable_timeout",
                    status="running",
                    message="图片任务仍在云端生成，可继续等待或稍后查看",
                    progress=90,
                    external_task_id=tuzi_task_id,
                    external_status="running",
                    external_progress=95,
                    retryable=True,
                    recovery_attempted=True,
                )
                return saved_files
            except Exception as e:
                print(f"[ImageGenerator] Tuzi async error: {e}")
                recovered_file = self._recover_tuzi_async_result(
                    task_id=tuzi_task_id,
                    endpoint=endpoint,
                    headers=headers,
                    output_path=output_path,
                    index=i,
                )
                if recovered_file:
                    saved_files.append(recovered_file)
                    self._emit_progress(
                        progress_callback,
                        stage="recovered",
                        status="completed",
                        message="Gemini 已生成完成，结果已补领保存",
                        progress=100,
                        external_task_id=tuzi_task_id,
                        external_status="completed",
                        external_progress=100,
                        saved_files=saved_files.copy(),
                        recovery_attempted=True,
                    )
                    continue
                if not saved_files:
                    raise e

        return saved_files
    
    def generate_via_minimax(self, prompt: str, output_dir: str, count: int = 1,
                             aspect_ratio: str = "3:4", model_override: Optional[str] = None) -> List[str]:
        """
        通过 MiniMax T2I V2 API 生成图片
        """
        if not self.api_key:
            raise ValueError("MiniMax API Key 未配置")
            
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        saved_files: List[str] = []
        
        # MiniMax T2I V2 专用端点
        endpoint = self.base_url # 已经在 .env 中配置为完整的 URL
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
        }
        
        model_name = model_override or self.model or "image-01"
        
        # 转换 aspect_ratio 格式以适配 MiniMax (3:4, 1:1, 4:3, 16:9, 9:16)
        minimax_ratio = aspect_ratio
        if aspect_ratio == "2:3": minimax_ratio = "3:4" # 映射最接近的
        elif aspect_ratio == "3:2": minimax_ratio = "4:3"
        
        print(f"[ImageGenerator] MiniMax Request: model={model_name}, ratio={minimax_ratio}")
        
        payload = {
            "model": model_name,
            "prompt": prompt,
            "aspect_ratio": minimax_ratio,
            "response_format": "url" # MiniMax 支持 url 或 b64_json
        }
        
        for i in range(count):
            try:
                start_time = time.time()
                resp = requests.post(endpoint, headers=headers, json=payload, timeout=IMAGE_REQUEST_TIMEOUT_SECONDS)
                duration = time.time() - start_time
                print(f"[ImageGenerator] MiniMax request {i+1}/{count} finished in {duration:.2f}s (status {resp.status_code})")
                
                if resp.status_code != 200:
                    print(f"[ImageGenerator] MiniMax Error: {resp.text}")
                    raise Exception(f"MiniMax API Error {resp.status_code}: {resp.text[:200]}")
                    
                data = resp.json()
                
                # MiniMax 响应结构: {"data": {"image_urls": [{"url": "..."}]}, "base_resp": {...}}
                image_urls = data.get("data", {}).get("image_urls", [])
                if not image_urls:
                    print(f"[ImageGenerator] MiniMax returned no images: {data}")
                    raise ValueError("MiniMax 响应中没有包含图片 URL")
                    
                for img_idx, img_obj in enumerate(image_urls):
                    # MiniMax 响应中 image_urls 可能是字符串列表或对象列表
                    image_url = img_obj.get("url") if isinstance(img_obj, dict) else img_obj
                    if not image_url: continue
                    
                    print(f"[ImageGenerator] Downloading MiniMax image from {image_url[:50]}...")
                    rimg = requests.get(image_url, timeout=120)
                    rimg.raise_for_status()
                    image_bytes = rimg.content
                    
                    datetime_str = self._get_datetime_filename()
                    filename = f"gen_minimax_{datetime_str}_{i}_{img_idx}_{self._unique_suffix()}.png"
                    file_path = output_path / filename
                    
                    with open(file_path, "wb") as f:
                        f.write(image_bytes)
                    saved_files.append(str(file_path))
                    print(f"[ImageGenerator] Saved MiniMax image to {file_path}")
                    
            except Exception as e:
                print(f"[ImageGenerator] MiniMax error: {e}")
                if not saved_files: raise e
                
        return saved_files

    def generate(self, prompt: str, output_dir: str = "data/images", count: int = 1,
                 aspect_ratio: str = "1:1", image_size: str = "1K",
                 progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
                 request_timeout_seconds: int = IMAGE_REQUEST_TIMEOUT_SECONDS) -> List[str]:
        """
        生成图片并保存到本地
        :param prompt: 提示词
        :param output_dir: 输出目录
        :param count: 生成数量
        :param aspect_ratio: 图片比例 (仅 OpenRouter)
        :param image_size: 图片尺寸 (仅 OpenRouter)
        :return: 图片的本地路径列表
        """
        if self.provider == "minimax":
            print(f"[ImageGenerator] Routing: provider=minimax → generate_via_minimax")
            return self.generate_via_minimax(
                prompt,
                output_dir,
                count=count,
                aspect_ratio=aspect_ratio
            )

        if self.provider == "openrouter":
            print(f"[ImageGenerator] Routing: provider=openrouter → chat/completions with modalities")
            errors: List[str] = []
            for model_name in self._image_model_candidates():
                for attempt in range(1, IMAGE_RATE_LIMIT_RETRIES + 2):
                    try:
                        return self.generate_via_openai_compatible_chat_image(
                            prompt,
                            output_dir,
                            count=count,
                            aspect_ratio=aspect_ratio,
                            image_size=image_size,
                            model_override=model_name,
                            request_timeout_seconds=request_timeout_seconds,
                        )
                    except RateLimitError as e:
                        errors.append(f"{model_name} rate_limit attempt {attempt}: {e}")
                        if attempt <= IMAGE_RATE_LIMIT_RETRIES:
                            self._sleep_after_rate_limit(attempt)
                            continue
                        print(f"[ImageGenerator] Model {model_name} exhausted after retries")
                        break
                    except TimeoutError as e:
                        errors.append(f"{model_name} timeout: {e}")
                        print(f"[ImageGenerator] Model {model_name} timed out, trying fallback if available")
                        break
                    except Exception as e:
                        errors.append(f"{model_name}: {e}")
                        print(f"[ImageGenerator] Model {model_name} failed: {e}")
                        break

            raise RuntimeError("图片生成失败，所有可用生图模型均不可用: " + " | ".join(errors))

        model_str = (self.model or "").lower().strip()
        if self._supports_chat_completions_image_generation():
            print(f"[ImageGenerator] Routing: provider={self.provider} model={self.model} → chat/completions image API")
            return self.generate_via_openai_compatible_chat_image(
                prompt,
                output_dir,
                count=count,
                aspect_ratio=aspect_ratio,
                image_size=image_size,
                model_override=self.model,
                request_timeout_seconds=request_timeout_seconds,
            )

        if self.provider == "tuzi" and "preview-async" in model_str:
            print(f"[ImageGenerator] Routing: provider=tuzi async model={self.model} → /videos async API")
            return self.generate_via_tuzi_async(
                prompt,
                output_dir,
                count=count,
                aspect_ratio=aspect_ratio,
                model_override=self.model,
                progress_callback=progress_callback,
            )

        if "preview-async" in model_str:
            print(f"[ImageGenerator] Routing: model={self.model} → chat/completions (async)")
            return self.generate_via_chat_async(
                prompt,
                output_dir,
                count=count,
                stream=False,
                request_timeout_seconds=request_timeout_seconds,
            )

        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        saved_files = []

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept-Encoding": "identity",
        }

        # 映射小红书等常用比例到标准 size
        size_str = "768x1024" # 默认小红书 3:4
        if aspect_ratio == "4:3":
            size_str = "1024x768"
        elif aspect_ratio == "16:9":
            size_str = "1024x576"
        elif aspect_ratio == "9:16":
            size_str = "576x1024"
        elif aspect_ratio == "1:1":
            size_str = "1024x1024"

        payload = {
            "model": self.model,
            "prompt": prompt,
            "n": 1,
            "size": size_str,
        }
        endpoint = f"{self.base_url.rstrip('/')}/images/generations"

        for i in range(count):
            try:
                print(f"[ImageGenerator] Generating image {i+1}/{count} (Native API)...")
                start_time = time.time()
                response = requests.post(
                    endpoint,
                    headers=headers,
                    json=payload,
                    timeout=request_timeout_seconds
                )
                duration = time.time() - start_time
                print(f"[ImageGenerator] Generated in {duration:.2f}s")

                if response.status_code == 429:
                    raise RateLimitError(message="Rate limit exceeded", response=response, body=None)
                elif response.status_code != 200:
                    raise Exception(f"API Error {response.status_code}: {response.text[:200]}")

                datetime_str = self._get_datetime_filename()
                
                try:
                    result = response.json()
                except Exception as json_err:
                    print(f"[ImageGenerator] JSON Decode Error: {json_err}")
                    print(f"[ImageGenerator] Response Text (First 1000 chars): {response.text[:1000]}")
                    raise ValueError(f"Invalid JSON response from API (Status {response.status_code}): {response.text[:100]}...")

                # DEBUG: Save full JSON response for inspection
                response_suffix = self._unique_suffix()
                debug_json_path = output_path / f"debug_response_{datetime_str}_{i}_{response_suffix}.json"
                with open(debug_json_path, "w") as f_json:
                    json.dump(result, f_json)
                print(f"[ImageGenerator] DEBUG: Saved full JSON response to {debug_json_path}")

                if not result.get("data"):
                    raise ValueError(
                        f"模型 {self.model} 返回空图片结果，请更换可用模型或稍后重试"
                    )

                image_obj = result["data"][0]
                image_base64 = image_obj.get('b64_json')
                image_url = image_obj.get('url')

                filename = f"gen_{datetime_str}_{i}_{response_suffix}.png"
                file_path = output_path / filename

                if image_base64:
                    try:
                        missing_padding = len(image_base64) % 4
                        if missing_padding:
                            image_base64 += '=' * (4 - missing_padding)
                        image_bytes = base64.b64decode(image_base64)
                    except Exception as b64_err:
                        print(f"[ImageGenerator] Base64 decoding failed: {b64_err}")
                        print(f"[ImageGenerator] Base64 string length: {len(image_base64)}")
                        print(f"[ImageGenerator] Base64 snippet (first 50): {image_base64[:50]}")
                        raise ValueError(f"Invalid Base64 response from API: {b64_err}")

                    # Some gateways prepend SSL or other binary garbage before the actual JPEG/PNG.
                        # We must find the standard JPEG start marker (ffd8ffe0 or ffd8ffe1 or ffd8ffdb etc)
                        # More robust: find b'\xff\xd8\xff' instead of just b'\xff\xd8' which might match garbage.
                        jpeg_start = image_bytes.find(b'\xff\xd8\xff')
                        png_start = image_bytes.find(b'\x89PNG')
                        if jpeg_start != -1:
                            print(f"[ImageGenerator] Warning: Found JPEG header at offset {jpeg_start}. Trimming garbage data.")
                            image_bytes = image_bytes[jpeg_start:]
                        elif png_start != -1:
                            print(f"[ImageGenerator] Warning: Found PNG header at offset {png_start}. Trimming garbage data.")
                            image_bytes = image_bytes[png_start:]

                    with open(file_path, "wb") as f:
                        f.write(image_bytes)

                    try:
                        from PIL import Image
                        from io import BytesIO
                        Image.open(BytesIO(image_bytes)).verify()
                        print(f"[ImageGenerator] Validated image integrity: OK")
                    except Exception as verify_err:
                        print(f"[ImageGenerator] ❌ Image validation failed: {verify_err}")
                        debug_filename = f"debug_corrupted_{datetime_str}_{i}.bin"
                        debug_path = output_path / debug_filename
                        with open(debug_path, "wb") as f_debug:
                            f_debug.write(image_bytes)
                        print(f"[ImageGenerator] SAVED CORRUPTED DATA TO: {debug_path}")
                        import binascii
                        print(f"[ImageGenerator] HEX DUMP (First 100 bytes): {binascii.hexlify(image_bytes[:100])}")
                        if file_path.exists():
                            file_path.unlink()
                        raise ValueError(f"API returned corrupted image data: {verify_err}")

                    saved_files.append(str(file_path))
                    print(f"[ImageGenerator] Saved base64 image to {file_path}")

                elif image_url:
                    print(f"[ImageGenerator] Downloading image from {image_url}")
                    resp = requests.get(image_url, timeout=60)
                    resp.raise_for_status()
                    image_bytes = resp.content
                    try:
                        from PIL import Image
                        from io import BytesIO
                        Image.open(BytesIO(image_bytes)).verify()
                        print(f"[ImageGenerator] Validated image (from URL) integrity: OK")
                    except Exception as verify_err:
                        print(f"[ImageGenerator] ❌ Image (from URL) validation failed: {verify_err}")
                        debug_filename = f"debug_url_corrupted_{datetime_str}_{i}.bin"
                        debug_path = output_path / debug_filename
                        with open(debug_path, "wb") as f_debug:
                            f_debug.write(image_bytes)
                        print(f"[ImageGenerator] SAVED CORRUPTED URL DATA TO: {debug_path}")
                        raise ValueError(f"Downloaded image corrupted: {verify_err}")

                    with open(file_path, "wb") as f:
                        f.write(image_bytes)
                    saved_files.append(str(file_path))
                    print(f"[ImageGenerator] Saved url image to {file_path}")
                else:
                    print(f"[ImageGenerator] Error: No base64 or url in response")

            except RateLimitError as e:
                print(f"[ImageGenerator] ⚠️ Rate Limit Exceeded: {e}")
                raise e
            except requests.exceptions.Timeout as e:
                raise TimeoutError(
                    f"图片生成超时，模型 {self.model} 在 {request_timeout_seconds} 秒内未返回结果"
                ) from e
            except Exception as e:
                print(f"[ImageGenerator] Caught Exception type: {type(e).__name__}")
                print(f"[ImageGenerator] Error generating image {i+1}: {e}")
                import traceback
                traceback.print_exc()
                if count == 1 or i == count - 1:
                    if not saved_files:
                        raise e

        print(f"[ImageGenerator] Finished. Saved {len(saved_files)} files.")
        return saved_files

    def edit_image(self, image_path: str, edit_prompt: str, output_dir: str = "data/images",
                   aspect_ratio: str = "1:1", image_size: str = "1K",
                   supporting_image_paths: Optional[List[str]] = None,
                   allow_reduced_supporting_retry: bool = True,
                   edit_purpose: Optional[str] = None,
                   candidate_offset_seed: Optional[str] = None,
                   candidate_offset: Optional[int] = None,
                   candidate_chain: Optional[List[Dict[str, str]]] = None) -> List[str]:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        print(f"[ImageGenerator] Starting image edit with provider: {self.provider}")
        print(f"[ImageGenerator] Input image: {image_path}")
        print(f"[ImageGenerator] Supporting images: {len(supporting_image_paths or [])}")
        print(f"[ImageGenerator] Edit prompt: {edit_prompt[:100]}...")
        self.last_edit_metadata = {}
        candidates = candidate_chain or self.resolve_edit_candidates_for_task(candidate_offset_seed, candidate_offset=candidate_offset)
        if not candidates:
            raise ValueError("未配置图片编辑模型或网关参数")

        last_error: Optional[Exception] = None
        image_base64: Optional[str] = None
        mime_type: Optional[str] = None
        supporting_images: Optional[List[tuple[str, str]]] = None
        valid_supporting_paths = [
            path
            for path in (supporting_image_paths or [])
            if path and Path(path).exists()
        ]
        has_supporting_images = bool(valid_supporting_paths)
        is_logo_replacement = str(edit_purpose or "").strip().lower() == "logo_replacement"
        transient_retries = max(0, LOGO_REPLACEMENT_EDIT_RETRIES if is_logo_replacement else IMAGE_EDIT_TRANSIENT_RETRIES)
        request_timeout_seconds = LOGO_REPLACEMENT_EDIT_TIMEOUT_SECONDS if is_logo_replacement else IMAGE_REQUEST_TIMEOUT_SECONDS

        for index, candidate in enumerate(candidates):
            candidate_model = candidate["model"]
            candidate_provider = candidate["provider"]
            candidate_base_url = candidate["base_url"]
            candidate_api_key = candidate["api_key"]
            print(
                f"[ImageGenerator] Edit candidate {index + 1}/{len(candidates)}: "
                f"model={candidate_model}, provider={candidate_provider}, base_url={candidate_base_url}"
            )
            try:
                temp_generator = ImageGenerator(
                    api_key=candidate_api_key,
                    base_url=candidate_base_url,
                    model=candidate_model,
                    provider=candidate_provider,
                )
                if candidate_provider == "openrouter" or temp_generator._supports_chat_completions_image_generation(candidate_model):
                    if image_base64 is None or mime_type is None:
                        image_base64, mime_type = self._image_to_base64(image_path)
                        print(f"[ImageGenerator] Image converted to base64 once, mime_type: {mime_type}")
                    if supporting_images is None:
                        supporting_images = [
                            self._image_to_base64(path)
                            for path in (supporting_image_paths or [])
                            if path and Path(path).exists()
                        ]
                    safe_prompt_retry_used = False
                    safe_retry_prompt = self._build_safe_edit_retry_prompt(aspect_ratio)
                    for attempt in range(1, transient_retries + 3):
                        try:
                            prompt_for_attempt = safe_retry_prompt if safe_prompt_retry_used else edit_prompt
                            result = temp_generator._edit_image_openrouter(
                                image_base64,
                                mime_type,
                                prompt_for_attempt,
                                output_path,
                                aspect_ratio,
                                image_size,
                                supporting_images=supporting_images,
                                request_timeout_seconds=request_timeout_seconds,
                            )
                            break
                        except Exception as retry_error:
                            if not self._is_transient_edit_error(retry_error):
                                raise
                            if attempt > transient_retries:
                                if not self._should_retry_edit_with_safe_prompt(retry_error):
                                    raise
                                if safe_prompt_retry_used:
                                    raise
                                safe_prompt_retry_used = True
                                print(
                                    "[ImageGenerator] Transient edit error persisted; retrying once with a shorter safe prompt "
                                    f"and the same {len(supporting_images or [])} supporting images: {retry_error}"
                                )
                                continue
                            delay = IMAGE_EDIT_TRANSIENT_BACKOFF_SECONDS * attempt
                            print(
                                f"[ImageGenerator] Transient edit error with full references, retrying same inputs "
                                f"after {delay}s (attempt {attempt}/{transient_retries}): {retry_error}"
                            )
                            time.sleep(delay)
                    self.last_edit_metadata = {
                        "edit_actual_model": candidate_model,
                        "edit_actual_base_url": candidate_base_url,
                        "edit_fallback_used": index > 0,
                        "supporting_images_used": len(supporting_images or []),
                        "safe_prompt_retry_used": safe_prompt_retry_used,
                    }
                    return result
                safe_prompt_retry_used = False
                safe_retry_prompt = self._build_safe_edit_retry_prompt(aspect_ratio)
                for attempt in range(1, transient_retries + 3):
                    try:
                        prompt_for_attempt = safe_retry_prompt if safe_prompt_retry_used else edit_prompt
                        result = temp_generator._edit_image_tuzi(
                            image_path,
                            prompt_for_attempt,
                            output_path,
                            aspect_ratio,
                            image_size,
                            supporting_image_paths=valid_supporting_paths,
                            request_timeout_seconds=request_timeout_seconds,
                        )
                        break
                    except Exception as retry_error:
                        if not self._is_transient_edit_error(retry_error):
                            raise
                        if attempt > transient_retries:
                            if not self._should_retry_edit_with_safe_prompt(retry_error):
                                raise
                            if safe_prompt_retry_used:
                                raise
                            safe_prompt_retry_used = True
                            print(
                                "[ImageGenerator] Transient edit error persisted; retrying once with a shorter safe prompt "
                                f"and the same {len(valid_supporting_paths)} supporting images: {retry_error}"
                            )
                            continue
                        delay = IMAGE_EDIT_TRANSIENT_BACKOFF_SECONDS * attempt
                        print(
                            f"[ImageGenerator] Transient edit error with full references, retrying same inputs "
                            f"after {delay}s (attempt {attempt}/{transient_retries}): {retry_error}"
                        )
                        time.sleep(delay)
                self.last_edit_metadata = {
                    "edit_actual_model": candidate_model,
                    "edit_actual_base_url": candidate_base_url,
                    "edit_fallback_used": index > 0,
                    "supporting_images_used": len(valid_supporting_paths),
                    "safe_prompt_retry_used": safe_prompt_retry_used,
                }
                return result
            except Exception as error:
                last_error = error
                print(f"[ImageGenerator] Edit candidate failed: model={candidate_model}, error={error}")
                if allow_reduced_supporting_retry and has_supporting_images and self._should_retry_edit_without_supporting_images(error):
                    print("[ImageGenerator] Retrying image edit with reduced supporting images; supporting material metadata stays in prompt.")
                    try:
                        uses_chat_edit = candidate_provider == "openrouter" or temp_generator._supports_chat_completions_image_generation(candidate_model)
                        if uses_chat_edit:
                            retry_supporting_sets: List[List[tuple[str, str]]] = []
                            if supporting_images and len(supporting_images) > 1:
                                retry_supporting_sets.append(supporting_images[:1])
                            retry_supporting_sets.append([])
                            retry_iterable = retry_supporting_sets
                        else:
                            retry_supporting_path_sets: List[List[str]] = []
                            if len(valid_supporting_paths) > 1:
                                retry_supporting_path_sets.append(valid_supporting_paths[:1])
                            retry_supporting_path_sets.append([])
                            retry_iterable = retry_supporting_path_sets

                        for reduced_supporting in retry_iterable:
                            if uses_chat_edit:
                                if image_base64 is None or mime_type is None:
                                    image_base64, mime_type = self._image_to_base64(image_path)
                                result = temp_generator._edit_image_openrouter(
                                    image_base64,
                                    mime_type,
                                    edit_prompt,
                                    output_path,
                                    aspect_ratio,
                                    image_size,
                                    supporting_images=reduced_supporting,
                                )
                            else:
                                result = temp_generator._edit_image_tuzi(
                                    image_path,
                                    edit_prompt,
                                    output_path,
                                    aspect_ratio,
                                    image_size,
                                    supporting_image_paths=reduced_supporting,
                                )
                            used_supporting_count = len(reduced_supporting)
                            self.last_edit_metadata = {
                                "edit_actual_model": candidate_model,
                                "edit_actual_base_url": candidate_base_url,
                                "edit_fallback_used": index > 0,
                                "supporting_images_dropped_after_retry": used_supporting_count < len(valid_supporting_paths),
                                "supporting_images_used_after_retry": used_supporting_count,
                            }
                            return result
                    except Exception as primary_only_error:
                        last_error = primary_only_error
                        print(f"[ImageGenerator] Reduced-reference edit retry failed: model={candidate_model}, error={primary_only_error}")
                if index < len(candidates) - 1 and self._is_retryable_edit_error(error):
                    print("[ImageGenerator] Retrying image edit with fallback model...")
                    continue
                raise

        if last_error:
            raise last_error
        raise RuntimeError("图片编辑失败，未获得任何结果")

    def _edit_image_tuzi(self, image_path: str, edit_prompt: str, 
                         output_path: Path, aspect_ratio: str, image_size: str,
                         supporting_image_paths: Optional[List[str]] = None,
                         request_timeout_seconds: Optional[int] = None) -> List[str]:
        saved_files: List[str] = []
        
        try:
            from openai import OpenAI
            
            client = OpenAI(
                base_url=self.base_url,
                api_key=self.api_key,
                timeout=request_timeout_seconds or IMAGE_REQUEST_TIMEOUT_SECONDS,
                default_headers={"Accept-Encoding": "identity"},
            )
            
            print(f"[ImageGenerator] Sending edit request to Tuzi API (OpenAI format)...")
            print(f"[ImageGenerator] Image: {image_path}")
            print(f"[ImageGenerator] Prompt: {edit_prompt[:100]}...")
            
            start_time = time.time()

            image_files = []
            try:
                image_files.append(open(image_path, "rb"))
                for supporting_path in supporting_image_paths or []:
                    if supporting_path and Path(supporting_path).exists():
                        image_files.append(open(supporting_path, "rb"))

                prompt = edit_prompt
                if len(image_files) > 1:
                    prompt = (
                        f"{edit_prompt}\n\n"
                        "The first image is the target image to edit. "
                        "All following images are reference materials from the user's chat attachments. "
                        "Use them for logos, screenshots, layout, style, objects, or visual details when the instruction asks for them."
                    )

                result = client.images.edit(
                    model=self.model,
                    image=image_files if len(image_files) > 1 else image_files[0],
                    prompt=prompt,
                    timeout=request_timeout_seconds or IMAGE_REQUEST_TIMEOUT_SECONDS,
                )
            finally:
                for file_handle in image_files:
                    try:
                        file_handle.close()
                    except Exception:
                        pass
            
            duration = time.time() - start_time
            print(f"[ImageGenerator] Tuzi edit request finished in {duration:.2f}s")

            result_data = getattr(result, "data", None)
            if not result_data:
                raise ValueError("Tuzi edit API returned no image data")
            
            for img_idx, img_data in enumerate(result_data):
                if img_data.url:
                    image_bytes = self._image_bytes_from_source(img_data.url, timeout=120)
                    
                    try:
                        from PIL import Image
                        from io import BytesIO
                        Image.open(BytesIO(image_bytes)).verify()
                        print(f"[ImageGenerator] Validated edited image integrity: OK")
                    except Exception as verify_err:
                        raise ValueError(f"Tuzi edited image corrupted: {verify_err}")
                    
                    datetime_str = self._get_datetime_filename()
                    filename = f"edit_tuzi_{datetime_str}_{img_idx}_{self._unique_suffix()}.png"
                    file_path = output_path / filename
                    
                    with open(file_path, "wb") as f:
                        f.write(image_bytes)
                    saved_files.append(str(file_path))
                    print(f"[ImageGenerator] Saved edited image to {file_path}")
                    
                elif img_data.b64_json:
                    print(f"[ImageGenerator] Processing base64 edited image...")
                    image_bytes = base64.b64decode(img_data.b64_json)
                    
                    try:
                        from PIL import Image
                        from io import BytesIO
                        Image.open(BytesIO(image_bytes)).verify()
                        print(f"[ImageGenerator] Validated edited image integrity: OK")
                    except Exception as verify_err:
                        raise ValueError(f"Tuzi edited image corrupted: {verify_err}")
                    
                    datetime_str = self._get_datetime_filename()
                    filename = f"edit_tuzi_{datetime_str}_{img_idx}_{self._unique_suffix()}.png"
                    file_path = output_path / filename
                    
                    with open(file_path, "wb") as f:
                        f.write(image_bytes)
                    saved_files.append(str(file_path))
                    print(f"[ImageGenerator] Saved edited image to {file_path}")
            
            if not saved_files:
                raise ValueError("No images returned from Tuzi edit API")
                
        except Exception as e:
            print(f"[ImageGenerator] Tuzi edit error: {e}")
            import traceback
            traceback.print_exc()
            raise e

        return saved_files

    def _edit_image_openrouter(self, image_base64: str, mime_type: str, edit_prompt: str,
                               output_path: Path, aspect_ratio: str, image_size: str,
                               supporting_images: Optional[List[tuple[str, str]]] = None,
                               request_timeout_seconds: Optional[int] = None) -> List[str]:
        saved_files: List[str] = []
        
        endpoint = f"{self.base_url.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        data_uri = f"data:{mime_type};base64,{image_base64}"
        
        content_items = [
            {"type": "text", "text": edit_prompt},
            {"type": "image_url", "image_url": {"url": data_uri}}
        ]
        for supporting_base64, supporting_mime_type in supporting_images or []:
            content_items.append({
                "type": "image_url",
                "image_url": {"url": f"data:{supporting_mime_type};base64,{supporting_base64}"}
            })

        if supporting_images:
            content_items[0]["text"] = (
                f"{edit_prompt}\n\n"
                "Image 1 is the target image to edit. The following images are reference materials attached by the user. "
                "Use them as visual references for logos, screenshots, style, layout, or replacement content as requested."
            )

        payload = {
            "model": self.model,
            "messages": [{
                "role": "user",
                "content": content_items
            }],
            "modalities": ["image", "text"],
        }

        image_config = {}
        if aspect_ratio and aspect_ratio != "1:1":
            image_config["aspect_ratio"] = aspect_ratio
        if image_size and image_size != "1K":
            image_config["image_size"] = image_size
        
        if image_config:
            payload["image_config"] = image_config
            print(f"[ImageGenerator] Using image_config: {image_config}")
        transport_label = "OpenRouter" if self.resolve_provider(self.base_url) == "openrouter" else "Chat image edit"

        try:
            print(f"[ImageGenerator] Sending edit request via {transport_label}...")
            start_time = time.time()
            resp = requests.post(endpoint, headers=headers, json=payload, timeout=request_timeout_seconds or 300)
            duration = time.time() - start_time
            print(f"[ImageGenerator] {transport_label} request finished in {duration:.2f}s (status {resp.status_code})")

            if resp.status_code == 429:
                raise RateLimitError(message="Rate limit exceeded", response=resp, body=None)
            elif resp.status_code != 200:
                print(f"[ImageGenerator] {transport_label} error response: {resp.text[:500]}")
                raise Exception(f"{transport_label} API Error {resp.status_code}: {resp.text[:200]}")

            data = resp.json()
            choices = data.get("choices", [])
            if not choices:
                raise ValueError(f"Empty choices in {transport_label} response")

            message = choices[0].get("message", {})
            images = message.get("images", [])
            
            if not images:
                raise ValueError(f"No images in {transport_label} response. Message: {message.get('content', '')[:200]}")

            if len(images) > 1:
                print(f"[ImageGenerator] Warning: {transport_label} returned {len(images)} images, only saving the first one")

            for img_idx, img_obj in enumerate(images[:1]):
                image_url = img_obj.get("image_url", {}).get("url", "")
                
                if not image_url:
                    print(f"[ImageGenerator] Warning: Empty image URL in edit response")
                    continue
                
                if image_url.startswith("data:image"):
                    print(f"[ImageGenerator] Processing base64 edited image from {transport_label}...")
                    header, encoded = image_url.split(",", 1)
                    image_bytes = base64.b64decode(encoded)
                else:
                    print(f"[ImageGenerator] Downloading edited image from URL: {image_url[:50]}...")
                    rimg = requests.get(image_url, timeout=120)
                    rimg.raise_for_status()
                    image_bytes = rimg.content

                try:
                    from PIL import Image
                    from io import BytesIO
                    Image.open(BytesIO(image_bytes)).verify()
                    print(f"[ImageGenerator] Validated {transport_label} edited image integrity: OK")
                except Exception as verify_err:
                    raise ValueError(f"{transport_label} edited image corrupted: {verify_err}")

                datetime_str = self._get_datetime_filename()
                filename = f"edit_chat_{datetime_str}_{img_idx}_{self._unique_suffix()}.png"
                file_path = output_path / filename

                with open(file_path, "wb") as f:
                    f.write(image_bytes)
                saved_files.append(str(file_path))
                print(f"[ImageGenerator] Saved edited image to {file_path}")
            
            if not saved_files:
                raise ValueError(f"No images returned from {transport_label} API")

        except RateLimitError as e:
            print(f"[ImageGenerator] ⚠️ {transport_label} rate limit exceeded: {e}")
            raise e
        except Exception as e:
            print(f"[ImageGenerator] {transport_label} error: {e}")
            import traceback
            traceback.print_exc()
            raise e
        
        return saved_files
