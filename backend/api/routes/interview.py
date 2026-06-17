"""
访谈接口
"""

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, Dict, Any
import uuid
import logging

from sqlalchemy.orm import Session
from backend.services.smart_interview_agent import InterviewServiceError, SmartInterviewAgent
from backend.middleware.auth import get_current_user_id
from backend.database.db_session import get_db
from backend.services.interview_session_store import (
    get_interview_session,
    get_latest_interview_session,
    safe_json_loads,
    serialize_interview_session,
    update_interview_ui_snapshot,
    upsert_interview_session,
)
from backend.services.product_profile_service import (
    get_product_profile,
    has_meaningful_product_brief,
    normalize_product_brief,
    recover_latest_history_brief,
    serialize_product_profile,
    upsert_product_profile,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/interview", tags=["interview"])

# 会话存储（生产环境应使用Redis）
sessions: Dict[str, SmartInterviewAgent] = {}


class StartRequest(BaseModel):
    """开始访谈请求"""
    product_brief: Optional[Dict[str, Any]] = None


class MessageRequest(BaseModel):
    """发送消息请求"""
    session_id: str
    message: str


class UISnapshotRequest(BaseModel):
    """保存前端访谈界面快照"""
    ui_snapshot: Dict[str, Any]


def _agent_status(agent: SmartInterviewAgent) -> str:
    return str(getattr(agent, "phase", "") or "asking")


def _persist_agent_snapshot(
    db: Optional[Session],
    *,
    user_id: str,
    session_id: str,
    agent: SmartInterviewAgent,
    ui_snapshot: Optional[Dict[str, Any]] = None,
) -> None:
    if db is None:
        return
    upsert_interview_session(
        db,
        user_id=user_id,
        session_id=session_id,
        status=_agent_status(agent),
        agent_snapshot=agent.to_snapshot(),
        ui_snapshot=ui_snapshot,
    )
    db.commit()


def _restore_agent_from_db(
    db: Optional[Session],
    *,
    user_id: str,
    session_id: str,
) -> Optional[SmartInterviewAgent]:
    if db is None:
        return None
    row = get_interview_session(db, user_id, session_id)
    if row is None:
        return None
    snapshot = safe_json_loads(row.agent_snapshot, {})
    if not isinstance(snapshot, dict):
        return None

    from backend.config import settings
    from backend.services.content_analyzer import resolve_text_generation_config

    api_key, base_url = resolve_text_generation_config()
    model = getattr(settings, "INTERVIEW_MODEL", "gpt-5.4")
    agent = SmartInterviewAgent.from_snapshot(
        snapshot,
        api_key=api_key,
        base_url=base_url,
        model=model,
    )
    sessions[session_id] = agent
    logger.info("[Interview API] 会话 %s 已从数据库恢复", session_id)
    return agent


@router.post("/start")
async def start_interview(
    request: StartRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """
    开始访谈
    """
    logger.info(f"[Interview API] 用户 {user_id} 开始访谈")
    
    try:
        from backend.config import settings
        from backend.services.content_analyzer import resolve_text_generation_config
        
        profile = get_product_profile(db, user_id)
        profile_data = serialize_product_profile(profile) if profile else None
        incoming_brief = normalize_product_brief(request.product_brief)
        if has_meaningful_product_brief(incoming_brief):
            profile = upsert_product_profile(db, user_id, incoming_brief, preserve_research_context=False)
            db.commit()
            db.refresh(profile)
            profile_data = serialize_product_profile(profile)
        elif not profile:
            history_brief = recover_latest_history_brief(db, user_id)
            if history_brief:
                profile = upsert_product_profile(db, user_id, history_brief, preserve_research_context=False)
                db.commit()
                db.refresh(profile)
                profile_data = serialize_product_profile(profile)

        product_brief = (profile_data or {}).get("product_brief") or {}
        research_context = (profile_data or {}).get("research_context")

        # 创建新会话
        session_id = str(uuid.uuid4())
        api_key, base_url = resolve_text_generation_config()
        model = getattr(settings, "INTERVIEW_MODEL", "gpt-5.4")
        
        agent = SmartInterviewAgent(
            user_id=user_id,
            api_key=api_key,
            base_url=base_url,
            model=model,
            product_brief=product_brief,
            research_context=research_context if isinstance(research_context, dict) else None,
        )
        
        # AI自主开始
        response = await agent.start()
        
        # 保存会话
        sessions[session_id] = agent
        _persist_agent_snapshot(db, user_id=user_id, session_id=session_id, agent=agent)
        
        logger.info(f"[Interview API] 会话 {session_id} 创建成功")
        
        return {
            "session_id": session_id,
            **response
        }
    
    except InterviewServiceError as e:
        logger.error(
            "[Interview API] 开始访谈失败 kind=%s status=%s error=%s",
            e.kind,
            e.status_code,
            e.raw_error or e.message,
            exc_info=True,
        )
        raise HTTPException(status_code=e.status_code, detail=e.message)
    except Exception as e:
        logger.error(f"[Interview API] 开始访谈失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"开始访谈失败: {str(e)}")


@router.post("/message")
async def send_message(
    request: MessageRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    """
    发送消息给AI
    """
    logger.info(f"[Interview API] 用户 {user_id} 发送消息到会话 {request.session_id}")
    
    # 获取会话
    agent = sessions.get(request.session_id)
    if not agent:
        agent = _restore_agent_from_db(db, user_id=user_id, session_id=request.session_id)
    if not agent:
        logger.error(f"[Interview API] 会话 {request.session_id} 不存在且无法恢复")
        raise HTTPException(status_code=404, detail="会话不存在或已过期，请重新开始访谈")
    
    try:
        # AI自主处理
        response = await agent.handle_message(request.message)
        
        # 如果访谈结束，保留会话以支持后续修改
        if response.get('action') == 'complete':
            logger.info(f"[Interview API] 会话 {request.session_id} 已完成，保留会话以支持修改")
            # del sessions[request.session_id]
        _persist_agent_snapshot(db, user_id=user_id, session_id=request.session_id, agent=agent)
        
        return response
    
    except InterviewServiceError as e:
        logger.error(
            "[Interview API] 处理消息失败 kind=%s status=%s error=%s",
            e.kind,
            e.status_code,
            e.raw_error or e.message,
            exc_info=True,
        )
        raise HTTPException(status_code=e.status_code, detail=e.message)
    except Exception as e:
        logger.error(f"[Interview API] 处理消息失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"处理消息失败: {str(e)}")


@router.get("/session/current")
async def get_current_interview_session(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    row = get_latest_interview_session(db, user_id) if db is not None else None
    if row is None:
        return {"success": True, "data": None}
    return {"success": True, "data": serialize_interview_session(row, include_payload=True)}


@router.get("/session/{session_id}")
async def get_interview_session_snapshot(
    session_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    row = get_interview_session(db, user_id, session_id) if db is not None else None
    if row is None:
        raise HTTPException(status_code=404, detail="访谈会话不存在或已过期")
    return {"success": True, "data": serialize_interview_session(row, include_payload=True)}


@router.put("/session/{session_id}/ui")
async def save_interview_ui_snapshot(
    session_id: str,
    request: UISnapshotRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db),
):
    row = update_interview_ui_snapshot(
        db,
        user_id=user_id,
        session_id=session_id,
        ui_snapshot=request.ui_snapshot,
    ) if db is not None else None
    if row is None:
        raise HTTPException(status_code=404, detail="访谈会话不存在或已过期")
    db.commit()
    return {"success": True, "data": serialize_interview_session(row, include_payload=False)}
