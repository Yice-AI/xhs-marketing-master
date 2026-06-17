from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
import httpx
from backend.utils.logger import logger

router = APIRouter(prefix="/image-proxy", tags=["图片代理"])

@router.get("")
async def proxy_image(url: str):
    """代理小红书图片,绕过防盗链"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                    "Referer": "https://www.xiaohongshu.com/"
                },
                timeout=10.0
            )
            
            if response.status_code == 200:
                return Response(
                    content=response.content,
                    media_type=response.headers.get("content-type", "image/webp")
                )
            else:
                raise HTTPException(status_code=response.status_code, detail="图片加载失败")
                
    except Exception as e:
        logger.error(f"图片代理失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
