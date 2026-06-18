import json
import re
import time
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from openai import OpenAI

from backend.config import settings
from backend.services.content_analyzer import (
    get_text_generation_config_candidates,
    get_text_generation_model,
    get_text_generation_model_candidates,
    is_retryable_text_generation_error,
    resolve_text_generation_config,
)
from backend.utils.ai_parser import clean_and_parse_ai_json
from backend.utils.logger import logger


AI_MARKERS = [
    "家人们谁懂",
    "真的绝了",
    "冲就完事",
    "闭眼入",
    "狠狠",
    "谁懂啊",
    "宝子们",
    "姐妹们",
    "直接封神",
    "无脑入",
]

XHS_TITLE_MAX_CHARS = 20
XHS_BODY_MAX_CHARS = 1000
XHS_BODY_SAFE_MAX_CHARS = 980
XHS_STRATEGY_BODY_TARGET_MAX_CHARS = 950
XHS_STRATEGY_BODY_MIN_COMPLETE_CHARS = 720
XHS_BODY_MIN_COMPLETE_CHARS = 180
INTERVIEW_BODY_MIN_COMPLETE_CHARS = 420
XHS_LAYOUT_EMOJI_RE = re.compile(r"[\u2600-\u27BF]|[\U0001F300-\U0001FAFF]")
XHS_SEMANTIC_BODY_EMOJIS = (
    "💡", "👥", "✅", "🔥", "🎯", "✨", "👉", "👇", "⚠️",
    "✍️", "📝", "📖", "🌍", "🛒",
)
XHS_PRIVATE_DOMAIN_EMOJI_RULES = (
    (("社群", "群内", "建群", "群规", "群内容", "群环境", "成员"), "👥"),
    (("活跃", "促活", "活动", "红包", "签到", "死群", "放大", "增长"), "🔥"),
    (("分层", "精准", "标签", "触达", "人群", "用户层级"), "🎯"),
    (("风险", "风控", "留痕", "敏感词", "交接", "合规", "流走"), "⚠️"),
    (("统一", "规范", "设好", "接住", "承接", "闭环", "复盘", "检查", "减少"), "✅"),
    (("关键", "其实", "真正", "不是", "先别急", "重点", "为什么", "发现"), "💡"),
    (("下面", "对照", "照着", "自查", "清单"), "👇"),
)
XHS_PRIVATE_DOMAIN_PARAGRAPH_EMOJI_RULES = (
    (("活跃", "促活", "活动", "红包", "签到", "死群", "放大", "增长"), "🔥"),
    (("分层", "精准", "标签", "触达", "人群", "用户层级"), "🎯"),
    (("风险", "风控", "留痕", "敏感词", "交接", "合规", "流走"), "⚠️"),
    (("统一", "规范", "设好", "接住", "承接", "闭环", "复盘", "检查", "减少"), "✅"),
    (("社群", "群内", "建群", "群规", "群内容", "群环境", "成员"), "👥"),
    (("关键", "其实", "真正", "不是", "先别急", "重点", "为什么", "发现"), "💡"),
    (("下面", "对照", "照着", "自查", "清单"), "👇"),
)
XHS_CONTENT_TOOL_EMOJI_RULES = (
    (("写作", "文案", "笔记", "文章", "小编", "自媒体", "公众号", "改写", "导入", "标题", "内容"), "✍️"),
    (("模板", "排版", "分页", "水印", "套用", "格式", "卡片"), "📝"),
    (("违规", "敏感词", "检测", "风险", "发布前", "审核"), "⚠️"),
    (("一键", "自动", "省时", "效率", "批量", "不用复制", "无需复制", "减少"), "✅"),
    (("下面", "对照", "照着", "自查", "清单"), "👇"),
    (("关键", "其实", "真正", "不是", "先别急", "重点", "为什么", "发现"), "💡"),
)
XHS_CONTENT_TOOL_PARAGRAPH_EMOJI_RULES = (
    (("违规", "敏感词", "检测", "风险", "发布前", "审核"), "⚠️"),
    (("模板", "排版", "分页", "水印", "套用", "格式", "卡片"), "📝"),
    (("一键", "自动", "省时", "效率", "批量", "不用复制", "无需复制", "减少"), "✅"),
    (("写作", "文案", "笔记", "文章", "小编", "自媒体", "公众号", "改写", "导入", "标题", "内容"), "✍️"),
    (("下面", "对照", "照着", "自查", "清单"), "👇"),
    (("关键", "其实", "真正", "不是", "先别急", "重点", "为什么", "发现"), "💡"),
)
XHS_CONTEXTUAL_EMOJI_RULES = XHS_PRIVATE_DOMAIN_EMOJI_RULES
XHS_PARAGRAPH_CONTEXTUAL_EMOJI_RULES = XHS_PRIVATE_DOMAIN_PARAGRAPH_EMOJI_RULES
TEXT_GENERATION_REQUEST_TIMEOUT_SECONDS = float(
    getattr(settings, "TEXT_GENERATION_REQUEST_TIMEOUT_SECONDS", 90)
)
XHS_TITLE_QUALITY_GUIDE = """标题质量要求：
- 每条标题必须 20 字以内，同时要有小红书点击欲，不能只是普通概括句。
- 优先使用这 4 类钩子之一：具体痛点、反差观点、结果收益、场景代入。
- 标题里要尽量出现具体对象或场景，比如“客户一来”“私域跟进”“销售回复”“老板复盘”，不要只写抽象词。
- 避免泛标题：例如“私域运营别硬扛”“高效运营指南”“这个工具很好用”“解决方案来了”。
- 不要标题党，不要虚假夸张；可以口语化、有一点情绪，但必须贴合正文和策略。"""

TITLE_REVISION_GUIDE = """标题专项改写要求：
- 先从正文里找“谁遇到什么具体问题/哪个反常判断/看完能得到什么结果”，标题必须押中其中一个。
- B2B、SaaS、企微、私域类标题不要写成产品广告，不要喊口号；要像老板、运营、销售真的会点开的复盘/提醒/避坑。
- 优先写“场景 + 痛点/结果”，例如“客户加了企微却不下单”“老板复盘私域先看这点”。
- 可以保留产品关键词，但不能堆词；不要为了包含“企业微信服务商/SCRM”等词牺牲可读性。
- 避免空泛安全标题：例如“老板看私域，先查这5个坑”“私域运营别踩坑”“这套方法很实用”。
- 如果用户说“不好/不够吸引/不像小红书”，要明显换角度，而不是只替换同义词。"""

XHS_BODY_LAYOUT_GUIDE = (
    "版式要求：正文要像可直接发布的小红书笔记，按自然信息块分段，段落之间保留空行。"
    "凡是用编号、emoji、符号、小标题、冒号引出新要点时，都要另起一段，不要把多个要点挤在同一段里。"
    "输出前检查：手机上看起来必须是清楚分段的笔记，而不是一整段说明文。"
)

INCOMPLETE_BODY_SUFFIXES = (
    "，", "、", "：", "；", ",", ":", ";", "（", "(", "【", "[", "《", "“", "\"",
)

XHS_EMOJI_STYLE_GUIDE = """小红书正文 emoji 审美要求：
- emoji 是排版节奏，不是装饰。优先使用少而准的一组：💡、👥、✅、🔥、🎯、👉、👇、⚠️；✨ 只能少量点缀，不能当默认表情。
- 教程/步骤型正文要模仿这种语义排版：观点/判断句尾用 💡，社群/群运营标题用 👥，完成/设置好/可检查的结果句用 ✅，活跃/增长/死群段落用 🔥，用户分层/精准触达标题用 🎯，风险/交接/留痕段落用 ⚠️。
- 步骤标题优先用 1️⃣ 2️⃣ 3️⃣ 这类编号，并在编号后留一个空格；如果标题含明确语义，可以在标题句尾补一个对应 emoji，例如“3️⃣ 社群搭建：从建群到活跃，规则先行 👥”。
- 位置要克制：开头判断 0-1 个，步骤标题 1 个，重点段落句尾 1 个；不要连续堆两个以上 emoji。
- 避免把 📌/📍 当默认结尾符，它们偏硬；除非语境非常适合，否则优先换成 💡/✅/🎯/👉。
- 不要为了表情牺牲信息密度；正文仍要自然控制在 900-980 字，绝对不超过 1000 字。"""

PRODUCT_EXPRESSION_CATEGORY_HINTS = [
    {
        "category": "内容工具/写作效率",
        "keywords": ["Uplog", "小编", "自媒体", "公众号", "小红书运营", "写作", "文案", "笔记", "模板", "排版", "分页", "水印", "敏感词", "违规检测", "AI写作", "导入"],
        "title_style": "标题优先写内容生产的具体卡点、效率收益或发布前风险，例如“小编改笔记别再复制粘贴”“公众号转小红书先看这几步”。",
        "body_style": "正文适合写真实工作流、前后对比、发布前检查、步骤清单；少写老板经营复盘，多写小编/运营每天会遇到的复制、排版、检测和交付压力。",
        "emoji_style": "优先使用 ✍️、📝、✅、⚠️、👇、💡；模板/排版用 📝，写作/改写用 ✍️，检测/敏感词用 ⚠️，省时间/一键完成用 ✅。",
        "tag_hints": ["内容运营", "小红书运营", "自媒体工具", "AI写作", "效率工具", "笔记排版"],
        "opening_emoji": "✍️",
    },
    {
        "category": "私域/SCRM/B2B运营",
        "keywords": ["企业微信", "企微", "私域", "SCRM", "客户", "社群", "群运营", "SOP", "会话留痕", "分层", "风控", "获客", "转化", "复购"],
        "title_style": "标题优先写老板/运营会点开的场景、断点、框架或避坑，例如“客户加了企微却不下单”“私域从0到1先搭这几步”。",
        "body_style": "正文适合写问题诊断、流程框架、步骤拆解、执行结果；把功能点翻译成客户承接、团队效率、资产沉淀和经营复盘。",
        "emoji_style": "优先使用 💡、👥、✅、🔥、🎯、⚠️；社群用 👥，分层/精准触达用 🎯，风控/交接/留痕用 ⚠️，活跃/增长用 🔥。",
        "tag_hints": ["企业微信", "私域运营", "社群运营", "客户管理", "SCRM", "运营经验"],
        "opening_emoji": "💡",
    },
    {
        "category": "学习/翻译/知识工具",
        "keywords": ["翻译", "双语", "论文", "PDF", "网页翻译", "学习", "研究生", "科研", "英语", "文献", "知识"],
        "title_style": "标题优先写学习场景、效率提升或痛点解决，例如“看英文网页别再来回复制”“读论文翻译这样省时间”。",
        "body_style": "正文适合写场景痛点、前后对比、使用步骤和适用人群；语气清楚、可信、少夸张。",
        "emoji_style": "优先使用 📖、🌍、💡、✅、👇；阅读/学习用 📖，语言/跨境用 🌍，关键提醒用 💡。",
        "tag_hints": ["学习工具", "AI翻译", "效率工具", "科研工具", "英语学习"],
        "opening_emoji": "📖",
    },
    {
        "category": "电商/消费/种草",
        "keywords": ["电商", "好物", "消费", "穿搭", "美妆", "护肤", "食品", "家居", "店铺", "下单", "购买", "优惠"],
        "title_style": "标题优先写真实场景、体验结果、适合谁和避坑点，避免空泛种草。",
        "body_style": "正文适合写体验感、使用场景、细节证明、优缺点和购买建议。",
        "emoji_style": "优先使用 ✨、🛒、✅、🔥、👇；体验亮点用 ✨，购买/选择用 🛒，热度/活动用 🔥。",
        "tag_hints": ["好物分享", "真实测评", "购物攻略", "种草笔记"],
        "opening_emoji": "✨",
    },
]


def _compact_text_for_expression(*values: Any) -> str:
    return "\n".join(str(value or "") for value in values if str(value or "").strip())


def _build_strategy_expression_seed(
    product_info: Optional[Dict[str, Any]],
    note_strategy: Optional[Dict[str, Any]],
    benchmark_note: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    product_info = product_info or {}
    note_strategy = note_strategy or {}
    benchmark_note = benchmark_note or {}
    text = _compact_text_for_expression(
        product_info.get("product_name"),
        product_info.get("target_audience"),
        product_info.get("product_features"),
        product_info.get("must_include"),
        note_strategy.get("label"),
        note_strategy.get("summary"),
        note_strategy.get("contentAngle"),
        note_strategy.get("suggestedTitle"),
        " ".join(str(item) for item in (note_strategy.get("corePainPoints") or [])),
        " ".join(str(item) for item in (note_strategy.get("coreBenefits") or [])),
        " ".join(str(item) for item in (note_strategy.get("recommendedCardPlan") or [])),
        benchmark_note.get("title"),
        benchmark_note.get("desc"),
        " ".join(str(item) for item in (benchmark_note.get("tags") or [])),
    )
    lowered = text.lower()
    best_hint = PRODUCT_EXPRESSION_CATEGORY_HINTS[1]
    best_score = -1
    for hint in PRODUCT_EXPRESSION_CATEGORY_HINTS:
        score = 0
        for keyword in hint["keywords"]:
            keyword_text = str(keyword)
            if keyword_text and (keyword_text in text or keyword_text.lower() in lowered):
                score += 1
        if score > best_score:
            best_hint = hint
            best_score = score
    return {
        "product_category_hint": best_hint["category"],
        "title_style_hint": best_hint["title_style"],
        "body_style_hint": best_hint["body_style"],
        "emoji_style_hint": best_hint["emoji_style"],
        "tag_hints": best_hint["tag_hints"],
        "opening_emoji": best_hint["opening_emoji"],
        "matched_keyword_count": max(0, best_score),
    }


def _contract_value_to_text(value: Any, *, fallback: str = "") -> str:
    if isinstance(value, list):
        return "；".join(str(item).strip() for item in value if str(item).strip()) or fallback
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    text = str(value or "").strip()
    return text or fallback


def _build_dynamic_xhs_style_guide(contract: Optional[Dict[str, Any]], expression_seed: Optional[Dict[str, Any]]) -> str:
    contract = contract or {}
    expression_seed = expression_seed or {}
    product_category = _contract_value_to_text(
        contract.get("product_category") or contract.get("productCategory"),
        fallback=str(expression_seed.get("product_category_hint") or "由策略判断"),
    )
    title_style = _contract_value_to_text(
        contract.get("title_style") or contract.get("titleStyle") or contract.get("title_requirements"),
        fallback=str(expression_seed.get("title_style_hint") or "标题要贴合策略场景、痛点和结果。"),
    )
    body_style = _contract_value_to_text(
        contract.get("writing_structure") or contract.get("body_style") or contract.get("bodyStyle"),
        fallback=str(expression_seed.get("body_style_hint") or "正文结构由策略决定，按价值动态取舍，不平均分配篇幅。"),
    )
    emoji_style = _contract_value_to_text(
        contract.get("emoji_style") or contract.get("emojiStyle"),
        fallback=str(expression_seed.get("emoji_style_hint") or "使用与产品语境匹配的少量 emoji 做阅读节奏。"),
    )
    tag_style = _contract_value_to_text(
        contract.get("tag_style") or contract.get("tagStyle") or contract.get("tag_hints"),
        fallback="、".join(str(item) for item in (expression_seed.get("tag_hints") or [])) or "标签贴合产品类别、目标人群和内容主题。",
    )
    return f"""策略表达执行规则：
- 当前产品/策略类别：{product_category}
- 标题语境：{title_style}
- 正文结构节奏：{body_style}
- emoji 语境：{emoji_style}
- 标签语境：{tag_style}
- 这些规则只决定“怎么写”，不能改写策略决定的主题、人群、痛点、结构方向和产品介入边界。

小红书正文通用排版要求：
- emoji 是排版节奏，不是装饰；建议 5-8 个，必须贴合当前产品语境，不要把一个行业的表情硬套到另一个产品。
- 步骤标题优先用 1️⃣ 2️⃣ 3️⃣ 这类编号，并在编号后留一个空格；标题句尾可补一个对应语义 emoji。
- 位置要克制：开头判断 0-1 个，步骤标题 1 个，重点段落句尾 1 个；不要连续堆两个以上 emoji。
- 避免把 📌/📍 当默认结尾符；除非语境非常适合，否则换成更具体的语义表情。
- 不要为了表情牺牲信息密度；正文仍要自然控制在 900-980 字，绝对不超过 1000 字。"""


def _build_strategy_direct_contract(note_strategy: Optional[Dict[str, Any]], expression_seed: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    note_strategy = note_strategy or {}
    expression_seed = expression_seed or {}
    recommended_plan = [
        str(item).strip()
        for item in (note_strategy.get("recommendedCardPlan") or [])
        if str(item).strip()
    ][:6]
    return {
        "content_type": str(note_strategy.get("label") or note_strategy.get("contentAngle") or "策略直写型").strip(),
        "product_category": str(expression_seed.get("product_category_hint") or "由策略判断").strip(),
        "reader_identity": str(note_strategy.get("targetAudience") or "目标读者").strip(),
        "writing_structure": str(
            note_strategy.get("contentAngle")
            or expression_seed.get("body_style_hint")
            or "按策略主线写成真实场景、判断、动作和收束"
        ).strip(),
        "product_role": str(note_strategy.get("productRole") or note_strategy.get("productUsageMode") or "按策略自然承接").strip(),
        "title_style": str(expression_seed.get("title_style_hint") or "标题要贴合策略场景、痛点和结果。").strip(),
        "emoji_style": str(expression_seed.get("emoji_style_hint") or "").strip(),
        "tag_style": "、".join(str(item) for item in (expression_seed.get("tag_hints") or [])),
        "structure_units": recommended_plan,
        "must_keep": [
            *[str(item).strip() for item in (note_strategy.get("corePainPoints") or []) if str(item).strip()][:3],
            *[str(item).strip() for item in (note_strategy.get("coreBenefits") or []) if str(item).strip()][:3],
        ][:6],
        "avoid": ["标题超20字", "正文超过950字", "正文停在步骤中间", "写成产品功能清单", "结尾像被截断"],
        "quality_bar": [
            "一次写成完整发布稿",
            "正文优先控制在850-930字，硬上限950字",
            "标题20字以内",
            "低AI味，像真实工作复盘或经验分享",
        ],
        "strict_structure_units": True,
    }


def _build_strategy_direct_content_atoms(note_strategy: Optional[Dict[str, Any]], product_info: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    note_strategy = note_strategy or {}
    product_info = product_info or {}
    atoms: List[Dict[str, Any]] = []

    def add(role: str, values: Any, priority: int) -> None:
        raw_values = values if isinstance(values, list) else [values]
        for value in raw_values:
            text = str(value or "").strip()
            if not text or _is_placeholder_text(text):
                continue
            if any(atom["text"] == text for atom in atoms):
                continue
            atoms.append({"role": role, "text": text, "priority": priority})

    add("summary", note_strategy.get("summary"), 1)
    add("pain_point", note_strategy.get("corePainPoints") or [], 1)
    add("benefit", note_strategy.get("coreBenefits") or [], 1)
    add("outline", note_strategy.get("recommendedCardPlan") or [], 2)
    add("angle", note_strategy.get("contentAngle"), 1)
    add("product_feature", product_info.get("product_features"), 2)
    add("must_include", product_info.get("must_include"), 1)
    return atoms[:12]


def _build_strategy_direct_human_voice_guide(
    note_strategy: Optional[Dict[str, Any]],
    expression_seed: Optional[Dict[str, Any]],
) -> str:
    note_strategy = note_strategy or {}
    expression_seed = expression_seed or {}
    strategy_text = _compact_text_for_expression(
        note_strategy.get("label"),
        note_strategy.get("contentAngle"),
        note_strategy.get("summary"),
        note_strategy.get("recommendedCardPlan"),
    )
    body_style = str(expression_seed.get("body_style_hint") or "")
    list_friendly = any(keyword in strategy_text for keyword in ["教程", "清单", "步骤", "框架", "从0到1", "0-1", "检查"])
    structure_rule = (
        "- 当前策略允许步骤/清单，但每一步必须有“为什么会出问题 + 具体怎么做 + 做完有什么变化”，不要只列动作。\n"
        "- 步骤标题最多 4-6 个；如果正文已经有编号，结尾不要再重复总结一遍编号。"
        if list_friendly
        else
        "- 当前策略更适合经验/复盘叙事；不要强行写成 1️⃣2️⃣3️⃣ 清单，优先用自然段推进。"
    )
    return f"""真人发布感要求：
- 开头要像真人刚经历过/复盘过一个具体场景，不要用“在当今/随着/很多人都知道/你是否也”这类模板开场。
- 正文里至少有 2 处具体细节，例如“发前十分钟”“换人后又问一遍”“图片还在群聊天里”“标题改了正文没跟着调”。
- 少用“我现在会/我的做法是/这一步很重要”连续开头；同类句式不要重复超过 2 次。
- 允许轻微口语和犹豫感，例如“说白了”“最麻烦的是”“后来我才发现”，但不要装腔。
- 产品只作为场景里的工具或流程动作出现，不能像产品说明书。
- 结尾要落到一个真实判断、避坑提醒或自查动作，不要只说“以上就是/希望有帮助/赶紧试试”。
{structure_rule}
- 产品语境参考：{body_style or "按策略自然选择真实复盘、教程、避坑或工作流表达。"}"""


def _build_strategy_direct_title_fallbacks(
    *,
    body: str,
    product_info: Dict[str, Any],
    note_strategy: Optional[Dict[str, Any]],
) -> List[str]:
    text = str(body or "")
    product_info = product_info or {}
    note_strategy = note_strategy or {}
    features = _split_term_candidates(str(product_info.get("product_features") or ""))
    strategy_units = [
        *[str(item or "") for item in (note_strategy.get("corePainPoints") or [])[:3]],
        *[str(item or "") for item in (note_strategy.get("coreBenefits") or [])[:3]],
        str(note_strategy.get("label") or ""),
        str(note_strategy.get("summary") or ""),
        str(note_strategy.get("contentAngle") or ""),
    ]
    candidates: List[str] = []

    def add(title: str) -> None:
        normalized = str(title or "").strip()
        if normalized and len(normalized) <= XHS_TITLE_MAX_CHARS and normalized not in candidates:
            candidates.append(normalized)

    def compact_phrase(value: Any, *, max_chars: int = 11) -> str:
        raw = re.sub(r"[\"'“”‘’「」『』]", "", str(value or ""))
        raw = re.sub(r"第\d+页|封面|钩子|场景|痛点|展开|展示|总结|价值", "", raw)
        chunks = [
            re.sub(r"\s+", "", chunk).strip("“”\"'‘’「」『』【】（）()：:，,。.!！?？、；;")
            for chunk in re.split(r"(?:，|,|。|！|!|？|\?|；|;|：|:|——|-|\n)", raw)
        ]
        chunks = [chunk for chunk in chunks if 3 <= len(chunk) <= 24 and not _is_placeholder_text(chunk)]
        if not chunks:
            return ""
        preferred = next(
            (
                chunk for chunk in chunks
                if any(marker in chunk for marker in ["不是", "别", "卡", "断", "漏", "乱", "慢", "找不到", "写不出", "复盘", "重做"])
            ),
            chunks[0],
        )
        preferred = re.sub(r"^(很多|每次|如果|比如|真正|核心|关键|先|再|然后|从|围绕|让用户看到|重点讲|主打)", "", preferred)
        product_name = re.sub(r"\s+", "", str(product_info.get("product_name") or ""))
        if product_name and product_name in preferred:
            return ""
        return preferred[:max_chars].strip("，,。.!！?？、；;：:")

    for unit in strategy_units:
        phrase = compact_phrase(unit)
        if not phrase:
            continue
        add(phrase)
        if len(phrase) <= 8 and not any(marker in phrase for marker in ["别", "不是", "为什么", "为啥", "怎么", "如何", "先"]):
            if any(marker in unit for marker in ["卡", "断", "漏", "乱", "慢", "找不到", "写不出", "重复", "返工"]):
                add(f"{phrase}别硬扛")
            else:
                add(f"{phrase}先查这点")

    contrast_matches = re.findall(r"([^。！？!?]{0,10}不是[^。！？!?]{2,18}(?:而是|是)[^。！？!?]{2,18})", text)
    for match in contrast_matches[:2]:
        phrase = compact_phrase(match, max_chars=18)
        add(phrase)

    action_text = " ".join(strategy_units + [text])
    for feature in features[:4]:
        compact_feature = re.sub(r"\s+", "", feature)
        if not (2 <= len(compact_feature) <= 6):
            continue
        if compact_feature not in action_text:
            continue
        if any(marker in action_text for marker in ["卡", "断", "漏", "乱", "慢", "返工", "找不到", "写不出"]):
            add(f"{compact_feature}别只当功能")
        if any(term in action_text for term in ["检查", "风险", "发布前", "复盘"]):
            add(f"{compact_feature}先查这点")

    if not candidates:
        for feature in features[:3]:
            compact_feature = re.sub(r"\s+", "", feature)
            if 2 <= len(compact_feature) <= 6:
                add(f"{compact_feature}怎么用")

    return candidates[:6]


def _collect_strategy_direct_quality_flags(
    generator: "ViralContentGenerator",
    *,
    body: str,
    title_candidates: List[str],
    benchmark_note: Dict[str, Any],
    product_info: Dict[str, Any],
    note_strategy: Optional[Dict[str, Any]],
    contract: Dict[str, Any],
    product_usage_mode: str,
) -> List[str]:
    flags = _body_publish_quality_flags(
        body,
        title_candidates=title_candidates,
        benchmark_title=str(benchmark_note.get("title") or ""),
        strategy_title=str((note_strategy or {}).get("suggestedTitle") or ""),
        product_usage_mode=product_usage_mode,
        product_info=product_info,
    )
    text = str(body or "").strip()
    if len(text) > XHS_STRATEGY_BODY_TARGET_MAX_CHARS:
        flags.append("body_over_strategy_target")
    incomplete_reasons = _strategy_direct_incomplete_reasons(
        generator,
        text,
        selected_route={"content_outline": contract.get("structure_units") or []},
        contract=contract,
        note_strategy=note_strategy,
    )
    if incomplete_reasons:
        flags.append("body_incomplete_or_too_short")
        flags.extend(f"body_incomplete_reason:{reason}" for reason in incomplete_reasons)
    if not title_candidates or any(len(title) > XHS_TITLE_MAX_CHARS for title in title_candidates[:1]):
        flags.append("title_missing_or_over_limit")
    return list(dict.fromkeys(flags))

GENERIC_REQUIRED_TERM_STOPWORDS = {
    "今天",
    "哪个",
    "这条",
    "笔记",
    "真的",
    "不是",
    "而是",
    "很多",
    "一个",
    "我们",
    "你们",
    "他们",
    "自己",
    "用户",
    "企业",
    "产品",
    "功能",
    "方案",
    "运营",
    "工具",
    "客户",
    "数据",
}

PLACEHOLDER_TERMS = {
    "暂无",
    "无",
    "没有",
    "无资料",
    "暂无资料",
    "暂无信息",
    "暂无内容",
    "暂无真实用户表达",
}

SAFE_DE_AI_REPLACEMENTS = [
    ("家人们谁懂", "说个真实感受"),
    ("谁懂啊", "真的会有这种感觉"),
    ("宝子们", "先说结论"),
    ("姐妹们", "先说结论"),
    ("真的绝了", "这个点挺实用"),
    ("冲就完事", "可以先试起来"),
    ("闭眼入", "适合认真看看"),
    ("狠狠", ""),
    ("直接封神", "体验会更顺"),
    ("无脑入", "可以优先考虑"),
    ("能够", "能"),
    ("进行", "做"),
    ("提供", "给到"),
    ("通过", "靠"),
    ("实现", "做到"),
    ("提升", "拉高"),
    ("优化", "调顺"),
    ("解决", "处理掉"),
    ("确保", "保证"),
    ("例如", "比如"),
    ("因此", "所以"),
    ("此外", "另外"),
    ("同时", "也能"),
    ("如果", "要是"),
    ("需要", "得"),
    ("使用", "用"),
    ("帮助", "帮"),
    ("可以", "能"),
]


def _split_paragraphs(text: str) -> List[str]:
    return [paragraph.strip() for paragraph in re.split(r"\n+", text or "") if paragraph.strip()]


def _is_placeholder_text(value: Any) -> bool:
    normalized = re.sub(r"[\s:：。.!！?？,，、;；#＃\-_/\\|｜]+", "", str(value or "").strip())
    return not normalized or normalized in PLACEHOLDER_TERMS


def _strip_placeholder_tail(body: str) -> str:
    lines = str(body or "").splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and _is_placeholder_text(lines[-1]):
        lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()
    return "\n".join(lines).strip()


def _normalize_title_candidates(titles: Any, fallback: Any = None) -> List[str]:
    raw_titles = titles if isinstance(titles, list) else []
    fallback_titles = fallback if isinstance(fallback, list) else []
    deduped: List[str] = []
    for title in [*raw_titles, *fallback_titles]:
        normalized = re.sub(r"\s+", "", str(title or "").strip())
        if normalized and normalized not in deduped:
            deduped.append(normalized)
    return deduped[:5]


TITLE_SIGNAL_STOPWORDS = {
    "为什么",
    "怎么办",
    "怎么做",
    "不是",
    "而是",
    "这个",
    "那个",
    "这些",
    "那些",
    "客户",
    "老板",
    "用户",
    "产品",
    "工具",
    "方法",
    "指南",
    "干货",
    "真的",
    "一个",
    "一篇",
    "很多",
    "你们",
}

TITLE_REUSABLE_SIGNAL_PATTERNS = [
    r"企业微信",
    r"企微",
    r"私域",
    r"SCRM",
    r"小红书",
    r"公众号",
    r"社群",
    r"从0到1",
    r"0到1",
    r"0-1",
    r"\d+步",
    r"\d+个",
]


def _extract_title_signal_terms(*texts: Any) -> List[str]:
    terms: List[str] = []
    raw_text = "\n".join(str(text or "") for text in texts if text)
    for pattern in TITLE_REUSABLE_SIGNAL_PATTERNS:
        for match in re.findall(pattern, raw_text, flags=re.IGNORECASE):
            term = str(match).strip()
            if term and term not in terms:
                terms.append(term)

    for chunk in re.split(r"[\s｜|·•：:，,、;；。.!！?？/\\\n\r\t（）()【】\[\]\"“”'‘’]+", raw_text):
        normalized = chunk.strip().replace("#", "")
        if not normalized or normalized in TITLE_SIGNAL_STOPWORDS:
            continue
        if 2 <= len(normalized) <= 12 and not re.fullmatch(r"[\d\W_]+", normalized):
            if normalized not in terms:
                terms.append(normalized)
    return terms[:12]


def _title_publish_quality_score(
    title: str,
    *,
    benchmark_title: str = "",
    strategy_title: str = "",
    body: str = "",
    product_info: Optional[Dict[str, Any]] = None,
) -> int:
    normalized = re.sub(r"\s+", "", str(title or "").strip())
    if not normalized:
        return -100

    score = 0
    normalized_benchmark_title = re.sub(r"\s+", "", str(benchmark_title or "").strip())
    normalized_strategy_title = re.sub(r"\s+", "", str(strategy_title or "").strip())
    if normalized and normalized == normalized_benchmark_title:
        score -= 24
    elif normalized and normalized == normalized_strategy_title:
        score -= 8
    if len(normalized) <= XHS_TITLE_MAX_CHARS:
        score += 30
    else:
        score -= 90 + (len(normalized) - XHS_TITLE_MAX_CHARS) * 5

    product_info = product_info or {}
    signal_terms = _extract_title_signal_terms(
        benchmark_title,
        strategy_title,
        product_info.get("product_name", ""),
        product_info.get("must_include", ""),
        product_info.get("product_features", ""),
    )
    signal_hits = sum(1 for term in signal_terms if term and term in normalized)
    score += min(signal_hits, 4) * 10
    if signal_terms and signal_hits == 0:
        score -= 18

    if re.search(r"(从0到1|0到1|0-1|\d+步|\d+个|框架|指南|清单|避坑|复盘|拆解|搭建|教程)", normalized):
        score += 14
    if re.search(r"(为什么|为啥|别|先|不是|而是|怎么|如何|到底|真相)", normalized):
        score += 6
    if re.search(r"(省时流程|避坑清单)$", normalized) and not re.search(r"(别|不是|为什么|为啥|卡|断|漏|乱|救|查|先)", normalized):
        score -= 42
    if re.search(r"^(支持|提供|具备|实现|拥有|包含)", normalized) and "、" in normalized:
        score -= 54
    if re.search(r"^(却|但|但是|而且|所以|因为|以及|然后|再|也|还|就|都|被|把)", normalized):
        score -= 50
    if re.search(r"(是不是|有没有|能不能|要不要|是不是关|有没有做|能不能把).{0,2}$", normalized):
        score -= 50
    if len(normalized) >= 8 and not re.search(r"(别|不是|为什么|为啥|怎么|如何|先|卡|断|漏|乱|慢|复盘|流程|清单|指南|框架|客户|内容|资料|标题|文章|笔记|旧文|会议|团队|老板|工具)", normalized):
        score -= 24
    title_fragments = [
        fragment
        for fragment in re.split(r"(?:不是|而是|别|先|怎么|如何|为什么|为啥|，|,|：|:|\\|/|的|了)", normalized)
        if len(fragment) >= 3
    ]
    if body and any(fragment in body for fragment in title_fragments[:4]):
        score += 24
    grounded_title_chunks = [
        normalized[index:index + width]
        for width in (3, 4, 5, 6)
        for index in range(0, max(0, len(normalized) - width + 1))
    ]
    if body and any(chunk in body for chunk in grounded_title_chunks):
        score += 24
    numbered_steps = _numbered_step_indexes(body) if body else []
    title_step_match = re.search(r"(\d+)(?:步|项|个)", normalized)
    if title_step_match and numbered_steps:
        try:
            promised_steps = int(title_step_match.group(1))
        except ValueError:
            promised_steps = 0
        if promised_steps and max(numbered_steps) < promised_steps:
            score -= 28
    if body and any(term in body for term in signal_terms[:6]) and signal_hits == 0:
        score -= 10
    if len(normalized) <= 8 and signal_hits == 0:
        score -= 8
    return score


def _rank_publish_title_candidates(
    titles: Any,
    *,
    benchmark_title: str = "",
    strategy_title: str = "",
    body: str = "",
    product_info: Optional[Dict[str, Any]] = None,
    fallback: Any = None,
) -> List[str]:
    candidates = _normalize_title_candidates(titles, fallback)
    if not candidates:
        return []
    ranked = sorted(
        candidates,
        key=lambda title: _title_publish_quality_score(
            title,
            benchmark_title=benchmark_title,
            strategy_title=strategy_title,
            body=body,
            product_info=product_info,
        ),
        reverse=True,
    )
    in_limit = [title for title in ranked if len(title) <= XHS_TITLE_MAX_CHARS]
    return (in_limit or ranked)[:5]


def _is_publish_checklist_line(line: str) -> bool:
    text = str(line or "").strip()
    if not text:
        return False
    if re.match(r"^[✅✔☑•\-]\s*", text):
        return True
    return bool(re.match(r"^(?:[1-9][️⃣\.、]|第[一二三四五六七八九十]+[步点])", text))


def _is_bare_publish_checklist_line(line: str) -> bool:
    text = re.sub(r"^[✅✔☑•\-\s]+", "", str(line or "").strip())
    if not text or re.match(r"^[1-9][️⃣\.、]", text):
        return False
    if "：" in text or ":" in text or re.search(r"[。！？!?]", text):
        return False
    return len(text) <= 24


def _xhs_layout_emoji_count(text: str) -> int:
    value = str(text or "")
    keycap_count = len(re.findall(r"[0-9#*]\ufe0f?\u20e3", value))
    return len(XHS_LAYOUT_EMOJI_RE.findall(value)) + keycap_count


def _xhs_semantic_body_emoji_count(text: str) -> int:
    value = str(text or "")
    return sum(value.count(emoji) for emoji in XHS_SEMANTIC_BODY_EMOJIS)


def _emoji_profile_category(style_profile: Optional[Dict[str, Any]]) -> str:
    profile = style_profile or {}
    return str(
        profile.get("product_category")
        or profile.get("productCategory")
        or profile.get("product_category_hint")
        or ""
    )


def _emoji_profile_opening(style_profile: Optional[Dict[str, Any]]) -> str:
    profile = style_profile or {}
    emoji_style = _contract_value_to_text(profile.get("emoji_style") or profile.get("emojiStyle"), fallback="")
    for emoji in XHS_SEMANTIC_BODY_EMOJIS:
        if emoji in emoji_style:
            return emoji
    return str(profile.get("opening_emoji") or "💡")


def _xhs_contextual_rules_for_profile(style_profile: Optional[Dict[str, Any]], *, line_is_checklist: bool) -> tuple:
    category = _emoji_profile_category(style_profile)
    if any(marker in category for marker in ["内容", "写作", "自媒体", "效率"]):
        return XHS_CONTENT_TOOL_EMOJI_RULES if line_is_checklist else XHS_CONTENT_TOOL_PARAGRAPH_EMOJI_RULES
    return XHS_PRIVATE_DOMAIN_EMOJI_RULES if line_is_checklist else XHS_PRIVATE_DOMAIN_PARAGRAPH_EMOJI_RULES


def _suggest_xhs_contextual_emoji(
    line: str,
    *,
    is_opening: bool = False,
    style_profile: Optional[Dict[str, Any]] = None,
) -> str:
    text = str(line or "").strip()
    if not text or _xhs_semantic_body_emoji_count(text) > 0:
        return ""
    if ("：" in text or ":" in text) and len(text) <= 32 and not _is_publish_checklist_line(text):
        return ""
    if is_opening and len(text) >= 30:
        return _emoji_profile_opening(style_profile)
    line_is_checklist = _is_publish_checklist_line(text)
    rules = _xhs_contextual_rules_for_profile(style_profile, line_is_checklist=line_is_checklist)
    for keywords, emoji in rules:
        if any(keyword in text for keyword in keywords):
            return emoji
    return ""


def _append_xhs_line_emoji(line: str, emoji: str) -> str:
    if not emoji:
        return line
    stripped = str(line or "").rstrip()
    if not stripped or stripped.endswith(emoji):
        return line
    return f"{stripped} {emoji}"


def _polish_xhs_emoji_layout(
    body: str,
    *,
    max_chars: int = XHS_BODY_SAFE_MAX_CHARS,
    min_semantic_count: int = 5,
    max_additions: int = 6,
    style_profile: Optional[Dict[str, Any]] = None,
) -> tuple[str, List[str]]:
    text = str(body or "").strip()
    if not text:
        return "", []
    if len(text) >= max_chars or _xhs_semantic_body_emoji_count(text) >= min_semantic_count:
        return text, []

    lines = text.splitlines()
    nonempty_indexes = [index for index, line in enumerate(lines) if line.strip()]
    if not nonempty_indexes:
        return text, []

    candidate_indexes: List[tuple[int, bool]] = []
    first_index = nonempty_indexes[0]
    candidate_indexes.append((first_index, True))
    for index in nonempty_indexes:
        if index == first_index:
            continue
        line = lines[index].strip()
        if _is_publish_checklist_line(line):
            candidate_indexes.append((index, False))
    for index in nonempty_indexes:
        if index == first_index or any(existing_index == index for existing_index, _ in candidate_indexes):
            continue
        candidate_indexes.append((index, False))

    notes: List[str] = []
    additions = 0
    current_len = len(text)
    for index, is_opening in candidate_indexes:
        if additions >= max_additions or _xhs_semantic_body_emoji_count("\n".join(lines)) >= min_semantic_count:
            break
        emoji = _suggest_xhs_contextual_emoji(lines[index], is_opening=is_opening, style_profile=style_profile)
        if not emoji:
            continue
        addition_len = len(f" {emoji}")
        if current_len + addition_len > max_chars:
            continue
        lines[index] = _append_xhs_line_emoji(lines[index], emoji)
        current_len += addition_len
        additions += 1
        notes.append(f"补充语义 emoji：{emoji}")

    polished = "\n".join(lines).strip()
    return polished, notes[:4]


def _body_publish_quality_flags(
    body: str,
    *,
    title_candidates: Optional[List[str]] = None,
    benchmark_title: str = "",
    strategy_title: str = "",
    product_usage_mode: str = "",
    product_info: Optional[Dict[str, Any]] = None,
) -> List[str]:
    text = str(body or "").strip()
    if not text:
        return ["empty_body"]

    flags: List[str] = []
    if len(text) > XHS_BODY_MAX_CHARS:
        flags.append("body_over_limit")

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    checklist_lines = [line for line in lines if _is_publish_checklist_line(line)]
    bare_checklist_lines = [line for line in lines if _is_bare_publish_checklist_line(line)]
    checklist_ratio = len(checklist_lines) / max(1, len(lines))
    if len(checklist_lines) >= 12 and checklist_ratio >= 0.38:
        flags.append("checklist_overload")
    if len(bare_checklist_lines) >= 6:
        flags.append("bare_function_list")

    if len(text) >= 650:
        layout_emoji_count = _xhs_layout_emoji_count(text)
        if layout_emoji_count < 3:
            flags.append("layout_too_plain")
        elif _xhs_semantic_body_emoji_count(text) < 4:
            flags.append("emoji_style_weak")

    judgment_markers = ["不是", "而是", "真正", "核心", "关键", "说到底", "其实", "最怕", "更重要", "本质", "重点"]
    value_markers = ["所以", "这样", "才能", "决定", "意味着", "最后", "结果", "沉淀", "转化", "复盘", "资产", "效率"]
    judgment_count = sum(text.count(marker) for marker in judgment_markers)
    value_count = sum(text.count(marker) for marker in value_markers)
    if len(text) >= 650 and judgment_count < 4 and value_count < 8:
        flags.append("weak_value_translation")

    product_info = product_info or {}
    product_name = str(product_info.get("product_name") or "").strip()
    if product_usage_mode == "product_assist" and product_name:
        if text.count(product_name) >= 4:
            flags.append("product_overexposed")
        if not _has_product_assist_bridge(text, product_info):
            flags.append("product_assist_missing_bridge")

    best_title = (title_candidates or [""])[0]
    if best_title and _title_publish_quality_score(
        best_title,
        benchmark_title=benchmark_title,
        strategy_title=strategy_title,
        body=text,
        product_info=product_info,
    ) < 32:
        flags.append("weak_title")
    return flags


def _has_product_assist_bridge(text: str, product_info: Dict[str, Any]) -> bool:
    body = str(text or "").strip()
    if not body:
        return False

    tail = body[-420:]
    product_name = str((product_info or {}).get("product_name") or "").strip()
    if product_name and product_name not in tail:
        return False
    if product_name and product_name in tail:
        return True

    feature_terms = [
        term
        for term in _split_term_candidates(str((product_info or {}).get("product_features") or ""))
        if 2 <= len(term) <= 16 and term not in GENERIC_REQUIRED_TERM_STOPWORDS
    ]
    feature_hits = sum(1 for term in feature_terms[:8] if term and term in tail)

    generic_bridge_hit = any(term in tail for term in ["工具", "系统", "平台", "助手", "插件"])
    action_hit = any(
        term in tail
        for term in ["辅助", "承接", "固定", "沉淀", "记录", "留痕", "提醒", "检查", "管理", "省时", "效率"]
    )
    return generic_bridge_hit and action_hit and feature_hits >= 2


def _infer_product_expression_category(product_info: Dict[str, Any]) -> str:
    product_info = product_info or {}
    text = _compact_text_for_expression(
        product_info.get("product_name"),
        product_info.get("target_audience"),
        product_info.get("product_features"),
        product_info.get("must_include"),
    )
    lowered = text.lower()
    best_hint = PRODUCT_EXPRESSION_CATEGORY_HINTS[1]
    best_score = -1
    for hint in PRODUCT_EXPRESSION_CATEGORY_HINTS:
        score = 0
        for keyword in hint["keywords"]:
            keyword_text = str(keyword)
            if keyword_text and (keyword_text in text or keyword_text.lower() in lowered):
                score += 1
        if score > best_score:
            best_hint = hint
            best_score = score
    return str(best_hint["category"])


def _build_product_assist_bridge_paragraph(product_info: Dict[str, Any]) -> str:
    product_info = product_info or {}
    product_name = str(product_info.get("product_name") or "").strip()
    feature_terms = [
        term
        for term in _split_term_candidates(str(product_info.get("product_features") or ""))
        if 2 <= len(term) <= 16 and term not in GENERIC_REQUIRED_TERM_STOPWORDS
    ][:3]
    feature_text = "、".join(feature_terms) or "检查、记录和提醒"
    category = _infer_product_expression_category(product_info)
    name_text = product_name or "这类辅助工具"
    if "私域" in category or "SCRM" in category or "B2B" in category:
        return (
            f"如果要把这套承接动作固定下来，{name_text}更适合放在后段做辅助，"
            f"把{feature_text}变成团队可复用的客户承接流程。它不替销售判断客户，只帮团队把信息接住，减少换人后重复询问和跟进断层。"
        )
    if "内容工具" in category or "写作效率" in category:
        return (
            f"如果要把这套发布动作固定下来，{name_text}适合放在最后做辅助，"
            f"把{feature_text}变成内容发布前的固定流程。它不替你决定选题，只帮团队少靠临场记忆，减少临发前漏项和返工。"
        )
    if product_name:
        return (
            f"如果要把这套动作固定下来，{product_name}适合放在最后做辅助，"
            f"把{feature_text}变成团队可复用流程。它不替你做关键判断，只帮团队少靠临场记忆，减少重复返工。"
        )
    return (
        f"如果要把这套动作固定下来，可以用辅助工具把{feature_text}变成团队可复用流程。"
        "它不替你做关键判断，只帮团队少靠临场记忆，减少重复返工。"
    )


def _ensure_product_assist_bridge(
    body: str,
    product_info: Dict[str, Any],
    *,
    max_chars: int = XHS_BODY_SAFE_MAX_CHARS,
) -> tuple[str, List[str]]:
    text = str(body or "").strip()
    if not text or _has_product_assist_bridge(text, product_info):
        return text, []

    bridge = _build_product_assist_bridge_paragraph(product_info)
    reserve = max(420, max_chars - len(bridge) - 2)
    base = _clip_body_to_complete_sentence_limit(text, reserve)
    if len(base) < min(len(text), 420):
        base = text[:reserve].rstrip("，,；;、：: \n\t")
        if base and not re.search(r"[。！？!?]$", base):
            base = base.rstrip("，,；;、：:") + "。"
    combined = "\n\n".join(part for part in [base, bridge] if part).strip()
    combined, limit_notes = _finalize_publish_body_limit(
        combined,
        soft_limit=max_chars,
        hard_limit=XHS_BODY_MAX_CHARS,
    )
    return combined, ["已确定性补回产品轻承接，避免 product_assist 成稿完全变成经验文", *limit_notes]


def _finalize_body_complete_guard(body: str) -> tuple[str, List[str]]:
    text = _strip_placeholder_tail(str(body or "").strip())
    notes: List[str] = []
    if not text:
        return "", notes
    finalized, limit_notes = _finalize_publish_body_limit(text)
    notes.extend(limit_notes)
    if finalized and finalized != text:
        notes.append("最终正文已按完整句收口，避免尾句截断")
    if finalized and len(finalized) > XHS_BODY_MAX_CHARS:
        finalized = _clip_body_to_complete_sentence_limit(finalized, XHS_BODY_SAFE_MAX_CHARS)
        notes.append("最终正文仍超限，已再次按完整句压缩")
    return finalized, notes


def _is_specific_required_term(term: str) -> bool:
    normalized = term.strip().replace("#", "")
    if len(normalized) < 2 or len(normalized) > 18:
        return False
    if normalized in GENERIC_REQUIRED_TERM_STOPWORDS:
        return False
    if re.fullmatch(r"[\d\s\W_]+", normalized):
        return False
    return True


def _split_term_candidates(value: str) -> List[str]:
    return [
        item.strip().replace("#", "")
        for item in re.split(r"[，,、；;。！？!?\|｜/\\\n\r\t]+", value or "")
        if item.strip() and not _is_placeholder_text(item)
    ]


def _normalize_generated_tags(tags: Any, *, limit: int = 8) -> List[str]:
    if isinstance(tags, str):
        raw_items = re.split(r"[\s,，、;；#\n\r\t]+", tags)
    elif isinstance(tags, list):
        raw_items = []
        for item in tags:
            raw_items.extend(re.split(r"[\s,，、;；#\n\r\t]+", str(item or "")))
    else:
        raw_items = []

    normalized: List[str] = []
    for item in raw_items:
        tag = re.sub(r"^[#＃]+", "", str(item or "").strip())
        tag = re.sub(r"[。.!！?？,，;；、]+$", "", tag).strip()
        if not tag or len(tag) > 24:
            continue
        if tag not in normalized:
            normalized.append(tag)
    return normalized[:limit]


def _strip_trailing_hashtag_block(body: str, tags: Any = None) -> tuple[str, List[str]]:
    text = str(body or "").strip()
    normalized_tags = _normalize_generated_tags(tags)
    if not text:
        return "", normalized_tags

    extracted_tags: List[str] = []
    lines = text.splitlines()
    while lines:
        line = lines[-1].strip()
        if not line:
            lines.pop()
            continue

        candidate = re.sub(r"^(?:标签|话题|发布标签|hashtags?)\s*[:：]\s*", "", line, flags=re.IGNORECASE).strip()
        if not re.search(r"[#＃]", candidate):
            break
        tag_items = re.findall(r"[#＃]\s*([^\s#＃,，、;；。.!！?？]+)", candidate)
        remainder = re.sub(r"[#＃]\s*[^\s#＃,，、;；。.!！?？]+", "", candidate)
        remainder = re.sub(r"[\s,，、;；。.!！?？]+", "", remainder)
        if not tag_items or remainder:
            break

        extracted_tags = _normalize_generated_tags(tag_items) + extracted_tags
        lines.pop()

    cleaned_body = "\n".join(lines).strip()
    merged_tags = _normalize_generated_tags([*normalized_tags, *extracted_tags])
    return cleaned_body, merged_tags


def _extract_required_terms(
    product_info: Dict[str, Any],
    benchmark_note: Dict[str, Any],
    source_text: str = "",
) -> List[str]:
    raw_terms: List[str] = []
    source = source_text or ""

    product_name = str(product_info.get("product_name", "") or "").strip()
    if product_name:
        raw_terms.append(product_name)

    must_include = str(product_info.get("must_include", "") or "")
    raw_terms.extend(_split_term_candidates(must_include))

    product_features = str(product_info.get("product_features", "") or "")
    for term in _split_term_candidates(product_features):
        if not source or term in source:
            raw_terms.append(term)

    # Benchmark titles are hooks, not factual requirements. Only protect title terms that
    # the generated draft already chose to carry forward.
    benchmark_title = str(benchmark_note.get("title", "") or "")
    for term in re.split(r"[｜|·•：:，,、\s]+", benchmark_title):
        if term and term in source:
            raw_terms.append(term)

    deduped: List[str] = []
    for term in raw_terms:
        normalized = term.strip().replace("#", "")
        if not _is_specific_required_term(normalized):
            continue
        if normalized not in deduped:
            deduped.append(normalized)
    return deduped[:8]


def _missing_required_terms(text: str, required_terms: List[str]) -> List[str]:
    normalized_text = text or ""
    return [term for term in required_terms if term and term not in normalized_text]


def _normalize_body_for_compare(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def _body_has_visible_change(source: str, candidate: str) -> bool:
    source_normalized = _normalize_body_for_compare(source)
    candidate_normalized = _normalize_body_for_compare(candidate)
    if not source_normalized or not candidate_normalized:
        return False
    if source_normalized == candidate_normalized:
        return False
    length_delta = abs(len(source_normalized) - len(candidate_normalized))
    return length_delta >= 2 or source_normalized[:40] != candidate_normalized[:40]


def _body_change_ratio(source: str, candidate: str) -> float:
    source_normalized = _normalize_body_for_compare(source)
    candidate_normalized = _normalize_body_for_compare(candidate)
    if not source_normalized or not candidate_normalized:
        return 0.0
    return 1.0 - SequenceMatcher(None, source_normalized, candidate_normalized).ratio()


def _body_has_meaningful_change(
    source: str,
    candidate: str,
    *,
    min_ratio: float,
    min_changed_chars: int,
) -> bool:
    source_normalized = _normalize_body_for_compare(source)
    candidate_normalized = _normalize_body_for_compare(candidate)
    if not _body_has_visible_change(source_normalized, candidate_normalized):
        return False
    length_delta = abs(len(source_normalized) - len(candidate_normalized))
    common_prefix = 0
    max_prefix = min(len(source_normalized), len(candidate_normalized))
    while common_prefix < max_prefix and source_normalized[common_prefix] == candidate_normalized[common_prefix]:
        common_prefix += 1
    rough_changed_chars = max(length_delta, max(len(source_normalized), len(candidate_normalized)) - common_prefix)
    return _body_change_ratio(source_normalized, candidate_normalized) >= min_ratio or rough_changed_chars >= min_changed_chars


def _clip_body_to_limit(body: str, limit: int = XHS_BODY_MAX_CHARS) -> str:
    text = str(body or "").strip()
    if len(text) <= limit:
        return text

    paragraphs = _split_paragraphs(text)
    kept: List[str] = []
    used = 0
    for paragraph in paragraphs:
        separator_len = 2 if kept else 0
        if used + separator_len + len(paragraph) <= limit:
            kept.append(paragraph)
            used += separator_len + len(paragraph)
            continue
        remaining = limit - used - separator_len
        if remaining > 24:
            kept.append(paragraph[: max(1, remaining - 1)].rstrip("，,；;、 ") + "。")
        break
    return "\n\n".join(kept).strip() or (text[: max(1, limit - 1)].rstrip("，,；;、 ") + "。")


def _clip_body_to_complete_sentence_limit(body: str, limit: int = XHS_BODY_SAFE_MAX_CHARS) -> str:
    text = str(body or "").strip()
    if not text:
        return ""
    if len(text) <= limit and re.search(r"[。！？!?][”’」』）)]?$", text):
        return text

    candidate = text[:limit].rstrip("，,；;、：: \n\t")
    sentence_ends = [match.end() for match in re.finditer(r"[。！？!?]", candidate)]
    minimum_keep = min(len(candidate), max(160, limit - 260))
    usable_ends = [end for end in sentence_ends if end >= minimum_keep]
    if usable_ends:
        return candidate[:usable_ends[-1]].strip()
    return _clip_body_to_limit(text, limit)


def _clip_numbered_body_preserving_steps(body: str, limit: int = XHS_BODY_SAFE_MAX_CHARS) -> str:
    text = str(body or "").strip()
    if not text or len(text) <= limit:
        return text

    paragraphs = _split_paragraphs(text)
    if not paragraphs:
        return ""

    step_starts: List[int] = []
    for index, paragraph in enumerate(paragraphs):
        if _numbered_step_indexes(paragraph[:80]):
            step_starts.append(index)
    if len(step_starts) < 4:
        return ""

    preface = paragraphs[:step_starts[0]]
    groups: List[List[str]] = []
    for position, start in enumerate(step_starts):
        end = step_starts[position + 1] if position + 1 < len(step_starts) else len(paragraphs)
        groups.append(paragraphs[start:end])

    separator_budget = max(0, 2 * (len(groups) + (1 if preface else 0) - 1))
    preface_budget = min(120, max(0, limit // 7)) if preface else 0
    remaining_budget = max(1, limit - preface_budget - separator_budget)
    step_budget = max(90, remaining_budget // len(groups))

    clipped_parts: List[str] = []
    if preface:
        preface_text = "\n\n".join(preface)
        clipped_preface = _clip_body_to_complete_sentence_limit(preface_text, preface_budget)
        if clipped_preface:
            clipped_parts.append(clipped_preface)

    for group in groups:
        group_text = "\n\n".join(group)
        clipped_group = _clip_body_to_complete_sentence_limit(group_text, step_budget)
        if clipped_group:
            clipped_parts.append(clipped_group)

    candidate = "\n\n".join(part for part in clipped_parts if part).strip()
    if len(candidate) <= limit and all(step in _numbered_step_indexes(candidate) for step in _numbered_step_indexes(text)):
        return candidate

    while len(candidate) > limit and step_budget > 70:
        step_budget -= 10
        clipped_parts = []
        if preface:
            preface_text = "\n\n".join(preface)
            clipped_preface = _clip_body_to_complete_sentence_limit(preface_text, max(60, preface_budget - 20))
            if clipped_preface:
                clipped_parts.append(clipped_preface)
        for group in groups:
            clipped_group = _clip_body_to_complete_sentence_limit("\n\n".join(group), step_budget)
            if clipped_group:
                clipped_parts.append(clipped_group)
        candidate = "\n\n".join(part for part in clipped_parts if part).strip()

    candidate_steps = _numbered_step_indexes(candidate)
    original_steps = _numbered_step_indexes(text)
    if candidate and len(candidate) <= limit and all(step in candidate_steps for step in original_steps):
        return candidate
    return ""


def _finalize_publish_body_limit(body: str, *, soft_limit: int = XHS_BODY_SAFE_MAX_CHARS, hard_limit: int = XHS_BODY_MAX_CHARS) -> tuple[str, List[str]]:
    text = _strip_placeholder_tail(str(body or "").strip())
    notes: List[str] = []
    if not text:
        return "", notes

    original = text
    if len(text) > soft_limit:
        text = _clip_body_to_complete_sentence_limit(text, soft_limit)
        notes.append(f"正文已按完整句收口到 {soft_limit} 字安全区间，避免贴近 {hard_limit} 字截断")
    elif not re.search(r"[。！？!?][”’」』）)]?$", text):
        text = _clip_body_to_complete_sentence_limit(text, min(len(text), soft_limit))
        if text != original:
            notes.append("正文尾句不完整，已回退到上一句完整表达")

    if len(text) > hard_limit:
        text = _clip_body_to_complete_sentence_limit(text, hard_limit)
        notes.append(f"正文仍超 {hard_limit} 字，已按完整句硬收口")
    return text, notes


def _derive_publish_tags(
    *,
    title: str = "",
    body: str = "",
    product_info: Optional[Dict[str, Any]] = None,
    benchmark_note: Optional[Dict[str, Any]] = None,
    note_strategy: Optional[Dict[str, Any]] = None,
    existing_tags: Any = None,
    limit: int = 8,
) -> List[str]:
    product_info = product_info or {}
    benchmark_note = benchmark_note or {}
    note_strategy = note_strategy or {}
    text = "\n".join([
        str(title or ""),
        str(body or ""),
        str(product_info.get("product_name") or ""),
        str(product_info.get("target_audience") or ""),
        str(product_info.get("must_include") or ""),
        str(note_strategy.get("contentAngle") or ""),
        str(note_strategy.get("label") or ""),
    ])

    raw_tags: List[Any] = []
    raw_tags.extend(_normalize_generated_tags(existing_tags))
    raw_tags.extend(_normalize_generated_tags(benchmark_note.get("tags") or []))

    known_tag_map = [
        ("企业微信", "企业微信"),
        ("企微", "企微"),
        ("私域", "私域运营"),
        ("社群", "社群运营"),
        ("用户", "用户运营"),
        ("客户", "客户管理"),
        ("SCRM", "SCRM"),
        ("小红书", "小红书运营"),
        ("内容", "内容运营"),
        ("引流", "引流获客"),
        ("获客", "引流获客"),
        ("转化", "转化提升"),
        ("复购", "复购运营"),
        ("风控", "私域风控"),
        ("AI", "AI工具"),
        ("自动化", "自动化运营"),
    ]
    for keyword, tag in known_tag_map:
        if keyword and keyword in text:
            raw_tags.append(tag)

    for field in [
        product_info.get("product_name"),
        product_info.get("target_audience"),
        product_info.get("must_include"),
    ]:
        raw_tags.extend(_split_term_candidates(str(field or "")))

    for item in (note_strategy.get("coreBenefits") or [])[:4]:
        raw_tags.extend(_split_term_candidates(str(item or "")))

    return _normalize_generated_tags(raw_tags, limit=limit)


def _evaluate_polished_body(
    *,
    body_draft: str,
    polished_body: str,
    product_info: Dict[str, Any],
    benchmark_note: Dict[str, Any],
    tags: Optional[List[str]] = None,
    minimum_ratio: float = 0.55,
    max_paragraph_drop: int = 1,
    missing_term_threshold: int = 2,
    enforce_tag_semantics: bool = True,
) -> tuple[bool, str]:
    draft = (body_draft or "").strip()
    polished = (polished_body or "").strip()
    if not draft:
        return True, ""
    if not polished:
        return False, "去 AI 味后正文为空"

    minimum_length = max(120, int(len(draft) * minimum_ratio))
    if len(polished) < minimum_length:
        return False, f"去 AI 味后正文长度仅 {len(polished)}，低于主稿保护阈值 {minimum_length}"

    draft_paragraphs = _split_paragraphs(draft)
    polished_paragraphs = _split_paragraphs(polished)
    if draft_paragraphs and len(polished_paragraphs) < max(2, len(draft_paragraphs) - max_paragraph_drop):
        return False, f"去 AI 味后段落数从 {len(draft_paragraphs)} 降到 {len(polished_paragraphs)}"

    required_terms = _extract_required_terms(product_info, benchmark_note, source_text=draft)
    missing_terms = _missing_required_terms(polished, required_terms)
    if len(missing_terms) >= missing_term_threshold:
        return False, f"去 AI 味后丢失关键表达：{'、'.join(missing_terms[:4])}"

    tag_terms = [str(tag).replace("#", "").strip() for tag in (tags or []) if str(tag).strip()]
    missing_tag_terms = [tag for tag in tag_terms[:5] if tag and tag not in polished]
    if enforce_tag_semantics and len(tag_terms) >= 3 and len(missing_tag_terms) >= 3:
        return False, "去 AI 味后标签语义与正文脱节"

    return True, ""


def _repair_body_with_draft(
    *,
    body_draft: str,
    candidate_body: str,
    product_info: Dict[str, Any],
    benchmark_note: Dict[str, Any],
) -> tuple[str, List[str]]:
    draft = (body_draft or "").strip()
    candidate = (candidate_body or "").strip()
    repairs: List[str] = []
    if not draft:
        return candidate, repairs

    repaired_body = candidate
    draft_paragraphs = _split_paragraphs(draft)
    repaired_paragraphs = _split_paragraphs(repaired_body)

    if repaired_paragraphs and len(repaired_paragraphs) < len(draft_paragraphs):
        missing_tail = draft_paragraphs[len(repaired_paragraphs):]
        if missing_tail:
            repaired_paragraphs.extend(missing_tail)
            repairs.append("按段落补回主稿缺失段")

    required_terms = _extract_required_terms(product_info, benchmark_note, source_text=draft)
    missing_terms = _missing_required_terms("\n\n".join(repaired_paragraphs), required_terms)
    for term in missing_terms:
        source_paragraph = next((paragraph for paragraph in draft_paragraphs if term in paragraph and paragraph not in repaired_paragraphs), None)
        if source_paragraph:
            repaired_paragraphs.append(source_paragraph)
            repairs.append(f"补回关键信息：{term}")

    if not repaired_paragraphs:
        repaired_paragraphs = draft_paragraphs
        repairs.append("候选稿异常，整体回填正文主稿")

    repaired_body = "\n\n".join(repaired_paragraphs).strip()
    return repaired_body or draft, repairs


def _build_safe_minimal_polish(body_draft: str) -> tuple[str, List[str]]:
    draft_paragraphs = _split_paragraphs(body_draft)
    if not draft_paragraphs:
        return (body_draft or "").strip(), []

    notes: List[str] = []
    polished_paragraphs: List[str] = []
    for paragraph in draft_paragraphs:
        next_paragraph = paragraph
        for old, new in SAFE_DE_AI_REPLACEMENTS:
            if old in next_paragraph:
                next_paragraph = next_paragraph.replace(old, new)
                notes.append(f"替换模板表达：{old}")

        next_paragraph = re.sub(r"([。！？!?])\s*(首先|其次|另外|最后|综上)[，,、]?", r"\1\n\2，", next_paragraph)
        if len(next_paragraph) > 80 and next_paragraph.count("，") >= 3 and "\n" not in next_paragraph:
            comma_indexes = [match.start() for match in re.finditer("，", next_paragraph)]
            split_at = comma_indexes[min(1, len(comma_indexes) - 1)] + 1
            next_paragraph = f"{next_paragraph[:split_at]}\n{next_paragraph[split_at:].lstrip()}"
            notes.append("拆分过长句节奏")
        next_paragraph = re.sub(r"(非常|十分|特别){2,}", r"\1", next_paragraph)
        next_paragraph = re.sub(r"[ \t]{2,}", " ", next_paragraph).strip()
        polished_paragraphs.append(next_paragraph)

    polished = "\n\n".join(polished_paragraphs).strip()
    if polished != (body_draft or "").strip() and not notes:
        notes.append("调整长句节奏")
    return polished or (body_draft or "").strip(), list(dict.fromkeys(notes))[:6]


def _build_safe_deep_polish(body_draft: str, minimal_body: str) -> tuple[str, List[str]]:
    source = (minimal_body or body_draft or "").strip()
    paragraphs = _split_paragraphs(source)
    if not paragraphs:
        return source, []

    notes: List[str] = []
    rewritten: List[str] = []
    for index, paragraph in enumerate(paragraphs):
        next_paragraph = paragraph.strip()
        replacements = [
            ("总的来说，", ""),
            ("综上，", ""),
            ("不仅可以", "更适合用来"),
            ("帮助用户", "让你"),
            ("提升效率", "少绕弯"),
            ("非常适合", "更适合"),
            ("如果你也", "如果你正好"),
        ]
        for old, new in replacements:
            if old in next_paragraph:
                next_paragraph = next_paragraph.replace(old, new)
                notes.append(f"改写表达：{old}")
        if index == 0 and not re.match(r"^(说真的|最近|我发现|有一说一|之前)", next_paragraph):
            next_paragraph = f"说真的，{next_paragraph}"
            notes.append("开头增加真人分享语气")
        if index == len(paragraphs) - 1 and "评论" not in next_paragraph and "收藏" not in next_paragraph:
            next_paragraph = f"{next_paragraph}\n\n可以先收藏，等真正要做的时候照着这版思路走。"
            notes.append("结尾补充轻行动引导")
        rewritten.append(next_paragraph)

    polished = "\n\n".join(rewritten).strip()
    if not _body_has_visible_change(source, polished):
        polished = source.replace("。", "。\n", 1).strip()
        notes.append("微调首段节奏")
    return polished or source, list(dict.fromkeys(notes))[:6]


def _format_note_strategy_for_prompt(note_strategy: Optional[Dict[str, Any]]) -> str:
    if not note_strategy:
        return "暂无"

    lines = [
        f"策略名称：{note_strategy.get('label', '')}",
        f"策略摘要：{note_strategy.get('summary', '')}",
        f"推荐标题方向：{note_strategy.get('suggestedTitle', '')}",
        f"目标人群：{note_strategy.get('targetAudience', '')}",
        f"内容角度：{note_strategy.get('contentAngle', '')}",
        f"创作目标：{note_strategy.get('noteGoal', '')}",
        "核心痛点：" + "；".join(str(item) for item in (note_strategy.get("corePainPoints") or []) if str(item).strip()),
        "核心卖点：" + "；".join(str(item) for item in (note_strategy.get("coreBenefits") or []) if str(item).strip()),
        "推荐结构：" + "；".join(str(item) for item in (note_strategy.get("recommendedCardPlan") or []) if str(item).strip()),
    ]
    return "\n".join(line for line in lines if line and not line.endswith("："))


def _format_strategy_anchor_instruction(
    strategy_anchor_terms: List[str],
    *,
    required: bool,
    target: str,
) -> str:
    anchor_text = "、".join(term for term in strategy_anchor_terms if not _is_placeholder_text(term))
    if not anchor_text:
        return "当前策略没有可用锚点词；不要把“暂无”“无”等占位词写入标题或正文。"
    if required:
        return f"策略锚点词必须自然出现，尤其是：{anchor_text}。"
    return f"如果语境适合，可自然使用策略锚点词：{anchor_text}；不要为了塞词牺牲{target}自然度。"


def _get_note_strategy_product_usage_mode(note_strategy: Optional[Dict[str, Any]]) -> str:
    if not note_strategy:
        return ""
    mode = str(note_strategy.get("productUsageMode") or note_strategy.get("product_usage_mode") or "").strip()
    if mode:
        return mode
    benchmark_fit = note_strategy.get("benchmarkFit") or note_strategy.get("benchmark_fit") or {}
    if isinstance(benchmark_fit, dict):
        mode = str(benchmark_fit.get("product_usage_mode") or benchmark_fit.get("productUsageMode") or "").strip()
        if mode:
            return mode
    return ""


def _format_product_usage_constraints(note_strategy: Optional[Dict[str, Any]]) -> str:
    mode = _get_note_strategy_product_usage_mode(note_strategy)
    benchmark_fit = (note_strategy or {}).get("benchmarkFit") or (note_strategy or {}).get("benchmark_fit") or {}
    fit_text = json.dumps(benchmark_fit, ensure_ascii=False) if isinstance(benchmark_fit, dict) and benchmark_fit else "暂无"
    if mode == "no_product":
        return f"""【产品介入约束：no_product】
本次策略诊断要求不使用产品信息。正文和标题必须只复刻对标笔记的标题钩子、开头节奏、卡片/段落顺序、观点推进和互动收束。
禁止出现产品名、产品功能、产品卖点、产品目标人群；禁止把对标方法映射成产品流程；禁止写成产品教程或种草文。
诊断依据：{fit_text}
"""
    if mode == "product_assist":
        return f"""【产品介入约束：product_assist】
本次内容主线必须先服务对标笔记的原始爆点，产品只可作为辅助承接。
产品信息最多出现在最后 1-2 段、附赠提醒或某一个执行环节；禁止把每个步骤都改成产品功能；禁止让标题和正文变成完整产品教程。
诊断依据：{fit_text}
"""
    return ""


def _extract_strategy_anchor_terms(note_strategy: Optional[Dict[str, Any]]) -> List[str]:
    if not note_strategy:
        return []
    if _get_note_strategy_product_usage_mode(note_strategy) == "no_product":
        return []
    raw_text = _format_note_strategy_for_prompt(note_strategy)
    candidates: List[str] = []
    candidates.extend(re.findall(r"\b\d{2,4}(?:\.\d+)?\b", raw_text))
    candidates.extend(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]*(?:大促|促销|复利|增长|开学季|年终|双11|双12|618)[\u4e00-\u9fffA-Za-z0-9]*", raw_text))
    deduped: List[str] = []
    for item in candidates:
        normalized = item.strip()
        if not normalized or normalized in deduped:
            continue
        deduped.append(normalized)
    return deduped[:6]


def _normalize_outline_token(value: Any) -> str:
    text = re.sub(r"\s+", "", str(value or ""))
    text = re.sub(r"^[卡页步骤第]?[一二三四五六七八九十\d]+[：:、.．）)]?", "", text)
    text = re.sub(r"^(封面|过程图|价值总结|收口|步骤)\W*", "", text)
    return re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]", "", text)


def _outline_item_covered(body: str, outline_item: Any) -> bool:
    token = _normalize_outline_token(outline_item)
    if not token:
        return True
    if len(token) <= 4:
        return token in body

    chunks = [
        chunk
        for chunk in re.split(r"(?:和|与|及|、|，|,|：|:|/|\\|\s+)", token)
        if len(chunk) >= 2
    ]
    meaningful_chunks = [chunk for chunk in chunks if chunk not in {"过程图", "步骤", "内容", "完整"}]
    if meaningful_chunks and any(chunk in body for chunk in meaningful_chunks):
        return True

    window = 4 if len(token) <= 8 else 5
    for index in range(0, max(1, len(token) - window + 1)):
        fragment = token[index:index + window]
        if len(fragment) >= 4 and fragment in body:
            return True
    return False


def _numbered_step_indexes(body: str) -> List[int]:
    chinese_numbers = {
        "一": 1,
        "二": 2,
        "三": 3,
        "四": 4,
        "五": 5,
        "六": 6,
        "七": 7,
        "八": 8,
        "九": 9,
        "十": 10,
    }
    indexes: List[int] = []
    for match in re.finditer(r"(?m)^\s*(\d+)[\ufe0f\u20e3⃣]?\s*[、.．）)]?", str(body or "")):
        try:
            indexes.append(int(match.group(1)))
        except ValueError:
            continue
    for match in re.finditer(r"(?m)^\s*(?:第)?([一二三四五六七八九十])(?:步|点|个|、|：|:|，|,)", str(body or "")):
        index = chinese_numbers.get(match.group(1))
        if index:
            indexes.append(index)
    return indexes


def _ends_with_bare_step_heading(body: str) -> bool:
    paragraphs = [segment.strip() for segment in re.split(r"\n+", str(body or "").strip()) if segment.strip()]
    if not paragraphs:
        return False
    tail = paragraphs[-1]
    if len(tail) > 42:
        return False
    return bool(re.match(
        r"^(?:\d+[\ufe0f\u20e3⃣]?\s*[、.．）)]?|(?:第)?[一二三四五六七八九十](?:步|点|个|、|：|:|，|,))\s*.+[。！？!?]?$",
        tail,
    ))


def _is_structurally_incomplete_publish_body(
    body: str,
    *,
    selected_route: Optional[Dict[str, Any]] = None,
    contract: Optional[Dict[str, Any]] = None,
    note_strategy: Optional[Dict[str, Any]] = None,
) -> bool:
    text = str(body or "").strip()
    if not text:
        return True
    if _ends_with_bare_step_heading(text):
        return True

    selected_route = selected_route or {}
    contract = contract or {}
    note_strategy = note_strategy or {}
    outline: List[Any] = []
    for source in (
        selected_route.get("content_outline"),
        contract.get("structure_units"),
        note_strategy.get("recommendedCardPlan"),
    ):
        if isinstance(source, list):
            outline = [item for item in source if str(item or "").strip()]
            if outline:
                break

    steps = _numbered_step_indexes(text)
    if outline and len(outline) >= 4:
        covered = sum(1 for item in outline if _outline_item_covered(text, item))
        product_assist_outline = _get_note_strategy_product_usage_mode(note_strategy) == "product_assist"
        expected_numbered_steps = min(len(outline) - 2 if product_assist_outline else len(outline), 6)
        strict_structure_units = bool((contract or {}).get("strict_structure_units"))
        if strict_structure_units and steps and max(steps) >= 4 and max(steps) < expected_numbered_steps:
            return True
        if not steps and len(text) < 600 and covered == 0:
            return True

    if steps:
        max_step = max(steps)
        expects_steps = len(outline) >= 3 or any(
            keyword in _normalize_outline_token(item)
            for item in outline
            for keyword in ("步骤", "流程", "清单", "教程", "处理", "收束")
        )
        starts_like_step_sequence = 1 in steps or len(set(steps)) >= 2
        if expects_steps and starts_like_step_sequence and max_step < 3:
            return True

    if len(text) >= 800:
        return False

    return False


def _strategy_direct_incomplete_reasons(
    generator: "ViralContentGenerator",
    body: str,
    *,
    selected_route: Optional[Dict[str, Any]] = None,
    contract: Optional[Dict[str, Any]] = None,
    note_strategy: Optional[Dict[str, Any]] = None,
) -> List[str]:
    text = str(body or "").strip()
    if not text:
        return ["empty_body"]

    reasons: List[str] = []
    if len(text) < XHS_STRATEGY_BODY_MIN_COMPLETE_CHARS:
        reasons.append("under_min_chars")
    if text.endswith(INCOMPLETE_BODY_SUFFIXES):
        reasons.append("incomplete_suffix")
    if _ends_with_bare_step_heading(text):
        reasons.append("bare_step_heading_tail")

    selected_route = selected_route or {}
    contract = contract or {}
    note_strategy = note_strategy or {}
    outline: List[Any] = []
    for source in (
        selected_route.get("content_outline"),
        contract.get("structure_units"),
        note_strategy.get("recommendedCardPlan"),
    ):
        if isinstance(source, list):
            outline = [item for item in source if str(item or "").strip()]
            if outline:
                break

    steps = _numbered_step_indexes(text)
    if steps:
        max_step = max(steps)
        expects_steps = len(outline) >= 3 or any(
            keyword in _normalize_outline_token(item)
            for item in outline
            for keyword in ("步骤", "流程", "清单", "教程", "处理", "收束")
        )
        starts_like_step_sequence = 1 in steps or len(set(steps)) >= 2
        if expects_steps and starts_like_step_sequence and max_step < 3:
            reasons.append("step_sequence_stops_before_step_3")

        if outline and len(outline) >= 4:
            product_assist_outline = _get_note_strategy_product_usage_mode(note_strategy) == "product_assist"
            expected_numbered_steps = min(len(outline) - 2 if product_assist_outline else len(outline), 6)
            strict_structure_units = bool((contract or {}).get("strict_structure_units"))
            if strict_structure_units and max_step >= 4 and max_step < expected_numbered_steps:
                reasons.append("strict_outline_steps_missing")

    if generator._is_likely_incomplete_xhs_body(text, min_chars=XHS_STRATEGY_BODY_MIN_COMPLETE_CHARS):
        if not reasons:
            reasons.append("likely_incomplete_body")
    if _is_structurally_incomplete_publish_body(
        text,
        selected_route=selected_route,
        contract=contract,
        note_strategy=note_strategy,
    ):
        if not any(reason in reasons for reason in (
            "bare_step_heading_tail",
            "step_sequence_stops_before_step_3",
            "strict_outline_steps_missing",
        )):
            reasons.append("structurally_incomplete")

    return list(dict.fromkeys(reasons))


def _ensure_strategy_direct_complete_closing(
    body: str,
    *,
    product_info: Optional[Dict[str, Any]] = None,
    note_strategy: Optional[Dict[str, Any]] = None,
    max_chars: int = XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
) -> tuple[str, List[str]]:
    text = str(body or "").strip()
    if not text:
        return "", []
    if len(text) >= max_chars:
        return text, []

    product_info = product_info or {}
    note_strategy = note_strategy or {}
    strategy_text = _compact_text_for_expression(
        note_strategy.get("label"),
        note_strategy.get("contentAngle"),
        note_strategy.get("summary"),
    )
    product_name = str(product_info.get("product_name") or "").strip()
    target = str(product_info.get("target_audience") or "").strip()

    closings: List[str] = []
    if any(term in strategy_text + text[-260:] for term in ["复盘", "SOP", "跟进", "客户", "私域"]):
        closings.append("复盘时也要回看关键动作有没有按时完成。")
        closings.append("最后别只问成交数，先问关键动作有没有断。")
    if any(term in strategy_text + text[-260:] for term in ["证据链", "资料", "写作", "内容"]):
        closings.append("最后再动笔，内容会更稳，也更容易追溯。")
    if any(term in strategy_text + text[-260:] for term in ["旧文", "公众号", "选题"]):
        closings.append("先把旧内容重新盘一遍，往往比硬憋新题更有效。")
    if product_name:
        closings.append(f"如果这一步总靠人盯，{product_name}更适合放在流程里做辅助。")
    if target:
        closings.append(f"对{target.split('、')[0]}来说，先把流程跑稳，比临时补救更重要。")
    closings.append("先把这一步补上，后面的效率才不会一直靠人硬扛。")

    paragraphs = _split_paragraphs(text)
    tail = paragraphs[-1] if paragraphs else text
    separator = "" if re.search(r"[。！？!?][”’」』）)]?$", tail) else "。"
    for closing in closings:
        addition = f"{separator}{closing}" if len(tail) <= 42 else f"\n\n{closing}"
        if len(text) + len(addition) <= max_chars:
            return (text + addition).strip(), ["最终本地补齐短收束句，避免正文停在未展开的结尾"]
    return text, []


class ViralContentGenerator:
    def __init__(self, api_key: Optional[str] = None, base_url: Optional[str] = None, model: Optional[str] = None):
        self.config_candidates: List[Dict[str, str]] = []
        if api_key and base_url:
            self.api_key = api_key
            self.base_url = base_url
            self.config_candidates = [{
                "name": "manual",
                "api_key": api_key,
                "base_url": base_url,
            }]
        else:
            self.api_key, self.base_url = resolve_text_generation_config(api_key)
            self.config_candidates = get_text_generation_config_candidates() or [{
                "name": "resolved_default",
                "api_key": self.api_key,
                "base_url": self.base_url,
            }]
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=TEXT_GENERATION_REQUEST_TIMEOUT_SECONDS,
            max_retries=0,
            default_headers={"Accept-Encoding": "identity"},
        )
        self.model_id = model or get_text_generation_model()

    def _safe_json_loads(self, content: Optional[str]) -> Any:
        if content is None:
            raise ValueError("模型未返回文本内容")
            
        try:
            return clean_and_parse_ai_json(content)
        except Exception as e:
            print(f"[ViralContentGenerator] JSON 解析错误: {e}")
            print(f"[ViralContentGenerator] 原始文本 (前 200 字符): {content[:200]}...")
            raise ValueError(f"模型未返回有效的 JSON 格式: {str(e)}")

    def _normalize_json_object(self, payload: Any, *, stage: str) -> Dict[str, Any]:
        if isinstance(payload, dict):
            return payload

        if isinstance(payload, list):
            for item in payload:
                if isinstance(item, dict):
                    print(f"[ViralContentGenerator] {stage} 返回 list，已自动取首个对象元素兜底")
                    return item
            print(f"[ViralContentGenerator] {stage} 返回 list 且不含对象，回退为空对象")
            return {}

        print(f"[ViralContentGenerator] {stage} 返回 {type(payload).__name__}，回退为空对象")
        return {}

    def _is_likely_incomplete_xhs_body(self, body: str, *, min_chars: int = XHS_BODY_MIN_COMPLETE_CHARS) -> bool:
        text = str(body or "").strip()
        if not text:
            return True
        if len(text) < min_chars:
            return True
        if text.endswith(INCOMPLETE_BODY_SUFFIXES):
            return True
        terminal_count = len(re.findall(r"[。！？!?]", text))
        paragraph_count = len([segment for segment in re.split(r"\n+", text) if segment.strip()])
        if terminal_count <= 1 and len(text) < 360:
            return True
        if paragraph_count <= 1 and terminal_count <= 2 and len(text) < 420:
            return True
        return False

    def _is_revision_body_suspicious(self, *, original_body: str, revised_body: str, scope: str, instruction: str = "") -> bool:
        original = str(original_body or "").strip()
        revised = str(revised_body or "").strip()
        instruction_text = str(instruction or "")
        allow_shorter_body = any(
            keyword in instruction_text
            for keyword in ["缩短", "精简", "简短", "短一点", "压缩", "控制字数", "少一点"]
        )
        if not revised:
            return True
        if revised == original:
            return False
        if self._is_likely_incomplete_xhs_body(revised, min_chars=min(160, XHS_BODY_MIN_COMPLETE_CHARS)):
            return True
        if not allow_shorter_body and len(original) >= 320 and len(revised) < max(160, int(len(original) * 0.45)):
            return True
        if scope in {"opening", "closing", "outline", "title"} and len(revised) < max(160, int(len(original) * 0.75)):
            return True
        return False

    def _build_interview_expression_contract(
        self,
        *,
        product_usage_mode: str,
        target_audience: str,
        target_scene: str,
        marketing_goal: str,
    ) -> Dict[str, Any]:
        product_role = "主解决方案" if product_usage_mode == "product_main" else "场景里的辅助工具"
        return {
            "content_type": "访谈提炼型小红书笔记",
            "reader_identity": f"写给{target_audience or target_scene or '目标读者'}看的真实经验分享",
            "writing_structure": "真实卡点开场-场景拆解-方法建议-产品自然承接-轻行动引导",
            "product_role": product_role,
            "quality_bar": [
                "围绕访谈结果展开",
                "正文有完整段落和收束",
                "产品信息只在场景中自然出现",
                f"服务目标：{marketing_goal or '让读者产生共鸣并愿意行动'}",
            ],
        }

    def _build_interview_content_outline(
        self,
        *,
        content: str,
        marketing_goal: str,
        real_motivation: str,
        target_scene: str,
        action_goal: str,
        product_features: str,
    ) -> List[str]:
        outline = [
            item for item in [
                f"开头切入：{real_motivation}" if real_motivation else "",
                f"读者场景：{target_scene}" if target_scene else "",
                "拆出最容易共鸣的具体卡点",
                f"把产品能力翻译成解决动作：{product_features}" if product_features else "",
                f"结尾行动：{action_goal or marketing_goal}" if (action_goal or marketing_goal) else "",
            ]
            if item
        ]
        if len(outline) >= 3:
            return outline[:6]
        paragraphs = _split_paragraphs(content)
        fallback_outline = [paragraph[:42] for paragraph in paragraphs if paragraph.strip()]
        return (outline + fallback_outline)[:6]

    def _build_interview_content_atoms(
        self,
        *,
        collected_info: Dict[str, Any],
        raw_context_notes: List[str],
        content_outline: List[str],
    ) -> List[Dict[str, str]]:
        atoms: List[Dict[str, str]] = []
        field_roles = [
            ("marketing_goal", "goal"),
            ("real_motivation", "pain_point"),
            ("target_scene", "scene"),
            ("action_goal", "closing"),
            ("core_features", "product_bridge"),
            ("product_features", "product_bridge"),
            ("content_specifics", "detail"),
        ]
        seen = set()
        for key, role in field_roles:
            text = str(collected_info.get(key) or "").strip()
            if text and text not in seen:
                atoms.append({"role": role, "text": text})
                seen.add(text)
        for note in raw_context_notes[:4]:
            note_text = str(note or "").strip()
            if note_text and note_text not in seen:
                atoms.append({"role": "user_phrase", "text": note_text})
                seen.add(note_text)
        for item in content_outline[:4]:
            item_text = str(item or "").strip()
            if item_text and item_text not in seen:
                atoms.append({"role": "outline", "text": item_text})
                seen.add(item_text)
        return atoms[:12]

    def _extract_sentences(self, text: str) -> List[str]:
        return [seg.strip() for seg in re.split(r"[。！？\n]", text or "") if seg.strip()]

    def _find_ai_risk_sentences(self, text: str, real_phrases: Optional[List[str]] = None) -> List[str]:
        real_phrase_set = set(real_phrases or [])
        risky: List[str] = []
        for sentence in self._extract_sentences(text):
            if any(marker in sentence for marker in AI_MARKERS):
                risky.append(sentence)
                continue
            if len(sentence) > 28 and sentence.count("，") >= 3:
                risky.append(sentence)
                continue
            if sentence in real_phrase_set:
                continue
            if len(set(re.findall(r"[\u4e00-\u9fff]", sentence))) <= 6 and len(sentence) >= 12:
                risky.append(sentence)
        return risky[:8]

    def _call_json(self, prompt: str, temperature: float = 0.6, max_tokens: int = 2200) -> Dict[str, Any]:
        errors: List[str] = []

        for config in self.config_candidates:
            deduped_models = get_text_generation_model_candidates(config, current_model=self.model_id)
            client = OpenAI(
                api_key=config["api_key"],
                base_url=config["base_url"],
                timeout=TEXT_GENERATION_REQUEST_TIMEOUT_SECONDS,
                max_retries=0,
                default_headers={"Accept-Encoding": "identity"},
            )
            for model_name in deduped_models:
                for attempt in range(2):
                    try:
                        response = client.chat.completions.create(
                            model=model_name,
                            messages=[{"role": "user", "content": prompt}],
                            temperature=temperature if attempt == 0 else max(0.1, temperature - 0.2),
                            max_tokens=max_tokens,
                            response_format={"type": "json_object"},
                        )
                        choice = response.choices[0] if response.choices else None
                        finish_reason = str(getattr(choice, "finish_reason", "") or "").lower() if choice else ""
                        if finish_reason in {"length", "max_tokens"}:
                            raise ValueError(f"模型输出被截断: finish_reason={finish_reason}, max_tokens={max_tokens}")
                        content = choice.message.content if choice else None
                        if content is None or not str(content).strip():
                            raise ValueError("模型未返回可解析的 JSON 文本")
                        self.api_key = config["api_key"]
                        self.base_url = config["base_url"]
                        self.client = client
                        self.model_id = model_name
                        return self._safe_json_loads(content)
                    except Exception as error:
                        error_text = str(error)
                        errors.append(f"{config['name']}::{model_name}::attempt{attempt + 1}: {error_text}")
                        is_json_format_error = "模型未返回有效的 JSON 格式" in error_text
                        if is_json_format_error and attempt == 0:
                            print(f"[ViralContentGenerator] {model_name} 首次返回坏 JSON，正在同模型重试一次")
                            continue
                        if is_retryable_text_generation_error(error):
                            if attempt == 0:
                                logger.warning(
                                    "[ViralContentGenerator] %s 可重试错误，正在同模型重试一次: %s",
                                    model_name,
                                    error_text[:160],
                                )
                                time.sleep(1.0)
                                continue
                            break
                        raise

        raise RuntimeError("文案模型全部回退失败: " + " | ".join(errors))

    def _build_product_brief(self, product_info: Dict[str, Any]) -> str:
        return "\n".join([
            f"- 产品名称：{product_info.get('product_name', '')}",
            f"- 产品特点：{product_info.get('product_features', '')}",
            f"- 目标人群：{product_info.get('target_audience', '')}",
            f"- 品牌语气：{product_info.get('brand_tone', '真实、口语化、不过度销售')}",
            f"- 必须提及：{product_info.get('must_include', '无')}",
            f"- 禁用词：{product_info.get('banned_terms', '无')}",
        ])

    def build_safe_rewrite_session_from_content(
        self,
        *,
        title: str,
        body: str,
        tags: Optional[List[str]] = None,
        product_info: Optional[Dict[str, Any]] = None,
        benchmark_note: Optional[Dict[str, Any]] = None,
        rewrite_mode: str = "安全轻改",
        fallback_reason: str = "",
    ) -> Dict[str, Any]:
        product_info = product_info or {}
        benchmark_note = benchmark_note or {}
        body_draft = str(body or "").strip()
        body_draft, normalized_tags = _strip_trailing_hashtag_block(body_draft, tags or [])
        title_candidates = _normalize_title_candidates([title], [benchmark_note.get("title")])
        safe_polish_body, safe_polish_notes = _build_safe_minimal_polish(body_draft)
        if not safe_polish_body.strip():
            safe_polish_body = body_draft

        final_body = safe_polish_body
        final_titles = title_candidates
        length_notes: List[str] = []
        try:
            fitted = self._fit_to_xhs_publish_limits(
                title_candidates=title_candidates,
                body=safe_polish_body,
                product_info=product_info,
                note_strategy=fallback_reason,
            )
            final_titles = fitted.get("title_candidates") or title_candidates
            final_body = str(fitted.get("body") or safe_polish_body).strip()
            final_body, normalized_tags = _strip_trailing_hashtag_block(final_body, normalized_tags)
            length_notes = [str(note).strip() for note in (fitted.get("notes") or []) if str(note).strip()]
        except Exception as error:
            length_notes = [f"发布长度适配失败，已保留安全轻改稿：{error}"]
            final_body, normalized_tags = _strip_trailing_hashtag_block(final_body, normalized_tags)

        changed = _body_has_visible_change(body_draft, final_body)
        report_summary = "新版多步去 AI 味失败，已启用安全轻改兜底。"
        if changed:
            report_summary = "已启用安全轻改兜底，保留策略信息并降低模板腔。"
        if fallback_reason:
            report_summary = f"{report_summary} 原因：{fallback_reason}"

        revision_notes = [
            *(safe_polish_notes or []),
            *length_notes,
        ] or ["已检查正文，保留原有策略信息与小红书分段。"]

        return {
            "benchmark_note": benchmark_note,
            "product_info": product_info,
            "rewrite_mode": rewrite_mode,
            "title_candidates": final_titles,
            "opening_candidates": [],
            "content_outline": [],
            "body_draft": body_draft,
            "minimal_polish_body": final_body,
            "deep_polish_body": "",
            "polished_body": final_body,
            "final_body": final_body,
            "final_body_source": "safe_minimal_polish",
            "polished_body_fallback_used": False,
            "polish_guardrail_reason": fallback_reason,
            "guardrail_stage": "safe_minimal_polish",
            "guardrail_repairs_applied": revision_notes[:6],
            "replacement_phrases": [],
            "tags": normalized_tags,
            "rationale": fallback_reason or "新版多步生成失败后启用安全轻改兜底",
            "de_ai_report": {
                "formula_density": 0,
                "emotion_word_overload": 0,
                "sentence_rhythm_risk": len(self._find_ai_risk_sentences(final_body)),
                "comment_voice_gap": 0,
                "summary": report_summary,
            },
            "revision_notes": revision_notes[:6],
            "high_risk_ai_sentences": self._find_ai_risk_sentences(final_body),
            "estimated_engagement": benchmark_note.get("recommendation_tier", "可参考"),
        }

    def _fit_to_xhs_publish_limits(
        self,
        *,
        title_candidates: List[str],
        body: str,
        product_info: Dict[str, Any],
        note_strategy: str = "",
    ) -> Dict[str, Any]:
        normalized_titles = _normalize_title_candidates(title_candidates)
        body_text = str(body or "").strip()
        original_titles = list(normalized_titles)
        original_body = body_text
        title_over_limit = any(len(title) > XHS_TITLE_MAX_CHARS for title in normalized_titles)
        body_over_limit = len(body_text) > XHS_BODY_MAX_CHARS
        if not title_over_limit and not body_over_limit:
            return {
                "title_candidates": normalized_titles,
                "body": body_text,
                "changed": False,
                "notes": [],
            }

        prompt = f"""你是小红书发布前总编辑。请在不降低内容质量的前提下，把标题和正文调整到平台发布长度内。

【产品 brief】
{self._build_product_brief(product_info)}

【当前标题候选】
{json.dumps(normalized_titles, ensure_ascii=False)}

【当前正文】
{body_text}

【当前策略/说明】
{note_strategy}

{XHS_TITLE_QUALITY_GUIDE}

硬性要求：
1. 标题候选每条必须 20 字以内，不能靠生硬截断；即使原标题已合规，也要优先优化成更有小红书吸引力的标题。
2. 正文必须 1000 字以内，建议 900-980 字。
3. 保留：目标人群、核心痛点、核心卖点、关键场景、行动引导、真人语气和 emoji 排版。
4. 压缩方式：合并重复铺垫、删泛泛解释、缩短长句、减少同义反复；不要删掉产品关键能力。
5. 必须保留小红书阅读节奏：严格参考【当前正文】原有分段方式；正文要有空行分段，建议 4-8 个自然段；清单项、✅/✨/👉 这类提示符要单独成行；不要把全文压成一个大段落。
6. 不要输出 Markdown，不要解释过程。
7. JSON 字符串里的正文必须包含换行符；段落之间用两个换行符，清单项之间用一个换行符。

请输出严格 JSON：
{{
  "title_candidates": ["3个20字以内、有场景/痛点/结果感的标题"],
  "body": "1000字以内的高质量正文，保留小红书换行和空行分段",
  "notes": ["做了哪些压缩和保留"]
}}
"""
        next_titles = normalized_titles
        next_body = body_text
        notes: List[str] = []
        for attempt in range(2):
            fitted = self._normalize_json_object(
                self._call_json(
                    prompt if attempt == 0 else prompt + "\n\n上一次输出仍然超限、排版不佳或标题太普通，请再次重写，必须保证标题≤20字且更像小红书标题，正文≤1000字，并保留空行分段/清单独立成行，不能生硬截断。",
                    temperature=0.25 if attempt == 0 else 0.15,
                    max_tokens=2200,
                ),
                stage="xhs_publish_length_fit",
            )
            next_titles = _normalize_title_candidates(fitted.get("title_candidates"), normalized_titles)
            next_body = str(fitted.get("body") or body_text).strip()
            notes = [str(item).strip() for item in (fitted.get("notes") or []) if str(item).strip()] if isinstance(fitted.get("notes"), list) else []
            if not any(len(title) > XHS_TITLE_MAX_CHARS for title in next_titles) and len(next_body) <= XHS_BODY_MAX_CHARS:
                break
            normalized_titles = next_titles
            body_text = next_body
        if len(next_body) > XHS_BODY_MAX_CHARS:
            next_body = _clip_body_to_limit(next_body, XHS_BODY_MAX_CHARS)
            notes = [*notes, "模型两次压缩后仍超限，已按段落兜底压到发布长度内"]
        return {
            "title_candidates": next_titles,
            "body": next_body,
            "changed": next_titles != original_titles or next_body != original_body,
            "notes": notes,
        }

    def _revise_confirmation_title(
        self,
        *,
        title: str,
        opening: str,
        outline: List[str],
        body: str,
        closing: str = "",
        instruction: str,
        rewrite_session: Optional[Dict[str, Any]] = None,
        product_info: Optional[Dict[str, Any]] = None,
        benchmark_note: Optional[Dict[str, Any]] = None,
        note_strategy: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        body_excerpt = str(body or "").strip()
        if len(body_excerpt) > 900:
            body_excerpt = body_excerpt[:900] + "..."
        benchmark_title = str((benchmark_note or {}).get("title") or "").strip()
        prompt = f"""你是小红书确认稿工作台里的“标题主编”，只负责改标题。

用户不是要你概括正文，而是要你基于上下文重新设计更值得点击的标题。

【当前标题】
{title}

【用户指令】
{instruction}

【笔记上下文】
开头：{opening}
结构骨架：{json.dumps(outline or [], ensure_ascii=False)}
正文摘要：{body_excerpt}
结尾：{closing}

【产品 brief】
{self._build_product_brief(product_info or {})}

【当前策略】
{json.dumps(note_strategy or {}, ensure_ascii=False)}

【对标标题】
{benchmark_title}

{XHS_TITLE_QUALITY_GUIDE}
{TITLE_REVISION_GUIDE}

硬性要求：
1. 只改标题，不改正文、开头、结构、结尾。
2. 输出 3 个候选标题，每个自然控制在 20 字以内。
3. 三个候选必须是不同角度：痛点型、反差型、结果/场景型；不能只是同义词替换。
4. 不要输出“标题：”前缀，不要 Markdown，不要解释长篇过程。
5. `selected_title` 必须从 `title_candidates` 里选择最强的一条。

请输出严格 JSON：
{{
  "selected_title": "最推荐标题",
  "title_candidates": ["痛点型标题", "反差型标题", "结果或场景型标题"],
  "reasoning_summary": "一句话说明为什么这个标题更适合"
}}
"""
        result = self._normalize_json_object(
            self._call_json(prompt, temperature=0.72, max_tokens=650),
            stage="title_revision",
        )
        raw_candidates = result.get("title_candidates")
        selected_title = str(result.get("selected_title") or "").strip()
        title_candidates = _normalize_title_candidates(
            [selected_title, *(raw_candidates if isinstance(raw_candidates, list) else [])],
            [title],
        )
        if not title_candidates:
            title_candidates = _normalize_title_candidates([title])
        selected_title = title_candidates[0]

        merged_session = dict(rewrite_session or {})
        merged_session["title_candidates"] = _normalize_title_candidates([
            selected_title,
            *title_candidates,
            *(merged_session.get("title_candidates") or []),
        ])
        merged_session["revision_notes"] = [
            f"标题修改：{instruction}",
            *(merged_session.get("revision_notes") or []),
        ][:6]

        return {
            "detected_scope": "title",
            "reasoning_summary": str(result.get("reasoning_summary") or "已基于正文场景和策略重写标题。").strip(),
            "updated_fields": {
                "title": selected_title,
                "opening": opening,
                "outline": outline,
                "body": body,
                "closing": closing,
            },
            "updated_rewrite_session": merged_session,
        }

    def revise_confirmation_note(
        self,
        *,
        title: str,
        opening: str,
        outline: List[str],
        body: str,
        closing: str = "",
        instruction: str,
        selected_scope: Optional[str] = None,
        rewrite_session: Optional[Dict[str, Any]] = None,
        product_info: Optional[Dict[str, Any]] = None,
        benchmark_note: Optional[Dict[str, Any]] = None,
        note_strategy: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        normalized_outline = [str(item).strip() for item in (outline or []) if str(item).strip()]
        scope_hint = selected_scope or "auto"
        if scope_hint == "title":
            return self._revise_confirmation_title(
                title=title,
                opening=opening,
                outline=normalized_outline,
                body=body,
                closing=closing,
                instruction=instruction,
                rewrite_session=rewrite_session,
                product_info=product_info,
                benchmark_note=benchmark_note,
                note_strategy=note_strategy,
            )

        prompt = f"""你是小红书笔记确认工作台里的“定向改写编辑器”。

你的任务：根据用户的自然语言修改要求，判断这是整篇修改还是局部修改，只更新必要字段。

【当前确认稿】
标题：{title}
开头：{opening}
结构骨架：{json.dumps(normalized_outline, ensure_ascii=False)}
正文：{body}
结尾：{closing}

【用户指令】
{instruction}

【用户显式选择的优先作用域】
{scope_hint}

【产品 brief】
{self._build_product_brief(product_info or {})}

【当前策略】
{json.dumps(note_strategy or {}, ensure_ascii=False)}

【对标笔记】
{json.dumps(benchmark_note or {}, ensure_ascii=False)}

规则：
1. 如果用户显式选中了作用域，则必须优先遵守。
2. 如果用户没有显式选择作用域，你要自己判断是 title/opening/outline/body/closing/full_note 中哪个最合适。
3. 只改必要内容，不要顺手重写无关字段。
4. 输出字段里的正文必须更像小红书真人表达，避免模板腔，同时适度增加符合语境的 emoji 表情提升排版。
5. 如果是 full_note，可以同时更新 title/opening/outline/body/closing。
6. `updated_rewrite_session` 要返回一个完整可用的会话对象；至少同步 title_candidates、opening_candidates、content_outline、body_draft、polished_body、final_body、revision_notes。
7. 标题必须自然控制在 20 字以内，并符合小红书点击标题风格；正文必须自然控制在 1000 字以内；如果用户要求扩写，也要用合并重复信息的方式守住长度。
{XHS_TITLE_QUALITY_GUIDE}

请输出严格 JSON：
{{
  "detected_scope": "title | opening | outline | body | closing | full_note",
  "reasoning_summary": "一句话说明为什么判断为这个作用域",
  "updated_fields": {{
    "title": "可选",
    "opening": "可选",
    "outline": ["可选"],
    "body": "可选",
    "closing": "可选"
  }},
  "updated_rewrite_session": {{
    "title_candidates": ["至少1条标题"],
    "opening_candidates": ["至少1条开头"],
    "content_outline": ["结构骨架"],
    "body_draft": "正文",
    "polished_body": "正文",
    "final_body": "正文",
    "revision_notes": ["本次改动说明"]
  }}
}}
"""
        result = self._normalize_json_object(
            self._call_json(prompt, temperature=0.45, max_tokens=3600),
            stage="note_revision",
        )

        detected_scope = str(result.get("detected_scope") or selected_scope or "full_note").strip()
        if detected_scope not in {"title", "opening", "outline", "body", "closing", "full_note"}:
            detected_scope = selected_scope or "full_note"

        updated_fields = result.get("updated_fields", {}) if isinstance(result.get("updated_fields"), dict) else {}
        resolved_title = str(updated_fields.get("title") or title).strip()
        resolved_opening = str(updated_fields.get("opening") or opening).strip()
        resolved_outline = updated_fields.get("outline") if isinstance(updated_fields.get("outline"), list) else normalized_outline
        resolved_outline = [str(item).strip() for item in resolved_outline if str(item).strip()]
        resolved_body = str(updated_fields.get("body") or body).strip()
        resolved_closing = str(updated_fields.get("closing") or closing).strip()
        revision_notes: List[str] = []
        if self._is_revision_body_suspicious(
            original_body=body,
            revised_body=resolved_body,
            scope=detected_scope,
            instruction=instruction,
        ):
            print(
                "[ViralContentGenerator] note_revision 返回疑似不完整正文，已保留原确认稿正文 "
                f"scope={detected_scope} original_len={len(str(body or '').strip())} revised_len={len(resolved_body)}"
            )
            resolved_body = str(body or "").strip()
            revision_notes.append("模型本次返回的正文疑似不完整，已保留修改前完整正文，避免覆盖成残稿")
        fitted = self._fit_to_xhs_publish_limits(
            title_candidates=[resolved_title],
            body=resolved_body,
            product_info=product_info or {},
            note_strategy=instruction,
        )
        resolved_title = (fitted.get("title_candidates") or [resolved_title])[0]
        resolved_body = str(fitted.get("body") or resolved_body).strip()

        merged_session = dict(rewrite_session or {})
        returned_session = result.get("updated_rewrite_session", {}) if isinstance(result.get("updated_rewrite_session"), dict) else {}
        merged_session.update(returned_session)
        merged_session["title_candidates"] = _normalize_title_candidates([
            resolved_title,
            *(returned_session.get("title_candidates") or merged_session.get("title_candidates") or []),
        ])
        merged_session["opening_candidates"] = [
            item for item in [
                resolved_opening,
                *(returned_session.get("opening_candidates") or merged_session.get("opening_candidates") or []),
            ]
            if isinstance(item, str) and item.strip()
        ][:5]
        merged_session["content_outline"] = resolved_outline
        merged_session["body_draft"] = resolved_body
        merged_session["polished_body"] = resolved_body
        merged_session["final_body"] = resolved_body
        merged_session["final_body_source"] = "custom_revision"
        merged_session["revision_notes"] = [
            *(returned_session.get("revision_notes") or [instruction]),
            *revision_notes,
            *(fitted.get("notes") or []),
        ][:6]

        return {
            "detected_scope": detected_scope,
            "reasoning_summary": str(result.get("reasoning_summary") or "已按你的要求更新确认稿。").strip(),
            "updated_fields": {
                "title": resolved_title,
                "opening": resolved_opening,
                "outline": resolved_outline,
                "body": resolved_body,
                "closing": resolved_closing,
            },
            "updated_rewrite_session": merged_session,
        }

    def _candidate_judge_enabled(self) -> bool:
        return bool(getattr(settings, "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED", False))

    def generate_strategy_direct_session(
        self,
        *,
        benchmark_note: Dict[str, Any],
        product_info: Dict[str, Any],
        rewrite_mode: str = "策略直写",
        sales_intensity: int = 45,
        colloquial_level: int = 75,
        authenticity_level: int = 80,
        real_phrases: Optional[List[str]] = None,
        note_strategy: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        benchmark_note = benchmark_note or {}
        product_info = product_info or {}
        note_strategy = note_strategy or {}
        strategy_text = _format_note_strategy_for_prompt(note_strategy)
        product_usage_constraints = _format_product_usage_constraints(note_strategy)
        product_usage_mode = _get_note_strategy_product_usage_mode(note_strategy)
        product_brief_text = self._build_product_brief(product_info)
        if product_usage_mode == "no_product":
            product_brief_text = "本次产品介入模式为 no_product。产品信息不得进入标题、正文、卡片骨架或策略锚点。"
        product_assist_generation_rule = (
            "- 当前是 product_assist：正文主线先讲策略爆点，产品只在最后 1 段自然承接；建议只出现 1 次产品名，不能写成功能教程。\n"
            if product_usage_mode == "product_assist"
            else ""
        )
        real_phrase_text = "\n".join(f"- {phrase}" for phrase in (real_phrases or [])[:10]) or "- 暂无真实用户表达"
        strategy_title = str(note_strategy.get("suggestedTitle") or "").strip()
        benchmark_title = str(benchmark_note.get("title") or "").strip()
        expression_seed = _build_strategy_expression_seed(product_info, note_strategy, benchmark_note)
        contract = _build_strategy_direct_contract(note_strategy, expression_seed)
        content_atoms = _build_strategy_direct_content_atoms(note_strategy, product_info)
        dynamic_style_guide = _build_dynamic_xhs_style_guide(contract, expression_seed)
        human_voice_guide = _build_strategy_direct_human_voice_guide(note_strategy, expression_seed)
        content_outline = [
            str(item).strip()
            for item in (contract.get("structure_units") or [])
            if str(item).strip()
        ][:6]
        if not content_outline:
            content_outline = [
                str(atom.get("text") or "").strip()
                for atom in content_atoms
                if isinstance(atom, dict) and str(atom.get("text") or "").strip()
            ][:6]

        prompt = f"""你是小红书策略直写主编。请基于【当前已选笔记策略】一次写出可发布标题和正文。

这次不要做多候选路线、不要写蓝图、不要解释过程，只交付一篇完整稿。

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【策略表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【内容原子】
{json.dumps(content_atoms, ensure_ascii=False, indent=2)}

【可参考背景】
标题方向：{benchmark_title or strategy_title}
正文参考：{benchmark_note.get('desc', '')}

【真实用户表达优先词库】
{real_phrase_text}

{XHS_TITLE_QUALITY_GUIDE}

{dynamic_style_guide}

{human_voice_guide}

【参数】
- 改写模式：{rewrite_mode}
- 销售感强弱：{sales_intensity}/100
- 口语化程度：{colloquial_level}/100
- 真实体验感：{authenticity_level}/100

硬性要求：
1. `final_title` 和 `title_candidates` 每条都必须 20 字以内，不能生硬截断。
2. `title_candidates` 至少覆盖 3 种不同钩子：具体痛点、反差判断、结果收益/自查动作；不要只给“清单/流程/指南”同质标题。
3. `body` 必须一次写成 820-900 字的完整发布稿，硬上限 950 字，绝对不能超过 1000 字。
4. 正文必须完整收束，不能停在步骤标题、清单中间、冒号后面或半句话。
5. {XHS_BODY_LAYOUT_GUIDE}
6. 写法要像真实工作复盘、避坑、教程或经验分享；少用“赋能、闭环、提升效率”等模板词。
7. 每个产品能力都要翻译成“解决什么真实卡点/为什么重要/带来什么结果”，不要只列功能。
8. emoji 只做阅读节奏，建议 4-7 个，必须贴合产品语境，不要连续堆。
9. 严格遵守产品介入边界：{product_usage_mode or "按策略自然处理"}。
{product_assist_generation_rule}10. 不要输出 Markdown，不要输出话题标签在正文里。

请输出严格 JSON：
{{
  "final_title": "20字以内最终标题",
  "title_candidates": ["3-5个20字以内候选标题"],
  "body": "820-900字完整正文，保留小红书换行和空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "rationale": "一句话说明为什么这篇贴合策略"
}}
"""
        draft_payload = self._normalize_json_object(
            self._call_json(prompt, temperature=0.62, max_tokens=2300),
            stage="strategy_direct_draft",
        )
        body_draft = str(
            draft_payload.get("body")
            or draft_payload.get("content")
            or draft_payload.get("final_body")
            or ""
        ).strip()
        body_draft, draft_tags = _strip_trailing_hashtag_block(body_draft, draft_payload.get("tags", []))
        body_draft = _strip_placeholder_tail(body_draft)
        body_draft, emoji_notes = _polish_xhs_emoji_layout(
            body_draft,
            max_chars=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
            style_profile={**expression_seed, **contract},
        )
        title_candidates = _rank_publish_title_candidates(
            [
                draft_payload.get("final_title"),
                *(draft_payload.get("title_candidates") if isinstance(draft_payload.get("title_candidates"), list) else []),
            ],
            benchmark_title=benchmark_title,
            strategy_title=strategy_title,
            body=body_draft,
            product_info=product_info,
            fallback=[strategy_title, benchmark_title],
        )
        title_candidates = [title for title in title_candidates if len(title) <= XHS_TITLE_MAX_CHARS]
        final_body = body_draft
        final_tags = _derive_publish_tags(
            title=title_candidates[0] if title_candidates else "",
            body=final_body,
            product_info=product_info,
            benchmark_note=benchmark_note,
            note_strategy=note_strategy,
            existing_tags=[*draft_tags, *(expression_seed.get("tag_hints") or [])],
        )
        quality_flags = _collect_strategy_direct_quality_flags(
            self,
            body=final_body,
            title_candidates=title_candidates,
            benchmark_note=benchmark_note,
            product_info=product_info,
            note_strategy=note_strategy,
            contract=contract,
            product_usage_mode=product_usage_mode,
        )

        repair_notes: List[str] = []
        if quality_flags:
            repair_prompt = f"""你是小红书策略直写返修编辑。当前稿件有硬性问题，请保留策略主线，只修到可发布。

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【策略表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【当前标题候选】
{json.dumps(title_candidates or [draft_payload.get("final_title"), strategy_title, benchmark_title], ensure_ascii=False)}

【当前正文】
{final_body}

【系统质量标记】
{quality_flags}

{XHS_TITLE_QUALITY_GUIDE}

{TITLE_REVISION_GUIDE}

{dynamic_style_guide}

{human_voice_guide}

返修要求：
1. 标题候选每条必须 20 字以内，并且有场景、痛点或结果感。
2. 标题候选至少给出 3 个明显不同角度，不要只在“清单/流程/几步”里换词。
3. 正文改成 850-920 字完整发布稿，硬上限 950 字，绝对不能超过 1000 字。
4. 必须完整写完最后一个步骤和结尾，不能停在标题/清单/半句话。
5. 如果正文太长，优先合并重复铺垫、重复解释和低价值功能点，不要硬截断。
6. 如果正文太短，补足具体场景、判断、动作、结果和自然收束，不要只续写几句。
7. 如果正文太像 SOP 清单，要补“真实发生的麻烦”和“为什么这样做”的判断句。
8. 如果有 product_assist_missing_bridge，最后补 1 段自然产品辅助承接；不能写成整篇产品教程。
9. 如果有 layout_too_plain 或 emoji_style_weak，补 4-7 个贴合语境的 emoji；不要堆表情。
10. 严格遵守产品介入边界：{product_usage_mode or "按策略自然处理"}。
{product_assist_generation_rule}
请输出严格 JSON：
{{
  "title_candidates": ["3-5个20字以内标题"],
  "body": "850-920字完整正文，保留小红书换行和空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "repair_notes": ["具体修了什么"]
}}
"""
            repaired = self._normalize_json_object(
                self._call_json(repair_prompt, temperature=0.32, max_tokens=2300),
                stage="strategy_direct_repair",
            )
            repaired_body = str(repaired.get("body") or "").strip()
            repaired_body, repaired_tags = _strip_trailing_hashtag_block(repaired_body, repaired.get("tags", final_tags))
            repaired_body = _strip_placeholder_tail(repaired_body)
            if repaired_body:
                repaired_body, repaired_emoji_notes = _polish_xhs_emoji_layout(
                    repaired_body,
                    max_chars=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                    style_profile={**expression_seed, **contract},
                )
                final_body = repaired_body
                title_candidates = _rank_publish_title_candidates(
                    repaired.get("title_candidates"),
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    body=final_body,
                    product_info=product_info,
                    fallback=[*title_candidates, strategy_title, benchmark_title],
                )
                title_candidates = [title for title in title_candidates if len(title) <= XHS_TITLE_MAX_CHARS]
                final_tags = _derive_publish_tags(
                    title=title_candidates[0] if title_candidates else "",
                    body=final_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                    note_strategy=note_strategy,
                    existing_tags=[*repaired_tags, *(expression_seed.get("tag_hints") or [])],
                )
                repair_notes = [
                    str(item).strip()
                    for item in (repaired.get("repair_notes") or [])
                    if str(item).strip()
                ] if isinstance(repaired.get("repair_notes"), list) else []
                emoji_notes = [*emoji_notes, *repaired_emoji_notes]

        limit_notes: List[str] = []
        if len(final_body) > XHS_STRATEGY_BODY_TARGET_MAX_CHARS:
            original_over_limit_body = final_body
            compressed_body = ""
            original_steps = _numbered_step_indexes(original_over_limit_body)
            expected_steps = list(range(1, max(original_steps) + 1)) if original_steps and 1 in original_steps and max(original_steps) >= 4 else []
            compression_source_body = original_over_limit_body
            compression_notes: List[str] = []
            for compression_attempt in range(2):
                retry_rule = (
                    "\n【上一次压缩仍不合格】\n"
                    f"上一版长度 {len(compression_source_body)} 字，仍然超出上限或结构不完整。"
                    "这次必须更狠地删重复解释、长例子和产品段，只保留核心动作；最终必须低于 930 字。\n"
                    if compression_attempt > 0
                    else ""
                )
                compression_prompt = f"""你是小红书发布稿保风格压缩编辑。当前正文已经完整写出，但超过字数上限，请只做压缩，不换选题，不改结构，不把文字改成标准答案。

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【当前正文】
{compression_source_body}
{retry_rule}

压缩要求：
1. 最终正文必须控制在 800-920 字，硬上限 {XHS_STRATEGY_BODY_TARGET_MAX_CHARS} 字；超过 920 字就算失败。
2. 保留原稿的真实场景感、口语感和具体观察，不要改成模板清单。
3. 如果原稿已有编号步骤，压缩后必须保留同一组编号步骤；宁可每步短一点，也不能删除后面的步骤。
4. 每个步骤至少保留一个具体动作和一句“为什么”。
5. 优先删除重复铺垫、过长例子、同义反复、泛泛结论、产品段里的多余解释。
6. 严格遵守产品介入边界：{product_usage_mode or "按策略自然处理"}。
{product_assist_generation_rule}
请输出严格 JSON：
{{
  "body": "850-930字完整正文，保留原文分段与编号结构",
  "repair_notes": ["具体压缩了什么"]
}}
"""
                try:
                    compressed_payload = self._normalize_json_object(
                        self._call_json(compression_prompt, temperature=0.16, max_tokens=1600),
                        stage="strategy_direct_structure_compress",
                    )
                    candidate_body = str(compressed_payload.get("body") or "").strip()
                    candidate_body, compressed_tags = _strip_trailing_hashtag_block(candidate_body, final_tags)
                    candidate_body = _strip_placeholder_tail(candidate_body)
                    candidate_steps = _numbered_step_indexes(candidate_body)
                    preserves_steps = not expected_steps or all(step in candidate_steps for step in expected_steps)
                    compression_reasons = _strategy_direct_incomplete_reasons(
                        self,
                        candidate_body,
                        selected_route={"content_outline": contract.get("structure_units") or []},
                        contract=contract,
                        note_strategy=note_strategy,
                    )
                    if (
                        candidate_body
                        and len(candidate_body) <= XHS_STRATEGY_BODY_TARGET_MAX_CHARS
                        and len(candidate_body) >= XHS_STRATEGY_BODY_MIN_COMPLETE_CHARS
                        and preserves_steps
                        and not compression_reasons
                    ):
                        compressed_body = candidate_body
                        final_body = compressed_body
                        if compressed_tags:
                            final_tags = _derive_publish_tags(
                                title=title_candidates[0] if title_candidates else "",
                                body=final_body,
                                product_info=product_info,
                                benchmark_note=benchmark_note,
                                note_strategy=note_strategy,
                                existing_tags=[*compressed_tags, *(expression_seed.get("tag_hints") or [])],
                            )
                        compression_notes = [
                            str(item).strip()
                            for item in (compressed_payload.get("repair_notes") or [])
                            if str(item).strip()
                        ] if isinstance(compressed_payload.get("repair_notes"), list) else []
                        retry_suffix = "（二次压缩）" if compression_attempt > 0 else ""
                        limit_notes.extend([f"正文超长，已用保结构压缩替代尾部裁剪{retry_suffix}", *compression_notes])
                        break
                    compression_source_body = candidate_body or compression_source_body
                except Exception as compression_error:
                    logger.warning("策略直写保结构压缩失败，回退完整句收口: %s", compression_error)
                    break

            if not compressed_body and compression_source_body != original_over_limit_body:
                locally_clipped_body = _clip_numbered_body_preserving_steps(
                    compression_source_body,
                    XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                )
                locally_clipped_steps = _numbered_step_indexes(locally_clipped_body)
                if locally_clipped_body and (not expected_steps or all(step in locally_clipped_steps for step in expected_steps)):
                    final_body = locally_clipped_body
                    compressed_body = locally_clipped_body
                    limit_notes.append("正文超长，模型压缩仍超限，已按编号结构本地收口")

            clipped_body = "" if compressed_body else _clip_body_to_complete_sentence_limit(final_body, XHS_STRATEGY_BODY_TARGET_MAX_CHARS)
            if clipped_body:
                final_body = clipped_body
                limit_notes.append(f"正文已按完整句收口到 {XHS_STRATEGY_BODY_TARGET_MAX_CHARS} 字以内，避免贴近平台上限")
        else:
            final_body, complete_notes = _finalize_publish_body_limit(
                final_body,
                soft_limit=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                hard_limit=XHS_BODY_MAX_CHARS,
            )
            limit_notes.extend(complete_notes)
        final_body = _strip_placeholder_tail(final_body)

        if product_usage_mode == "product_assist":
            assist_flags = _collect_strategy_direct_quality_flags(
                self,
                body=final_body,
                title_candidates=title_candidates,
                benchmark_note=benchmark_note,
                product_info=product_info,
                note_strategy=note_strategy,
                contract=contract,
                product_usage_mode=product_usage_mode,
            )
            if "product_assist_missing_bridge" in assist_flags:
                final_body, bridge_notes = _ensure_product_assist_bridge(
                    final_body,
                    product_info,
                    max_chars=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                )
                repair_notes = [*repair_notes, *bridge_notes]

        if not title_candidates:
            title_candidates = _rank_publish_title_candidates(
                [strategy_title, benchmark_title, product_info.get("product_name")],
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                body=final_body,
                product_info=product_info,
            )
        if not title_candidates:
            title_candidates = _normalize_title_candidates(["发布标题"])

        quality_flags = _collect_strategy_direct_quality_flags(
            self,
            body=final_body,
            title_candidates=title_candidates,
            benchmark_note=benchmark_note,
            product_info=product_info,
            note_strategy=note_strategy,
            contract=contract,
            product_usage_mode=product_usage_mode,
        )
        if "weak_title" in quality_flags and title_candidates:
            repaired_title_candidates = _rank_publish_title_candidates(
                [
                    *_build_strategy_direct_title_fallbacks(
                        body=final_body,
                        product_info=product_info,
                        note_strategy=note_strategy,
                    ),
                    *title_candidates,
                ],
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                body=final_body,
                product_info=product_info,
                fallback=[strategy_title, benchmark_title],
            )
            if repaired_title_candidates:
                title_candidates = repaired_title_candidates

            title_score = _title_publish_quality_score(
                title_candidates[0],
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                body=final_body,
                product_info=product_info,
            )
            if title_score >= 32:
                quality_flags = [flag for flag in quality_flags if flag != "weak_title"]

        final_rescue_notes: List[str] = []
        if "body_incomplete_or_too_short" in quality_flags:
            body_incomplete_reasons = [
                flag.split(":", 1)[1]
                for flag in quality_flags
                if flag.startswith("body_incomplete_reason:")
            ]
            if len(final_body) >= 900:
                rescue_length_rule = (
                    "当前正文已经接近 950 字上限，不要继续扩写大段；请压缩重复铺垫，重点改写最后 1-2 段，"
                    "把未完成的步骤/半句话补完整，最终控制在 860-930 字。"
                )
            else:
                rescue_length_rule = (
                    f"如果当前正文不足 720 字，必须补足至少 {max(120, 820 - len(final_body))} 字的新信息；"
                    "新增内容要围绕真实细节、判断、动作和结果，不要只加口号。"
                )
            rescue_prompt = f"""你是小红书策略直写终稿补全编辑。当前稿件经过返修后仍被系统判定为不完整，请只做最后一次补全，不要重新选题。

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【策略表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【当前标题候选】
{json.dumps(title_candidates, ensure_ascii=False)}

【当前正文】
{final_body}

【仍存在的硬性问题】
{quality_flags}

【不完整原因】
{body_incomplete_reasons or ["未命中具体原因，请重点检查结尾、编号步骤和半句话"]}

【当前正文长度】
{len(final_body)} 字

{XHS_TITLE_QUALITY_GUIDE}

{human_voice_guide}

补全要求：
1. 保留当前正文已经写好的真实场景和主线，不要重写成另一篇。
2. 补齐缺失的策略结构、最后一步、产品承接或自然收束；如果标题承诺了数字，正文必须匹配，或者改成不承诺数字的标题。
3. 正文必须是 820-930 字完整发布稿，硬上限 950 字；不能只有几百字，不能停在步骤中间。
4. {rescue_length_rule}
5. 结尾必须是完整句，落到真实判断、自查提醒或自然产品承接。
6. 严格遵守产品介入边界：{product_usage_mode or "按策略自然处理"}。
{product_assist_generation_rule}
请输出严格 JSON：
{{
  "title_candidates": ["3-5个20字以内标题"],
  "body": "820-930字完整正文，保留空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "repair_notes": ["具体补全了什么"]
}}
"""
            rescued = self._normalize_json_object(
                self._call_json(rescue_prompt, temperature=0.26, max_tokens=2600),
                stage="strategy_direct_final_rescue",
            )
            rescued_body = str(rescued.get("body") or "").strip()
            rescued_body, rescued_tags = _strip_trailing_hashtag_block(rescued_body, rescued.get("tags", final_tags))
            rescued_body = _strip_placeholder_tail(rescued_body)
            if rescued_body:
                rescued_body, rescued_limit_notes = _finalize_publish_body_limit(
                    rescued_body,
                    soft_limit=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                    hard_limit=XHS_BODY_MAX_CHARS,
                )
                rescued_body, rescued_emoji_notes = _polish_xhs_emoji_layout(
                    rescued_body,
                    max_chars=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                    style_profile={**expression_seed, **contract},
                )
                if rescued_emoji_notes:
                    rescued_body, rescued_post_notes = _finalize_publish_body_limit(
                        rescued_body,
                        soft_limit=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                        hard_limit=XHS_BODY_MAX_CHARS,
                    )
                    rescued_limit_notes = [*rescued_limit_notes, *rescued_emoji_notes, *rescued_post_notes]
                rescued_titles = _rank_publish_title_candidates(
                    [
                        *(rescued.get("title_candidates") if isinstance(rescued.get("title_candidates"), list) else []),
                        *title_candidates,
                    ],
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    body=rescued_body,
                    product_info=product_info,
                    fallback=[strategy_title, benchmark_title],
                )
                rescued_titles = [title for title in rescued_titles if len(title) <= XHS_TITLE_MAX_CHARS]
                rescued_flags = _collect_strategy_direct_quality_flags(
                    self,
                    body=rescued_body,
                    title_candidates=rescued_titles or title_candidates,
                    benchmark_note=benchmark_note,
                    product_info=product_info,
                    note_strategy=note_strategy,
                    contract=contract,
                    product_usage_mode=product_usage_mode,
                )
                if "body_incomplete_or_too_short" not in rescued_flags:
                    final_body = rescued_body
                    title_candidates = rescued_titles or title_candidates
                    final_tags = _derive_publish_tags(
                        title=title_candidates[0] if title_candidates else "",
                        body=final_body,
                        product_info=product_info,
                        benchmark_note=benchmark_note,
                        note_strategy=note_strategy,
                        existing_tags=[*rescued_tags, *(expression_seed.get("tag_hints") or [])],
                    )
                    rescue_notes = [
                        str(item).strip()
                        for item in (rescued.get("repair_notes") or [])
                        if str(item).strip()
                    ] if isinstance(rescued.get("repair_notes"), list) else []
                    final_rescue_notes = ["最终补全救援已执行", *rescue_notes, *rescued_limit_notes]
                    quality_flags = rescued_flags

        if "body_incomplete_or_too_short" in quality_flags:
            tail_repair_reasons = [
                flag.split(":", 1)[1]
                for flag in quality_flags
                if flag.startswith("body_incomplete_reason:")
            ]
            tail_repair_prompt = f"""你是小红书发布稿尾段修复编辑。当前稿件只剩“结尾/最后步骤不完整”的问题，请不要换选题，不要重写整篇。

【产品 brief】
{product_brief_text}

【策略】
{strategy_text}

【标题候选】
{json.dumps(title_candidates, ensure_ascii=False)}

【不完整原因】
{tail_repair_reasons or ["结尾不完整"]}

【当前正文长度】
{len(final_body)} 字

【当前正文】
{final_body}

修复要求：
1. 只围绕最后 1-2 段和必要的重复铺垫做压缩/补完，不能改掉主线。
2. 如果结尾停在步骤标题，必须把该步骤写成完整动作 + 原因 + 结果，然后再自然收束。
3. 如果当前正文超过 900 字，不要扩写大段；删掉重复句，把最终正文控制在 860-930 字，硬上限 950 字。
4. 结尾必须是完整句，不能以顿号、逗号、冒号、括号、步骤标题收尾。
5. 保持产品介入边界：{product_usage_mode or "按策略自然处理"}。

请输出严格 JSON：
{{
  "title_candidates": ["3-5个20字以内标题"],
  "body": "860-930字完整发布稿，保留空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "repair_notes": ["具体修复了哪个尾部问题"]
}}
"""
            tail_repaired = self._normalize_json_object(
                self._call_json(tail_repair_prompt, temperature=0.22, max_tokens=2200),
                stage="strategy_direct_tail_repair",
            )
            tail_body = str(tail_repaired.get("body") or "").strip()
            tail_body, tail_tags = _strip_trailing_hashtag_block(tail_body, tail_repaired.get("tags", final_tags))
            tail_body = _strip_placeholder_tail(tail_body)
            if tail_body:
                tail_body, tail_limit_notes = _finalize_publish_body_limit(
                    tail_body,
                    soft_limit=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
                    hard_limit=XHS_BODY_MAX_CHARS,
                )
                tail_titles = _rank_publish_title_candidates(
                    [
                        *(tail_repaired.get("title_candidates") if isinstance(tail_repaired.get("title_candidates"), list) else []),
                        *title_candidates,
                    ],
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    body=tail_body,
                    product_info=product_info,
                    fallback=[strategy_title, benchmark_title],
                )
                tail_titles = [title for title in tail_titles if len(title) <= XHS_TITLE_MAX_CHARS]
                tail_flags = _collect_strategy_direct_quality_flags(
                    self,
                    body=tail_body,
                    title_candidates=tail_titles or title_candidates,
                    benchmark_note=benchmark_note,
                    product_info=product_info,
                    note_strategy=note_strategy,
                    contract=contract,
                    product_usage_mode=product_usage_mode,
                )
                if "body_incomplete_or_too_short" not in tail_flags:
                    final_body = tail_body
                    title_candidates = tail_titles or title_candidates
                    final_tags = _derive_publish_tags(
                        title=title_candidates[0] if title_candidates else "",
                        body=final_body,
                        product_info=product_info,
                        benchmark_note=benchmark_note,
                        note_strategy=note_strategy,
                        existing_tags=[*tail_tags, *(expression_seed.get("tag_hints") or [])],
                    )
                    tail_notes = [
                        str(item).strip()
                        for item in (tail_repaired.get("repair_notes") or [])
                        if str(item).strip()
                    ] if isinstance(tail_repaired.get("repair_notes"), list) else []
                    final_rescue_notes = [
                        *final_rescue_notes,
                        "模型尾段窄修复已执行",
                        *tail_notes,
                        *tail_limit_notes,
                    ]
                    quality_flags = tail_flags

        if "body_incomplete_or_too_short" in quality_flags:
            completed_body, closing_notes = _ensure_strategy_direct_complete_closing(
                final_body,
                product_info=product_info,
                note_strategy=note_strategy,
                max_chars=XHS_STRATEGY_BODY_TARGET_MAX_CHARS,
            )
            if completed_body and completed_body != final_body:
                final_body = completed_body
                final_rescue_notes = [*final_rescue_notes, *closing_notes]
                quality_flags = _collect_strategy_direct_quality_flags(
                    self,
                    body=final_body,
                    title_candidates=title_candidates,
                    benchmark_note=benchmark_note,
                    product_info=product_info,
                    note_strategy=note_strategy,
                    contract=contract,
                    product_usage_mode=product_usage_mode,
                )

        if "body_incomplete_or_too_short" in quality_flags or len(final_body) < XHS_STRATEGY_BODY_MIN_COMPLETE_CHARS:
            raise ValueError(
                "策略直写终稿正文不完整，请重试模型生成"
                f": length={len(final_body)} flags={quality_flags}"
            )

        final_body_source = "strategy_direct_repair" if repair_notes else "strategy_direct"
        revision_notes = [
            "已启用策略直写链路，跳过多候选裁判以减少模型等待",
            *(emoji_notes or []),
            *repair_notes,
            *final_rescue_notes,
            *limit_notes,
            *(f"质量标记：{flag}" for flag in quality_flags),
        ]
        revision_notes = [note for note in revision_notes if str(note).strip()][:8]
        high_risk_sentences = self._find_ai_risk_sentences(final_body, real_phrases=real_phrases)

        return {
            "benchmark_note": benchmark_note,
            "product_info": product_info,
            "rewrite_mode": rewrite_mode,
            "selected_title": title_candidates[0],
            "title_candidates": title_candidates,
            "opening_candidates": _split_paragraphs(final_body)[:2],
            "content_outline": content_outline,
            "body_draft": body_draft,
            "minimal_polish_body": final_body,
            "deep_polish_body": final_body if repair_notes else "",
            "polished_body": final_body,
            "final_body": final_body,
            "final_body_source": final_body_source,
            "polished_body_fallback_used": False,
            "polish_guardrail_reason": "",
            "guardrail_stage": final_body_source,
            "guardrail_repairs_applied": revision_notes[:6],
            "replacement_phrases": [],
            "tags": final_tags,
            "rationale": str(draft_payload.get("rationale") or note_strategy.get("summary") or "").strip(),
            "de_ai_report": {
                "formula_density": 0,
                "emotion_word_overload": 0,
                "sentence_rhythm_risk": len(high_risk_sentences),
                "comment_voice_gap": 0,
                "summary": "已通过策略直写生成，并完成标题、正文长度和完整性校验。",
            },
            "revision_notes": revision_notes,
            "high_risk_ai_sentences": high_risk_sentences,
            "estimated_engagement": benchmark_note.get("recommendation_tier", "可参考"),
            "candidate_judge_enabled": False,
            "candidate_judge_quality_flags": quality_flags,
            "expression_contract": contract,
            "strategy_expression_seed": expression_seed,
            "dynamic_style_guide": dynamic_style_guide,
            "content_atoms": content_atoms,
        }

    def _generate_rewrite_session_candidate_judge(
        self,
        *,
        benchmark_note: Dict[str, Any],
        product_info: Dict[str, Any],
        rewrite_mode: str,
        sales_intensity: int,
        colloquial_level: int,
        authenticity_level: int,
        real_phrases: Optional[List[str]],
        note_strategy: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        benchmark_text = (
            f"标题：{benchmark_note.get('title', '')}\n"
            f"正文：{benchmark_note.get('desc', '')}\n"
            f"分类：{benchmark_note.get('content_category', '')}\n"
            f"推荐层级：{benchmark_note.get('recommendation_tier', '')}\n"
            f"素材依赖：{benchmark_note.get('material_dependency', '')}\n"
        )
        strategy_text = _format_note_strategy_for_prompt(note_strategy)
        product_usage_constraints = _format_product_usage_constraints(note_strategy)
        product_usage_mode = _get_note_strategy_product_usage_mode(note_strategy)
        product_brief_text = self._build_product_brief(product_info)
        if product_usage_mode == "no_product":
            product_brief_text = "本次产品介入模式为 no_product。产品信息不得进入标题、正文、卡片骨架或策略锚点。"
        product_assist_generation_rule = (
            "- 当前是 product_assist：正文主线仍先讲对标爆点，但最后必须有 1 段自然产品/能力承接；建议只出现 1 次产品名，或用 2-3 个核心能力说明它如何辅助落地，不能完全不接产品。\n"
            if product_usage_mode == "product_assist"
            else ""
        )
        real_phrase_text = "\n".join(f"- {phrase}" for phrase in (real_phrases or [])[:10]) or "- 暂无真实用户表达"
        benchmark_title = str(benchmark_note.get("title") or "").strip()
        strategy_title = str((note_strategy or {}).get("suggestedTitle") or "").strip()
        expression_seed = _build_strategy_expression_seed(product_info, note_strategy, benchmark_note)

        blueprint_prompt = f"""你是小红书内容总编。请完成【写作蓝图与候选路线任务】，不要写完整正文。

【对标笔记】
{benchmark_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【改写模式】
{rewrite_mode}

【策略表达校准参考】
{json.dumps(expression_seed, ensure_ascii=False, indent=2)}

任务：
1. 先给出表达契约：判断表达类型、读者身份、产品角色、标题风格、正文取舍规则。
2. 再拆内容原子：把策略和产品信息拆成可编排的痛点、判断、动作、结果、产品承接、结尾。
3. 生成 3 条候选写作路线。注意这里只选路线，不写完整正文；每条路线只给标题候选、开头钩子、正文骨架、产品承接、结尾方式和风险。
4. 三条路线必须明显不同：至少在开头钩子、结构推进、产品出现位置、互动收束里有 3 项不同。
5. 标题候选必须天然能控制在 20 字以内；正文路线必须天然能写成 850-960 字，不依赖最后硬截断。
6. 必须根据【当前已选笔记策略】和【产品 brief】判断产品类别与表达语境；只能决定“怎么写”，不能改写策略决定的主题、人群、痛点、结构方向和产品介入边界。
7. 不要把某一类产品的写法硬套给另一类产品：内容工具不要写成私域经营复盘，私域/SCRM不要写成普通效率工具种草。

请输出严格 JSON：
{{
  "expression_contract": {{
    "content_type": "内容表达类型",
    "product_category": "产品/策略表达类别，例如 私域/SCRM/B2B运营、内容工具/写作效率、学习翻译工具、消费种草等",
    "reader_identity": "这篇要像谁在写给谁看",
    "must_keep": ["必须保留的表达资产"],
    "avoid": ["必须避免的问题"],
    "structure_units": ["本篇应该保留的结构单元，不要求平均分配篇幅"],
    "writing_structure": "正文应该采用的结构节奏，例如真实工作流/问题诊断/前后对比/步骤清单/案例复盘",
    "product_role": "产品在正文中的角色和边界",
    "title_style": "标题应该使用的产品语境、钩子类型和避免方向",
    "emoji_style": "适合当前产品类别的 emoji 语义规则",
    "tag_style": "适合当前产品类别的发布标签方向",
    "title_requirements": ["标题应该保留什么关键词/价值"],
    "quality_bar": ["最终正文必须达到的表达质量标准"]
  }},
  "content_atoms": [
    {{"role": "pain_point/judgment/action/result/proof/product_bridge/closing", "text": "内容原子", "priority": 1, "why_keep": "为什么值得保留"}}
  ],
  "compression_rules": ["哪些信息可以合并、删减或降级"],
  "route_candidates": [
    {{
      "variant": "路线名称",
      "title_candidates": ["3个20字以内标题方向"],
      "opening_hook": "开头怎么起",
      "content_outline": ["4-6个正文推进点"],
      "product_bridge": "产品在哪个位置以什么身份出现",
      "closing": "结尾互动或行动引导",
      "rationale": "这条路线为什么可能更好",
      "risk": "这条路线最容易写坏的点"
    }}
  ]
}}
"""
        blueprint = self._normalize_json_object(
            self._call_json(blueprint_prompt, temperature=0.42, max_tokens=3200),
            stage="candidate_blueprint_routes",
        )
        contract = blueprint.get("expression_contract") if isinstance(blueprint.get("expression_contract"), dict) else {}
        if not contract:
            contract_keys = [
                "content_type",
                "product_category",
                "reader_identity",
                "must_keep",
                "avoid",
                "structure_units",
                "writing_structure",
                "product_role",
                "title_style",
                "emoji_style",
                "tag_style",
                "title_requirements",
                "quality_bar",
            ]
            contract = {key: blueprint.get(key) for key in contract_keys if key in blueprint}
        dynamic_style_guide = _build_dynamic_xhs_style_guide(contract, expression_seed)
        content_atoms = blueprint.get("content_atoms") if isinstance(blueprint.get("content_atoms"), list) else []
        atoms_payload = {
            "content_atoms": content_atoms,
            "compression_rules": blueprint.get("compression_rules") if isinstance(blueprint.get("compression_rules"), list) else [],
        }

        raw_routes = (
            blueprint.get("route_candidates")
            or blueprint.get("candidate_routes")
            or blueprint.get("routes")
            or []
        )
        route_candidates: List[Dict[str, Any]] = []
        if isinstance(raw_routes, list):
            for index, item in enumerate(raw_routes[:3]):
                if not isinstance(item, dict):
                    continue
                route_text = "\n".join([
                    str(item.get("variant") or ""),
                    str(item.get("opening_hook") or ""),
                    "；".join(str(part) for part in (item.get("content_outline") or []) if str(part).strip()) if isinstance(item.get("content_outline"), list) else str(item.get("content_outline") or ""),
                    str(item.get("product_bridge") or ""),
                    str(item.get("closing") or ""),
                    str(item.get("rationale") or ""),
                ])
                titles = _rank_publish_title_candidates(
                    item.get("title_candidates") or item.get("titles") or [item.get("title")],
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    body=route_text,
                    product_info=product_info,
                    fallback=[strategy_title, benchmark_title],
                )
                outline = item.get("content_outline") if isinstance(item.get("content_outline"), list) else []
                route_candidates.append({
                    "index": index,
                    "variant": str(item.get("variant") or f"候选路线{index + 1}").strip(),
                    "title_candidates": titles,
                    "opening_hook": str(item.get("opening_hook") or "").strip(),
                    "content_outline": [str(part).strip() for part in outline if str(part).strip()][:6],
                    "product_bridge": str(item.get("product_bridge") or "").strip(),
                    "closing": str(item.get("closing") or "").strip(),
                    "rationale": str(item.get("rationale") or "").strip(),
                    "risk": str(item.get("risk") or "").strip(),
                })

        if not route_candidates:
            fallback_outline = contract.get("structure_units") if isinstance(contract.get("structure_units"), list) else []
            route_candidates = [{
                "index": 0,
                "variant": str(contract.get("content_type") or "策略主线").strip() or "策略主线",
                "title_candidates": _rank_publish_title_candidates(
                    [strategy_title, benchmark_title],
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    product_info=product_info,
                ),
                "opening_hook": str((contract.get("must_keep") or [""])[0] if isinstance(contract.get("must_keep"), list) else "").strip(),
                "content_outline": [str(part).strip() for part in fallback_outline if str(part).strip()][:6],
                "product_bridge": str(contract.get("product_role") or "").strip(),
                "closing": "给读者一个自查或评论互动问题",
                "rationale": "模型未返回候选路线，已用表达契约构造保底路线。",
                "risk": "路线多样性不足",
            }]

        route_judge_prompt = f"""你是小红书选题主编。请完成【候选路线裁判任务】，从候选路线中选择最适合写成高质量发布稿的一条。

【表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【内容原子】
{json.dumps(atoms_payload, ensure_ascii=False, indent=2)}

【对标笔记】
{benchmark_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【真实用户表达优先词库】
{real_phrase_text}

{dynamic_style_guide}

【候选路线】
{json.dumps(route_candidates, ensure_ascii=False, indent=2)}

裁判标准：
1. 选择最能稳定写成 850-960 字完整正文的路线，不选需要大量硬压缩的路线。
2. 标题方向必须天然能落在 20 字以内，且有场景/痛点/结果感。
3. 路线必须贴合表达契约和产品介入边界，product_assist 不能写成功能教程，no_product 不能出现产品信息。
4. 优先选择能把功能翻译成场景、判断、业务结果的路线。
5. 不要只选最像说明书的路线；要像真人经验、诊断或教程，而不是产品功能列表。
6. 这一步仍然不要写完整正文，只做路线选择和标题方向校准。

请输出严格 JSON：
{{
  "selected_index": 0,
  "title_candidates": ["3-5个20字以内最终标题方向"],
  "needs_attention": false,
  "attention_points": ["成稿时最需要避免的问题"],
  "scores": [
    {{"index": 0, "total": 0, "title": 0, "strategy_fit": 0, "publishability": 0, "risk": "主要风险"}}
  ],
  "reasoning_summary": "一句话说明为什么选择这条路线"
}}
"""
        judge = self._normalize_json_object(
            self._call_json(route_judge_prompt, temperature=0.2, max_tokens=1300),
            stage="candidate_route_judge",
        )
        try:
            selected_index = int(judge.get("selected_index", 0))
        except (TypeError, ValueError):
            selected_index = 0
        if selected_index >= len(route_candidates) and selected_index - 1 < len(route_candidates):
            selected_index -= 1
        selected_index = min(max(0, selected_index), len(route_candidates) - 1)
        selected_route = dict(route_candidates[selected_index])
        judge_titles = _rank_publish_title_candidates(
            judge.get("title_candidates"),
            benchmark_title=benchmark_title,
            strategy_title=strategy_title,
            body="\n".join([
                str(selected_route.get("opening_hook") or ""),
                "；".join(selected_route.get("content_outline") or []),
                str(selected_route.get("product_bridge") or ""),
            ]),
            product_info=product_info,
            fallback=selected_route.get("title_candidates"),
        )

        draft_prompt = f"""你是资深小红书主编。请基于已选路线写出一篇完整、可直接发布的小红书正文。

【表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【内容原子】
{json.dumps(atoms_payload, ensure_ascii=False, indent=2)}

【已选路线】
{json.dumps(selected_route, ensure_ascii=False, indent=2)}

【路线裁判意见】
{json.dumps(judge, ensure_ascii=False, indent=2)}

【对标笔记】
{benchmark_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【真实用户表达优先词库】
{real_phrase_text}

{dynamic_style_guide}

【参数】
- 销售感强弱：{sales_intensity}/100
- 口语化程度：{colloquial_level}/100
- 真实体验感：{authenticity_level}/100

硬性要求：
1. `final_title` 和 `title_candidates` 每条都必须 20 字以内，不能生硬截断，优先保留场景、痛点、结果或搜索关键词。
2. `body` 必须一次写成 850-960 字的完整发布稿，绝对不能超过 1000 字；结尾必须是完整句。
3. 不要写 3 篇候选稿，只写已选路线的一篇完整稿。
4. {XHS_BODY_LAYOUT_GUIDE}
5. 不要把策略里的结构单元机械翻译成一堆 ✅ 功能清单。每个动作都要解释“为什么重要/解决什么问题/带来什么结果”。
6. 保留符合产品语境的自然 emoji 节奏，建议 4-7 个；不要大量堆 ✅。
7. 严格遵守产品介入边界：{product_usage_mode or "按策略自然处理"}。
{product_assist_generation_rule}8. 不要输出 Markdown，不要解释过程。

请输出严格 JSON：
{{
  "final_title": "20字以内最终标题",
  "title_candidates": ["3-5个20字以内候选标题"],
  "body": "850-960字完整正文，保留小红书换行和空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "rationale": "一句话说明为什么这篇贴合策略"
}}
"""
        draft_payload = self._normalize_json_object(
            self._call_json(draft_prompt, temperature=0.68, max_tokens=2800),
            stage="candidate_selected_route_draft",
        )
        draft_body = str(
            draft_payload.get("body")
            or draft_payload.get("content")
            or draft_payload.get("final_body")
            or ""
        ).strip()
        draft_body, draft_tags = _strip_trailing_hashtag_block(draft_body, draft_payload.get("tags", []))
        draft_body = _strip_placeholder_tail(draft_body)
        selected_before_repair = {
            "body": draft_body,
            "title_candidates": _rank_publish_title_candidates(
                [
                    draft_payload.get("final_title"),
                    *(draft_payload.get("title_candidates") if isinstance(draft_payload.get("title_candidates"), list) else []),
                ],
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                body=draft_body,
                product_info=product_info,
                fallback=[*judge_titles, *selected_route.get("title_candidates", [])],
            ),
            "tags": draft_tags,
            "rationale": str(draft_payload.get("rationale") or "").strip(),
        }

        final_body = draft_body
        final_body, final_limit_notes = _finalize_publish_body_limit(final_body)
        emoji_style_profile = {**expression_seed, **contract}
        final_body, emoji_layout_notes = _polish_xhs_emoji_layout(final_body, style_profile=emoji_style_profile)
        if emoji_layout_notes:
            final_body, post_emoji_limit_notes = _finalize_publish_body_limit(final_body)
            final_limit_notes = [*final_limit_notes, *emoji_layout_notes, *post_emoji_limit_notes]
        final_titles = _rank_publish_title_candidates(
            selected_before_repair.get("title_candidates"),
            benchmark_title=benchmark_title,
            strategy_title=strategy_title,
            body=final_body,
            product_info=product_info,
            fallback=[*judge_titles, *selected_route.get("title_candidates", []), strategy_title, benchmark_title],
        )
        final_titles = [title for title in final_titles if len(title) <= XHS_TITLE_MAX_CHARS]
        final_tags = _derive_publish_tags(
            title=final_titles[0] if final_titles else "",
            body=final_body,
            product_info=product_info,
            benchmark_note=benchmark_note,
            note_strategy=note_strategy,
            existing_tags=[*draft_tags, *(expression_seed.get("tag_hints") or [])],
        )
        def collect_final_flags(body: str, titles: List[str]) -> List[str]:
            flags = _body_publish_quality_flags(
                body,
                title_candidates=titles,
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                product_usage_mode=product_usage_mode,
                product_info=product_info,
            )
            if self._is_likely_incomplete_xhs_body(body, min_chars=520):
                flags.append("body_incomplete_or_too_short")
            if _is_structurally_incomplete_publish_body(
                body,
                selected_route=selected_route,
                contract=contract,
                note_strategy=note_strategy,
            ):
                flags.append("body_incomplete_or_too_short")
            if not titles:
                flags.append("title_missing_or_over_limit")
            return list(dict.fromkeys(flags))

        final_flags = collect_final_flags(final_body, final_titles)

        needs_repair = bool(final_flags)
        repair_notes: List[str] = []
        if needs_repair:
            repair_prompt = f"""你是小红书【候选路线返修编辑器】。请只修复系统指出的问题，不要推翻已选路线。

【表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【已选路线】
{json.dumps(selected_route, ensure_ascii=False, indent=2)}

【路线裁判意见】
{json.dumps(judge, ensure_ascii=False, indent=2)}

【当前成稿】
标题候选：{json.dumps(final_titles or selected_before_repair.get("title_candidates") or judge_titles, ensure_ascii=False)}
正文：
{final_body}

【系统质量标记】
{final_flags}

{dynamic_style_guide}

返修要求：
1. 标题候选每条必须 20 字以内，不能生硬截断。
2. 正文必须 850-960 字，绝对不超过 1000 字；如果当前正文太短，要补足场景、判断和产品承接；如果太长，要自然压缩。
3. 结尾必须完整收束，不能像残稿，不能以逗号、冒号、顿号结尾。
4. 保留已选路线的核心结构，但允许合并裸清单、重排句子、删低价值功能点。
5. 把“功能是什么”改成“为什么重要/解决什么问题/带来什么结果”。
6. 如果系统标记包含 layout_too_plain 或 emoji_style_weak，要按上面的策略表达执行规则补回 4-7 个自然 emoji；不要堆成裸 ✅ 清单。
7. 严格遵守产品介入边界：{product_usage_mode or "按策略自然处理"}。
{product_assist_generation_rule}

请输出严格 JSON：
{{
  "title_candidates": ["3个20字以内标题"],
  "body": "返修后的850-960字完整正文，保留小红书换行和空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "repair_notes": ["具体修了什么"]
}}
"""
            repaired = self._normalize_json_object(
                self._call_json(repair_prompt, temperature=0.35, max_tokens=2800),
                stage="candidate_selected_route_repair",
            )
            repaired_body = str(repaired.get("body") or "").strip()
            repaired_body, repaired_tags = _strip_trailing_hashtag_block(repaired_body, repaired.get("tags", final_tags))
            repaired_body = _strip_placeholder_tail(repaired_body)
            if repaired_body:
                repaired_body, repaired_limit_notes = _finalize_publish_body_limit(repaired_body)
                repaired_body, repaired_emoji_notes = _polish_xhs_emoji_layout(repaired_body, style_profile=emoji_style_profile)
                if repaired_emoji_notes:
                    repaired_body, repaired_post_emoji_notes = _finalize_publish_body_limit(repaired_body)
                    repaired_limit_notes = [*repaired_limit_notes, *repaired_emoji_notes, *repaired_post_emoji_notes]
                final_body = repaired_body
                final_titles = _rank_publish_title_candidates(
                    repaired.get("title_candidates"),
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    body=repaired_body,
                    product_info=product_info,
                    fallback=[*final_titles, *judge_titles, *selected_route.get("title_candidates", [])],
                )
                final_titles = [title for title in final_titles if len(title) <= XHS_TITLE_MAX_CHARS]
                final_tags = _derive_publish_tags(
                    title=final_titles[0] if final_titles else "",
                    body=final_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                    note_strategy=note_strategy,
                    existing_tags=[*repaired_tags, *(expression_seed.get("tag_hints") or [])],
                )
                repair_notes = [str(item).strip() for item in (repaired.get("repair_notes") or []) if str(item).strip()] if isinstance(repaired.get("repair_notes"), list) else []
                final_limit_notes = [*final_limit_notes, *repaired_limit_notes]

        if not final_titles:
            fitted = self._fit_to_xhs_publish_limits(
                title_candidates=selected_before_repair.get("title_candidates") or judge_titles or [strategy_title, benchmark_title],
                body=final_body,
                product_info=product_info,
                note_strategy="\n".join([strategy_text, json.dumps(contract, ensure_ascii=False)]),
            )
            final_body = _strip_placeholder_tail(str(fitted.get("body") or final_body).strip())
            final_titles = _rank_publish_title_candidates(
                fitted.get("title_candidates"),
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                body=final_body,
                product_info=product_info,
                fallback=final_titles,
            )
            final_titles = [title for title in final_titles if len(title) <= XHS_TITLE_MAX_CHARS]
            final_limit_notes = [*final_limit_notes, *(fitted.get("notes") or [])]
        if not final_titles:
            final_titles = _normalize_title_candidates(["发布标题"])

        final_flags = collect_final_flags(final_body, final_titles)
        hard_final_flags = {
            "empty_body",
            "body_over_limit",
            "body_incomplete_or_too_short",
            "title_missing_or_over_limit",
            "product_assist_missing_bridge",
        }
        if any(flag in hard_final_flags for flag in final_flags):
            pre_guard_body = final_body
            pre_guard_titles = list(final_titles)
            pre_guard_tags = list(final_tags)
            final_guard_prompt = f"""你是小红书发布前最后守门编辑。当前稿件仍有硬性发布问题，请只修复硬问题，不要推翻已选路线。

【表达契约】
{json.dumps(contract, ensure_ascii=False, indent=2)}

【已选路线】
{json.dumps(selected_route, ensure_ascii=False, indent=2)}

【当前标题候选】
{json.dumps(final_titles or selected_before_repair.get("title_candidates") or judge_titles, ensure_ascii=False)}

【当前正文】
{final_body}

【硬性问题】
{final_flags}

要求：
1. 标题候选每条必须 20 字以内，必须保留场景、痛点或结果感，不能只写泛标题。
2. 正文必须是完整发布稿，建议 850-960 字，绝对不超过 1000 字。
3. 如果当前正文太短，必须补足具体场景、判断、动作、产品承接和完整收束；不要只续写几句。
4. 如果当前正文太长，必须自然压缩到完整句结尾，不能硬截断。
5. 保留小红书空行分段和自然 emoji 节奏，结尾必须是完整句。
{product_assist_generation_rule}

请输出严格 JSON：
{{
  "title_candidates": ["3个20字以内标题"],
  "body": "850-960字完整正文，保留小红书换行和空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "repair_notes": ["具体修了哪些硬问题"]
}}
"""
            final_guard = self._normalize_json_object(
                self._call_json(final_guard_prompt, temperature=0.28, max_tokens=2800),
                stage="candidate_final_guard_repair",
            )
            guarded_body = str(final_guard.get("body") or "").strip()
            guarded_body, guarded_tags = _strip_trailing_hashtag_block(guarded_body, final_guard.get("tags", final_tags))
            guarded_body = _strip_placeholder_tail(guarded_body)
            if guarded_body:
                guarded_body, guarded_limit_notes = _finalize_publish_body_limit(guarded_body)
                guarded_body, guarded_emoji_notes = _polish_xhs_emoji_layout(guarded_body, style_profile=emoji_style_profile)
                if guarded_emoji_notes:
                    guarded_body, guarded_post_emoji_notes = _finalize_publish_body_limit(guarded_body)
                    guarded_limit_notes = [*guarded_limit_notes, *guarded_emoji_notes, *guarded_post_emoji_notes]
                final_body = guarded_body
                final_titles = _rank_publish_title_candidates(
                    final_guard.get("title_candidates"),
                    benchmark_title=benchmark_title,
                    strategy_title=strategy_title,
                    body=final_body,
                    product_info=product_info,
                    fallback=[*final_titles, *judge_titles, *selected_route.get("title_candidates", [])],
                )
                final_titles = [title for title in final_titles if len(title) <= XHS_TITLE_MAX_CHARS]
                final_tags = _derive_publish_tags(
                    title=final_titles[0] if final_titles else "",
                    body=final_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                    note_strategy=note_strategy,
                    existing_tags=[*guarded_tags, *(expression_seed.get("tag_hints") or [])],
                )
                final_limit_notes = [*final_limit_notes, *guarded_limit_notes]
                guard_notes = [
                    str(item).strip()
                    for item in (final_guard.get("repair_notes") or [])
                    if str(item).strip()
                ] if isinstance(final_guard.get("repair_notes"), list) else []
                repair_notes = [*repair_notes, *guard_notes][:6]
                final_flags = collect_final_flags(final_body, final_titles)

            guarded_flags = collect_final_flags(final_body, final_titles)
            pre_guard_flags = collect_final_flags(pre_guard_body, pre_guard_titles)
            if (
                "body_incomplete_or_too_short" in guarded_flags
                and "body_incomplete_or_too_short" not in pre_guard_flags
            ):
                final_body = pre_guard_body
                final_titles = pre_guard_titles
                final_tags = pre_guard_tags
                final_flags = pre_guard_flags
                repair_notes = [*repair_notes, "最终守门返回短稿，已保留守门前完整稿"][:6]
            else:
                final_flags = guarded_flags

        if product_usage_mode == "product_assist" and "product_assist_missing_bridge" in final_flags:
            bridged_body, bridge_notes = _ensure_product_assist_bridge(final_body, product_info)
            if bridged_body:
                final_body = bridged_body
                final_tags = _derive_publish_tags(
                    title=final_titles[0] if final_titles else "",
                    body=final_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                    note_strategy=note_strategy,
                    existing_tags=[*final_tags, *(expression_seed.get("tag_hints") or [])],
                )
                final_limit_notes = [*final_limit_notes, *bridge_notes]
                final_flags = collect_final_flags(final_body, final_titles)
        if "weak_title" in final_flags and final_titles:
            title_score = _title_publish_quality_score(
                final_titles[0],
                benchmark_title=benchmark_title,
                strategy_title=strategy_title,
                body=final_body,
                product_info=product_info,
            )
            if len(final_titles[0]) <= XHS_TITLE_MAX_CHARS and title_score >= 24:
                final_flags = [flag for flag in final_flags if flag != "weak_title"]
        if len(final_body) > XHS_BODY_MAX_CHARS:
            final_body = _clip_body_to_complete_sentence_limit(final_body, XHS_BODY_SAFE_MAX_CHARS)
            final_flags = [flag for flag in final_flags if flag != "body_over_limit"]
            final_flags.append("body_clipped_to_complete_publish_limit")

        revision_notes = [
            "已启用多路线候选裁判生文链路",
            str(judge.get("reasoning_summary") or "").strip(),
            *repair_notes,
            *final_limit_notes,
            *(f"质量标记：{flag}" for flag in final_flags),
        ]
        revision_notes = [note for note in revision_notes if str(note).strip()][:8]
        outline = selected_route.get("content_outline") or (contract.get("structure_units") if isinstance(contract.get("structure_units"), list) else [])
        if not outline and content_atoms:
            outline = [str(atom.get("text") or "").strip() for atom in content_atoms[:6] if isinstance(atom, dict) and str(atom.get("text") or "").strip()]

        return {
            "benchmark_note": benchmark_note,
            "product_info": product_info,
            "rewrite_mode": rewrite_mode,
            "selected_title": final_titles[0],
            "title_candidates": final_titles,
            "opening_candidates": _split_paragraphs(final_body)[:2],
            "content_outline": outline,
            "body_draft": draft_body,
            "minimal_polish_body": selected_before_repair.get("body", ""),
            "deep_polish_body": final_body if needs_repair else "",
            "polished_body": final_body,
            "final_body": final_body,
            "final_body_source": "candidate_judge",
            "polished_body_fallback_used": False,
            "polish_guardrail_reason": "",
            "guardrail_stage": "candidate_judge",
            "guardrail_repairs_applied": revision_notes[:6],
            "replacement_phrases": [],
            "tags": final_tags,
            "rationale": str(judge.get("reasoning_summary") or selected_before_repair.get("rationale") or selected_route.get("rationale") or "").strip(),
            "de_ai_report": {
                "formula_density": 0,
                "emotion_word_overload": 0,
                "sentence_rhythm_risk": len(self._find_ai_risk_sentences(final_body, real_phrases=real_phrases)),
                "comment_voice_gap": 0,
                "summary": "已通过多路线候选裁判选择，并完成单篇成稿与发布前限长校验。",
            },
            "revision_notes": revision_notes,
            "high_risk_ai_sentences": self._find_ai_risk_sentences(final_body, real_phrases=real_phrases),
            "estimated_engagement": benchmark_note.get("recommendation_tier", "可参考"),
            "candidate_judge_enabled": True,
            "expression_contract": contract,
            "strategy_expression_seed": expression_seed,
            "dynamic_style_guide": dynamic_style_guide,
            "content_atoms": content_atoms[:12],
            "publish_candidates": route_candidates,
            "route_candidates": route_candidates,
            "selected_route": selected_route,
            "candidate_judge_scores": judge.get("scores", []),
            "candidate_judge_quality_flags": final_flags,
        }

    def generate_rewrite_session(
        self,
        benchmark_note: Dict[str, Any],
        product_info: Dict[str, Any],
        rewrite_mode: str = "结构仿写",
        sales_intensity: int = 45,
        colloquial_level: int = 75,
        authenticity_level: int = 80,
        real_phrases: Optional[List[str]] = None,
        note_strategy: Optional[Dict[str, Any]] = None,
        _candidate_judge_attempted: bool = False,
    ) -> Dict[str, Any]:
        if self._candidate_judge_enabled() and not _candidate_judge_attempted:
            try:
                return self._generate_rewrite_session_candidate_judge(
                    benchmark_note=benchmark_note,
                    product_info=product_info,
                    rewrite_mode=rewrite_mode,
                    sales_intensity=sales_intensity,
                    colloquial_level=colloquial_level,
                    authenticity_level=authenticity_level,
                    real_phrases=real_phrases,
                    note_strategy=note_strategy,
                )
            except Exception as error:
                fallback_session = self.generate_rewrite_session(
                    benchmark_note=benchmark_note,
                    product_info=product_info,
                    rewrite_mode=rewrite_mode,
                    sales_intensity=sales_intensity,
                    colloquial_level=colloquial_level,
                    authenticity_level=authenticity_level,
                    real_phrases=real_phrases,
                    note_strategy=note_strategy,
                    _candidate_judge_attempted=True,
                )
                fallback_session["candidate_judge_enabled"] = True
                fallback_session["candidate_judge_fallback_reason"] = f"多候选裁判链路失败，已回退旧链路：{error}"
                fallback_session["guardrail_repairs_applied"] = [
                    fallback_session["candidate_judge_fallback_reason"],
                    *(fallback_session.get("guardrail_repairs_applied") or []),
                ][:8]
                return fallback_session

        benchmark_text = (
            f"标题：{benchmark_note.get('title', '')}\n"
            f"正文：{benchmark_note.get('desc', '')}\n"
            f"分类：{benchmark_note.get('content_category', '')}\n"
            f"推荐层级：{benchmark_note.get('recommendation_tier', '')}\n"
            f"素材依赖：{benchmark_note.get('material_dependency', '')}\n"
        )
        real_phrase_text = "\n".join(f"- {phrase}" for phrase in (real_phrases or [])[:10]) or "- 暂无真实用户表达"
        strategy_text = _format_note_strategy_for_prompt(note_strategy)
        product_usage_constraints = _format_product_usage_constraints(note_strategy)
        product_usage_mode = _get_note_strategy_product_usage_mode(note_strategy)
        product_brief_text = self._build_product_brief(product_info)
        if product_usage_mode == "no_product":
            product_brief_text = "本次产品介入模式为 no_product。产品信息不得进入标题、正文、卡片骨架或策略锚点。"
        strategy_anchor_terms = [
            term for term in _extract_strategy_anchor_terms(note_strategy)
            if not _is_placeholder_text(term)
        ]
        structure_anchor_instruction = _format_strategy_anchor_instruction(
            strategy_anchor_terms,
            required=bool(strategy_anchor_terms),
            target="骨架",
        )
        draft_anchor_instruction = _format_strategy_anchor_instruction(
            strategy_anchor_terms,
            required=bool(strategy_anchor_terms),
            target="正文",
        )
        polish_anchor_instruction = _format_strategy_anchor_instruction(
            strategy_anchor_terms,
            required=bool(strategy_anchor_terms) and product_usage_mode != "no_product",
            target="正文",
        )
        no_product_structure_instruction = (
            "如果产品介入约束是 no_product，则上一句中的“策略锚点词”要求自动失效，标题框架和正文骨架不得出现产品名、功能、卖点和目标人群。"
            if product_usage_mode == "no_product"
            else ""
        )
        draft_product_usage_instruction = (
            "- 如果产品介入约束是 no_product，不得出现产品名、功能、卖点和目标人群；如果是 product_assist，产品只可轻带，不能每一步都写成功能。"
            if product_usage_mode in {"no_product", "product_assist"}
            else ""
        )
        minimal_product_usage_instruction = (
            "10. 如果产品介入约束是 no_product，则第 3 条的产品名和核心卖点保留要求不适用，且不得新增产品信息；如果是 product_assist，不得把轻带内容扩写成产品教程。\n"
            if product_usage_mode in {"no_product", "product_assist"}
            else ""
        )
        minimal_anchor_instruction = (
            f"11. 如果产品介入约束不是 no_product，{polish_anchor_instruction}"
            if product_usage_mode in {"no_product", "product_assist"}
            else f"10. {polish_anchor_instruction}"
        )
        deep_product_preserve_instruction = (
            "3. 如果产品介入约束是 no_product，则不得新增产品名、功能、卖点和目标人群；如果是 product_assist，不得把轻带内容扩写成产品教程。"
            if product_usage_mode in {"no_product", "product_assist"}
            else "3. 产品名、核心卖点、CTA、标签语义必须保留。"
        )

        structure_prompt = f"""你是小红书内容总编，请先做“结构迁移”，不要直接写最终文案。

【对标笔记】
{benchmark_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【改写模式】
{rewrite_mode}

{XHS_TITLE_QUALITY_GUIDE}

请输出严格 JSON：
{{
  "title_frameworks": ["3个标题框架"],
  "opening_hooks": ["3个开头钩子"],
  "content_outline": ["3-5个正文段落骨架"],
  "ending_options": ["2-3个结尾互动方式"],
  "rewrite_strategy": "50字内说明应该保留什么、替换什么"
}}

注意：后续标题必须能自然落在 20 字以内，并且要像小红书标题而不是产品功能概括；正文最终必须自然落在 1000 字以内，所以结构骨架要优先保留高价值信息，避免设计过多铺垫段。
如果【当前已选笔记策略】不为空，它是本次正文主线，必须优先于通用对标仿写；{structure_anchor_instruction}
{no_product_structure_instruction}
"""
        structure = self._normalize_json_object(
            self._call_json(structure_prompt, temperature=0.4, max_tokens=1600),
            stage="structure_generation",
        )

        draft_prompt = f"""你是资深小红书操盘手，请根据下面的结构骨架产出一版“可发前主稿”。

【对标笔记】
{benchmark_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【产品 brief】
{product_brief_text}

【结构骨架】
{json.dumps(structure, ensure_ascii=False, indent=2)}

【真实用户表达优先词库】
{real_phrase_text}

【参数】
- 销售感强弱：{sales_intensity}/100
- 口语化程度：{colloquial_level}/100
- 真实体验感：{authenticity_level}/100

要求：排版必须符合小红书风格，每段和关键短句应当使用符合语境的 emoji 表情（如✨🔥💡✅👇等）来提升视觉吸引力和阅读节奏感。
{XHS_TITLE_QUALITY_GUIDE}
排版要求：
- 正文必须有空行分段，建议 4-8 个自然段。
- 清单项、✅/✨/👉 这类提示符要单独成行。
- 不要把全文写成一个大段落。
发布长度硬约束：
- 标题候选每条必须控制在 20 字以内（含 emoji）。
- 3 个标题要有差异：至少覆盖“痛点切入 / 反差观点 / 结果收益”中的两类。
- 正文主稿必须控制在 900-980 字之间，绝对不能超过 1000 字。
- 如果信息很多，优先保留策略、人群、核心卖点和行动引导，删掉重复铺垫和泛泛解释。
- 如果当前策略含有 618、双11、开学季、年终等活动/时间节点，标题或正文前 2 段必须自然出现这些词，不能只写泛泛痛点。
- {draft_anchor_instruction}
{draft_product_usage_instruction}

请输出严格 JSON：
{{
  "title_candidates": ["3个标题"],
  "opening_candidates": ["3个开头"],
  "body_draft": "正文主稿",
  "replacement_phrases": ["5-8条可替换表达"],
  "tags": ["5个标签"],
  "rationale": "简要说明这版为什么更适合当前产品"
}}
"""
        draft = self._normalize_json_object(
            self._call_json(draft_prompt, temperature=0.75, max_tokens=2400),
            stage="draft_generation",
        )
        draft["title_candidates"] = _normalize_title_candidates(
            draft.get("title_candidates"),
            structure.get("title_frameworks"),
        )
        body_draft = str(draft.get("body_draft", "") or "").strip()
        body_draft, draft["tags"] = _strip_trailing_hashtag_block(body_draft, draft.get("tags", []))
        draft["body_draft"] = body_draft
        guardrail_repairs_applied: List[str] = []

        minimal_polish_prompt = f"""你是“去 AI 味轻改编辑器”。请只做最小改写，优先保留正文结构和信息密度。

【对标笔记】
{benchmark_text}

【产品 brief】
{product_brief_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【真实用户表达优先词库】
{real_phrase_text}

【待处理内容】
{json.dumps(draft, ensure_ascii=False, indent=2)}

硬性要求：
1. 只改高风险 AI 句、口头禅、公式化表达，不要重写整篇。
2. 必须保留原段落顺序，段落数不能减少。
3. 产品名、核心卖点、行动号召、标签语义必须保留。
4. 如果某句需要变自然，请逐句改写，不允许省略信息。
5. 不允许压缩成摘要，不允许删减事实和场景。
6. 保留并适度增加符合小红书语境的 emoji 表情，提升阅读节奏感和排版美观度。
7. `minimal_polish_body` 不允许与 `body_draft` 完全相同；至少调整 5 处书面词、模板词或长句节奏。
8. `minimal_polish_body` 必须控制在 1000 字以内，推荐 900-980 字；不得为了润色把正文写长。
9. 必须保留空行分段和清单独立成行，不要压成一个大段落。
{minimal_product_usage_instruction}{minimal_anchor_instruction}

请输出严格 JSON：
{{
  "minimal_polish_body": "轻改后的正文",
  "polished_openings": ["优化后的开头"],
  "de_ai_report": {{
    "formula_density": 0,
    "emotion_word_overload": 0,
    "sentence_rhythm_risk": 0,
    "comment_voice_gap": 0,
    "summary": "一句话说明主要改了什么"
  }},
  "revision_notes": ["3-5条轻改点"],
  "high_risk_ai_sentences": ["仍然偏 AI 的句子"]
}}
"""
        try:
            minimal_polish = self._normalize_json_object(
                self._call_json(minimal_polish_prompt, temperature=0.2, max_tokens=2200),
                stage="minimal_de_ai_polish",
            )
        except Exception as error:
            safe_polish_body, safe_polish_notes = _build_safe_minimal_polish(body_draft)
            minimal_polish = {
                "minimal_polish_body": safe_polish_body or body_draft,
                "polished_openings": draft.get("opening_candidates", []),
                "de_ai_report": {
                    "summary": f"模型轻改失败，已启用保结构安全轻改：{error}",
                },
                "revision_notes": safe_polish_notes or ["模型轻改失败，已启用保结构安全轻改"],
                "high_risk_ai_sentences": self._find_ai_risk_sentences(safe_polish_body or body_draft, real_phrases=real_phrases),
            }
            guardrail_repairs_applied.extend(minimal_polish["revision_notes"][:6])

        minimal_polish_body = minimal_polish.get("minimal_polish_body") or minimal_polish.get("polished_body") or body_draft
        minimal_polish_body, draft["tags"] = _strip_trailing_hashtag_block(minimal_polish_body, draft.get("tags", []))
        minimal_polish_body = _strip_placeholder_tail(minimal_polish_body)
        minimal_polish["minimal_polish_body"] = minimal_polish_body
        if not _body_has_meaningful_change(
            body_draft,
            minimal_polish_body,
            min_ratio=0.015,
            min_changed_chars=18,
        ):
            safe_polish_body, safe_polish_notes = _build_safe_minimal_polish(body_draft)
            if _body_has_visible_change(body_draft, safe_polish_body):
                minimal_polish_body = safe_polish_body
                guardrail_note = "模型轻改与主稿过于接近，已启用保结构安全轻改"
                minimal_polish["revision_notes"] = [
                    guardrail_note,
                    *(safe_polish_notes or []),
                    *(minimal_polish.get("revision_notes") or []),
                ][:6]
                minimal_polish.setdefault("de_ai_report", {})
                minimal_polish["de_ai_report"]["summary"] = guardrail_note
        minimal_guardrail_ok, minimal_guardrail_reason = _evaluate_polished_body(
            body_draft=draft.get("body_draft", ""),
            polished_body=minimal_polish_body,
            product_info=product_info,
            benchmark_note=benchmark_note,
            tags=draft.get("tags", []),
            minimum_ratio=0.78,
            max_paragraph_drop=0,
            missing_term_threshold=3,
            enforce_tag_semantics=False,
        )
        if not minimal_guardrail_ok:
            minimal_polish_body, minimal_repairs = _repair_body_with_draft(
                body_draft=body_draft,
                candidate_body=minimal_polish_body,
                product_info=product_info,
                benchmark_note=benchmark_note,
            )
            guardrail_repairs_applied.extend(minimal_repairs)
            minimal_guardrail_ok, minimal_guardrail_reason = _evaluate_polished_body(
                body_draft=body_draft,
                polished_body=minimal_polish_body,
                product_info=product_info,
                benchmark_note=benchmark_note,
                tags=draft.get("tags", []),
                minimum_ratio=0.78,
                max_paragraph_drop=0,
                missing_term_threshold=3,
                enforce_tag_semantics=False,
            )
        if not minimal_guardrail_ok:
            safe_polish_body, safe_polish_notes = _build_safe_minimal_polish(body_draft)
            safe_guardrail_ok, safe_guardrail_reason = _evaluate_polished_body(
                body_draft=body_draft,
                polished_body=safe_polish_body,
                product_info=product_info,
                benchmark_note=benchmark_note,
                tags=draft.get("tags", []),
                minimum_ratio=0.78,
                max_paragraph_drop=0,
                missing_term_threshold=3,
                enforce_tag_semantics=False,
            )
            if safe_guardrail_ok:
                guardrail_repairs_applied.extend(safe_polish_notes or ["启用保结构安全轻改"])
                minimal_polish_body = safe_polish_body
                minimal_guardrail_ok = True
                minimal_guardrail_reason = ""
                minimal_polish["revision_notes"] = [
                    *(minimal_polish.get("revision_notes") or []),
                    *(safe_polish_notes or ["启用保结构安全轻改"]),
                ][:6]
                minimal_polish.setdefault("de_ai_report", {})
                minimal_polish["de_ai_report"]["summary"] = "模型轻改未通过完整性保护，已启用保结构安全轻改。"
                minimal_polish["high_risk_ai_sentences"] = self._find_ai_risk_sentences(
                    minimal_polish_body,
                    real_phrases=real_phrases,
                )
            else:
                minimal_guardrail_reason = minimal_guardrail_reason or safe_guardrail_reason

        minimal_risk_sentences = minimal_polish.get("high_risk_ai_sentences") or self._find_ai_risk_sentences(minimal_polish_body, real_phrases=real_phrases)
        should_run_deep_polish = minimal_guardrail_ok
        should_prefer_deep_polish = len(minimal_risk_sentences) >= 2

        deep_polish: Dict[str, Any] = {}
        deep_polish_body = ""
        deep_guardrail_ok = False
        deep_guardrail_reason = ""

        if should_run_deep_polish:
            deep_polish_prompt = f"""你是“去 AI 味深改编辑器”。请在轻改稿基础上继续提升真人感，但仍然必须保留完整信息。

【对标笔记】
{benchmark_text}

【产品 brief】
{product_brief_text}

【当前已选笔记策略】
{strategy_text}

{product_usage_constraints}

【真实用户表达优先词库】
{real_phrase_text}

【正文主稿】
{body_draft}

【当前轻改版】
{minimal_polish_body}

硬性要求：
1. 可以优化语序、节奏和真人感，但不能删掉有效信息。
2. 必须保留主要段落结构，段落数最多只允许轻微变化。
{deep_product_preserve_instruction}
4. 优先做自然化润色，不要写成摘要或短评。
5. 保留并适度增加符合小红书语境的 emoji 表情，提升阅读节奏感和排版美观度。
6. `deep_polish_body` 必须明显区别于【当前轻改版】，但不能比正文主稿少太多信息。
7. `deep_polish_body` 必须控制在 1000 字以内，推荐 900-980 字；优先压缩重复铺垫，不要删核心卖点。
8. 必须保留空行分段和清单独立成行，不要压成一个大段落。
9. {polish_anchor_instruction}

请输出严格 JSON：
{{
  "deep_polish_body": "深改后的正文",
  "polished_openings": ["优化后的开头"],
  "de_ai_report": {{
    "formula_density": 0,
    "emotion_word_overload": 0,
    "sentence_rhythm_risk": 0,
    "comment_voice_gap": 0,
    "summary": "一句话说明深改做了什么"
  }},
  "revision_notes": ["3-5条深改点"],
  "high_risk_ai_sentences": ["仍然偏 AI 的句子"]
}}
"""
            try:
                deep_polish = self._normalize_json_object(
                    self._call_json(deep_polish_prompt, temperature=0.35, max_tokens=2200),
                    stage="deep_de_ai_polish",
                )
                deep_polish_body = deep_polish.get("deep_polish_body") or deep_polish.get("polished_body") or minimal_polish_body
                deep_polish_body, draft["tags"] = _strip_trailing_hashtag_block(deep_polish_body, draft.get("tags", []))
                deep_polish_body = _strip_placeholder_tail(deep_polish_body)
                deep_polish["deep_polish_body"] = deep_polish_body
            except Exception as error:
                deep_polish = {}
                deep_polish_body = ""
                deep_guardrail_reason = f"深改模型失败，已保留轻改版：{error}"
                guardrail_repairs_applied.append(deep_guardrail_reason)
            if not _body_has_meaningful_change(
                minimal_polish_body,
                deep_polish_body,
                min_ratio=0.06,
                min_changed_chars=60,
            ):
                safe_deep_body, safe_deep_notes = _build_safe_deep_polish(body_draft, minimal_polish_body)
                if _body_has_meaningful_change(
                    minimal_polish_body,
                    safe_deep_body,
                    min_ratio=0.035,
                    min_changed_chars=40,
                ):
                    deep_polish_body = safe_deep_body
                    deep_polish = {
                        **deep_polish,
                        "revision_notes": [
                            *(safe_deep_notes or []),
                            *(deep_polish.get("revision_notes") or []),
                        ][:6],
                    }
                    deep_polish.setdefault("de_ai_report", {})
                    deep_polish["de_ai_report"]["summary"] = "模型深改与轻改过近，已启用保信息差异化深改。"
                    guardrail_repairs_applied.extend(safe_deep_notes or ["启用保信息差异化深改"])
                else:
                    deep_polish_body = ""
                    deep_guardrail_reason = deep_guardrail_reason or "深改版与轻改版无明显差异，已隐藏重复版本"
            if deep_polish_body:
                deep_guardrail_ok, deep_guardrail_reason = _evaluate_polished_body(
                    body_draft=body_draft,
                    polished_body=deep_polish_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                    tags=draft.get("tags", []),
                    minimum_ratio=0.6,
                    max_paragraph_drop=1,
                    missing_term_threshold=2,
                    enforce_tag_semantics=True,
                )
            if deep_polish_body and not deep_guardrail_ok:
                deep_polish_body, deep_repairs = _repair_body_with_draft(
                    body_draft=body_draft,
                    candidate_body=deep_polish_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                )
                guardrail_repairs_applied.extend(deep_repairs)
                deep_guardrail_ok, deep_guardrail_reason = _evaluate_polished_body(
                    body_draft=body_draft,
                    polished_body=deep_polish_body,
                    product_info=product_info,
                    benchmark_note=benchmark_note,
                    tags=draft.get("tags", []),
                    minimum_ratio=0.6,
                    max_paragraph_drop=1,
                    missing_term_threshold=2,
                    enforce_tag_semantics=True,
                )

        final_body = body_draft
        polished_body = minimal_polish_body
        final_body_source = "draft"
        guardrail_stage = "draft"
        polish_guardrail_reason = minimal_guardrail_reason or deep_guardrail_reason

        if should_prefer_deep_polish and deep_guardrail_ok and deep_polish_body.strip():
            final_body = deep_polish_body
            polished_body = deep_polish_body
            final_body_source = "deep_polish"
            guardrail_stage = "deep_polish"
            polish_guardrail_reason = ""
        elif minimal_guardrail_ok and minimal_polish_body.strip():
            final_body = minimal_polish_body
            polished_body = minimal_polish_body
            final_body_source = "minimal_polish"
            guardrail_stage = "minimal_polish"
            polish_guardrail_reason = deep_guardrail_reason if should_run_deep_polish and deep_guardrail_reason else ""

        title_candidates = _normalize_title_candidates(draft.get("title_candidates"), structure.get("title_frameworks", []))
        try:
            length_fit = self._fit_to_xhs_publish_limits(
                title_candidates=title_candidates,
                body=final_body,
                product_info=product_info,
                note_strategy="\n".join([
                    str(structure.get("rewrite_strategy", "")),
                    strategy_text,
                ]),
            )
        except Exception as error:
            length_fit = {"changed": False, "title_candidates": title_candidates, "body": final_body, "notes": []}
            guardrail_repairs_applied.append(f"发布长度/标题适配失败，已保留去 AI 味版本：{error}")
            polish_guardrail_reason = polish_guardrail_reason or "发布长度/标题适配失败，已保留去 AI 味版本"
        if length_fit.get("changed"):
            final_body = str(length_fit.get("body") or final_body).strip()
            final_body, draft["tags"] = _strip_trailing_hashtag_block(final_body, draft.get("tags", []))
            final_body = _strip_placeholder_tail(final_body)
            polished_body = final_body
            if final_body_source == "deep_polish":
                deep_polish_body = final_body
            elif final_body_source == "minimal_polish":
                minimal_polish_body = final_body
            else:
                body_draft = final_body
            title_candidates = length_fit.get("title_candidates") or title_candidates
            guardrail_repairs_applied.extend(str(note) for note in (length_fit.get("notes") or []) if str(note).strip())
            polish_guardrail_reason = polish_guardrail_reason or "已按小红书发布长度自然压缩到 1000 字以内"

        final_body, final_complete_notes = _finalize_body_complete_guard(final_body)
        if final_complete_notes:
            guardrail_repairs_applied.extend(final_complete_notes)
            if final_body_source == "deep_polish":
                deep_polish_body = final_body
            elif final_body_source == "minimal_polish":
                minimal_polish_body = final_body
            else:
                body_draft = final_body
            polished_body = final_body
        polished_body = _strip_placeholder_tail(polished_body)
        minimal_polish_body = _strip_placeholder_tail(minimal_polish_body)
        deep_polish_body = _strip_placeholder_tail(deep_polish_body)

        polished_body_fallback_used = final_body_source == "draft"
        de_ai_report = dict((deep_polish or minimal_polish).get("de_ai_report", {}) or {})
        if final_body_source == "deep_polish":
            de_ai_report["summary"] = de_ai_report.get("summary") or "已完成深度去 AI 味"
        elif final_body_source == "minimal_polish":
            if should_run_deep_polish and deep_guardrail_reason:
                de_ai_report["summary"] = f"深度改写未通过完整性保护，已采用轻改版：{deep_guardrail_reason}"
            else:
                de_ai_report["summary"] = "已完成最小改写"
        else:
            de_ai_report["summary"] = f"轻改版异常，已回退主稿：{minimal_guardrail_reason or deep_guardrail_reason or '完整性保护已触发'}"

        return {
            "benchmark_note": benchmark_note,
            "product_info": product_info,
            "rewrite_mode": rewrite_mode,
            "title_candidates": title_candidates,
            "opening_candidates": (deep_polish.get("polished_openings") if deep_polish else None) or minimal_polish.get("polished_openings", draft.get("opening_candidates", [])),
            "content_outline": structure.get("content_outline", []),
            "body_draft": body_draft,
            "minimal_polish_body": minimal_polish_body,
            "deep_polish_body": deep_polish_body,
            "polished_body": polished_body,
            "final_body": final_body,
            "final_body_source": final_body_source,
            "polished_body_fallback_used": polished_body_fallback_used,
            "polish_guardrail_reason": polish_guardrail_reason,
            "guardrail_stage": guardrail_stage,
            "guardrail_repairs_applied": guardrail_repairs_applied,
            "replacement_phrases": draft.get("replacement_phrases", []),
            "tags": draft.get("tags", []),
            "rationale": draft.get("rationale", structure.get("rewrite_strategy", "")),
            "de_ai_report": de_ai_report,
            "revision_notes": (deep_polish.get("revision_notes") if deep_polish else None) or minimal_polish.get("revision_notes", []),
            "high_risk_ai_sentences": (deep_polish.get("high_risk_ai_sentences") if deep_polish else None) or minimal_polish.get("high_risk_ai_sentences") or self._find_ai_risk_sentences(final_body, real_phrases=real_phrases),
            "estimated_engagement": benchmark_note.get("recommendation_tier", "可参考"),
        }

    def generate_content(self, product_name: str, product_features: str, target_audience: str, analysis_insights: str, style: str = "种草", count: int = 3) -> List[Dict[str, Any]]:
        prompt = f"""你是一位专业的小红书内容创作者。请根据以下信息，生成 {count} 套文案。

产品名称：{product_name}
产品特点：{product_features}
目标人群：{target_audience}
分析结果：{analysis_insights}
风格：{style}

要求：文案必须符合小红书风格，每段和关键短句都应当加入合适的 emoji 表情（如✨🔥💡✅👇等），增强视觉排版和阅读体验。
{XHS_TITLE_QUALITY_GUIDE}
排版要求：
- 正文必须有空行分段，建议 4-8 个自然段。
- 清单项、✅/✨/👉 这类提示符要单独成行。
- 不要把全文写成一个大段落。

重要约束（严格执行，不得违反）：
- 标题（含 emoji）必须自然控制在 20 个字以内，不能靠生硬截断；标题要有明确钩子，不要只是产品功能概括。
- 正文（含 emoji）必须自然控制在 1000 个字以内，建议 900-980 字。
- 如果内容超长，优先合并重复铺垫、压缩长句、保留人群/痛点/卖点/行动引导。

输出严格 JSON：
{{
  "plans": [
    {{
      "title": "标题",
      "content": "正文",
      "tags": ["标签1", "标签2"],
      "estimated_engagement": "高/中/低",
      "rationale": "创作思路"
    }}
  ]
}}
"""
        data = self._normalize_json_object(
            self._call_json(prompt, temperature=0.8, max_tokens=2400),
            stage="content_generation",
        )
        plans = data.get("plans", [])
        normalized: List[Dict[str, Any]] = []
        for idx, plan in enumerate(plans[:count], 1):
            plan_body, plan_tags = _strip_trailing_hashtag_block(
                str(plan.get("content", "未生成正文")),
                plan.get("tags", []),
            )
            fitted = self._fit_to_xhs_publish_limits(
                title_candidates=[str(plan.get("title", "未生成标题"))],
                body=plan_body,
                product_info={
                    "product_name": product_name,
                    "product_features": product_features,
                    "target_audience": target_audience,
                    "brand_tone": style,
                },
                note_strategy=analysis_insights,
            )
            fitted_body, fitted_tags = _strip_trailing_hashtag_block(str(fitted.get("body") or plan_body), plan_tags)
            normalized.append({
                "id": idx,
                "title": (fitted.get("title_candidates") or [str(plan.get("title", "未生成标题"))])[0],
                "content": fitted_body,
                "tags": fitted_tags,
                "estimated_engagement": plan.get("estimated_engagement", "中"),
                "rationale": plan.get("rationale", "无"),
            })
        return normalized or [{
            "id": 1,
            "title": "生成失败",
            "content": "模型没有返回可解析的文案。",
            "tags": [],
            "estimated_engagement": "未知",
            "rationale": "格式解析错误",
        }]

    def generate_content_from_interview(
        self,
        *,
        selected_title: str,
        collected_info: Dict[str, Any],
        raw_context_notes: Optional[List[str]] = None,
        feedback: str = "",
    ) -> Dict[str, Any]:
        normalized_title = (selected_title or "").strip()
        if not normalized_title:
            raise ValueError("缺少已选择的标题，无法生成正文")

        product_name = str(collected_info.get("product_name") or "未命名产品").strip()
        product_features = str(
            collected_info.get("core_features")
            or collected_info.get("product_features")
            or collected_info.get("product_type")
            or "待补充"
        ).strip()
        target_audience = str(
            collected_info.get("target_audience")
            or collected_info.get("target_scene")
            or "待补充"
        ).strip()
        style_preference = str(collected_info.get("style_preference") or "").strip()
        marketing_goal = str(collected_info.get("marketing_goal") or "").strip()
        real_motivation = str(collected_info.get("real_motivation") or "").strip()
        target_scene = str(collected_info.get("target_scene") or "").strip()
        action_goal = str(collected_info.get("action_goal") or "").strip()

        context_lines = [
            f"选定标题：{normalized_title}",
            f"产品名称：{product_name}",
            f"目标人群：{target_audience}",
            f"产品特点：{product_features}",
            f"营销目标：{marketing_goal or '待补充'}",
            f"真实动机：{real_motivation or '待补充'}",
            f"目标场景：{target_scene or '待补充'}",
            f"行动目标：{action_goal or '待补充'}",
            f"风格偏好：{style_preference or '真实、口语化、不过度销售'}",
        ]
        cleaned_notes = [
            str(item).strip()
            for item in (raw_context_notes or [])
            if isinstance(item, str) and str(item).strip()
        ]
        if cleaned_notes:
            context_lines.append("用户原话片段：")
            context_lines.extend([f"- {note}" for note in cleaned_notes[:6]])
        if feedback.strip():
            context_lines.append(f"本次补充要求：{feedback.strip()}")

        product_usage_mode = "product_main"
        if not any(keyword in f"{marketing_goal} {action_goal}" for keyword in ["成交", "咨询", "私信", "留资", "加微信", "转化", "下单", "购买"]):
            product_usage_mode = "product_assist"
        interview_strategy = {
            "id": "interview_strategy",
            "label": "访谈策略",
            "summary": "；".join(
                item for item in [
                    f"营销目标：{marketing_goal}" if marketing_goal else "",
                    f"真实动机：{real_motivation}" if real_motivation else "",
                    f"目标场景：{target_scene}" if target_scene else "",
                    f"行动目标：{action_goal}" if action_goal else "",
                ]
                if item
            ),
            "suggestedTitle": normalized_title,
            "targetAudience": target_audience,
            "contentAngle": target_scene or marketing_goal or "访谈提炼出的真实场景内容",
            "corePainPoints": [
                item for item in [real_motivation, target_scene, marketing_goal]
                if item and not _is_placeholder_text(item)
            ][:4],
            "coreBenefits": [
                item for item in [product_features, action_goal]
                if item and not _is_placeholder_text(item)
            ][:4],
            "recommendedCardPlan": [
                "开头先写真实场景和为什么现在要发",
                "指出目标人群最容易遇到的具体卡点",
                "给出可对照的判断或方法",
                "把产品能力自然翻译成场景价值",
                "用行动目标做轻 CTA 收束",
            ],
            "noteGoal": action_goal or marketing_goal,
            "productUsageMode": product_usage_mode,
        }
        synthetic_benchmark_note = {
            "title": normalized_title,
            "desc": "\n".join(context_lines),
            "content_category": "访谈策略生成",
            "recommendation_tier": action_goal or marketing_goal or "可参考",
            "material_dependency": "访谈上下文与产品资料",
        }
        product_info = {
            "product_name": product_name,
            "product_features": product_features,
            "target_audience": target_audience,
            "brand_tone": style_preference,
            "must_include": str(collected_info.get("must_include") or ""),
            "banned_terms": str(collected_info.get("banned_terms") or ""),
        }

        expression_seed = _build_strategy_expression_seed(product_info, interview_strategy, synthetic_benchmark_note)
        dynamic_style_guide = _build_dynamic_xhs_style_guide({}, expression_seed)
        product_usage_constraints = _format_product_usage_constraints(interview_strategy)
        real_phrase_text = "\n".join(f"- {note}" for note in cleaned_notes[:8]) or "- 暂无真实用户表达"

        def build_interview_prompt(*, retry_instruction: str = "") -> str:
            return f"""你是小红书访谈内容总编。用户已经完成访谈并选定标题，请基于访谈结果生成一篇完整、可直接发布的小红书笔记。

这不是策略生文任务，不要调用对标仿写思路；但你要借鉴稳定生文的内部工作方式：
先在心里完成【表达契约 → 内容原子 → 结构取舍 → 发布稿】四步，但不要把这些过程输出出来。

【已选标题】
{normalized_title}

【访谈信息】
{json.dumps(collected_info, ensure_ascii=False, indent=2)}

【访谈策略摘要】
{json.dumps(interview_strategy, ensure_ascii=False, indent=2)}

{product_usage_constraints}

【产品 brief】
{self._build_product_brief(product_info)}

【用户原话片段】
{real_phrase_text}

【本次补充要求】
{feedback.strip() or "无"}
{retry_instruction}

{dynamic_style_guide}

{XHS_TITLE_QUALITY_GUIDE}

写作要求：
1. 标题必须自然控制在 20 字以内。若已选标题合格，优先沿用；不要改成泛标题。
2. 正文必须是一篇完整发布稿，不是提纲、不是分析、不是“可以这样写”。
3. 正文自然控制在 500-900 字，绝对不超过 1000 字；信息较少时也要写成完整经验/方法笔记，不要只写几句话，不要返回 300 字以内短稿。
4. 必须围绕访谈结果写，访谈里没有的硬数据、案例结果、客户数量不要编造；可以把产品能力翻译成场景价值和行动建议。
5. 不要把产品特点机械堆成说明书；每个产品点都要绑定“用户遇到什么场景/为什么重要/下一步怎么做”。
6. 正文要有小红书阅读节奏：4-7 个自然段，段落之间必须用两个换行符。
7. 如果正文里出现编号、步骤或并列清单，必须每一项单独成行，绝对不能写成“1️⃣... 2️⃣... 3️⃣...”或“1、... 2、... 3、...”挤在同一行。
8. 清单项推荐格式：
   1️⃣ 不同渠道有没有独立入口
   2️⃣ 客户进来有没有自动带上来源标签
   3️⃣ 后续有没有记录和回复
9. `content` 字符串里必须真实包含换行符；段落之间用两个换行符，清单项之间用一个换行符。
10. emoji 要少而准，按当前产品语境使用 3-6 个，不要堆表情。
11. 正文最后必须完整收束，有轻 CTA 或自查引导；最后一句必须是完整句，不能以逗号、冒号、顿号结尾。
12. 不要输出 Markdown，不要输出代码块，不要解释思考过程。

请输出严格 JSON：
{{
  "final_title": "20字以内最终标题",
  "title_candidates": ["最多3个20字以内候选标题"],
  "content": "完整正文，保留空行分段",
  "tags": ["5-8个发布标签，不带#"],
  "rationale": "一句话说明为什么这篇贴合访谈目标"
}}
"""
        print(
            "[ViralContentGenerator] interview_direct_generation start "
            f"title={normalized_title} notes={len(cleaned_notes)} feedback={bool(feedback.strip())}"
        )
        payload = self._normalize_json_object(
            self._call_json(build_interview_prompt(), temperature=0.5, max_tokens=2200),
            stage="interview_direct_generation",
        )
        content = str(
            payload.get("content")
            or payload.get("body")
            or payload.get("final_body")
            or ""
        ).strip()
        content, payload_tags = _strip_trailing_hashtag_block(content, payload.get("tags", []))
        content = _strip_placeholder_tail(content)
        if self._is_likely_incomplete_xhs_body(content, min_chars=INTERVIEW_BODY_MIN_COMPLETE_CHARS):
            print(
                "[ViralContentGenerator] interview_direct_generation short_body_retry "
                f"title={normalized_title} length={len(content)}"
            )
            retry_payload = self._normalize_json_object(
                self._call_json(
                    build_interview_prompt(
                        retry_instruction=(
                            "\n【重要重写要求】\n"
                            "上一版正文明显过短或像残稿。请重新生成一篇完整发布稿，"
                            "不要沿用上一版短稿，不要补写说明，正文必须有 4-7 个自然段。"
                        )
                    ),
                    temperature=0.42,
                    max_tokens=2400,
                ),
                stage="interview_direct_generation_retry",
            )
            retry_content = str(
                retry_payload.get("content")
                or retry_payload.get("body")
                or retry_payload.get("final_body")
                or ""
            ).strip()
            retry_content, retry_tags = _strip_trailing_hashtag_block(retry_content, retry_payload.get("tags", []))
            retry_content = _strip_placeholder_tail(retry_content)
            if not self._is_likely_incomplete_xhs_body(
                retry_content,
                min_chars=INTERVIEW_BODY_MIN_COMPLETE_CHARS,
            ):
                payload = retry_payload
                content = retry_content
                payload_tags = retry_tags
        title_candidates = _rank_publish_title_candidates(
            [
                str(payload.get("final_title") or ""),
                normalized_title,
                *(payload.get("title_candidates") if isinstance(payload.get("title_candidates"), list) else []),
            ],
            benchmark_title=normalized_title,
            strategy_title=normalized_title,
            body=content,
            product_info=product_info,
            fallback=[normalized_title],
        )
        if not title_candidates:
            title_candidates = _normalize_title_candidates([normalized_title])
        tags = _derive_publish_tags(
            title=title_candidates[0] if title_candidates else normalized_title,
            body=content,
            product_info=product_info,
            benchmark_note=synthetic_benchmark_note,
            note_strategy=interview_strategy,
            existing_tags=[*payload_tags, *(expression_seed.get("tag_hints") or [])],
        )
        paragraphs = _split_paragraphs(content)
        opening_candidates = paragraphs[:2]
        content_outline = self._build_interview_content_outline(
            content=content,
            marketing_goal=marketing_goal,
            real_motivation=real_motivation,
            target_scene=target_scene,
            action_goal=action_goal,
            product_features=product_features,
        )
        expression_contract = self._build_interview_expression_contract(
            product_usage_mode=product_usage_mode,
            target_audience=target_audience,
            target_scene=target_scene,
            marketing_goal=marketing_goal,
        )
        content_atoms = self._build_interview_content_atoms(
            collected_info=collected_info,
            raw_context_notes=cleaned_notes,
            content_outline=content_outline,
        )
        rewrite_session = {
            "benchmark_note": synthetic_benchmark_note,
            "product_info": product_info,
            "rewrite_mode": "访谈专用生文",
            "selected_title": title_candidates[0] if title_candidates else normalized_title,
            "title_candidates": title_candidates,
            "opening_candidates": opening_candidates,
            "content_outline": content_outline,
            "body_draft": content,
            "minimal_polish_body": "",
            "deep_polish_body": "",
            "polished_body": content,
            "final_body": content,
            "final_body_source": "interview_direct",
            "polished_body_fallback_used": False,
            "polish_guardrail_reason": "",
            "guardrail_stage": "interview_prompt_contract",
            "guardrail_repairs_applied": [],
            "replacement_phrases": [],
            "tags": tags,
            "rationale": str(payload.get("rationale") or "基于访谈上下文直接生成").strip(),
            "de_ai_report": {
                "formula_density": 0,
                "emotion_word_overload": 0,
                "sentence_rhythm_risk": len(self._find_ai_risk_sentences(content, real_phrases=cleaned_notes)),
                "comment_voice_gap": 0,
                "summary": "访谈专用生文：借鉴策略生文的表达契约和内容原子思路，一次生成完整发布稿。",
            },
            "revision_notes": ["访谈专用生文未走策略候选评审链路"],
            "high_risk_ai_sentences": self._find_ai_risk_sentences(content, real_phrases=cleaned_notes),
            "estimated_engagement": action_goal or marketing_goal or "可参考",
            "candidate_judge_enabled": False,
            "expression_contract": expression_contract,
            "content_atoms": content_atoms,
            "strategy_expression_seed": expression_seed,
            "dynamic_style_guide": dynamic_style_guide,
        }
        if not content:
            raise ValueError("模型未返回正文内容")
        if self._is_likely_incomplete_xhs_body(content, min_chars=INTERVIEW_BODY_MIN_COMPLETE_CHARS):
            raise ValueError(f"访谈正文不完整，请重试生成: length={len(content)}")
        if len(content) > XHS_BODY_MAX_CHARS:
            raise ValueError(f"访谈正文超过小红书发布限制，请重试生成: length={len(content)}")
        if any(len(title) > XHS_TITLE_MAX_CHARS for title in title_candidates):
            raise ValueError("访谈标题超过小红书发布限制，请重试生成")

        return {
            "title": (title_candidates or [normalized_title])[0],
            "content": content,
            "tags": tags,
            "estimated_engagement": rewrite_session.get("estimated_engagement", "中"),
            "rationale": rewrite_session.get("rationale", "基于访谈上下文生成"),
            "rewrite_session": rewrite_session,
            "note_strategy": interview_strategy,
        }

    def generate_title_options_from_interview(
        self,
        *,
        collected_info: Dict[str, Any],
        raw_context_notes: Optional[List[str]] = None,
        feedback: str = "",
    ) -> List[Dict[str, Any]]:
        marketing_goal = str(collected_info.get("marketing_goal") or "").strip()
        real_motivation = str(collected_info.get("real_motivation") or "").strip()
        target_scene = str(collected_info.get("target_scene") or "").strip()
        action_goal = str(collected_info.get("action_goal") or "").strip()
        product_name = str(collected_info.get("product_name") or "").strip()
        core_features = str(collected_info.get("core_features") or collected_info.get("product_features") or "").strip()
        target_audience = str(collected_info.get("target_audience") or "").strip()
        style_preference = str(collected_info.get("style_preference") or "").strip()
        cleaned_notes = [
            str(item).strip()
            for item in (raw_context_notes or [])
            if isinstance(item, str) and str(item).strip()
        ]

        prompt_lines = [
            "你是一位专业的小红书标题策划。请基于当前访谈信息，重新生成 3 个更适合的小红书标题。",
            "要求：",
            "1. 标题要有明确收益感、问题切口或场景代入感，并且包含合适的 emoji 表情。",
            "2. 三个标题风格要有差异，但都必须贴合当前访谈目标。",
            "3. 每个标题必须自然控制在 20 字以内，不要靠生硬截断。",
            "4. 标题不能只是普通概括句，要有具体场景、痛点反差或结果感。",
            "5. 不要输出正文，只输出标题选项。",
            XHS_TITLE_QUALITY_GUIDE,
            f"产品名称：{product_name or '待补充'}",
            f"产品特点：{core_features or '待补充'}",
            f"目标人群：{target_audience or '待补充'}",
            f"营销目标：{marketing_goal or '待补充'}",
            f"真实动机：{real_motivation or '待补充'}",
            f"目标场景：{target_scene or '待补充'}",
            f"行动目标：{action_goal or '待补充'}",
            f"风格偏好：{style_preference or '真实、口语化'}",
        ]
        if cleaned_notes:
            prompt_lines.append("用户原话片段：")
            prompt_lines.extend([f"- {note}" for note in cleaned_notes[:6]])
        if feedback.strip():
            prompt_lines.append(f"用户这次对标题的额外要求：{feedback.strip()}")

        prompt_lines.extend([
            "输出严格 JSON：",
            "{",
            '  "title_options": [',
            '    {"id": 1, "title": "标题1", "style": "风格1", "rationale": "理由1"},',
            '    {"id": 2, "title": "标题2", "style": "风格2", "rationale": "理由2"},',
            '    {"id": 3, "title": "标题3", "style": "风格3", "rationale": "理由3"}',
            "  ]",
            "}",
        ])

        payload = self._normalize_json_object(
            self._call_json("\n".join(prompt_lines), temperature=0.7, max_tokens=1400),
            stage="interview_title_regeneration",
        )
        options = payload.get("title_options", [])
        normalized: List[Dict[str, Any]] = []
        for index, option in enumerate(options[:3], 1):
            if not isinstance(option, dict):
                continue
            title = str(option.get("title") or "").strip()
            if not title:
                continue
            fitted = self._fit_to_xhs_publish_limits(
                title_candidates=[title],
                body="标题候选生成，无正文。",
                product_info={
                    "product_name": product_name,
                    "product_features": core_features,
                    "target_audience": target_audience,
                    "brand_tone": style_preference,
                },
                note_strategy=feedback,
            )
            normalized.append({
                "id": index,
                "title": (fitted.get("title_candidates") or [title])[0],
                "style": str(option.get("style") or "访谈定制").strip() or "访谈定制",
                "rationale": str(option.get("rationale") or "基于当前访谈上下文重构标题").strip() or "基于当前访谈上下文重构标题",
            })
        if not normalized:
            raise ValueError("模型未返回可用标题选项")
        return normalized

    def refine_content(self, original_content: Dict[str, Any], refinement_instruction: str) -> Dict[str, Any]:
        prompt = f"""请根据用户的修改要求优化以下小红书文案。

标题：{original_content.get('title', '')}
正文：{original_content.get('content', '')}
标签：{', '.join(original_content.get('tags', []))}

修改要求：{refinement_instruction}

重要约束（严格执行，不得违反）：
- 标题（含 emoji）必须自然控制在 20 个字以内，不能靠生硬截断；标题要有小红书点击欲，不要只是功能概括。
- 正文（含 emoji）必须自然控制在 1000 个字以内，建议 900-980 字。
- 如果信息很多，合并重复铺垫、压缩长句，保留人群/痛点/卖点/行动引导。
{XHS_TITLE_QUALITY_GUIDE}

请输出严格 JSON：
{{
  "title": "优化后的标题",
  "content": "优化后的正文",
  "tags": ["标签1", "标签2"],
  "changes": "50字内说明"
}}
"""
        try:
            refined = self._normalize_json_object(
                self._call_json(prompt, temperature=0.65, max_tokens=1400),
                stage="content_refine",
            )
            fitted = self._fit_to_xhs_publish_limits(
                title_candidates=[str(refined.get("title", original_content.get("title", "")))],
                body=str(refined.get("content", original_content.get("content", ""))),
                product_info={},
                note_strategy=refinement_instruction,
            )
            return {
                "id": original_content.get("id", 1),
                "title": (fitted.get("title_candidates") or [str(refined.get("title", original_content.get("title", "")))])[0],
                "content": str(fitted.get("body") or refined.get("content", original_content.get("content", ""))),
                "tags": refined.get("tags", original_content.get("tags", [])),
                "estimated_engagement": original_content.get("estimated_engagement", "中"),
                "rationale": refined.get("changes", "已优化"),
            }
        except Exception as e:
            return {
                "id": original_content.get("id", 1),
                "title": str(original_content.get("title", "")),
                "content": str(original_content.get("content", "")),
                "tags": original_content.get("tags", []),
                "estimated_engagement": original_content.get("estimated_engagement", "中"),
                "rationale": f"优化失败: {str(e)}",
            }
