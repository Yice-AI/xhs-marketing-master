from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from backend.config.settings import settings
from typing import Generator

engine = None
SessionLocal = None


def init_database():
    global engine, SessionLocal
    
    if not hasattr(settings, 'DATABASE_URL') or not settings.DATABASE_URL:
        return
    
    engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=3600,
        echo=settings.SQL_ECHO,
    )
    
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    if SessionLocal is None:
        init_database()
    
    if SessionLocal is None:
        yield None
        return
    
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
