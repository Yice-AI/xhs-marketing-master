from __future__ import annotations

import re
from typing import Any, Dict, Optional

import requests
from openai import OpenAI

from backend.config import settings
from backend.services.content_analyzer import (
    DEFAULT_ANTHROPIC_BASE_URL,
    get_anthropic_base_url,
    get_text_generation_base_url,
    get_text_generation_model,
    resolve_text_generation_config,
)
from backend.utils.logger import logger


def classify_model_gateway_error(error: Exception | str) -> Dict[str, Any]:
    raw_text = str(error or "").strip()
    error_text = raw_text.lower()
    status_codes = set(re.findall(r"\b\d{3}\b", error_text))

    if any(
        fragment in error_text
        for fragment in [
            "temporary failure in name resolution",
            "name or service not known",
            "nodename nor servname provided",
            "network is unreachable",
            "connection refused",
            "connection error",
            "connecterror",
            "max retries exceeded",
            "failed to establish a new connection",
            "timed out",
            "timeout",
        ]
    ):
        return {
            "kind": "network_unreachable",
            "status_code": 503,
            "message": "模型通道不可用：当前无法连接内网模型网关，请检查 VPN、专线或出口代理。",
            "raw_error": raw_text,
        }

    if any(fragment in error_text for fragment in ["model_not_found", "invalid_argument", "unsupported model"]) or (
        "not found" in error_text and "model" in error_text
    ):
        return {
            "kind": "invalid_model",
            "status_code": 502,
            "message": "模型网关可达，但当前模型 ID 不可用或已下线，请检查模型配置。",
            "raw_error": raw_text,
        }

    if "429" in status_codes or any(fragment in error_text for fragment in ["rate limit", "resource has been exhausted", "quota", "额度"]):
        return {
            "kind": "quota_exhausted",
            "status_code": 429,
            "message": "模型网关可达，但额度或限流已触发，请稍后重试。",
            "raw_error": raw_text,
        }

    if any(code in status_codes for code in ["401", "403"]) or any(
        fragment in error_text for fragment in ["permission", "unauthorized", "forbidden", "api key"]
    ):
        return {
            "kind": "permission_denied",
            "status_code": 502,
            "message": "模型网关已连通，但当前 Key 或模型权限不可用，请检查网关权限配置。",
            "raw_error": raw_text,
        }

    if "502" in status_codes or any(fragment in error_text for fragment in ["bad gateway", "upstream"]):
        return {
            "kind": "gateway_failure",
            "status_code": 502,
            "message": "模型网关暂时不可用，请稍后重试。",
            "raw_error": raw_text,
        }

    if "content safety service" in error_text or "safety service" in error_text:
        return {
            "kind": "safety_service_unavailable",
            "status_code": 503,
            "message": "模型内容安全服务临时不可用，请稍后重试；若已配置备用编辑模型，系统会自动尝试切换。",
            "raw_error": raw_text,
        }

    if "503" in status_codes or any(fragment in error_text for fragment in ["每日额度", "已达每日", "额度上限", "source quota", "configuration_error"]):
        return {
            "kind": "quota_exhausted",
            "status_code": 429,
            "message": "模型网关可达，但额度或限流已触发，请稍后重试。",
            "raw_error": raw_text,
        }

    return {
        "kind": "unknown",
        "status_code": 500,
        "message": "模型调用失败，请查看后端诊断日志。",
        "raw_error": raw_text,
    }


def _mask_secret(secret: Optional[str]) -> str:
    value = (secret or "").strip()
    if not value:
        return "missing"
    if len(value) <= 10:
        return f"{value[:3]}***"
    return f"{value[:8]}...{value[-4:]}"


def _resolve_image_generation_config() -> tuple[str, str, str, str]:
    model = settings.IMAGE_GEN_MODEL
    base_url = settings.IMAGE_GEN_BASE_URL or settings.ANTHROPIC_BASE_URL
    normalized_base_url = (base_url or "").lower()

    if "tu-zi.com" in normalized_base_url:
        provider = "tuzi"
        api_key = settings.TUZI_API_KEY or settings.IMAGE_GEN_API_KEY or settings.ANTHROPIC_API_KEY or settings.OPENROUTER_API_KEY
    elif "minimaxi.com" in normalized_base_url:
        provider = "minimax"
        api_key = settings.IMAGE_GEN_API_KEY or settings.MINIMAX_API_KEY or settings.OPENROUTER_API_KEY or settings.ANTHROPIC_API_KEY
    elif "openrouter.ai" in normalized_base_url:
        provider = "openrouter"
        api_key = settings.IMAGE_GEN_API_KEY or settings.OPENROUTER_API_KEY or settings.ANTHROPIC_API_KEY or settings.TUZI_API_KEY
    elif model.startswith("gemini"):
        provider = "custom"
        api_key = settings.ANTHROPIC_API_KEY or settings.IMAGE_GEN_API_KEY or settings.OPENROUTER_API_KEY or settings.TUZI_API_KEY
    else:
        provider = "custom"
        api_key = settings.IMAGE_GEN_API_KEY or settings.OPENROUTER_API_KEY or settings.ANTHROPIC_API_KEY or settings.TUZI_API_KEY

    if not api_key:
        raise ValueError("未配置生图服务 API Key。")

    return api_key, base_url, model, provider


def _resolve_text_generation_config_without_logging() -> tuple[str, str]:
    anthropic_api_key = getattr(settings, "ANTHROPIC_API_KEY", "")
    if anthropic_api_key:
        return anthropic_api_key, get_anthropic_base_url()

    image_api_key = getattr(settings, "IMAGE_GEN_API_KEY", "")
    image_base_url = getattr(settings, "IMAGE_GEN_BASE_URL", "")
    if image_api_key and image_base_url:
        normalized = (image_base_url or DEFAULT_ANTHROPIC_BASE_URL).rstrip("/")
        if not normalized.endswith("/v1"):
            normalized = f"{normalized}/v1"
        return image_api_key, normalized

    openai_api_key = getattr(settings, "OPENAI_API_KEY", "")
    if openai_api_key:
        return openai_api_key, "https://api.openai.com/v1"

    if settings.OPENROUTER_API_KEY:
        return settings.OPENROUTER_API_KEY, get_text_generation_base_url()
    if settings.GEMINI_API_KEY:
        return settings.GEMINI_API_KEY, "https://generativelanguage.googleapis.com/v1beta/openai/"
    if settings.MINIMAX_API_KEY:
        return settings.MINIMAX_API_KEY, "https://api.minimaxi.com/v1"
    raise ValueError("未配置文本模型服务 API Key。")


def _uses_chat_completions_image_probe(model_name: str) -> bool:
    normalized = (model_name or "").strip().lower()
    return "gemini" in normalized and "image" in normalized


def _image_probe_timeout_seconds() -> float:
    # Gemini image generation can take much longer than text probes.
    return max(float(settings.MODEL_GATEWAY_HEALTHCHECK_TIMEOUT_SECONDS), 150.0)


def build_model_gateway_summary() -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "mode": settings.MODEL_GATEWAY_MODE,
        "startup_probe_enabled": settings.CHECK_MODEL_GATEWAY_ON_STARTUP,
        "timeout_seconds": settings.MODEL_GATEWAY_HEALTHCHECK_TIMEOUT_SECONDS,
    }

    try:
        text_api_key, text_base_url = _resolve_text_generation_config_without_logging()
        summary["text"] = {
            "configured": True,
            "base_url": text_base_url,
            "model": get_text_generation_model(),
            "key": _mask_secret(text_api_key),
        }
    except Exception as error:
        summary["text"] = {
            "configured": False,
            "error": str(error),
        }

    try:
        image_api_key, image_base_url, image_model, image_provider = _resolve_image_generation_config()
        summary["image"] = {
            "configured": True,
            "base_url": image_base_url,
            "model": image_model,
            "provider": image_provider,
            "key": _mask_secret(image_api_key),
        }
    except Exception as error:
        summary["image"] = {
            "configured": False,
            "error": str(error),
        }

    return summary


def probe_text_gateway() -> Dict[str, Any]:
    api_key, base_url = resolve_text_generation_config()
    client = OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=float(settings.MODEL_GATEWAY_HEALTHCHECK_TIMEOUT_SECONDS),
        default_headers={"Accept-Encoding": "identity"},
    )
    model_name = get_text_generation_model()
    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=[{"role": "user", "content": "请只回复：ok"}],
            max_tokens=8,
            temperature=0,
        )
        content = response.choices[0].message.content if response.choices else ""
        return {
            "ok": True,
            "model": model_name,
            "base_url": base_url,
            "detail": (content or "").strip() or "ok",
        }
    except Exception as error:
        classified = classify_model_gateway_error(error)
        return {
            "ok": False,
            "model": model_name,
            "base_url": base_url,
            **classified,
        }


def probe_image_gateway() -> Dict[str, Any]:
    api_key, base_url, model_name, provider = _resolve_image_generation_config()
    try:
        if _uses_chat_completions_image_probe(model_name):
            response = requests.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model_name,
                    "messages": [{"role": "user", "content": "health check poster"}],
                    "modalities": ["image", "text"],
                },
                timeout=_image_probe_timeout_seconds(),
            )
            response.raise_for_status()
            payload = response.json()
            choices = payload.get("choices") or []
            message = choices[0].get("message", {}) if choices else {}
            has_payload = bool(message.get("images")) or "data:image" in str(message.get("content", ""))
        else:
            client = OpenAI(
                api_key=api_key,
                base_url=base_url,
                timeout=_image_probe_timeout_seconds(),
                default_headers={"Accept-Encoding": "identity"},
            )
            response = client.images.generate(
                model=model_name,
                prompt="health check poster",
                n=1,
                size="1024x1024",
            )
            has_payload = bool(getattr(response, "data", None))
        return {
            "ok": has_payload,
            "model": model_name,
            "base_url": base_url,
            "provider": provider,
            "detail": "image payload received" if has_payload else "image response returned without payload",
        }
    except Exception as error:
        classified = classify_model_gateway_error(error)
        return {
            "ok": False,
            "model": model_name,
            "base_url": base_url,
            "provider": provider,
            **classified,
        }


def run_startup_model_gateway_probe_if_enabled() -> Optional[Dict[str, Any]]:
    if not settings.CHECK_MODEL_GATEWAY_ON_STARTUP:
        return None

    result = {
        "text": probe_text_gateway(),
        "image": probe_image_gateway(),
    }
    logger.info("[MODEL_GATEWAY] startup probe result=%s", result)
    return result
