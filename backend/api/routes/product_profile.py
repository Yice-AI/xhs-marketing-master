from typing import Any, Dict, List, Optional
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database.db_session import get_db
from backend.middleware.auth import get_current_user_id
from backend.services.note_strategy_service import NoteStrategyService
from backend.services.product_profile_service import (
    build_product_brief_signature,
    get_product_profile,
    has_meaningful_product_brief,
    normalize_product_brief,
    recover_latest_history_brief,
    serialize_product_profile,
    upsert_product_profile,
)
from backend.services.text_job_runner import run_research_text_job
from backend.utils.logger import logger


router = APIRouter(prefix="/api/product-profile", tags=["product-profile"])


class ProductProfileRequest(BaseModel):
    product_brief: Dict[str, Any]


class ResearchContextRequest(BaseModel):
    product_brief: Optional[Dict[str, Any]] = None
    reference_assets: Optional[List[Dict[str, Any]]] = None
    benchmark_note: Optional[Dict[str, Any]] = None
    force_refresh: Optional[bool] = False


def _response(profile) -> Dict[str, Any]:
    return {"success": True, "data": serialize_product_profile(profile)}


@router.get("/current")
async def get_current_product_profile(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    try:
        profile = get_product_profile(db, user_id)
        if profile:
            return _response(profile)

        history_brief = recover_latest_history_brief(db, user_id)
        if not history_brief:
            return {"success": True, "data": None}

        profile = upsert_product_profile(db, user_id, history_brief, preserve_research_context=False)
        db.commit()
        db.refresh(profile)
        return _response(profile)
    except Exception as error:
        logger.error("获取产品档案失败: %s", error, exc_info=True)
        raise HTTPException(status_code=500, detail="获取产品档案失败")


@router.put("/current")
async def update_current_product_profile(
    request: ProductProfileRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    try:
        normalized = normalize_product_brief(request.product_brief)
        if not has_meaningful_product_brief(normalized):
            raise HTTPException(status_code=400, detail="产品信息不能为空")

        profile = upsert_product_profile(
            db,
            user_id,
            normalized,
            preserve_research_context=False,
        )
        db.commit()
        db.refresh(profile)
        return _response(profile)
    except HTTPException:
        raise
    except Exception as error:
        logger.error("保存产品档案失败: %s", error, exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail="保存产品档案失败")


@router.post("/research-context")
async def get_or_generate_research_context(
    request: ResearchContextRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    try:
        profile = get_product_profile(db, user_id)
        profile_data = serialize_product_profile(profile) if profile else None
        incoming_brief = normalize_product_brief(request.product_brief or (profile_data or {}).get("product_brief"))
        if not has_meaningful_product_brief(incoming_brief):
            raise HTTPException(status_code=400, detail="请先补全产品信息")

        signature = build_product_brief_signature(incoming_brief)
        cached_context = (profile_data or {}).get("research_context")
        if (
            profile
            and not request.force_refresh
            and profile.source_signature == signature
            and isinstance(cached_context, dict)
            and cached_context
        ):
            return {
                "success": True,
                "message": "已复用缓存的产品研究结果",
                "data": cached_context,
                "cached": True,
                "profile": profile_data,
            }

        service = NoteStrategyService()
        context = await run_research_text_job(
            service.build_research_context,
            product_brief=incoming_brief,
            reference_assets=request.reference_assets or [],
            benchmark_note=request.benchmark_note,
            timeout_seconds=180.0,
        )
        profile = upsert_product_profile(
            db,
            user_id,
            incoming_brief,
            research_context=context,
            preserve_research_context=True,
        )
        db.commit()
        db.refresh(profile)
        return {
            "success": True,
            "message": "产品研究完成",
            "data": context,
            "cached": False,
            "profile": serialize_product_profile(profile),
        }
    except HTTPException:
        raise
    except asyncio.TimeoutError:
        logger.error("生成产品研究上下文超时")
        if db:
            db.rollback()
        service = NoteStrategyService()
        fallback_context = service.build_research_context(
            product_brief=incoming_brief,
            reference_assets=request.reference_assets or [],
            benchmark_note=request.benchmark_note,
            use_model=False,
        )
        try:
            profile = upsert_product_profile(
                db,
                user_id,
                incoming_brief,
                research_context=fallback_context,
                preserve_research_context=True,
            )
            db.commit()
            db.refresh(profile)
            profile_data = serialize_product_profile(profile)
        except Exception:
            if db:
                db.rollback()
            profile_data = profile_data or None
        return {
            "success": True,
            "message": "产品研究完成（已使用本地兜底研究）",
            "data": fallback_context,
            "cached": False,
            "fallback_used": True,
            "profile": profile_data,
        }
    except Exception as error:
        logger.error("生成产品研究上下文失败: %s", error, exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=f"研究产品资料失败: {error}")
