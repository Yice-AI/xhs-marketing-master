"""Initial schema

Revision ID: 001
Revises: 
Create Date: 2026-02-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'users',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.String(length=64), nullable=False, comment='用户ID'),
        sa.Column('username', sa.String(length=128), nullable=False, comment='用户名'),
        sa.Column('password_hash', sa.String(length=256), nullable=False, comment='密码哈希'),
        sa.Column('email', sa.String(length=256), nullable=True, comment='邮箱'),
        sa.Column('is_active', sa.Boolean(), nullable=True, comment='是否激活'),
        sa.Column('created_at', sa.DateTime(), nullable=True, comment='创建时间'),
        sa.Column('updated_at', sa.DateTime(), nullable=True, comment='更新时间'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
        sa.UniqueConstraint('username'),
        sa.UniqueConstraint('email')
    )
    op.create_index(op.f('ix_users_user_id'), 'users', ['user_id'], unique=False)
    
    op.create_table(
        'user_tunnel_ports',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.String(length=64), nullable=False, comment='用户ID'),
        sa.Column('cdp_port', sa.Integer(), nullable=False, comment='CDP隧道端口'),
        sa.Column('mcp_port', sa.Integer(), nullable=False, comment='MCP隧道端口'),
        sa.Column('is_active', sa.Boolean(), nullable=True, comment='是否激活'),
        sa.Column('created_at', sa.DateTime(), nullable=True, comment='创建时间'),
        sa.Column('updated_at', sa.DateTime(), nullable=True, comment='更新时间'),
        sa.Column('last_connected_at', sa.DateTime(), nullable=True, comment='最后连接时间'),
        sa.Column('client_version', sa.String(length=32), nullable=True, comment='客户端版本'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
        sa.UniqueConstraint('cdp_port', name='uq_cdp_port'),
        sa.UniqueConstraint('mcp_port', name='uq_mcp_port')
    )
    op.create_index(op.f('ix_user_tunnel_ports_user_id'), 'user_tunnel_ports', ['user_id'], unique=False)
    
    op.create_table(
        'notes',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.String(length=64), nullable=False, comment='用户ID'),
        sa.Column('note_id', sa.String(length=64), nullable=False, comment='笔记ID'),
        sa.Column('title', sa.String(length=256), nullable=True, comment='标题'),
        sa.Column('content', sa.Text(), nullable=True, comment='内容'),
        sa.Column('keyword', sa.String(length=128), nullable=True, comment='关键词'),
        sa.Column('created_at', sa.DateTime(), nullable=True, comment='创建时间'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_notes_user_id'), 'notes', ['user_id'], unique=False)
    op.create_index(op.f('ix_notes_keyword'), 'notes', ['keyword'], unique=False)
    op.create_index('idx_user_keyword', 'notes', ['user_id', 'keyword'], unique=False)
    op.create_index('idx_user_created', 'notes', ['user_id', 'created_at'], unique=False)


def downgrade() -> None:
    op.drop_index('idx_user_created', table_name='notes')
    op.drop_index('idx_user_keyword', table_name='notes')
    op.drop_index(op.f('ix_notes_keyword'), table_name='notes')
    op.drop_index(op.f('ix_notes_user_id'), table_name='notes')
    op.drop_table('notes')
    
    op.drop_index(op.f('ix_user_tunnel_ports_user_id'), table_name='user_tunnel_ports')
    op.drop_table('user_tunnel_ports')
    
    op.drop_index(op.f('ix_users_user_id'), table_name='users')
    op.drop_table('users')
