"""Add note strategy logs table

Revision ID: 010
Revises: 009
Create Date: 2026-05-15 18:05:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


LONG_TEXT = sa.Text().with_variant(mysql.LONGTEXT(), "mysql")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "note_strategy_logs" in inspector.get_table_names():
        return

    op.create_table(
        "note_strategy_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("log_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("product_name", sa.String(length=256), nullable=True),
        sa.Column("strategy_mode", sa.String(length=64), nullable=True),
        sa.Column("product_usage_mode", sa.String(length=64), nullable=True),
        sa.Column("selected_strategy_id", sa.String(length=128), nullable=True),
        sa.Column("fallback_used", sa.Boolean(), nullable=True),
        sa.Column("fallback_reason", LONG_TEXT, nullable=True),
        sa.Column("model_name", sa.String(length=128), nullable=True),
        sa.Column("runtime_ms", sa.Integer(), nullable=True),
        sa.Column("research_context", LONG_TEXT, nullable=True),
        sa.Column("benchmark_note", LONG_TEXT, nullable=True),
        sa.Column("real_phrases", LONG_TEXT, nullable=True),
        sa.Column("strategy_feedback", LONG_TEXT, nullable=True),
        sa.Column("benchmark_fit", LONG_TEXT, nullable=True),
        sa.Column("strategies", LONG_TEXT, nullable=True),
        sa.Column("response_payload", LONG_TEXT, nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_note_strategy_logs_log_id", "note_strategy_logs", ["log_id"], unique=True)
    op.create_index("ix_note_strategy_logs_user_id", "note_strategy_logs", ["user_id"], unique=False)
    op.create_index("ix_note_strategy_logs_product_name", "note_strategy_logs", ["product_name"], unique=False)
    op.create_index("ix_note_strategy_logs_strategy_mode", "note_strategy_logs", ["strategy_mode"], unique=False)
    op.create_index("ix_note_strategy_logs_product_usage_mode", "note_strategy_logs", ["product_usage_mode"], unique=False)
    op.create_index("idx_note_strategy_logs_user_created", "note_strategy_logs", ["user_id", "created_at"], unique=False)
    op.create_index(
        "idx_note_strategy_logs_user_mode_created",
        "note_strategy_logs",
        ["user_id", "strategy_mode", "created_at"],
        unique=False,
    )
    op.create_index(
        "idx_note_strategy_logs_user_usage_created",
        "note_strategy_logs",
        ["user_id", "product_usage_mode", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "note_strategy_logs" not in inspector.get_table_names():
        return

    existing_indexes = {index["name"] for index in inspector.get_indexes("note_strategy_logs")}
    for index_name in (
        "idx_note_strategy_logs_user_usage_created",
        "idx_note_strategy_logs_user_mode_created",
        "idx_note_strategy_logs_user_created",
        "ix_note_strategy_logs_product_usage_mode",
        "ix_note_strategy_logs_strategy_mode",
        "ix_note_strategy_logs_product_name",
        "ix_note_strategy_logs_user_id",
        "ix_note_strategy_logs_log_id",
    ):
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name="note_strategy_logs")
    op.drop_table("note_strategy_logs")
