import json
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import text

from backend.config import settings
from backend.database import db_session
from backend.database.models import ImagePromptLog
from backend.utils.logger import logger


def _get_engine():
    if db_session.engine is None:
        db_session.init_database()
    return db_session.engine


def _json_dumps(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False)


def _clip(value: Any, max_length: int) -> str:
    text_value = str(value or "").strip()
    if len(text_value) <= max_length:
        return text_value
    return text_value[:max_length]


def ensure_image_prompt_log_schema() -> None:
    if not settings.allow_runtime_schema_fallback:
        return

    db_engine = _get_engine()
    if db_engine is None:
        return

    ImagePromptLog.__table__.create(bind=db_engine, checkfirst=True)


def save_image_prompt_log(payload: Dict[str, Any]) -> Optional[str]:
    db_engine = _get_engine()
    if db_engine is None:
        return None

    ensure_image_prompt_log_schema()
    log_id = payload.get("log_id") or uuid.uuid4().hex
    row = {
        "log_id": log_id,
        "task_id": payload.get("task_id"),
        "user_id": payload.get("user_id") or "unknown",
        "title": _clip(payload.get("title"), 256) or None,
        "content_excerpt": _clip(payload.get("content_excerpt"), 4000) or None,
        "visual_mode": _clip(payload.get("visual_mode"), 64) or None,
        "prompt_strategy": _clip(payload.get("prompt_strategy"), 64) or None,
        "prompt_model": _clip(payload.get("prompt_model"), 128) or None,
        "image_provider": _clip(payload.get("image_provider"), 64) or None,
        "image_model": _clip(payload.get("image_model"), 128) or None,
        "workflow_index": payload.get("workflow_index"),
        "workflow_total": payload.get("workflow_total"),
        "prompt_type": _clip(payload.get("prompt_type"), 64) or None,
        "prompt_title": _clip(payload.get("prompt_title"), 256) or None,
        "role": _clip(payload.get("role"), 64) or None,
        "key_message": payload.get("key_message"),
        "prompt_text": payload.get("prompt_text") or "",
        "prompt_payload": _json_dumps(payload.get("prompt_payload")),
        "design_plan": _json_dumps(payload.get("design_plan")),
        "prompt_stats": _json_dumps(payload.get("prompt_stats")),
        "product_brief": _json_dumps(payload.get("product_brief")),
        "dynamic_style_params": _json_dumps(payload.get("dynamic_style_params")),
        "material_summary": payload.get("material_summary"),
        "reference_summary": payload.get("reference_summary"),
        "reference_asset_ids": _json_dumps(payload.get("reference_asset_ids")),
    }

    try:
        with db_engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO image_prompt_logs (
                    log_id, task_id, user_id, title, content_excerpt,
                    visual_mode, prompt_strategy, prompt_model,
                    image_provider, image_model, workflow_index, workflow_total,
                    prompt_type, prompt_title, role, key_message, prompt_text,
                    prompt_payload, design_plan, prompt_stats, product_brief,
                    dynamic_style_params, material_summary, reference_summary,
                    reference_asset_ids, created_at
                ) VALUES (
                    :log_id, :task_id, :user_id, :title, :content_excerpt,
                    :visual_mode, :prompt_strategy, :prompt_model,
                    :image_provider, :image_model, :workflow_index, :workflow_total,
                    :prompt_type, :prompt_title, :role, :key_message, :prompt_text,
                    :prompt_payload, :design_plan, :prompt_stats, :product_brief,
                    :dynamic_style_params, :material_summary, :reference_summary,
                    :reference_asset_ids, CURRENT_TIMESTAMP
                )
            """), row)
        return log_id
    except Exception as error:
        logger.warning("[ImagePromptLogStore] 保存提示词日志失败: %s", error, exc_info=True)
        return None


def list_image_prompt_logs(
    *,
    user_id: str,
    limit: int = 50,
    prompt_strategy: Optional[str] = None,
    title_keyword: Optional[str] = None,
) -> List[Dict[str, Any]]:
    db_engine = _get_engine()
    if db_engine is None:
        return []

    ensure_image_prompt_log_schema()
    safe_limit = max(1, min(int(limit or 50), 200))
    filters = ["user_id = :user_id"]
    params: Dict[str, Any] = {"user_id": user_id, "limit": safe_limit}
    if prompt_strategy:
        filters.append("prompt_strategy = :prompt_strategy")
        params["prompt_strategy"] = prompt_strategy
    if title_keyword:
        filters.append("title LIKE :title_keyword")
        params["title_keyword"] = f"%{title_keyword}%"

    with db_engine.begin() as conn:
        rows = conn.execute(text(f"""
            SELECT
                log_id, task_id, user_id, title, content_excerpt,
                visual_mode, prompt_strategy, prompt_model,
                image_provider, image_model, workflow_index, workflow_total,
                prompt_type, prompt_title, role, key_message, prompt_text,
                prompt_payload, design_plan, prompt_stats, product_brief,
                dynamic_style_params, material_summary, reference_summary,
                reference_asset_ids, created_at
            FROM image_prompt_logs
            WHERE {" AND ".join(filters)}
            ORDER BY created_at DESC, id DESC
            LIMIT :limit
        """), params).mappings().all()

    return [dict(row) for row in rows]
