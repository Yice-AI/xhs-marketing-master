"""Add reference asset metadata

Revision ID: 009
Revises: 008
Create Date: 2026-05-09 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reference_assets" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("reference_assets")}
    if "source" not in columns:
        op.add_column("reference_assets", sa.Column("source", sa.String(length=64), nullable=True, comment="素材来源"))
    if "display_name" not in columns:
        op.add_column("reference_assets", sa.Column("display_name", sa.String(length=256), nullable=True, comment="素材显示名称"))
    if "note" not in columns:
        op.add_column("reference_assets", sa.Column("note", sa.Text(), nullable=True, comment="用户备注"))
    if "tags" not in columns:
        op.add_column("reference_assets", sa.Column("tags", sa.Text(), nullable=True, comment="素材标签JSON"))
    if "ai_hint" not in columns:
        op.add_column("reference_assets", sa.Column("ai_hint", sa.Text(), nullable=True, comment="给AI的素材说明"))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reference_assets" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("reference_assets")}
    for column_name in ["ai_hint", "tags", "note", "display_name", "source"]:
        if column_name in columns:
            op.drop_column("reference_assets", column_name)
