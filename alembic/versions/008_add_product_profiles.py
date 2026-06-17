"""Add product profiles table

Revision ID: 008
Revises: 007
Create Date: 2026-05-08 18:00:00.000000
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


LONG_TEXT = sa.Text().with_variant(mysql.LONGTEXT(), "mysql")


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "product_profiles" in inspector.get_table_names():
        return

    op.create_table(
        "product_profiles",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.String(length=64), nullable=False, comment="用户ID"),
        sa.Column("product_brief", LONG_TEXT, nullable=False, comment="当前产品参数JSON"),
        sa.Column("research_context", LONG_TEXT, nullable=True, comment="产品网页解析与研究上下文JSON"),
        sa.Column("source_signature", sa.String(length=512), nullable=True, comment="产品参数与资料链接签名"),
        sa.Column("created_at", sa.DateTime(), nullable=True, comment="创建时间"),
        sa.Column("updated_at", sa.DateTime(), nullable=True, comment="更新时间"),
    )
    op.create_index("ix_product_profiles_user_id", "product_profiles", ["user_id"], unique=True)
    op.create_index("idx_product_profiles_user_updated", "product_profiles", ["user_id", "updated_at"], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "product_profiles" not in inspector.get_table_names():
        return

    existing_indexes = {index["name"] for index in inspector.get_indexes("product_profiles")}
    if "idx_product_profiles_user_updated" in existing_indexes:
        op.drop_index("idx_product_profiles_user_updated", table_name="product_profiles")
    if "ix_product_profiles_user_id" in existing_indexes:
        op.drop_index("ix_product_profiles_user_id", table_name="product_profiles")
    op.drop_table("product_profiles")
