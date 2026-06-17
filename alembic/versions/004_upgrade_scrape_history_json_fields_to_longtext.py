"""Upgrade scrape history JSON fields to LONGTEXT for MySQL

Revision ID: 004
Revises: 003
Create Date: 2026-04-22
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _alter_scrape_history_columns(target_type: sa.types.TypeEngine) -> None:
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return

    inspector = sa.inspect(bind)
    if "scrape_history" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("scrape_history")}
    for column_name, comment in (
        ("notes_data", "采集笔记数据JSON"),
        ("analysis_result", "AI分析结果JSON"),
        ("filters", "采集筛选条件JSON"),
        ("product_brief", "产品参数快照JSON"),
    ):
        if column_name not in columns:
            continue
        op.alter_column(
            "scrape_history",
            column_name,
            existing_type=sa.Text(),
            type_=target_type,
            existing_nullable=True,
            existing_comment=comment,
        )


def upgrade() -> None:
    _alter_scrape_history_columns(mysql.LONGTEXT())


def downgrade() -> None:
    _alter_scrape_history_columns(sa.Text())
