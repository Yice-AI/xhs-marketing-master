from fastapi import Header, HTTPException
from typing import Optional

from backend.config.settings import settings
from backend.services.auth_service import decode_access_token
from backend.utils.logger import logger


async def get_current_user_id(
    authorization: Optional[str] = Header(None, alias="Authorization"),
) -> str:
    if not settings.AUTH_REQUIRED:
        return settings.DEFAULT_DEV_USER_ID

    if not authorization:
        if not settings.is_production and settings.ALLOW_DEV_AUTH_BYPASS:
            logger.warning("[Auth] 未提供 Authorization，使用开发用户兜底")
            return settings.DEFAULT_DEV_USER_ID
        raise HTTPException(status_code=401, detail="缺少 Authorization 认证信息")

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization 格式无效")

    token = authorization.replace("Bearer ", "", 1).strip()
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="登录态已失效，请重新登录")

    user_id = str(payload.get("sub") or "").strip()
    if not user_id:
        raise HTTPException(status_code=401, detail="认证令牌缺少用户标识")

    return user_id
