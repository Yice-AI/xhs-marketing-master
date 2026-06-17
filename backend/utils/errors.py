from enum import IntEnum
from fastapi import HTTPException
from typing import Optional, Dict, Any


class ErrorCode(IntEnum):
    
    UNAUTHORIZED = 1001
    TOKEN_EXPIRED = 1002
    INVALID_CREDENTIALS = 1003
    
    QUOTA_EXCEEDED = 2001
    RATE_LIMIT_EXCEEDED = 2002
    COST_LIMIT_EXCEEDED = 2003
    
    CLIENT_OFFLINE = 3001
    CLIENT_VERSION_TOO_OLD = 3002
    
    GENERATION_FAILED = 4001
    PUBLISH_FAILED = 4002
    INVALID_INPUT = 4003
    
    INTERNAL_ERROR = 5001
    DATABASE_ERROR = 5002
    EXTERNAL_API_ERROR = 5003


class AppException(Exception):
    
    def __init__(
        self,
        error_code: ErrorCode,
        message: str,
        user_message: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        status_code: int = 400
    ):
        self.error_code = error_code
        self.message = message
        self.user_message = user_message or message
        self.details = details or {}
        self.status_code = status_code
        super().__init__(self.message)


class UnauthorizedException(AppException):
    def __init__(self, message: str = "未授权", user_message: Optional[str] = None):
        super().__init__(
            error_code=ErrorCode.UNAUTHORIZED,
            message=message,
            user_message=user_message or "请先登录",
            status_code=401
        )


class QuotaExceededException(AppException):
    def __init__(self, quota_type: str, limit: int, used: int):
        super().__init__(
            error_code=ErrorCode.QUOTA_EXCEEDED,
            message=f"Quota exceeded: {quota_type}",
            user_message=f"配额已用完,今日限额: {limit},已使用: {used}",
            details={
                "quota_type": quota_type,
                "limit": limit,
                "used": used
            },
            status_code=429
        )


class ClientOfflineException(AppException):
    def __init__(self):
        super().__init__(
            error_code=ErrorCode.CLIENT_OFFLINE,
            message="Client is offline",
            user_message="本地客户端离线,请先启动客户端",
            status_code=503
        )


class GenerationFailedException(AppException):
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            error_code=ErrorCode.GENERATION_FAILED,
            message=message,
            user_message="内容生成失败,请重试",
            details=details,
            status_code=500
        )


class PublishFailedException(AppException):
    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(
            error_code=ErrorCode.PUBLISH_FAILED,
            message=message,
            user_message="发布失败,请检查登录状态后重试",
            details=details,
            status_code=500
        )
