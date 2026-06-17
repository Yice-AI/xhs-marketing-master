import json
from typing import Any, Dict, Optional
from datetime import datetime

from sqlalchemy import text

from backend.config import settings
from backend.database import db_session
from backend.utils.logger import logger


def _get_engine():
    if db_session.engine is None:
        db_session.init_database()
    return db_session.engine


def ensure_image_task_schema() -> None:
    if not settings.allow_runtime_schema_fallback:
        logger.info("[ImageTaskStore] 生产模式跳过运行时 image_generation_tasks schema 兜底")
        return

    db_engine = _get_engine()
    if db_engine is None:
        return

    with db_engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS image_generation_tasks (
                task_id VARCHAR(64) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                status VARCHAR(32) NOT NULL,
                progress INTEGER DEFAULT 0,
                message TEXT,
                error TEXT,
                result_json LONGTEXT,
                metadata_json LONGTEXT,
                created_at DATETIME,
                started_at DATETIME,
                completed_at DATETIME,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))


def save_task_snapshot(snapshot: Dict[str, Any]) -> None:
    db_engine = _get_engine()
    if db_engine is None:
        return

    ensure_image_task_schema()
    payload = {
        "task_id": snapshot["task_id"],
        "name": snapshot.get("name") or "任务",
        "status": snapshot.get("status") or "pending",
        "progress": snapshot.get("progress") or 0,
        "message": snapshot.get("message") or "",
        "error": snapshot.get("error") or "",
        "result_json": json.dumps(snapshot.get("result"), ensure_ascii=False) if snapshot.get("result") is not None else None,
        "metadata_json": json.dumps(snapshot.get("metadata") or {}, ensure_ascii=False),
        "created_at": snapshot.get("created_at"),
        "started_at": snapshot.get("started_at"),
        "completed_at": snapshot.get("completed_at"),
    }

    with db_engine.begin() as conn:
        existing = conn.execute(
            text("SELECT task_id FROM image_generation_tasks WHERE task_id = :task_id"),
            {"task_id": payload["task_id"]},
        ).first()

        if existing:
            conn.execute(text("""
                UPDATE image_generation_tasks
                SET
                    name = :name,
                    status = :status,
                    progress = :progress,
                    message = :message,
                    error = :error,
                    result_json = :result_json,
                    metadata_json = :metadata_json,
                    created_at = :created_at,
                    started_at = :started_at,
                    completed_at = :completed_at,
                    updated_at = CURRENT_TIMESTAMP
                WHERE task_id = :task_id
            """), payload)
        else:
            conn.execute(text("""
                INSERT INTO image_generation_tasks (
                    task_id, name, status, progress, message, error,
                    result_json, metadata_json, created_at, started_at, completed_at, updated_at
                ) VALUES (
                    :task_id, :name, :status, :progress, :message, :error,
                    :result_json, :metadata_json, :created_at, :started_at, :completed_at, CURRENT_TIMESTAMP
                )
            """), payload)


def load_task_snapshot(task_id: str) -> Optional[Dict[str, Any]]:
    db_engine = _get_engine()
    if db_engine is None:
        return None

    ensure_image_task_schema()
    with db_engine.begin() as conn:
        row = conn.execute(text("""
            SELECT task_id, name, status, progress, message, error,
                   result_json, metadata_json, created_at, started_at, completed_at
            FROM image_generation_tasks
            WHERE task_id = :task_id
        """), {"task_id": task_id}).mappings().first()

    if not row:
        return None

    def _serialize_datetime(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, str):
            return value
        return str(value)

    return {
        "task_id": row["task_id"],
        "name": row["name"],
        "status": row["status"],
        "progress": row["progress"] or 0,
        "message": row["message"],
        "error": row["error"],
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else {},
        "created_at": _serialize_datetime(row["created_at"]),
        "started_at": _serialize_datetime(row["started_at"]),
        "completed_at": _serialize_datetime(row["completed_at"]),
    }


def fail_orphaned_local_image_tasks_after_startup() -> int:
    """Fail local in-process image tasks that cannot survive a service restart."""
    db_engine = _get_engine()
    if db_engine is None:
        return 0

    ensure_image_task_schema()
    now = datetime.now()
    failed_count = 0
    restart_message = "服务刚刚重启，上一轮本地生图队列已中断，请重新生成"

    with db_engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT task_id, metadata_json
            FROM image_generation_tasks
            WHERE status IN ('pending', 'running')
        """)).mappings().all()

        for row in rows:
            metadata: Dict[str, Any] = {}
            if row.get("metadata_json"):
                try:
                    metadata = json.loads(row["metadata_json"]) or {}
                except Exception:
                    metadata = {}

            task_kind = str(metadata.get("task_kind") or "").strip()
            if task_kind not in {"image", "image_edit"}:
                continue

            # Tuzi async/image2 jobs can be refreshed from their remote task id.
            # Local edit/generation jobs run inside this Python process, so a
            # deployment restart leaves only a stale DB snapshot behind.
            if metadata.get("external_task_id"):
                continue

            metadata.update({
                "stage": "failed",
                "retryable": False,
                "interrupted_by_restart": True,
                "restart_interrupted_at": now.isoformat(),
            })
            conn.execute(text("""
                UPDATE image_generation_tasks
                SET
                    status = 'failed',
                    progress = 100,
                    message = :message,
                    error = :message,
                    metadata_json = :metadata_json,
                    completed_at = :completed_at,
                    updated_at = CURRENT_TIMESTAMP
                WHERE task_id = :task_id
                  AND status IN ('pending', 'running')
            """), {
                "task_id": row["task_id"],
                "message": restart_message,
                "metadata_json": json.dumps(metadata, ensure_ascii=False),
                "completed_at": now,
            })
            failed_count += 1

    if failed_count:
        logger.warning(
            "[ImageTaskStore] 已清理服务重启后无法恢复的本地生图任务: count=%s",
            failed_count,
        )
    return failed_count
