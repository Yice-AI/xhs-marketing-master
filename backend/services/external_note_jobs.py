import asyncio
import base64
import ipaddress
import hashlib
import logging
import json
import re
import shutil
import tempfile
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import BackgroundTasks, HTTPException
import requests
from urllib.parse import urlparse

from backend.api.models import CreateNoteJobRequest, ImageAckRequest, LogoFixJobRequest
from backend.api.routes import scraper, visual
from backend.config import settings
from backend.config.paths import get_external_artifacts_dir, get_static_images_dir
from backend.services.content_analyzer import resolve_text_generation_config
from backend.services.image_job_runner import image_job_slot
from backend.services.image_generator import ImageGenerator
from backend.utils.ai_parser import clean_and_parse_ai_json
from backend.utils.image_task_store import load_task_snapshot, save_task_snapshot
from backend.utils.task_manager import TaskStatus, task_manager

logger = logging.getLogger(__name__)

DEFAULT_VISUAL_STYLE = "温暖渐变卡片"
DEFAULT_CONTENT_STYLE = "seed"
EXTERNALLY_ENABLED_IMAGE_MODES = ("concept", "image2_dynamic")
EXTERNAL_NOTE_JOB_MAX_CONCURRENCY = max(1, int(getattr(settings, "EXTERNAL_NOTE_JOB_MAX_CONCURRENCY", 2)))
EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT = max(1, int(getattr(settings, "EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT", 2)))
EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE = max(1, int(getattr(settings, "EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE", 20)))
_EXTERNAL_NOTE_JOB_SEMAPHORE = asyncio.Semaphore(EXTERNAL_NOTE_JOB_MAX_CONCURRENCY)
_EXTERNAL_NOTE_JOB_CLIENT_SEMAPHORES: dict[str, asyncio.Semaphore] = defaultdict(
    lambda: asyncio.Semaphore(EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT)
)
_BUILTIN_BRAND_LOGO_DIR = Path(__file__).resolve().parents[1] / "assets" / "brand_logos"
_EXTERNAL_NOTE_JOB_ACTIVE = 0
_EXTERNAL_NOTE_JOB_WAITING = 0
_EXTERNAL_NOTE_JOB_COMPLETED = 0
_EXTERNAL_NOTE_JOB_FAILED = 0
_EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT: dict[str, int] = {}
_EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT: dict[str, int] = {}
EXTERNAL_IMAGE_RETRY_AFTER_SECONDS = max(30, int(getattr(settings, "EXTERNAL_IMAGE_RETRY_AFTER_SECONDS", 240)))
EXTERNAL_IMAGE_MAX_ATTEMPTS_PER_ITEM = max(1, int(getattr(settings, "EXTERNAL_IMAGE_MAX_ATTEMPTS_PER_ITEM", 2)))
_STRATEGY_USER_ID_MAX_LENGTH = 64
YIBAN_LOGO_FORBIDDEN_SHAPE_TERMS = (
    "叶子",
    "对勾",
    "勾",
    "check",
    "checkmark",
    "纸飞机",
    "飞机",
    "箭头",
    "箭",
    "发送",
    "盾牌",
    "数字",
    "7",
    "七",
    "普通装饰",
    "装饰圆标",
    "胶囊",
    "随意白色符号",
)
YIBAN_LOGO_REQUIRED_SHAPE_TERMS = ("Y", "y", "折角")

TEXT_RESULT_FIELDS = [
    "product_brief",
    "research_context",
    "note_strategy",
    "title",
    "content",
    "final_body",
    "tags",
    "note_visual_plan",
    "selected_strategy_style",
    "selected_visual_style",
    "variation_seed",
    "variation_hints",
    "source_documents",
]

VISUAL_STYLE_FAMILIES: Dict[str, List[str]] = {
    "温暖渐变卡片": ["温暖渐变卡片", "笔记卡片风"],
    "笔记卡片风": ["笔记卡片风", "温暖渐变卡片"],
    "极简文字海报": ["极简文字海报", "企业级扁平海报"],
    "企业级扁平海报": ["企业级扁平海报", "极简文字海报"],
    "赛博朋克": ["赛博朋克"],
}

STRATEGY_STYLE_TO_DIRECTIONS: Dict[str, List[str]] = {
    "benefit": ["benefit"],
    "tutorial": ["tutorial"],
    "review": ["benefit", "general"],
    "general": ["general"],
    "auto": [],
}

CONTENT_STYLE_BY_STRATEGY: Dict[str, str] = {
    "benefit": "seed",
    "tutorial": "tutorial",
    "review": "review",
    "general": "seed",
    "auto": DEFAULT_CONTENT_STYLE,
}

VARIATION_HINTS: Dict[str, Dict[str, List[str]]] = {
    "benefit": {
        "low": ["收益点更聚焦", "适合人群更明确"],
        "medium": ["先讲收益后讲原理", "把卖点拆成 3 个卡片"],
        "high": ["突出对比感", "封面走结果感表达"],
    },
    "tutorial": {
        "low": ["步骤表达更直接", "补充一个注意事项"],
        "medium": ["先给结论再给步骤", "正文更像照着做教程"],
        "high": ["强调上手门槛低", "步骤顺序更偏实操"],
    },
    "review": {
        "low": ["保留测评感", "强调真实体验"],
        "medium": ["先讲结论后讲理由", "加入轻度对比口吻"],
        "high": ["突出推荐理由", "封面更像测评标题"],
    },
    "general": {
        "low": ["语气更自然", "减少模板化表达"],
        "medium": ["开头切入更换成场景", "结尾行动引导更轻"],
        "high": ["封面角度更鲜明", "卡片节奏更有变化"],
    },
}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _artifact_ttl() -> timedelta:
    return timedelta(hours=max(settings.EXTERNAL_ARTIFACT_TTL_HOURS, 1))


def _external_artifacts_root() -> Path:
    root = get_external_artifacts_dir()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _task_artifact_dir(task_id: str) -> Path:
    path = _external_artifacts_root() / task_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def _image_file_path(task_id: str, index: int) -> Path:
    return _task_artifact_dir(task_id) / f"image_{index}.png"


def _image_download_url(task_id: str, index: int) -> str:
    return f"{settings.app_base_url}/api/external/image-jobs/{task_id}/files/{index}"


def _artifact_expires_at_iso(from_time: Optional[datetime] = None) -> str:
    base = from_time or _now_utc()
    return (base + _artifact_ttl()).isoformat()


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _artifact_is_expired(expires_at: Optional[str]) -> bool:
    parsed = _parse_iso_datetime(expires_at)
    if not parsed:
        return False
    return parsed <= _now_utc()


def _image_source_path_from_url(image_url: str) -> Optional[Path]:
    normalized = str(image_url or "").strip()
    if not normalized:
        return None
    if normalized.startswith("/static/images/"):
        return get_static_images_dir() / Path(normalized).name
    return None


def _split_external_terms(value: Optional[str]) -> List[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    terms = [
        item.strip(" \t\r\n\"'“”‘’")
        for item in re.split(r"[,，、;；\n\r]+", raw)
        if item.strip(" \t\r\n\"'“”‘’")
    ]
    return list(dict.fromkeys(terms))[:12]


def _build_external_dynamic_logo_intent(request: CreateNoteJobRequest) -> str:
    product_name = str(request.product_name or "").strip()
    if not product_name:
        return ""

    allowed_terms = [product_name]
    if product_name.endswith("助手") and len(product_name) > 2:
        allowed_terms.append(product_name[:-2])
    allowed_terms.extend(_split_external_terms(request.must_include))
    allowed_terms = list(dict.fromkeys(term for term in allowed_terms if term))[:8]

    banned_terms = _split_external_terms(request.banned_terms)
    if product_name == "壹伴助手":
        banned_terms.extend(["微伴", "一伴", "壹拌", "壹伴帮手", "微伴助手"])
    banned_terms = list(dict.fromkeys(term for term in banned_terms if term and term not in allowed_terms))[:12]

    allowed_text = "、".join(f"「{term}」" for term in allowed_terms)
    lines = [
        "品牌 Logo 视觉约束：",
        f"- 如画面出现品牌或 Logo 区域，品牌文字只能使用 {allowed_text}，必须准确清晰。",
        "- 不要生成其他产品、竞品、错别字或乱码 Logo；不要把 URL、二维码、手机号或邮箱放在 Logo 附近。",
    ]
    if banned_terms:
        lines.append(f"- 严禁在 Logo/品牌区写成：{'、'.join(f'「{term}」' for term in banned_terms)}。")
    if product_name == "壹伴助手":
        lines.append("- Logo 图标必须使用壹伴官方风格：绿色圆形底，中间是白色几何 Y 形/折角标识；不要画成叶子、对勾、纸飞机或普通圆形图标。")
    return "\n".join(lines)


def _build_external_dynamic_style_params(request: CreateNoteJobRequest, resolved_image_mode: str) -> Optional[Dict[str, Any]]:
    if resolved_image_mode != "image2_dynamic":
        return None
    logo_intent = _build_external_dynamic_logo_intent(request)
    if not logo_intent:
        return None
    return {
        "intent": logo_intent,
        "external_api_logo_guardrail": logo_intent,
    }


def _is_public_http_url(url: str) -> bool:
    try:
        parsed = urlparse(str(url or "").strip())
        if parsed.scheme not in {"http", "https"}:
            return False
        hostname = (parsed.hostname or "").strip().lower()
        if not hostname or hostname in {"localhost", "0.0.0.0"} or hostname.endswith(".local"):
            return False
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        except ValueError:
            if re.match(r"^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)", hostname):
                return False
        return True
    except Exception:
        return False


def _extract_logo_reference_urls(urls: List[str], *, limit: int = 4) -> List[str]:
    candidates: List[str] = []
    for url in _normalize_product_urls(urls):
        parsed = urlparse(url)
        path = (parsed.path or "").lower()
        if not _is_public_http_url(url):
            continue
        if not path.endswith((".png", ".jpg", ".jpeg", ".webp")):
            continue
        candidates.append(url)
    return list(dict.fromkeys(candidates))[:limit]


def _external_logo_reference_urls(request: CreateNoteJobRequest) -> List[str]:
    explicit_urls = _extract_logo_reference_urls(request.logo_reference_urls, limit=4)
    if explicit_urls:
        return explicit_urls
    return _extract_logo_reference_urls(request.product_urls, limit=2)


def _logo_fix_reference_urls(request: LogoFixJobRequest) -> List[str]:
    return _extract_logo_reference_urls(request.logo_reference_urls, limit=4)


def _builtin_logo_reference_paths(product_name: str) -> List[Path]:
    normalized = str(product_name or "").strip()
    if normalized == "壹伴助手":
        return [
            path
            for path in (
                _BUILTIN_BRAND_LOGO_DIR / "yiban_logo_combined.png",
                _BUILTIN_BRAND_LOGO_DIR / "yiban_icon.png",
            )
            if path.exists()
        ]
    return []


def _resize_image_for_qc(image_path: Path, *, max_width: int = 384) -> str:
    from io import BytesIO
    from PIL import Image

    with Image.open(image_path) as image:
        image = image.convert("RGB")
        if image.width > max_width:
            resized_height = max(1, round(image.height * max_width / image.width))
            image = image.resize((max_width, resized_height), Image.LANCZOS)
        buffer = BytesIO()
        image.save(buffer, format="JPEG", quality=82)
        encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{encoded}"


def _build_external_logo_qc_prompt(request: CreateNoteJobRequest) -> str:
    product_name = str(request.product_name or "").strip() or "产品"
    allowed_terms = [product_name]
    if product_name.endswith("助手") and len(product_name) > 2:
        allowed_terms.append(product_name[:-2])
    allowed_terms.extend(_split_external_terms(request.must_include))
    allowed_terms = list(dict.fromkeys(term for term in allowed_terms if term))[:8]

    banned_terms = _split_external_terms(request.banned_terms)
    if product_name == "壹伴助手":
        banned_terms.extend(["微伴", "一伴", "壹拌", "壹伴帮手", "微伴助手"])
    banned_terms = list(dict.fromkeys(term for term in banned_terms if term and term not in allowed_terms))[:12]

    allowed_text = "、".join(f"「{term}」" for term in allowed_terms)
    logo_shape_rule = ""
    if product_name == "壹伴助手":
        logo_shape_rule = """
我会先提供 1-2 张官方 logo 参考图，标注为 official_logo_reference。请以参考图为准，不要只按文字想象。
壹伴官方图形要求：绿色圆形底，中间是白色几何 Y 形/折角标识，比例和 official_logo_reference 接近。
不要把「绿色圆形 + 白色图案」泛泛判定为正确；白色图案必须明确是参考图里的 Y 形/折角结构。
壹伴官方图形不是叶子、不是对勾、不是数字 7、不是纸飞机/箭头、不是发送按钮、不是盾牌、也不是普通装饰圆标。
如果看起来像绿色圆底白色对勾、数字 7、箭头、发送按钮、纸飞机、叶子、盾牌或普通装饰圆标，即使颜色和品牌字正确，也必须判 suspect，need_fix=true。
以下都必须判为 suspect，need_fix=true：叶子、对勾、数字 7、纸飞机/箭头、发送按钮、盾牌、普通装饰圆标、绿色胶囊底上的随意白色符号、只有品牌文字但没有可核验图形。
宁可把不确定的相似图标判为 suspect，也不要把「像对勾/像 7/像箭头」的图标判 ok。
请检查画面里所有出现的品牌/logo位置，包括角标、侧边栏、按钮、界面 mockup 内的小图标；只要任意一个「壹伴助手/壹伴」旁边或界面里的 logo 图形不符合 official_logo_reference，就不能判 ok。
只要品牌文字是「壹伴助手」但图形标识和 official_logo_reference 明显不一致，也必须判为 suspect，need_fix=true。
"""

    prompt = f"""你是品牌 Logo 质检员。请检查这些小红书海报中是否出现「{product_name}」品牌标识，以及是否明显错误。只判断品牌/logo区域，不要评价设计。

官方可接受：{allowed_text}。
错误示例：{"、".join(banned_terms) if banned_terms else "错别字、乱码、其他品牌、URL 字符串被画进图里"}。
{logo_shape_rule}

请返回严格 JSON：
{{"items":[{{"index":1,"detected_brand_text":"...","detected_logo_shape":"...","status":"ok|suspect|missing","need_fix":true/false,"reason":"..."}}],"summary":"..."}}
"""
    return prompt.strip()


def _build_external_logo_fix_prompt(request: CreateNoteJobRequest, qc_item: Dict[str, Any]) -> str:
    product_name = str(request.product_name or "").strip() or "产品"
    allowed_terms = [product_name]
    if product_name.endswith("助手") and len(product_name) > 2:
        allowed_terms.append(product_name[:-2])
    allowed_terms.extend(_split_external_terms(request.must_include))
    allowed_terms = list(dict.fromkeys(term for term in allowed_terms if term))[:8]

    banned_terms = _split_external_terms(request.banned_terms)
    if product_name == "壹伴助手":
        banned_terms.extend(["微伴", "一伴", "壹拌", "壹伴帮手", "微伴助手"])
    banned_terms = list(dict.fromkeys(term for term in banned_terms if term and term not in allowed_terms))[:12]

    allowed_text = "、".join(f"「{term}」" for term in allowed_terms)
    reason = str(qc_item.get("reason") or "").strip()
    lines = [
        "把图里的品牌 logo 换成参考图里的 logo。其他内容、文案、版式、卡片、背景和功能图标保持不变。",
        f"品牌文字只能是 {allowed_text}，必须清晰准确。",
    ]
    if reason:
        lines.append(f"质检指出的问题：{reason}")
    if banned_terms:
        lines.append(f"不要写成这些错误品牌名：{'、'.join(f'「{term}」' for term in banned_terms)}。")
    if product_name == "壹伴助手":
        lines.append("参考图是壹伴官方 logo；替换后的 logo 必须是绿色圆形底，白色几何 Y 形/折角标识，比例接近参考图。不要画成叶子、对勾、数字7、纸飞机、箭头、盾牌或普通圆形图标。")
    lines.append("不要新增二维码、条形码、手机号、URL、邮箱或水印。")
    return " ".join(lines)


def _build_external_logo_postprocess_summary(
    qc_items: List[Dict[str, Any]],
    *,
    qc_summary: Optional[Dict[str, Any]] = None,
    auto_fix_summary: Optional[Dict[str, Any]] = None,
    postprocess_error: Optional[str] = None,
) -> Dict[str, Any]:
    need_fix = sum(1 for item in qc_items if item.get("need_fix"))
    fixed = int((auto_fix_summary or {}).get("fixed") or 0)
    failed = int((auto_fix_summary or {}).get("failed") or 0)
    skipped = int((auto_fix_summary or {}).get("skipped") or sum(1 for item in qc_items if not item.get("need_fix")))
    summary: Dict[str, Any] = {
        "qc_ran": bool((qc_summary or {}).get("qc_ran", False)),
        "auto_fix_ran": bool((auto_fix_summary or {}).get("auto_fix_ran", False)),
        "total": len(qc_items),
        "need_fix": need_fix,
        "fixed": fixed,
        "failed": failed,
        "skipped": skipped,
        "reference_logo_count": max(
            int((qc_summary or {}).get("reference_logo_count") or 0),
            int((auto_fix_summary or {}).get("reference_logo_count") or 0),
        ),
    }
    if qc_summary:
        if qc_summary.get("qc_summary"):
            summary["qc_summary"] = str(qc_summary.get("qc_summary") or "").strip()
        if qc_summary.get("qc_error"):
            summary["qc_error"] = str(qc_summary.get("qc_error") or "").strip()
        if qc_summary.get("reason"):
            summary["qc_reason"] = str(qc_summary.get("reason") or "").strip()
    if auto_fix_summary:
        if auto_fix_summary.get("fix_reason"):
            summary["fix_reason"] = str(auto_fix_summary.get("fix_reason") or "").strip()
        if auto_fix_summary.get("postprocess_error"):
            summary["postprocess_error"] = str(auto_fix_summary.get("postprocess_error") or "").strip()
    if postprocess_error:
        summary["postprocess_error"] = str(postprocess_error).strip()
    return summary


def _normalize_external_logo_qc_item(
    item: Dict[str, Any],
    *,
    product_name: str,
) -> Dict[str, Any]:
    status = str(item.get("status") or "unknown").strip().lower()
    need_fix = bool(item.get("need_fix")) or status in {"suspect", "missing", "partial", "fail"}
    detected_logo_shape = str(item.get("detected_logo_shape") or "").strip()
    reason = str(item.get("reason") or "").strip()

    if product_name == "壹伴助手":
        shape_context = f"{detected_logo_shape}\n{reason}"
        forbidden_term = next((term for term in YIBAN_LOGO_FORBIDDEN_SHAPE_TERMS if term in shape_context), "")
        if forbidden_term:
            status = "suspect"
            need_fix = True
            reason_suffix = f"壹伴 Logo 图形命中禁用形态「{forbidden_term}」，需按官方参考图修正。"
            reason = f"{reason} {reason_suffix}".strip() if reason else reason_suffix
        elif status == "ok" and not any(term in detected_logo_shape for term in YIBAN_LOGO_REQUIRED_SHAPE_TERMS):
            status = "suspect"
            need_fix = True
            reason_suffix = "壹伴 Logo 图形描述未明确包含 Y 形/折角结构，需按官方参考图复核修正。"
            reason = f"{reason} {reason_suffix}".strip() if reason else reason_suffix

    return {
        "status": status if status in {"ok", "suspect", "missing", "partial", "fail"} else "unknown",
        "need_fix": need_fix,
        "detected_brand_text": str(item.get("detected_brand_text") or "").strip(),
        "detected_logo_shape": detected_logo_shape,
        "reason": reason,
    }


async def _download_external_logo_reference_assets(request: CreateNoteJobRequest, image_task_id: str) -> List[str]:
    reference_urls = _external_logo_reference_urls(request)
    downloaded: List[str] = [str(path) for path in _builtin_logo_reference_paths(request.product_name)]
    if not reference_urls:
        return downloaded

    temp_dir = Path(tempfile.mkdtemp(prefix=f"{image_task_id}_logo_refs_"))
    for index, url in enumerate(reference_urls, start=1):
        parsed = urlparse(url)
        suffix = (Path(parsed.path).suffix or ".png").lower()
        destination = temp_dir / f"logo_ref_{index}{suffix}"
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
            destination.write_bytes(response.content)
            from PIL import Image
            with Image.open(destination) as image:
                image.verify()
            downloaded.append(str(destination))
        except Exception as error:
            logger.warning("[ExternalNoteJob] 下载 Logo 参考失败: url=%s, error=%s", url, error)
    return downloaded


async def _download_logo_fix_reference_assets(request: LogoFixJobRequest, image_task_id: str) -> List[str]:
    reference_urls = _logo_fix_reference_urls(request)
    downloaded: List[str] = [str(path) for path in _builtin_logo_reference_paths(request.product_name)]
    if not reference_urls:
        return downloaded

    temp_dir = Path(tempfile.mkdtemp(prefix=f"{image_task_id}_logo_fix_refs_"))
    for index, url in enumerate(reference_urls, start=1):
        parsed = urlparse(url)
        suffix = (Path(parsed.path).suffix or ".png").lower()
        destination = temp_dir / f"logo_ref_{index}{suffix}"
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
            destination.write_bytes(response.content)
            from PIL import Image
            with Image.open(destination) as image:
                image.verify()
            downloaded.append(str(destination))
        except Exception as error:
            logger.warning("[ExternalLogoFixJob] 下载 Logo 参考失败: url=%s, error=%s", url, error)
    return downloaded


async def _run_external_logo_quality_checks(
    *,
    request: CreateNoteJobRequest,
    image_paths: List[Path],
    image_task_id: str,
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    if not getattr(settings, "EXTERNAL_IMAGE_LOGO_QC_ENABLED", True):
        return [], {
            "qc_ran": False,
            "total": 0,
            "need_fix": 0,
            "fixed": 0,
            "failed": 0,
            "skipped": 0,
            "reason": "disabled",
        }
    if not image_paths:
        return [], {
            "qc_ran": False,
            "total": 0,
            "need_fix": 0,
            "fixed": 0,
            "failed": 0,
            "skipped": 0,
            "reason": "no-images",
        }

    api_key, base_url = resolve_text_generation_config()
    reference_logo_paths = await _download_external_logo_reference_assets(request, image_task_id)
    prompt = _build_external_logo_qc_prompt(request)
    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    for ref_index, logo_path_value in enumerate(reference_logo_paths, start=1):
        logo_path = Path(logo_path_value)
        content.append({"type": "text", "text": f"official_logo_reference_{ref_index}: {logo_path.name}"})
        content.append({"type": "image_url", "image_url": {"url": _resize_image_for_qc(logo_path, max_width=256)}})
    for index, image_path in enumerate(image_paths, start=1):
        content.append({"type": "text", "text": f"image_{index}: {image_path.name}"})
        content.append({"type": "image_url", "image_url": {"url": _resize_image_for_qc(image_path)}})

    def _invoke() -> str:
        from openai import OpenAI

        client = OpenAI(
            api_key=api_key,
            base_url=base_url,
            timeout=getattr(settings, "EXTERNAL_IMAGE_LOGO_QC_TIMEOUT_SECONDS", 120),
            default_headers={"Accept-Encoding": "identity"},
        )
        response = client.chat.completions.create(
            model=getattr(settings, "TEXT_GEN_MODEL", "gpt-5.4"),
            messages=[{"role": "user", "content": content}],
            temperature=0,
            max_tokens=1200,
            timeout=getattr(settings, "EXTERNAL_IMAGE_LOGO_QC_TIMEOUT_SECONDS", 120),
        )
        content_text = response.choices[0].message.content if response.choices else None
        if content_text is None or not str(content_text).strip():
            raise ValueError("Logo QC 模型未返回内容")
        return str(content_text)

    try:
        raw_text = await asyncio.to_thread(_invoke)
        parsed = clean_and_parse_ai_json(raw_text)
        raw_items = parsed.get("items") if isinstance(parsed, dict) else []
        item_map = {
            int(item.get("index") or 0): item
            for item in raw_items
            if isinstance(item, dict) and str(item.get("index") or "").strip()
        }
        normalized_items: List[Dict[str, Any]] = []
        for index, image_path in enumerate(image_paths, start=1):
            item = item_map.get(index) or {}
            normalized_qc = _normalize_external_logo_qc_item(
                item,
                product_name=str(request.product_name or "").strip(),
            )
            normalized_items.append({
                "index": index,
                "file_name": image_path.name,
                "status": normalized_qc["status"],
                "need_fix": normalized_qc["need_fix"],
                "detected_brand_text": normalized_qc["detected_brand_text"],
                "detected_logo_shape": normalized_qc["detected_logo_shape"],
                "reason": normalized_qc["reason"],
                "fix_status": "pending" if normalized_qc["need_fix"] else "skipped",
                "fix_error": None,
            })
        summary = {
            "qc_ran": True,
            "total": len(normalized_items),
            "need_fix": sum(1 for item in normalized_items if item["need_fix"]),
            "fixed": 0,
            "failed": 0,
            "skipped": sum(1 for item in normalized_items if not item["need_fix"]),
            "reference_logo_count": len(reference_logo_paths),
            "qc_summary": str(parsed.get("summary") or "").strip() if isinstance(parsed, dict) else "",
        }
        return normalized_items, summary
    except Exception as error:
        logger.warning("[ExternalNoteJob] Logo 质检失败: task_id=%s, error=%s", image_task_id, error)
        fallback_items = []
        for index, image_path in enumerate(image_paths, start=1):
            fallback_items.append({
                "index": index,
                "file_name": image_path.name,
                "status": "unknown",
                "need_fix": False,
                "detected_brand_text": "",
                "reason": f"logo QC unavailable: {error}",
                "fix_status": "skipped",
                "fix_error": str(error),
            })
        summary = {
            "qc_ran": False,
            "total": len(fallback_items),
            "need_fix": 0,
            "fixed": 0,
            "failed": 0,
            "skipped": len(fallback_items),
            "reference_logo_count": len(reference_logo_paths),
            "qc_error": str(error),
        }
        return fallback_items, summary


async def _auto_fix_external_logo_images(
    *,
    request: CreateNoteJobRequest,
    client_id: str,
    image_task_id: str,
    image_paths: List[Path],
    qc_items: List[Dict[str, Any]],
    deadline_monotonic: Optional[float] = None,
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    if not getattr(settings, "EXTERNAL_IMAGE_LOGO_AUTO_FIX_ENABLED", True):
        return qc_items, {
            "auto_fix_ran": False,
            "total": len(qc_items),
            "need_fix": sum(1 for item in qc_items if item.get("need_fix")),
            "fixed": 0,
            "failed": 0,
            "skipped": sum(1 for item in qc_items if not item.get("need_fix")),
            "reference_logo_count": 0,
            "reason": "disabled",
        }
    if not image_paths or not qc_items:
        return qc_items, {
            "auto_fix_ran": False,
            "total": len(qc_items),
            "need_fix": sum(1 for item in qc_items if item.get("need_fix")),
            "fixed": 0,
            "failed": 0,
            "skipped": sum(1 for item in qc_items if not item.get("need_fix")),
            "reference_logo_count": 0,
            "reason": "no-images",
        }

    reference_logo_paths = await _download_external_logo_reference_assets(request, image_task_id)
    api_key, base_url, model, fallback_api_key, fallback_base_url, fallback_model = visual.resolve_image_edit_config()
    provider = visual._resolve_image_provider(base_url)
    generator = ImageGenerator(
        api_key=api_key,
        base_url=base_url,
        model=model,
        provider=provider,
    )

    fixed_count = 0
    failed_count = 0
    timed_out_count = 0
    budget_exhausted = False
    for item in qc_items:
        if not item.get("need_fix"):
            continue
        if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
            item["fix_status"] = "skipped"
            item["fix_error"] = "logo fix budget exhausted"
            timed_out_count += 1
            budget_exhausted = True
            continue
        index = int(item.get("index") or 0)
        if index < 1 or index > len(image_paths):
            item["fix_status"] = "failed"
            item["fix_error"] = "image index out of range"
            failed_count += 1
            continue

        source_path = image_paths[index - 1]
        candidate_seed = f"{image_task_id}:logo-fix:{index}"
        support_paths = reference_logo_paths[:4]
        prompt = _build_external_logo_fix_prompt(request, item)

        try:
            per_image_timeout = max(1, int(getattr(settings, "EXTERNAL_IMAGE_LOGO_FIX_TIMEOUT_SECONDS", 180)))
            if deadline_monotonic is not None:
                remaining_budget = deadline_monotonic - time.monotonic()
                if remaining_budget <= 0:
                    raise asyncio.TimeoutError()
                per_image_timeout = max(1, min(per_image_timeout, int(remaining_budget)))
            async with image_job_slot(
                f"{image_task_id}:logo-fix:{index}",
                job_type="image_edit",
                label=model,
                owner_id=client_id,
                policy_key="logo_replacement",
            ):
                repaired_paths = await asyncio.wait_for(
                    asyncio.to_thread(
                        generator.edit_image,
                        str(source_path),
                        prompt,
                        str(source_path.parent),
                        "3:4",
                        "1K",
                        support_paths,
                        False,
                        "logo_replacement",
                        candidate_seed,
                        index - 1,
                        None,
                    ),
                    timeout=per_image_timeout,
                )
            if not repaired_paths:
                raise RuntimeError("logo fix returned no image")

            repaired_path = Path(repaired_paths[0])
            shutil.copy2(repaired_path, source_path)
            item["fix_status"] = "fixed"
            item["fix_error"] = None
            fixed_count += 1
        except asyncio.TimeoutError:
            logger.warning("[ExternalNoteJob] Logo 修图超时: task_id=%s, index=%s", image_task_id, index)
            item["fix_status"] = "failed"
            item["fix_error"] = "logo fix timed out"
            failed_count += 1
            timed_out_count += 1
            if deadline_monotonic is not None and time.monotonic() >= deadline_monotonic:
                budget_exhausted = True
        except Exception as error:
            logger.warning("[ExternalNoteJob] Logo 修图失败: task_id=%s, index=%s, error=%s", image_task_id, index, error)
            item["fix_status"] = "failed"
            item["fix_error"] = str(error)
            failed_count += 1

    summary = {
        "auto_fix_ran": True,
        "total": len(qc_items),
        "need_fix": sum(1 for item in qc_items if item.get("need_fix")),
        "fixed": fixed_count,
        "failed": failed_count,
        "skipped": sum(1 for item in qc_items if not item.get("need_fix")),
        "reference_logo_count": len(reference_logo_paths),
        "timed_out": timed_out_count,
        "budget_exhausted": budget_exhausted,
    }
    return qc_items, summary


async def _write_data_url_to_png(data_url: str, destination: Path) -> None:
    header, encoded = data_url.split(",", 1)
    if ";base64" in header:
        destination.write_bytes(base64.b64decode(encoded))
        return

    rasterized = await scraper.rasterize_template(scraper.RasterizeTemplateRequest(data_url=data_url))
    destination.write_bytes(rasterized.body)


def _persist_task(task_id: str) -> None:
    snapshot = task_manager.get_task(task_id)
    if snapshot:
        save_task_snapshot(snapshot)


def get_external_note_job_runner_stats() -> Dict[str, Any]:
    return {
        "concurrency_limit": EXTERNAL_NOTE_JOB_MAX_CONCURRENCY,
        "per_client_concurrency_limit": EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT,
        "queue_max_size": EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE,
        "active": _EXTERNAL_NOTE_JOB_ACTIVE,
        "waiting": _EXTERNAL_NOTE_JOB_WAITING,
        "completed": _EXTERNAL_NOTE_JOB_COMPLETED,
        "failed": _EXTERNAL_NOTE_JOB_FAILED,
        "available_slots": max(0, EXTERNAL_NOTE_JOB_MAX_CONCURRENCY - _EXTERNAL_NOTE_JOB_ACTIVE),
        "active_by_client": dict(_EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT),
        "waiting_by_client": dict(_EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT),
    }


def can_accept_external_note_job(client_id: str) -> Tuple[bool, str]:
    normalized_client_id = str(client_id or "").strip()
    total_pending = _EXTERNAL_NOTE_JOB_ACTIVE + _EXTERNAL_NOTE_JOB_WAITING
    if total_pending >= EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE:
        return False, "外部 API 任务队列已满，请稍后再提交"

    client_pending = (
        _EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT.get(normalized_client_id, 0)
        + _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT.get(normalized_client_id, 0)
    )
    client_queue_limit = max(EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT, EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE)
    if client_pending >= client_queue_limit:
        return False, "当前 API Key 的外部任务队列已满，请稍后再提交"

    return True, ""


@asynccontextmanager
async def external_note_job_slot(
    *,
    batch_id: str,
    client_id: str,
    text_task_id: str,
    image_task_id: str,
) -> AsyncIterator[float]:
    global _EXTERNAL_NOTE_JOB_ACTIVE, _EXTERNAL_NOTE_JOB_WAITING
    global _EXTERNAL_NOTE_JOB_COMPLETED, _EXTERNAL_NOTE_JOB_FAILED

    normalized_client_id = str(client_id or "").strip()
    queued_at = time.monotonic()
    client_semaphore = _EXTERNAL_NOTE_JOB_CLIENT_SEMAPHORES[normalized_client_id]
    _EXTERNAL_NOTE_JOB_WAITING += 1
    _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT[normalized_client_id] = (
        _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT.get(normalized_client_id, 0) + 1
    )
    global_acquired = False
    client_acquired = False
    try:
        await _update_task(
            text_task_id,
            progress=0,
            message="等待外部 API 任务执行名额...",
            metadata={"stage": "external_queue_wait", "external_runner": get_external_note_job_runner_stats()},
        )
        await _update_task(
            image_task_id,
            progress=0,
            message="等待外部 API 任务执行名额...",
            metadata={"stage": "external_queue_wait", "external_runner": get_external_note_job_runner_stats()},
        )
        await client_semaphore.acquire()
        client_acquired = True
        await _EXTERNAL_NOTE_JOB_SEMAPHORE.acquire()
        global_acquired = True
    except Exception:
        _EXTERNAL_NOTE_JOB_WAITING = max(0, _EXTERNAL_NOTE_JOB_WAITING - 1)
        next_waiting = max(0, _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT.get(normalized_client_id, 0) - 1)
        if next_waiting:
            _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT[normalized_client_id] = next_waiting
        else:
            _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT.pop(normalized_client_id, None)
        if client_acquired:
            client_semaphore.release()
        raise

    _EXTERNAL_NOTE_JOB_WAITING = max(0, _EXTERNAL_NOTE_JOB_WAITING - 1)
    next_waiting = max(0, _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT.get(normalized_client_id, 0) - 1)
    if next_waiting:
        _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT[normalized_client_id] = next_waiting
    else:
        _EXTERNAL_NOTE_JOB_WAITING_BY_CLIENT.pop(normalized_client_id, None)
    _EXTERNAL_NOTE_JOB_ACTIVE += 1
    _EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT[normalized_client_id] = (
        _EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT.get(normalized_client_id, 0) + 1
    )
    queue_wait_seconds = time.monotonic() - queued_at
    started_at = time.monotonic()
    logger.info(
        "[ExternalNoteJobRunner] start batch_id=%s client=%s active=%s waiting=%s concurrency_limit=%s per_client_limit=%s queue_wait=%.3fs",
        batch_id,
        normalized_client_id,
        _EXTERNAL_NOTE_JOB_ACTIVE,
        _EXTERNAL_NOTE_JOB_WAITING,
        EXTERNAL_NOTE_JOB_MAX_CONCURRENCY,
        EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT,
        queue_wait_seconds,
    )
    succeeded = False
    try:
        yield queue_wait_seconds
        succeeded = True
    finally:
        runtime_seconds = time.monotonic() - started_at
        _EXTERNAL_NOTE_JOB_ACTIVE = max(0, _EXTERNAL_NOTE_JOB_ACTIVE - 1)
        next_active = max(0, _EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT.get(normalized_client_id, 0) - 1)
        if next_active:
            _EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT[normalized_client_id] = next_active
        else:
            _EXTERNAL_NOTE_JOB_ACTIVE_BY_CLIENT.pop(normalized_client_id, None)
        if succeeded:
            _EXTERNAL_NOTE_JOB_COMPLETED += 1
            outcome = "completed"
        else:
            _EXTERNAL_NOTE_JOB_FAILED += 1
            outcome = "failed"
        if global_acquired:
            _EXTERNAL_NOTE_JOB_SEMAPHORE.release()
        if client_acquired:
            client_semaphore.release()
        logger.info(
            "[ExternalNoteJobRunner] finish outcome=%s batch_id=%s client=%s active=%s waiting=%s runtime=%.3fs",
            outcome,
            batch_id,
            normalized_client_id,
            _EXTERNAL_NOTE_JOB_ACTIVE,
            _EXTERNAL_NOTE_JOB_WAITING,
            runtime_seconds,
        )


async def _update_task(
    task_id: str,
    *,
    status: Optional[TaskStatus] = None,
    progress: Optional[int] = None,
    message: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    await task_manager.update_task(
        task_id,
        status=status,
        progress=progress,
        message=message,
        result=result,
        error=error,
        metadata=metadata,
    )
    _persist_task(task_id)
    return task_manager.get_task(task_id) or {}


def _normalize_product_urls(urls: List[str]) -> List[str]:
    normalized: List[str] = []
    for value in urls:
        candidate = str(value or "").strip()
        if not candidate:
            continue
        if not candidate.startswith(("http://", "https://")):
            candidate = f"https://{candidate.lstrip('/')}"
        if candidate not in normalized:
            normalized.append(candidate)
    return normalized


def _stable_hash(value: str) -> int:
    return sum((index + 1) * ord(char) for index, char in enumerate(value))


def _normalize_strategy_identity_part(value: str) -> str:
    normalized = re.sub(r"[^0-9A-Za-z_.:-]+", "-", str(value or "").strip())
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    return normalized or "unknown"


def _resolve_external_strategy_user_id(client_id: str, external_user_id: Optional[str]) -> str:
    client_part = _normalize_strategy_identity_part(client_id)
    user_part = _normalize_strategy_identity_part(external_user_id or "")
    raw = f"api:{client_part}:{user_part}" if external_user_id else f"api:{client_part}"
    if len(raw) <= _STRATEGY_USER_ID_MAX_LENGTH:
        return raw

    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    readable_user = user_part[:24].strip("-") or "user"
    compact = f"api:{readable_user}:{digest}" if external_user_id else f"api:{digest}"
    return compact[:_STRATEGY_USER_ID_MAX_LENGTH]


def _select_visual_style(
    requested_style: Optional[str],
    *,
    diversity_level: str,
    variation_seed: str,
    perturbation_enabled: bool,
) -> Tuple[str, Dict[str, Any]]:
    base_style = str(requested_style or DEFAULT_VISUAL_STYLE).strip() or DEFAULT_VISUAL_STYLE
    family = VISUAL_STYLE_FAMILIES.get(base_style, [base_style])
    selected_style = base_style

    if perturbation_enabled and diversity_level in {"medium", "high"} and len(family) > 1:
        selected_style = family[_stable_hash(f"visual:{variation_seed}:{base_style}:{diversity_level}") % len(family)]

    return selected_style, {
        "requested_visual_style": base_style,
        "selected_visual_style": selected_style,
        "visual_style_family": family,
    }


def _strategy_matches_requested_style(strategy: Dict[str, Any], requested_style: str) -> bool:
    if requested_style == "auto":
        return True

    visual_direction = str(strategy.get("visualDirection") or "").strip().lower()
    angle = str(strategy.get("contentAngle") or "").strip().lower()
    directions = STRATEGY_STYLE_TO_DIRECTIONS.get(requested_style, [])
    if visual_direction in directions:
        return True
    if requested_style == "review" and ("测评" in angle or "评测" in angle):
        return True
    return False


def _select_note_strategy(
    strategies: List[Dict[str, Any]],
    *,
    requested_style: str,
    selected_strategy_id: str,
    diversity_level: str,
    variation_seed: str,
    perturbation_enabled: bool,
) -> Tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    if not strategies:
        return None, {
            "requested_strategy_style": requested_style,
            "selected_strategy_style": requested_style,
            "selected_strategy_id": "",
            "strategy_candidates": [],
        }

    matching = [item for item in strategies if _strategy_matches_requested_style(item, requested_style)]
    if not matching:
        matching = strategies

    preferred = next((item for item in matching if str(item.get("id") or "") == selected_strategy_id), None)
    selected = preferred or matching[0]

    if perturbation_enabled and diversity_level in {"medium", "high"} and len(matching) > 1:
        selected = matching[_stable_hash(f"strategy:{variation_seed}:{requested_style}:{diversity_level}") % len(matching)]

    selected_style = requested_style
    if requested_style == "auto":
        selected_style = str(selected.get("visualDirection") or "general").strip().lower() or "general"

    return selected, {
        "requested_strategy_style": requested_style,
        "selected_strategy_style": selected_style,
        "selected_strategy_id": str(selected.get("id") or ""),
        "strategy_candidates": [str(item.get("id") or "") for item in matching],
    }


def _build_variation_hints(
    requested_style: str,
    *,
    diversity_level: str,
    variation_seed: str,
    perturbation_enabled: bool,
) -> List[str]:
    if not perturbation_enabled:
        return []

    normalized_style = requested_style if requested_style in VARIATION_HINTS else "general"
    hint_pool = VARIATION_HINTS.get(normalized_style, VARIATION_HINTS["general"]).get(diversity_level, [])
    if not hint_pool:
        return []
    hint = hint_pool[_stable_hash(f"hint:{variation_seed}:{normalized_style}:{diversity_level}") % len(hint_pool)]
    return [hint]


def _resolve_effective_content_style(request: CreateNoteJobRequest, selected_strategy_style: str) -> str:
    requested_content_style = str(request.content_style or "").strip()
    if requested_content_style:
        return requested_content_style
    return CONTENT_STYLE_BY_STRATEGY.get(selected_strategy_style, DEFAULT_CONTENT_STYLE)


def _compact_text_result_for_storage(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "title": result_payload.get("title"),
        "body": result_payload.get("final_body") or result_payload.get("content"),
        "tags": result_payload.get("tags"),
    }


def _build_image_result(
    image_task_id: str,
    *,
    status: str,
    progress: int,
    message: Optional[str],
    images: List[Dict[str, Any]],
    requested_image_mode: Optional[str],
    visual_mode_resolved: Optional[str],
    artifact_expires_at: Optional[str],
    downloaded_acknowledged: bool,
    deleted_at: Optional[str],
    logo_quality_checks: Optional[List[Dict[str, Any]]] = None,
    logo_fix_summary: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    result = {
        "image_task_id": image_task_id,
        "status": status,
        "progress": progress,
        "message": message,
        "images": images,
        "image_count": len(images),
        "requested_image_mode": requested_image_mode,
        "visual_mode_resolved": visual_mode_resolved,
        "artifact_expires_at": artifact_expires_at,
        "downloaded_acknowledged": downloaded_acknowledged,
        "deleted_at": deleted_at,
    }
    if logo_quality_checks is not None:
        result["logo_quality_checks"] = logo_quality_checks
    if logo_fix_summary is not None:
        result["logo_fix_summary"] = logo_fix_summary
    return result


def _runtime_seconds(started_at: Optional[str], completed_at: Optional[str] = None) -> Optional[int]:
    started = _parse_iso_datetime(started_at)
    if not started:
        return None
    completed = _parse_iso_datetime(completed_at) if completed_at else _now_utc()
    if not completed:
        return None
    return max(0, int((completed - started).total_seconds()))


def _get_latest_image_task_snapshot(task_id: str) -> Optional[Dict[str, Any]]:
    memory_task = task_manager.get_task(task_id)
    stored_task = load_task_snapshot(task_id)
    if not memory_task:
        if stored_task:
            task_manager.set_task_snapshot(stored_task)
        return stored_task
    if not stored_task:
        return memory_task

    memory_status = memory_task.get("status")
    stored_status = stored_task.get("status")
    terminal_statuses = {TaskStatus.COMPLETED.value, TaskStatus.FAILED.value, TaskStatus.CANCELLED.value}
    if stored_status in terminal_statuses and memory_status not in terminal_statuses:
        task_manager.set_task_snapshot(stored_task)
        return stored_task
    if stored_task.get("completed_at") and not memory_task.get("completed_at"):
        task_manager.set_task_snapshot(stored_task)
        return stored_task
    return memory_task


def _build_upstream_image_item_statuses(image_task_ids: List[str]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    for fallback_index, upstream_task_id in enumerate(image_task_ids, start=1):
        task = _get_latest_image_task_snapshot(upstream_task_id)
        if not task:
            items.append({
                "index": fallback_index,
                "task_id": upstream_task_id,
                "status": "missing",
                "progress": 0,
                "message": "上游图片任务不存在",
            })
            continue
        metadata = task.get("metadata") or {}
        result = task.get("result") if isinstance(task.get("result"), dict) else {}
        workflow_index = metadata.get("workflow_index")
        try:
            index = int(workflow_index or fallback_index)
        except Exception:
            index = fallback_index
        paths = result.get("paths") if isinstance(result, dict) else None
        images = result.get("images") if isinstance(result, dict) else None
        items.append({
            "index": index,
            "task_id": upstream_task_id,
            "status": task.get("status") or "unknown",
            "progress": int(task.get("progress") or 0),
            "message": task.get("message"),
            "error": task.get("error"),
            "stage": metadata.get("stage"),
            "started_at": task.get("started_at"),
            "completed_at": task.get("completed_at"),
            "runtime_seconds": _runtime_seconds(task.get("started_at"), task.get("completed_at")),
            "prompt_length": len(str(metadata.get("prompt") or "")),
            "image_queue_wait_seconds": metadata.get("image_queue_wait_seconds"),
            "retry_count": metadata.get("retry_count"),
            "external_retry_attempt": metadata.get("external_retry_attempt"),
            "source_task_id": metadata.get("source_task_id"),
            "model": metadata.get("model"),
            "has_image": bool(paths or images),
        })
    return sorted(items, key=lambda item: item.get("index") or 0)


def _group_image_attempt_ids_by_index(image_task_ids: List[str]) -> Dict[int, List[str]]:
    grouped: Dict[int, List[str]] = {}
    for fallback_index, upstream_task_id in enumerate(image_task_ids, start=1):
        task = _get_latest_image_task_snapshot(upstream_task_id)
        metadata = (task or {}).get("metadata") or {}
        try:
            index = int(metadata.get("workflow_index") or fallback_index)
        except Exception:
            index = fallback_index
        grouped.setdefault(index, []).append(upstream_task_id)
    return grouped


def _expected_image_count_from_upstream_tasks(image_task_ids: List[str], fallback_count: int) -> int:
    grouped = _group_image_attempt_ids_by_index(image_task_ids)
    return len(grouped) or fallback_count


def _select_completed_image_sources(image_task_ids: List[str]) -> Dict[int, str]:
    selected: Dict[int, str] = {}
    for fallback_index, upstream_task_id in enumerate(image_task_ids, start=1):
        task = _get_latest_image_task_snapshot(upstream_task_id)
        if not task or task.get("status") != TaskStatus.COMPLETED.value:
            continue
        metadata = task.get("metadata") or {}
        try:
            index = int(metadata.get("workflow_index") or fallback_index)
        except Exception:
            index = fallback_index
        if index in selected:
            continue
        first_image = str(((task.get("result") or {}).get("images") or [""])[0] or "").strip()
        if first_image:
            selected[index] = first_image
    return selected


async def _start_external_image_retry_attempt(
    *,
    source_task_id: str,
    attempt_number: int,
) -> Optional[str]:
    source_task = task_manager.get_task(source_task_id) or load_task_snapshot(source_task_id)
    if not source_task:
        return None
    metadata = source_task.get("metadata") or {}
    prompt = str(metadata.get("prompt") or "").strip()
    if not prompt:
        return None
    workflow_index = metadata.get("workflow_index")
    workflow_total = metadata.get("workflow_total")
    retry_task_id = task_manager.create_task(
        f"生成图片 {workflow_index or '?'} 重试 {attempt_number}",
        metadata={
            **metadata,
            "source_task_id": source_task_id,
            "external_retry_attempt": attempt_number,
            "stage": "pending",
            "retry_stage": "external_slow_retry_pending",
            "retry_count": attempt_number - 1,
        },
    )
    _persist_task(retry_task_id)
    asyncio.create_task(
        visual.run_generate_task(
            retry_task_id,
            prompt,
            1,
            str(metadata.get("aspect_ratio") or "3:4"),
            str(metadata.get("image_size") or "1K"),
        )
    )
    logger.info(
        "[ExternalNoteJob] started slow image retry: source_task_id=%s retry_task_id=%s workflow_index=%s/%s attempt=%s",
        source_task_id,
        retry_task_id,
        workflow_index,
        workflow_total,
        attempt_number,
    )
    return retry_task_id


def _extract_text_context_for_image_task(result_payload: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "title": result_payload.get("title"),
        "final_body": result_payload.get("final_body"),
        "note_visual_plan": result_payload.get("note_visual_plan"),
        "selected_visual_style": result_payload.get("selected_visual_style"),
        "variation_seed": result_payload.get("variation_seed"),
        "variation_hints": result_payload.get("variation_hints"),
        "product_brief": result_payload.get("product_brief"),
    }


def _resolve_external_target_image_count(
    note_visual_plan: Optional[Dict[str, Any]],
    *,
    resolved_image_mode: str,
    requested_image_count: int = 3,
    image_count_provided: bool = False,
    note_strategy: Optional[Dict[str, Any]] = None,
) -> int:
    if resolved_image_mode == "image2_dynamic":
        if image_count_provided:
            return max(1, min(int(requested_image_count or 4), 4))
        return 4

    if resolved_image_mode != "concept":
        return 1

    card_plan = list((note_visual_plan or {}).get("card_plan") or [])
    if not card_plan:
        return 3

    card_types = [str(item.get("card_type") or "") for item in card_plan if isinstance(item, dict)]
    visual_direction = str((note_strategy or {}).get("visualDirection") or "").lower()

    if "对比卡" in card_types or any(keyword in visual_direction for keyword in ("compare", "contrast", "before_after")):
        return 4

    if card_types.count("步骤卡") >= 2 or visual_direction == "tutorial" or any(keyword in visual_direction for keyword in ("step", "guide", "tutorial")):
        return 4

    if len(card_types) <= 3:
        return 3

    # 默认取 4，避免把整套 6 页都当作必须出图数量。
    return 4


def _get_task(task_id: str) -> Optional[Dict[str, Any]]:
    task = task_manager.get_task(task_id) or load_task_snapshot(task_id)
    if not task:
        return None
    task_manager.set_task_snapshot(task)
    return task_manager.get_task(task_id) or task


def _assert_client_access(task: Dict[str, Any], client_id: str) -> None:
    task_client_id = str(((task.get("metadata") or {}).get("client_id")) or "").strip()
    if task_client_id and task_client_id != client_id:
        raise HTTPException(status_code=403, detail="无权访问该任务")


def _resolve_external_image_mode(requested_mode: Optional[str]) -> str:
    try:
        resolved_mode = visual.resolve_visual_mode(requested_mode, strict=True)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    if resolved_mode not in EXTERNALLY_ENABLED_IMAGE_MODES:
        supported_inputs: List[str] = []
        for mode_name in EXTERNALLY_ENABLED_IMAGE_MODES:
            aliases = sorted(visual.VISUAL_MODE_ALIASES.get(mode_name, set()))
            for alias in aliases:
                if alias not in supported_inputs:
                    supported_inputs.append(alias)
        supported = " / ".join(supported_inputs) or "概念表达"
        raise HTTPException(
            status_code=400,
            detail=f"当前外部 API 暂只支持 image_mode={supported}，收到 {requested_mode}",
        )

    return resolved_mode


def cleanup_expired_external_artifacts() -> int:
    root = _external_artifacts_root()
    removed = 0
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        task_id = entry.name
        task = _get_task(task_id)
        if not task:
            continue
        metadata = task.get("metadata") or {}
        if metadata.get("task_kind") != "external_image_job":
            continue
        result = task.get("result") or {}
        if not isinstance(result, dict):
            continue
        expires_at = result.get("artifact_expires_at")
        if _artifact_is_expired(expires_at):
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
            status = task.get("status")
            next_status = TaskStatus.COMPLETED if status == "completed" else TaskStatus.FAILED
            task_manager.update_task_sync(
                task_id,
                status=next_status,
                progress=100,
                message="图片文件已过期清理",
                result={
                    **result,
                    "images": [],
                    "image_count": 0,
                    "deleted_at": result.get("deleted_at") or _now_utc().isoformat(),
                },
                metadata={
                    "lifecycle_status": "deleted",
                },
            )
            _persist_task(task_id)
    return removed


def create_external_note_batch(request: CreateNoteJobRequest, client_id: str) -> Dict[str, str]:
    cleanup_expired_external_artifacts()
    batch_id = str(uuid4())
    variation_seed = request.variation_seed or uuid4().hex[:12]
    resolved_image_mode = _resolve_external_image_mode(request.image_mode)
    strategy_user_id = _resolve_external_strategy_user_id(client_id, request.external_user_id)

    text_task_id = task_manager.create_task(
        "外部笔记文本任务",
        metadata={
            "client_id": client_id,
            "strategy_user_id": strategy_user_id,
            "external_user_id": request.external_user_id,
            "task_kind": "external_text_job",
            "batch_id": batch_id,
            "stage": "pending",
            "variation_seed": variation_seed,
            "requested_strategy_style": request.note_strategy_style,
            "requested_visual_style": request.visual_style or DEFAULT_VISUAL_STYLE,
            "requested_image_mode": request.image_mode,
            "resolved_image_mode": resolved_image_mode,
        },
    )
    image_task_id = task_manager.create_task(
        "外部笔记图片任务",
        metadata={
            "client_id": client_id,
            "strategy_user_id": strategy_user_id,
            "external_user_id": request.external_user_id,
            "task_kind": "external_image_job",
            "batch_id": batch_id,
            "stage": "pending",
            "variation_seed": variation_seed,
            "requested_image_mode": request.image_mode,
            "resolved_image_mode": resolved_image_mode,
            "lifecycle_status": "pending",
            "text_task_id": text_task_id,
        },
    )

    _persist_task(text_task_id)
    _persist_task(image_task_id)

    return {
        "batch_id": batch_id,
        "text_task_id": text_task_id,
        "image_task_id": image_task_id,
    }


def create_external_logo_fix_job(request: LogoFixJobRequest, client_id: str) -> Dict[str, str]:
    if not request.image_urls:
        raise HTTPException(status_code=400, detail="image_urls 不能为空")
    if not request.logo_reference_urls and not _builtin_logo_reference_paths(request.product_name):
        raise HTTPException(status_code=400, detail="logo_reference_urls 不能为空")

    cleanup_expired_external_artifacts()
    image_task_id = task_manager.create_task(
        "外部 Logo 批量修图任务",
        metadata={
            "client_id": client_id,
            "external_user_id": request.external_user_id,
            "task_kind": "external_image_job",
            "external_image_job_type": "logo_fix",
            "stage": "pending",
            "lifecycle_status": "pending",
            "requested_image_count": len(request.image_urls),
        },
    )
    _persist_task(image_task_id)
    return {"image_task_id": image_task_id}


async def _run_background_tasks(tasks: BackgroundTasks) -> None:
    await tasks()


async def run_external_logo_fix_job(
    image_task_id: str,
    request: LogoFixJobRequest,
    client_id: str,
) -> None:
    images: List[Dict[str, Any]] = []
    try:
        await _update_task(
            image_task_id,
            status=TaskStatus.RUNNING,
            progress=10,
            message="正在下载待修图片",
            result=_build_image_result(
                image_task_id,
                status="running",
                progress=10,
                message="正在下载待修图片",
                images=[],
                requested_image_mode="logo_fix",
                visual_mode_resolved="logo_replacement",
                artifact_expires_at=None,
                downloaded_acknowledged=False,
                deleted_at=None,
            ),
            metadata={"stage": "download_inputs", "lifecycle_status": "running"},
        )
        images = await _download_external_image_inputs(image_task_id, request.image_urls)
        image_paths = [_image_file_path(image_task_id, item["index"]) for item in images]
        reference_logo_paths = await _download_logo_fix_reference_assets(request, image_task_id)
        if not reference_logo_paths:
            raise RuntimeError("未找到可用 Logo 参考图")

        await _update_task(
            image_task_id,
            status=TaskStatus.RUNNING,
            progress=30,
            message="正在批量修 Logo",
            result=_build_image_result(
                image_task_id,
                status="running",
                progress=30,
                message="正在批量修 Logo",
                images=images,
                requested_image_mode="logo_fix",
                visual_mode_resolved="logo_replacement",
                artifact_expires_at=None,
                downloaded_acknowledged=False,
                deleted_at=None,
                logo_fix_summary={
                    "auto_fix_ran": True,
                    "total": len(images),
                    "need_fix": len(images),
                    "fixed": 0,
                    "failed": 0,
                    "skipped": 0,
                    "reference_logo_count": len(reference_logo_paths),
                },
            ),
            metadata={"stage": "logo_fix", "lifecycle_status": "running"},
        )

        api_key, base_url, model, _fallback_api_key, _fallback_base_url, _fallback_model = visual.resolve_image_edit_config()
        provider = visual._resolve_image_provider(base_url)
        generator = ImageGenerator(api_key=api_key, base_url=base_url, model=model, provider=provider)
        prompt = str(request.prompt or "").strip() or "把图里的品牌 logo 换成参考图里的 logo。其他内容保持不变。"
        support_paths = reference_logo_paths[:4]
        fixed_count = 0
        failed_count = 0
        items: List[Dict[str, Any]] = []

        for offset, source_path in enumerate(image_paths):
            index = offset + 1
            item = {
                "index": index,
                "file_name": source_path.name,
                "status": "suspect",
                "need_fix": True,
                "detected_brand_text": "",
                "detected_logo_shape": "",
                "reason": "外部 API 指定批量 Logo 修图",
                "fix_status": "pending",
                "fix_error": None,
            }
            items.append(item)
            try:
                async with image_job_slot(
                    f"{image_task_id}:logo-fix:{index}",
                    job_type="image_edit",
                    label=model,
                    owner_id=client_id,
                    policy_key="logo_replacement",
                ):
                    repaired_paths = await asyncio.wait_for(
                        asyncio.to_thread(
                            generator.edit_image,
                            str(source_path),
                            prompt,
                            str(source_path.parent),
                            "3:4",
                            "1K",
                            support_paths,
                            False,
                            "logo_replacement",
                            f"{image_task_id}:logo-fix:{index}",
                            offset,
                            None,
                        ),
                        timeout=getattr(settings, "EXTERNAL_IMAGE_LOGO_FIX_TIMEOUT_SECONDS", 600),
                    )
                if not repaired_paths:
                    raise RuntimeError("logo fix returned no image")
                shutil.copy2(Path(repaired_paths[0]), source_path)
                item["fix_status"] = "fixed"
                fixed_count += 1
            except Exception as error:
                logger.warning("[ExternalLogoFixJob] Logo 修图失败: task_id=%s, index=%s, error=%s", image_task_id, index, error)
                item["fix_status"] = "failed"
                item["fix_error"] = str(error)
                failed_count += 1

            await _update_task(
                image_task_id,
                status=TaskStatus.RUNNING,
                progress=min(95, 30 + int(60 * (index / max(1, len(image_paths))))),
                message=f"正在批量修 Logo（{index}/{len(image_paths)}）",
                result=_build_image_result(
                    image_task_id,
                    status="running",
                    progress=min(95, 30 + int(60 * (index / max(1, len(image_paths))))),
                    message=f"正在批量修 Logo（{index}/{len(image_paths)}）",
                    images=images,
                    requested_image_mode="logo_fix",
                    visual_mode_resolved="logo_replacement",
                    artifact_expires_at=None,
                    downloaded_acknowledged=False,
                    deleted_at=None,
                    logo_quality_checks=items,
                    logo_fix_summary={
                        "auto_fix_ran": True,
                        "total": len(images),
                        "need_fix": len(images),
                        "fixed": fixed_count,
                        "failed": failed_count,
                        "skipped": 0,
                        "reference_logo_count": len(reference_logo_paths),
                    },
                ),
            )

        expires_at = _artifact_expires_at_iso()
        await _update_task(
            image_task_id,
            status=TaskStatus.COMPLETED,
            progress=100,
            message="Logo 批量修图完成，等待确认回执",
            result=_build_image_result(
                image_task_id,
                status="awaiting_ack",
                progress=100,
                message="Logo 批量修图完成，等待确认回执",
                images=images,
                requested_image_mode="logo_fix",
                visual_mode_resolved="logo_replacement",
                artifact_expires_at=expires_at,
                downloaded_acknowledged=False,
                deleted_at=None,
                logo_quality_checks=items,
                logo_fix_summary={
                    "auto_fix_ran": True,
                    "total": len(images),
                    "need_fix": len(images),
                    "fixed": fixed_count,
                    "failed": failed_count,
                    "skipped": 0,
                    "reference_logo_count": len(reference_logo_paths),
                },
            ),
            metadata={"stage": "awaiting_ack", "lifecycle_status": "awaiting_ack", "artifact_expires_at": expires_at},
        )
    except Exception as error:
        logger.warning("[ExternalLogoFixJob] failed: task_id=%s error=%s", image_task_id, error)
        await _update_task(
            image_task_id,
            status=TaskStatus.FAILED,
            progress=100,
            message="Logo 批量修图失败",
            error=str(error),
            result=_build_image_result(
                image_task_id,
                status="failed",
                progress=100,
                message="Logo 批量修图失败",
                images=images,
                requested_image_mode="logo_fix",
                visual_mode_resolved="logo_replacement",
                artifact_expires_at=None,
                downloaded_acknowledged=False,
                deleted_at=None,
            ),
            metadata={"stage": "failed", "lifecycle_status": "failed"},
        )


async def _start_image_workflow(
    *,
    image_task_id: str,
    request: CreateNoteJobRequest,
    client_id: str,
    image_context: Dict[str, Any],
    resolved_image_mode: str,
    target_image_count: int,
    job_started_monotonic: Optional[float] = None,
) -> List[str]:
    title = str(image_context.get("title") or request.product_name).strip()
    content = str(image_context.get("final_body") or "").strip()
    note_visual_plan = image_context.get("note_visual_plan")
    selected_visual_style = str(image_context.get("selected_visual_style") or DEFAULT_VISUAL_STYLE).strip() or DEFAULT_VISUAL_STYLE
    variation_hints = list(image_context.get("variation_hints") or [])
    product_brief = image_context.get("product_brief") or {}
    dynamic_style_params = _build_external_dynamic_style_params(request, resolved_image_mode)

    if resolved_image_mode == "template_compose":
        compose_response = await visual.compose_template_series(
            visual.ComposeTemplateSeriesRequest(
                title=title,
                content=content,
                product_brief=product_brief,
                reference_assets=[],
                primary_reference_asset_id="",
                brand_style=selected_visual_style,
                note_visual_plan=note_visual_plan or None,
                card_count_limit=min(max(request.image_count, 1), 6),
            )
        )
        cards = list((compose_response.data or {}).get("cards") or [])
        return [
            str(((card.get("renderedAsset") or {}).get("url")) or ((card.get("composeResult") or {}).get("rendered_image_url")) or "").strip()
            for card in cards
            if str(((card.get("renderedAsset") or {}).get("url")) or ((card.get("composeResult") or {}).get("rendered_image_url")) or "").strip()
        ]

    background_tasks = BackgroundTasks()
    workflow_response = await visual.analyze_and_generate(
            visual.WorkflowRequest(
                title=title,
                content=content,
                style=selected_visual_style,
                image_count=target_image_count,
                mode=request.image_mode,
                material_summary="；".join(variation_hints),
            reference_summary="",
            reference_assets=[],
            primary_reference_asset_id="",
            prompts=[],
            product_brief=product_brief,
            template_kind=request.template_kind or "",
            dynamic_style_params=dynamic_style_params,
        ),
        background_tasks=background_tasks,
        user_id=client_id,
    )
    asyncio.create_task(_run_background_tasks(background_tasks))

    image_task_ids = list(workflow_response.get("task_ids") or [])
    await _update_task(
        image_task_id,
        progress=40,
        message="图片任务已创建，正在等待生成完成...",
        result=_build_image_result(
            image_task_id,
            status="running",
            progress=40,
                message="图片任务已创建，正在等待生成完成...",
                images=[],
                requested_image_mode=request.image_mode,
                visual_mode_resolved=resolved_image_mode,
                artifact_expires_at=None,
                downloaded_acknowledged=False,
                deleted_at=None,
        ),
        metadata={
            "stage": "image_poll",
            "upstream_image_task_ids": image_task_ids,
            "lifecycle_status": "running",
            "expected_image_count": len(image_task_ids),
            "ready_image_count": 0,
            "image_items": _build_upstream_image_item_statuses(image_task_ids),
        },
    )

    images: List[str] = []
    failed_image_tasks: List[Dict[str, str]] = []
    retry_attempts_by_index: Dict[int, int] = {}
    configured_target_timeout_seconds = max(
        1,
        int(getattr(settings, "EXTERNAL_IMAGE_JOB_TARGET_TIMEOUT_SECONDS", 900)),
    )
    elapsed_job_seconds = int(time.monotonic() - job_started_monotonic) if job_started_monotonic else 0
    image_poll_budget_seconds = max(360, configured_target_timeout_seconds - elapsed_job_seconds - 30)
    timeout_attempts = max(1, int(image_poll_budget_seconds / 2))
    for _attempt in range(timeout_attempts):
        completed_sources = _select_completed_image_sources(image_task_ids)
        completed = len(completed_sources)
        images = [completed_sources[index] for index in sorted(completed_sources)]
        grouped_attempts = _group_image_attempt_ids_by_index(image_task_ids)
        for index, attempt_ids in sorted(grouped_attempts.items()):
            if index in completed_sources:
                continue
            if len(attempt_ids) >= EXTERNAL_IMAGE_MAX_ATTEMPTS_PER_ITEM:
                continue
            oldest_runtime = 0
            retry_source_task_id = ""
            active_attempt_exists = False
            failed_attempt_exists = False
            for attempt_id in attempt_ids:
                task = _get_latest_image_task_snapshot(attempt_id)
                if not task:
                    continue
                if task.get("status") in {TaskStatus.PENDING.value, TaskStatus.RUNNING.value}:
                    active_attempt_exists = True
                if task.get("status") == TaskStatus.FAILED.value:
                    failed_attempt_exists = True
                runtime = _runtime_seconds(task.get("started_at")) or 0
                if runtime > oldest_runtime:
                    oldest_runtime = runtime
                    retry_source_task_id = attempt_id
            next_attempt_number = len(attempt_ids) + 1
            already_started_attempt = retry_attempts_by_index.get(index, 1)
            if (
                (active_attempt_exists or failed_attempt_exists)
                and retry_source_task_id
                and (failed_attempt_exists or oldest_runtime >= EXTERNAL_IMAGE_RETRY_AFTER_SECONDS)
                and next_attempt_number > already_started_attempt
            ):
                retry_task_id = await _start_external_image_retry_attempt(
                    source_task_id=retry_source_task_id,
                    attempt_number=next_attempt_number,
                )
                if retry_task_id:
                    image_task_ids.append(retry_task_id)
                    retry_attempts_by_index[index] = next_attempt_number

        for upstream_task_id in list(image_task_ids):
            task = _get_latest_image_task_snapshot(upstream_task_id)
            if not task:
                continue
            task_manager.set_task_snapshot(task)
            task = await visual._refresh_tuzi_task_if_needed(upstream_task_id, task)
            task = await visual._terminate_stale_sync_image_task_if_needed(upstream_task_id, task)
        completed_sources = _select_completed_image_sources(image_task_ids)
        completed = len(completed_sources)
        images = [completed_sources[index] for index in sorted(completed_sources)]
        grouped_attempts = _group_image_attempt_ids_by_index(image_task_ids)
        failed_image_tasks = []
        for index, attempt_ids in sorted(grouped_attempts.items()):
            if index in completed_sources:
                continue
            if len(attempt_ids) < EXTERNAL_IMAGE_MAX_ATTEMPTS_PER_ITEM:
                continue
            failed_attempts: List[Dict[str, str]] = []
            for attempt_id in attempt_ids:
                task = _get_latest_image_task_snapshot(attempt_id)
                if task and task.get("status") == TaskStatus.FAILED.value:
                    failed_attempts.append({
                        "task_id": attempt_id,
                        "error": str(task.get("error") or task.get("message") or "图片生成失败"),
                    })
            if len(failed_attempts) == len(attempt_ids):
                failed_image_tasks.extend(failed_attempts)

        expected_image_count = _expected_image_count_from_upstream_tasks(image_task_ids, target_image_count)
        progress = 40 + int((completed / max(expected_image_count, 1)) * 50)
        image_items = _build_upstream_image_item_statuses(image_task_ids)
        ready_image_count = completed
        image_result = _build_image_result(
            image_task_id,
            status="running",
            progress=min(progress, 95),
            message=f"图片生成中（{completed}/{expected_image_count}）",
            images=[],
            requested_image_mode=request.image_mode,
            visual_mode_resolved=resolved_image_mode,
            artifact_expires_at=None,
            downloaded_acknowledged=False,
            deleted_at=None,
        )
        image_result.update({
            "expected_image_count": expected_image_count,
            "ready_image_count": ready_image_count,
            "image_items": image_items,
        })
        await _update_task(
            image_task_id,
            progress=min(progress, 95),
            message=f"图片生成中（{completed}/{expected_image_count}）",
            result=image_result,
            metadata={
                "expected_image_count": expected_image_count,
                "ready_image_count": ready_image_count,
                "image_items": image_items,
                "image_poll_budget_seconds": image_poll_budget_seconds,
                "upstream_image_task_ids": image_task_ids,
            },
        )

        if failed_image_tasks:
            raise RuntimeError(" | ".join(f"{item['task_id']}: {item['error']}" for item in failed_image_tasks))

        if completed >= expected_image_count:
            return images

        await asyncio.sleep(2)

    raise TimeoutError(f"图片任务轮询超时（已等待约 {image_poll_budget_seconds} 秒）")


async def _materialize_png_files(image_task_id: str, image_sources: List[str]) -> List[Dict[str, Any]]:
    materialized: List[Dict[str, Any]] = []
    for offset, image_source in enumerate(image_sources):
        index = offset + 1
        destination = _image_file_path(image_task_id, index)
        source = str(image_source or "").strip()
        if source.startswith("data:image/"):
            await _write_data_url_to_png(source, destination)
        else:
            source_path = _image_source_path_from_url(source)
            if source_path and source_path.exists():
                shutil.copy2(source_path, destination)
            else:
                raise FileNotFoundError(f"无法定位图片文件: {source}")
        materialized.append({
            "index": index,
            "file_name": destination.name,
            "download_url": _image_download_url(image_task_id, index),
            "mime_type": "image/png",
        })
    return materialized


async def _download_external_image_inputs(image_task_id: str, image_urls: List[str]) -> List[Dict[str, Any]]:
    materialized: List[Dict[str, Any]] = []
    task_dir = _task_artifact_dir(image_task_id)
    for offset, image_url in enumerate(image_urls):
        index = offset + 1
        url = str(image_url or "").strip()
        if not _is_public_http_url(url):
            raise HTTPException(status_code=400, detail=f"图片 URL 不是公开 HTTP 地址: {url}")
        destination = task_dir / f"image_{index}.png"
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
            raw_path = task_dir / f"source_{index}{Path(urlparse(url).path).suffix or '.img'}"
            raw_path.write_bytes(response.content)
            from PIL import Image
            with Image.open(raw_path) as image:
                image.convert("RGB").save(destination, format="PNG")
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"下载图片失败: {url}") from error
        materialized.append({
            "index": index,
            "file_name": destination.name,
            "download_url": _image_download_url(image_task_id, index),
            "mime_type": "image/png",
        })
    return materialized


async def _run_external_note_batch_impl(
    batch_id: str,
    text_task_id: str,
    image_task_id: str,
    request: CreateNoteJobRequest,
    client_id: str,
) -> None:
    cleanup_expired_external_artifacts()
    job_started_monotonic = time.monotonic()
    variation_seed = request.variation_seed or str(((_get_task(text_task_id) or {}).get("metadata") or {}).get("variation_seed") or uuid4().hex[:12])
    text_completed = False
    logo_quality_checks: Optional[List[Dict[str, Any]]] = None
    logo_fix_summary: Optional[Dict[str, Any]] = None
    qc_summary: Optional[Dict[str, Any]] = None
    auto_fix_summary: Optional[Dict[str, Any]] = None
    resolved_image_mode = str(((_get_task(image_task_id) or {}).get("metadata") or {}).get("resolved_image_mode") or _resolve_external_image_mode(request.image_mode))
    strategy_user_id = str(((_get_task(text_task_id) or {}).get("metadata") or {}).get("strategy_user_id") or "").strip()
    if not strategy_user_id:
        strategy_user_id = _resolve_external_strategy_user_id(client_id, request.external_user_id)

    try:
        await _update_task(
            text_task_id,
            status=TaskStatus.RUNNING,
            progress=5,
            message="正在准备产品资料...",
            metadata={"stage": "research", "variation_seed": variation_seed},
        )
        await _update_task(
            image_task_id,
            status=TaskStatus.RUNNING,
            progress=5,
            message="等待文本任务完成...",
            result=_build_image_result(
                image_task_id,
                status="pending",
                progress=5,
                message="等待文本任务完成...",
                images=[],
                requested_image_mode=request.image_mode,
                visual_mode_resolved=resolved_image_mode,
                artifact_expires_at=None,
                downloaded_acknowledged=False,
                deleted_at=None,
            ),
            metadata={"stage": "waiting_text", "lifecycle_status": "pending"},
        )

        product_brief = {
            "product_name": request.product_name,
            "target_audience": request.target_audience,
            "product_features": request.product_features,
            "brand_tone": request.brand_tone or "真实、口语化、不过度销售",
            "must_include": request.must_include or "",
            "banned_terms": request.banned_terms or "",
            "reference_urls": _normalize_product_urls(request.product_urls),
        }

        research_response = await visual.generate_research_context(
            visual.ResearchContextRequest(
                product_brief=product_brief,
                reference_assets=[],
                benchmark_note=None,
            )
        )
        research_context = deepcopy(research_response.data or {})
        await _update_task(
            text_task_id,
            progress=20,
            message="产品研究已完成，正在生成笔记策略...",
            result={"product_brief": product_brief, "research_context": research_context},
        )

        strategy_response = await visual._generate_note_strategy_for_user(
            visual.StrategyRequest(
                research_context=research_context,
                benchmark_note=None,
                real_phrases=[],
                strategy_mode=request.strategy_mode,
            ),
            strategy_user_id,
        )
        strategy_data = deepcopy(strategy_response.data or {})
        strategies = list(strategy_data.get("strategies") or [])
        selected_strategy, strategy_metadata = _select_note_strategy(
            strategies,
            requested_style=request.note_strategy_style,
            selected_strategy_id=str(strategy_data.get("selected_strategy_id") or ""),
            diversity_level=request.diversity_level,
            variation_seed=variation_seed,
            perturbation_enabled=request.style_perturbation_enabled,
        )
        variation_hints = _build_variation_hints(
            strategy_metadata.get("selected_strategy_style") or request.note_strategy_style,
            diversity_level=request.diversity_level,
            variation_seed=variation_seed,
            perturbation_enabled=request.style_perturbation_enabled,
        )

        await _update_task(
            text_task_id,
            progress=35,
            message="笔记策略已生成，正在生成文案...",
            result={
                "product_brief": product_brief,
                "research_context": research_context,
                "note_strategy": selected_strategy,
                **strategy_metadata,
                "variation_seed": variation_seed,
                "variation_hints": variation_hints,
            },
            metadata={
                "stage": "content",
                "selected_strategy_id": strategy_metadata.get("selected_strategy_id") or "",
                "selected_strategy_style": strategy_metadata.get("selected_strategy_style") or request.note_strategy_style,
            },
        )

        content_style = _resolve_effective_content_style(
            request,
            str(strategy_metadata.get("selected_strategy_style") or request.note_strategy_style),
        )
        content_response = await visual.generate_content(
            visual.GenerateContentRequest(
                product_name=request.product_name,
                target_audience=request.target_audience,
                product_features=request.product_features,
                content_style=content_style,
                benchmark_note=None,
                rewrite_mode="结构仿写",
                brand_tone=product_brief["brand_tone"],
                must_include=product_brief["must_include"],
                banned_terms=product_brief["banned_terms"],
                real_phrases=[],
                research_context=research_context,
                note_strategy=selected_strategy,
            )
        )
        title = str(content_response.title or request.product_name).strip()
        final_body = str(content_response.final_body or content_response.content or "").strip()
        content = str(content_response.content or final_body).strip()

        selected_visual_style, style_metadata = _select_visual_style(
            request.visual_style,
            diversity_level=request.diversity_level,
            variation_seed=variation_seed,
            perturbation_enabled=request.style_perturbation_enabled,
        )

        final_text_result = {
            "product_brief": product_brief,
            "research_context": research_context,
            "note_strategy": selected_strategy,
            "title": title,
            "content": content,
            "final_body": final_body or content,
            "tags": content_response.tags or [],
            "note_visual_plan": content_response.note_visual_plan,
            "selected_strategy_style": strategy_metadata.get("selected_strategy_style") or request.note_strategy_style,
            "selected_visual_style": selected_visual_style,
            "selected_content_style": content_style,
            "variation_seed": variation_seed,
            "variation_hints": variation_hints,
            "source_documents": research_context.get("source_documents") or [],
        }

        await _update_task(
            text_task_id,
            status=TaskStatus.COMPLETED,
            progress=100,
            message="文本任务已完成",
            result=_compact_text_result_for_storage(final_text_result),
            metadata={
                "stage": "completed",
                "batch_id": batch_id,
                "image_context": _extract_text_context_for_image_task(final_text_result),
                "resolved_image_mode": resolved_image_mode,
            },
        )
        text_completed = True
        target_image_count = _resolve_external_target_image_count(
            content_response.note_visual_plan,
            resolved_image_mode=resolved_image_mode,
            requested_image_count=request.image_count,
            image_count_provided="image_count" in getattr(request, "model_fields_set", set()),
            note_strategy=selected_strategy,
        )

        await _update_task(
            image_task_id,
            progress=15,
            message=f"文本任务已完成，正在生成 {target_image_count} 张图片...",
            result=_build_image_result(
                image_task_id,
                status="running",
                progress=15,
                message=f"文本任务已完成，正在生成 {target_image_count} 张图片...",
                images=[],
                requested_image_mode=request.image_mode,
                visual_mode_resolved=resolved_image_mode,
                artifact_expires_at=None,
                downloaded_acknowledged=False,
                deleted_at=None,
            ),
            metadata={
                "stage": "image_submit",
                "lifecycle_status": "running",
                "image_context": _extract_text_context_for_image_task(final_text_result),
                "resolved_image_mode": resolved_image_mode,
            },
        )

        image_sources = await _start_image_workflow(
            image_task_id=image_task_id,
            request=request,
            client_id=client_id,
            image_context=_extract_text_context_for_image_task(final_text_result),
            resolved_image_mode=resolved_image_mode,
            target_image_count=target_image_count,
            job_started_monotonic=job_started_monotonic,
        )
        image_status_metadata = (_get_task(image_task_id).get("metadata") if _get_task(image_task_id) else {}) or {}
        image_items = list(image_status_metadata.get("image_items") or [])
        expected_image_count = image_status_metadata.get("expected_image_count") or target_image_count
        ready_image_count = image_status_metadata.get("ready_image_count") or len(image_sources)
        images = await _materialize_png_files(image_task_id, image_sources)
        expires_at = _artifact_expires_at_iso()
        completed_image_result = _build_image_result(
            image_task_id,
            status="awaiting_ack",
            progress=100,
            message="图片任务已完成，等待确认回执",
            images=images,
            requested_image_mode=request.image_mode,
            visual_mode_resolved=resolved_image_mode,
            artifact_expires_at=expires_at,
            downloaded_acknowledged=False,
            deleted_at=None,
            logo_quality_checks=logo_quality_checks,
            logo_fix_summary=logo_fix_summary,
        )
        completed_image_result.update({
            "expected_image_count": expected_image_count,
            "ready_image_count": ready_image_count,
            "image_items": image_items,
        })
        await _update_task(
            image_task_id,
            status=TaskStatus.COMPLETED,
            progress=100,
            message="图片任务已完成，等待确认回执",
            result=completed_image_result,
            metadata={
                "stage": "completed",
                "lifecycle_status": "awaiting_ack",
                "artifact_expires_at": expires_at,
                "expected_image_count": expected_image_count,
                "ready_image_count": ready_image_count,
                "image_items": image_items,
            },
        )
    except HTTPException as error:
        image_metadata = ((_get_task(image_task_id) or {}).get("metadata") or {})
        failed_image_result = _build_image_result(
            image_task_id,
            status="failed",
            progress=100,
            message="图片任务失败",
            images=[],
            requested_image_mode=request.image_mode,
            visual_mode_resolved=resolved_image_mode,
            artifact_expires_at=None,
            downloaded_acknowledged=False,
            deleted_at=None,
            logo_quality_checks=logo_quality_checks,
            logo_fix_summary=logo_fix_summary,
        )
        failed_image_result.update({
            "expected_image_count": image_metadata.get("expected_image_count"),
            "ready_image_count": image_metadata.get("ready_image_count"),
            "image_items": image_metadata.get("image_items") or [],
        })
        if not text_completed:
            await _update_task(
                text_task_id,
                status=TaskStatus.FAILED,
                progress=100,
                message="文本任务失败",
                error=str(error.detail),
                metadata={"failed_stage": ((_get_task(text_task_id) or {}).get("metadata") or {}).get("stage") or "unknown"},
            )
        await _update_task(
            image_task_id,
            status=TaskStatus.FAILED,
            progress=100,
            message="图片任务失败",
            error=str(error.detail),
            result=failed_image_result,
            metadata={"failed_stage": ((_get_task(image_task_id) or {}).get("metadata") or {}).get("stage") or "unknown", "lifecycle_status": "failed"},
        )
    except Exception as error:
        image_metadata = ((_get_task(image_task_id) or {}).get("metadata") or {})
        failed_image_result = _build_image_result(
            image_task_id,
            status="failed",
            progress=100,
            message="图片任务失败",
            images=[],
            requested_image_mode=request.image_mode,
            visual_mode_resolved=resolved_image_mode,
            artifact_expires_at=None,
            downloaded_acknowledged=False,
            deleted_at=None,
            logo_quality_checks=logo_quality_checks,
            logo_fix_summary=logo_fix_summary,
        )
        failed_image_result.update({
            "expected_image_count": image_metadata.get("expected_image_count"),
            "ready_image_count": image_metadata.get("ready_image_count"),
            "image_items": image_metadata.get("image_items") or [],
        })
        if not text_completed:
            await _update_task(
                text_task_id,
                status=TaskStatus.FAILED,
                progress=100,
                message="文本任务失败",
                error=str(error),
                metadata={"failed_stage": ((_get_task(text_task_id) or {}).get("metadata") or {}).get("stage") or "unknown"},
            )
        await _update_task(
            image_task_id,
            status=TaskStatus.FAILED,
            progress=100,
            message="图片任务失败",
            error=str(error),
            result=failed_image_result,
            metadata={"failed_stage": ((_get_task(image_task_id) or {}).get("metadata") or {}).get("stage") or "unknown", "lifecycle_status": "failed"},
        )


async def run_external_note_batch(
    batch_id: str,
    text_task_id: str,
    image_task_id: str,
    request: CreateNoteJobRequest,
    client_id: str,
) -> None:
    async with external_note_job_slot(
        batch_id=batch_id,
        client_id=client_id,
        text_task_id=text_task_id,
        image_task_id=image_task_id,
    ) as queue_wait_seconds:
        runner_metadata = {
            "stage": "external_slot_acquired",
            "external_queue_wait_seconds": round(queue_wait_seconds, 3),
            "external_runner": get_external_note_job_runner_stats(),
        }
        await _update_task(text_task_id, metadata=runner_metadata)
        await _update_task(image_task_id, metadata=runner_metadata)
        await _run_external_note_batch_impl(
            batch_id,
            text_task_id,
            image_task_id,
            request,
            client_id,
        )


def get_external_text_job_status(task_id: str, client_id: str) -> Optional[Dict[str, Any]]:
    cleanup_expired_external_artifacts()
    task = _get_task(task_id)
    if not task:
        return None
    _assert_client_access(task, client_id)
    if (task.get("metadata") or {}).get("task_kind") != "external_text_job":
        raise HTTPException(status_code=404, detail="文本任务不存在")
    return task


def get_external_image_job_status(task_id: str, client_id: str) -> Optional[Dict[str, Any]]:
    cleanup_expired_external_artifacts()
    task = _get_task(task_id)
    if not task:
        return None
    _assert_client_access(task, client_id)
    if (task.get("metadata") or {}).get("task_kind") != "external_image_job":
        raise HTTPException(status_code=404, detail="图片任务不存在")
    result = task.get("result")
    if isinstance(result, dict):
        expires_at = result.get("artifact_expires_at")
        if result.get("images") and _artifact_is_expired(expires_at):
            result = {
                **result,
                "status": "deleted",
                "images": [],
                "image_count": 0,
                "deleted_at": result.get("deleted_at") or _now_utc().isoformat(),
            }
            task = {**task, "result": result}
    return task


def get_external_image_job_file(task_id: str, index: int, client_id: str) -> Path:
    task = get_external_image_job_status(task_id, client_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    result = task.get("result") or {}
    if not isinstance(result, dict):
        raise HTTPException(status_code=404, detail="图片任务结果不存在")
    if result.get("deleted_at"):
        raise HTTPException(status_code=410, detail="图片已删除")
    if _artifact_is_expired(result.get("artifact_expires_at")):
        raise HTTPException(status_code=410, detail="图片已过期，请重新生成")
    image_path = _image_file_path(task_id, index)
    if not image_path.exists():
        raise HTTPException(status_code=404, detail="图片文件不存在")
    return image_path


def acknowledge_external_image_job(task_id: str, client_id: str, request: Optional[ImageAckRequest] = None) -> Dict[str, Any]:
    task = get_external_image_job_status(task_id, client_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    result = task.get("result") or {}
    if not isinstance(result, dict):
        raise HTTPException(status_code=404, detail="图片任务结果不存在")

    deleted_at = result.get("deleted_at") or _now_utc().isoformat()
    shutil.rmtree(_task_artifact_dir(task_id), ignore_errors=True)

    ack_payload = request.model_dump(exclude_none=True) if request else {}
    updated_result = {
        **result,
        "status": "deleted",
        "images": [],
        "image_count": 0,
        "downloaded_acknowledged": True,
        "deleted_at": deleted_at,
    }
    task_manager.update_task_sync(
        task_id,
        status=TaskStatus.COMPLETED,
        progress=100,
        message="图片已确认接收并删除",
        result=updated_result,
        metadata={
            "lifecycle_status": "deleted",
            "ack_payload": ack_payload,
        },
    )
    _persist_task(task_id)
    return task_manager.get_task(task_id) or task
