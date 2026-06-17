from fastapi import APIRouter, HTTPException, BackgroundTasks, UploadFile, File, Depends, Query, Form, Header
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from pathlib import Path
import asyncio
import base64
import hashlib
import httpx
import io
import json
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timezone
from openai import OpenAI
from PIL import Image

from backend.utils.task_manager import task_manager, TaskStatus
from backend.utils.image_task_store import ensure_image_task_schema, load_task_snapshot, save_task_snapshot
from backend.utils.image_prompt_log_store import list_image_prompt_logs, save_image_prompt_log
from backend.utils.note_strategy_log_store import list_recent_note_strategy_signals, save_note_strategy_log
from backend.utils.logger import logger
from backend.api.models import EditImageRequest, EditImageResponse, PolishContentRequest, PolishContentResponse
from backend.config import settings
from backend.config.paths import get_static_images_dir, get_uploads_dir
from backend.services.content_analyzer import (
    get_text_generation_config_candidates,
    get_text_generation_model,
    get_text_generation_model_candidates,
    is_retryable_text_generation_error,
    resolve_text_generation_config,
)
from backend.utils.ai_parser import clean_and_parse_ai_json, extract_json_list
from backend.middleware.user_context import get_current_user_id
from backend.database.db_session import get_db
from backend.database import db_session
from sqlalchemy.orm import Session
from sqlalchemy import inspect, text
from backend.services.auth_service import decode_access_token
from backend.services.template_visual_service import (
    compose_template_payload,
    compose_template_series_payload,
    normalize_template_kind,
    build_note_visual_plan,
)
from backend.services.note_strategy_service import NoteStrategyService
from backend.services.model_gateway_diagnostics import classify_model_gateway_error
from backend.services.image_generator import (
    IMAGE_REQUEST_TIMEOUT_SECONDS,
    LOGO_REPLACEMENT_EDIT_TIMEOUT_SECONDS,
    build_image_candidate_chain,
)
from backend.services.image_job_runner import ImageJobCancelled, get_image_job_runner_stats, image_job_slot, resolve_image_job_policy_limit
from backend.services.text_job_runner import (
    get_research_text_job_runner_stats,
    get_revision_text_job_runner_stats,
    get_strategy_text_job_runner_stats,
    get_text_job_runner_stats,
    run_research_text_job,
    run_revision_text_job,
    run_strategy_text_job,
    run_text_job,
)
router = APIRouter(prefix="/api/visual", tags=["visual"])

VISUAL_PROMPT_TIMEOUT_SECONDS = 90.0
POLISH_CONTENT_TIMEOUT_SECONDS = 60.0
TEXT_MODEL_ROUTE_TIMEOUT_SECONDS = 180.0
NOTE_STRATEGY_ROUTE_TIMEOUT_SECONDS = 420.0
CONTENT_GENERATION_ROUTE_TIMEOUT_SECONDS = 360.0
VISUAL_PROMPT_MAX_CONTENT_CHARS = 1400
VISUAL_PROMPT_MAX_TOKENS = 2200
PROMPT_OVERLOAD_RETRIES = 2
PROMPT_OVERLOAD_BACKOFF_SECONDS = 2
ASYNC_TEXT_TASK_MAX_ATTEMPTS = 2
ASYNC_TEXT_TASK_RETRY_BACKOFF_SECONDS = 3
STRATEGY_DIRECT_SYNC_MAX_ATTEMPTS = 4
STRATEGY_DIRECT_SYNC_RETRY_BACKOFF_SECONDS = 3
TUZI_TASK_REFRESH_INTERVAL_SECONDS = 10
TUZI_WORKFLOW_MAX_CONCURRENCY = 2
DEFAULT_IMAGE_WORKFLOW_CONCURRENCY = 1
DEFAULT_WORKFLOW_STAGGER_SECONDS = 0.0
MATERIAL_FUSION_MAX_IMAGE_COUNT = 6
DEFAULT_MATERIAL_FUSION_EDIT_STAGGER_SECONDS = 45.0
GEMINI_WORKFLOW_CONCURRENCY = 2
GEMINI_WORKFLOW_STAGGER_SECONDS = 6.0
N9E_WORKFLOW_STAGGER_SECONDS = 8.0
SYNC_IMAGE_TASK_TIMEOUT_SECONDS = 150
SYNC_IMAGE_TASK_STALE_GRACE_SECONDS = 30
GEMINI_SYNC_IMAGE_TASK_TIMEOUT_SECONDS = 240
IMAGE_EDIT_SYNC_IMAGE_TASK_TIMEOUT_SECONDS = 480
LOGO_REPLACEMENT_SYNC_IMAGE_TASK_TIMEOUT_SECONDS = LOGO_REPLACEMENT_EDIT_TIMEOUT_SECONDS
IMAGE2_DYNAMIC_SYNC_IMAGE_TASK_TIMEOUT_SECONDS = 840
IMAGE2_DYNAMIC_SYNC_IMAGE_TASK_STALE_GRACE_SECONDS = 60
IMAGE2_DYNAMIC_IMAGE_REQUEST_TIMEOUT_SECONDS = 420
IMAGE2_DYNAMIC_MAX_RETRIES = 1
IMAGE2_QUALITY_MODES = {"image2_dynamic", "style_expression"}
STYLE_EXPRESSION_PARAM_KEYS = {"style_preset", "stylePreset", "visual_style", "visualStyle"}
LOGO_REPLACEMENT_RESOURCE_COOLDOWN_SECONDS = int(os.getenv("LOGO_REPLACEMENT_RESOURCE_COOLDOWN_SECONDS", "600"))
_LOGO_REPLACEMENT_RESOURCE_COOLDOWNS: Dict[str, float] = {}
MODEL_CANDIDATE_COOLDOWN_SECONDS = int(os.getenv("MODEL_CANDIDATE_COOLDOWN_SECONDS", "600"))
_MODEL_CANDIDATE_COOLDOWNS: Dict[str, Dict[str, Any]] = {}
KNOWN_UNAVAILABLE_IMAGE_MODELS = {
    "gemini-2.5-flash-image-preview",
}
PROMPT_VARIANT_SPECS = [
    {
        "variant_key": "hero_cover",
        "type": "Cover",
        "title": "封面主视觉型",
        "layout_family": "headline_hero",
        "visual_focus": "大标题 + 单一主视觉锚点",
        "composition_instruction": "Use a dominant hero object with oversized headline typography, strong focal hierarchy, and minimal secondary info.",
    },
    {
        "variant_key": "benefit_card",
        "type": "Content",
        "title": "卖点信息卡型",
        "layout_family": "info_card_grid",
        "visual_focus": "卖点卡片 + 功能信息块",
        "composition_instruction": "Use modular benefit cards, icon-driven blocks, and a clean information hierarchy with medium-density content.",
    },
    {
        "variant_key": "scenario_breakdown",
        "type": "Content",
        "title": "场景功能拆解型",
        "layout_family": "scenario_storyboard",
        "visual_focus": "场景拆解 + 使用路径",
        "composition_instruction": "Use a storyboard-like or step-by-step scene layout that explains usage flow, scene details, or before/after transformation.",
    },
    {
        "variant_key": "step_detail",
        "type": "Content",
        "title": "步骤细化型",
        "layout_family": "step_walkthrough",
        "visual_focus": "步骤拆分 + 操作重点",
        "composition_instruction": "Use a step-by-step educational layout with clear sequencing, numbered highlights, and one practical action takeaway.",
    },
    {
        "variant_key": "comparison_focus",
        "type": "Content",
        "title": "对比亮点型",
        "layout_family": "before_after_focus",
        "visual_focus": "前后对比 + 结果变化",
        "composition_instruction": "Use a contrast-led composition that emphasizes before/after differences, visible improvements, and one decisive conclusion.",
    },
    {
        "variant_key": "closing_cta",
        "type": "Content",
        "title": "收口行动型",
        "layout_family": "summary_cta",
        "visual_focus": "总结收口 + 行动引导",
        "composition_instruction": "Use a closing summary composition with one key takeaway, compact supporting bullets, and a strong final CTA.",
    },
]
PROVIDER_CONCURRENCY_LIMITS = {
    "custom": 3,
    "openrouter": 3,
    "tuzi": 2,
    "minimax": 2,
    "n9e": 1,
}

IMAGE2_DYNAMIC_WORKFLOW_CONCURRENCY = max(1, int(os.getenv("IMAGE2_DYNAMIC_WORKFLOW_CONCURRENCY", "4")))
MATERIAL_FUSION_EDIT_CONCURRENCY = max(1, int(os.getenv("MATERIAL_FUSION_EDIT_CONCURRENCY", "2")))
MATERIAL_FUSION_EDIT_STAGGER_SECONDS = float(os.getenv("MATERIAL_FUSION_EDIT_STAGGER_SECONDS", "0"))


def _is_gemini_sync_image_provider(provider: Optional[str], model: Optional[str]) -> bool:
    normalized_provider = (provider or "").lower()
    normalized_model = (model or "").lower()
    return normalized_provider in {"custom", "openrouter"} and "gemini" in normalized_model


def _resolve_sync_image_task_timeout_seconds(
    provider: Optional[str],
    model: Optional[str],
    *,
    mode: Optional[str] = None,
) -> int:
    normalized_mode = (mode or "").strip().lower()
    if normalized_mode == "logo_replacement":
        return LOGO_REPLACEMENT_SYNC_IMAGE_TASK_TIMEOUT_SECONDS
    if normalized_mode == "image_edit":
        return IMAGE_EDIT_SYNC_IMAGE_TASK_TIMEOUT_SECONDS
    if normalized_mode in IMAGE2_QUALITY_MODES:
        return IMAGE2_DYNAMIC_SYNC_IMAGE_TASK_TIMEOUT_SECONDS
    if _is_gemini_sync_image_provider(provider, model):
        return GEMINI_SYNC_IMAGE_TASK_TIMEOUT_SECONDS
    if model and "gpt-image" in model.lower():
        return 300 # image2 is known to be slow
    return SYNC_IMAGE_TASK_TIMEOUT_SECONDS


def _resolve_image_provider(base_url: Optional[str]) -> str:
    normalized_base_url = (base_url or "").lower()
    if "tu-zi.com" in normalized_base_url:
        return "tuzi"
    if "minimaxi.com" in normalized_base_url:
        return "minimax"
    if "openrouter.ai" in normalized_base_url:
        return "openrouter"
    if "api.example.com" in normalized_base_url or "n9e.tech" in normalized_base_url:
        return "n9e"
    return "custom"


def _mask_secret(secret: Optional[str]) -> str:
    value = (secret or "").strip()
    if not value:
        return "missing"
    if len(value) <= 10:
        return f"{value[:3]}***"
    return f"{value[:8]}...{value[-4:]}"


def _summarize_runtime_key_source(api_key: Optional[str]) -> str:
    value = (api_key or "").strip()
    if not value:
        return "missing"
    pooled_keys = [
        str(key or "").strip()
        for key in getattr(settings, "IMAGE_GEN_API_KEYS", [])
        if str(key or "").strip()
    ]
    for index, pooled_key in enumerate(pooled_keys, start=1):
        if value == pooled_key:
            return f"IMAGE_GEN_API_KEYS[{index}]"
    candidates = [
        ("ANTHROPIC_API_KEY", getattr(settings, "ANTHROPIC_API_KEY", "")),
        ("IMAGE_GEN_API_KEY", getattr(settings, "IMAGE_GEN_API_KEY", "")),
        ("OPENROUTER_API_KEY", getattr(settings, "OPENROUTER_API_KEY", "")),
        ("TUZI_API_KEY", getattr(settings, "TUZI_API_KEY", "")),
        ("MINIMAX_API_KEY", getattr(settings, "MINIMAX_API_KEY", "")),
    ]
    for name, configured in candidates:
        if value == (configured or "").strip():
            return name
    return "unknown_runtime_source"


def _image_candidate_resource_id(candidate: Dict[str, Any]) -> str:
    provider = str(candidate.get("provider") or "provider").strip() or "provider"
    base_url = str(candidate.get("base_url") or "").strip()
    model = str(candidate.get("model") or "").strip()
    key_slot = str(candidate.get("key_slot") or "").strip()
    if not key_slot:
        api_key = str(candidate.get("api_key") or "").strip()
        key_slot = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12] if api_key else "default"
    material = "|".join([provider, base_url, model, key_slot])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _candidate_cooldown_id(candidate: Dict[str, Any], *, kind: str) -> str:
    provider = str(candidate.get("provider") or kind or "provider").strip() or "provider"
    base_url = str(candidate.get("base_url") or "").strip()
    model = str(candidate.get("model") or "").strip()
    api_key = str(candidate.get("api_key") or "").strip()
    key_fingerprint = hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12] if api_key else "missing"
    material = "|".join([kind, provider, base_url, model, key_fingerprint])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]


def _purge_expired_model_candidate_cooldowns() -> None:
    if not _MODEL_CANDIDATE_COOLDOWNS:
        return
    now = time.monotonic()
    expired = [
        key
        for key, value in _MODEL_CANDIDATE_COOLDOWNS.items()
        if float(value.get("until") or 0) <= now
    ]
    for key in expired:
        _MODEL_CANDIDATE_COOLDOWNS.pop(key, None)


def _mark_model_candidate_unhealthy(candidate: Dict[str, Any], *, kind: str, reason: str) -> None:
    if MODEL_CANDIDATE_COOLDOWN_SECONDS <= 0:
        return
    cooldown_id = _candidate_cooldown_id(candidate, kind=kind)
    _MODEL_CANDIDATE_COOLDOWNS[cooldown_id] = {
        "until": time.monotonic() + MODEL_CANDIDATE_COOLDOWN_SECONDS,
        "kind": kind,
        "reason": reason,
        "model": candidate.get("model"),
        "base_url": candidate.get("base_url"),
        "label": candidate.get("label") or candidate.get("name") or candidate.get("provider"),
    }
    logger.warning(
        "[MODEL_COOLDOWN] mark kind=%s id=%s label=%s model=%s reason=%s cooldown_seconds=%s",
        kind,
        cooldown_id,
        candidate.get("label") or candidate.get("name") or candidate.get("provider") or "",
        candidate.get("model") or "",
        reason,
        MODEL_CANDIDATE_COOLDOWN_SECONDS,
    )


def _clear_model_candidate_cooldown(candidate: Dict[str, Any], *, kind: str) -> None:
    _MODEL_CANDIDATE_COOLDOWNS.pop(_candidate_cooldown_id(candidate, kind=kind), None)


def _prefer_healthy_model_candidates(candidates: List[Dict[str, Any]], *, kind: str) -> List[Dict[str, Any]]:
    if len(candidates) <= 1:
        return candidates
    _purge_expired_model_candidate_cooldowns()
    return sorted(
        candidates,
        key=lambda candidate: (
            _candidate_cooldown_id(candidate, kind=kind) in _MODEL_CANDIDATE_COOLDOWNS,
        ),
    )


def _edit_candidate_resource_id(candidate: Dict[str, Any]) -> str:
    return f"image_edit:{_image_candidate_resource_id(candidate)}"


def _logo_replacement_resource_cooldown_ids() -> set[str]:
    if not _LOGO_REPLACEMENT_RESOURCE_COOLDOWNS:
        return set()
    now = time.monotonic()
    expired = [
        resource_id
        for resource_id, until in _LOGO_REPLACEMENT_RESOURCE_COOLDOWNS.items()
        if until <= now
    ]
    for resource_id in expired:
        _LOGO_REPLACEMENT_RESOURCE_COOLDOWNS.pop(resource_id, None)
    return set(_LOGO_REPLACEMENT_RESOURCE_COOLDOWNS)


def _mark_logo_replacement_resource_unhealthy(resource_id: Optional[str], *, reason: str) -> None:
    normalized = str(resource_id or "").strip()
    if not normalized:
        return
    _LOGO_REPLACEMENT_RESOURCE_COOLDOWNS[normalized] = time.monotonic() + LOGO_REPLACEMENT_RESOURCE_COOLDOWN_SECONDS
    logger.warning(
        "[Visual] Logo replacement resource cooldown: resource=%s reason=%s cooldown_seconds=%s",
        normalized,
        reason,
        LOGO_REPLACEMENT_RESOURCE_COOLDOWN_SECONDS,
    )


def _clear_logo_replacement_resource_cooldown(resource_id: Optional[str]) -> None:
    normalized = str(resource_id or "").strip()
    if normalized:
        _LOGO_REPLACEMENT_RESOURCE_COOLDOWNS.pop(normalized, None)


def _prefer_available_edit_candidates(
    candidates: List[Dict[str, Any]],
    *,
    avoid_resource_ids: Optional[set[str]] = None,
) -> List[Dict[str, Any]]:
    if len(candidates) <= 1:
        return candidates
    runner_stats = get_image_job_runner_stats()
    active_by_resource = runner_stats.get("active_by_resource") or {}
    avoid_resource_ids = avoid_resource_ids or set()
    return sorted(
        candidates,
        key=lambda candidate: (
            _edit_candidate_resource_id(candidate) in avoid_resource_ids,
            int(active_by_resource.get(_edit_candidate_resource_id(candidate), 0) or 0),
        ),
    )


def _rotate_image_candidates_for_task(candidates: List[Dict[str, Any]], task_id: str) -> List[Dict[str, Any]]:
    if len(candidates) <= 1:
        return candidates
    offset = int(hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:8], 16) % len(candidates)
    rotated = candidates[offset:] + candidates[:offset]
    return _prefer_healthy_model_candidates(rotated, kind="image")


def _log_image_runtime_diagnostics(
    scene: str,
    *,
    api_key: Optional[str],
    base_url: Optional[str],
    model: Optional[str],
    provider: Optional[str],
    mode: Optional[str] = None,
    config_slot: Optional[str] = None,
) -> None:
    logger.info(
        "[IMAGE_DIAG] scene=%s mode=%s config_slot=%s provider=%s model=%s base_url=%s key_source=%s key=%s anthropic_base=%s image_base=%s image2_model=%s concept_model=%s",
        scene,
        mode or "",
        config_slot or "",
        provider or "unknown",
        model or "",
        base_url or "",
        _summarize_runtime_key_source(api_key),
        _mask_secret(api_key),
        getattr(settings, "ANTHROPIC_BASE_URL", ""),
        getattr(settings, "IMAGE_GEN_BASE_URL", ""),
        getattr(settings, "IMAGE2_GEN_MODEL", ""),
        getattr(settings, "CONCEPT_IMAGE_MODEL", getattr(settings, "IMAGE_GEN_MODEL", "")),
    )


def _get_visual_output_dir() -> Path:
    output_dir = get_static_images_dir()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def _get_reference_uploads_root() -> Path:
    uploads_root = get_uploads_dir()
    uploads_root.mkdir(parents=True, exist_ok=True)
    return uploads_root


def _resolve_generated_image_path(image_id: str) -> Path:
    output_dir = _get_visual_output_dir()
    direct_path = output_dir / image_id
    if image_id.endswith((".png", ".jpg", ".jpeg", ".webp")):
        return direct_path

    for suffix in (".png", ".jpg", ".jpeg", ".webp"):
        candidate = output_dir / f"{image_id}{suffix}"
        if candidate.exists():
            return candidate

    return output_dir / f"{image_id}.png"


def _save_runtime_task(task_id: str) -> None:
    snapshot = task_manager.get_task(task_id)
    if snapshot:
        save_task_snapshot(snapshot)


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def _compute_elapsed_seconds(queued_since: Optional[str]) -> Optional[int]:
    queued_at = _parse_iso_datetime(queued_since)
    if not queued_at:
        return None
    now = datetime.now(queued_at.tzinfo) if queued_at.tzinfo else datetime.now()
    return max(0, int((now - queued_at).total_seconds()))


def _compute_runtime_seconds(started_at: Optional[str]) -> Optional[int]:
    started = _parse_iso_datetime(started_at)
    if not started:
        return None
    now = datetime.now(started.tzinfo) if started.tzinfo else datetime.now()
    return max(0, int((now - started).total_seconds()))


def _tuzi_stage_from_status(external_status: Optional[str], has_external_task_id: bool) -> str:
    normalized = (external_status or "").lower()
    if not has_external_task_id:
        return "submitting"
    if normalized in {"queued", "pending", "submitted", "queue_full_retrying"}:
        return "queued"
    if normalized in {"running", "processing", "in_progress", "generating"}:
        return "processing"
    if normalized in {"completed", "succeeded", "success", "done", "finished"}:
        return "completed"
    if normalized in {"failed", "error", "cancelled"}:
        return "failed"
    return "submitted"


def _merge_tuzi_task_metadata(existing_metadata: Optional[Dict[str, Any]], **updates: Any) -> Dict[str, Any]:
    merged = dict(existing_metadata or {})
    explicit_stage = updates.get("stage")
    for key, value in updates.items():
        if value is not None:
            merged[key] = value
    if merged.get("external_task_id") and not merged.get("queued_since"):
        merged["queued_since"] = datetime.utcnow().isoformat()
    merged["poll_interval_seconds"] = TUZI_TASK_REFRESH_INTERVAL_SECONDS
    elapsed_seconds = _compute_elapsed_seconds(merged.get("queued_since"))
    if elapsed_seconds is not None:
        merged["elapsed_seconds"] = elapsed_seconds
    merged["stage"] = explicit_stage or merged.get("stage") or _tuzi_stage_from_status(
        merged.get("external_status"),
        bool(merged.get("external_task_id")),
    )
    return merged


def _is_image2_quality_mode(metadata: Optional[Dict[str, Any]]) -> bool:
    if not metadata:
        return False
    mode = str(metadata.get("prompt_strategy") or metadata.get("visual_mode_resolved") or "").strip().lower()
    return mode in IMAGE2_QUALITY_MODES


def _is_retryable_image_generation_error(error: Exception | str) -> bool:
    classified = classify_model_gateway_error(error)
    if classified["kind"] in {"network_unreachable", "gateway_failure", "quota_exhausted", "safety_service_unavailable"}:
        return True

    error_text = str(error or "").lower()
    retry_markers = [
        "timeout",
        "timed out",
        "connection error",
        "connecterror",
        "empty choices",
        "no images",
        "no base64 or url",
        "corrupted image",
        "bad gateway",
        "upstream",
        "temporary failure",
        "未生成任何图片",
        "未返回有效",
        "无有效图片",
        "429",
        "rate limit",
        "quota",
        "exhausted",
        "503",
        "每日额度",
        "已达每日",
        "额度上限",
        "configuration_error",
    ]
    return any(marker in error_text for marker in retry_markers)


async def _update_visual_task(
    task_id: str,
    *,
    status: Optional[TaskStatus] = None,
    progress: Optional[int] = None,
    message: Optional[str] = None,
    result: Optional[Any] = None,
    error: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> None:
    await task_manager.update_task(
        task_id,
        status=status,
        progress=progress,
        message=message,
        result=result,
        error=error,
        metadata=metadata,
    )
    _save_runtime_task(task_id)


def _update_visual_task_sync(
    task_id: str,
    *,
    status: Optional[TaskStatus] = None,
    progress: Optional[int] = None,
    message: Optional[str] = None,
    result: Optional[Any] = None,
    error: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None
) -> None:
    task_manager.update_task_sync(
        task_id,
        status=status,
        progress=progress,
        message=message,
        result=result,
        error=error,
        metadata=metadata,
    )
    _save_runtime_task(task_id)


def _is_visual_task_cancelled(task_id: str) -> bool:
    task = task_manager.get_task(task_id) or load_task_snapshot(task_id) or {}
    return task.get("status") == TaskStatus.CANCELLED.value


async def _cancel_visual_task(task_id: str, message: str = "已取消生成") -> Dict[str, Any]:
    task = task_manager.get_task(task_id)
    if not task:
        task = _hydrate_task_from_store(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    await _update_visual_task(
        task_id,
        status=TaskStatus.CANCELLED,
        progress=100,
        message=message,
        error=message,
        metadata=_merge_tuzi_task_metadata(
            task.get("metadata"),
            stage="cancelled",
            retryable=False,
            cancelled_at=datetime.utcnow().isoformat(),
        ),
    )
    return task_manager.get_task(task_id) or load_task_snapshot(task_id) or task


async def _wait_for_visual_task_cancellation(task_id: str, poll_interval_seconds: float = 0.5) -> None:
    while True:
        if _is_visual_task_cancelled(task_id):
            return
        await asyncio.sleep(poll_interval_seconds)


def _hydrate_task_from_store(task_id: str) -> Optional[Dict[str, Any]]:
    snapshot = load_task_snapshot(task_id)
    if snapshot:
        task_manager.set_task_snapshot(snapshot)
    return snapshot


async def _refresh_tuzi_task_if_needed(task_id: str, task: Dict[str, Any]) -> Dict[str, Any]:
    metadata = task.get("metadata") or {}
    if task.get("status") not in {TaskStatus.PENDING.value, TaskStatus.RUNNING.value}:
        return task

    async def _refresh_local_metadata_only() -> Dict[str, Any]:
        refreshed_local_metadata = _merge_tuzi_task_metadata(metadata)
        if refreshed_local_metadata == metadata:
            return task
        await _update_visual_task(task_id, metadata=refreshed_local_metadata)
        return task_manager.get_task(task_id) or task

    provider = metadata.get("provider")
    model = (metadata.get("model") or "").lower()
    external_task_id = metadata.get("external_task_id")
    if provider != "tuzi" or "preview-async" not in model or not external_task_id:
        return await _refresh_local_metadata_only()

    last_polled_at = metadata.get("last_polled_at")
    if last_polled_at:
        try:
            last_polled = datetime.fromisoformat(last_polled_at)
            if (datetime.utcnow() - last_polled).total_seconds() < TUZI_TASK_REFRESH_INTERVAL_SECONDS:
                return await _refresh_local_metadata_only()
        except Exception:
            pass

    from backend.services.image_generator import ImageGenerator

    api_key, base_url, resolved_model = resolve_image_generation_config()
    generator = ImageGenerator(
        api_key=api_key,
        base_url=base_url,
        model=resolved_model,
        provider="tuzi",
    )
    output_dir = str(_get_visual_output_dir())

    try:
        refreshed = await asyncio.to_thread(
            generator.refresh_tuzi_async_task,
            external_task_id,
            output_dir,
            metadata.get("workflow_index", 1) - 1,
            ((task.get("result") or {}).get("paths") or []),
        )
    except Exception as error:
        logger.warning(
            "刷新 Tuzi 任务状态失败: task_id=%s, external_task_id=%s, error=%s",
            task_id,
            external_task_id,
            error,
        )
        await _update_visual_task(
            task_id,
            metadata=_merge_tuzi_task_metadata(
                metadata,
                last_polled_at=datetime.utcnow().isoformat(),
                last_error=str(error),
                retryable=True,
            ),
        )
        return task_manager.get_task(task_id) or task

    refreshed_metadata = _merge_tuzi_task_metadata(
        metadata,
        external_task_id=external_task_id,
        external_status=refreshed.get("external_status"),
        external_progress=refreshed.get("external_progress"),
        last_polled_at=datetime.utcnow().isoformat(),
        last_remote_error_code=refreshed.get("last_remote_error_code"),
        retryable=refreshed.get("status") == "running",
    )

    if refreshed.get("status") == "completed":
        saved_files = refreshed.get("saved_files") or []
        await _update_visual_task(
            task_id,
            status=TaskStatus.COMPLETED,
            progress=100,
            message=refreshed.get("message") or "图片生成完成",
            result={
                "success": True,
                "images": [f"/static/images/{Path(path).name}" for path in saved_files],
                "paths": saved_files,
            },
            metadata=refreshed_metadata,
        )
    elif refreshed.get("status") == "failed":
        await _update_visual_task(
            task_id,
            status=TaskStatus.FAILED,
            progress=100,
            message="图片生成失败",
            error=refreshed.get("message") or "Tuzi 远端任务失败",
            metadata={**refreshed_metadata, "retryable": False},
        )
    else:
        await _update_visual_task(
            task_id,
            status=TaskStatus.RUNNING,
            progress=refreshed.get("progress"),
            message=refreshed.get("message"),
            metadata=refreshed_metadata,
        )

    return task_manager.get_task(task_id) or task


async def _terminate_stale_sync_image_task_if_needed(task_id: str, task: Dict[str, Any]) -> Dict[str, Any]:
    if task.get("status") != TaskStatus.RUNNING.value:
        return task

    metadata = task.get("metadata") or {}
    provider = (metadata.get("provider") or metadata.get("active_provider") or "").lower()
    model = (metadata.get("model") or metadata.get("edit_actual_model") or metadata.get("edit_primary_model") or "").lower()
    stage = (metadata.get("stage") or "").lower()
    is_dynamic_image2 = _is_image2_quality_mode(metadata)
    task_kind = (metadata.get("task_kind") or "").lower()
    edit_purpose = (metadata.get("edit_purpose") or "").lower()

    if provider == "tuzi" and "preview-async" in model:
        return task
    if stage not in {"submitting", "generating", "fallback_generating", "retrying"}:
        return task

    model_started_at = metadata.get("edit_model_started_at") if task_kind == "image_edit" else None
    if task_kind == "image_edit" and stage == "generating" and not model_started_at:
        return task

    runtime_seconds = _compute_runtime_seconds(model_started_at or task.get("started_at"))
    configured_timeout_seconds = metadata.get("sync_timeout_seconds")
    try:
        timeout_seconds = int(configured_timeout_seconds) if configured_timeout_seconds is not None else _resolve_sync_image_task_timeout_seconds(
            provider,
            model,
            mode=edit_purpose or task_kind or metadata.get("prompt_strategy") or metadata.get("visual_mode_resolved"),
        )
    except (TypeError, ValueError):
        timeout_seconds = _resolve_sync_image_task_timeout_seconds(
            provider,
            model,
            mode=edit_purpose or task_kind or metadata.get("prompt_strategy") or metadata.get("visual_mode_resolved"),
        )
    stale_after_seconds = timeout_seconds + (
        IMAGE2_DYNAMIC_SYNC_IMAGE_TASK_STALE_GRACE_SECONDS if is_dynamic_image2 else SYNC_IMAGE_TASK_STALE_GRACE_SECONDS
    )
    if runtime_seconds is None or runtime_seconds <= stale_after_seconds:
        return task

    active_provider = metadata.get("active_provider") or provider or "生图后端"
    logger.warning(
        "检测到悬挂生图任务，自动终止: task_id=%s, provider=%s, model=%s, runtime_seconds=%s",
        task_id,
        provider,
        model,
        runtime_seconds,
    )
    await _update_visual_task(
        task_id,
        status=TaskStatus.FAILED,
        progress=100,
        message="图片生成失败",
        error=f"{active_provider} 图片任务超过 {stale_after_seconds} 秒未回写结果，已自动终止，请重试",
        metadata=_merge_tuzi_task_metadata(
            metadata,
            stage="failed",
            retryable=False,
            stale_runtime_seconds=runtime_seconds,
            stale_terminated=True,
            last_error=f"{active_provider} task stalled without completion callback",
        ),
    )
    return task_manager.get_task(task_id) or task


def _run_text_completion_with_fallback(messages: List[Dict[str, Any]], *, temperature: float, max_tokens: int) -> Any:
    errors: List[str] = []
    config_candidates = _prefer_healthy_model_candidates(
        get_text_generation_config_candidates(),
        kind="text",
    )
    if not config_candidates:
        api_key, base_url = resolve_text_generation_config()
        config_candidates = [{
            "name": "resolved_default",
            "api_key": api_key,
            "base_url": base_url,
        }]

    for config in config_candidates:
        client = OpenAI(
            api_key=config["api_key"],
            base_url=config["base_url"],
            timeout=45.0,
            default_headers={"Accept-Encoding": "identity"},
        )
        for model_name in get_text_generation_model_candidates(config):
            try:
                response = client.chat.completions.create(
                    model=model_name,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens
                )
                _clear_model_candidate_cooldown(
                    {**config, "model": model_name, "provider": "text"},
                    kind="text",
                )
                return response
            except Exception as error:
                errors.append(f"{config['name']}::{model_name}: {error}")
                if is_retryable_text_generation_error(error):
                    _mark_model_candidate_unhealthy(
                        {**config, "model": model_name, "provider": "text"},
                        kind="text",
                        reason=str(classify_model_gateway_error(error).get("kind") or "retryable_error"),
                    )
                    continue
                raise

    raise RuntimeError("文本模型全部回退失败: " + " | ".join(errors))


async def _run_text_completion_with_timeout(messages: List[Dict[str, str]], *, temperature: float, max_tokens: int, timeout_seconds: float) -> Any:
    return await run_text_job(
        _run_text_completion_with_fallback,
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_seconds=timeout_seconds,
    )


async def _run_blocking_with_timeout(func, *args, timeout_seconds: float = TEXT_MODEL_ROUTE_TIMEOUT_SECONDS, **kwargs) -> Any:
    return await run_text_job(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def _run_research_blocking_with_timeout(func, *args, timeout_seconds: float = TEXT_MODEL_ROUTE_TIMEOUT_SECONDS, **kwargs) -> Any:
    return await run_research_text_job(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def _run_strategy_blocking_with_timeout(func, *args, timeout_seconds: float = TEXT_MODEL_ROUTE_TIMEOUT_SECONDS, **kwargs) -> Any:
    return await run_strategy_text_job(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def _run_revision_blocking_with_timeout(func, *args, timeout_seconds: float = TEXT_MODEL_ROUTE_TIMEOUT_SECONDS, **kwargs) -> Any:
    return await run_revision_text_job(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def _run_visual_prompt_generation_with_timeout(*args: Any, **kwargs: Any) -> Any:
    return await run_text_job(
        _generate_visual_prompts_sync,
        *args,
        timeout_seconds=VISUAL_PROMPT_TIMEOUT_SECONDS,
        **kwargs,
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _task_result_payload(response: Any) -> Any:
    if hasattr(response, "model_dump"):
        return response.model_dump()
    if isinstance(response, BaseModel):
        return response.dict()
    return response


def _error_detail(error: Exception) -> str:
    return str(getattr(error, "detail", error))


def _is_retryable_async_text_error(error: Exception) -> bool:
    if isinstance(error, asyncio.TimeoutError):
        return True
    if isinstance(error, HTTPException):
        return error.status_code in {429, 500, 502, 503, 504} or is_retryable_text_generation_error(error.detail)
    return is_retryable_text_generation_error(error)


async def _run_async_text_task_with_retry(
    task_id: str,
    *,
    job_type: str,
    start_message: str,
    retry_message: str,
    success_message: str,
    failure_message: str,
    execute,
) -> None:
    last_error: Optional[Exception] = None
    for attempt in range(1, ASYNC_TEXT_TASK_MAX_ATTEMPTS + 1):
        try:
            await _update_visual_task(
                task_id,
                status=TaskStatus.RUNNING,
                progress=15 if attempt == 1 else 25,
                message=start_message if attempt == 1 else f"{retry_message}（第 {attempt} 次）",
                metadata={
                    "stage": "running",
                    "attempt": attempt,
                    "max_attempts": ASYNC_TEXT_TASK_MAX_ATTEMPTS,
                    "job_type": job_type,
                    "runner": get_text_job_runner_stats(),
                    "started_at": _now_iso(),
                },
            )
            response = await execute()
            await _update_visual_task(
                task_id,
                status=TaskStatus.COMPLETED,
                progress=100,
                message=success_message,
                result=_task_result_payload(response),
                metadata={
                    "stage": "completed",
                    "attempt": attempt,
                    "runner": get_text_job_runner_stats(),
                    "completed_at": _now_iso(),
                },
            )
            return
        except Exception as error:
            last_error = error
            retryable = _is_retryable_async_text_error(error)
            if attempt < ASYNC_TEXT_TASK_MAX_ATTEMPTS and retryable:
                backoff_seconds = ASYNC_TEXT_TASK_RETRY_BACKOFF_SECONDS * attempt
                logger.warning(
                    "异步文本任务可重试失败: task_id=%s job_type=%s attempt=%s backoff=%s error=%s",
                    task_id,
                    job_type,
                    attempt,
                    backoff_seconds,
                    error,
                    exc_info=True,
                )
                await _update_visual_task(
                    task_id,
                    status=TaskStatus.RUNNING,
                    progress=30,
                    message=f"{retry_message}，{backoff_seconds} 秒后重试",
                    error=_error_detail(error),
                    metadata={
                        "stage": "retry_wait",
                        "attempt": attempt,
                        "next_attempt": attempt + 1,
                        "max_attempts": ASYNC_TEXT_TASK_MAX_ATTEMPTS,
                        "retryable": True,
                        "retry_backoff_seconds": backoff_seconds,
                        "last_error": _error_detail(error),
                        "runner": get_text_job_runner_stats(),
                    },
                )
                await asyncio.sleep(backoff_seconds)
                continue
            logger.error("异步文本任务失败: task_id=%s job_type=%s error=%s", task_id, job_type, error, exc_info=True)
            await _update_visual_task(
                task_id,
                status=TaskStatus.FAILED,
                progress=100,
                message=failure_message,
                error=_error_detail(error),
                metadata={
                    "stage": "failed",
                    "attempt": attempt,
                    "max_attempts": ASYNC_TEXT_TASK_MAX_ATTEMPTS,
                    "retryable": retryable,
                    "last_error": _error_detail(error),
                    "runner": get_text_job_runner_stats(),
                    "completed_at": _now_iso(),
                },
            )
            return
    if last_error:
        raise last_error


def _ensure_reference_asset_schema(db: Session) -> None:
    if not settings.allow_runtime_schema_fallback:
        logger.info("[Visual] 生产模式跳过 reference_assets 运行时 schema 兜底")
        return

    if db is None:
        return

    inspector = inspect(db.bind)
    table_names = inspector.get_table_names()
    if "reference_assets" not in table_names:
        db.execute(text("""
            CREATE TABLE reference_assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id VARCHAR(64) NOT NULL UNIQUE,
                user_id VARCHAR(64) NOT NULL,
                file_name VARCHAR(256) NOT NULL,
                original_name VARCHAR(256) NOT NULL,
                relative_path VARCHAR(512) NOT NULL,
                mime_type VARCHAR(128),
                size INTEGER,
                width INTEGER,
                height INTEGER,
                source VARCHAR(64),
                display_name VARCHAR(256),
                note TEXT,
                tags TEXT,
                ai_hint TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_reference_assets_asset_id ON reference_assets (asset_id)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_reference_assets_user_id ON reference_assets (user_id)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS idx_reference_asset_user_created ON reference_assets (user_id, created_at)"))
        db.commit()
        return

    column_names = {column["name"] for column in inspector.get_columns("reference_assets")}
    if "width" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN width INTEGER"))
    if "height" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN height INTEGER"))
    if "source" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN source VARCHAR(64)"))
    if "display_name" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN display_name VARCHAR(256)"))
    if "note" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN note TEXT"))
    if "tags" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN tags TEXT"))
    if "ai_hint" not in column_names:
        db.execute(text("ALTER TABLE reference_assets ADD COLUMN ai_hint TEXT"))
    db.commit()


def _reference_asset_to_response(asset: Any) -> Dict[str, Any]:
    payload = asset.to_dict()
    payload["url"] = f"/static/uploads/{payload['relative_path']}"
    payload.pop("relative_path", None)
    return payload


def _reference_asset_to_internal_payload(asset: Any) -> Dict[str, Any]:
    payload = asset.to_dict()
    payload["url"] = f"/static/uploads/{payload['relative_path']}"
    return payload


def _normalize_asset_tags(raw_tags: Any) -> List[str]:
    if isinstance(raw_tags, str):
        items = [item.strip() for item in re.split(r"[,，\n#]+", raw_tags) if item.strip()]
    elif isinstance(raw_tags, list):
        items = [str(item).strip() for item in raw_tags if str(item).strip()]
    else:
        items = []
    deduped: List[str] = []
    for item in items:
        if item not in deduped:
            deduped.append(item[:32])
    return deduped[:12]


def _build_reference_asset_instruction(asset: Any, index: int) -> str:
    tags = []
    if getattr(asset, "tags", None):
        try:
            parsed = json.loads(asset.tags)
            tags = parsed if isinstance(parsed, list) else []
        except Exception:
            tags = []
    parts = [
        f"Reference image {index}:",
        f"name={getattr(asset, 'display_name', None) or getattr(asset, 'original_name', '')}",
    ]
    if tags:
        parts.append(f"tags={', '.join(str(tag) for tag in tags[:8])}")
    if getattr(asset, "note", None):
        parts.append(f"note={asset.note}")
    if getattr(asset, "ai_hint", None):
        parts.append(f"ai_hint={asset.ai_hint}")
    return " ".join(parts)


def _resolve_primary_reference_asset(
    reference_assets: Optional[List[Dict[str, Any]]],
    primary_reference_asset_id: Optional[str],
) -> tuple[Optional[Dict[str, Any]], List[str]]:
    assets = [asset for asset in (reference_assets or []) if isinstance(asset, dict)]
    asset_ids = [
        str(asset.get("id")).strip()
        for asset in assets
        if str(asset.get("id") or "").strip()
    ]
    if not assets:
        return None, []

    if primary_reference_asset_id:
        matched = next((asset for asset in assets if str(asset.get("id") or "").strip() == primary_reference_asset_id), None)
        if matched:
            return matched, asset_ids

    return assets[0], asset_ids


def _load_reference_asset_record(asset_id: str, user_id: Optional[str] = None) -> Optional[Any]:
    if not asset_id:
        return None
    if db_session.SessionLocal is None:
        db_session.init_database()
    if db_session.SessionLocal is None:
        return None

    from backend.database.models import ReferenceAsset

    db = db_session.SessionLocal()
    try:
        query = db.query(ReferenceAsset).filter(ReferenceAsset.asset_id == asset_id)
        if user_id:
            query = query.filter(ReferenceAsset.user_id == user_id)
        return query.first()
    finally:
        db.close()


def resolve_image_generation_config() -> tuple[str, str, str]:
    model = getattr(settings, "CONCEPT_IMAGE_MODEL", settings.IMAGE_GEN_MODEL)
    base_url = settings.IMAGE_GEN_BASE_URL or settings.ANTHROPIC_BASE_URL
    normalized_base_url = (base_url or "").lower()

    if "tu-zi.com" in normalized_base_url:
        api_key = settings.TUZI_API_KEY or settings.IMAGE_GEN_API_KEY or settings.ANTHROPIC_API_KEY or settings.OPENROUTER_API_KEY
    # gemini 系模型在当前网关上需要使用具备 Gemini 访问能力的 key
    elif model.startswith("gemini"):
        api_key = settings.ANTHROPIC_API_KEY or settings.IMAGE_GEN_API_KEY or settings.OPENROUTER_API_KEY or settings.TUZI_API_KEY
    else:
        api_key = settings.IMAGE_GEN_API_KEY or settings.OPENROUTER_API_KEY or settings.ANTHROPIC_API_KEY or settings.TUZI_API_KEY

    if not api_key:
        raise ValueError("未配置生图服务 API Key (优先 TUZI_API_KEY / IMAGE_GEN_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY)")

    _log_image_runtime_diagnostics(
        "resolve_image_generation_config",
        api_key=api_key,
        base_url=base_url,
        model=model,
        provider=_resolve_image_provider(base_url),
        mode="concept/default",
        config_slot="CONCEPT_IMAGE_MODEL",
    )

    return api_key, base_url, model


def resolve_image_edit_config() -> tuple[str, str, str, str, str, str]:
    primary_model = getattr(settings, "IMAGE_EDIT_MODEL", "") or "gpt-image-2"
    primary_base_url = getattr(settings, "IMAGE_EDIT_BASE_URL", "") or settings.IMAGE_GEN_BASE_URL or settings.ANTHROPIC_BASE_URL
    primary_api_key = (
        getattr(settings, "IMAGE_EDIT_API_KEY", "")
        or settings.IMAGE_GEN_API_KEY
        or settings.OPENROUTER_API_KEY
        or settings.ANTHROPIC_API_KEY
    )
    backup_api_key = (
        getattr(settings, "IMAGE_GEN_BACKUP_API_KEY", "")
        or getattr(settings, "ANTHROPIC_BACKUP_API_KEY", "")
    )
    backup_base_url = getattr(settings, "IMAGE_GEN_BACKUP_BASE_URL", "") or primary_base_url
    fallback_base_url = (
        getattr(settings, "IMAGE_GEN_FALLBACK_BASE_URL", "")
        or getattr(settings, "IMAGE_GEN_BACKUP_BASE_URL", "")
        or settings.IMAGE_GEN_BASE_URL
        or settings.ANTHROPIC_BASE_URL
    )
    fallback_api_key = getattr(settings, "IMAGE_GEN_FALLBACK_API_KEY", "") or backup_api_key
    fallback_model = (
        getattr(settings, "IMAGE_EDIT_FALLBACK_MODEL", "")
        or getattr(settings, "IMAGE2_GEN_MODEL", "")
        or primary_model
    )

    if not primary_api_key:
        raise ValueError("未配置图片编辑服务 API Key")

    candidates = build_image_candidate_chain(
        primary_model=primary_model,
        primary_base_url=primary_base_url,
        primary_api_key=primary_api_key,
        backup_same_model_api_key=backup_api_key,
        backup_same_model_base_url=backup_base_url,
        fallback_models=[fallback_model] if fallback_model else [],
        fallback_api_key=fallback_api_key,
        fallback_base_url=fallback_base_url,
    )
    fallback_candidate = candidates[1] if len(candidates) > 1 else candidates[0]

    return (
        primary_api_key,
        primary_base_url,
        primary_model,
        fallback_candidate["api_key"],
        fallback_candidate["base_url"],
        fallback_candidate["model"],
    )


def _extract_list_from_data(data: Any) -> List[Dict[str, Any]]:
    if isinstance(data, list):
        return data
    elif isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, list):
                return value
        return []
    return []


def clean_and_parse_json(text: str) -> List[Dict[str, Any]]:
    try:
        data = clean_and_parse_ai_json(text)
        return extract_json_list(data)
    except Exception as e:
        logger.error(f"[clean_and_parse_json] JSON 解析错误: {e}")
        logger.error(f"[clean_and_parse_json] 原始文本 (前 1000 字符): {text[:1000]}")
        raise ValueError(f"无法解析 JSON: {str(e)}")


def _flatten_prompt_items(value: Any) -> List[Any]:
    if isinstance(value, list):
        flattened: List[Any] = []
        for item in value:
            flattened.extend(_flatten_prompt_items(item))
        return flattened
    if isinstance(value, dict):
        return [value]
    return []


def _derive_prompt_title(item: Dict[str, Any], index: int) -> str:
    for key in ("title", "name", "theme", "label"):
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return f"方案 {index}"


def _derive_prompt_type(item: Dict[str, Any], index: int) -> str:
    value = item.get("type")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return "Cover" if index == 1 else "Content"


def _normalize_visual_prompts(raw_data: Any) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    candidates: List[Any] = []
    if isinstance(raw_data, dict):
        for key in ("prompts", "plans", "items", "data", "result"):
            wrapped = raw_data.get(key)
            if isinstance(wrapped, (list, dict)):
                candidates.extend(_flatten_prompt_items(wrapped))
        if not candidates:
            candidates.extend(_flatten_prompt_items(raw_data))
    else:
        candidates.extend(_flatten_prompt_items(raw_data))

    normalized: List[Dict[str, Any]] = []
    dropped = 0
    for index, item in enumerate(candidates, start=1):
        if not isinstance(item, dict):
            dropped += 1
            continue

        prompt_value = item.get("prompt") or item.get("text") or item.get("content")
        if not isinstance(prompt_value, str) or not prompt_value.strip():
            dropped += 1
            continue

        normalized.append({
            "id": item.get("id") if isinstance(item.get("id"), (int, str)) else index,
            "type": _derive_prompt_type(item, index),
            "title": _derive_prompt_title(item, index),
            "prompt": prompt_value.strip(),
            "style": item.get("style") if isinstance(item.get("style"), str) else None,
            "rationale": item.get("rationale") if isinstance(item.get("rationale"), str) else None,
            "role": item.get("role") if isinstance(item.get("role"), str) else None,
            "key_message": item.get("key_message") if isinstance(item.get("key_message"), str) else None,
            "variant_key": item.get("variant_key") if isinstance(item.get("variant_key"), str) else None,
            "layout_family": item.get("layout_family") if isinstance(item.get("layout_family"), str) else None,
            "visual_focus": item.get("visual_focus") if isinstance(item.get("visual_focus"), str) else None,
        })

    stats = {
        "raw_prompt_count": len(candidates),
        "normalized_prompt_count": len(normalized),
        "dropped_prompt_items": dropped,
    }
    return _apply_prompt_variants(normalized), stats


def _extract_dynamic_design_plan(raw_data: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw_data, dict):
        return None

    design_plan = raw_data.get("design_plan")
    if not isinstance(design_plan, dict):
        return None

    normalized = dict(design_plan)
    try:
        image_count = int(normalized.get("image_count") or 0)
    except (TypeError, ValueError):
        image_count = 0

    if image_count > 0:
        normalized["image_count"] = max(1, min(image_count, 6))

    return normalized


def _variant_spec_for_index(index: int) -> Dict[str, str]:
    spec = PROMPT_VARIANT_SPECS[min(index - 1, len(PROMPT_VARIANT_SPECS) - 1)]
    return spec


def _build_prompt_variant_instructions(target_count: int) -> str:
    lines = []
    for index in range(1, max(target_count, 1) + 1):
        spec = _variant_spec_for_index(index)
        lines.append(
            f'   - Prompt {index}: variant_key="{spec["variant_key"]}", '
            f'type="{spec["type"]}", layout_family="{spec["layout_family"]}", '
            f'visual_focus="{spec["visual_focus"]}"'
        )
    return "\n".join(lines)


def _apply_prompt_variants(prompts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    enriched: List[Dict[str, Any]] = []
    for index, item in enumerate(prompts, start=1):
        spec = _variant_spec_for_index(index)
        enriched.append({
            **item,
            "type": item.get("type") or spec["type"],
            "title": item.get("title") or spec["title"],
            "variant_key": item.get("variant_key") or spec["variant_key"],
            "layout_family": item.get("layout_family") or spec["layout_family"],
            "visual_focus": item.get("visual_focus") or spec["visual_focus"],
        })
    return enriched


def _prompt_model_candidates(primary_model: str, text_fallback_model: str) -> List[str]:
    candidates = [primary_model]
    deduped: List[str] = []
    for candidate in candidates:
        if candidate and candidate not in deduped:
            deduped.append(candidate)
    return deduped


def _clip_text(value: Optional[str], limit: int) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n...[内容已截断]"


def _normalize_visual_mode(mode: Optional[str]) -> str:
    return resolve_visual_mode(mode)


VISUAL_MODE_ALIASES: Dict[str, set[str]] = {
    "concept": {"概念表达", "concept", "concept_cloud"},
    "material_fusion": {"物料融合", "素材融合", "material_fusion"},
    "template_compose": {"模板拼装", "template_compose"},
    "image2_dynamic": {"轻量直出", "动态表达", "image2_dynamic"},
    "style_expression": {"风格表达", "多风格表达", "style_expression"},
}


def list_supported_visual_mode_inputs() -> List[str]:
    ordered: List[str] = []
    for aliases in VISUAL_MODE_ALIASES.values():
        for alias in sorted(aliases):
            if alias not in ordered:
                ordered.append(alias)
    return ordered


def resolve_visual_mode(
    mode: Optional[str],
    *,
    default: str = "concept",
    strict: bool = False,
) -> str:
    value = (mode or "").strip()
    if not value:
        return default

    for canonical_mode, aliases in VISUAL_MODE_ALIASES.items():
        if value in aliases:
            return canonical_mode

    if strict:
        supported = " / ".join(list_supported_visual_mode_inputs())
        raise ValueError(f"不支持的 image_mode: {value}，当前支持：{supported}")

    return default



def _build_concept_visual_messages(
    *,
    title: str,
    content: str,
    style: str,
    target_count: int = 3,
    product_brief: Optional[Dict[str, Any]] = None,
) -> tuple[str, str]:
    from backend.services.visual_director import _build_system_prompt

    system_prompt = _build_system_prompt(style)
    note_content = f"标题：{(title or '').strip() or '未提供标题'}\n\n正文：\n{_clip_text(content, VISUAL_PROMPT_MAX_CONTENT_CHARS) or '无正文'}"
    
    product_context = ""
    if product_brief:
        from backend.services.image2_prompt_engine import analyze_product_brief
        product_analysis = analyze_product_brief(product_brief)
        product_context = f"""
# PRODUCT CONTEXT:
- Name: {product_analysis["product_name"]}
- Target Audience: {product_analysis["target_audience"]}
- Core Features: {product_analysis["product_features"]}
- System Market Type Hint: {product_analysis["market_type"]}
- Evidence: {product_analysis["evidence"]}
CRITICAL: Please combine the system market type hint with the note content and infer if this is a B2B product (like Enterprise SCRM, SaaS) or B2C. If B2B, ensure the poster style reflects professionalism, technology, and trust (e.g. corporate blue/green, data visualization), avoiding overly childish or casual aesthetics!
"""

    style_instruction = f"Use the specified style: {style}" if style else "Analyze the content and choose the most suitable style from the available options."
    user_message = f"""# USER NOTE CONTENT:
{note_content}
{product_context}
---
# IMPORTANT INSTRUCTIONS
1. Output MUST be valid JSON only, wrapped in this exact object shape:
{{
  "prompts": [
    {{
      "id": 1,
      "type": "Cover",
      "title": "方案标题",
      "rationale": "一句话原因",
      "prompt": "工程化英文结构 prompt"
    }},
    {{
      "id": 2,
      "type": "Content",
      "title": "方案标题",
      "rationale": "一句话原因",
      "prompt": "工程化英文结构 prompt"
    }}
  ]
}}
2. Return EXACTLY {target_count} prompts and map them to these fixed variants:
{_build_prompt_variant_instructions(target_count)}
3. The "prompt" field MUST follow this format exactly with LINE BREAKS between sections:
   > A professional [Style] marketing poster...
   [Background]: ...
   [Top Section]: ...
   [Center Layout]: ...
   [Bottom Section]: ...
   [Style & Quality]: ... --ar 3:4
4. Each section MUST start on a NEW LINE.
5. Each prompt MUST stay concise and production-ready. Keep each prompt under 1200 characters.
6. You MUST extract Chinese keywords from the note and include them in the prompt, wrapped in double quotes.
7. The poster's visible copy MUST be Chinese-first, not English-first.
8. You MUST explicitly include a dedicated line named [Chinese Copy Plan]: and provide all visible poster copy in Chinese quotes, including:
   - Main title text: "..."
   - Subtitle text: "..."
   - CTA text: "..."
   - Bullet text 1: "..."
   - Bullet text 2: "..."
   - Bullet text 3: "..."
9. The Chinese copy must be concise, poster-ready, and directly derived from the note's Chinese value points.
10. Never replace visible title/CTA/bullet copy with English slogans or generic English labels.
11. {style_instruction}
12. Main title MUST have specific visual effects, not generic title placeholders.
13. CTA MUST be poster-style and visually integrated, not web UI buttons.
14. Never include QR codes, barcodes, phone numbers, emails, URLs, or realistic product photography.
15. Keep the prompt engineering-grade, English-led in structure, but Chinese-first in ALL visible poster copy.
16. If you mention any visible text in the layout, that text must be Chinese unless it is a tiny brand accent.
17. The three prompts MUST look materially different in composition, not just color or wording changes.
18. For each prompt object, include extra fields: "variant_key", "layout_family", "visual_focus".
""".strip()
    return system_prompt, user_message


def _format_reference_asset_context_from_payload(
    asset: Dict[str, Any],
    index: int,
    *,
    is_primary: bool = False,
) -> str:
    label = "PRIMARY MATERIAL" if is_primary else f"SUPPORTING MATERIAL {index}"
    name = asset.get("display_name") or asset.get("original_name") or asset.get("name") or asset.get("id") or "unnamed"
    tags = asset.get("tags") if isinstance(asset.get("tags"), list) else []
    note = asset.get("ai_hint") or asset.get("note") or asset.get("description") or ""
    parts = [f"- {label}: {name}"]
    if tags:
        parts.append(f"  tags: {', '.join(str(tag) for tag in tags[:8])}")
    if note:
        parts.append(f"  hint: {str(note)[:300]}")
    return "\n".join(parts)


def _material_asset_name(asset: Optional[Dict[str, Any]], fallback: str = "unnamed material") -> str:
    if not asset:
        return fallback
    return str(
        asset.get("display_name")
        or asset.get("original_name")
        or asset.get("name")
        or asset.get("id")
        or fallback
    ).strip()


def _material_asset_tags_text(asset: Optional[Dict[str, Any]], limit: int = 6) -> str:
    if not asset:
        return ""
    tags = asset.get("tags") if isinstance(asset.get("tags"), list) else []
    return ", ".join(str(tag) for tag in tags[:limit] if str(tag).strip())


MATERIAL_FUSION_STRICT_SCORE_THRESHOLD = 16
MATERIAL_FUSION_KEYWORD_GROUPS: List[tuple[str, List[str]]] = [
    ("渠道活码", ["渠道活码", "活码", "渠道码", "二维码活码", "员工活码", "客户活码"]),
    ("客户管理", ["客户管理", "客户列表", "客户画像", "客户资料", "用户管理"]),
    ("销售订单", ["销售订单", "订单管理", "订单", "订单后台", "订单页面", "销售单", "成交订单"]),
    ("数据看板", ["数据看板", "经营看板", "销售看板", "分析看板", "统计报表", "数据报表", "分析报表"]),
    ("一键导入", ["一键导入", "内容导入", "素材导入", "导入素材", "导入内容", "导入页", "导入功能", "文章导入", "公众号导入", "飞书导入", "notion导入", "本地上传", "复制粘贴"]),
    ("AI写作", ["ai写作", "ai辅助写作", "ai辅助", "ai整理表达", "ai整理", "写作工具栏", "智能写作", "标题开头", "提重点", "文案整理", "理顺标题", "补开头"]),
    ("智能排版", ["智能排版", "ai排版", "自动排版", "一键排版", "排版成稿", "智能成稿", "正文结构", "结构识别"]),
    ("自动分页", ["自动分页", "模板分页", "分页成稿", "分页排版", "分页页", "分页功能", "卡片分页", "分页", "分镜", "多页"]),
    ("水印", ["水印", "添加水印", "品牌水印", "卡片水印", "素材保护"]),
    ("违规检测", ["违规检测", "风险检测", "风险检查", "发前检查", "发布检查", "发布前检测", "发布前检查", "检测页", "检查页", "敏感词", "敏感词检测", "小红书检测"]),
    ("模板", ["模板", "模板库", "套模板", "版式模板", "风格模板", "模板套用", "套用模板"]),
    ("AI总结", ["ai总结", "网页总结", "视频总结", "pdf总结", "图片总结", "总结"]),
    ("生词本", ["生词本", "生词", "高亮注释", "单词本", "词汇"]),
    ("双语对照", ["双语对照", "双语", "翻译对照", "中英对照"]),
    ("大模型", ["大模型", "模型选择", "ai模型"]),
    ("SOP", ["sop", "标准作业", "自动化sop", "跟进sop", "sop流程"]),
    ("群发", ["群发", "群发助手", "消息群发", "批量触达", "触达"]),
    ("任务宝", ["任务宝", "裂变", "拉新", "邀请", "助力"]),
    ("企业微信", ["企业微信", "企微", "私域运营", "私域客户"]),
    ("销售管理", ["销售管理", "线索管理", "商机管理", "客户跟进", "销售跟进", "转化分析"]),
    ("产品首页", ["产品首页", "产品页", "官网首页", "落地页", "主页", "home"]),
]


def _material_asset_text(asset: Optional[Dict[str, Any]]) -> str:
    if not asset:
        return ""
    tags = asset.get("tags") if isinstance(asset.get("tags"), list) else []
    return " ".join([
        str(asset.get("display_name") or ""),
        str(asset.get("original_name") or ""),
        str(asset.get("source") or ""),
        " ".join(str(tag) for tag in tags),
        str(asset.get("note") or ""),
        str(asset.get("ai_hint") or ""),
    ]).lower()


def _extract_material_keywords(text: str) -> List[str]:
    lowered = (text or "").lower()
    matched: List[str] = []
    for canonical, aliases in MATERIAL_FUSION_KEYWORD_GROUPS:
        if any(alias.lower() in lowered for alias in aliases):
            matched.append(canonical)
    normalized = list(dict.fromkeys(matched))
    if "自动分页" in normalized and "模板" in normalized:
        normalized = [item for item in normalized if item != "模板"]
    return normalized


def _material_fusion_item_need_text(plan_item: Dict[str, Any]) -> str:
    return " ".join([
        str(plan_item.get("title") or ""),
        str(plan_item.get("summary") or ""),
        str(plan_item.get("visualFocus") or plan_item.get("visual_focus") or ""),
        str(plan_item.get("contentSummary") or plan_item.get("content_summary") or ""),
        str(plan_item.get("role") or ""),
        str(plan_item.get("requiredHint") or plan_item.get("required_hint") or ""),
    ]).lower()


def _material_fusion_is_feature_driven(need_text: str, required_keywords: List[str]) -> bool:
    if required_keywords:
        return True
    return bool(re.search(
        r"功能|步骤|教程|流程|后台|页面|界面|截图|演示|操作|设置|列表|详情|看板|数据|客户|活码|导入|写作|排版|分页|模板|违规|检测|检查|敏感词|水印|群发|任务宝|sop|product|feature|dashboard|screen|screenshot",
        need_text or "",
        re.IGNORECASE,
    ))


def _validate_material_fusion_primary_match(
    plan_item: Dict[str, Any],
    source_asset: Optional[Dict[str, Any]],
) -> tuple[bool, str]:
    if not source_asset:
        return False, "缺少主素材"
    if _asset_payload_is_logo(source_asset):
        return False, "Logo 不能作为功能卡主物料"
    if _asset_payload_is_competitor_reference(source_asset):
        return False, "竞品参考不能作为功能卡主物料"
    if _asset_payload_is_brand_style_only(source_asset):
        return False, "品牌风格图不能作为功能卡主物料"
    need_text = _material_fusion_item_need_text(plan_item)
    required_keywords = [
        str(item).strip()
        for item in (plan_item.get("requiredKeywords") or plan_item.get("required_keywords") or [])
        if str(item).strip()
    ]
    selection_source = str(plan_item.get("selectionSource") or plan_item.get("selection_source") or "").strip().lower()
    if selection_source == "manual":
        asset_keywords = _extract_material_keywords(_material_asset_text(source_asset))
        missing_keywords = [keyword for keyword in required_keywords if keyword not in asset_keywords]
        if missing_keywords:
            logger.warning(
                "[WORKFLOW] 物料融合手动主素材关键词弱匹配但继续生成: item=%s, source_asset=%s, missing_keywords=%s, asset_keywords=%s",
                plan_item.get("id") or plan_item.get("index"),
                source_asset.get("id"),
                missing_keywords,
                asset_keywords,
            )
        return True, "手动选择主素材，已按用户选择继续"
    if not required_keywords:
        required_keywords = _extract_material_keywords(need_text)
    asset_keywords = _extract_material_keywords(_material_asset_text(source_asset))
    if required_keywords:
        overlap = [keyword for keyword in required_keywords if keyword in asset_keywords]
        if not overlap:
            return False, f"主素材只匹配到 {('、'.join(overlap) if overlap else '无')}，不足以对应 {'、'.join(required_keywords)}"
    elif _material_fusion_is_feature_driven(need_text, required_keywords):
        return False, "这张卡片需要具体功能图，但缺少可校验的功能关键词"
    raw_score = plan_item.get("matchScore") if plan_item.get("matchScore") is not None else plan_item.get("match_score")
    try:
        match_score = int(raw_score) if raw_score is not None else MATERIAL_FUSION_STRICT_SCORE_THRESHOLD
    except (TypeError, ValueError):
        match_score = 0
    if match_score < MATERIAL_FUSION_STRICT_SCORE_THRESHOLD:
        return False, f"主素材匹配分 {match_score} 低于阈值 {MATERIAL_FUSION_STRICT_SCORE_THRESHOLD}"
    return True, "主素材与卡片文案匹配"


def _asset_payload_is_logo(asset: Dict[str, Any]) -> bool:
    text = " ".join([
        str(asset.get("display_name") or ""),
        str(asset.get("original_name") or ""),
        str(asset.get("note") or ""),
        str(asset.get("ai_hint") or ""),
        " ".join(str(tag) for tag in (asset.get("tags") or [])),
    ]).lower()
    looks_like_logo = any(token in text for token in [
        "logo",
        "纯logo",
        "品牌logo",
        "品牌标识",
        "商标",
        "brandmark",
        "logotype",
    ])
    looks_like_page = any(token in text for token in [
        "后台",
        "页面",
        "界面",
        "截图",
        "看板",
        "客户",
        "订单",
        "活码",
        "导入",
        "写作",
        "排版",
        "分页",
        "模板",
        "违规",
        "检测",
        "检查",
        "敏感词",
        "水印",
        "sop",
        "dashboard",
        "screenshot",
    ])
    return looks_like_logo and not looks_like_page


def _asset_payload_is_competitor_reference(asset: Dict[str, Any]) -> bool:
    text = " ".join([
        str(asset.get("display_name") or ""),
        str(asset.get("original_name") or ""),
        str(asset.get("note") or ""),
        str(asset.get("ai_hint") or ""),
        " ".join(str(tag) for tag in (asset.get("tags") or [])),
    ]).lower()
    explicit_non_competitor = any(token in text for token in [
        "不是竞品",
        "非竞品",
        "不要识别为竞品",
        "不是对标",
        "非对标",
        "not competitor",
    ])
    if explicit_non_competitor:
        return False
    return any(token in text for token in [
        "竞品",
        "对标",
        "竞对",
        "别人家的",
        "其他品牌",
        "其他产品",
        "benchmark",
        "competitor",
        "仅参考结构",
        "只参考结构",
        "不要直接使用",
        "不可直接使用",
    ])


def _asset_payload_is_brand_style_only(asset: Dict[str, Any]) -> bool:
    text = " ".join([
        str(asset.get("display_name") or ""),
        str(asset.get("original_name") or ""),
        str(asset.get("note") or ""),
        str(asset.get("ai_hint") or ""),
        " ".join(str(tag) for tag in (asset.get("tags") or [])),
    ]).lower()
    looks_like_brand_style = any(token in text for token in [
        "品牌风格",
        "品牌视觉",
        "配色",
        "色彩",
        "官网风格",
        "落地页风格",
        "视觉参考",
        "brand style",
        "style reference",
    ])
    looks_like_function_page = any(token in text for token in [
        "功能",
        "后台",
        "页面",
        "界面",
        "截图",
        "看板",
        "客户",
        "订单",
        "活码",
        "导入",
        "写作",
        "排版",
        "分页",
        "模板",
        "违规",
        "检测",
        "检查",
        "敏感词",
        "水印",
        "群发",
        "任务宝",
        "sop",
        "dashboard",
        "screenshot",
    ])
    return looks_like_brand_style and not looks_like_function_page


def _asset_payload_is_function_material(asset: Dict[str, Any]) -> bool:
    text = " ".join([
        str(asset.get("display_name") or ""),
        str(asset.get("original_name") or ""),
        str(asset.get("note") or ""),
        str(asset.get("ai_hint") or ""),
        " ".join(str(tag) for tag in (asset.get("tags") or [])),
    ]).lower()
    if _asset_payload_is_logo(asset):
        return False
    return any(token in text for token in [
        "功能",
        "后台",
        "页面",
        "界面",
        "截图",
        "看板",
        "客户",
        "订单",
        "活码",
        "导入",
        "写作",
        "排版",
        "分页",
        "模板",
        "违规",
        "检测",
        "检查",
        "敏感词",
        "水印",
        "群发",
        "任务宝",
        "sop",
        "dashboard",
        "screenshot",
    ])


def _build_material_fusion_visual_messages(
    *,
    title: str,
    content: str,
    material_summary: Optional[str],
    reference_summary: Optional[str],
    reference_assets: Optional[List[Dict[str, Any]]],
    primary_reference_asset_id: Optional[str],
    product_brief: Optional[Dict[str, Any]] = None,
) -> tuple[str, str]:
    primary_asset, asset_ids = _resolve_primary_reference_asset(reference_assets, primary_reference_asset_id)
    primary_id = str((primary_asset or {}).get("id") or "").strip()
    material_context_lines: List[str] = []
    for index, asset in enumerate(reference_assets or [], start=1):
        if not isinstance(asset, dict):
            continue
        asset_id = str(asset.get("id") or "").strip()
        material_context_lines.append(
            _format_reference_asset_context_from_payload(
                asset,
                index,
                is_primary=bool(asset_id and primary_id and asset_id == primary_id),
            )
        )

    product_context = ""
    if product_brief:
        from backend.services.image2_prompt_engine import analyze_product_brief
        product_analysis = analyze_product_brief(product_brief)
        product_context = f"""
# PRODUCT CONTEXT
- Name: {product_analysis["product_name"]}
- Target Audience: {product_analysis["target_audience"]}
- Core Features: {product_analysis["product_features"]}
- Market Type Hint: {product_analysis["market_type"]}
""".strip()

    system_prompt = """You are a senior image-edit prompt director for Chinese social commerce posters.
Return JSON only. Create exactly one production-ready image editing prompt.
The model will receive the primary material image as the source image. Your prompt must preserve the primary material's identity and important details while transforming it into a polished Xiaohongshu poster.
Never ask to invent a different product, logo, screenshot, or UI when a primary material is provided.""".strip()

    user_message = f"""# NOTE
Title: {(title or '').strip() or '未提供标题'}
Content:
{_clip_text(content, VISUAL_PROMPT_MAX_CONTENT_CHARS) or '无正文'}

{product_context}

# USER MATERIAL INTENT
{(material_summary or '').strip() or '无额外意图'}

# REFERENCE SUMMARY
{(reference_summary or '').strip() or '无'}

# MATERIALS
{chr(10).join(material_context_lines) if material_context_lines else 'No materials provided.'}

# OUTPUT FORMAT
Return valid JSON only:
{{
  "prompts": [
    {{
      "id": 1,
      "type": "MaterialFusion",
      "title": "主物料融合海报",
      "rationale": "一句话说明为什么这样融合",
      "prompt": "English image-edit prompt with Chinese visible copy plan",
      "variant_key": "material_fusion_primary_edit",
      "layout_family": "source_preserving_poster_edit",
      "visual_focus": "保留主素材主体 + 融入产品卖点"
    }}
  ]
}}

# PROMPT REQUIREMENTS
1. The prompt MUST be for image editing, not pure text-to-image generation.
2. Preserve the primary material's real identity, logo, UI structure, product shape, colors, and readable key details unless the user intent explicitly says otherwise.
3. Use supporting materials only as brand, UI, color, layout, or detail references. Do not let them replace the primary material.
4. Convert the note into a polished 3:4 Xiaohongshu poster with Chinese-first visible copy.
5. Include a [Chinese Copy Plan] section with concise Chinese title, subtitle, CTA, and 2-3 bullet points.
6. Keep the prompt under 1200 characters and end with --ar 3:4.
7. Avoid adding extra contact details, unrelated marks, or invented interface elements.
8. Use the material tags/notes as semantic labels so the image model understands what each material represents.

Primary material id: {primary_id or 'missing'}
All material ids: {', '.join(asset_ids) if asset_ids else 'none'}
""".strip()
    return system_prompt, user_message


def _compose_material_fusion_prompt_for_plan_item(
    base_prompt: str,
    plan_item: Dict[str, Any],
    *,
    index: int,
    total: int,
    source_asset: Optional[Dict[str, Any]] = None,
    uploaded_logo_assets: Optional[List[Dict[str, Any]]] = None,
    note_content: str = "",
) -> str:
    title = str(plan_item.get("title") or f"第 {index} 张").strip()
    summary = str(plan_item.get("summary") or "").strip()
    visual_focus = str(plan_item.get("visualFocus") or plan_item.get("visual_focus") or "").strip()
    content_summary = str(plan_item.get("contentSummary") or plan_item.get("content_summary") or "").strip()
    required_hint = str(plan_item.get("requiredHint") or plan_item.get("required_hint") or "").strip()
    role = str(plan_item.get("role") or "").strip()
    source_name = _material_asset_name(source_asset, "selected material")
    source_tags = _material_asset_tags_text(source_asset, limit=10)
    source_hint = str((source_asset or {}).get("ai_hint") or (source_asset or {}).get("note") or "").strip()
    source_lines = [
        f"- Image 1 is the selected main material: {source_name}.",
        "- Its real UI/page/content meaning is the anchor for this card. The poster copy must match this material.",
    ]
    if source_tags:
        source_lines.append(f"- Image 1 material tags: {source_tags}.")
    if source_hint:
        source_lines.append(f"- Image 1 material hint: {source_hint[:260]}.")
    if visual_focus:
        source_lines.append(f"- Card visual focus: {visual_focus}.")
    if content_summary and content_summary != summary:
        source_lines.append(f"- Card content summary: {content_summary}.")
    if summary:
        source_lines.append(f"- Card summary: {summary}.")
    if required_hint:
        source_lines.append(f"- Material requirement: {required_hint}.")
    if role:
        source_lines.append(f"- Card role: {role}.")
    logo_lines = []
    for logo_index, logo_asset in enumerate(uploaded_logo_assets or [], start=2):
        logo_lines.append(
            f"- Image {logo_index}: brand logo reference. Place it accurately and do not invent a different logo."
        )
    return (
        "Create one clean 3:4 Xiaohongshu business poster by editing Image 1.\n"
        f"{chr(10).join(source_lines)}\n"
        "- Preserve Image 1's original page type, layout, menu structure, and UI content.\n"
        f"{chr(10).join(logo_lines) + chr(10) if logo_lines else ''}"
        f"- Card {index}/{total}: {title}. Use this as the Chinese headline direction.\n"
        "- The visible Chinese copy must describe Image 1's real content and the card visual focus. "
        "- If the selected screenshot does not show a requested feature, reframe the copy around what Image 1 actually shows instead of inventing a different UI. "
        "Use a light enterprise-tech layout, concise Chinese headline, short selling points, and one CTA. "
        "Do not claim features that are not represented by Image 1. Do not create a hybrid UI. "
        "Do not add QR codes, barcodes, phone numbers, URLs, emails, unrelated watermarks, or invented product UI. --ar 3:4"
    )


def _resolve_material_fusion_plan_items(
    plan: Optional[List[Dict[str, Any]]],
    prompts: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    items = [item for item in (plan or []) if isinstance(item, dict) and item.get("primaryAssetId")]
    if items:
        return items[:MATERIAL_FUSION_MAX_IMAGE_COUNT]
    return [
        {
            "id": "single-primary",
            "index": 1,
            "title": prompts[0].get("title") if prompts else "主物料融合海报",
            "summary": prompts[0].get("rationale") if prompts else "",
            "primaryAssetId": "",
            "globalAssetIds": [],
        }
    ]


def _image_provider_display_name(provider: str, model: Optional[str]) -> str:
    lowered_model = (model or "").lower()
    if provider == "tuzi":
        return "Tuzi"
    if provider == "minimax":
        return "MiniMax"
    if "gemini" in lowered_model:
        return "Gemini"
    if provider == "openrouter":
        return "OpenRouter"
    return provider or "image-provider"


def _is_known_unavailable_image_model(model_name: Optional[str]) -> bool:
    normalized = (model_name or "").strip().lower()
    return normalized in KNOWN_UNAVAILABLE_IMAGE_MODELS


def _resolve_image_generation_candidates(mode: Optional[str] = None) -> List[Dict[str, Any]]:
    backup_api_key = getattr(settings, "IMAGE_GEN_BACKUP_API_KEY", "") or getattr(settings, "ANTHROPIC_BACKUP_API_KEY", "")
    backup_base_url = getattr(settings, "IMAGE_GEN_BACKUP_BASE_URL", "") or getattr(settings, "IMAGE_GEN_BASE_URL", "") or getattr(settings, "ANTHROPIC_BASE_URL", "")
    fallback_api_key = getattr(settings, "IMAGE_GEN_FALLBACK_API_KEY", "") or backup_api_key
    fallback_base_url = (
        getattr(settings, "IMAGE_GEN_FALLBACK_BASE_URL", "")
        or getattr(settings, "IMAGE_GEN_BACKUP_BASE_URL", "")
        or getattr(settings, "IMAGE_GEN_BASE_URL", "")
        or getattr(settings, "ANTHROPIC_BASE_URL", "")
    )
    primary_extra_models = [
        model.strip()
        for model in os.getenv("IMAGE_GEN_FALLBACK_MODELS", "").split(",")
        if model.strip()
    ]

    if mode in IMAGE2_QUALITY_MODES:
        primary_model = getattr(settings, "IMAGE2_GEN_MODEL", "gpt-image-2")
        primary_base_url = getattr(settings, "IMAGE_EDIT_BASE_URL", "") or getattr(settings, "IMAGE_GEN_BASE_URL", "")
        primary_api_key = getattr(settings, "IMAGE_EDIT_API_KEY", "") or getattr(settings, "IMAGE_GEN_API_KEY", "")
        _log_image_runtime_diagnostics(
            "resolve_image_generation_candidates",
            api_key=primary_api_key,
            base_url=primary_base_url,
            model=primary_model,
            provider=_resolve_image_provider(primary_base_url),
            mode=mode,
            config_slot="IMAGE2_GEN_MODEL",
        )
        raw_candidates = build_image_candidate_chain(
            primary_model=primary_model,
            primary_base_url=primary_base_url,
            primary_api_key=primary_api_key,
            backup_same_model_api_key=backup_api_key,
            backup_same_model_base_url=backup_base_url or primary_base_url,
            fallback_models=[
                getattr(settings, "IMAGE_EDIT_FALLBACK_MODEL", "") or getattr(settings, "IMAGE_GEN_FALLBACK_MODEL", "")
            ],
            fallback_api_key=fallback_api_key,
            fallback_base_url=fallback_base_url or primary_base_url,
        )
        return [
            {
                **candidate,
                "label": _image_provider_display_name(candidate["provider"], candidate["model"]),
            }
            for candidate in raw_candidates
        ]

    primary_api_key, primary_base_url, primary_model = resolve_image_generation_config()
    raw_candidates = build_image_candidate_chain(
        primary_model=primary_model,
        primary_base_url=primary_base_url,
        primary_api_key=primary_api_key,
        primary_extra_models=primary_extra_models,
        backup_same_model_api_key=backup_api_key,
        backup_same_model_base_url=backup_base_url or primary_base_url,
        fallback_models=[getattr(settings, "IMAGE_GEN_FALLBACK_MODEL", "")],
        fallback_api_key=fallback_api_key,
        fallback_base_url=fallback_base_url or primary_base_url,
    )
    candidates: List[Dict[str, Any]] = [
        {
            **candidate,
            "label": _image_provider_display_name(candidate["provider"], candidate["model"]),
        }
        for candidate in raw_candidates
    ]

    tuzi_base_url = os.getenv("TUZI_BASE_URL", "").strip()
    if settings.TUZI_API_KEY and tuzi_base_url:
        provider = _resolve_image_provider(tuzi_base_url)
        tuzi_model = os.getenv("TUZI_IMAGE_MODEL", "").strip()
        if tuzi_model and _is_known_unavailable_image_model(tuzi_model):
            logger.warning("跳过已知不可用的 Tuzi 生图模型: %s", tuzi_model)
            tuzi_model = ""
        if tuzi_model:
            candidates.append({
                "provider": provider,
                "api_key": settings.TUZI_API_KEY,
                "base_url": tuzi_base_url,
                "model": tuzi_model,
                "label": _image_provider_display_name(provider, tuzi_model),
            })

    minimax_base_url = os.getenv("MINIMAX_IMAGE_BASE_URL", "").strip()
    if settings.MINIMAX_API_KEY and minimax_base_url:
        candidates.append({
            "provider": "minimax",
            "api_key": settings.MINIMAX_API_KEY,
            "base_url": minimax_base_url,
            "model": os.getenv("MINIMAX_IMAGE_MODEL", "image-01"),
            "label": "MiniMax",
        })

    deduped: List[Dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for candidate in candidates:
        if _is_known_unavailable_image_model(candidate.get("model")):
            logger.warning("跳过已知不可用的生图候选: provider=%s, model=%s", candidate.get("provider"), candidate.get("model"))
            continue
        key = (candidate["provider"], candidate["base_url"], candidate["model"], candidate.get("key_slot") or candidate.get("api_key"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _resolve_workflow_concurrency(candidates: List[Dict[str, Any]]) -> int:
    if not candidates:
        return DEFAULT_IMAGE_WORKFLOW_CONCURRENCY
    primary_provider = candidates[0].get("provider", "")
    primary_model = candidates[0].get("model", "")
    if "gpt-image-2" in str(primary_model or "").lower():
        return IMAGE2_DYNAMIC_WORKFLOW_CONCURRENCY
    if _is_gemini_sync_image_provider(primary_provider, primary_model):
        return GEMINI_WORKFLOW_CONCURRENCY
    return PROVIDER_CONCURRENCY_LIMITS.get(primary_provider, DEFAULT_IMAGE_WORKFLOW_CONCURRENCY)


def _resolve_image_owner_concurrency_limit(metadata: Optional[Dict[str, Any]]) -> int:
    return resolve_image_job_policy_limit(_resolve_image_job_policy_key(metadata))


def _resolve_edit_owner_concurrency_limit(metadata: Optional[Dict[str, Any]]) -> int:
    return resolve_image_job_policy_limit(_resolve_edit_job_policy_key(metadata))


def _resolve_image_job_policy_key(metadata: Optional[Dict[str, Any]]) -> str:
    normalized_mode = str((metadata or {}).get("visual_mode_resolved") or (metadata or {}).get("prompt_strategy") or "").strip().lower()
    if normalized_mode in IMAGE2_QUALITY_MODES:
        return normalized_mode
    if normalized_mode in {"concept", "concept_cloud"}:
        return "concept"
    return normalized_mode or "image"


def _sanitize_image2_dynamic_style_params(
    dynamic_style_params: Optional[Dict[str, Any]],
    prompt_strategy: Optional[str],
) -> Optional[Dict[str, Any]]:
    if not isinstance(dynamic_style_params, dict):
        return dynamic_style_params
    if str(prompt_strategy or "").strip().lower() == "style_expression":
        return dynamic_style_params
    return {
        key: value
        for key, value in dynamic_style_params.items()
        if key not in STYLE_EXPRESSION_PARAM_KEYS
    }


def _resolve_edit_job_policy_key(metadata: Optional[Dict[str, Any]]) -> str:
    edit_purpose = str((metadata or {}).get("edit_purpose") or "").strip().lower()
    if edit_purpose == "logo_replacement":
        return "logo_replacement"
    normalized_mode = str((metadata or {}).get("visual_mode_resolved") or "").strip().lower()
    if normalized_mode == "material_fusion":
        return "material_fusion"
    return "image_edit"


def _resolve_workflow_stagger_seconds(candidates: List[Dict[str, Any]]) -> float:
    if not candidates:
        return DEFAULT_WORKFLOW_STAGGER_SECONDS
    if any("gpt-image-2" in str(candidate.get("model") or "").lower() for candidate in candidates):
        return 0.0
    primary_provider = (candidates[0].get("provider") or "").lower()
    primary_model = (candidates[0].get("model") or "").lower()
    if _is_gemini_sync_image_provider(primary_provider, primary_model):
        return GEMINI_WORKFLOW_STAGGER_SECONDS
    if primary_provider == "n9e":
        return N9E_WORKFLOW_STAGGER_SECONDS
    return DEFAULT_WORKFLOW_STAGGER_SECONDS


def _count_chinese_characters(value: Optional[str]) -> int:
    if not value:
        return 0
    return len(re.findall(r"[\u4e00-\u9fff]", value))


def _extract_visible_copy_lines(prompt: str) -> Dict[str, str]:
    extracted: Dict[str, str] = {}
    patterns = {
        "main_title": r'Main title(?: text)?\s*:\s*"([^"]+)"',
        "subtitle": r'Subtitle(?: text)?\s*:\s*"([^"]+)"',
        "cta": r'CTA(?: text)?\s*:\s*"([^"]+)"',
        "bullet_1": r'Bullet(?: text)?\s*1\s*:\s*"([^"]+)"',
        "bullet_2": r'Bullet(?: text)?\s*2\s*:\s*"([^"]+)"',
        "bullet_3": r'Bullet(?: text)?\s*3\s*:\s*"([^"]+)"',
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, prompt, re.IGNORECASE)
        if match:
            extracted[key] = match.group(1).strip()
    return extracted


def _validate_concept_prompt_chinese_copy(prompts: List[Dict[str, Any]]) -> Dict[str, Any]:
    invalid_items: List[Dict[str, Any]] = []
    for index, item in enumerate(prompts, start=1):
        prompt_text = str(item.get("prompt") or "")
        copy_lines = _extract_visible_copy_lines(prompt_text)
        chinese_copy_count = sum(1 for value in copy_lines.values() if _count_chinese_characters(value) >= 2)
        total_chinese_chars = _count_chinese_characters(prompt_text)
        has_copy_plan = "[Chinese Copy Plan]" in prompt_text
        is_valid = has_copy_plan and chinese_copy_count >= 4 and total_chinese_chars >= 16
        if not is_valid:
            invalid_items.append({
                "index": index,
                "title": item.get("title"),
                "has_copy_plan": has_copy_plan,
                "chinese_copy_count": chinese_copy_count,
                "total_chinese_chars": total_chinese_chars,
                "copy_lines": copy_lines,
                "prompt_preview": prompt_text[:400],
            })

    return {
        "ok": len(invalid_items) == 0,
        "invalid_items": invalid_items,
    }


def _build_visual_messages(
    *,
    title: str,
    content: str,
    style: str,
    mode: str,
    material_summary: Optional[str],
    reference_summary: Optional[str],
    reference_assets: Optional[List[Dict[str, Any]]],
    primary_reference_asset_id: Optional[str],
    dynamic_style_params: Optional[Dict[str, Any]] = None,
    desired_image_count: int = 3,
    product_brief: Optional[Dict[str, Any]] = None,
) -> tuple[str, str, str]:
    normalized_mode = _normalize_visual_mode(mode)
    image2_dynamic_style_params = _sanitize_image2_dynamic_style_params(dynamic_style_params, normalized_mode)

    if normalized_mode == "template_compose":
        system_prompt = "Return JSON only."
        user_message = "Template compose mode should bypass prompt generation."
        return system_prompt, user_message, "template_compose"
    
    if normalized_mode in IMAGE2_QUALITY_MODES:
        from backend.services.image2_prompt_engine import build_image2_dynamic_messages
        system_prompt, user_message = build_image2_dynamic_messages(
            title=title,
            content=content,
            dynamic_style_params=image2_dynamic_style_params,
            product_brief=product_brief,
        )
        return system_prompt, user_message, normalized_mode

    if normalized_mode == "material_fusion":
        system_prompt, user_message = _build_material_fusion_visual_messages(
            title=title,
            content=content,
            material_summary=material_summary,
            reference_summary=reference_summary,
            reference_assets=reference_assets,
            primary_reference_asset_id=primary_reference_asset_id,
            product_brief=product_brief,
        )
        return system_prompt, user_message, "material_fusion"

    system_prompt, user_message = _build_concept_visual_messages(
        title=title,
        content=content,
        style=style,
        target_count=desired_image_count,
        product_brief=product_brief,
    )
    return system_prompt, user_message, "concept_cloud"


def _generate_visual_prompts_sync(
    client: Any,
    system_prompt: str,
    user_message: str,
    primary_model: str,
    text_fallback_model: str,
    prompt_strategy: Optional[str] = None,
) -> tuple[List[Dict[str, Any]], str, Dict[str, Any]]:
    best_effort_result: Optional[tuple[List[Dict[str, Any]], str, Dict[str, Any]]] = None
    _ = client
    config_candidates = _prefer_healthy_model_candidates(
        get_text_generation_config_candidates(),
        kind="text",
    )
    if not config_candidates:
        api_key, base_url = resolve_text_generation_config()
        config_candidates = [{
            "name": "resolved_default",
            "api_key": api_key,
            "base_url": base_url,
        }]

    for config in config_candidates:
        prompt_client = OpenAI(
            api_key=config["api_key"],
            base_url=config["base_url"],
            timeout=VISUAL_PROMPT_TIMEOUT_SECONDS,
            default_headers={"Accept-Encoding": "identity"},
        )
        config_models = _prompt_model_candidates(primary_model, text_fallback_model)
        for model_name in config_models:
            text_candidate = {**config, "model": model_name, "provider": "text"}
            for attempt in range(1, PROMPT_OVERLOAD_RETRIES + 1):
                try:
                    logger.info("开始调用 AI API 生成提示词, config=%s, model=%s, attempt=%s", config.get("name"), model_name, attempt)
                    effective_user_message = user_message
                    if prompt_strategy == "concept_cloud" and attempt > 1:
                        effective_user_message = f"""{user_message}

---
# RETRY HARD CONSTRAINTS
- Your previous output did not satisfy the Chinese visible copy requirement.
- Return one JSON object with a top-level "prompts" array only.
- Return exactly the requested number of prompt objects and keep them compact.
- Keep the engineering structure in English, but ALL visible poster copy must be Chinese-first.
- You MUST include [Chinese Copy Plan] with Chinese Main title / Subtitle / CTA / Bullet texts.
- Do NOT use English slogans as the main poster text.
""".strip()

                    response = prompt_client.chat.completions.create(
                        model=model_name,
                        messages=[
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": effective_user_message}
                        ],
                        response_format={"type": "json_object"},
                        temperature=0.3,
                        max_tokens=VISUAL_PROMPT_MAX_TOKENS
                    )

                    content_text = response.choices[0].message.content if response.choices else None
                    if content_text is None or not str(content_text).strip():
                        raise ValueError("提示词模型未返回可解析内容")
                    logger.info("AI 返回原始内容:\n%s", content_text)
                    parsed_data = clean_and_parse_ai_json(content_text)
                    prompts, stats = _normalize_visual_prompts(parsed_data)
                    _clear_model_candidate_cooldown(text_candidate, kind="text")
                    design_plan = _extract_dynamic_design_plan(parsed_data) if prompt_strategy in IMAGE2_QUALITY_MODES else None
                    if design_plan:
                        stats["design_plan"] = design_plan
                        stats["recommended_image_count"] = design_plan.get("image_count")
                    if not prompts:
                        raise ValueError("提示词结果格式无效：未生成任何可用提示词")

                    logger.info(
                        "成功解析 %s 个提示词, model=%s, raw=%s, dropped=%s",
                        len(prompts),
                        model_name,
                        stats["raw_prompt_count"],
                        stats["dropped_prompt_items"],
                    )
                    if prompt_strategy == "concept_cloud":
                        validation = _validate_concept_prompt_chinese_copy(prompts)
                        chinese_copy_summary = [
                            {
                                "index": item["index"],
                                "has_copy_plan": item["has_copy_plan"],
                                "chinese_copy_count": item["chinese_copy_count"],
                                "total_chinese_chars": item["total_chinese_chars"],
                            }
                            for item in validation["invalid_items"]
                        ]
                        logger.info(
                            "concept_cloud 中文文案校验: ok=%s, invalid=%s, preview=%s",
                            validation["ok"],
                            chinese_copy_summary,
                            prompts[0].get("prompt", "")[:300] if prompts else "",
                        )
                        best_effort_result = (prompts, model_name, stats)
                        if not validation["ok"]:
                            missing_copy_plan_count = sum(1 for item in validation["invalid_items"] if not item["has_copy_plan"])
                            severe_invalid_count = sum(
                                1
                                for item in validation["invalid_items"]
                                if (not item["has_copy_plan"]) or item["total_chinese_chars"] < 24
                            )
                            if attempt < PROMPT_OVERLOAD_RETRIES:
                                if severe_invalid_count <= 1 and missing_copy_plan_count == 0:
                                    logger.info(
                                        "concept_cloud 中文文案存在轻微不足，但已满足可用质量阈值，跳过额外重试以缩短等待: model=%s, attempt=%s, invalid=%s",
                                        model_name,
                                        attempt,
                                        chinese_copy_summary,
                                    )
                                    return prompts, model_name, stats
                                logger.warning(
                                    "concept_cloud 中文文案约束不足，准备仅重试提示词生成: model=%s, attempt=%s, invalid=%s",
                                    model_name,
                                    attempt,
                                    chinese_copy_summary,
                                )
                                time.sleep(PROMPT_OVERLOAD_BACKOFF_SECONDS * attempt)
                                continue
                            logger.warning(
                                "concept_cloud 中文文案约束仍偏弱，返回当前结果供前端与日志排查: invalid=%s",
                                validation["invalid_items"],
                            )
                    return prompts, model_name, stats
                except Exception as e:
                    error_text = str(e)
                    is_overloaded = "529" in error_text or "overloaded" in error_text.lower()
                    is_parse_failure = isinstance(e, (ValueError, json.JSONDecodeError)) or "expecting value" in error_text.lower()
                    logger.warning(
                        "提示词模型调用失败, config=%s, model=%s, attempt=%s, error=%s",
                        config.get("name"),
                        model_name,
                        attempt,
                        error_text,
                    )
                    if (is_overloaded or is_parse_failure) and attempt < PROMPT_OVERLOAD_RETRIES:
                        time.sleep(PROMPT_OVERLOAD_BACKOFF_SECONDS * attempt)
                        continue
                    if is_parse_failure:
                        break
                    if is_retryable_text_generation_error(e):
                        _mark_model_candidate_unhealthy(
                            text_candidate,
                            kind="text",
                            reason=str(classify_model_gateway_error(e).get("kind") or "retryable_error"),
                        )
                        break
                    raise
    if best_effort_result:
        logger.warning("提示词模型未达到理想中文文案约束，回退返回最佳可用结果")
        return best_effort_result
    raise RuntimeError("提示词模型未执行或未返回可解析的提示词 JSON")


def _raise_visual_http_error(error: Exception) -> None:
    error_msg = str(error)
    normalized = error_msg.lower()
    classified = classify_model_gateway_error(error)

    if "429" in normalized or "resource has been exhausted" in normalized or "rate limit" in normalized:
        raise HTTPException(
            status_code=429,
            detail=f"AI 服务繁忙或额度已耗尽: {error_msg}"
        )
    if "timeout" in normalized or "timed out" in normalized:
        raise HTTPException(
            status_code=504,
            detail="图片提示词生成超时，请稍后重试。当前没有自动回退到其他模型。"
        )
    if classified["kind"] != "unknown":
        raise HTTPException(status_code=classified["status_code"], detail=classified["message"])
    raise HTTPException(status_code=500, detail=error_msg)


def _user_facing_model_error_message(error: Exception | str, fallback: str = "模型调用失败，请稍后重试。") -> str:
    classified = classify_model_gateway_error(error)
    if classified.get("kind") != "unknown" and classified.get("message"):
        return str(classified["message"])
    error_text = str(error or "").strip()
    return error_text or fallback


class AnalyzeRequest(BaseModel):
    title: str
    content: str
    style: str = "cyberpunk"
    mode: str = "概念表达"
    material_summary: Optional[str] = ""
    reference_summary: Optional[str] = ""
    reference_assets: Optional[List[Dict[str, Any]]] = None
    primary_reference_asset_id: Optional[str] = ""
    product_brief: Optional[Dict[str, Any]] = None
    template_kind: Optional[str] = ""
    dynamic_style_params: Optional[Dict[str, Any]] = None

class AnalyzeResponse(BaseModel):
    success: bool
    message: str
    prompts: Optional[List[Dict[str, Any]]] = None
    data: Optional[Dict[str, Any]] = None


class GenerateImageRequest(BaseModel):
    prompt: str
    count: int = 1
    aspect_ratio: str = "3:4"
    image_size: str = "1K"
    mode: Optional[str] = None


class DynamicImageRequest(BaseModel):
    client_request_id: Optional[str] = ""
    title: str
    tags: Optional[List[str]] = None
    image_count: int = 1
    style: str = "cyberpunk"
    content: Optional[str] = ""
    dynamic_style_params: Optional[Dict[str, Any]] = None
    product_brief: Optional[Dict[str, Any]] = None


class GenerateImageResponse(BaseModel):
    success: bool
    message: str
    task_id: str
    data: Optional[Dict[str, Any]] = None


class WorkflowRequest(BaseModel):
    client_request_id: Optional[str] = ""
    title: str
    content: str
    style: str = "cyberpunk"
    image_count: int = 1
    mode: str = "概念表达"
    material_summary: Optional[str] = ""
    reference_summary: Optional[str] = ""
    reference_assets: Optional[List[Dict[str, Any]]] = None
    primary_reference_asset_id: Optional[str] = ""
    prompts: Optional[List[Dict[str, Any]]] = None
    product_brief: Optional[Dict[str, Any]] = None
    template_kind: Optional[str] = ""
    dynamic_style_params: Optional[Dict[str, Any]] = None
    material_fusion_plan: Optional[List[Dict[str, Any]]] = None
    design_plan: Optional[Dict[str, Any]] = None
    prompt_stats: Optional[Dict[str, Any]] = None


def _normalize_client_request_id(value: Optional[str]) -> str:
    return re.sub(r"[^a-zA-Z0-9_.:-]", "", (value or "").strip())[:96]


def _normalize_dynamic_image_tags(tags: Optional[List[str]]) -> List[str]:
    normalized: List[str] = []
    for item in tags or []:
        tag = re.sub(r"\s+", "", str(item or "").strip().lstrip("#"))
        if tag and tag not in normalized:
            normalized.append(tag)
    return normalized[:20]


def _build_dynamic_image_content(title: str, tags: Optional[List[str]], content: Optional[str]) -> str:
    normalized_tags = _normalize_dynamic_image_tags(tags)
    tag_text = " ".join(f"#{tag}" for tag in normalized_tags)
    sections = [
        f"笔记标题：{title.strip()}",
    ]
    if tag_text:
        sections.append(f"笔记标签：{tag_text}")
    if content and content.strip():
        sections.append(f"补充内容：{content.strip()}")
    sections.append("请基于笔记标题和标签生成适合小红书的动态表达图片。")
    return "\n".join(sections)


def _find_existing_workflow_tasks(user_id: str, client_request_id: str) -> List[str]:
    if not client_request_id:
        return []
    matched: List[Dict[str, Any]] = []
    for task in task_manager.get_all_tasks().values():
        metadata = task.get("metadata") or {}
        if metadata.get("user_id") != user_id:
            continue
        if metadata.get("client_request_id") != client_request_id:
            continue
        if metadata.get("task_kind") not in {"image", "image_edit"}:
            continue
        matched.append(task)
    matched.sort(key=lambda item: int((item.get("metadata") or {}).get("workflow_index") or 0))
    return [str(item.get("task_id")) for item in matched if item.get("task_id")]


def _build_workflow_signature(request: WorkflowRequest) -> str:
    payload = {
        "title": request.title,
        "content": request.content,
        "style": request.style,
        "image_count": request.image_count,
        "mode": request.mode,
        "material_summary": request.material_summary,
        "reference_summary": request.reference_summary,
        "primary_reference_asset_id": request.primary_reference_asset_id,
        "prompts": request.prompts or [],
        "product_brief": request.product_brief or {},
        "template_kind": request.template_kind,
        "dynamic_style_params": request.dynamic_style_params or {},
        "material_fusion_plan": request.material_fusion_plan or [],
        "design_plan": request.design_plan or {},
        "prompt_stats": request.prompt_stats or {},
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _find_recent_duplicate_workflow_tasks(user_id: str, workflow_signature: str, window_seconds: int = 180) -> List[str]:
    if not workflow_signature:
        return []
    now = datetime.now()
    matched: List[Dict[str, Any]] = []
    for task in task_manager.get_all_tasks().values():
        metadata = task.get("metadata") or {}
        if metadata.get("user_id") != user_id:
            continue
        if metadata.get("workflow_signature") != workflow_signature:
            continue
        if metadata.get("task_kind") not in {"image", "image_edit"}:
            continue
        created_at = _parse_iso_datetime(task.get("created_at"))
        if created_at:
            comparable_now = datetime.now(created_at.tzinfo) if created_at.tzinfo else now
            if (comparable_now - created_at).total_seconds() > window_seconds:
                continue
        matched.append(task)
    matched.sort(key=lambda item: int((item.get("metadata") or {}).get("workflow_index") or 0))
    return [str(item.get("task_id")) for item in matched if item.get("task_id")]


class ComposeTemplateRequest(BaseModel):
    title: str
    content: str
    product_brief: Optional[Dict[str, Any]] = None
    reference_assets: Optional[List[Dict[str, Any]]] = None
    primary_reference_asset_id: Optional[str] = ""
    template_kind: Optional[str] = ""
    brand_style: Optional[str] = ""
    note_visual_plan: Optional[Dict[str, Any]] = None


class ComposeTemplateSeriesRequest(BaseModel):
    title: str
    content: str
    product_brief: Optional[Dict[str, Any]] = None
    reference_assets: Optional[List[Dict[str, Any]]] = None
    primary_reference_asset_id: Optional[str] = ""
    brand_style: Optional[str] = ""
    note_visual_plan: Optional[Dict[str, Any]] = None
    card_count_limit: Optional[int] = None


class ComposeTemplateResponse(BaseModel):
    success: bool
    message: str
    data: Dict[str, Any]


class GenerateContentRequest(BaseModel):
    product_name: str
    target_audience: str
    product_features: str
    content_style: str = "seed"
    benchmark_note: Optional[Dict[str, Any]] = None
    rewrite_mode: Optional[str] = "结构仿写"
    brand_tone: Optional[str] = None
    must_include: Optional[str] = None
    banned_terms: Optional[str] = None
    real_phrases: Optional[List[str]] = None
    sales_intensity: int = 45
    colloquial_level: int = 75
    authenticity_level: int = 80
    research_context: Optional[Dict[str, Any]] = None
    note_strategy: Optional[Dict[str, Any]] = None


class GenerateContentResponse(BaseModel):
    success: bool
    message: str
    title: Optional[str] = None
    content: Optional[str] = None
    final_body: Optional[str] = None
    tags: Optional[List[str]] = None
    rewrite_session: Optional[Dict[str, Any]] = None
    note_visual_plan: Optional[Dict[str, Any]] = None
    research_context: Optional[Dict[str, Any]] = None
    note_strategy: Optional[Dict[str, Any]] = None


class AsyncTextTaskResponse(BaseModel):
    success: bool
    message: str
    task_id: str
    status: str = TaskStatus.PENDING.value


def _safe_json_loads(value: Any) -> Any:
    if value is None or isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def _format_prompt_log_row(row: Dict[str, Any]) -> Dict[str, Any]:
    data = dict(row)
    for key in (
        "prompt_payload",
        "design_plan",
        "prompt_stats",
        "product_brief",
        "dynamic_style_params",
        "reference_asset_ids",
    ):
        data[key] = _safe_json_loads(data.get(key))
    created_at = data.get("created_at")
    if isinstance(created_at, datetime):
        data["created_at"] = created_at.isoformat()
    elif created_at is not None:
        data["created_at"] = str(created_at)
    return data


def _resolve_optional_user_id_from_authorization(authorization: Any) -> str:
    if not settings.AUTH_REQUIRED:
        return settings.DEFAULT_DEV_USER_ID
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        return settings.DEFAULT_DEV_USER_ID
    payload = decode_access_token(authorization.replace("Bearer ", "", 1).strip())
    return str((payload or {}).get("sub") or settings.DEFAULT_DEV_USER_ID).strip() or settings.DEFAULT_DEV_USER_ID


class GenerateNoteVisualPlanRequest(BaseModel):
    title: str
    content: str
    product_brief: Optional[Dict[str, Any]] = None
    reference_assets: Optional[List[Dict[str, Any]]] = None
    note_strategy: Optional[Dict[str, Any]] = None


class ReviseNoteRequest(BaseModel):
    title: str
    opening: str
    outline: List[str]
    body: str
    closing: Optional[str] = ""
    instruction: str
    selected_scope: Optional[str] = None
    rewrite_session: Optional[Dict[str, Any]] = None
    product_brief: Optional[Dict[str, Any]] = None
    benchmark_note: Optional[Dict[str, Any]] = None
    note_strategy: Optional[Dict[str, Any]] = None


class ResearchContextRequest(BaseModel):
    product_brief: Dict[str, Any]
    reference_assets: Optional[List[Dict[str, Any]]] = None
    benchmark_note: Optional[Dict[str, Any]] = None


class StrategyRequest(BaseModel):
    research_context: Dict[str, Any]
    benchmark_note: Optional[Dict[str, Any]] = None
    real_phrases: Optional[List[str]] = None
    strategy_mode: Optional[str] = "research_first"
    strategy_feedback: Optional[str] = ""


class BasicDataResponse(BaseModel):
    success: bool
    message: str
    data: Dict[str, Any]


async def run_edit_task(
    task_id: str,
    image_id: str,
    edit_prompt: str,
    aspect_ratio: str,
    image_size: str,
    user_id: Optional[str] = None,
    reference_asset_ids: Optional[List[str]] = None,
):
    try:
        if _is_visual_task_cancelled(task_id):
            return
        await _update_visual_task(
            task_id,
            status=TaskStatus.RUNNING,
            progress=20,
            message="开始编辑图片",
            metadata=_merge_tuzi_task_metadata(
                (task_manager.get_task(task_id) or {}).get("metadata"),
                stage="prompting",
            ),
        )
        
        from backend.services.image_generator import ImageGenerator
        import asyncio
        
        api_key, base_url, model, fallback_api_key, fallback_base_url, fallback_model = resolve_image_edit_config()
        
        normalized_base_url = (base_url or "").lower()
        if "tu-zi.com" in normalized_base_url:
            provider = "tuzi"
        elif "minimaxi.com" in normalized_base_url:
            provider = "minimax"
        elif "openrouter.ai" in normalized_base_url:
            provider = "openrouter"
        else:
            provider = "custom"
        
        generator = ImageGenerator(
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider
        )
        
        output_dir = str(_get_visual_output_dir())
        
        image_path = ""
        source_asset_record = _load_reference_asset_record(image_id, user_id=user_id)
        if source_asset_record:
            image_path = str(_get_reference_uploads_root() / source_asset_record.relative_path)
        else:
            image_path = str(_resolve_generated_image_path(image_id))
        
        if not Path(image_path).exists():
            await _update_visual_task(
                task_id,
                status=TaskStatus.FAILED,
                message="图片文件不存在",
                error=f"未找到图片: {image_id}，路径: {image_path}"
            )
            return

        current_task_metadata = (task_manager.get_task(task_id) or {}).get("metadata") or {}
        edit_purpose = str(current_task_metadata.get("edit_purpose") or "").strip().lower()
        edit_candidate_seed = str(current_task_metadata.get("candidate_seed") or task_id).strip() or task_id
        raw_candidate_offset = current_task_metadata.get("candidate_offset")
        try:
            edit_candidate_offset = int(raw_candidate_offset) if raw_candidate_offset is not None else None
        except (TypeError, ValueError):
            edit_candidate_offset = None
        edit_candidates = generator.resolve_edit_candidates_for_task(
            edit_candidate_seed,
            candidate_offset=edit_candidate_offset,
        )
        if edit_purpose == "logo_replacement":
            trace_metadata = current_task_metadata.get("trace_metadata") or {}
            avoid_resource_ids = {
                str(item).strip()
                for item in (trace_metadata.get("avoid_resource_ids") or [])
                if str(item).strip()
            }
            avoid_resource_ids.update(_logo_replacement_resource_cooldown_ids())
            edit_candidates = _prefer_available_edit_candidates(
                edit_candidates,
                avoid_resource_ids=avoid_resource_ids,
            )
        active_edit_candidate = edit_candidates[0] if edit_candidates else {
            "provider": provider,
            "base_url": base_url,
            "model": model,
            "api_key": api_key,
        }
        active_edit_resource_id = _edit_candidate_resource_id(active_edit_candidate)
        is_logo_replacement = edit_purpose == "logo_replacement"
        upload_supporting_images = not bool(current_task_metadata.get("reference_metadata_only"))
        allowed_upload_reference_ids = {
            str(item).strip()
            for item in (current_task_metadata.get("upload_reference_asset_ids") or [])
            if str(item).strip()
        }
        supporting_image_paths: List[str] = []
        uploaded_reference_ids: List[str] = []
        reference_instructions: List[str] = []
        for reference_asset_id in reference_asset_ids or []:
            normalized_reference_id = str(reference_asset_id or "").strip()
            if not normalized_reference_id or normalized_reference_id == str(image_id):
                continue
            reference_asset_record = _load_reference_asset_record(normalized_reference_id, user_id=user_id)
            if not reference_asset_record:
                logger.warning("[Visual] 对话参考图不存在或无权限: %s", normalized_reference_id)
                continue
            reference_path = _get_reference_uploads_root() / reference_asset_record.relative_path
            if reference_path.exists():
                should_upload_reference = upload_supporting_images or normalized_reference_id in allowed_upload_reference_ids
                if should_upload_reference:
                    supporting_image_paths.append(str(reference_path))
                    uploaded_reference_ids.append(normalized_reference_id)
                reference_instructions.append(_build_reference_asset_instruction(reference_asset_record, len(reference_instructions) + 2))
        enriched_edit_prompt = edit_prompt
        if reference_instructions:
            enriched_edit_prompt = (
                f"{edit_prompt}\n\n"
                "User-provided reference image metadata:\n"
                + "\n".join(reference_instructions)
            )
        logger.info(
            "[Visual] 编辑任务素材上下文: task_id=%s, source_asset=%s, supporting_images=%s, uploaded_reference_ids=%s, allowed_upload_reference_ids=%s, reference_metadata_only=%s, reference_instructions=%s, candidate_seed=%s, candidate_offset=%s, edit_resource=%s, trace=%s",
            task_id,
            image_id,
            len(supporting_image_paths),
            uploaded_reference_ids,
            list(allowed_upload_reference_ids),
            current_task_metadata.get("reference_metadata_only"),
            len(reference_instructions),
            edit_candidate_seed,
            edit_candidate_offset,
            active_edit_resource_id,
            current_task_metadata.get("trace_metadata") or {},
        )
        await _update_visual_task(
            task_id,
            status=TaskStatus.RUNNING,
            progress=45,
            message="等待图片编辑资源",
            metadata=_merge_tuzi_task_metadata(
                (task_manager.get_task(task_id) or {}).get("metadata"),
                stage="image_queue_wait",
                active_provider="image_edit",
                edit_primary_model=model,
                edit_primary_base_url=base_url,
                edit_fallback_model=fallback_model,
                edit_fallback_base_url=fallback_base_url,
                edit_fallback_used=False,
                edit_transport="images_edit",
                edit_purpose=edit_purpose or None,
                candidate_seed=edit_candidate_seed,
                candidate_offset=edit_candidate_offset,
                edit_resource_id=active_edit_resource_id,
                sync_timeout_seconds=_resolve_sync_image_task_timeout_seconds(provider, model, mode=edit_purpose or "image_edit"),
                reference_metadata_only=not upload_supporting_images and not allowed_upload_reference_ids,
                upload_reference_asset_ids=list(allowed_upload_reference_ids),
                image_runner=get_image_job_runner_stats(),
            ),
        )

        async with image_job_slot(
            task_id,
            job_type="image_edit",
            label=model,
            owner_id=current_task_metadata.get("user_id"),
            policy_key=_resolve_edit_job_policy_key(current_task_metadata),
            resource_id=active_edit_resource_id,
            should_cancel=lambda: _is_visual_task_cancelled(task_id),
        ) as queue_wait_seconds:
            if _is_visual_task_cancelled(task_id):
                return
            await _update_visual_task(
                task_id,
                status=TaskStatus.RUNNING,
                progress=50,
                message="正在基于主素材编辑海报",
                metadata=_merge_tuzi_task_metadata(
                    (task_manager.get_task(task_id) or {}).get("metadata"),
                    stage="generating",
                    provider=provider,
                    model=model,
                    edit_purpose=edit_purpose or None,
                    candidate_seed=edit_candidate_seed,
                    candidate_offset=edit_candidate_offset,
                    edit_resource_id=active_edit_resource_id,
                    sync_timeout_seconds=_resolve_sync_image_task_timeout_seconds(provider, model, mode=edit_purpose or "image_edit"),
                    edit_model_started_at=datetime.now(timezone.utc).isoformat(),
                    image_queue_wait_seconds=round(queue_wait_seconds, 3),
                    image_runner=get_image_job_runner_stats(),
                ),
            )
            edit_timeout_seconds = _resolve_sync_image_task_timeout_seconds(provider, model, mode=edit_purpose or "image_edit")
            edit_future = asyncio.create_task(asyncio.to_thread(
                generator.edit_image,
                image_path=image_path,
                edit_prompt=enriched_edit_prompt,
                output_dir=output_dir,
                aspect_ratio=aspect_ratio,
                image_size=image_size,
                supporting_image_paths=supporting_image_paths,
                allow_reduced_supporting_retry=not bool(current_task_metadata.get("material_fusion_serial_mode")),
                edit_purpose=edit_purpose,
                candidate_offset_seed=edit_candidate_seed,
                candidate_offset=edit_candidate_offset,
                candidate_chain=edit_candidates,
            ))
            cancel_future = asyncio.create_task(_wait_for_visual_task_cancellation(task_id))
            try:
                done, pending = await asyncio.wait(
                    {edit_future, cancel_future},
                    timeout=edit_timeout_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if cancel_future in done:
                    edit_future.cancel()
                    logger.info("图片编辑任务已取消，停止等待上游返回: task_id=%s", task_id)
                    return
                if edit_future not in done:
                    edit_future.cancel()
                    raise asyncio.TimeoutError()
                edited_paths = edit_future.result()
            except asyncio.TimeoutError:
                if is_logo_replacement:
                    _mark_logo_replacement_resource_unhealthy(active_edit_resource_id, reason="timeout")
                logger.warning(
                    "图片编辑任务超时: task_id=%s, edit_purpose=%s, model=%s, timeout_seconds=%s",
                    task_id,
                    edit_purpose or "image_edit",
                    model,
                    edit_timeout_seconds,
                )
                await _update_visual_task(
                    task_id,
                    status=TaskStatus.FAILED,
                    progress=100,
                    message="图片编辑超时",
                    error=f"图片编辑接口响应超过 {edit_timeout_seconds} 秒，本次已停止，请重试",
                    metadata=_merge_tuzi_task_metadata(
                        (task_manager.get_task(task_id) or {}).get("metadata"),
                        stage="failed",
                        retryable=True,
                        edit_timeout_seconds=edit_timeout_seconds,
                        last_error="image edit timed out",
                    ),
                )
                return
            finally:
                cancel_future.cancel()
                if not edit_future.done():
                    edit_future.cancel()

        if _is_visual_task_cancelled(task_id):
            return
        
        await _update_visual_task(
            task_id,
            status=TaskStatus.RUNNING,
            progress=90,
            message="图片编辑完成，正在保存"
        )
        
        if edited_paths:
            if is_logo_replacement:
                _clear_logo_replacement_resource_cooldown(active_edit_resource_id)
            edited_urls = [f"/static/images/{Path(p).name}" for p in edited_paths]
            edit_runtime_metadata = getattr(generator, "last_edit_metadata", {}) or {}
            await _update_visual_task(
                task_id,
                status=TaskStatus.COMPLETED,
                progress=100,
                message="图片编辑完成",
                result={
                    "success": True,
                    "images": edited_urls,
                    "paths": edited_paths,
                    "original_id": image_id,
                    "edit_source_asset_id": image_id if source_asset_record else None,
                    "reference_asset_ids": reference_asset_ids or [],
                    "edit_primary_model": model,
                    "edit_fallback_model": fallback_model,
                    "edit_actual_model": edit_runtime_metadata.get("edit_actual_model") or model,
                    "edit_fallback_used": bool(edit_runtime_metadata.get("edit_fallback_used")),
                    "supporting_images_dropped_after_retry": bool(edit_runtime_metadata.get("supporting_images_dropped_after_retry")),
                },
                metadata=_merge_tuzi_task_metadata(
                    (task_manager.get_task(task_id) or {}).get("metadata"),
                    stage="completed",
                    edit_source_asset_id=image_id if source_asset_record else None,
                    reference_asset_ids=reference_asset_ids or [],
                    edit_primary_model=model,
                    edit_fallback_model=fallback_model,
                    edit_actual_model=edit_runtime_metadata.get("edit_actual_model") or model,
                    edit_actual_base_url=edit_runtime_metadata.get("edit_actual_base_url"),
                    edit_fallback_used=bool(edit_runtime_metadata.get("edit_fallback_used")),
                    edit_transport=edit_runtime_metadata.get("edit_transport") or "images_edit",
                    candidate_seed=edit_candidate_seed,
                    candidate_offset=edit_candidate_offset,
                    edit_resource_id=active_edit_resource_id,
                    supporting_images_dropped_after_retry=bool(edit_runtime_metadata.get("supporting_images_dropped_after_retry")),
                ),
            )
        else:
            await _update_visual_task(
                task_id,
                status=TaskStatus.FAILED,
                message="图片编辑失败",
                error="未生成任何编辑后的图片"
            )
        
    except Exception as e:
        if isinstance(e, ImageJobCancelled) or _is_visual_task_cancelled(task_id):
            logger.info("图片编辑任务已取消，跳过失败落库: task_id=%s", task_id)
            return
        logger.error(f"图片编辑任务失败: {e}", exc_info=True)
        current_metadata = (task_manager.get_task(task_id) or {}).get("metadata")
        classified_error = classify_model_gateway_error(e)
        if (current_metadata or {}).get("edit_purpose") == "logo_replacement" and _is_retryable_image_generation_error(e):
            _mark_logo_replacement_resource_unhealthy(
                (current_metadata or {}).get("edit_resource_id"),
                reason=str(classified_error.get("kind") or "retryable_error"),
            )
        await _update_visual_task(
            task_id,
            status=TaskStatus.FAILED,
            message="图片编辑失败",
            error=_user_facing_model_error_message(e, "图片编辑失败，请稍后重试。"),
            metadata=_merge_tuzi_task_metadata(
                current_metadata,
                stage="failed",
                edit_error_kind=classified_error.get("kind"),
                raw_error=str(e),
            ),
        )


async def run_generate_task(
    task_id: str,
    prompt: str,
    count: int,
    aspect_ratio: str,
    image_size: str
):
    try:
        if _is_visual_task_cancelled(task_id):
            return
        await _update_visual_task(
            task_id,
            status=TaskStatus.RUNNING,
            progress=20,
            message="正在准备图片生成任务",
        )

        from backend.services.image_generator import ImageGenerator
        import asyncio

        current_snapshot = task_manager.get_task(task_id) or {}
        current_metadata = current_snapshot.get("metadata") or {}
        visual_mode_resolved = current_metadata.get("visual_mode_resolved")
        is_dynamic_image2 = _is_image2_quality_mode(current_metadata)
        request_timeout_seconds = (
            IMAGE2_DYNAMIC_IMAGE_REQUEST_TIMEOUT_SECONDS
            if is_dynamic_image2
            else IMAGE_REQUEST_TIMEOUT_SECONDS
        )
        max_same_candidate_attempts = 1 + (IMAGE2_DYNAMIC_MAX_RETRIES if is_dynamic_image2 else 0)

        candidates = _rotate_image_candidates_for_task(
            _resolve_image_generation_candidates(mode=visual_mode_resolved),
            task_id,
        )
        initial_metadata = _merge_tuzi_task_metadata(
            current_metadata,
            provider_attempts=[],
            primary_provider=candidates[0]["provider"] if candidates else None,
            fallback_providers=[candidate["label"] for candidate in candidates[1:]],
            active_provider=candidates[0]["label"] if candidates else None,
            fallback_used=False,
            retry_policy="provider_fallback_with_backoff",
            stage="submitting",
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            image_size=image_size,
            generation_request_timeout_seconds=request_timeout_seconds,
            generation_max_attempts=max_same_candidate_attempts,
            retry_count=0,
        )
        await _update_visual_task(
            task_id,
            status=TaskStatus.RUNNING,
            progress=25,
            message=f"正在准备调用 {initial_metadata.get('active_provider') or '生图后端'}",
            metadata=initial_metadata,
        )

        output_dir = str(_get_visual_output_dir())
        selected_candidate: Optional[Dict[str, Any]] = None

        def progress_callback_factory(active_candidate: Dict[str, Any]):
            provider = active_candidate["provider"]
            model = active_candidate["model"]
            def _callback(payload: Dict[str, Any]) -> None:
                current_snapshot = task_manager.get_task(task_id) or {}
                metadata_update = {
                    "provider": provider,
                    "model": model,
                    "prompt": prompt,
                    "aspect_ratio": aspect_ratio,
                    "image_size": image_size,
                    "active_provider": active_candidate["label"],
                    "external_task_id": payload.get("external_task_id"),
                    "external_status": payload.get("external_status"),
                    "external_progress": payload.get("external_progress"),
                    "last_polled_at": datetime.utcnow().isoformat(),
                    "retryable": payload.get("retryable", True),
                    "recovery_attempted": payload.get("recovery_attempted", False),
                    "retry_stage": payload.get("stage"),
                    "queue_retry_count": payload.get("queue_retry_count"),
                    "last_remote_error_code": payload.get("last_remote_error_code"),
                    "task_kind": "image",
                    "poll_interval_seconds": TUZI_TASK_REFRESH_INTERVAL_SECONDS if provider == "tuzi" and "preview-async" in (model or "").lower() else None,
                    "stage": payload.get("stage") or current_snapshot.get("metadata", {}).get("stage"),
                }
                clean_metadata = _merge_tuzi_task_metadata(current_snapshot.get("metadata"), **metadata_update)
                task_status = payload.get("status")
                status_enum = TaskStatus(task_status) if task_status in TaskStatus._value2member_map_ else None
                result = None
                saved_files = payload.get("saved_files") or []
                if saved_files:
                    result = {
                        "success": True,
                        "images": [f"/static/images/{Path(p).name}" for p in saved_files],
                        "paths": saved_files,
                    }
                _update_visual_task_sync(
                    task_id,
                    status=status_enum,
                    progress=payload.get("progress"),
                    message=payload.get("message"),
                    result=result,
                    metadata=clean_metadata,
                )
            return _callback

        image_paths: List[str] = []
        errors: List[str] = []
        for candidate_index, candidate in enumerate(candidates, start=1):
            if _is_visual_task_cancelled(task_id):
                return
            selected_candidate = candidate
            candidate_image_paths: List[str] = []
            current_metadata = (task_manager.get_task(task_id) or {}).get("metadata") or {}
            provider_attempts = list(current_metadata.get("provider_attempts") or [])
            provider_attempts.append({
                "provider": candidate["provider"],
                "label": candidate["label"],
                "model": candidate["model"],
                "attempt": candidate_index,
                "started_at": datetime.utcnow().isoformat(),
            })
            stage = "fallback_generating" if candidate_index > 1 else "generating"
            await _update_visual_task(
                task_id,
                status=TaskStatus.RUNNING,
                progress=30 if candidate_index == 1 else 35,
                message=f"等待 {candidate['label']} 生图资源（第 {candidate_index}/{len(candidates)} 路）",
                metadata=_merge_tuzi_task_metadata(
                    current_metadata,
                    provider=candidate["provider"],
                    model=candidate["model"],
                    prompt=prompt,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                    retryable=candidate["provider"] == "tuzi" and "preview-async" in (candidate["model"] or "").lower(),
                    task_kind="image",
                    stage=stage,
                    active_provider=candidate["label"],
                    fallback_used=candidate_index > 1,
                    provider_attempts=provider_attempts,
                    generation_request_timeout_seconds=request_timeout_seconds,
                    generation_max_attempts=max_same_candidate_attempts,
                    retry_count=current_metadata.get("retry_count", 0),
                    image_runner=get_image_job_runner_stats(),
                ),
            )

            generator = ImageGenerator(
                api_key=candidate["api_key"],
                base_url=candidate["base_url"],
                model=candidate["model"],
                provider=candidate["provider"]
            )
            candidate_succeeded = False
            last_candidate_error: Optional[Exception] = None

            for attempt_index in range(1, max_same_candidate_attempts + 1):
                if _is_visual_task_cancelled(task_id):
                    return
                current_metadata = (task_manager.get_task(task_id) or {}).get("metadata") or {}
                attempt_message = f"正在调用 {candidate['label']} 生图模型（第 {candidate_index}/{len(candidates)} 路"
                if max_same_candidate_attempts > 1:
                    attempt_message += f"，尝试 {attempt_index}/{max_same_candidate_attempts}"
                attempt_message += "）"
                await _update_visual_task(
                    task_id,
                    status=TaskStatus.RUNNING,
                    progress=30 if candidate_index == 1 and attempt_index == 1 else 35,
                    message=attempt_message,
                    metadata=_merge_tuzi_task_metadata(
                        current_metadata,
                        provider=candidate["provider"],
                        model=candidate["model"],
                        prompt=prompt,
                        aspect_ratio=aspect_ratio,
                        image_size=image_size,
                        retryable=candidate["provider"] == "tuzi" and "preview-async" in (candidate["model"] or "").lower(),
                        task_kind="image",
                        stage=stage if attempt_index == 1 else "retrying",
                        active_provider=candidate["label"],
                        fallback_used=candidate_index > 1,
                        provider_attempts=provider_attempts,
                        generation_request_timeout_seconds=request_timeout_seconds,
                        generation_max_attempts=max_same_candidate_attempts,
                        retry_count=attempt_index - 1,
                        retry_stage="retrying_same_model" if attempt_index > 1 else stage,
                    ),
                )

                try:
                    async with image_job_slot(
                        task_id,
                        job_type="image_generate",
                        label=candidate["label"],
                        owner_id=current_metadata.get("user_id"),
                        policy_key=_resolve_image_job_policy_key(current_metadata),
                        resource_id=_image_candidate_resource_id(candidate),
                    ) as queue_wait_seconds:
                        current_metadata = (task_manager.get_task(task_id) or {}).get("metadata") or {}
                        await _update_visual_task(
                            task_id,
                            status=TaskStatus.RUNNING,
                            progress=30 if candidate_index == 1 and attempt_index == 1 else 35,
                            message=attempt_message,
                            metadata=_merge_tuzi_task_metadata(
                                current_metadata,
                                stage=stage if attempt_index == 1 else "retrying",
                                image_queue_wait_seconds=round(queue_wait_seconds, 3),
                                image_runner=get_image_job_runner_stats(),
                            ),
                        )
                        candidate_image_paths = await asyncio.to_thread(
                            generator.generate,
                            prompt=prompt,
                            output_dir=output_dir,
                            count=count,
                            aspect_ratio=aspect_ratio,
                            image_size=image_size,
                            progress_callback=progress_callback_factory(candidate),
                            request_timeout_seconds=request_timeout_seconds,
                        )
                    if _is_visual_task_cancelled(task_id):
                        return
                    if candidate_image_paths:
                        image_paths = candidate_image_paths
                        candidate_succeeded = True
                        break
                    last_candidate_error = RuntimeError(f"{candidate['label']}: 未生成任何图片")
                    errors.append(str(last_candidate_error))
                except Exception as candidate_error:
                    last_candidate_error = candidate_error
                    errors.append(f"{candidate['label']} 尝试 {attempt_index}/{max_same_candidate_attempts}: {candidate_error}")

                should_retry_same_candidate = (
                    is_dynamic_image2
                    and attempt_index < max_same_candidate_attempts
                    and _is_retryable_image_generation_error(last_candidate_error or RuntimeError("unknown error"))
                )
                if should_retry_same_candidate:
                    await _update_visual_task(
                        task_id,
                        status=TaskStatus.RUNNING,
                        progress=38 if candidate_index == 1 else 42,
                        message=f"{candidate['label']} 本次请求较慢，正在自动重试",
                        metadata=_merge_tuzi_task_metadata(
                            (task_manager.get_task(task_id) or {}).get("metadata"),
                            stage="retrying",
                            active_provider=candidate["label"],
                            fallback_used=candidate_index > 1,
                            last_error=str(last_candidate_error),
                            retry_count=attempt_index,
                            retry_stage="retrying_same_model",
                        ),
                    )
                    continue
                break

            if candidate_succeeded:
                _clear_model_candidate_cooldown(candidate, kind="image")
                break

            if candidate_index < len(candidates):
                if _is_retryable_image_generation_error(last_candidate_error or RuntimeError("unknown error")):
                    _mark_model_candidate_unhealthy(
                        candidate,
                        kind="image",
                        reason=str(classify_model_gateway_error(last_candidate_error or RuntimeError("unknown error")).get("kind") or "retryable_error"),
                    )
                await _update_visual_task(
                    task_id,
                    status=TaskStatus.RUNNING,
                    progress=40,
                    message=f"{candidate['label']} 暂不可用，正在切换备用后端",
                    metadata=_merge_tuzi_task_metadata(
                        (task_manager.get_task(task_id) or {}).get("metadata"),
                        stage="retrying",
                        active_provider=candidate["label"],
                        fallback_used=True,
                        last_error=str(last_candidate_error) if last_candidate_error else None,
                        retry_count=max_same_candidate_attempts - 1,
                    ),
                )
                continue

            raise RuntimeError(" | ".join(errors))

        if image_paths:
            image_urls = [f"/static/images/{Path(p).name}" for p in image_paths]
            await _update_visual_task(
                task_id,
                status=TaskStatus.COMPLETED,
                progress=100,
                message="图片生成完成",
                result={
                    "success": True,
                    "images": image_urls,
                    "paths": image_paths
                },
                metadata=_merge_tuzi_task_metadata(
                    task_manager.get_task(task_id).get("metadata") if task_manager.get_task(task_id) else {},
                    provider=selected_candidate["provider"] if selected_candidate else None,
                    model=selected_candidate["model"] if selected_candidate else None,
                    prompt=prompt,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                    retryable=False,
                    task_kind="image",
                    stage="completed",
                    active_provider=selected_candidate["label"] if selected_candidate else None,
                    fallback_used=bool(selected_candidate and selected_candidate != candidates[0]),
                    retry_count=((task_manager.get_task(task_id) or {}).get("metadata") or {}).get("retry_count", 0),
                    generation_request_timeout_seconds=request_timeout_seconds,
                    external_status="completed" if selected_candidate and selected_candidate["provider"] == "tuzi" and "preview-async" in (selected_candidate["model"] or "").lower() else None,
                    external_progress=100 if selected_candidate and selected_candidate["provider"] == "tuzi" and "preview-async" in (selected_candidate["model"] or "").lower() else None,
                ),
            )
        else:
            current_task = task_manager.get_task(task_id) or {}
            current_metadata = current_task.get("metadata") or {}
            if current_task.get("status") == TaskStatus.RUNNING.value and current_metadata.get("external_task_id"):
                await _update_visual_task(
                    task_id,
                    status=TaskStatus.RUNNING,
                    progress=max(current_task.get("progress") or 0, 35),
                    message=current_task.get("message") or "图片任务仍在云端生成，可继续等待或稍后查看",
                    metadata=_merge_tuzi_task_metadata(current_metadata, retryable=True),
                )
            else:
                await _update_visual_task(
                    task_id,
                    status=TaskStatus.FAILED,
                    message="图片生成失败",
                    error="未生成任何图片",
                metadata=_merge_tuzi_task_metadata(
                    current_metadata,
                    provider=provider,
                    model=model,
                    prompt=prompt,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                    task_kind="image",
                    stage="failed",
                    retry_count=current_metadata.get("retry_count", 0),
                    generation_request_timeout_seconds=request_timeout_seconds,
                ),
            )
        
    except Exception as e:
        logger.error(f"图片生成任务失败: {e}", exc_info=True)
        current_task = task_manager.get_task(task_id) or {}
        current_metadata = current_task.get("metadata") or {}
        error_text = str(e)
        if "队列持续繁忙" in error_text or "2400013" in error_text:
            await _update_visual_task(
                task_id,
                status=TaskStatus.FAILED,
                progress=100,
                message="图片生成失败",
                error=f"Tuzi 远端队列繁忙，自动重试后仍无法提交: {error_text}",
                metadata=_merge_tuzi_task_metadata(
                    current_metadata,
                    retryable=False,
                    retry_stage="queue_full_exhausted",
                    last_remote_error_code=current_metadata.get("last_remote_error_code") or "2400013",
                    external_status=current_metadata.get("external_status") or "failed",
                ),
            )
            return
        if current_metadata.get("external_task_id"):
            await _update_visual_task(
                task_id,
                status=TaskStatus.RUNNING,
                progress=max(current_task.get("progress") or 0, 35),
                message="图片任务仍在云端生成，可继续等待或稍后查看",
                metadata=_merge_tuzi_task_metadata(current_metadata, retryable=True, last_error=str(e)),
            )
            return
        await _update_visual_task(
            task_id,
            status=TaskStatus.FAILED,
            progress=100,
            message="图片生成失败",
            error=_user_facing_model_error_message(e, "图片生成失败，请稍后重试。"),
            metadata=_merge_tuzi_task_metadata(
                current_metadata,
                stage="failed",
                retryable=False,
                last_error=str(e),
                error_kind=classify_model_gateway_error(e).get("kind"),
            ),
        )


async def run_workflow_generate_tasks(
    task_specs: List[Dict[str, Any]],
    concurrency_limit: int,
    stagger_seconds: float = DEFAULT_WORKFLOW_STAGGER_SECONDS,
) -> None:
    total = len(task_specs)
    for index, task_spec in enumerate(task_specs, start=1):
        task_id = task_spec["task_id"]
        current_task = task_manager.get_task(task_id) or {}
        await _update_visual_task(
            task_id,
            status=TaskStatus.PENDING,
            progress=0,
            message=f"等待开始生成 ({index}/{total})",
            metadata=_merge_tuzi_task_metadata(
                current_task.get("metadata"),
                workflow_index=index,
                workflow_total=total,
                retry_stage="workflow_pending",
                stage="pending",
            ),
        )
    semaphore = asyncio.Semaphore(max(1, concurrency_limit))

    async def _run_one(index: int, task_spec: Dict[str, Any]) -> None:
        task_id = task_spec["task_id"]
        if _is_visual_task_cancelled(task_id):
            return
        if stagger_seconds > 0 and index > 1:
            queued_task = task_manager.get_task(task_id) or {}
            delay_seconds = round(stagger_seconds * (index - 1), 1)
            await _update_visual_task(
                task_id,
                status=TaskStatus.PENDING,
                progress=2,
                message=f"等待错峰启动，预计 {delay_seconds:.1f} 秒后提交",
                metadata=_merge_tuzi_task_metadata(
                    queued_task.get("metadata"),
                    workflow_index=index,
                    workflow_total=total,
                    retry_stage="stagger_wait",
                    stage="pending",
                    stagger_delay_seconds=delay_seconds,
                ),
            )
            await asyncio.sleep(stagger_seconds * (index - 1))
            if _is_visual_task_cancelled(task_id):
                return
        async with semaphore:
            if _is_visual_task_cancelled(task_id):
                return
            current_task = task_manager.get_task(task_id) or {}
            await _update_visual_task(
                task_id,
                status=TaskStatus.RUNNING,
                progress=5,
                message=f"正在生成第 {index}/{total} 张图片",
                metadata=_merge_tuzi_task_metadata(
                    current_task.get("metadata"),
                    workflow_index=index,
                    workflow_total=total,
                    retry_stage="generating",
                    stage="generating",
                ),
            )
            await run_generate_task(
                task_id,
                task_spec["prompt"],
                1,
                task_spec["aspect_ratio"],
                task_spec["image_size"],
            )

    await asyncio.gather(*[
        _run_one(index, task_spec)
        for index, task_spec in enumerate(task_specs, start=1)
    ])


async def run_material_fusion_edit_tasks(
    task_specs: List[Dict[str, Any]],
    stagger_seconds: float = MATERIAL_FUSION_EDIT_STAGGER_SECONDS,
) -> None:
    total = len(task_specs)
    for index, task_spec in enumerate(task_specs, start=1):
        task_id = task_spec["task_id"]
        current_task = task_manager.get_task(task_id) or {}
        await _update_visual_task(
            task_id,
            status=TaskStatus.PENDING,
            progress=0,
            message=f"等待提交物料融合 ({index}/{total})",
            metadata=_merge_tuzi_task_metadata(
                current_task.get("metadata"),
                workflow_index=index,
                workflow_total=total,
                retry_stage="material_fusion_pending",
                stage="pending",
            ),
        )

    semaphore = asyncio.Semaphore(max(1, MATERIAL_FUSION_EDIT_CONCURRENCY))

    async def _run_one(index: int, task_spec: Dict[str, Any]) -> None:
        task_id = task_spec["task_id"]
        if _is_visual_task_cancelled(task_id):
            return
        if stagger_seconds > 0 and index > 1:
            delay_seconds = round(stagger_seconds * (index - 1), 1)
            queued_task = task_manager.get_task(task_id) or {}
            await _update_visual_task(
                task_id,
                status=TaskStatus.PENDING,
                progress=2,
                message=f"等待物料融合错峰启动，预计 {delay_seconds:.1f} 秒后开始",
                metadata=_merge_tuzi_task_metadata(
                    queued_task.get("metadata"),
                    workflow_index=index,
                    workflow_total=total,
                    retry_stage="material_fusion_stagger_wait",
                    stage="pending",
                    stagger_delay_seconds=delay_seconds,
                ),
            )
            await asyncio.sleep(stagger_seconds * (index - 1))
            if _is_visual_task_cancelled(task_id):
                return
        async with semaphore:
            await run_edit_task(
                task_id,
                task_spec["source_asset_id"],
                task_spec["prompt"],
                task_spec["aspect_ratio"],
                task_spec["image_size"],
                task_spec.get("user_id"),
                task_spec.get("reference_asset_ids"),
            )

    await asyncio.gather(*[
        _run_one(index, task_spec)
        for index, task_spec in enumerate(task_specs, start=1)
    ])


@router.get("/assets")
async def get_reference_assets(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ReferenceAsset

        _ensure_reference_asset_schema(db)
        assets = db.query(ReferenceAsset).filter(
            ReferenceAsset.user_id == user_id
        ).order_by(ReferenceAsset.created_at.desc()).all()

        return {
            "success": True,
            "data": [_reference_asset_to_response(asset) for asset in assets]
        }
    except Exception as error:
        logger.error(f"获取素材库失败: {error}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(error))


@router.post("/assets")
async def upload_reference_asset(
    file: UploadFile = File(...),
    source: str = Form("project_library"),
    display_name: str = Form(""),
    note: str = Form(""),
    tags: str = Form(""),
    ai_hint: str = Form(""),
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ReferenceAsset

        _ensure_reference_asset_schema(db)

        allowed_types = {"image/png", "image/jpeg", "image/webp"}
        if file.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail="仅支持 PNG、JPG、WEBP 图片")

        uploads_root = _get_reference_uploads_root()
        user_dir = uploads_root / user_id
        user_dir.mkdir(parents=True, exist_ok=True)

        suffix = Path(file.filename or "").suffix.lower() or ".png"
        asset_id = str(uuid.uuid4())
        stored_name = f"{asset_id}{suffix}"
        destination = user_dir / stored_name
        normalized_source = source if source in {"project_library", "chat_attachment", "scraper_reference"} else "project_library"
        normalized_tags = _normalize_asset_tags(tags)

        with destination.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        size = destination.stat().st_size
        width = None
        height = None
        try:
            with Image.open(destination) as image:
                width, height = image.size
        except Exception as image_error:
            logger.warning("读取素材尺寸失败: %s", image_error)

        asset = ReferenceAsset(
            asset_id=asset_id,
            user_id=user_id,
            file_name=stored_name,
            original_name=file.filename or stored_name,
            relative_path=f"{user_id}/{stored_name}",
            mime_type=file.content_type,
            size=size,
            width=width,
            height=height,
            source=normalized_source,
            display_name=(display_name or file.filename or stored_name)[:256],
            note=(note or "")[:1000],
            tags=json.dumps(normalized_tags, ensure_ascii=False),
            ai_hint=(ai_hint or "")[:1000],
        )
        db.add(asset)
        db.commit()

        return {"success": True, "data": _reference_asset_to_response(asset)}
    except HTTPException:
        raise
    except Exception as error:
        logger.error(f"上传素材失败: {error}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(error))


class UpdateReferenceAssetRequest(BaseModel):
    display_name: Optional[str] = None
    note: Optional[str] = None
    tags: Optional[List[str]] = None
    ai_hint: Optional[str] = None
    source: Optional[str] = None


class OrganizeReferenceAssetsRequest(BaseModel):
    asset_ids: Optional[List[str]] = None
    product_brief: Optional[Dict[str, Any]] = None


MATERIAL_ASSET_KEYWORD_GROUPS: List[Dict[str, Any]] = [
    {"tag": "渠道活码", "aliases": ["渠道活码", "活码", "渠道码", "二维码活码", "员工活码", "客户活码"]},
    {"tag": "客户管理", "aliases": ["客户管理", "客户列表", "客户画像", "客户资料", "用户管理"]},
    {"tag": "销售订单", "aliases": ["销售订单", "订单管理", "订单后台", "订单页面", "销售单", "成交订单", "订单"]},
    {"tag": "数据看板", "aliases": ["数据看板", "数据分析", "统计报表", "看板", "报表"]},
    {"tag": "一键导入", "aliases": ["一键导入", "内容导入", "素材导入", "导入素材", "导入内容", "导入页", "导入功能", "文章导入", "公众号导入", "飞书导入", "notion导入", "本地上传", "复制粘贴"]},
    {"tag": "AI写作", "aliases": ["AI写作", "AI辅助写作", "AI辅助", "AI整理表达", "AI整理", "写作工具栏", "智能写作", "标题开头", "提重点", "文案整理", "理顺标题", "补开头"]},
    {"tag": "智能排版", "aliases": ["智能排版", "AI排版", "自动排版", "一键排版", "排版成稿", "智能成稿", "正文结构", "结构识别"]},
    {"tag": "自动分页", "aliases": ["自动分页", "模板分页", "分页成稿", "分页排版", "分页页", "分页功能", "卡片分页", "分页", "分镜", "多页"]},
    {"tag": "模板", "aliases": ["模板", "模板库", "套模板", "版式模板", "风格模板", "模板套用", "套用模板"]},
    {"tag": "违规检测", "aliases": ["违规检测", "风险检测", "风险检查", "发前检查", "发布检查", "发布前检测", "发布前检查", "检测页", "检查页", "敏感词", "敏感词检测", "小红书检测"]},
    {"tag": "SOP", "aliases": ["sop", "SOP", "标准作业", "自动化SOP", "跟进SOP", "SOP流程"]},
    {"tag": "群发", "aliases": ["群发", "群发助手", "消息群发", "批量触达", "触达"]},
    {"tag": "任务宝", "aliases": ["任务宝", "裂变", "拉新", "邀请", "助力"]},
    {"tag": "企业微信", "aliases": ["企业微信", "企微", "微信", "私域"]},
    {"tag": "销售管理", "aliases": ["销售管理", "销售线索", "线索管理", "商机", "转化", "跟进"]},
    {"tag": "后台页面", "aliases": ["后台页面", "后台", "管理后台", "管理页面", "系统页面"]},
]


def _extract_material_asset_detail_tags(text_value: str) -> List[str]:
    lowered = str(text_value or "").lower()
    tags: List[str] = []
    for group in MATERIAL_ASSET_KEYWORD_GROUPS:
        aliases = group.get("aliases") or []
        if any(str(alias).lower() in lowered for alias in aliases):
            tag = str(group.get("tag") or "").strip()
            if tag and tag not in tags:
                tags.append(tag)
    if "自动分页" in tags and "模板" in tags:
        tags = [tag for tag in tags if tag != "模板"]
    return tags


def _augment_material_asset_tags_from_text(tags: List[str], *text_values: Any) -> List[str]:
    detail_tags: List[str] = []
    for value in text_values:
        detail_tags = _merge_unique_tags(detail_tags, _extract_material_asset_detail_tags(str(value or "")))
    return _merge_unique_tags(tags, detail_tags)


def _merge_unique_tags(*tag_groups: List[str]) -> List[str]:
    merged: List[str] = []
    for group in tag_groups:
        for tag in group:
            clean_tag = str(tag or "").strip()
            if clean_tag and clean_tag not in merged:
                merged.append(clean_tag)
    return merged


def _build_reference_asset_image_data_url(asset_payload: Dict[str, Any]) -> Optional[str]:
    relative_path = str(asset_payload.get("relative_path") or "").strip()
    if not relative_path:
        return None
    image_path = _get_reference_uploads_root() / relative_path
    if not image_path.exists() or not image_path.is_file():
        return None
    try:
        with Image.open(image_path) as image:
            image = image.convert("RGB")
            image.thumbnail((900, 900))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=82, optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    except Exception as error:
        logger.warning("素材识图图片编码失败 asset_id=%s error=%s", asset_payload.get("id"), error)
        return None


def _organize_reference_assets_with_vision(asset_payloads: List[Dict[str, Any]], product_brief: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    vision_payloads: List[Dict[str, Any]] = []
    content_blocks: List[Dict[str, Any]] = [{
        "type": "text",
        "text": (
            "你是小红书营销素材库的视觉识别和标签整理助手。请逐张看图，并结合文件名、备注、旧标签、产品信息，输出素材名称、标签、ai_hint。\n"
            "重点识别：是否 Logo、是否产品/后台页面截图、页面里具体业务模块、可见文字、表格/看板/订单/客户/活码/导入/AI写作/排版/分页/模板/违规检测/SOP/群发/任务宝等功能区域。\n"
            "标签要求：一级用途标签从 logo、产品页、功能截图、品牌风格、竞品参考、其他素材 中选 1-2 个；二级标签必须具体，并优先使用这些标准功能标签：一键导入、AI写作、智能排版、自动分页、模板、违规检测、销售订单、订单管理、后台页面、客户管理、渠道活码、数据看板、SOP、群发、任务宝、首页、登录页。\n"
            "同义词归一要求：一键排版/自动排版/排版成稿 标为 智能排版；模板分页/分页成稿/分页页 标为 自动分页；发前检查/风险检测/敏感词检测/发布检查 标为 违规检测；AI整理表达/写作工具栏 标为 AI写作；素材导入/内容导入/文章导入/导入页 标为 一键导入。\n"
            "不要只写“功能截图”这种泛标签；如果是后台页面，必须写出具体模块。Logo 只有在画面主体确实是品牌标识时才标 logo。\n"
            "ai_hint 用一句中文说明这张图是什么、适合匹配哪类笔记卡片、使用限制。返回 JSON object：{\"items\":[{\"id\":\"...\",\"display_name\":\"...\",\"tags\":[\"...\"],\"ai_hint\":\"...\"}]}。\n"
            f"产品信息：{json.dumps(product_brief or {}, ensure_ascii=False)[:1200]}"
        ),
    }]
    for item in asset_payloads[:12]:
        if not isinstance(item, dict):
            continue
        image_data_url = _build_reference_asset_image_data_url(item)
        if not image_data_url:
            continue
        meta = {
            "id": item.get("id"),
            "original_name": item.get("original_name"),
            "display_name": item.get("display_name"),
            "tags": item.get("tags") or [],
            "note": item.get("note") or "",
            "ai_hint": item.get("ai_hint") or "",
            "width": item.get("width"),
            "height": item.get("height"),
        }
        vision_payloads.append(meta)
        content_blocks.append({
            "type": "text",
            "text": f"\n素材 {len(vision_payloads)} 元数据：{json.dumps(meta, ensure_ascii=False)}",
        })
        content_blocks.append({
            "type": "image_url",
            "image_url": {"url": image_data_url},
        })

    if not vision_payloads:
        return []

    messages = [
        {
            "role": "system",
            "content": "你只能返回合法 JSON，不要输出 Markdown。请准确识别图片内容，避免泛泛标签。",
        },
        {
            "role": "user",
            "content": content_blocks,
        },
    ]
    response = _run_text_completion_with_fallback(messages, temperature=0.1, max_tokens=2400)
    content = response.choices[0].message.content or "{}"
    parsed = clean_and_parse_ai_json(content)
    items = parsed.get("items") if isinstance(parsed, dict) else parsed
    return [item for item in (items or []) if isinstance(item, dict)]


def _organize_reference_asset_with_ai(asset_payloads: List[Dict[str, Any]], product_brief: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not asset_payloads:
        return []
    product_context = json.dumps(product_brief or {}, ensure_ascii=False)[:1200]
    assets_context = json.dumps([
        {
            "id": item.get("id"),
            "original_name": item.get("original_name"),
            "display_name": item.get("display_name"),
            "tags": item.get("tags") or [],
            "note": item.get("note") or "",
            "ai_hint": item.get("ai_hint") or "",
            "width": item.get("width"),
            "height": item.get("height"),
        }
        for item in asset_payloads
    ], ensure_ascii=False)
    messages = [
        {
            "role": "system",
            "content": (
                "你是素材库标签整理助手。请根据素材文件名、现有标签、备注、产品信息，整理素材名称、标签和给 AI 的说明。"
                "不要看图，只能基于文本判断。用户备注优先级最高，文件名其次，旧标签最后。"
                "不要因为出现“参考”二字就判定为竞品；如果备注出现“不是竞品、非竞品、不要识别为竞品”等否定表达，必须移除竞品参考标签。"
                "只有明确包含竞品、竞对、对标、其他品牌、仅参考结构、不要直接使用等含义，才标记竞品参考。"
                "标签体系要帮用户管理素材：一级用途标签只能从 logo、产品页、功能截图、品牌风格、竞品参考、其他素材 中选 1-2 个；"
                "二级内容标签必须尽量具体，可从 首页、后台页面、一键导入、AI写作、智能排版、自动分页、模板、违规检测、数据看板、客户管理、销售订单、订单管理、渠道活码、SOP、群发、任务宝、价格页、案例页、登录页、全局素材 中选择或少量补充。"
                "同义词必须归一：一键排版/自动排版/排版成稿 标为 智能排版；模板分页/分页成稿/分页页 标为 自动分页；发前检查/风险检测/敏感词检测/发布检查 标为 违规检测；AI整理表达/写作工具栏 标为 AI写作；素材导入/内容导入/文章导入/导入页 标为 一键导入。"
                "如果文件名或备注包含“销售订单管理后台页面”，标签不能只写功能截图，必须包含“销售订单”或“订单管理”以及“后台页面”。"
                "ai_hint 必须用一句中文说明具体业务模块，例如“这是销售订单管理后台页面截图，适合讲订单管理/销售流程相关卡片”，不要写泛泛的功能截图。"
                "display_name 要短且可识别，优先保留用户备注里的业务含义，不要写泛泛的“参考图”。"
                "返回 JSON object，形如 {\"items\":[{\"id\":\"...\",\"display_name\":\"...\",\"tags\":[\"...\"],\"ai_hint\":\"...\"}]}。"
            ),
        },
        {
            "role": "user",
            "content": f"产品信息：{product_context}\n\n素材列表：{assets_context}",
        },
    ]
    try:
        response = _run_text_completion_with_fallback(messages, temperature=0.2, max_tokens=1800)
        content = response.choices[0].message.content or "{}"
        parsed = clean_and_parse_ai_json(content)
        items = parsed.get("items") if isinstance(parsed, dict) else parsed
        return [item for item in (items or []) if isinstance(item, dict)]
    except Exception as error:
        logger.warning("AI 整理素材失败，使用规则兜底: %s", error, exc_info=True)
        fallback: List[Dict[str, Any]] = []
        for item in asset_payloads:
            name = item.get("display_name") or item.get("original_name") or ""
            tags = _normalize_asset_tags(item.get("tags") or [])
            if not tags:
                lowered = str(name).lower()
                if "logo" in lowered:
                    tags = ["logo", "全局素材"]
                elif any(token in lowered for token in ["首页", "home"]):
                    tags = ["产品页", "首页"]
                elif any(token in lowered for token in ["后台", "页面", "截图", "看板", "活码"]):
                    tags = ["功能截图"]
            tags = _augment_material_asset_tags_from_text(
                tags,
                name,
                item.get("note"),
                item.get("ai_hint"),
                " ".join(str(tag) for tag in (item.get("tags") or [])),
            )
            hint = item.get("ai_hint") or item.get("note")
            if not hint:
                detail_label = "、".join(_extract_material_asset_detail_tags(" ".join([str(name), " ".join(tags)]))[:3])
                hint = f"这是素材：{name}。{f'识别到业务模块：{detail_label}。' if detail_label else ''}请结合标签理解用途，不要误判为竞品素材。"
            fallback.append({
                "id": item.get("id"),
                "display_name": name,
                "tags": tags,
                "ai_hint": hint,
            })
        return fallback


def _sanitize_organized_asset_tags(
    raw_tags: Any,
    asset_payload: Dict[str, Any],
    organized_item: Optional[Dict[str, Any]] = None,
) -> List[str]:
    tags = _normalize_asset_tags(raw_tags or [])
    organized_item = organized_item or {}
    identity_text = " ".join([
        str(asset_payload.get("original_name") or ""),
        str(asset_payload.get("display_name") or ""),
        str(asset_payload.get("note") or ""),
        str(organized_item.get("display_name") or ""),
        str(organized_item.get("note") or ""),
    ]).lower()
    source_text = " ".join([
        identity_text,
        str(asset_payload.get("ai_hint") or ""),
        " ".join(str(tag) for tag in (asset_payload.get("tags") or [])),
        str(organized_item.get("ai_hint") or ""),
        " ".join(str(tag) for tag in (organized_item.get("tags") or [])),
    ]).lower()
    explicit_logo = any(token in identity_text for token in [
        "logo",
        "纯logo",
        "产品logo",
        "品牌标识",
        "品牌logo",
        "logo图",
        "logo素材",
        "蓝底logo",
        "白底logo",
        "标志",
        "商标",
        "brand mark",
        "brandmark",
        "logotype",
    ])
    looks_like_ui_page = any(token in identity_text for token in [
        "功能",
        "客户",
        "数据",
        "分析",
        "看板",
        "后台",
        "设置",
        "列表",
        "详情",
        "页面",
        "界面",
        "截图",
        "活码",
        "导入",
        "写作",
        "排版",
        "分页",
        "模板",
        "违规",
        "检测",
        "检查",
        "敏感词",
        "水印",
        "群发",
        "任务宝",
        "sop",
        "screen",
        "screenshot",
        "dashboard",
        "crm",
        "scrm",
    ])
    explicit_brand_style = any(token in source_text for token in [
        "品牌风格",
        "配色",
        "视觉风格",
        "brand style",
        "style guide",
    ])
    explicit_non_competitor = any(token in source_text for token in [
        "不是竞品",
        "非竞品",
        "不要识别为竞品",
        "别识别为竞品",
        "不是竞品图",
        "不是对标",
        "非对标",
        "not competitor",
        "not a competitor",
    ])
    explicit_competitor = any(token in source_text for token in [
        "竞品",
        "竞对",
        "对标",
        "其他品牌",
        "其他产品",
        "仅参考结构",
        "只参考结构",
        "不要直接使用",
        "不直接使用",
        "不可直接使用",
        "benchmark",
        "competitor",
    ])
    tags = _augment_material_asset_tags_from_text(tags, identity_text, source_text)
    detail_tags = _extract_material_asset_detail_tags(" ".join(tags))
    if detail_tags:
        detail_hint = f"识别到业务模块：{'、'.join(detail_tags[:4])}。"
        current_hint = str(organized_item.get("ai_hint") or asset_payload.get("ai_hint") or "")
        if current_hint and all(tag not in current_hint for tag in detail_tags):
            organized_item["ai_hint"] = f"{detail_hint}{current_hint}"

    if looks_like_ui_page and not explicit_logo:
        tags = [tag for tag in tags if tag not in {"logo", "品牌风格", "全局素材"}]
        if "功能截图" not in tags:
            tags = ["功能截图", *tags]
    elif explicit_logo:
        tags = [tag for tag in tags if tag not in {"功能截图", "产品页", "竞品参考", "仅参考结构"}]
        tags = ["logo", *[tag for tag in tags if tag != "logo"]]
        if "全局素材" not in tags:
            tags.append("全局素材")
    elif explicit_brand_style:
        tags = [tag for tag in tags if tag not in {"功能截图", "竞品参考", "仅参考结构"}]
        tags = ["品牌风格", *[tag for tag in tags if tag != "品牌风格"]]
        if "全局素材" not in tags:
            tags.append("全局素材")

    if explicit_non_competitor:
        tags = [tag for tag in tags if tag not in {"竞品参考", "仅参考结构"}]
    elif "竞品参考" in tags and not explicit_competitor:
        tags = [tag for tag in tags if tag not in {"竞品参考", "仅参考结构"}]
    return _merge_unique_tags(tags, detail_tags)


@router.patch("/assets/{asset_id}")
async def update_reference_asset(
    asset_id: str,
    request: UpdateReferenceAssetRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ReferenceAsset

        _ensure_reference_asset_schema(db)
        asset = db.query(ReferenceAsset).filter(
            ReferenceAsset.asset_id == asset_id,
            ReferenceAsset.user_id == user_id,
        ).first()
        if not asset:
            raise HTTPException(status_code=404, detail="素材不存在")

        if request.display_name is not None:
            asset.display_name = request.display_name.strip()[:256] or asset.original_name
        if request.note is not None:
            asset.note = request.note.strip()[:1000]
        if request.tags is not None:
            asset.tags = json.dumps(_normalize_asset_tags(request.tags), ensure_ascii=False)
        if request.ai_hint is not None:
            asset.ai_hint = request.ai_hint.strip()[:1000]
        if request.source in {"project_library", "chat_attachment", "scraper_reference"}:
            asset.source = request.source
        db.commit()
        db.refresh(asset)
        return {"success": True, "data": _reference_asset_to_response(asset)}
    except HTTPException:
        raise
    except Exception as error:
        logger.error(f"更新素材失败: {error}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(error))


@router.post("/assets/organize")
async def organize_reference_assets(
    request: OrganizeReferenceAssetsRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    try:
        from backend.database.models import ReferenceAsset

        _ensure_reference_asset_schema(db)
        query = db.query(ReferenceAsset).filter(ReferenceAsset.user_id == user_id)
        requested_ids = [str(item).strip() for item in (request.asset_ids or []) if str(item).strip()]
        if requested_ids:
            query = query.filter(ReferenceAsset.asset_id.in_(requested_ids))
        assets = query.order_by(ReferenceAsset.created_at.desc()).limit(50).all()
        payloads = [_reference_asset_to_internal_payload(asset) for asset in assets]
        try:
            organized_items = _organize_reference_assets_with_vision(payloads, request.product_brief)
        except Exception as vision_error:
            logger.warning("视觉整理素材失败，回退到文本整理: %s", vision_error, exc_info=True)
            organized_items = []
        organized_by_id = {
            str(item.get("id") or "").strip(): item
            for item in organized_items
            if str(item.get("id") or "").strip()
        }
        missing_payloads = [
            payload
            for payload in payloads
            if str(payload.get("id") or "").strip() not in organized_by_id
        ]
        if missing_payloads:
            text_items = _organize_reference_asset_with_ai(missing_payloads, request.product_brief)
            organized_items = [*organized_items, *text_items]
        organized_by_id = {
            str(item.get("id") or "").strip(): item
            for item in organized_items
            if str(item.get("id") or "").strip()
        }
        updated_assets = []
        payload_by_id = {str(item.get("id") or "").strip(): item for item in payloads}
        for asset in assets:
            item = organized_by_id.get(asset.asset_id)
            if not item:
                continue
            display_name = str(item.get("display_name") or "").strip()
            tags = _sanitize_organized_asset_tags(item.get("tags") or [], payload_by_id.get(asset.asset_id) or {}, item)
            ai_hint = str(item.get("ai_hint") or "").strip()
            if display_name:
                asset.display_name = display_name[:256]
            if tags:
                asset.tags = json.dumps(tags, ensure_ascii=False)
            if ai_hint:
                asset.ai_hint = ai_hint[:1000]
            updated_assets.append(asset)
        db.commit()
        for asset in updated_assets:
            db.refresh(asset)
        return {
            "success": True,
            "message": f"已识图整理 {len(updated_assets)} 张素材",
            "data": [_reference_asset_to_response(asset) for asset in assets],
            "updated_count": len(updated_assets),
        }
    except Exception as error:
        logger.error("AI 整理素材失败: %s", error, exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(error))


@router.delete("/assets/{asset_id}")
async def delete_reference_asset(
    asset_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ReferenceAsset

        _ensure_reference_asset_schema(db)
        asset = db.query(ReferenceAsset).filter(
            ReferenceAsset.user_id == user_id,
            ReferenceAsset.asset_id == asset_id
        ).first()

        if not asset:
            raise HTTPException(status_code=404, detail="素材不存在")

        file_path = _get_reference_uploads_root() / asset.relative_path
        if file_path.exists():
            file_path.unlink()

        db.delete(asset)
        db.commit()

        return {"success": True}
    except HTTPException:
        raise
    except Exception as error:
        logger.error(f"删除素材失败: {error}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(error))


@router.post("/compose-template", response_model=ComposeTemplateResponse)
async def compose_template(request: ComposeTemplateRequest):
    try:
        payload = compose_template_payload(
            title=request.title,
            content=request.content,
            product_brief=request.product_brief,
            reference_assets=request.reference_assets,
            primary_reference_asset_id=request.primary_reference_asset_id,
            template_kind=request.template_kind,
            brand_style=request.brand_style,
            note_visual_plan=request.note_visual_plan,
        )
        return ComposeTemplateResponse(
            success=True,
            message="模板拼装完成",
            data=payload,
        )
    except Exception as error:
        logger.error("模板拼装失败: %s", error, exc_info=True)
        raise HTTPException(status_code=500, detail=str(error))


@router.post("/compose-template-series", response_model=ComposeTemplateResponse)
async def compose_template_series(request: ComposeTemplateSeriesRequest):
    try:
        payload = compose_template_series_payload(
            title=request.title,
            content=request.content,
            product_brief=request.product_brief,
            reference_assets=request.reference_assets,
            primary_reference_asset_id=request.primary_reference_asset_id,
            brand_style=request.brand_style,
            note_visual_plan=request.note_visual_plan,
            card_count_limit=request.card_count_limit,
        )
        return ComposeTemplateResponse(
            success=True,
            message="组图模板拼装完成",
            data=payload,
        )
    except Exception as error:
        logger.error("组图模板拼装失败: %s", error, exc_info=True)
        raise HTTPException(status_code=500, detail=str(error))


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_content(request: AnalyzeRequest):
    try:
        logger.info(f"收到分析请求: {request.title}")
        if _normalize_visual_mode(request.mode) == "template_compose":
            composed = compose_template_payload(
                title=request.title,
                content=request.content,
                product_brief=request.product_brief,
                reference_assets=request.reference_assets,
                primary_reference_asset_id=request.primary_reference_asset_id,
                template_kind=request.template_kind,
                brand_style=request.style,
            )
            recommended = composed.get("recommended_template_kinds") or []
            prompts = [
                {
                    "id": index + 1,
                    "type": "Template",
                    "title": kind,
                    "variant_key": kind,
                    "layout_family": "template_compose",
                    "visual_focus": "截图保真 + 模板拼装",
                    "prompt": f"模板方案：{kind}",
                }
                for index, kind in enumerate(recommended[:3])
            ]
            return AnalyzeResponse(
                success=True,
                message="模板方案分析完成",
                prompts=prompts,
                data=composed,
            )
        from openai import OpenAI
        
        api_key, base_url = resolve_text_generation_config()
        
        client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=VISUAL_PROMPT_TIMEOUT_SECONDS,
            default_headers={"Accept-Encoding": "identity"},
        )

        system_prompt, user_message, prompt_strategy = _build_visual_messages(
            title=request.title,
            content=request.content,
            style=request.style,
            mode=request.mode,
            material_summary=request.material_summary,
            reference_summary=request.reference_summary,
            reference_assets=request.reference_assets,
            primary_reference_asset_id=request.primary_reference_asset_id,
            dynamic_style_params=request.dynamic_style_params,
            product_brief=request.product_brief,
        )
        logger.info(
            "提示词生成输入已就绪, strategy=%s, title_len=%s, content_len=%s, clipped_content_len=%s, timeout=%ss",
            prompt_strategy,
            len(request.title or ""),
            len(request.content or ""),
            len(_clip_text(request.content, VISUAL_PROMPT_MAX_CONTENT_CHARS)),
            VISUAL_PROMPT_TIMEOUT_SECONDS,
        )
        
        prompts, used_model, prompt_stats = await _run_visual_prompt_generation_with_timeout(
            client=client,
            system_prompt=system_prompt,
            user_message=user_message,
            primary_model=settings.PROMPT_GEN_MODEL,
            text_fallback_model=settings.TEXT_GEN_MODEL,
            prompt_strategy=prompt_strategy,
        )
        if prompt_strategy in IMAGE2_QUALITY_MODES:
            from backend.services.image2_prompt_engine import apply_image2_dynamic_intent_guardrails
            prompts = apply_image2_dynamic_intent_guardrails(
                prompts,
                _sanitize_image2_dynamic_style_params(request.dynamic_style_params, prompt_strategy),
            )
        logger.info(
            "[WORKFLOW] AI API 调用成功, used_model=%s, strategy=%s, raw=%s, normalized=%s, dropped=%s",
            used_model,
            prompt_strategy,
            prompt_stats["raw_prompt_count"],
            prompt_stats["normalized_prompt_count"],
            prompt_stats["dropped_prompt_items"],
        )
        
        return AnalyzeResponse(
            success=True,
            message="分析完成",
            prompts=prompts,
            data={
                "prompt_model": used_model,
                "prompt_stats": prompt_stats,
                "design_plan": prompt_stats.get("design_plan"),
                "recommended_image_count": prompt_stats.get("recommended_image_count"),
            },
        )
        
    except Exception as e:
        logger.error(f"分析内容失败: {e}", exc_info=True)
        _raise_visual_http_error(e)


@router.get("/prompt-logs")
async def get_image_prompt_logs(
    limit: int = Query(default=50, ge=1, le=200),
    prompt_strategy: Optional[str] = Query(default=None),
    title_keyword: Optional[str] = Query(default=None),
    user_id: str = Depends(get_current_user_id),
):
    try:
        rows = list_image_prompt_logs(
            user_id=user_id,
            limit=limit,
            prompt_strategy=prompt_strategy,
            title_keyword=title_keyword,
        )
        return {
            "success": True,
            "message": "提示词日志查询成功",
            "count": len(rows),
            "items": [_format_prompt_log_row(row) for row in rows],
        }
    except Exception as error:
        logger.error("查询提示词日志失败: %s", error, exc_info=True)
        raise HTTPException(status_code=500, detail=str(error))


@router.post("/generate", response_model=GenerateImageResponse)
async def generate_image(
    request: GenerateImageRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
):
    try:
        visual_mode_resolved = _normalize_visual_mode(request.mode) if request.mode else None
        logger.info(
            "收到生图请求: requested_mode=%s, visual_mode_resolved=%s, prompt_preview=%s",
            request.mode,
            visual_mode_resolved,
            request.prompt[:50],
        )
        ensure_image_task_schema()
        
        # We need to resolve the correct model for the response, although run_generate_task resolves it again
        candidates = _resolve_image_generation_candidates(mode=visual_mode_resolved)
        primary_candidate = candidates[0]
        provider = primary_candidate["provider"]
        model = primary_candidate["model"]
        
        sync_timeout_seconds = _resolve_sync_image_task_timeout_seconds(provider, model, mode=visual_mode_resolved)
        task_id = task_manager.create_task(f"生成图片", metadata={
            "user_id": user_id,
            "provider": provider,
            "model": model,
            "prompt": request.prompt,
            "aspect_ratio": request.aspect_ratio,
            "image_size": request.image_size,
            "retryable": provider == "tuzi" and "preview-async" in (model or "").lower(),
            "task_kind": "image",
            "stage": "pending",
            "sync_timeout_seconds": sync_timeout_seconds,
            "generation_request_timeout_seconds": IMAGE2_DYNAMIC_IMAGE_REQUEST_TIMEOUT_SECONDS if visual_mode_resolved in IMAGE2_QUALITY_MODES else IMAGE_REQUEST_TIMEOUT_SECONDS,
            "visual_mode_resolved": visual_mode_resolved,
        })
        _save_runtime_task(task_id)
        save_image_prompt_log({
            "task_id": task_id,
            "user_id": user_id,
            "title": "直接生图",
            "content_excerpt": "",
            "visual_mode": request.mode,
            "prompt_strategy": visual_mode_resolved,
            "prompt_model": None,
            "image_provider": provider,
            "image_model": model,
            "workflow_index": 1,
            "workflow_total": 1,
            "prompt_type": "Direct",
            "prompt_title": "直接生图",
            "role": "direct",
            "key_message": "",
            "prompt_text": request.prompt,
            "prompt_payload": {
                "id": 1,
                "type": "Direct",
                "title": "直接生图",
                "role": "direct",
                "prompt": request.prompt,
            },
            "design_plan": None,
            "prompt_stats": None,
            "product_brief": None,
            "dynamic_style_params": None,
            "material_summary": None,
            "reference_summary": None,
            "reference_asset_ids": [],
        })
        
        background_tasks.add_task(
            run_generate_task,
            task_id,
            request.prompt,
            request.count,
            request.aspect_ratio,
            request.image_size
        )
        
        return GenerateImageResponse(
            success=True,
            message="图片生成任务已创建，正在调用 Gemini",
            task_id=task_id,
            data={
                "prompt": request.prompt[:100],
                "count": request.count
            }
        )
        
    except Exception as e:
        logger.error(f"创建生图任务失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/workflow")
async def analyze_and_generate(
    request: WorkflowRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
):
    try:
        client_request_id = _normalize_client_request_id(request.client_request_id)
        workflow_signature = _build_workflow_signature(request)
        if client_request_id:
            existing_task_ids = _find_existing_workflow_tasks(user_id, client_request_id)
            if existing_task_ids:
                logger.warning(
                    "[WORKFLOW] 命中重复客户端请求，复用已有任务: user_id=%s client_request_id=%s task_count=%s",
                    user_id,
                    client_request_id,
                    len(existing_task_ids),
                )
                return {
                    "success": True,
                    "message": f"已复用同一请求的 {len(existing_task_ids)} 个生图任务",
                    "task_ids": existing_task_ids,
                    "requested_image_count": request.image_count,
                    "actual_submitted_count": len(existing_task_ids),
                    "prompts": request.prompts or [],
                    "visual_mode_resolved": _normalize_visual_mode(request.mode),
                    "reference_asset_ids": [],
                    "image_runner": get_image_job_runner_stats(),
                    "reused_client_request": True,
                }
        recent_duplicate_task_ids = _find_recent_duplicate_workflow_tasks(user_id, workflow_signature)
        if recent_duplicate_task_ids:
            logger.warning(
                "[WORKFLOW] 命中短时间重复工作流，复用已有任务: user_id=%s client_request_id=%s task_count=%s",
                user_id,
                client_request_id or "-",
                len(recent_duplicate_task_ids),
            )
            return {
                "success": True,
                "message": f"已复用刚刚创建的 {len(recent_duplicate_task_ids)} 个生图任务",
                "task_ids": recent_duplicate_task_ids,
                "requested_image_count": request.image_count,
                "actual_submitted_count": len(recent_duplicate_task_ids),
                "prompts": request.prompts or [],
                "visual_mode_resolved": _normalize_visual_mode(request.mode),
                "reference_asset_ids": [],
                "image_runner": get_image_job_runner_stats(),
                "reused_recent_workflow": True,
            }
        logger.info(
            "[WORKFLOW] 收到完整工作流请求: requested_mode=%s, resolved_mode=%s, title=%s, style=%s, image_count=%s, client_request_id=%s",
            request.mode,
            _normalize_visual_mode(request.mode),
            request.title,
            request.style,
            request.image_count,
            client_request_id or "-",
        )
        ensure_image_task_schema()

        prompt_strategy = _normalize_visual_mode(request.mode)
        used_model = "client_provided"
        prompt_stats: Dict[str, Any] = {"raw_prompt_count": 0, "normalized_prompt_count": 0, "dropped_prompt_items": 0}

        if request.prompts:
            prompts, prompt_stats = _normalize_visual_prompts(request.prompts)
            used_model = "reused_from_analyze"
            logger.info(
                "[WORKFLOW] 复用前一步提示词: strategy=%s, raw=%s, normalized=%s, dropped=%s",
                prompt_strategy,
                prompt_stats["raw_prompt_count"],
                prompt_stats["normalized_prompt_count"],
                prompt_stats["dropped_prompt_items"],
            )
            if not prompts:
                raise HTTPException(status_code=500, detail="前一步提示词无效，无法启动生图任务")
            if prompt_strategy in IMAGE2_QUALITY_MODES:
                from backend.services.image2_prompt_engine import apply_image2_dynamic_intent_guardrails
                prompts = apply_image2_dynamic_intent_guardrails(
                    prompts,
                    _sanitize_image2_dynamic_style_params(request.dynamic_style_params, prompt_strategy),
                )
        else:
            from openai import OpenAI

            api_key, base_url = resolve_text_generation_config()
            client = OpenAI(
                api_key=api_key,
                base_url=base_url,
                timeout=VISUAL_PROMPT_TIMEOUT_SECONDS,
                default_headers={"Accept-Encoding": "identity"},
            )

            system_prompt, user_message, resolved_prompt_strategy = _build_visual_messages(
                title=request.title,
                content=request.content,
                style=request.style,
                mode=request.mode,
                material_summary=request.material_summary,
                reference_summary=request.reference_summary,
                reference_assets=request.reference_assets,
                primary_reference_asset_id=request.primary_reference_asset_id,
                dynamic_style_params=request.dynamic_style_params,
                desired_image_count=request.image_count,
                product_brief=request.product_brief,
            )
            prompt_strategy = resolved_prompt_strategy
            logger.info(
                "[WORKFLOW] 提示词生成输入已就绪, strategy=%s, title_len=%s, content_len=%s, clipped_content_len=%s, timeout=%ss",
                prompt_strategy,
                len(request.title or ""),
                len(request.content or ""),
                len(_clip_text(request.content, VISUAL_PROMPT_MAX_CONTENT_CHARS)),
                VISUAL_PROMPT_TIMEOUT_SECONDS,
            )

            prompts, used_model, prompt_stats = await _run_visual_prompt_generation_with_timeout(
                client=client,
                system_prompt=system_prompt,
                user_message=user_message,
                primary_model=settings.PROMPT_GEN_MODEL,
                text_fallback_model=settings.TEXT_GEN_MODEL,
                prompt_strategy=prompt_strategy,
            )
            if prompt_strategy in IMAGE2_QUALITY_MODES:
                from backend.services.image2_prompt_engine import apply_image2_dynamic_intent_guardrails
                prompts = apply_image2_dynamic_intent_guardrails(
                    prompts,
                    _sanitize_image2_dynamic_style_params(request.dynamic_style_params, prompt_strategy),
                )
            logger.info(
                "成功解析 %s 个提示词, used_model=%s, strategy=%s, raw=%s, normalized=%s, dropped=%s",
                len(prompts),
                used_model,
                prompt_strategy,
                prompt_stats["raw_prompt_count"],
                prompt_stats["normalized_prompt_count"],
                prompt_stats["dropped_prompt_items"],
            )
        
        if not prompts:
            logger.error("[WORKFLOW] 未生成任何提示词")
            raise HTTPException(status_code=500, detail="未生成任何提示词")
        
        prompts = _apply_prompt_variants(prompts)
        effective_prompt_stats = request.prompt_stats or prompt_stats
        effective_design_plan = (
            request.design_plan
            or effective_prompt_stats.get("design_plan")
            or prompt_stats.get("design_plan")
        )
        material_plan_items = _resolve_material_fusion_plan_items(request.material_fusion_plan, prompts) if prompt_strategy == "material_fusion" else []
        actual_prompt_count = min(request.image_count, len(prompts))
        if prompt_strategy == "material_fusion":
            actual_prompt_count = len(material_plan_items) if material_plan_items else (1 if prompts else 0)
        if prompt_strategy == "template_compose":
            composed = compose_template_payload(
                title=request.title,
                content=request.content,
                product_brief=request.product_brief,
                reference_assets=request.reference_assets,
                primary_reference_asset_id=request.primary_reference_asset_id,
                template_kind=request.template_kind,
                brand_style=request.style,
            )
            return {
                "success": True,
                "message": "模板拼装已完成",
                "task_ids": [],
                "requested_image_count": request.image_count,
                "actual_submitted_count": 1,
                "prompts": prompts,
                "visual_mode_resolved": "template_compose",
                "reference_asset_ids": [
                    str(asset.get("id"))
                    for asset in (request.reference_assets or [])
                    if isinstance(asset, dict) and asset.get("id")
                ],
                "compose_result": composed,
            }

        primary_reference_asset, reference_asset_ids = _resolve_primary_reference_asset(
            request.reference_assets,
            request.primary_reference_asset_id,
        )
        if prompt_strategy == "material_fusion" and not primary_reference_asset:
            raise HTTPException(status_code=400, detail="素材融合模式必须选择主素材")

        if prompt_strategy == "material_fusion":
            prompt_data = prompts[0]
            asset_lookup = {
                str(asset.get("id")): asset
                for asset in (request.reference_assets or [])
                if isinstance(asset, dict) and asset.get("id")
            }
            plan_items = material_plan_items or [{
                "id": "single-primary",
                "index": 1,
                "title": prompt_data.get("title") or "主物料融合海报",
                "summary": prompt_data.get("rationale") or "",
                "primaryAssetId": primary_reference_asset.get("id"),
                "globalAssetIds": [],
            }]
            requested_material_count = max(1, min(int(request.image_count or 1), MATERIAL_FUSION_MAX_IMAGE_COUNT))
            if len(plan_items) > requested_material_count:
                logger.info(
                    "[WORKFLOW] 物料融合按请求限制提交数量: requested=%s, available=%s, submitted=%s",
                    request.image_count,
                    len(plan_items),
                    requested_material_count,
                )
                plan_items = plan_items[:requested_material_count]
            task_ids: List[str] = []
            returned_prompts: List[Dict[str, Any]] = []
            edit_source_asset_ids: List[str] = []
            edit_task_specs: List[Dict[str, Any]] = []
            rejected_material_items: List[str] = []
            for plan_index, plan_item in enumerate(plan_items, start=1):
                source_asset_id = str(plan_item.get("primaryAssetId") or primary_reference_asset.get("id") or "").strip()
                if not source_asset_id or source_asset_id not in asset_lookup:
                    logger.warning("[WORKFLOW] 跳过缺少主素材的物料融合项: index=%s, item=%s", plan_index, plan_item)
                    rejected_material_items.append(f"第 {plan_index} 张缺少主素材")
                    continue
                source_asset = asset_lookup.get(source_asset_id) or {}
                match_ok, match_reason = _validate_material_fusion_primary_match(plan_item, source_asset)
                if not match_ok:
                    logger.warning(
                        "[WORKFLOW] 跳过弱匹配物料融合项: index=%s, source_asset=%s, reason=%s, item=%s",
                        plan_index,
                        source_asset_id,
                        match_reason,
                        plan_item,
                    )
                    rejected_material_items.append(f"第 {plan_index} 张：{match_reason}")
                    continue
                per_item_reference_ids = [
                    source_asset_id,
                    *[str(item).strip() for item in (plan_item.get("globalAssetIds") or []) if str(item).strip()],
                ]
                per_item_reference_ids = [item for item in dict.fromkeys(per_item_reference_ids) if item in asset_lookup]
                explicit_global_reference_ids = [
                    str(item).strip()
                    for item in (plan_item.get("globalAssetIds") or [])
                    if (
                        str(item).strip()
                        and str(item).strip() != source_asset_id
                        and str(item).strip() in asset_lookup
                    )
                ]
                upload_logo_reference_ids = [
                    item
                    for item in explicit_global_reference_ids
                    if _asset_payload_is_logo(asset_lookup.get(item) or {})
                ][:1]
                if not upload_logo_reference_ids and explicit_global_reference_ids:
                    upload_logo_reference_ids = explicit_global_reference_ids[:1]
                if not upload_logo_reference_ids:
                    upload_logo_reference_ids = [
                        item
                        for item in per_item_reference_ids
                        if item != source_asset_id and _asset_payload_is_logo(asset_lookup.get(item) or {})
                    ][:1]
                upload_reference_asset_ids = [*upload_logo_reference_ids]
                if upload_logo_reference_ids:
                    logger.info(
                        "[WORKFLOW] 物料融合仅上传主素材和 Logo，避免跨页面功能图混入主界面: task_index=%s, source_asset=%s, references=%s",
                        plan_index,
                        source_asset_id,
                        per_item_reference_ids,
                    )
                uploaded_logo_assets = [asset_lookup.get(item) or {} for item in upload_logo_reference_ids]
                per_item_prompt_text = _compose_material_fusion_prompt_for_plan_item(
                    prompt_data.get("prompt", ""),
                    plan_item,
                    index=plan_index,
                    total=len(plan_items),
                    source_asset=source_asset,
                    uploaded_logo_assets=uploaded_logo_assets,
                    note_content=request.content,
                )
                per_item_prompt = {
                    **prompt_data,
                    "id": plan_index,
                    "title": plan_item.get("title") or prompt_data.get("title") or f"物料融合 {plan_index}",
                    "prompt": per_item_prompt_text,
                    "material_fusion_plan_item": plan_item,
                }
                task_id = task_manager.create_task(
                    f"物料融合 {plan_index}/{len(plan_items)}",
                    metadata={
                        "user_id": user_id,
                        "client_request_id": client_request_id,
                        "workflow_signature": workflow_signature,
                        "provider": "edit",
                        "prompt": per_item_prompt_text,
                        "aspect_ratio": "3:4",
                        "image_size": "1K",
                        "task_kind": "image_edit",
                        "stage": "submitting",
                        "workflow_index": plan_index,
                        "workflow_total": len(plan_items),
                        "variant_key": prompt_data.get("variant_key") or "preserve_subject_edit",
                        "layout_family": prompt_data.get("layout_family") or "source_preserving_poster_edit",
                        "visual_focus": prompt_data.get("visual_focus") or "保留主素材主体 + 海报化包装",
                        "visual_mode_resolved": "material_fusion",
                        "edit_source_asset_id": source_asset_id,
                        "edit_preservation_mode": "preserve_subject_edit",
                        "reference_asset_ids": per_item_reference_ids,
                        "material_fusion_plan_item": plan_item,
                        "active_provider": "image_edit",
                        "reference_metadata_only": True,
                        "upload_reference_asset_ids": upload_reference_asset_ids,
                        "material_fusion_serial_mode": True,
                        "material_fusion_stagger_seconds": MATERIAL_FUSION_EDIT_STAGGER_SECONDS,
                    },
                )
                _save_runtime_task(task_id)
                task_ids.append(task_id)
                returned_prompts.append(per_item_prompt)
                edit_source_asset_ids.append(source_asset_id)
                edit_task_specs.append({
                    "task_id": task_id,
                    "source_asset_id": source_asset_id,
                    "prompt": per_item_prompt_text,
                    "aspect_ratio": "3:4",
                    "image_size": "1K",
                    "user_id": user_id,
                    "reference_asset_ids": per_item_reference_ids,
                    "upload_reference_asset_ids": upload_reference_asset_ids,
                })
                save_image_prompt_log({
                    "task_id": task_id,
                    "user_id": user_id,
                    "title": request.title,
                    "content_excerpt": request.content,
                    "visual_mode": request.mode,
                    "prompt_strategy": prompt_strategy,
                    "prompt_model": used_model,
                    "image_provider": "edit",
                    "image_model": "image_edit",
                    "workflow_index": plan_index,
                    "workflow_total": len(plan_items),
                    "prompt_type": prompt_data.get("type"),
                    "prompt_title": per_item_prompt.get("title"),
                    "role": prompt_data.get("role"),
                    "key_message": prompt_data.get("key_message"),
                    "prompt_text": per_item_prompt_text,
                    "prompt_payload": per_item_prompt,
                    "design_plan": effective_design_plan,
                    "prompt_stats": effective_prompt_stats,
                    "product_brief": request.product_brief,
                    "dynamic_style_params": request.dynamic_style_params,
                    "material_summary": request.material_summary,
                    "reference_summary": request.reference_summary,
                    "reference_asset_ids": per_item_reference_ids,
                })
                logger.info(
                    "[WORKFLOW] 物料融合已创建编辑任务: task_id=%s, source_asset=%s, reference_assets=%s, upload_reference_assets=%s, plan_index=%s/%s",
                    task_id,
                    source_asset_id,
                    per_item_reference_ids,
                    upload_reference_asset_ids,
                    plan_index,
                    len(plan_items),
                )
            if not task_ids:
                detail = "物料融合模式没有足够匹配的主素材，请补充与图片文案对应的功能截图"
                if rejected_material_items:
                    detail = f"{detail}：{'；'.join(rejected_material_items[:4])}"
                raise HTTPException(status_code=400, detail=detail)
            background_tasks.add_task(run_material_fusion_edit_tasks, edit_task_specs)
            return {
                "success": True,
                "message": f"物料融合已启动，正在按顺序基于 {len(task_ids)} 张主素材编辑海报",
                "task_ids": task_ids,
                "requested_image_count": request.image_count,
                "actual_submitted_count": len(task_ids),
                "prompts": returned_prompts,
                "visual_mode_resolved": "material_fusion",
                "edit_source_asset_id": edit_source_asset_ids[0] if edit_source_asset_ids else primary_reference_asset.get("id"),
                "edit_source_asset_ids": edit_source_asset_ids,
                "edit_preservation_mode": "preserve_subject_edit",
                "reference_asset_ids": reference_asset_ids,
                "material_fusion_plan": plan_items,
            }

        image_candidates = _resolve_image_generation_candidates(mode=prompt_strategy)
        for index, candidate in enumerate(image_candidates, start=1):
            _log_image_runtime_diagnostics(
                f"workflow_candidate_{index}",
                api_key=candidate.get("api_key"),
                base_url=candidate.get("base_url"),
                model=candidate.get("model"),
                provider=candidate.get("provider"),
            )
        workflow_concurrency = _resolve_workflow_concurrency(image_candidates)
        workflow_stagger_seconds = _resolve_workflow_stagger_seconds(image_candidates)
        logger.info(
            "[WORKFLOW] 开始创建生图任务: requested=%s, actual=%s, concurrency_limit=%s, stagger_seconds=%s",
            request.image_count,
            actual_prompt_count,
            workflow_concurrency,
            workflow_stagger_seconds,
        )
        
        for i, prompt_data in enumerate(prompts[:request.image_count]):
            if not isinstance(prompt_data, dict):
                logger.warning(f"[WORKFLOW] 跳过无效提示词项: index={i}, type={type(prompt_data).__name__}")
                continue
            logger.info(f"[WORKFLOW] 提示词 {i+1}/{request.image_count}:")
            logger.info(f"  - ID: {prompt_data.get('id')}")
            logger.info(f"  - Type: {prompt_data.get('type')}")
            logger.info(f"  - Style: {prompt_data.get('style', 'N/A')}")
            logger.info(f"  - Prompt (前 600 字符): {prompt_data.get('prompt', '')[:600]}...")
        
        task_ids = []
        primary_candidate = image_candidates[0]
        provider = primary_candidate["provider"]
        model = primary_candidate["model"]
        sync_timeout_seconds = _resolve_sync_image_task_timeout_seconds(provider, model, mode=prompt_strategy)
        
        task_specs: List[Dict[str, Any]] = []
        for i, prompt_data in enumerate(prompts[:request.image_count]):
            if not isinstance(prompt_data, dict):
                logger.warning(f"[WORKFLOW] 跳过任务创建的无效提示词项: index={i}, type={type(prompt_data).__name__}")
                continue
            task_id = task_manager.create_task(f"生成图片 {i+1}/{request.image_count}", metadata={
                "user_id": user_id,
                "client_request_id": client_request_id,
                "workflow_signature": workflow_signature,
                "provider": provider,
                "model": model,
                "prompt": prompt_data.get("prompt", ""),
                "aspect_ratio": "3:4",
                "image_size": "1K",
                "retryable": provider == "tuzi" and "preview-async" in (model or "").lower(),
                "workflow_index": i + 1,
                "workflow_total": actual_prompt_count,
                "prompt_strategy": prompt_strategy,
                "task_kind": "image",
                "role": prompt_data.get("role"),
                "key_message": prompt_data.get("key_message"),
                "variant_key": prompt_data.get("variant_key"),
                "layout_family": prompt_data.get("layout_family"),
                "visual_focus": prompt_data.get("visual_focus"),
                "primary_provider": primary_candidate["label"],
                "fallback_providers": [candidate["label"] for candidate in image_candidates[1:]],
                "retry_policy": "provider_fallback_with_backoff",
                "active_provider": primary_candidate["label"],
                "fallback_used": False,
                "visual_mode_resolved": prompt_strategy,
                "sync_timeout_seconds": sync_timeout_seconds,
                "generation_request_timeout_seconds": IMAGE2_DYNAMIC_IMAGE_REQUEST_TIMEOUT_SECONDS if prompt_strategy in IMAGE2_QUALITY_MODES else IMAGE_REQUEST_TIMEOUT_SECONDS,
                "reference_asset_ids": reference_asset_ids,
                "stagger_delay_seconds": round(workflow_stagger_seconds * i, 1) if workflow_stagger_seconds > 0 else 0,
                "poll_interval_seconds": TUZI_TASK_REFRESH_INTERVAL_SECONDS if provider == "tuzi" and "preview-async" in (model or "").lower() else None,
                "requested_image_count": request.image_count,
                "actual_submitted_count": actual_prompt_count,
                "stage": "pending",
            })
            task_ids.append(task_id)
            task_specs.append({
                "task_id": task_id,
                "prompt": prompt_data.get("prompt", ""),
                "aspect_ratio": "3:4",
                "image_size": "1K",
                "role": prompt_data.get("role"),
                "key_message": prompt_data.get("key_message"),
                "variant_key": prompt_data.get("variant_key"),
                "layout_family": prompt_data.get("layout_family"),
                "visual_focus": prompt_data.get("visual_focus"),
            })
            _save_runtime_task(task_id)
            save_image_prompt_log({
                "task_id": task_id,
                "user_id": user_id,
                "title": request.title,
                "content_excerpt": request.content,
                "visual_mode": request.mode,
                "prompt_strategy": prompt_strategy,
                "prompt_model": used_model,
                "image_provider": provider,
                "image_model": model,
                "workflow_index": i + 1,
                "workflow_total": actual_prompt_count,
                "prompt_type": prompt_data.get("type"),
                "prompt_title": prompt_data.get("title"),
                "role": prompt_data.get("role"),
                "key_message": prompt_data.get("key_message"),
                "prompt_text": prompt_data.get("prompt", ""),
                "prompt_payload": prompt_data,
                "design_plan": effective_design_plan,
                "prompt_stats": effective_prompt_stats,
                "product_brief": request.product_brief,
                "dynamic_style_params": request.dynamic_style_params,
                "material_summary": request.material_summary,
                "reference_summary": request.reference_summary,
                "reference_asset_ids": reference_asset_ids,
            })
            logger.info(f"[WORKFLOW] 创建任务 {i+1}: task_id={task_id}")

        if not task_specs:
            raise HTTPException(status_code=500, detail="提示词结果格式无效：未生成任何可用提示词")

        background_tasks.add_task(
            run_workflow_generate_tasks,
            task_specs,
            workflow_concurrency,
            workflow_stagger_seconds,
        )
        
        logger.info(f"[WORKFLOW] 工作流已创建 {len(task_ids)} 个后台生图任务")
        
        logger.info(f"[WORKFLOW] 工作流启动成功, 返回 {len(task_ids)} 个任务ID")
        
        return {
            "success": True,
            "message": f"工作流已启动，实际提交 {len(task_ids)} 个生图任务",
            "task_ids": task_ids,
            "requested_image_count": request.image_count,
            "actual_submitted_count": len(task_ids),
            "prompts": prompts,
            "visual_mode_resolved": prompt_strategy,
            "reference_asset_ids": reference_asset_ids,
            "image_runner": get_image_job_runner_stats(),
        }
        
    except HTTPException as he:
        logger.error(f"[WORKFLOW] HTTP异常: {he.detail}", exc_info=True)
        raise
    except Exception as e:
        logger.error(f"[WORKFLOW] 工作流执行失败: {type(e).__name__}: {e}", exc_info=True)
        _raise_visual_http_error(e)


@router.post("/dynamic-image")
async def generate_dynamic_image(
    request: DynamicImageRequest,
    background_tasks: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
):
    title = (request.title or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="笔记标题不能为空")

    image_count = max(1, min(int(request.image_count or 1), 6))
    workflow_request = WorkflowRequest(
        client_request_id=request.client_request_id,
        title=title,
        content=_build_dynamic_image_content(title, request.tags, request.content),
        style=request.style or "cyberpunk",
        image_count=image_count,
        mode="动态表达",
        dynamic_style_params=request.dynamic_style_params,
        product_brief=request.product_brief,
    )
    result = await analyze_and_generate(workflow_request, background_tasks, user_id)
    if isinstance(result, dict):
        result["message"] = f"动态生图任务已启动，实际提交 {result.get('actual_submitted_count', len(result.get('task_ids') or []))} 个生图任务"
        result["source_api"] = "dynamic-image"
        result["input_tags"] = _normalize_dynamic_image_tags(request.tags)
    return result


@router.get("/task/{task_id}")
async def get_task_status(task_id: str, user_id: str = Depends(get_current_user_id)):
    try:
        ensure_image_task_schema()
        task = task_manager.get_task(task_id)
        if not task:
            task = _hydrate_task_from_store(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        task_user_id = str(((task.get("metadata") or {}).get("user_id")) or "").strip()
        if task_user_id and task_user_id != user_id:
            raise HTTPException(status_code=403, detail="无权访问该任务")
        task = await _refresh_tuzi_task_if_needed(task_id, task)
        task = await _terminate_stale_sync_image_task_if_needed(task_id, task)
        return task
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取任务状态失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/task/{task_id}/cancel")
async def cancel_task(task_id: str, user_id: str = Depends(get_current_user_id)):
    try:
        ensure_image_task_schema()
        task = task_manager.get_task(task_id)
        if not task:
            task = _hydrate_task_from_store(task_id)
        if not task:
            raise HTTPException(status_code=404, detail="任务不存在")
        task_user_id = str(((task.get("metadata") or {}).get("user_id")) or "").strip()
        if task_user_id and task_user_id != user_id:
            raise HTTPException(status_code=403, detail="无权取消该任务")
        if task.get("status") in {TaskStatus.COMPLETED.value, TaskStatus.FAILED.value, TaskStatus.CANCELLED.value}:
            return {
                "success": True,
                "message": "任务已结束",
                "task": task,
            }
        cancelled_task = await _cancel_visual_task(task_id)
        logger.info("[Visual] 用户取消生图任务: task_id=%s user_id=%s", task_id, user_id)
        return {
            "success": True,
            "message": "已取消生成任务",
            "task": cancelled_task,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("取消任务失败: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/tasks")
async def get_all_tasks(user_id: str = Depends(get_current_user_id)):
    try:
        tasks = task_manager.get_all_tasks()
        visible_tasks = [
            task for task in tasks
            if str(((task.get("metadata") or {}).get("user_id")) or "").strip() == user_id
        ]
        return {"tasks": visible_tasks}
    except Exception as e:
        logger.error(f"获取所有任务失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/text-runner/status")
async def get_text_runner_status(user_id: str = Depends(get_current_user_id)):
    return {
        "success": True,
        "runner": get_text_job_runner_stats(),
        "research_runner": get_research_text_job_runner_stats(),
        "strategy_runner": get_strategy_text_job_runner_stats(),
        "revision_runner": get_revision_text_job_runner_stats(),
    }


@router.get("/image-runner/status")
async def get_image_runner_status(user_id: str = Depends(get_current_user_id)):
    return {
        "success": True,
        "runner": get_image_job_runner_stats(),
    }


@router.post("/edit", response_model=EditImageResponse)
async def edit_image(
    request: EditImageRequest,
    user_id: str = Depends(get_current_user_id),
):
    try:
        trace_metadata = dict(request.trace_metadata or {})
        logger.info(
            "收到图片编辑请求: image_id=%s, prompt=%s..., candidate_seed=%s, trace=%s",
            request.image_id,
            request.prompt[:50],
            request.candidate_seed,
            trace_metadata,
        )
        edit_purpose = request.edit_purpose
        if not edit_purpose and trace_metadata.get("feature") == "studio_logo_fix_batch":
            edit_purpose = "logo_replacement"
        candidate_offset = request.candidate_offset
        if candidate_offset is None:
            trace_item_index = trace_metadata.get("item_index")
            try:
                candidate_offset = int(trace_item_index) if trace_item_index is not None else None
            except (TypeError, ValueError):
                candidate_offset = None
        
        task_id = task_manager.create_task(
            f"编辑图片 {request.image_id}",
            metadata={
                "user_id": user_id,
                "task_kind": "image_edit",
                "stage": "pending",
                "upload_reference_asset_ids": request.upload_reference_asset_ids,
                "material_fusion_serial_mode": request.material_fusion_serial_mode,
                "reference_metadata_only": request.reference_metadata_only,
                "edit_purpose": edit_purpose,
                "candidate_seed": request.candidate_seed,
                "candidate_offset": candidate_offset,
                "trace_metadata": trace_metadata,
            },
        )
        
        asyncio.create_task(
            run_edit_task(
                task_id,
                request.image_id,
                request.prompt,
                request.aspect_ratio,
                request.image_size,
                user_id,
                request.reference_asset_ids,
            )
        )
        
        return EditImageResponse(
            success=True,
            message="图片编辑任务已创建",
            task_id=task_id,
            data={
                "image_id": request.image_id,
                "prompt": request.prompt[:100],
                "reference_asset_ids": request.reference_asset_ids,
                "upload_reference_asset_ids": request.upload_reference_asset_ids,
                "reference_metadata_only": request.reference_metadata_only,
                "edit_purpose": edit_purpose,
                "candidate_seed": request.candidate_seed,
                "candidate_offset": candidate_offset,
                "trace_metadata": trace_metadata,
            }
        )
        
    except Exception as e:
        logger.error(f"创建图片编辑任务失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/polish-content", response_model=PolishContentResponse)
async def polish_content(request: PolishContentRequest):
    try:
        logger.info(f"收到文案优化请求: type={request.type}")

        system_prompt = """你是一个专业的小红书文案优化师。你的任务是修改用户提供的文本，使其更符合小红书风格，或者根据用户的具体指令进行调整。
        
        重要规则：
        1. 仅修改语气、风格或根据指令微调，保留核心信息。
        2. 不要重新生成与原意无关的内容。
        3. 直接返回修改后的文本，不要包含任何解释性语言（如"好的，这是修改后的..."）。
        4. 如果是标题，保持简短有力，必须包含合适的 emoji。
        5. 如果是正文，保持分段清晰，大量使用 emoji（每段或关键句后），符合小红书重度 emoji 排版风格。
        """
        
        user_prompt = f"""
        原文本：
        {request.text}
        
        修改指令：
        {request.instruction}
        
        请直接输出修改后的文本：
        """
        
        response = await _run_text_completion_with_timeout(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.7,
            max_tokens=1000,
            timeout_seconds=POLISH_CONTENT_TIMEOUT_SECONDS,
        )
        
        polished_text_raw = response.choices[0].message.content if response.choices else None
        if polished_text_raw is None or not str(polished_text_raw).strip():
            raise ValueError("文案优化模型未返回文本内容")
        polished_text = str(polished_text_raw).strip()
        
        # 清理可能包含的引号
        if polished_text.startswith('"') and polished_text.endswith('"'):
            polished_text = polished_text[1:-1]
            
        return PolishContentResponse(
            success=True,
            message="文案优化成功",
            polished_text=polished_text
        )
        
    except asyncio.TimeoutError:
        logger.error("文案优化超时: type=%s timeout_seconds=%s", request.type, POLISH_CONTENT_TIMEOUT_SECONDS)
        raise HTTPException(status_code=504, detail="文案优化请求超时，请稍后重试")
    except Exception as e:
        logger.error(f"文案优化失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


async def _run_polish_content_task(task_id: str, request: PolishContentRequest) -> None:
    await _run_async_text_task_with_retry(
        task_id,
        job_type="polish_content",
        start_message="文案优化已开始",
        retry_message="文案优化模型暂时繁忙",
        success_message="文案优化完成",
        failure_message="文案优化失败",
        execute=lambda: polish_content(request),
    )


@router.post("/polish-content-async", response_model=AsyncTextTaskResponse)
async def polish_content_async(request: PolishContentRequest, user_id: str = Depends(get_current_user_id)):
    task_id = task_manager.create_task(
        "文案优化",
        metadata={"user_id": user_id, "task_kind": "text", "text_job_type": "polish_content", "stage": "queued"},
    )
    asyncio.create_task(_run_polish_content_task(task_id, request))
    return AsyncTextTaskResponse(success=True, message="文案优化任务已提交", task_id=task_id)


@router.post("/notes/research-context", response_model=BasicDataResponse)
async def generate_research_context(request: ResearchContextRequest):
    try:
        service = NoteStrategyService()
        context = await _run_research_blocking_with_timeout(
            service.build_research_context,
            product_brief=request.product_brief or {},
            reference_assets=request.reference_assets or [],
            benchmark_note=request.benchmark_note,
        )
        return BasicDataResponse(
            success=True,
            message="产品研究完成",
            data=context,
        )
    except asyncio.TimeoutError:
        logger.error("生成研究上下文超时: timeout_seconds=%s", TEXT_MODEL_ROUTE_TIMEOUT_SECONDS)
        fallback_context = service.build_research_context(
            product_brief=request.product_brief or {},
            reference_assets=request.reference_assets or [],
            benchmark_note=request.benchmark_note,
            use_model=False,
        )
        return BasicDataResponse(
            success=True,
            message="产品研究完成（已使用本地兜底研究）",
            data=fallback_context,
        )
    except Exception as e:
        logger.error(f"生成研究上下文失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"研究产品资料失败: {e}")


async def _generate_note_strategy_for_user(
    request: StrategyRequest,
    effective_user_id: str,
):
    service = NoteStrategyService()
    started_at = time.monotonic()
    requested_strategy_mode = request.strategy_mode or "research_first"
    effective_user_id = str(effective_user_id or "").strip() or settings.DEFAULT_DEV_USER_ID
    product_name_for_log = str((request.research_context or {}).get("product_name") or "").strip()
    recent_strategy_signals = list_recent_note_strategy_signals(
        user_id=effective_user_id,
        product_name=product_name_for_log,
        strategy_mode=requested_strategy_mode,
    )
    try:
        strategies = await _run_strategy_blocking_with_timeout(
            service.build_note_strategies,
            research_context=request.research_context or {},
            benchmark_note=request.benchmark_note,
            real_phrases=request.real_phrases or [],
            strategy_mode=requested_strategy_mode,
            strategy_feedback=request.strategy_feedback or "",
            recent_strategy_signals=recent_strategy_signals,
            timeout_seconds=NOTE_STRATEGY_ROUTE_TIMEOUT_SECONDS,
        )
        save_note_strategy_log({
            "user_id": effective_user_id,
            "product_name": product_name_for_log,
            "strategy_mode": requested_strategy_mode,
            "research_context": request.research_context or {},
            "benchmark_note": request.benchmark_note,
            "real_phrases": request.real_phrases or [],
            "strategy_feedback": request.strategy_feedback or "",
            "response_payload": strategies,
            "model_name": getattr(service, "model_id", None),
            "started_at": started_at,
        })
        return BasicDataResponse(
            success=True,
            message="笔记策略生成完成",
            data=strategies,
        )
    except asyncio.TimeoutError:
        logger.error("生成笔记策略超时，不返回本地兜底: timeout_seconds=%s", NOTE_STRATEGY_ROUTE_TIMEOUT_SECONDS)
        raise HTTPException(status_code=504, detail="笔记策略模型生成超时，请稍后重试")
    except Exception as e:
        logger.error(f"生成笔记策略失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"生成笔记策略失败: {e}")


@router.post("/notes/strategy", response_model=BasicDataResponse)
async def generate_note_strategy(
    request: StrategyRequest,
    authorization: Optional[str] = Header(None, alias="Authorization"),
):
    effective_user_id = _resolve_optional_user_id_from_authorization(authorization)
    return await _generate_note_strategy_for_user(request, effective_user_id)


@router.post("/notes/visual-plan", response_model=BasicDataResponse)
async def generate_note_visual_plan(request: GenerateNoteVisualPlanRequest):
    try:
        product_brief = request.product_brief or {}
        plan = build_note_visual_plan(
            title=request.title,
            content=request.content,
            product_name=str(product_brief.get("product_name") or ""),
            target_audience=str(product_brief.get("target_audience") or ""),
            product_features=str(product_brief.get("product_features") or ""),
            reference_assets=request.reference_assets or [],
            note_strategy=request.note_strategy or None,
        )
        return BasicDataResponse(
            success=True,
            message="笔记视觉规划生成成功",
            data=plan,
        )
    except Exception as e:
        logger.error(f"生成笔记视觉规划失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"生成笔记视觉规划失败: {e}")


@router.post("/revise-note")
async def revise_note(request: ReviseNoteRequest):
    try:
        if not str(request.instruction or "").strip():
            raise HTTPException(status_code=400, detail="修改指令不能为空")

        from backend.services.viral_content_generator import ViralContentGenerator

        generator = ViralContentGenerator()
        revision = await _run_revision_blocking_with_timeout(
            generator.revise_confirmation_note,
            title=request.title,
            opening=request.opening,
            outline=request.outline,
            body=request.body,
            closing=request.closing or "",
            instruction=request.instruction,
            selected_scope=request.selected_scope,
            rewrite_session=request.rewrite_session or None,
            product_info=request.product_brief or None,
            benchmark_note=request.benchmark_note or None,
            note_strategy=request.note_strategy or None,
        )
        updated_fields = revision.get("updated_fields", {}) if isinstance(revision.get("updated_fields"), dict) else {}
        if revision.get("detected_scope") == "title" and (request.selected_scope or "") == "title":
            revision["note_visual_plan"] = None
        else:
            note_visual_plan = build_note_visual_plan(
                title=str(updated_fields.get("title") or request.title or ""),
                content=str(updated_fields.get("body") or request.body or ""),
                product_name=str((request.product_brief or {}).get("product_name") or ""),
                target_audience=str((request.product_brief or {}).get("target_audience") or ""),
                product_features=str((request.product_brief or {}).get("product_features") or ""),
                reference_assets=[],
                note_strategy=request.note_strategy or None,
            )
            revision["note_visual_plan"] = note_visual_plan
        return {
            "success": True,
            "message": "笔记确认稿修改完成",
            "data": revision,
        }
    except HTTPException:
        raise
    except asyncio.TimeoutError:
        logger.error("修改确认稿超时: timeout_seconds=%s", TEXT_MODEL_ROUTE_TIMEOUT_SECONDS)
        raise HTTPException(status_code=504, detail="修改确认稿超时，请稍后重试")
    except Exception as e:
        logger.error(f"修改确认稿失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"修改确认稿失败: {e}")


async def _run_revise_note_task(task_id: str, request: ReviseNoteRequest) -> None:
    await _run_async_text_task_with_retry(
        task_id,
        job_type="revise_note",
        start_message="确认稿修改已开始",
        retry_message="确认稿修改模型暂时繁忙",
        success_message="确认稿修改完成",
        failure_message="确认稿修改失败",
        execute=lambda: revise_note(request),
    )


@router.post("/revise-note-async", response_model=AsyncTextTaskResponse)
async def revise_note_async(request: ReviseNoteRequest, user_id: str = Depends(get_current_user_id)):
    if not str(request.instruction or "").strip():
        raise HTTPException(status_code=400, detail="修改指令不能为空")
    task_id = task_manager.create_task(
        "确认稿修改",
        metadata={"user_id": user_id, "task_kind": "text", "text_job_type": "revise_note", "stage": "queued"},
    )
    asyncio.create_task(_run_revise_note_task(task_id, request))
    return AsyncTextTaskResponse(success=True, message="确认稿修改任务已提交", task_id=task_id)


def _generate_content_blocking(request: GenerateContentRequest):
    try:
        logger.info(f"收到文案生成请求: {request.product_name}")
        
        from backend.services.viral_content_generator import ViralContentGenerator
        
        generator = ViralContentGenerator()
        
        product_info = {
            "product_name": request.product_name,
            "target_audience": request.target_audience,
            "product_features": request.product_features,
            "brand_tone": request.brand_tone or "真实、口语化、不过度销售",
            "must_include": request.must_include or "",
            "banned_terms": request.banned_terms or "",
        }
        research_context = request.research_context or None
        note_strategy = request.note_strategy or None
        if note_strategy:
            logger.info(
                "文案生成使用策略 label=%s angle=%s suggested_title=%s",
                note_strategy.get("label") or "",
                note_strategy.get("contentAngle") or "",
                note_strategy.get("suggestedTitle") or "",
            )

        def _rewrite_text_probe(value: Any) -> str:
            text = str(value or "")
            normalized = re.sub(r"\s+", "", text)
            digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:8] if normalized else "empty"
            return f"len={len(text)} normalized_len={len(normalized)} hash={digest}"

        def _has_rewrite_change(source: Any, candidate: Any) -> bool:
            source_normalized = re.sub(r"\s+", "", str(source or ""))
            candidate_normalized = re.sub(r"\s+", "", str(candidate or ""))
            return bool(source_normalized and candidate_normalized and source_normalized != candidate_normalized)

        def log_rewrite_success(path: str, session: Dict[str, Any], title: str, content: str) -> None:
            logger.info(
                "文案生成成功 path=%s final_source=%s guardrail_stage=%s fallback_used=%s title=%s content_length=%s draft={%s} minimal={%s} deep={%s} final={%s} minimal_changed=%s deep_changed=%s final_changed=%s de_ai_summary=%s",
                path,
                session.get("final_body_source") or "",
                session.get("guardrail_stage") or "",
                session.get("polished_body_fallback_used"),
                title,
                len(content or ""),
                _rewrite_text_probe(session.get("body_draft")),
                _rewrite_text_probe(session.get("minimal_polish_body")),
                _rewrite_text_probe(session.get("deep_polish_body")),
                _rewrite_text_probe(session.get("final_body") or content),
                _has_rewrite_change(session.get("body_draft"), session.get("minimal_polish_body")),
                _has_rewrite_change(session.get("minimal_polish_body") or session.get("body_draft"), session.get("deep_polish_body")),
                _has_rewrite_change(session.get("body_draft"), session.get("final_body") or content),
                ((session.get("de_ai_report") or {}).get("summary") or ""),
            )

        if request.benchmark_note:
            rewrite_session = generator.generate_rewrite_session(
                benchmark_note=request.benchmark_note,
                product_info=product_info,
                rewrite_mode=request.rewrite_mode or "结构仿写",
                sales_intensity=request.sales_intensity,
                colloquial_level=request.colloquial_level,
                authenticity_level=request.authenticity_level,
                real_phrases=request.real_phrases or [],
                note_strategy=note_strategy,
            )
            final_title = rewrite_session.get("selected_title") or (rewrite_session.get("title_candidates") or [""])[0]
            final_content = rewrite_session.get("final_body") or rewrite_session.get("polished_body") or rewrite_session.get("body_draft") or ""
            note_visual_plan = build_note_visual_plan(
                title=final_title,
                content=final_content,
                product_name=request.product_name,
                target_audience=request.target_audience,
                product_features=request.product_features,
                reference_assets=[],
                note_strategy=note_strategy,
            )
            log_rewrite_success("benchmark_strategy_rewrite" if note_strategy else "benchmark_rewrite", rewrite_session, final_title, final_content)
            return GenerateContentResponse(
                success=True,
                message="对标仿写完成",
                title=final_title,
                content=final_content,
                final_body=final_content,
                tags=rewrite_session.get("tags", []),
                rewrite_session=rewrite_session,
                note_visual_plan=note_visual_plan,
                research_context=research_context,
                note_strategy=note_strategy,
            )

        synthetic_benchmark_lines: List[str] = []
        if note_strategy:
            synthetic_benchmark_lines.extend([
                str(note_strategy.get("summary") or ""),
                "核心痛点：" + "；".join(note_strategy.get("corePainPoints") or []),
                "核心卖点：" + "；".join(note_strategy.get("coreBenefits") or []),
                "内容角度：" + str(note_strategy.get("contentAngle") or ""),
                "推荐结构：" + "；".join(note_strategy.get("recommendedCardPlan") or []),
            ])
        if research_context:
            synthetic_benchmark_lines.extend([
                "研究摘要：" + str(research_context.get("summary") or ""),
                "使用场景：" + "；".join(research_context.get("use_cases") or []),
                "差异化价值：" + "；".join(research_context.get("differentiators") or []),
            ])
        synthetic_benchmark_note = {
            "title": str((note_strategy or {}).get("suggestedTitle") or request.product_name or "产品研究策略笔记"),
            "desc": "\n".join(line for line in synthetic_benchmark_lines if line).strip() or request.product_features,
            "content_category": str((note_strategy or {}).get("label") or "产品研究策略"),
            "recommendation_tier": str((note_strategy or {}).get("noteGoal") or "可参考"),
            "material_dependency": "产品资料与策略生成",
        }

        rewrite_error_message = ""
        try:
            if note_strategy:
                for attempt in range(1, STRATEGY_DIRECT_SYNC_MAX_ATTEMPTS + 1):
                    try:
                        rewrite_session = generator.generate_strategy_direct_session(
                            benchmark_note=synthetic_benchmark_note,
                            product_info=product_info,
                            rewrite_mode=request.rewrite_mode or "策略直写",
                            sales_intensity=request.sales_intensity,
                            colloquial_level=request.colloquial_level,
                            authenticity_level=request.authenticity_level,
                            real_phrases=request.real_phrases or [],
                            note_strategy=note_strategy,
                        )
                        if attempt > 1:
                            retry_note = f"策略直写模型第 {attempt} 次调用成功"
                            rewrite_session["revision_notes"] = [
                                retry_note,
                                *(rewrite_session.get("revision_notes") or []),
                            ][:8]
                            rewrite_session["guardrail_repairs_applied"] = [
                                retry_note,
                                *(rewrite_session.get("guardrail_repairs_applied") or []),
                            ][:8]
                        break
                    except Exception as strategy_error:
                        retryable = is_retryable_text_generation_error(strategy_error)
                        if attempt < STRATEGY_DIRECT_SYNC_MAX_ATTEMPTS and retryable:
                            backoff_seconds = STRATEGY_DIRECT_SYNC_RETRY_BACKOFF_SECONDS * attempt
                            logger.warning(
                                "策略直写模型调用失败，将重试: product=%s attempt=%s/%s backoff=%ss error=%s",
                                request.product_name,
                                attempt,
                                STRATEGY_DIRECT_SYNC_MAX_ATTEMPTS,
                                backoff_seconds,
                                strategy_error,
                                exc_info=True,
                            )
                            time.sleep(backoff_seconds)
                            continue
                        raise
            else:
                rewrite_session = generator.generate_rewrite_session(
                    benchmark_note=synthetic_benchmark_note,
                    product_info=product_info,
                    rewrite_mode=request.rewrite_mode or "结构仿写",
                    sales_intensity=request.sales_intensity,
                    colloquial_level=request.colloquial_level,
                    authenticity_level=request.authenticity_level,
                    real_phrases=request.real_phrases or [],
                    note_strategy=note_strategy,
                )
            note_visual_plan = build_note_visual_plan(
                title=(rewrite_session.get("title_candidates") or [""])[0],
                content=rewrite_session.get("final_body") or rewrite_session.get("polished_body") or rewrite_session.get("body_draft") or "",
                product_name=request.product_name,
                target_audience=request.target_audience,
                product_features=request.product_features,
                reference_assets=[],
                note_strategy=note_strategy,
            )
            final_title = (rewrite_session.get("title_candidates") or [""])[0]
            final_content = rewrite_session.get("final_body") or rewrite_session.get("polished_body") or rewrite_session.get("body_draft") or ""
            log_rewrite_success("strategy_direct_rewrite" if note_strategy else "strategy_rewrite", rewrite_session, final_title, final_content)
            return GenerateContentResponse(
                success=True,
                message="策略正文与去 AI 味报告生成完成",
                title=final_title,
                content=final_content,
                final_body=final_content,
                tags=rewrite_session.get("tags", []),
                rewrite_session=rewrite_session,
                note_visual_plan=note_visual_plan,
                research_context=research_context,
                note_strategy=note_strategy,
            )
        except Exception as rewrite_error:
            rewrite_error_message = str(rewrite_error)
            logger.error(f"策略直写模型重试后仍失败，不返回本地兜底: {rewrite_error}", exc_info=True)
            if note_strategy:
                raise HTTPException(
                    status_code=502,
                    detail=f"策略正文模型生成失败，请稍后重试: {rewrite_error_message}",
                )

        strategy_angle = str((note_strategy or {}).get("contentAngle") or "").lower()
        if "教程" in strategy_angle:
            request_style = "tutorial"
        elif "测评" in strategy_angle or "评测" in strategy_angle:
            request_style = "review"
        elif "情感" in strategy_angle:
            request_style = "emotional"
        else:
            request_style = request.content_style or "seed"

        analysis_lines = [
            f"目标人群: {request.target_audience}",
            f"产品特点: {request.product_features}",
            "写作原则: 图讲过程，文案讲价值，不要机械复述每一步图片内容。",
            "正文任务: 优先讲适合谁、解决什么问题、为什么值得看/值得用。",
        ]
        if research_context:
            source_documents = list(research_context.get("source_documents") or [])
            analysis_lines.extend([
                f"研究摘要: {research_context.get('summary', '')}",
                f"使用场景: {'；'.join(research_context.get('use_cases') or [])}",
                f"差异化价值: {'；'.join(research_context.get('differentiators') or [])}",
                f"常见疑问: {'；'.join(research_context.get('faq_hints') or [])}",
            ])
            if source_documents:
                analysis_lines.append(
                    "外部资料补充: " + "；".join(
                        f"{item.get('title', '')}:{item.get('summary', '')}"
                        for item in source_documents[:3]
                        if isinstance(item, dict)
                    )
                )
        if note_strategy:
            analysis_lines.extend([
                f"笔记策略人群: {note_strategy.get('targetAudience', '')}",
                f"核心痛点: {'；'.join(note_strategy.get('corePainPoints') or [])}",
                f"核心卖点: {'；'.join(note_strategy.get('coreBenefits') or [])}",
                f"切入角度: {note_strategy.get('contentAngle', '')}",
                f"创作目标: {note_strategy.get('noteGoal', '')}",
            ])
        analysis_lines.extend([
            "根据小红书爆款规律:",
            "1. 标题要有明确收益感或问题切口",
            "2. 开头先建立场景或痛点共鸣",
            "3. 正文分段清晰，语言自然，不要模板腔",
            "4. 结尾给出适度行动引导",
        ])
        analysis_insights = "\n".join(line for line in analysis_lines if line)
        
        style_map = {
            "seed": "种草",
            "review": "测评",
            "tutorial": "教程",
            "emotional": "情感共鸣"
        }
        style = style_map.get(request_style, "种草")
        
        contents = generator.generate_content(
            product_name=request.product_name,
            product_features=request.product_features,
            target_audience=request.target_audience,
            analysis_insights=analysis_insights,
            style=style,
            count=1
        )
        
        if not contents:
            raise ValueError("文案生成失败")
        
        result = contents[0]
        strategy_title = str((note_strategy or {}).get("suggestedTitle") or "").strip()
        title = result.get("title", "") or strategy_title
        content = result.get("content", "")
        tags = result.get("tags", [])
        fallback_rewrite_session = generator.build_safe_rewrite_session_from_content(
            title=title,
            body=content,
            tags=tags,
            product_info=product_info,
            benchmark_note=synthetic_benchmark_note,
            rewrite_mode=request.rewrite_mode or "结构仿写",
            fallback_reason=rewrite_error_message,
        )
        title = (fallback_rewrite_session.get("title_candidates") or [title])[0]
        content = (
            fallback_rewrite_session.get("final_body")
            or fallback_rewrite_session.get("polished_body")
            or content
        )
        
        log_rewrite_success("legacy_safe_fallback", fallback_rewrite_session, title, content)
        logger.info(f"Content preview (first 200 chars): {repr(content[:200])}")
        
        return GenerateContentResponse(
            success=True,
            message="文案生成成功",
            title=title,
            content=content,
            final_body=content,
            tags=tags,
            rewrite_session=fallback_rewrite_session,
            note_visual_plan=build_note_visual_plan(
                title=title,
                content=content,
                product_name=request.product_name,
                target_audience=request.target_audience,
                product_features=request.product_features,
                reference_assets=[],
                note_strategy=note_strategy,
            ),
            research_context=research_context,
            note_strategy=note_strategy,
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"文案生成失败: {e}", exc_info=True)
        error_msg = str(e)
        if "rate" in error_msg.lower() or "429" in error_msg:
            raise HTTPException(
                status_code=429,
                detail="API 请求频率超限，请稍后重试。建议等待 1-2 分钟后再试。"
            )
        elif "timeout" in error_msg.lower():
            raise HTTPException(
                status_code=504,
                detail="API 请求超时，请检查网络连接后重试。"
            )
        else:
            raise HTTPException(
                status_code=500,
                detail=f"文案生成失败: {error_msg}"
            )


@router.post("/generate-content", response_model=GenerateContentResponse)
async def generate_content(request: GenerateContentRequest):
    try:
        return await _run_blocking_with_timeout(
            _generate_content_blocking,
            request,
            timeout_seconds=CONTENT_GENERATION_ROUTE_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        logger.error("文案生成超时: timeout_seconds=%s product=%s", CONTENT_GENERATION_ROUTE_TIMEOUT_SECONDS, request.product_name)
        raise HTTPException(status_code=504, detail="文案生成超时，请稍后重试")


async def _run_generate_content_task(task_id: str, request: GenerateContentRequest) -> None:
    await _run_async_text_task_with_retry(
        task_id,
        job_type="generate_content",
        start_message="文案生成已开始",
        retry_message="文案生成模型暂时繁忙",
        success_message="文案生成完成",
        failure_message="文案生成失败",
        execute=lambda: generate_content(request),
    )


@router.post("/generate-content-async", response_model=AsyncTextTaskResponse)
async def generate_content_async(request: GenerateContentRequest, user_id: str = Depends(get_current_user_id)):
    task_id = task_manager.create_task(
        "文案生成",
        metadata={"user_id": user_id, "task_kind": "text", "text_job_type": "generate_content", "stage": "queued"},
    )
    asyncio.create_task(_run_generate_content_task(task_id, request))
    return AsyncTextTaskResponse(success=True, message="文案生成任务已提交", task_id=task_id)


@router.get("/publish-quota")
async def get_publish_quota():
    from backend.utils.rate_limiter import get_rate_limiter
    
    rate_limiter = get_rate_limiter()
    quota_info = rate_limiter.get_quota_info()
    
    return quota_info
