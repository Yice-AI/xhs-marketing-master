"""Add collection mode fields to scrape history

Revision ID: 005
Revises: 004_upgrade_scrape_history_json_fields_to_longtext
Create Date: 2026-04-28 17:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "scrape_history" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("scrape_history")}
    if "collection_mode" not in existing_columns:
        op.add_column(
            "scrape_history",
            sa.Column("collection_mode", sa.String(length=32), nullable=True, comment="采集模式 keyword|url"),
        )
    if "source_input" not in existing_columns:
        op.add_column(
            "scrape_history",
            sa.Column("source_input", sa.Text(), nullable=True, comment="原始输入，关键词或URL"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "scrape_history" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("scrape_history")}
    if "source_input" in existing_columns:
        op.drop_column("scrape_history", "source_input")
    if "collection_mode" in existing_columns:
        op.drop_column("scrape_history", "collection_mode")
