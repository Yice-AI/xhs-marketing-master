"""Add image prompt logs table

Revision ID: 007
Revises: 006
Create Date: 2026-05-08 15:30:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


LONG_TEXT = sa.Text().with_variant(mysql.LONGTEXT(), "mysql")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "image_prompt_logs" in inspector.get_table_names():
        return

    op.create_table(
        "image_prompt_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("log_id", sa.String(length=64), nullable=False),
        sa.Column("task_id", sa.String(length=64), nullable=True),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=256), nullable=True),
        sa.Column("content_excerpt", LONG_TEXT, nullable=True),
        sa.Column("visual_mode", sa.String(length=64), nullable=True),
        sa.Column("prompt_strategy", sa.String(length=64), nullable=True),
        sa.Column("prompt_model", sa.String(length=128), nullable=True),
        sa.Column("image_provider", sa.String(length=64), nullable=True),
        sa.Column("image_model", sa.String(length=128), nullable=True),
        sa.Column("workflow_index", sa.Integer(), nullable=True),
        sa.Column("workflow_total", sa.Integer(), nullable=True),
        sa.Column("prompt_type", sa.String(length=64), nullable=True),
        sa.Column("prompt_title", sa.String(length=256), nullable=True),
        sa.Column("role", sa.String(length=64), nullable=True),
        sa.Column("key_message", LONG_TEXT, nullable=True),
        sa.Column("prompt_text", LONG_TEXT, nullable=False),
        sa.Column("prompt_payload", LONG_TEXT, nullable=True),
        sa.Column("design_plan", LONG_TEXT, nullable=True),
        sa.Column("prompt_stats", LONG_TEXT, nullable=True),
        sa.Column("product_brief", LONG_TEXT, nullable=True),
        sa.Column("dynamic_style_params", LONG_TEXT, nullable=True),
        sa.Column("material_summary", LONG_TEXT, nullable=True),
        sa.Column("reference_summary", LONG_TEXT, nullable=True),
        sa.Column("reference_asset_ids", LONG_TEXT, nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_image_prompt_logs_log_id", "image_prompt_logs", ["log_id"], unique=True)
    op.create_index("ix_image_prompt_logs_task_id", "image_prompt_logs", ["task_id"], unique=False)
    op.create_index("ix_image_prompt_logs_user_id", "image_prompt_logs", ["user_id"], unique=False)
    op.create_index("ix_image_prompt_logs_visual_mode", "image_prompt_logs", ["visual_mode"], unique=False)
    op.create_index("ix_image_prompt_logs_prompt_strategy", "image_prompt_logs", ["prompt_strategy"], unique=False)
    op.create_index("idx_image_prompt_logs_task", "image_prompt_logs", ["task_id"], unique=False)
    op.create_index("idx_image_prompt_logs_user_created", "image_prompt_logs", ["user_id", "created_at"], unique=False)
    op.create_index(
        "idx_image_prompt_logs_user_strategy_created",
        "image_prompt_logs",
        ["user_id", "prompt_strategy", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "image_prompt_logs" not in inspector.get_table_names():
        return

    existing_indexes = {index["name"] for index in inspector.get_indexes("image_prompt_logs")}
    for index_name in (
        "idx_image_prompt_logs_user_strategy_created",
        "idx_image_prompt_logs_user_created",
        "idx_image_prompt_logs_task",
        "ix_image_prompt_logs_prompt_strategy",
        "ix_image_prompt_logs_visual_mode",
        "ix_image_prompt_logs_user_id",
        "ix_image_prompt_logs_task_id",
        "ix_image_prompt_logs_log_id",
    ):
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name="image_prompt_logs")
    op.drop_table("image_prompt_logs")
