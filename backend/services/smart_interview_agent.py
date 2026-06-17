"""
AI-Native 智能访谈代理
- 使用 OpenAI 兼容文本模型执行顾问式访谈
- AI 完全自主决策访谈流程
- Prompt 控制大方向
"""

import asyncio
import json
import logging
import re
from typing import Optional, Dict, Any, List
from openai import OpenAI, APITimeoutError
from backend.config import settings
from backend.services.content_analyzer import resolve_text_generation_config
from backend.services.model_gateway_diagnostics import classify_model_gateway_error
from backend.services.text_job_runner import run_text_job
from backend.utils.ai_parser import clean_and_parse_ai_json

logger = logging.getLogger(__name__)


_INTERVIEW_REQUIRED_FIELDS = {
    "marketing_goal": "笔记目标",
    "real_motivation": "为什么现在要发",
    "target_scene": "目标人群和真实场景",
    "action_goal": "希望读者下一步做什么",
}
_INTERVIEW_PLACEHOLDER_TERMS = (
    "待补充", "未填写", "暂无", "无", "不知道", "说不清", "随便", "都可以", "看情况"
)
_INTERVIEW_ABSTRACT_GOALS = (
    "涨粉", "曝光", "推广", "引流", "互动", "评论", "关注", "转化", "带货", "获客"
)
_CONTENT_CREATION_KEYWORDS = (
    "小红书", "图文", "笔记", "文案", "选题", "标题", "内容", "自媒体", "小编", "运营"
)
_CONTENT_TOPIC_UNCERTAINTY_KEYWORDS = (
    "不知道发什么", "不知道写什么", "写什么", "发什么", "选题方向", "评论", "关注", "互动"
)
_CONTENT_WORKFLOW_DETAIL_KEYWORDS = (
    "复制", "粘贴", "排版", "分页", "水印", "敏感词", "违规", "模板", "导入",
    "改格式", "截图", "封面", "素材", "发布", "审核", "校对", "手动", "反复",
    "花时间", "小时", "分钟"
)


class InterviewServiceError(Exception):
    def __init__(self, message: str, *, status_code: int = 500, kind: str = "unknown", raw_error: str = ""):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.kind = kind
        self.raw_error = raw_error


class SmartInterviewAgent:
    """
    智能访谈代理
    """
    
    def __init__(
        self,
        user_id: str,
        api_key: str = None,
        base_url: str = None,
        model: str = None,
        product_brief: Optional[Dict[str, Any]] = None,
        research_context: Optional[Dict[str, Any]] = None,
    ):
        self.user_id = user_id
        self.product_brief = product_brief or {}
        self.research_context = research_context or {}

        if api_key and base_url:
            resolved_api_key, resolved_base_url = api_key, base_url
        else:
            resolved_api_key, resolved_base_url = resolve_text_generation_config(api_key)
        
        self.client = OpenAI(
            base_url=resolved_base_url,
            api_key=resolved_api_key,
            timeout=float(getattr(settings, "INTERVIEW_REQUEST_TIMEOUT_SECONDS", 60)),
            default_headers={"Accept-Encoding": "identity"},
        )
        self.model = model or getattr(settings, "INTERVIEW_MODEL", "gpt-5.4")
        
        # 对话历史
        self.conversation_history: List[Dict[str, str]] = []
        self.phase = "asking"
        self.collected_info_snapshot: Dict[str, Any] = self._build_initial_collected_info()
        self.title_options_snapshot: List[Dict[str, Any]] = []
        self.selected_title: Optional[Dict[str, Any]] = None
        self.final_result_snapshot: Optional[Dict[str, Any]] = None
        self.raw_context_notes: List[str] = []
        
        # System Prompt
        self.system_prompt = self._build_system_prompt()
    
    def _build_system_prompt(self) -> str:
        """
        构建System Prompt
        """
        product_context = self._build_product_context_prompt()
        template = """# 你是谁
你是一位拥有 10 年经验的小红书内容策略专家。
你不是“文案生成器”，而是一位**顾问型访谈专家**。

你的核心能力是：
通过对话，逐步挖掘用户自己都未必意识到的真实营销目标、现实处境和关键诉求，并基于这些信息生成真正匹配的小红书内容。

你的价值不在“问完所有问题”，而在**问对关键问题**，并在信息足够时及时收口。

# 你的核心方法论
你的工作分为三个阶段，但阶段不是固定流程，而是由你对“信息是否已经足够”的判断来决定是否继续。

## Phase 0：目标对齐（最高优先级）
**目标**：搞清楚“这篇笔记为什么要存在”。
**规则（强制）**：
* 不允许一上来就问产品细节；如果下方已有产品上下文，默认你已经理解产品基础情况
* 不允许连续追问细节
* **必须先确认**：这篇笔记最想解决什么问题
* **第一轮必须使用「场景化单选题」**来做方向定位，并且必须提供「不确定 / 说不清 / 想先聊聊现状」作为兜底选项。

**原因**：用户往往只能模糊地说出“想带货 / 想涨粉”，你的职责是先帮他定方向，而不是逼他给标准答案。

## Phase 1：动机挖掘（最关键的一步）
当用户完成 Phase 0 的目标选择后：
👉 **下一轮必须立刻切换为开放输入题（type: "text"）**
👉 **禁止使用选择题替代**

你必须追问一句“为什么是现在”的问题，例如：
* “你为什么现在想发这篇？”
* “最近发生了什么，让你有这个想法？”

**目的**：
* 挖掘真实背景（焦虑 / 转折 / 卡点）
* 判断这是「主动规划」还是「被动自救」
* 捕捉隐藏需求（如：销量下滑、流量断崖、验证方向）

这是整个访谈中权重最高的一问，**不允许被跳过，也不允许被弱化**。

## Phase 2：场景化结构补全（动态进行）
当用户的真实动机开始清晰后，你进入结构化补全阶段。
你需要根据用户的回答，动态决定使用选择题还是开放题，补全以下关键信息模块（顺序不固定）：
* 当前处境：为什么是“现在”
* 目标对象：具体使用场景中的人
* 核心痛点：最急、最想解决的一个问题
* 差异点：为什么是你，而不是别人
* 行动目标：你希望读者下一步做什么

# 动态提问规则（强制执行）
1. **选择题的使用边界**
   * 选择题只用于「方向定位 / 结构化筛选 / 兜底判断」
   * **禁止连续使用 3 轮选择题**
   * 禁止用选择题替代动机、故事、背景挖掘

2. **开放题的强制使用时机**
   * Phase 0 → Phase 1 切换时，**必须**使用 `type: "text"`
   * 当问题指向「为什么 / 发生了什么 / 真实经历」时，只能用 `type: "text"`

3. **信息完整度判断机制（字段级）**
   在每一轮对话后，你都需要在内部检查以下信息是否已清晰：
	   * `marketing_goal`（这篇笔记最想达成什么结果）
	   * `real_motivation`（为什么是现在）
	   * `target_scene`（影响谁，在什么具体场景）
	   * `action_goal`（希望读者下一步行为）
	   * `content_specifics`（能写进正文的真实细节：具体卡点、场景、步骤、对比或用户原话）

	   **判断规则**：
	   * 如果缺失任意一项 → 必须继续提问
	   * 如果用户回答少于 15 字，或大量使用抽象词（如：涨粉、推广、曝光、互动、关注） → **必须追问一句具体场景/具体卡点**
	   * 如果用户说“不知道写什么/发什么/怎么带来评论关注”，不能直接展示标题，必须追问“最卡的真实环节、最近一次卡住的情境、读者会共鸣的具体问题”
	   * 如果以上字段都明确，且 `content_specifics` 至少包含 2 个可写进正文的具体细节 → 才能收口并展示标题

	4. **收口规则（非常重要）**
	   * 当【核心目标 + 真实动机 + 目标场景 + 行动目标 + 正文细节】已经清晰
	   * 即使未达到 8 轮
	   * 也必须立刻结束访谈并生成内容（先展示标题选项）

# 隐藏需求识别（增强能力）
当用户说：
* “想涨粉” / “想做曝光” / “先发发看”
你需要在内部判断，其真实诉求更可能是：
* 为后续带货铺垫 / 为个人 IP 建立信任 / 为商业化接广告做准备
你的任务不是接受表层答案，而是通过追问或场景化选项，帮助用户确认真正目标。

# 已知产品上下文（如果有）
{{PRODUCT_CONTEXT}}

使用规则：
* 如果这里已有产品名称、目标人群、核心卖点，不要再让用户从头介绍产品。
* 访谈重点放在“这次想写什么、为什么现在写、希望读者做什么”。
* 只有当用户当前表达和已知产品信息明显冲突，或关键字段为空时，才轻量确认产品信息。
* 生成标题和正文时，必须自然融入已知产品信息、禁用词和必须提及信息。

# 兜底策略（用户说不清时）
如果用户出现：“我也不知道”、“就想发一下”、“想涨粉吧”
你必须先安抚用户，再给判断型选项：“没关系，这种情况很常见，我帮你判断一下，你更像下面哪种？”

# 输出格式（严格遵守）
每次回复时，必须返回JSON格式，不要输出任何多余说明文字。

**1. 提问阶段（ask）**
```json
{
  "action": "ask",
  "message": {
    "type": "single_choice" | "multiple_choice" | "text",
    "content": "自然、像顾问聊天的问题",
    "reason": "解释为什么此时问这个问题",
    "options": ["选项1", "选项2"] // 仅选择题需要
  },
  "steps": [
    { "id": "1", "label": "目标对齐", "status": "completed" },
    { "id": "2", "label": "动机挖掘", "status": "active" },
    { "id": "3", "label": "结构补全", "status": "pending" }
  ],
  "collected_info": {
    "marketing_goal": "..."
  },
  "progress": 30
}
```

**2. 收口展示标题（show_titles）**
当 Phase 2 结束，信息足够时，先展示标题让用户选择（这是系统流程的一部分）：
```json
{
  "action": "show_titles",
  "message": {
    "type": "text",
    "content": "太好了，我已经理解你的真实需求了。基于我们的沟通，我为你构思了几个标题："
  },
  "title_options": [
    {"id": 1, "title": "标题1", "style": "风格1", "rationale": "理由1"},
    {"id": 2, "title": "标题2", "style": "风格2", "rationale": "理由2"},
    {"id": 3, "title": "标题3", "style": "风格3", "rationale": "理由3"}
  ],
  "steps": [
    { "id": "1", "label": "目标对齐", "status": "completed" },
    { "id": "2", "label": "动机挖掘", "status": "completed" },
    { "id": "3", "label": "生成内容", "status": "active" }
  ],
  "collected_info": {...},
  "progress": 90
}
```

**3. 完成生成（complete）**
当用户选了标题后（消息以 `[选择标题]` 开头），生成最终内容：
```json
{
  "action": "complete",
  "message": {
    "type": "text",
    "content": "完美！这是为你生成的小红书内容："
  },
  "result": {
    "title": "用户选择的标题",
    "content": "正文（纯文本，无Markdown，符合小红书排版风格的大量emoji，像朋友聊天，分段清晰）",
    "collected_info": {
      "marketing_goal": "...",
      "real_motivation": "...",
      "target_scene": "...",
      "action_goal": "..."
    }
  }
}
```

# 开始工作
用户已进入访谈页面。
**请忽略所有预设，直接开始 Phase 0：目标对齐。**
请使用一个「场景化单选题」，询问用户本次笔记的核心目标。
注意：这是一次顾问式对话，而不是问卷调查。
"""
        return template.replace("{{PRODUCT_CONTEXT}}", product_context)

    def _build_initial_collected_info(self) -> Dict[str, Any]:
        product_name = str(self.product_brief.get("product_name") or "").strip()
        product_features = str(self.product_brief.get("product_features") or "").strip()
        target_audience = str(self.product_brief.get("target_audience") or "").strip()
        brand_tone = str(self.product_brief.get("brand_tone") or "").strip()
        collected: Dict[str, Any] = {}
        if product_name:
            collected["product_name"] = product_name
        if product_features:
            collected["core_features"] = product_features
            collected["product_features"] = product_features
        if target_audience:
            collected["target_audience"] = target_audience
        if brand_tone:
            collected["style_preference"] = brand_tone
        return collected

    def _build_product_context_prompt(self) -> str:
        if not self.product_brief:
            return "暂无已保存产品信息。"

        source_documents = self.research_context.get("source_documents") if isinstance(self.research_context, dict) else []
        source_titles = [
            str(item.get("title") or item.get("url") or "").strip()
            for item in (source_documents or [])[:3]
            if isinstance(item, dict)
        ]
        lines = [
            f"- 产品名称：{self.product_brief.get('product_name') or '未填写'}",
            f"- 目标人群：{self.product_brief.get('target_audience') or '未填写'}",
            f"- 核心卖点：{self.product_brief.get('product_features') or '未填写'}",
            f"- 品牌语气：{self.product_brief.get('brand_tone') or '真实、口语化、不过度销售'}",
            f"- 必须提及：{self.product_brief.get('must_include') or '无'}",
            f"- 禁用词：{self.product_brief.get('banned_terms') or '无'}",
        ]
        if isinstance(self.research_context, dict) and self.research_context:
            lines.extend([
                f"- 产品研究摘要：{self.research_context.get('summary') or '无'}",
                f"- 使用场景：{'；'.join(self.research_context.get('use_cases') or []) or '无'}",
                f"- 差异化价值：{'；'.join(self.research_context.get('differentiators') or []) or '无'}",
            ])
        if source_titles:
            lines.append(f"- 已解析资料：{'；'.join(source_titles)}")
        return "\n".join(lines)

    def to_snapshot(self) -> Dict[str, Any]:
        return {
            "user_id": self.user_id,
            "model": self.model,
            "product_brief": self.product_brief,
            "research_context": self.research_context,
            "conversation_history": self.conversation_history,
            "phase": self.phase,
            "collected_info_snapshot": self.collected_info_snapshot,
            "title_options_snapshot": self.title_options_snapshot,
            "selected_title": self.selected_title,
            "final_result_snapshot": self.final_result_snapshot,
            "raw_context_notes": self.raw_context_notes,
        }

    @classmethod
    def from_snapshot(
        cls,
        snapshot: Dict[str, Any],
        *,
        api_key: str = None,
        base_url: str = None,
        model: str = None,
    ) -> "SmartInterviewAgent":
        agent = cls(
            user_id=str(snapshot.get("user_id") or ""),
            api_key=api_key,
            base_url=base_url,
            model=model or snapshot.get("model"),
            product_brief=snapshot.get("product_brief") if isinstance(snapshot.get("product_brief"), dict) else {},
            research_context=snapshot.get("research_context") if isinstance(snapshot.get("research_context"), dict) else {},
        )
        conversation_history = snapshot.get("conversation_history")
        if isinstance(conversation_history, list):
            agent.conversation_history = [
                {"role": str(item.get("role") or ""), "content": str(item.get("content") or "")}
                for item in conversation_history
                if isinstance(item, dict)
            ]
        agent.phase = str(snapshot.get("phase") or "asking")
        collected_info = snapshot.get("collected_info_snapshot")
        if isinstance(collected_info, dict):
            agent.collected_info_snapshot = collected_info
        title_options = snapshot.get("title_options_snapshot")
        if isinstance(title_options, list):
            agent.title_options_snapshot = [item for item in title_options if isinstance(item, dict)]
        selected_title = snapshot.get("selected_title")
        agent.selected_title = selected_title if isinstance(selected_title, dict) else None
        final_result = snapshot.get("final_result_snapshot")
        agent.final_result_snapshot = final_result if isinstance(final_result, dict) else None
        raw_context_notes = snapshot.get("raw_context_notes")
        if isinstance(raw_context_notes, list):
            agent.raw_context_notes = [str(item) for item in raw_context_notes if str(item).strip()][-8:]
        return agent
    
    async def start(self) -> Dict[str, Any]:
        """
        开始访谈
        """
        logger.info(f"[SmartInterviewAgent] 用户 {self.user_id} 开始访谈")
        
        return await self._call_ai("用户已进入访谈页面，准备开始访谈。请开始你的第一个问题。")
    
    async def handle_message(self, user_message: str) -> Dict[str, Any]:
        """
        处理用户消息
        """
        logger.info(f"[SmartInterviewAgent] 用户 {self.user_id} 发送消息: {user_message[:50]}...")

        if user_message.startswith("[选择标题]"):
            return await self._handle_title_selection(user_message)
        if user_message.startswith("[重新生成标题]"):
            return await self._regenerate_titles(user_message)
        if user_message.startswith("[重新生成正文]"):
            return await self._regenerate_content(user_message)

        return await self._call_ai(user_message)
    
    async def _call_ai(self, user_message: str) -> Dict[str, Any]:
        """
        调用AI
        """
        self._remember_user_context(user_message)

        # 添加用户消息到历史
        self.conversation_history.append({
            "role": "user",
            "content": user_message
        })
        
        try:
            # 调用Claude API
            request_params = {
                "model": self.model,
                "messages": [
                    {"role": "system", "content": self.system_prompt},
                    *self.conversation_history
                ],
                "temperature": 0.5,
                "max_tokens": 1600,
                "response_format": {"type": "json_object"},
            }
            try:
                response = await run_text_job(
                    self.client.chat.completions.create,
                    timeout_seconds=60,
                    **request_params,
                )
            except Exception:
                request_params.pop("response_format", None)
                response = await run_text_job(
                    self.client.chat.completions.create,
                    timeout_seconds=60,
                    **request_params,
                )
            
            ai_response = response.choices[0].message.content
            
            logger.info(f"[SmartInterviewAgent] AI响应长度: {len(ai_response)} 字符")
            
            # 解析JSON
            result = await self._parse_ai_response(ai_response)
            result = self._enforce_readiness_gate(result)
            if result.get("_readiness_gate_applied") is True:
                result = {key: value for key, value in result.items() if key != "_readiness_gate_applied"}
                assistant_content = json.dumps(result, ensure_ascii=False)
            else:
                assistant_content = ai_response

            # 添加AI响应到历史。若代码闸门拦下 show_titles，则记录实际返回给前端的追问。
            self.conversation_history.append({
                "role": "assistant",
                "content": assistant_content,
            })
            self._apply_response_state(result)
            
            return result
        
        except Exception as e:
            logger.error(f"[SmartInterviewAgent] AI调用失败: {e}", exc_info=True)
            raise self._classify_error(e) from e
    
    async def _parse_ai_response(self, ai_response: str) -> Dict[str, Any]:
        """
        解析AI响应
        """
        try:
            result = clean_and_parse_ai_json(ai_response)
            if isinstance(result, dict):
                logger.info(f"[SmartInterviewAgent] JSON解析成功")
                return result
            else:
                raise ValueError("解析结果不是字典对象")
        
        except Exception as e:
            logger.warning(f"[SmartInterviewAgent] JSON解析失败: {e}")
            # 如果解析失败，直接返回一个可恢复的兜底问题，避免无限等待
            return {
                "action": "ask",
                "message": {
                    "type": "single_choice",
                    "content": "我们先快速对齐一下这篇笔记最想达成的目标，你更接近哪一种？",
                    "reason": "先把目标定清楚，后面的访谈会更快更准。",
                    "options": [
                        "A. 直接带来咨询或成交",
                        "B. 引导用户私信、加微信或留资",
                        "C. 做品牌曝光或涨粉铺垫",
                        "D. 我还说不清，想先聊现状"
                    ]
                },
                "steps": [
                    {"id": "1", "label": "目标对齐", "status": "active"},
                    {"id": "2", "label": "动机挖掘", "status": "pending"},
                    {"id": "3", "label": "结构补全", "status": "pending"}
                ],
                "collected_info": {},
                "progress": 15
            }

    def _enforce_readiness_gate(self, result: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(result, dict):
            return result

        action = str(result.get("action") or "").strip()
        if action != "show_titles":
            return result

        merged_info = self._merge_collected_info(result.get("collected_info"))
        readiness = self._evaluate_content_readiness(merged_info)
        if readiness.get("ready"):
            return result

        logger.info(
            "[SmartInterviewAgent] stage=readiness_gate_blocked user=%s reason=%s missing=%s weak=%s",
            self.user_id,
            readiness.get("reason_code"),
            readiness.get("missing_fields"),
            readiness.get("weak_fields"),
        )
        followup = self._build_readiness_followup(readiness, merged_info)
        followup["_readiness_gate_applied"] = True
        return followup

    def _merge_collected_info(self, incoming: Any = None) -> Dict[str, Any]:
        merged = dict(self.collected_info_snapshot or {})
        if isinstance(incoming, dict):
            merged.update({str(key): value for key, value in incoming.items() if value is not None})
        return merged

    def _normalize_info_text(self, value: Any) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, (list, tuple, set)):
            return "；".join(self._normalize_info_text(item) for item in value if self._normalize_info_text(item))
        if isinstance(value, dict):
            try:
                return json.dumps(value, ensure_ascii=False)
            except Exception:
                return str(value).strip()
        return str(value or "").strip()

    def _is_placeholder_info(self, text: str) -> bool:
        normalized = str(text or "").strip()
        if not normalized:
            return True
        return normalized in _INTERVIEW_PLACEHOLDER_TERMS

    def _contains_any(self, text: str, keywords: tuple[str, ...]) -> bool:
        return any(keyword in text for keyword in keywords)

    def _count_keyword_hits(self, text: str, keywords: tuple[str, ...]) -> int:
        return sum(1 for keyword in keywords if keyword in text)

    def _specific_detail_score(self, text: str) -> int:
        normalized = str(text or "")
        score = 0
        detail_markers = (
            "最近", "每天", "经常", "反复", "卡在", "卡住", "下滑", "流量", "线索",
            "客户", "读者", "评论区", "私信", "咨询", "成交", "发布", "复盘", "审核",
            "敏感词", "水印", "排版", "分页", "模板", "复制", "粘贴", "导入", "小时", "分钟",
        )
        score += self._count_keyword_hits(normalized, detail_markers)
        if re.search(r"\d|一|二|三|两|半|每天|每周|一次|几次", normalized):
            score += 1
        if len(normalized) >= 24:
            score += 1
        return score

    def _evaluate_content_readiness(self, collected_info: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        info = dict(collected_info or self.collected_info_snapshot or {})
        missing_fields: List[str] = []
        weak_fields: List[str] = []

        required_texts = {
            key: self._normalize_info_text(info.get(key))
            for key in _INTERVIEW_REQUIRED_FIELDS
        }
        for key, label in _INTERVIEW_REQUIRED_FIELDS.items():
            value = required_texts.get(key, "")
            if self._is_placeholder_info(value):
                missing_fields.append(label)

        marketing_goal = required_texts.get("marketing_goal", "")
        real_motivation = required_texts.get("real_motivation", "")
        target_scene = required_texts.get("target_scene", "")
        action_goal = required_texts.get("action_goal", "")
        if (
            marketing_goal
            and self._contains_any(marketing_goal, _INTERVIEW_ABSTRACT_GOALS)
            and len(marketing_goal) <= 6
        ):
            weak_fields.append("笔记目标太泛")
        if (
            real_motivation
            and self._contains_any(real_motivation, _INTERVIEW_ABSTRACT_GOALS)
            and len(real_motivation) <= 12
        ):
            weak_fields.append("真实动机太泛")

        raw_text = "\n".join(note for note in self.raw_context_notes if str(note).strip())
        explicit_specifics = "\n".join(
            self._normalize_info_text(info.get(key))
            for key in (
                "content_specifics", "specific_points", "pain_points", "core_pain",
                "content_angle", "concrete_scene", "user_story", "use_case",
                "user_quotes", "selected_pain_points",
            )
            if self._normalize_info_text(info.get(key))
        )
        user_specific_text = "\n".join(
            item
            for item in [real_motivation, target_scene, action_goal, explicit_specifics, raw_text]
            if item
        )
        product_context_text = "\n".join(
            self._normalize_info_text(info.get(key))
            for key in ("product_name", "core_features", "product_features", "target_audience")
            if self._normalize_info_text(info.get(key))
        )
        all_context_text = "\n".join(
            item for item in [marketing_goal, user_specific_text, product_context_text] if item
        )

        detail_score = self._specific_detail_score(user_specific_text)
        workflow_detail_hits = self._count_keyword_hits(user_specific_text, _CONTENT_WORKFLOW_DETAIL_KEYWORDS)
        is_content_creation_topic = self._contains_any(all_context_text, _CONTENT_CREATION_KEYWORDS)
        is_topic_uncertain = self._contains_any(user_specific_text, _CONTENT_TOPIC_UNCERTAINTY_KEYWORDS)

        reason_code = ""
        if is_content_creation_topic and is_topic_uncertain and workflow_detail_hits < 2:
            weak_fields.append("小红书内容卡点缺少具体工作流细节")
            reason_code = "content_workflow_details"
        elif not explicit_specifics and detail_score < 2:
            weak_fields.append("正文可写细节不足")
            reason_code = "content_specifics"

        ready = not missing_fields and not weak_fields
        if missing_fields and not reason_code:
            reason_code = "missing_required_fields"
        elif weak_fields and not reason_code:
            reason_code = "weak_required_fields"

        return {
            "ready": ready,
            "missing_fields": missing_fields,
            "weak_fields": weak_fields,
            "reason_code": reason_code,
            "detail_score": detail_score,
            "workflow_detail_hits": workflow_detail_hits,
            "is_content_creation_topic": is_content_creation_topic,
        }

    def _build_readiness_followup(self, readiness: Dict[str, Any], collected_info: Dict[str, Any]) -> Dict[str, Any]:
        reason_code = str(readiness.get("reason_code") or "")
        missing_fields = [str(item) for item in readiness.get("missing_fields") or [] if str(item).strip()]
        weak_fields = [str(item) for item in readiness.get("weak_fields") or [] if str(item).strip()]

        if reason_code == "content_workflow_details":
            content = (
                "我先不急着生成，避免出来又是一篇很短很虚的稿子。\n\n"
                "你说卡在“不知道写什么/怎么带来评论关注”，那最真实的卡点是哪几步？"
                "比如复制粘贴、排版、分页、水印、敏感词、反复改格式、找选题里，选 2-3 个最常发生的，"
                "再补一句最近一次卡住的场景。"
            )
            reason = "访谈里已经有方向，但正文缺少能展开成完整笔记的真实工作流细节。"
        elif missing_fields:
            content = f"还差一个关键信息：{missing_fields[0]}。你用一句大白话补一下就行，这样我再给你出标题。"
            reason = "核心信息没补齐时直接生成，正文容易空或者跑偏。"
        else:
            field_text = "、".join(weak_fields[:2]) or "正文细节"
            content = (
                f"方向有了，但{field_text}还不够具体，我先追一问："
                "这篇笔记里最想让读者点头的一个真实场景是什么？可以直接说最近一次发生的事。"
            )
            reason = "现在的信息还不足以稳定支撑一篇完整的小红书正文。"

        return {
            "action": "ask",
            "message": {
                "type": "text",
                "content": content,
                "reason": reason,
            },
            "steps": [
                {"id": "1", "label": "目标对齐", "status": "completed"},
                {"id": "2", "label": "动机挖掘", "status": "completed"},
                {"id": "3", "label": "结构补全", "status": "active"},
            ],
            "collected_info": collected_info,
            "progress": 75,
        }

    async def _handle_title_selection(self, user_message: str) -> Dict[str, Any]:
        self._remember_user_context(user_message, allow_command=False)
        selected_title_text = self._extract_command_payload(user_message, "[选择标题]")
        selected_option = self._find_title_option(selected_title_text)
        if not selected_option:
            raise InterviewServiceError(
                "当前标题选择无效，请重新选择列表中的标题。",
                status_code=400,
                kind="invalid_title_selection",
                raw_error=selected_title_text,
            )

        self.phase = "title_selection"
        self.selected_title = selected_option
        self.conversation_history.append({
            "role": "user",
            "content": user_message,
        })
        logger.info(
            "[SmartInterviewAgent] stage=complete_prepare user=%s title=%s",
            self.user_id,
            selected_option.get("title", ""),
        )

        readiness = self._evaluate_content_readiness(self.collected_info_snapshot)
        if not readiness.get("ready"):
            result = self._build_readiness_followup(readiness, self.collected_info_snapshot)
            self.conversation_history.append({
                "role": "assistant",
                "content": json.dumps(result, ensure_ascii=False),
            })
            self._apply_response_state(result)
            return result

        result = await self._generate_final_content(feedback="")
        self._apply_response_state(result)
        return result

    async def _regenerate_titles(self, user_message: str) -> Dict[str, Any]:
        feedback = self._extract_command_payload(user_message, "[重新生成标题]")
        self._remember_user_context(feedback, allow_command=False)
        self.conversation_history.append({
            "role": "user",
            "content": user_message,
        })
        logger.info("[SmartInterviewAgent] stage=regenerate_titles user=%s", self.user_id)

        from backend.services.viral_content_generator import ViralContentGenerator

        generator = ViralContentGenerator()
        try:
            title_options = await run_text_job(
                generator.generate_title_options_from_interview,
                collected_info=self.collected_info_snapshot,
                raw_context_notes=self.raw_context_notes,
                feedback=feedback,
                timeout_seconds=120.0,
            )
        except asyncio.TimeoutError as error:
            logger.error("[SmartInterviewAgent] stage=regenerate_titles_timeout", exc_info=True)
            raise InterviewServiceError(
                "标题生成超时，请稍后重试。",
                status_code=504,
                kind="timeout",
                raw_error=str(error),
            ) from error
        self.title_options_snapshot = title_options
        self.phase = "title_selection"
        self.selected_title = None

        ai_response = {
            "action": "show_titles",
            "message": {
                "type": "text",
                "content": "我根据你的反馈重新整理了几版标题，这次看看哪一个更接近你想要的方向：",
            },
            "title_options": title_options,
            "steps": self._build_title_selection_steps(),
            "collected_info": self.collected_info_snapshot,
            "progress": 90,
        }
        self.conversation_history.append({
            "role": "assistant",
            "content": str(ai_response),
        })
        return ai_response

    async def _regenerate_content(self, user_message: str) -> Dict[str, Any]:
        feedback = self._extract_command_payload(user_message, "[重新生成正文]")
        self._remember_user_context(feedback, allow_command=False)
        self.conversation_history.append({
            "role": "user",
            "content": user_message,
        })
        logger.info("[SmartInterviewAgent] stage=regenerate_content user=%s", self.user_id)

        if not self.selected_title:
            raise InterviewServiceError(
                "当前还没有选中的标题，请先选择一个标题后再重新生成正文。",
                status_code=400,
                kind="missing_selected_title",
            )

        if self.final_result_snapshot and self._should_revise_existing_content(feedback):
            result = await self._revise_existing_content(feedback=feedback)
            self._apply_response_state(result)
            return result

        result = await self._generate_final_content(feedback=feedback)
        self._apply_response_state(result)
        return result

    def _should_revise_existing_content(self, feedback: str) -> bool:
        if not self.final_result_snapshot:
            return False
        instruction = str(feedback or "").strip()
        if not instruction:
            return False
        full_regenerate_markers = (
            "重新生成一篇", "重写一篇", "全部重写", "整篇重写", "从头写", "换个方向",
            "另起一篇", "完全重新", "不要这篇", "不要这个方向"
        )
        if any(marker in instruction for marker in full_regenerate_markers):
            return False
        local_markers = (
            "改", "修改", "调整", "优化", "替换", "换成", "删", "去掉", "加一句",
            "结尾", "最后", "开头", "第一句", "标题", "语气", "口语", "自然",
            "更像", "emoji", "表情", "排版", "换行", "编号", "1、", "2、", "3、"
        )
        return any(marker in instruction for marker in local_markers)

    def _infer_revision_scope(self, feedback: str) -> str:
        instruction = str(feedback or "")
        if any(marker in instruction for marker in ("标题", "题目")):
            return "title"
        if any(marker in instruction for marker in ("开头", "第一句", "首句", "第一段")):
            return "opening"
        if any(marker in instruction for marker in ("结尾", "最后一句", "最后一段", "收尾")):
            return "closing"
        if any(marker in instruction for marker in ("结构", "大纲", "段落", "排版", "换行", "编号")):
            return "body"
        return "auto"

    def _split_content_for_revision(self, content: str) -> Dict[str, Any]:
        paragraphs = [item.strip() for item in re.split(r"\n{2,}", str(content or "").strip()) if item.strip()]
        if not paragraphs:
            return {"opening": "", "outline": [], "body": "", "closing": ""}
        if len(paragraphs) == 1:
            return {"opening": paragraphs[0], "outline": [], "body": paragraphs[0], "closing": ""}
        opening = paragraphs[0]
        closing = paragraphs[-1] if len(paragraphs) >= 3 else ""
        middle = paragraphs[1:-1] if closing else paragraphs[1:]
        return {
            "opening": opening,
            "outline": [item[:42] for item in paragraphs[:6]],
            "body": "\n\n".join(middle) if middle else opening,
            "closing": closing,
        }

    def _join_revised_content(self, *, opening: str, body: str, closing: str) -> str:
        parts: List[str] = []
        for item in [opening, body, closing]:
            normalized = str(item or "").strip()
            if normalized and normalized not in parts:
                parts.append(normalized)
        return "\n\n".join(parts).strip()

    async def _revise_existing_content(self, *, feedback: str) -> Dict[str, Any]:
        current_result = dict(self.final_result_snapshot or {})
        current_content = str(current_result.get("content") or "").strip()
        if not current_content:
            return await self._generate_final_content(feedback=feedback)

        from backend.services.viral_content_generator import ViralContentGenerator

        fields = self._split_content_for_revision(current_content)
        rewrite_session = current_result.get("rewrite_session") if isinstance(current_result.get("rewrite_session"), dict) else {}
        product_info = rewrite_session.get("product_info") if isinstance(rewrite_session.get("product_info"), dict) else {
            "product_name": self.collected_info_snapshot.get("product_name") or "",
            "product_features": self.collected_info_snapshot.get("core_features") or self.collected_info_snapshot.get("product_features") or "",
            "target_audience": self.collected_info_snapshot.get("target_audience") or self.collected_info_snapshot.get("target_scene") or "",
            "brand_tone": self.collected_info_snapshot.get("style_preference") or "",
        }
        note_strategy = (
            current_result.get("note_strategy")
            if isinstance(current_result.get("note_strategy"), dict)
            else rewrite_session.get("note_strategy") if isinstance(rewrite_session.get("note_strategy"), dict) else {}
        )
        benchmark_note = rewrite_session.get("benchmark_note") if isinstance(rewrite_session.get("benchmark_note"), dict) else {
            "title": current_result.get("title") or self.selected_title.get("title") or "",
            "desc": current_content,
        }
        logger.info(
            "[SmartInterviewAgent] stage=revise_existing_content user=%s scope=%s",
            self.user_id,
            self._infer_revision_scope(feedback),
        )

        try:
            generator = ViralContentGenerator()
            revision = await run_text_job(
                generator.revise_confirmation_note,
                title=str(current_result.get("title") or self.selected_title.get("title") or "").strip(),
                opening=fields["opening"],
                outline=fields["outline"],
                body=fields["body"],
                closing=fields["closing"],
                instruction=feedback,
                selected_scope=self._infer_revision_scope(feedback),
                rewrite_session=rewrite_session,
                product_info=product_info,
                benchmark_note=benchmark_note,
                note_strategy=note_strategy,
                timeout_seconds=120.0,
            )
        except asyncio.TimeoutError as error:
            logger.error("[SmartInterviewAgent] stage=revise_existing_content_timeout", exc_info=True)
            raise InterviewServiceError(
                "正文修改超时，请稍后重试。",
                status_code=504,
                kind="timeout",
                raw_error=str(error),
            ) from error
        except Exception as error:
            logger.error("[SmartInterviewAgent] stage=revise_existing_content_failed error=%s", error, exc_info=True)
            raise self._classify_completion_error(error) from error

        updated_fields = revision.get("updated_fields", {}) if isinstance(revision.get("updated_fields"), dict) else {}
        final_title = str(updated_fields.get("title") or current_result.get("title") or self.selected_title.get("title") or "").strip()
        final_content = self._join_revised_content(
            opening=str(updated_fields.get("opening") or fields["opening"] or "").strip(),
            body=str(updated_fields.get("body") or fields["body"] or "").strip(),
            closing=str(updated_fields.get("closing") or fields["closing"] or "").strip(),
        )
        if not final_content:
            final_content = current_content

        self.phase = "content_ready"
        self.final_result_snapshot = {
            **current_result,
            "title": final_title,
            "content": final_content,
            "collected_info": self.collected_info_snapshot,
        }
        if isinstance(revision.get("updated_rewrite_session"), dict):
            updated_session = dict(revision["updated_rewrite_session"])
            updated_session["body_draft"] = final_content
            updated_session["polished_body"] = final_content
            updated_session["final_body"] = final_content
            updated_session["final_body_source"] = "custom_revision"
            self.final_result_snapshot["rewrite_session"] = updated_session
        if isinstance(note_strategy, dict) and note_strategy:
            self.final_result_snapshot["note_strategy"] = note_strategy

        ai_response = {
            "action": "complete",
            "message": {
                "type": "text",
                "content": "已按你的要求更新这版内容：",
            },
            "result": self.final_result_snapshot,
            "steps": self._build_content_ready_steps(),
            "collected_info": self.collected_info_snapshot,
            "progress": 100,
        }
        self.conversation_history.append({
            "role": "assistant",
            "content": json.dumps(ai_response, ensure_ascii=False),
        })
        return ai_response

    async def _generate_final_content(self, *, feedback: str) -> Dict[str, Any]:
        if not self.selected_title:
            raise InterviewServiceError(
                "缺少已选择的标题，无法生成正文。",
                status_code=400,
                kind="missing_selected_title",
            )

        if not self.collected_info_snapshot:
            raise InterviewServiceError(
                "当前访谈上下文不完整，请重新进行访谈。",
                status_code=409,
                kind="missing_context",
            )

        readiness = self._evaluate_content_readiness(self.collected_info_snapshot)
        if not readiness.get("ready"):
            raise InterviewServiceError(
                "访谈信息还不够支撑完整正文，请先补充一个具体场景或卡点。",
                status_code=409,
                kind="insufficient_interview_context",
                raw_error=json.dumps(readiness, ensure_ascii=False),
            )

        logger.info(
            "[SmartInterviewAgent] stage=complete user=%s title=%s model_line=generate_content",
            self.user_id,
            self.selected_title.get("title", ""),
        )

        from backend.services.viral_content_generator import ViralContentGenerator

        try:
            generator = ViralContentGenerator()
            content_result = await run_text_job(
                generator.generate_content_from_interview,
                selected_title=str(self.selected_title.get("title") or "").strip(),
                collected_info=self.collected_info_snapshot,
                raw_context_notes=self.raw_context_notes,
                feedback=feedback,
                timeout_seconds=180.0,
            )
        except asyncio.TimeoutError as error:
            logger.error("[SmartInterviewAgent] stage=complete_generation_timeout", exc_info=True)
            raise InterviewServiceError(
                "正文生成超时，请稍后重试。",
                status_code=504,
                kind="timeout",
                raw_error=str(error),
            ) from error
        except Exception as error:
            logger.error("[SmartInterviewAgent] stage=complete_generation_failed error=%s", error, exc_info=True)
            raise self._classify_completion_error(error) from error

        self.phase = "content_ready"
        final_title = str(content_result.get("title") or self.selected_title.get("title") or "").strip()
        self.final_result_snapshot = {
            "title": final_title,
            "content": str(content_result.get("content") or "").strip(),
            "collected_info": self.collected_info_snapshot,
        }
        if isinstance(content_result.get("rewrite_session"), dict):
            self.final_result_snapshot["rewrite_session"] = content_result["rewrite_session"]
        if isinstance(content_result.get("note_strategy"), dict):
            self.final_result_snapshot["note_strategy"] = content_result["note_strategy"]
        if isinstance(content_result.get("tags"), list):
            self.final_result_snapshot["tags"] = content_result["tags"]

        ai_response = {
            "action": "complete",
            "message": {
                "type": "text",
                "content": "完美！这是为你生成的小红书内容：",
            },
            "result": self.final_result_snapshot,
            "steps": self._build_content_ready_steps(),
            "collected_info": self.collected_info_snapshot,
            "progress": 100,
        }
        self.conversation_history.append({
            "role": "assistant",
            "content": str(ai_response),
        })
        return ai_response

    def _remember_user_context(self, user_message: str, *, allow_command: bool = True) -> None:
        normalized = str(user_message or "").strip()
        if not normalized:
            return
        if not allow_command and normalized.startswith("["):
            return
        if normalized.startswith("["):
            return
        if normalized not in self.raw_context_notes:
            self.raw_context_notes.append(normalized)
        self.raw_context_notes = self.raw_context_notes[-8:]

    def _apply_response_state(self, result: Dict[str, Any]) -> None:
        if not isinstance(result, dict):
            return

        collected_info = result.get("collected_info")
        if isinstance(collected_info, dict):
            self.collected_info_snapshot = {
                **self.collected_info_snapshot,
                **{str(key): value for key, value in collected_info.items() if value is not None},
            }

        action = str(result.get("action") or "").strip()
        if action == "show_titles":
            options = result.get("title_options")
            if isinstance(options, list):
                self.title_options_snapshot = [option for option in options if isinstance(option, dict)]
            self.phase = "title_selection"
        elif action == "complete":
            final_result = result.get("result")
            if isinstance(final_result, dict):
                self.final_result_snapshot = final_result
            self.phase = "content_ready"
        else:
            self.phase = "asking"

    def _extract_command_payload(self, user_message: str, prefix: str) -> str:
        return str(user_message or "").replace(prefix, "", 1).strip()

    def _find_title_option(self, selected_title_text: str) -> Optional[Dict[str, Any]]:
        normalized = (selected_title_text or "").strip()
        if not normalized:
            return None
        for option in self.title_options_snapshot:
            option_title = str(option.get("title") or "").strip()
            if option_title == normalized:
                return option
        return None

    def _build_title_selection_steps(self) -> List[Dict[str, str]]:
        return [
            {"id": "1", "label": "目标对齐", "status": "completed"},
            {"id": "2", "label": "动机挖掘", "status": "completed"},
            {"id": "3", "label": "生成内容", "status": "active"},
        ]

    def _build_content_ready_steps(self) -> List[Dict[str, str]]:
        return [
            {"id": "1", "label": "目标对齐", "status": "completed"},
            {"id": "2", "label": "动机挖掘", "status": "completed"},
            {"id": "3", "label": "生成内容", "status": "completed"},
        ]

    def _classify_completion_error(self, error: Exception) -> InterviewServiceError:
        classified = self._classify_error(error)
        if classified.kind == "timeout":
            return InterviewServiceError(
                "正文生成超时，请重试。",
                status_code=504,
                kind="timeout",
                raw_error=classified.raw_error,
            )
        if classified.status_code == 502:
            return InterviewServiceError(
                "正文生成暂时失败，请稍后重试。",
                status_code=502,
                kind=classified.kind,
                raw_error=classified.raw_error,
            )
        error_text = str(error)
        if "正文不完整" in error_text or "模型输出被截断" in error_text:
            return InterviewServiceError(
                "正文生成不完整，系统已拦截残稿，请重新生成一次。",
                status_code=502,
                kind="incomplete_content",
                raw_error=error_text,
            )
        return classified

    def _classify_error(self, error: Exception) -> InterviewServiceError:
        if isinstance(error, InterviewServiceError):
            return error

        if isinstance(error, APITimeoutError) or "timeout" in str(error).lower() or "timed out" in str(error).lower():
            return InterviewServiceError(
                "访谈模型响应超时，请稍后重试。",
                status_code=504,
                kind="timeout",
                raw_error=str(error),
            )

        classified = classify_model_gateway_error(error)
        return InterviewServiceError(
            classified.get("message", "模型调用失败，请查看后端诊断日志。"),
            status_code=int(classified.get("status_code", 500)),
            kind=str(classified.get("kind", "unknown")),
            raw_error=str(classified.get("raw_error", error)),
        )
