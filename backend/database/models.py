from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, UniqueConstraint, Index
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.dialects.mysql import LONGTEXT
from datetime import datetime
import json

Base = declarative_base()
LONG_TEXT = Text().with_variant(LONGTEXT(), "mysql")


class User(Base):
    __tablename__ = 'users'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), unique=True, nullable=False, index=True, comment='用户ID')
    username = Column(String(128), unique=True, nullable=False, comment='用户名')
    password_hash = Column(String(256), nullable=False, comment='密码哈希')
    email = Column(String(256), unique=True, nullable=True, comment='邮箱')
    is_active = Column(Boolean, default=True, comment='是否激活')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, comment='更新时间')
    
    def __repr__(self):
        return f"<User(user_id='{self.user_id}', username='{self.username}')>"


class ScrapeHistory(Base):
    __tablename__ = 'scrape_history'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    task_id = Column(String(64), unique=True, index=True, nullable=False, comment='任务唯一标识')
    keyword = Column(String(128), comment='采集关键词')
    collection_mode = Column(String(32), nullable=True, comment='采集模式 keyword|url')
    source_input = Column(String(1024), nullable=True, comment='原始输入，关键词或URL')
    notes_count = Column(Integer, default=0, comment='采集数量')
    notes_data = Column(LONG_TEXT, comment='采集笔记数据JSON')
    analysis_result = Column(LONG_TEXT, nullable=True, comment='AI分析结果JSON')
    filters = Column(LONG_TEXT, nullable=True, comment='采集筛选条件JSON')
    product_brief = Column(LONG_TEXT, nullable=True, comment='产品参数快照JSON')
    created_at = Column(DateTime, default=datetime.utcnow, comment='采集时间')
    
    __table_args__ = (
        Index('idx_scrape_user_created', 'user_id', 'created_at'),
    )
    
    def __repr__(self):
        return f"<ScrapeHistory(id={self.id}, user_id='{self.user_id}', keyword='{self.keyword}')>"

    def to_dict(self, include_data=False):
        res = {
            'id': self.id,
            'user_id': self.user_id,
            'task_id': self.task_id,
            'keyword': self.keyword,
            'collection_mode': self.collection_mode,
            'source_input': self.source_input,
            'notes_count': self.notes_count,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }
        if include_data:
            res['notes_data'] = self.notes_data
            res['analysis_result'] = self.analysis_result
            res['filters'] = self.filters
            res['product_brief'] = self.product_brief
        else:
            res['analysis_result'] = self.analysis_result
            res['filters'] = self.filters
            res['product_brief'] = self.product_brief
        return res


class ProductProfile(Base):
    __tablename__ = 'product_profiles'

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), unique=True, nullable=False, index=True, comment='用户ID')
    product_brief = Column(LONG_TEXT, nullable=False, comment='当前产品参数JSON')
    research_context = Column(LONG_TEXT, nullable=True, comment='产品网页解析与研究上下文JSON')
    source_signature = Column(String(512), nullable=True, comment='产品参数与资料链接签名')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, comment='更新时间')

    __table_args__ = (
        Index('idx_product_profiles_user_updated', 'user_id', 'updated_at'),
    )

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'product_brief': self.product_brief,
            'research_context': self.research_context,
            'source_signature': self.source_signature,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class ReferenceAsset(Base):
    __tablename__ = 'reference_assets'

    id = Column(Integer, primary_key=True, autoincrement=True)
    asset_id = Column(String(64), unique=True, index=True, nullable=False, comment='素材唯一标识')
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    file_name = Column(String(256), nullable=False, comment='服务端文件名')
    original_name = Column(String(256), nullable=False, comment='原始文件名')
    relative_path = Column(String(512), nullable=False, comment='相对路径')
    mime_type = Column(String(128), nullable=True, comment='文件类型')
    size = Column(Integer, nullable=True, comment='文件大小')
    width = Column(Integer, nullable=True, comment='图片宽度')
    height = Column(Integer, nullable=True, comment='图片高度')
    source = Column(String(64), nullable=True, comment='素材来源 project_library|chat_attachment')
    display_name = Column(String(256), nullable=True, comment='素材显示名称')
    note = Column(Text, nullable=True, comment='用户备注')
    tags = Column(Text, nullable=True, comment='素材标签JSON')
    ai_hint = Column(Text, nullable=True, comment='给AI的素材说明')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')

    __table_args__ = (
        Index('idx_reference_asset_user_created', 'user_id', 'created_at'),
    )

    def to_dict(self):
        parsed_tags = []
        if self.tags:
            try:
                parsed_tags = json.loads(self.tags)
            except Exception:
                parsed_tags = []
        return {
            'id': self.asset_id,
            'user_id': self.user_id,
            'file_name': self.file_name,
            'original_name': self.original_name,
            'relative_path': self.relative_path,
            'mime_type': self.mime_type,
            'size': self.size,
            'width': self.width,
            'height': self.height,
            'source': self.source or 'project_library',
            'display_name': self.display_name or self.original_name,
            'note': self.note or '',
            'tags': parsed_tags if isinstance(parsed_tags, list) else [],
            'ai_hint': self.ai_hint or '',
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class CreativeDraft(Base):
    __tablename__ = 'creative_drafts'

    id = Column(Integer, primary_key=True, autoincrement=True)
    draft_id = Column(String(64), unique=True, index=True, nullable=False, comment='草稿唯一标识')
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    session_key = Column(String(128), nullable=True, index=True, comment='当前创作会话键')
    title = Column(String(256), nullable=False, comment='草稿标题')
    status = Column(String(32), nullable=False, default='latest_auto', comment='草稿状态 latest_auto|manual_saved|archived')
    source_context = Column(String(256), nullable=True, comment='草稿来源上下文')
    snapshot_version = Column(Integer, nullable=False, default=1, comment='快照版本')
    content_payload = Column(LONG_TEXT, nullable=False, comment='完整草稿快照JSON')
    preview_payload = Column(LONG_TEXT, nullable=False, comment='草稿预览JSON')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, comment='更新时间')
    last_opened_at = Column(DateTime, nullable=True, comment='最近打开时间')

    __table_args__ = (
        Index('idx_creative_drafts_user_updated', 'user_id', 'updated_at'),
        Index('idx_creative_drafts_user_session_status', 'user_id', 'session_key', 'status'),
    )

    def to_dict(self, include_payload=False):
        data = {
            'draft_id': self.draft_id,
            'user_id': self.user_id,
            'session_key': self.session_key,
            'title': self.title,
            'status': self.status,
            'source_context': self.source_context,
            'snapshot_version': self.snapshot_version,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'last_opened_at': self.last_opened_at.isoformat() if self.last_opened_at else None,
        }
        if include_payload:
            data['content_payload'] = self.content_payload
        data['preview_payload'] = self.preview_payload
        return data


class InterviewSession(Base):
    __tablename__ = 'interview_sessions'

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String(64), unique=True, index=True, nullable=False, comment='访谈会话ID')
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    status = Column(String(32), nullable=False, default='asking', comment='访谈状态 asking|title_selection|content_ready|expired')
    agent_snapshot = Column(LONG_TEXT, nullable=False, comment='后端访谈代理快照JSON')
    ui_snapshot = Column(LONG_TEXT, nullable=True, comment='前端访谈界面快照JSON')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, comment='更新时间')
    expires_at = Column(DateTime, nullable=True, comment='过期时间')

    __table_args__ = (
        Index('idx_interview_sessions_user_updated', 'user_id', 'updated_at'),
        Index('idx_interview_sessions_user_status_updated', 'user_id', 'status', 'updated_at'),
        Index('idx_interview_sessions_expires', 'expires_at'),
    )

    def to_dict(self, include_payload=False):
        data = {
            'session_id': self.session_id,
            'user_id': self.user_id,
            'status': self.status,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'expires_at': self.expires_at.isoformat() if self.expires_at else None,
        }
        if include_payload:
            data['agent_snapshot'] = self.agent_snapshot
            data['ui_snapshot'] = self.ui_snapshot
        return data


class ImagePromptLog(Base):
    __tablename__ = 'image_prompt_logs'

    id = Column(Integer, primary_key=True, autoincrement=True)
    log_id = Column(String(64), unique=True, index=True, nullable=False, comment='提示词日志ID')
    task_id = Column(String(64), nullable=True, index=True, comment='生图任务ID')
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    title = Column(String(256), nullable=True, comment='笔记标题')
    content_excerpt = Column(LONG_TEXT, nullable=True, comment='笔记正文摘要')
    visual_mode = Column(String(64), nullable=True, index=True, comment='前端视觉模式')
    prompt_strategy = Column(String(64), nullable=True, index=True, comment='后端提示词策略')
    prompt_model = Column(String(128), nullable=True, comment='提示词模型')
    image_provider = Column(String(64), nullable=True, comment='生图供应商')
    image_model = Column(String(128), nullable=True, comment='生图模型')
    workflow_index = Column(Integer, nullable=True, comment='组图序号')
    workflow_total = Column(Integer, nullable=True, comment='组图总数')
    prompt_type = Column(String(64), nullable=True, comment='提示词类型')
    prompt_title = Column(String(256), nullable=True, comment='单图标题')
    role = Column(String(64), nullable=True, comment='图位角色')
    key_message = Column(LONG_TEXT, nullable=True, comment='核心表达')
    prompt_text = Column(LONG_TEXT, nullable=False, comment='最终生图提示词')
    prompt_payload = Column(LONG_TEXT, nullable=True, comment='提示词完整结构JSON')
    design_plan = Column(LONG_TEXT, nullable=True, comment='动态表达设计规划JSON')
    prompt_stats = Column(LONG_TEXT, nullable=True, comment='提示词生成统计JSON')
    product_brief = Column(LONG_TEXT, nullable=True, comment='产品参数快照JSON')
    dynamic_style_params = Column(LONG_TEXT, nullable=True, comment='动态表达自由意图JSON')
    material_summary = Column(LONG_TEXT, nullable=True, comment='用户补充意图')
    reference_summary = Column(LONG_TEXT, nullable=True, comment='参考说明')
    reference_asset_ids = Column(LONG_TEXT, nullable=True, comment='参考素材ID列表JSON')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')

    __table_args__ = (
        Index('idx_image_prompt_logs_user_created', 'user_id', 'created_at'),
        Index('idx_image_prompt_logs_user_strategy_created', 'user_id', 'prompt_strategy', 'created_at'),
        Index('idx_image_prompt_logs_task', 'task_id'),
    )

    def to_dict(self):
        return {
            'log_id': self.log_id,
            'task_id': self.task_id,
            'user_id': self.user_id,
            'title': self.title,
            'content_excerpt': self.content_excerpt,
            'visual_mode': self.visual_mode,
            'prompt_strategy': self.prompt_strategy,
            'prompt_model': self.prompt_model,
            'image_provider': self.image_provider,
            'image_model': self.image_model,
            'workflow_index': self.workflow_index,
            'workflow_total': self.workflow_total,
            'prompt_type': self.prompt_type,
            'prompt_title': self.prompt_title,
            'role': self.role,
            'key_message': self.key_message,
            'prompt_text': self.prompt_text,
            'prompt_payload': self.prompt_payload,
            'design_plan': self.design_plan,
            'prompt_stats': self.prompt_stats,
            'product_brief': self.product_brief,
            'dynamic_style_params': self.dynamic_style_params,
            'material_summary': self.material_summary,
            'reference_summary': self.reference_summary,
            'reference_asset_ids': self.reference_asset_ids,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class NoteStrategyLog(Base):
    __tablename__ = 'note_strategy_logs'

    id = Column(Integer, primary_key=True, autoincrement=True)
    log_id = Column(String(64), unique=True, index=True, nullable=False, comment='策略日志ID')
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    product_name = Column(String(256), nullable=True, index=True, comment='产品名')
    strategy_mode = Column(String(64), nullable=True, index=True, comment='策略模式 research_first|benchmark_first')
    product_usage_mode = Column(String(64), nullable=True, index=True, comment='产品使用模式 product_main|product_assist|no_product')
    selected_strategy_id = Column(String(128), nullable=True, comment='默认选中策略ID')
    fallback_used = Column(Boolean, default=False, comment='是否使用兜底策略')
    fallback_reason = Column(LONG_TEXT, nullable=True, comment='兜底原因')
    model_name = Column(String(128), nullable=True, comment='策略模型')
    runtime_ms = Column(Integer, nullable=True, comment='策略生成耗时毫秒')
    research_context = Column(LONG_TEXT, nullable=True, comment='产品研究上下文JSON')
    benchmark_note = Column(LONG_TEXT, nullable=True, comment='对标笔记快照JSON')
    real_phrases = Column(LONG_TEXT, nullable=True, comment='真实用户表达JSON')
    strategy_feedback = Column(LONG_TEXT, nullable=True, comment='用户纠偏说明')
    benchmark_fit = Column(LONG_TEXT, nullable=True, comment='对标诊断结果JSON')
    strategies = Column(LONG_TEXT, nullable=True, comment='三套策略JSON')
    response_payload = Column(LONG_TEXT, nullable=True, comment='策略接口完整返回JSON')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')

    __table_args__ = (
        Index('idx_note_strategy_logs_user_created', 'user_id', 'created_at'),
        Index('idx_note_strategy_logs_user_mode_created', 'user_id', 'strategy_mode', 'created_at'),
        Index('idx_note_strategy_logs_user_usage_created', 'user_id', 'product_usage_mode', 'created_at'),
    )

    def to_dict(self):
        return {
            'log_id': self.log_id,
            'user_id': self.user_id,
            'product_name': self.product_name,
            'strategy_mode': self.strategy_mode,
            'product_usage_mode': self.product_usage_mode,
            'selected_strategy_id': self.selected_strategy_id,
            'fallback_used': self.fallback_used,
            'fallback_reason': self.fallback_reason,
            'model_name': self.model_name,
            'runtime_ms': self.runtime_ms,
            'research_context': self.research_context,
            'benchmark_note': self.benchmark_note,
            'real_phrases': self.real_phrases,
            'strategy_feedback': self.strategy_feedback,
            'benchmark_fit': self.benchmark_fit,
            'strategies': self.strategies,
            'response_payload': self.response_payload,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class Note(Base):
    __tablename__ = 'notes'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(String(64), nullable=False, index=True, comment='用户ID')
    note_id = Column(String(64), nullable=False, comment='笔记ID')
    title = Column(String(256), comment='标题')
    content = Column(Text, comment='内容')
    keyword = Column(String(128), index=True, comment='关键词')
    created_at = Column(DateTime, default=datetime.utcnow, comment='创建时间')
    
    __table_args__ = (
        Index('idx_user_keyword', 'user_id', 'keyword'),
        Index('idx_user_created', 'user_id', 'created_at'),
    )
    
    def __repr__(self):
        return f"<Note(id={self.id}, user_id='{self.user_id}', title='{self.title}')>"
    
    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'note_id': self.note_id,
            'title': self.title,
            'content': self.content,
            'keyword': self.keyword,
            'created_at': self.created_at.isoformat() if self.created_at else None
        }
