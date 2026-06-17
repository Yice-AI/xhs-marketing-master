import hashlib
import json
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from backend.config import settings
from backend.database.models import ProductProfile, ScrapeHistory


PRODUCT_BRIEF_DEFAULTS: Dict[str, Any] = {
    "product_name": "",
    "target_audience": "",
    "product_features": "",
    "brand_tone": "真实体验感、口语化、不硬卖",
    "must_include": "",
    "banned_terms": "",
    "reference_urls": [],
}


def safe_json_loads(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def normalize_product_brief(brief: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    raw = brief if isinstance(brief, dict) else {}
    normalized = {**PRODUCT_BRIEF_DEFAULTS, **raw}
    reference_urls = raw.get("reference_urls")
    urls = reference_urls if isinstance(reference_urls, list) else []
    deduped_urls = []
    for item in urls:
        url = str(item or "").strip()
        if url and url not in deduped_urls:
            deduped_urls.append(url)
    normalized["reference_urls"] = deduped_urls
    for key in ("product_name", "target_audience", "product_features", "brand_tone", "must_include", "banned_terms"):
        normalized[key] = str(normalized.get(key) or "").strip()
    if not normalized["brand_tone"]:
        normalized["brand_tone"] = PRODUCT_BRIEF_DEFAULTS["brand_tone"]
    return normalized


def has_meaningful_product_brief(brief: Optional[Dict[str, Any]]) -> bool:
    normalized = normalize_product_brief(brief)
    return bool(
        normalized["product_name"]
        or normalized["target_audience"]
        or normalized["product_features"]
        or normalized["must_include"]
        or normalized["banned_terms"]
        or normalized["reference_urls"]
    )


def build_product_brief_signature(brief: Optional[Dict[str, Any]]) -> str:
    normalized = normalize_product_brief(brief)
    payload = json.dumps(
        {
            "product_name": normalized["product_name"],
            "target_audience": normalized["target_audience"],
            "product_features": normalized["product_features"],
            "brand_tone": normalized["brand_tone"],
            "must_include": normalized["must_include"],
            "banned_terms": normalized["banned_terms"],
            "reference_urls": normalized["reference_urls"],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def serialize_product_profile(profile: ProductProfile) -> Dict[str, Any]:
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "product_brief": normalize_product_brief(safe_json_loads(profile.product_brief, {})),
        "research_context": safe_json_loads(profile.research_context, None),
        "source_signature": profile.source_signature,
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
    }


def get_product_profile(db: Session, user_id: str) -> Optional[ProductProfile]:
    ensure_product_profile_schema(db)
    return db.query(ProductProfile).filter(ProductProfile.user_id == user_id).first()


def recover_latest_history_brief(db: Session, user_id: str) -> Optional[Dict[str, Any]]:
    ensure_product_profile_schema(db)
    histories = db.query(ScrapeHistory).filter(
        ScrapeHistory.user_id == user_id,
        ScrapeHistory.product_brief.isnot(None),
    ).order_by(ScrapeHistory.created_at.desc()).limit(10).all()

    for history in histories:
        brief = normalize_product_brief(safe_json_loads(history.product_brief, {}))
        if has_meaningful_product_brief(brief):
            return brief
    return None


def upsert_product_profile(
    db: Session,
    user_id: str,
    product_brief: Dict[str, Any],
    *,
    research_context: Optional[Dict[str, Any]] = None,
    preserve_research_context: bool = True,
) -> ProductProfile:
    ensure_product_profile_schema(db)
    normalized = normalize_product_brief(product_brief)
    signature = build_product_brief_signature(normalized)
    profile = get_product_profile(db, user_id)
    serialized_brief = json.dumps(normalized, ensure_ascii=False)
    serialized_research = json.dumps(research_context, ensure_ascii=False) if research_context is not None else None

    now = datetime.utcnow()
    if not profile:
        profile = ProductProfile(
            user_id=user_id,
            product_brief=serialized_brief,
            research_context=serialized_research,
            source_signature=signature,
            created_at=now,
            updated_at=now,
        )
        db.add(profile)
        return profile

    signature_changed = profile.source_signature != signature
    profile.product_brief = serialized_brief
    profile.source_signature = signature
    profile.updated_at = now
    if research_context is not None:
        profile.research_context = serialized_research
    elif signature_changed and not preserve_research_context:
        profile.research_context = None
    return profile


def ensure_product_profile_schema(db: Session) -> None:
    if not settings.allow_runtime_schema_fallback:
        return
    if db is None or db.bind is None:
        return
    inspector = inspect(db.bind)
    if "product_profiles" in inspector.get_table_names():
        return
    ProductProfile.__table__.create(db.bind, checkfirst=True)
