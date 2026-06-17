"""Add creative drafts table

Revision ID: 006
Revises: 005
Create Date: 2026-04-28 18:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "creative_drafts" in inspector.get_table_names():
        return

    op.create_table(
        "creative_drafts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("draft_id", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=False),
        sa.Column("session_key", sa.String(length=128), nullable=True),
        sa.Column("title", sa.String(length=256), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="latest_auto"),
        sa.Column("source_context", sa.String(length=256), nullable=True),
        sa.Column("snapshot_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("content_payload", sa.Text(), nullable=False),
        sa.Column("preview_payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=True),
        sa.Column("last_opened_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_creative_drafts_draft_id", "creative_drafts", ["draft_id"], unique=True)
    op.create_index("ix_creative_drafts_user_id", "creative_drafts", ["user_id"], unique=False)
    op.create_index("ix_creative_drafts_session_key", "creative_drafts", ["session_key"], unique=False)
    op.create_index("idx_creative_drafts_user_updated", "creative_drafts", ["user_id", "updated_at"], unique=False)
    op.create_index("idx_creative_drafts_user_session_status", "creative_drafts", ["user_id", "session_key", "status"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "creative_drafts" not in inspector.get_table_names():
        return

    existing_indexes = {index["name"] for index in inspector.get_indexes("creative_drafts")}
    if "idx_creative_drafts_user_session_status" in existing_indexes:
        op.drop_index("idx_creative_drafts_user_session_status", table_name="creative_drafts")
    if "idx_creative_drafts_user_updated" in existing_indexes:
        op.drop_index("idx_creative_drafts_user_updated", table_name="creative_drafts")
    if "ix_creative_drafts_session_key" in existing_indexes:
        op.drop_index("ix_creative_drafts_session_key", table_name="creative_drafts")
    if "ix_creative_drafts_user_id" in existing_indexes:
        op.drop_index("ix_creative_drafts_user_id", table_name="creative_drafts")
    if "ix_creative_drafts_draft_id" in existing_indexes:
        op.drop_index("ix_creative_drafts_draft_id", table_name="creative_drafts")
    op.drop_table("creative_drafts")
