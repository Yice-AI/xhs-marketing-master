import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import text

from backend.config import settings
from backend.database import db_session
from backend.database.models import NoteStrategyLog
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


def _safe_json_loads(value: Any) -> Any:
    if value is None or isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return None


def _looks_like_abstract_signal(value: Any) -> bool:
    text_value = str(value or "").strip()
    if not text_value:
        return False
    first_part = text_value.split("｜", 1)[0].split("|", 1)[0].split("：", 1)[0].split(":", 1)[0].strip()
    if first_part.endswith(("型", "法", "框架", "路径", "模型", "模板")) and len(first_part) <= 18:
        return True
    return bool(re.search(r"(?:^|[｜|：:\s])[\u4e00-\u9fffA-Za-z0-9]{2,18}(?:型|法|框架|路径|模型|模板)(?:[｜|：:\s]|$)", text_value))


def _strategy_signal_text(strategy: Dict[str, Any]) -> str:
    candidates = [
        _clip(strategy.get("summary"), 70),
        _clip(strategy.get("suggestedTitle"), 42),
        _clip(strategy.get("label"), 42),
        _clip(strategy.get("contentAngle"), 56),
    ]
    clean_candidates = [item for item in candidates if item and not _looks_like_abstract_signal(item)]
    if clean_candidates:
        return clean_candidates[0]
    return next((item for item in candidates if item), "")


def ensure_note_strategy_log_schema() -> None:
    if not settings.allow_runtime_schema_fallback:
        return

    db_engine = _get_engine()
    if db_engine is None:
        return

    NoteStrategyLog.__table__.create(bind=db_engine, checkfirst=True)


def save_note_strategy_log(payload: Dict[str, Any]) -> Optional[str]:
    db_engine = _get_engine()
    if db_engine is None:
        return None

    ensure_note_strategy_log_schema()
    log_id = payload.get("log_id") or uuid.uuid4().hex
    response_payload = payload.get("response_payload") or {}
    research_context = payload.get("research_context") or {}
    started_at = payload.get("started_at")
    runtime_ms = payload.get("runtime_ms")
    if runtime_ms is None and started_at is not None:
        try:
            runtime_ms = max(0, int((time.monotonic() - float(started_at)) * 1000))
        except Exception:
            runtime_ms = None

    row = {
        "log_id": log_id,
        "user_id": _clip(payload.get("user_id") or "unknown", 64) or "unknown",
        "product_name": _clip(
            payload.get("product_name") or (research_context or {}).get("product_name"),
            256,
        ) or None,
        "strategy_mode": _clip(payload.get("strategy_mode"), 64) or None,
        "product_usage_mode": _clip(
            payload.get("product_usage_mode") or (response_payload or {}).get("product_usage_mode"),
            64,
        ) or None,
        "selected_strategy_id": _clip(
            payload.get("selected_strategy_id") or (response_payload or {}).get("selected_strategy_id"),
            128,
        ) or None,
        "fallback_used": bool(
            payload.get("fallback_used")
            if payload.get("fallback_used") is not None
            else (response_payload or {}).get("fallback_used")
        ),
        "fallback_reason": payload.get("fallback_reason") or (response_payload or {}).get("fallback_reason"),
        "model_name": _clip(payload.get("model_name"), 128) or None,
        "runtime_ms": runtime_ms,
        "research_context": _json_dumps(research_context),
        "benchmark_note": _json_dumps(payload.get("benchmark_note")),
        "real_phrases": _json_dumps(payload.get("real_phrases")),
        "strategy_feedback": payload.get("strategy_feedback"),
        "benchmark_fit": _json_dumps(payload.get("benchmark_fit") or (response_payload or {}).get("benchmark_fit")),
        "strategies": _json_dumps(payload.get("strategies") or (response_payload or {}).get("strategies")),
        "response_payload": _json_dumps(response_payload),
    }

    try:
        with db_engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO note_strategy_logs (
                    log_id, user_id, product_name, strategy_mode, product_usage_mode,
                    selected_strategy_id, fallback_used, fallback_reason, model_name,
                    runtime_ms, research_context, benchmark_note, real_phrases,
                    strategy_feedback, benchmark_fit, strategies, response_payload, created_at
                ) VALUES (
                    :log_id, :user_id, :product_name, :strategy_mode, :product_usage_mode,
                    :selected_strategy_id, :fallback_used, :fallback_reason, :model_name,
                    :runtime_ms, :research_context, :benchmark_note, :real_phrases,
                    :strategy_feedback, :benchmark_fit, :strategies, :response_payload, CURRENT_TIMESTAMP
                )
            """), row)
        return log_id
    except Exception as error:
        logger.warning("[NoteStrategyLogStore] 保存策略日志失败: %s", error, exc_info=True)
        return None


def list_recent_note_strategy_signals(
    *,
    user_id: str,
    product_name: str,
    strategy_mode: Optional[str] = None,
    limit: int = 6,
) -> List[str]:
    db_engine = _get_engine()
    if db_engine is None:
        return []

    ensure_note_strategy_log_schema()
    safe_limit = max(1, min(int(limit or 6), 12))
    filters = ["user_id = :user_id", "product_name = :product_name"]
    params: Dict[str, Any] = {
        "user_id": _clip(user_id or "unknown", 64) or "unknown",
        "product_name": _clip(product_name, 256),
        "row_limit": 8,
    }
    if not params["product_name"]:
        return []
    if strategy_mode:
        filters.append("strategy_mode = :strategy_mode")
        params["strategy_mode"] = _clip(strategy_mode, 64)

    try:
        with db_engine.begin() as conn:
            rows = conn.execute(text(f"""
                SELECT strategies
                FROM note_strategy_logs
                WHERE {" AND ".join(filters)}
                  AND (fallback_used = 0 OR fallback_used IS NULL)
                ORDER BY created_at DESC, id DESC
                LIMIT :row_limit
            """), params).mappings().all()
    except Exception as error:
        logger.warning("[NoteStrategyLogStore] 查询近期策略信号失败: %s", error, exc_info=True)
        return []

    signals: List[str] = []
    seen = set()
    for row in rows:
        strategies = _safe_json_loads(row.get("strategies")) or []
        if not isinstance(strategies, list):
            continue
        for strategy in strategies:
            if not isinstance(strategy, dict):
                continue
            signal = _strategy_signal_text(strategy)
            if not signal or signal in seen:
                continue
            seen.add(signal)
            signals.append(signal)
            if len(signals) >= safe_limit:
                return signals

    return signals
