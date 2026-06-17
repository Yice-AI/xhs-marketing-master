from backend.database import db_session
from backend.database.models import Base
from backend.utils.image_task_store import ensure_image_task_schema
from backend.utils.logger import logger
from backend.config import settings


def init_database():
    db_session.init_database()
    if db_session.engine is None:
        logger.warning("[Database] 未配置 DATABASE_URL，跳过数据库初始化")
        return

    if settings.allow_runtime_schema_fallback:
        Base.metadata.create_all(bind=db_session.engine)
        ensure_image_task_schema()
        logger.info("[Database] 本地运行时 schema 兜底已启用")
        return

    logger.info("[Database] 生产模式不执行运行时 schema 变更，请使用 Alembic migration")


if __name__ == "__main__":
    init_database()
