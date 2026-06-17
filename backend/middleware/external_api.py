from hashlib import sha256
from typing import Optional

from fastapi import Header, HTTPException

from backend.config.settings import settings


async def get_external_api_client_id(
    authorization: Optional[str] = Header(None, alias="Authorization"),
) -> str:
    if not settings.EXTERNAL_API_ENABLED:
        raise HTTPException(status_code=403, detail="外部 API 未启用")

    if not authorization:
        raise HTTPException(status_code=401, detail="缺少 Authorization 认证信息")

    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization 格式无效")

    token = authorization.replace("Bearer ", "", 1).strip()
    if not token:
        raise HTTPException(status_code=401, detail="API Key 不能为空")

    if token not in settings.EXTERNAL_API_KEYS:
        raise HTTPException(status_code=403, detail="API Key 无效")

    digest = sha256(token.encode("utf-8")).hexdigest()[:12]
    return f"external-api:{digest}"
