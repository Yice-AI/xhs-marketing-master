import json
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from backend.config import settings
from backend.database.models import InterviewSession


INTERVIEW_SESSION_TTL_DAYS = 30


def safe_json_loads(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def _json_dumps(value: Any) -> str:
    return json.dumps(value or {}, ensure_ascii=False)


def ensure_interview_session_schema(db: Session) -> None:
    if not settings.allow_runtime_schema_fallback:
        return
    if db is None or db.bind is None:
        return
    inspector = inspect(db.bind)
    if "interview_sessions" in inspector.get_table_names():
        return
    InterviewSession.__table__.create(db.bind, checkfirst=True)


def serialize_interview_session(session: InterviewSession, *, include_payload: bool = True) -> Dict[str, Any]:
    data = session.to_dict(include_payload=False)
    if include_payload:
        data["agent_snapshot"] = safe_json_loads(session.agent_snapshot, {})
        data["ui_snapshot"] = safe_json_loads(session.ui_snapshot, None)
    return data


def get_interview_session(db: Session, user_id: str, session_id: str) -> Optional[InterviewSession]:
    ensure_interview_session_schema(db)
    return db.query(InterviewSession).filter(
        InterviewSession.user_id == user_id,
        InterviewSession.session_id == session_id,
    ).first()


def get_latest_interview_session(db: Session, user_id: str) -> Optional[InterviewSession]:
    ensure_interview_session_schema(db)
    now = datetime.utcnow()
    return db.query(InterviewSession).filter(
        InterviewSession.user_id == user_id,
        InterviewSession.status != "expired",
        ((InterviewSession.expires_at.is_(None)) | (InterviewSession.expires_at > now)),
    ).order_by(InterviewSession.updated_at.desc()).first()


def upsert_interview_session(
    db: Session,
    *,
    user_id: str,
    session_id: str,
    status: str,
    agent_snapshot: Dict[str, Any],
    ui_snapshot: Optional[Dict[str, Any]] = None,
) -> InterviewSession:
    ensure_interview_session_schema(db)
    now = datetime.utcnow()
    expires_at = now + timedelta(days=INTERVIEW_SESSION_TTL_DAYS)
    row = get_interview_session(db, user_id, session_id)
    if row is None:
        row = InterviewSession(
            session_id=session_id,
            user_id=user_id,
            status=status or "asking",
            agent_snapshot=_json_dumps(agent_snapshot),
            ui_snapshot=_json_dumps(ui_snapshot) if ui_snapshot is not None else None,
            created_at=now,
            updated_at=now,
            expires_at=expires_at,
        )
        db.add(row)
        return row

    row.status = status or row.status or "asking"
    row.agent_snapshot = _json_dumps(agent_snapshot)
    if ui_snapshot is not None:
        row.ui_snapshot = _json_dumps(ui_snapshot)
    row.updated_at = now
    row.expires_at = expires_at
    return row


def update_interview_ui_snapshot(
    db: Session,
    *,
    user_id: str,
    session_id: str,
    ui_snapshot: Dict[str, Any],
) -> Optional[InterviewSession]:
    row = get_interview_session(db, user_id, session_id)
    if row is None:
        return None
    row.ui_snapshot = _json_dumps(ui_snapshot)
    row.updated_at = datetime.utcnow()
    return row


def mark_interview_session_expired(db: Session, *, user_id: str, session_id: str) -> bool:
    row = get_interview_session(db, user_id, session_id)
    if row is None:
        return False
    row.status = "expired"
    row.updated_at = datetime.utcnow()
    return True
