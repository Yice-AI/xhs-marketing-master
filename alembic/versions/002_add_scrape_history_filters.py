"""Add scrape history filters

Revision ID: 002
Revises: 001
Create Date: 2026-04-03
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scrape_history",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False, comment="用户ID"),
        sa.Column("task_id", sa.String(length=64), nullable=False, comment="任务唯一标识"),
        sa.Column("keyword", sa.String(length=128), nullable=True, comment="采集关键词"),
        sa.Column("notes_count", sa.Integer(), nullable=True, comment="采集数量"),
        sa.Column("notes_data", sa.Text(), nullable=True, comment="采集笔记数据JSON"),
        sa.Column("analysis_result", sa.Text(), nullable=True, comment="AI分析结果JSON"),
        sa.Column("filters", sa.Text(), nullable=True, comment="采集筛选条件JSON"),
        sa.Column("created_at", sa.DateTime(), nullable=True, comment="采集时间"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scrape_history_task_id", "scrape_history", ["task_id"], unique=True)
    op.create_index("ix_scrape_history_user_id", "scrape_history", ["user_id"], unique=False)
    op.create_index("idx_scrape_user_created", "scrape_history", ["user_id", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_scrape_user_created", table_name="scrape_history")
    op.drop_index("ix_scrape_history_user_id", table_name="scrape_history")
    op.drop_index("ix_scrape_history_task_id", table_name="scrape_history")
    op.drop_table("scrape_history")
