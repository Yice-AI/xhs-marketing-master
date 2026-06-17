"""Add visual assets and persisted task tables

Revision ID: 003
Revises: 002
Create Date: 2026-04-21
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    scrape_columns = {column["name"] for column in inspector.get_columns("scrape_history")}
    if "product_brief" not in scrape_columns:
        op.add_column("scrape_history", sa.Column("product_brief", sa.Text(), nullable=True, comment="产品参数快照JSON"))

    if "reference_assets" not in inspector.get_table_names():
        op.create_table(
            "reference_assets",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("asset_id", sa.String(length=64), nullable=False, comment="素材唯一标识"),
            sa.Column("user_id", sa.String(length=64), nullable=False, comment="用户ID"),
            sa.Column("file_name", sa.String(length=256), nullable=False, comment="服务端文件名"),
            sa.Column("original_name", sa.String(length=256), nullable=False, comment="原始文件名"),
            sa.Column("relative_path", sa.String(length=512), nullable=False, comment="相对路径"),
            sa.Column("mime_type", sa.String(length=128), nullable=True, comment="文件类型"),
            sa.Column("size", sa.Integer(), nullable=True, comment="文件大小"),
            sa.Column("width", sa.Integer(), nullable=True, comment="图片宽度"),
            sa.Column("height", sa.Integer(), nullable=True, comment="图片高度"),
            sa.Column("created_at", sa.DateTime(), nullable=True, comment="创建时间"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("asset_id"),
        )
        op.create_index("ix_reference_assets_asset_id", "reference_assets", ["asset_id"], unique=False)
        op.create_index("ix_reference_assets_user_id", "reference_assets", ["user_id"], unique=False)
        op.create_index("idx_reference_asset_user_created", "reference_assets", ["user_id", "created_at"], unique=False)

    if "image_generation_tasks" not in inspector.get_table_names():
        op.create_table(
            "image_generation_tasks",
            sa.Column("task_id", sa.String(length=64), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("progress", sa.Integer(), nullable=True),
            sa.Column("message", sa.Text(), nullable=True),
            sa.Column("error", sa.Text(), nullable=True),
            sa.Column("result_json", sa.Text(), nullable=True),
            sa.Column("metadata_json", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
            sa.PrimaryKeyConstraint("task_id"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if "image_generation_tasks" in inspector.get_table_names():
        op.drop_table("image_generation_tasks")

    if "reference_assets" in inspector.get_table_names():
        op.drop_index("idx_reference_asset_user_created", table_name="reference_assets")
        op.drop_index("ix_reference_assets_user_id", table_name="reference_assets")
        op.drop_index("ix_reference_assets_asset_id", table_name="reference_assets")
        op.drop_table("reference_assets")

    scrape_columns = {column["name"] for column in inspector.get_columns("scrape_history")}
    if "product_brief" in scrape_columns:
        op.drop_column("scrape_history", "product_brief")
