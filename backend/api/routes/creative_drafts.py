from datetime import datetime
import json
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.database.db_session import get_db
from backend.database.models import CreativeDraft
from backend.middleware.auth import get_current_user_id
from backend.config import settings


router = APIRouter(prefix="/api/creative-drafts", tags=["creative-drafts"])


def _is_transient_image_url(value: Any) -> bool:
    return isinstance(value, str) and value.strip().startswith("blob:")


class CreativeDraftPayloadRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=256)
    session_key: str = Field(..., min_length=1, max_length=128)
    source_context: Optional[str] = Field(default=None, max_length=256)
    snapshot_version: int = Field(default=1, ge=1)
    content_payload: Dict[str, Any]
    preview_payload: Dict[str, Any]


class CreativeDraftUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=256)
    status: Optional[str] = Field(default=None)


def _ensure_creative_drafts_schema(db: Session) -> None:
    if db is None or db.bind is None:
        return
    if not settings.allow_runtime_schema_fallback:
        return
    CreativeDraft.__table__.create(bind=db.bind, checkfirst=True)


def _deserialize_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def _serialize_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _resolve_stable_cover_image(preview_payload: Dict[str, Any], content_payload: Dict[str, Any]) -> Dict[str, Any]:
    preview = dict(preview_payload or {})
    cover = preview.get("cover_image_url") or ""
    if cover and not _is_transient_image_url(cover):
        return preview

    generated_note = (content_payload or {}).get("generatedNote") or {}
    studio_state = (content_payload or {}).get("studioContentState") or {}
    active_asset_id = studio_state.get("activeAssetId") or (generated_note.get("studioDraftState") or {}).get("activeAssetId")
    assets = generated_note.get("assets") or []

    def stable_url(asset: Dict[str, Any]) -> str:
        export_ready = str(asset.get("exportReadyUrl") or "").strip()
        if export_ready and not _is_transient_image_url(export_ready):
            return export_ready
        direct = str(asset.get("url") or "").strip()
        if direct and not _is_transient_image_url(direct):
            return direct
        return ""

    if active_asset_id:
        matched = next((item for item in assets if str(item.get("id") or "").strip() == str(active_asset_id).strip()), None)
        if matched:
            resolved = stable_url(matched)
            if resolved:
                preview["cover_image_url"] = resolved
                return preview

    for asset in assets:
        resolved = stable_url(asset)
        if resolved:
            preview["cover_image_url"] = resolved
            return preview

    return preview


def _format_creative_draft(draft: CreativeDraft, include_payload: bool = False) -> Dict[str, Any]:
    data = draft.to_dict(include_payload=include_payload)
    content_payload = _deserialize_json(data.get("content_payload")) or {}
    data["preview_payload"] = _resolve_stable_cover_image(
        _deserialize_json(data.get("preview_payload")) or {},
        content_payload,
    )
    if include_payload:
        data["content_payload"] = content_payload
    return data


def _get_owned_draft(db: Session, user_id: str, draft_id: str) -> CreativeDraft:
    draft = db.query(CreativeDraft).filter(
        CreativeDraft.user_id == user_id,
        CreativeDraft.draft_id == draft_id,
    ).first()
    if not draft:
        raise HTTPException(status_code=404, detail="草稿不存在")
    return draft


@router.post("/autosave")
async def autosave_creative_draft(
    request: CreativeDraftPayloadRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    _ensure_creative_drafts_schema(db)

    draft = db.query(CreativeDraft).filter(
        CreativeDraft.user_id == user_id,
        CreativeDraft.session_key == request.session_key,
        CreativeDraft.status == "latest_auto",
    ).first()

    if not draft:
        draft = CreativeDraft(
            draft_id=str(uuid.uuid4()),
            user_id=user_id,
            session_key=request.session_key,
            title=request.title,
            status="latest_auto",
            source_context=request.source_context,
            snapshot_version=request.snapshot_version,
            content_payload=_serialize_json(request.content_payload),
            preview_payload=_serialize_json(request.preview_payload),
        )
        db.add(draft)
    else:
        draft.title = request.title
        draft.source_context = request.source_context
        draft.snapshot_version = request.snapshot_version
        draft.content_payload = _serialize_json(request.content_payload)
        draft.preview_payload = _serialize_json(request.preview_payload)
        draft.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(draft)
    return {"success": True, "data": _format_creative_draft(draft, include_payload=True)}


@router.post("")
async def create_creative_draft(
    request: CreativeDraftPayloadRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    _ensure_creative_drafts_schema(db)

    draft = CreativeDraft(
        draft_id=str(uuid.uuid4()),
        user_id=user_id,
        session_key=request.session_key,
        title=request.title,
        status="manual_saved",
        source_context=request.source_context,
        snapshot_version=request.snapshot_version,
        content_payload=_serialize_json(request.content_payload),
        preview_payload=_serialize_json(request.preview_payload),
    )
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return {"success": True, "data": _format_creative_draft(draft, include_payload=True)}


@router.get("")
async def list_creative_drafts(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    _ensure_creative_drafts_schema(db)

    drafts = db.query(CreativeDraft).filter(
        CreativeDraft.user_id == user_id,
        CreativeDraft.status != "archived",
    ).all()

    ordered = sorted(
        drafts,
        key=lambda item: (
            0 if item.status == "latest_auto" else 1,
            -(item.updated_at or item.created_at or datetime.min).timestamp(),
        ),
    )
    return {"success": True, "data": [_format_creative_draft(item) for item in ordered]}


@router.get("/{draft_id}")
async def get_creative_draft(
    draft_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    _ensure_creative_drafts_schema(db)
    draft = _get_owned_draft(db, user_id, draft_id)
    draft.last_opened_at = datetime.utcnow()
    db.commit()
    db.refresh(draft)
    return {"success": True, "data": _format_creative_draft(draft, include_payload=True)}


@router.put("/{draft_id}")
async def update_creative_draft(
    draft_id: str,
    request: CreativeDraftUpdateRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    _ensure_creative_drafts_schema(db)
    draft = _get_owned_draft(db, user_id, draft_id)

    if request.title is not None:
        draft.title = request.title
    if request.status is not None:
        draft.status = request.status
    draft.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(draft)
    return {"success": True, "data": _format_creative_draft(draft, include_payload=True)}


@router.delete("/{draft_id}")
async def delete_creative_draft(
    draft_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    _ensure_creative_drafts_schema(db)
    draft = _get_owned_draft(db, user_id, draft_id)
    db.delete(draft)
    db.commit()
    return {"success": True}
