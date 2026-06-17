"""Upgrade task result JSON fields to LONGTEXT for MySQL

Revision ID: 012
Revises: 011
Create Date: 2026-05-17 21:45:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def _alter_task_json_columns(target_type: sa.types.TypeEngine) -> None:
    bind = op.get_bind()
    if bind.dialect.name != "mysql":
        return

    inspector = sa.inspect(bind)
    if "image_generation_tasks" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("image_generation_tasks")}
    for column_name in ("result_json", "metadata_json"):
        if column_name not in columns:
            continue
        op.alter_column(
            "image_generation_tasks",
            column_name,
            existing_type=sa.Text(),
            type_=target_type,
            existing_nullable=True,
        )


def upgrade() -> None:
    _alter_task_json_columns(mysql.LONGTEXT())


def downgrade() -> None:
    _alter_task_json_columns(sa.Text())
