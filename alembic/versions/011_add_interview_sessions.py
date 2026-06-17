"""Add interview sessions table

Revision ID: 011
Revises: 010
Create Date: 2026-05-16 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


LONG_TEXT = sa.Text().with_variant(mysql.LONGTEXT(), "mysql")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "interview_sessions" in inspector.get_table_names():
        return

    op.create_table(
        "interview_sessions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("session_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="asking"),
        sa.Column("agent_snapshot", LONG_TEXT, nullable=False),
        sa.Column("ui_snapshot", LONG_TEXT, nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_interview_sessions_session_id", "interview_sessions", ["session_id"], unique=True)
    op.create_index("ix_interview_sessions_user_id", "interview_sessions", ["user_id"], unique=False)
    op.create_index("idx_interview_sessions_user_updated", "interview_sessions", ["user_id", "updated_at"], unique=False)
    op.create_index(
        "idx_interview_sessions_user_status_updated",
        "interview_sessions",
        ["user_id", "status", "updated_at"],
        unique=False,
    )
    op.create_index("idx_interview_sessions_expires", "interview_sessions", ["expires_at"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "interview_sessions" not in inspector.get_table_names():
        return

    existing_indexes = {index["name"] for index in inspector.get_indexes("interview_sessions")}
    for index_name in (
        "idx_interview_sessions_expires",
        "idx_interview_sessions_user_status_updated",
        "idx_interview_sessions_user_updated",
        "ix_interview_sessions_user_id",
        "ix_interview_sessions_session_id",
    ):
        if index_name in existing_indexes:
            op.drop_index(index_name, table_name="interview_sessions")
    op.drop_table("interview_sessions")
