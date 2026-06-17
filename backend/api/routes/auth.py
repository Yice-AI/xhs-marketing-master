from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.api.models import AuthTokenResponse, AuthUserResponse, LoginRequest, RegisterRequest
from backend.database.db_session import get_db
from backend.database.models import User
from backend.middleware.auth import get_current_user_id
from backend.services.auth_service import create_access_token, create_user_id, hash_password, verify_password
from backend.utils.logger import logger


router = APIRouter(prefix="/api/auth", tags=["auth"])


def _serialize_user(user: User) -> AuthUserResponse:
    return AuthUserResponse(
        user_id=user.user_id,
        username=user.username,
        email=user.email,
        is_active=bool(user.is_active),
    )


@router.post("/register", response_model=AuthTokenResponse)
async def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.username == payload.username).first()
    if existing:
        raise HTTPException(status_code=409, detail="用户名已存在")

    if payload.email:
        existing_email = db.query(User).filter(User.email == payload.email).first()
        if existing_email:
            raise HTTPException(status_code=409, detail="邮箱已存在")

    user = User(
        user_id=create_user_id(),
        username=payload.username.strip(),
        password_hash=hash_password(payload.password),
        email=payload.email,
        is_active=True,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(subject=user.user_id, username=user.username)
    logger.info("[Auth] 注册成功: username=%s user_id=%s", user.username, user.user_id)
    return AuthTokenResponse(access_token=token, user=_serialize_user(user))


@router.post("/login", response_model=AuthTokenResponse)
async def login(payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == payload.username.strip()).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被停用")

    user.updated_at = datetime.utcnow()
    db.commit()

    token = create_access_token(subject=user.user_id, username=user.username)
    return AuthTokenResponse(access_token=token, user=_serialize_user(user))


@router.get("/me", response_model=AuthUserResponse)
async def get_me(current_user_id: str = Depends(get_current_user_id), db: Session = Depends(get_db)):
    user = db.query(User).filter(User.user_id == current_user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return _serialize_user(user)
