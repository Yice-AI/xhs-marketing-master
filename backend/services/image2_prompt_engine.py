import json
import re
from typing import Optional, Dict, Any, Tuple, List
from backend.api.routes.visual import _clip_text, VISUAL_PROMPT_MAX_CONTENT_CHARS
from backend.config import settings

B2B_PRODUCT_KEYWORDS = [
    "b2b",
    "to-b",
    "tob",
    "企业",
    "商家",
    "门店",
    "销售",
    "客服",
    "运营",
    "私域",
    "线索",
    "客资",
    "crm",
    "scrm",
    "saas",
    "系统",
    "管理",
    "协同",
    "自动化",
    "数据",
    "报表",
    "后台",
    "降本",
    "增效",
]

B2C_CREATOR_TOOL_KEYWORDS = [
    "uplog",
    "排版",
    "编辑器",
    "写作",
    "笔记",
    "图文",
    "小红书",
    "公众号",
    "自媒体",
    "创作者",
    "博主",
    "作者",
    "内容创作",
    "模板",
]

B2C_PRODUCT_KEYWORDS = [
    "b2c",
    "to-c",
    "toc",
    "个人",
    "消费者",
    "用户",
    "女生",
    "宝妈",
    "学生",
    "家庭",
    "护肤",
    "美妆",
    "穿搭",
    "食品",
    "生活方式",
    *B2C_CREATOR_TOOL_KEYWORDS,
]

DYNAMIC_INTENT_PROMPT_GUARDRAIL_MARKER = "# 用户补充意图落图约束:"
STYLE_EXPRESSION_PROMPT_GUARDRAIL_MARKER = "# 风格表达预设落图约束:"
DYNAMIC_INTENT_SCOPE_GLOBAL = "global"
DYNAMIC_INTENT_SCOPE_COVER = "cover"
DYNAMIC_INTENT_SCOPE_CONTENT = "content"
DYNAMIC_INTENT_SCOPE_ENDING = "ending"

STYLE_EXPRESSION_PRESETS: Dict[str, Dict[str, str]] = {
    "auto_dynamic": {
        "label": "AI自动匹配",
        "guidance": "保持动态表达默认能力：根据笔记内容自行选择最合适的小红书软件/工具类信息图风格，不额外固定色系或版式。",
    },
    "handdrawn_operations": {
        "label": "运营干货手绘卡",
        "guidance": (
            "复刻高点击小红书爆款手绘运营干货系列，不是普通信息图模板。画面外层优先使用饱和青绿色背景，"
            "内层是一张白色/浅奶白撕纸质感大纸张，纸张边缘粗糙，有轻微阴影和纸纹；主色青绿色 #18B8B5，"
            "搭配浓黑粗手写中文标题，少量明黄色高亮胶带、珊瑚红收藏贴纸、浅蓝/浅紫/浅绿便签胶带。"
            "必须有真实小红书爆款运营干货账号的系列感：手绘马克笔刷痕、撕纸、胶带、涂鸦箭头、星星、"
            "勾选框、便签小卡、黑色线稿小图标；中文大标题清晰可读，字形有粗手写感但不要乱码。"
            "背景要白净/奶白，不要灰黄旧纸；青绿色要鲜艳有冲击；黑字要粗但不能让画面发黑；"
            "标题面积大，信息密度中等偏低，装饰活泼但不要平均铺满。"
            "同一组图要保持青绿外底、白/奶白撕纸、粗黑手写标题、青绿重点字/刷痕、黄色胶带、"
            "彩色便签和红色收藏贴纸的统一视觉语言，但每张图必须服务自己的页面角色：封面、模块解释、步骤、对比或总结。"
        ),
    },
    "notebook_method": {
        "label": "方法论笔记本",
        "guidance": (
            "画面像线圈笔记本或分页索引卡：白色纸张、细网格或横线、右侧标签、中心方法框架、"
            "3-5 个小卡模块。适合 SOP、清单、步骤、判断标准类内容。"
        ),
    },
    "clean_flow": {
        "label": "清爽流程信息图",
        "guidance": (
            "使用白底或浅灰底、清晰箭头、流程节点、对比块和少量高亮色；信息层级干净，"
            "不要做成企业 BI 大屏，不要堆满小字。"
        ),
    },
    "saas_feature_cards": {
        "label": "SaaS功能卡片",
        "guidance": (
            "适合企业服务、SaaS、效率工具：高级浅色卡片、产品界面感抽象模块、数据标签、功能卡片、"
            "可信但不传统企业宣传，避免复杂仪表盘和满屏蓝色霓虹。"
        ),
    },
    "bold_cover": {
        "label": "爆款封面大字报",
        "guidance": (
            "封面用超清晰中文大标题、强对比色块和 1 个核心视觉符号；内容页保持大标题+少量模块，"
            "不要变成促销海报，不要堆表情和夸张爆炸贴纸。"
        ),
    },
}

STYLE_EXPRESSION_PRESET_ALIASES: Dict[str, str] = {
    "AI自动匹配": "auto_dynamic",
    "auto": "auto_dynamic",
    "auto_dynamic": "auto_dynamic",
    "运营干货手绘卡": "handdrawn_operations",
    "手绘青绿": "handdrawn_operations",
    "handdrawn_operations": "handdrawn_operations",
    "方法论笔记本": "notebook_method",
    "notebook_method": "notebook_method",
    "清爽流程信息图": "clean_flow",
    "clean_flow": "clean_flow",
    "SaaS功能卡片": "saas_feature_cards",
    "saas_feature_cards": "saas_feature_cards",
    "爆款封面大字报": "bold_cover",
    "bold_cover": "bold_cover",
    # Backward-compatible labels from the old concept style selector.
    "温暖渐变卡片": "handdrawn_operations",
    "笔记卡片风": "notebook_method",
    "极简文字海报": "clean_flow",
    "赛博朋克": "bold_cover",
    "企业级扁平海报": "saas_feature_cards",
}


def _resolve_style_expression_preset(dynamic_style_params: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    if not dynamic_style_params:
        return None
    raw_value = (
        dynamic_style_params.get("style_preset")
        or dynamic_style_params.get("stylePreset")
        or dynamic_style_params.get("visual_style")
        or dynamic_style_params.get("visualStyle")
    )
    preset_value = _stringify_product_field(raw_value)
    if not preset_value:
        return None
    preset_key = STYLE_EXPRESSION_PRESET_ALIASES.get(preset_value, preset_value)
    preset = STYLE_EXPRESSION_PRESETS.get(preset_key)
    if not preset or preset_key == "auto_dynamic":
        return None
    return {"key": preset_key, **preset}


def _build_style_expression_guidance(preset: Optional[Dict[str, str]]) -> str:
    if not preset:
        return ""
    return f"""---
# 风格表达预设:
- 预设名称: {preset["label"]}
- 视觉系统: {preset["guidance"]}
- 重要：这只是风格系统，不是固定模板。必须先按笔记内容规划每张图角色，再在同一风格系统里做不同版式。
- 质量底线：保持动态表达现有小红书软件/工具类图片质量，中文清晰，信息克制，安全边距充足，禁止为了贴风格牺牲可读性。""".strip()


def _build_style_expression_prompt_guardrail(preset: Dict[str, str]) -> str:
    return f"""{STYLE_EXPRESSION_PROMPT_GUARDRAIL_MARKER}
- 本张图必须融入「{preset["label"]}」风格系统：{preset["guidance"]}
- 同组图片要保持统一色板、字体气质、装饰语言和页面编号/标签逻辑。
- 但本张图版式必须服务当前 role/topic/key_message，不要复制其他页结构，不要所有图都像封面。
- 中文标题和短句要清晰可读；保留足够安全边距，底部和边缘不要裁切文字。""".strip()

DYNAMIC_INTENT_GLOBAL_KEYWORDS = ("整体", "全组", "整组", "整套", "全部", "所有图", "每张", "统一")
DYNAMIC_INTENT_COVER_KEYWORDS = ("封面", "首图", "第一张", "第1张", "第 1 张", "头图")
DYNAMIC_INTENT_CONTENT_KEYWORDS = ("内容页", "步骤页", "流程页", "方法页", "内容优化", "第2张", "第3张", "第 2 张", "第 3 张")
DYNAMIC_INTENT_ENDING_KEYWORDS = (
    "结尾",
    "最后",
    "收尾",
    "尾页",
    "最后一张",
    "第4张",
    "第 4 张",
    "第5张",
    "第 5 张",
    "第6张",
    "第 6 张",
    "福利页",
)
DYNAMIC_INTENT_COLOR_KEYWORDS = ("配色", "色系", "主色", "颜色", "色调")
DYNAMIC_INTENT_DENSITY_KEYWORDS = (
    "密度",
    "留白",
    "信息量",
    "画面密度",
    "精简",
    "简化",
    "不要太满",
    "不要那么高",
    "减少模块",
    "少一点字",
)
DYNAMIC_INTENT_COPY_KEYWORDS = (
    "卖点",
    "文案",
    "标题",
    "数据",
    "夸大",
    "移除",
    "避免",
    "禁用",
    "不要",
    "去掉",
    "删除",
    "改用",
    "替换",
)
DYNAMIC_INTENT_INTERACTION_KEYWORDS = ("互动", "评论", "评论区", "提问", "引导")
DYNAMIC_INTENT_BENEFIT_KEYWORDS = ("福利", "关注", "收藏", "点赞", "模板合集", "领取", "送")
DYNAMIC_INTENT_VISUAL_KEYWORDS = ("人物", "情绪", "对比", "互动感", "before", "after", "耗时", "分钟", "小时", "→")
DYNAMIC_INTENT_PALETTE_KEYWORDS = (
    "紫白",
    "蓝白",
    "黑金",
    "黑白",
    "红白",
    "绿白",
    "粉白",
    "橙白",
    "高级灰",
    "莫兰迪",
    "浅色",
    "深色",
)


def _stringify_product_field(value: Any) -> str:
    if isinstance(value, (list, tuple, set)):
        return "、".join(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value or "").strip()


def _build_dynamic_intent_guidance(intent: str) -> str:
    if not intent:
        return ""
    return """---
# 补充意图处理方式:
- 先判断补充意图的作用范围：整体/全组意图影响每张图；封面、内容页、结尾页意图只影响对应页面。
- 内容型意图用于封面主卖点、文案取舍、页面分工、禁用词/数据口径、互动话术或结尾福利的放置；明确提到配色、密度、版式或画风时，才把它作为视觉约束。
- 不要把内容型补充意图当成新的视觉风格；除非用户明确要求颜色、画风或版式，否则不要在最终 prompt 中新增具体色系、人物主视觉、before/after 大叙事、促销海报感或插画风格。
- 保持动态表达原有轻约束框架，让 image2 继续自然选择高级软件/工具类小红书视觉；用户有意图时，只让每张图“说什么”更贴合，不让它“长什么样”被重写。
- 若意图要求精简信息，封面只提炼 1 个主卖点和最多 1 个辅助信息；互动话术和福利优先放在内容页或结尾页，避免挤进封面。
- 若意图限制夸张词、数据口径或信息密度，最终 prompt 必须写成可执行的可见文案约束，不要让图片模型自行补百分比、倍数或功能清单。""".strip()


def extract_dynamic_user_intent(dynamic_style_params: Optional[Dict[str, Any]]) -> str:
    if not dynamic_style_params:
        return ""
    return _stringify_product_field(dynamic_style_params.get("intent"))


def _extract_external_api_logo_guardrail(dynamic_style_params: Optional[Dict[str, Any]]) -> str:
    if not dynamic_style_params:
        return ""
    guardrail = _stringify_product_field(dynamic_style_params.get("external_api_logo_guardrail"))
    if "品牌 Logo 视觉约束" not in guardrail:
        return ""
    return guardrail


def _is_cover_prompt(prompt_data: Dict[str, Any], index: int) -> bool:
    if index == 1:
        return True
    combined = " ".join(
        str(prompt_data.get(key) or "").lower()
        for key in ("type", "role", "title")
    )
    return "cover" in combined or "封面" in combined


def _classify_dynamic_prompt_scope(prompt_data: Dict[str, Any], index: int, total: int, intent: str = "") -> str:
    if _is_cover_prompt(prompt_data, index):
        return DYNAMIC_INTENT_SCOPE_COVER

    combined = " ".join(
        str(prompt_data.get(key) or "").lower()
        for key in ("type", "role", "title", "key_message")
    )
    if (
        "ending" in combined
        or "summary" in combined
        or "cta" in combined
        or "结尾" in combined
        or "总结" in combined
        or "福利" in combined
        or "收藏" in combined
        or "关注" in combined
    ):
        return DYNAMIC_INTENT_SCOPE_ENDING
    if index == total and total > 1 and _contains_any(intent, DYNAMIC_INTENT_ENDING_KEYWORDS + DYNAMIC_INTENT_BENEFIT_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_ENDING
    return DYNAMIC_INTENT_SCOPE_CONTENT


def _split_product_feature_entries(value: str) -> List[str]:
    entries = [
        item.strip()
        for item in re.split(r"[；;、,，/|]+", value or "")
        if item.strip()
    ]
    return entries


def _limit_cover_product_features(prompt_text: str) -> str:
    def replace_line(match: re.Match[str]) -> str:
        raw_features = match.group(1).strip()
        entries = _split_product_feature_entries(raw_features)
        feature_summary = "；".join(entries[:2]) if entries else raw_features
        return f"产品特点（背景信息，封面最多选 1-2 个相关点，不要全部上屏）：{feature_summary}"

    return re.sub(
        r"(?m)^产品特点[:：]\s*(.+)$",
        replace_line,
        prompt_text,
        count=1,
    )


def _extract_forbidden_terms_from_intent(intent: str) -> List[str]:
    terms: List[str] = []
    negative_markers = ("移除", "避免", "禁用", "不要", "去掉", "删除")
    positive_transition_markers = ("改用", "换成", "替换为", "可用", "使用", "建议用")
    for segment in re.split(r"[。；;\n]", intent or ""):
        marker_positions = [
            segment.find(marker)
            for marker in negative_markers
            if marker in segment
        ]
        if not marker_positions:
            continue
        negative_part = segment[min(marker_positions):]
        transition_positions = [
            negative_part.find(marker)
            for marker in positive_transition_markers
            if marker in negative_part
        ]
        if transition_positions:
            negative_part = negative_part[:min(transition_positions)]
        for term in re.findall(r"[“\"「『]([^”\"」』]+)[”\"」』]", negative_part):
            normalized = term.strip()
            if normalized and normalized not in terms:
                terms.append(normalized)
    return terms[:8]


def _split_dynamic_intent_segments(intent: str) -> List[str]:
    normalized = re.sub(r"[•*]+", "\n", intent or "")
    raw_segments = re.split(r"[\n。；;]+", normalized)
    segments: List[str] = []
    for segment in raw_segments:
        cleaned = re.sub(r"^\s*[-–—]+\s*", "", segment).strip()
        if cleaned:
            segments.append(cleaned)
    return segments


def _contains_any(text: str, keywords: Tuple[str, ...]) -> bool:
    return any(keyword.lower() in text.lower() for keyword in keywords)


def _detect_dynamic_intent_scope(segment: str, previous_scope: str = DYNAMIC_INTENT_SCOPE_GLOBAL) -> str:
    if _contains_any(segment, DYNAMIC_INTENT_GLOBAL_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_GLOBAL
    if _contains_any(segment, DYNAMIC_INTENT_COVER_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_COVER
    if _contains_any(segment, DYNAMIC_INTENT_ENDING_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_ENDING
    if _contains_any(segment, DYNAMIC_INTENT_CONTENT_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_CONTENT
    if (
        previous_scope == DYNAMIC_INTENT_SCOPE_COVER
        and (
            _contains_any(segment, DYNAMIC_INTENT_VISUAL_KEYWORDS)
            or not _contains_any(segment, DYNAMIC_INTENT_INTERACTION_KEYWORDS + DYNAMIC_INTENT_BENEFIT_KEYWORDS)
        )
    ):
        return DYNAMIC_INTENT_SCOPE_COVER
    if _contains_any(segment, DYNAMIC_INTENT_INTERACTION_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_CONTENT
    if _contains_any(segment, DYNAMIC_INTENT_BENEFIT_KEYWORDS):
        return DYNAMIC_INTENT_SCOPE_ENDING
    return previous_scope if previous_scope != DYNAMIC_INTENT_SCOPE_GLOBAL else DYNAMIC_INTENT_SCOPE_GLOBAL


def _detect_dynamic_intent_kinds(segment: str) -> List[str]:
    kinds: List[str] = []
    if _contains_any(segment, DYNAMIC_INTENT_COLOR_KEYWORDS + DYNAMIC_INTENT_PALETTE_KEYWORDS):
        kinds.append("color")
    if _contains_any(segment, DYNAMIC_INTENT_DENSITY_KEYWORDS):
        kinds.append("density")
    if _contains_any(segment, DYNAMIC_INTENT_COPY_KEYWORDS):
        kinds.append("copy")
    if _contains_any(segment, DYNAMIC_INTENT_INTERACTION_KEYWORDS):
        kinds.append("interaction")
    if _contains_any(segment, DYNAMIC_INTENT_BENEFIT_KEYWORDS):
        kinds.append("benefit")
    if _contains_any(segment, DYNAMIC_INTENT_VISUAL_KEYWORDS):
        kinds.append("visual")
    return kinds or ["copy"]


def _parse_dynamic_intent_segments(intent: str) -> List[Dict[str, Any]]:
    parsed_segments: List[Dict[str, Any]] = []
    previous_scope = DYNAMIC_INTENT_SCOPE_GLOBAL
    for segment in _split_dynamic_intent_segments(intent):
        scope = _detect_dynamic_intent_scope(segment, previous_scope)
        previous_scope = scope
        parsed_segments.append({
            "text": segment,
            "scope": scope,
            "kinds": _detect_dynamic_intent_kinds(segment),
        })
    return parsed_segments


def _intent_segment_applies_to_prompt(segment_scope: str, prompt_scope: str) -> bool:
    if segment_scope == DYNAMIC_INTENT_SCOPE_GLOBAL:
        return True
    if segment_scope == prompt_scope:
        return True
    if segment_scope == DYNAMIC_INTENT_SCOPE_CONTENT and prompt_scope == DYNAMIC_INTENT_SCOPE_ENDING:
        return True
    return False


def _intent_scope_label(scope: str) -> str:
    return {
        DYNAMIC_INTENT_SCOPE_GLOBAL: "全组",
        DYNAMIC_INTENT_SCOPE_COVER: "封面",
        DYNAMIC_INTENT_SCOPE_CONTENT: "内容页",
        DYNAMIC_INTENT_SCOPE_ENDING: "结尾页",
    }.get(scope, "本页")


def _extract_color_phrase_from_intent_segment(segment: str) -> str:
    for token in DYNAMIC_INTENT_PALETTE_KEYWORDS:
        if token in segment:
            return token
    color_match = re.search(r"(?:配色|色系|主色|颜色|色调)[^，,。；;\n]{0,12}", segment)
    if color_match:
        phrase = re.sub(r"^(?:整体|全组|全部|统一|改成|换成|调整为|使用|采用|以)", "", color_match.group(0)).strip(" ：:，,。")
        return phrase or color_match.group(0).strip(" ：:，,。")
    return segment.strip(" ：:，,。")


def _dedupe_preserve_order(values: List[str]) -> List[str]:
    deduped: List[str] = []
    for value in values:
        if value and value not in deduped:
            deduped.append(value)
    return deduped


def _build_scoped_dynamic_intent_lines(*, intent: str, prompt_scope: str) -> List[str]:
    parsed_segments = _parse_dynamic_intent_segments(intent)
    applicable_segments = [
        segment
        for segment in parsed_segments
        if _intent_segment_applies_to_prompt(str(segment["scope"]), prompt_scope)
    ]
    if not applicable_segments:
        return []

    lines: List[str] = []
    color_phrases = _dedupe_preserve_order([
        _extract_color_phrase_from_intent_segment(str(segment["text"]))
        for segment in applicable_segments
        if "color" in segment["kinds"]
    ])
    if color_phrases:
        palette = "、".join(color_phrases[:2])
        scope_label = "全组" if any(segment["scope"] == DYNAMIC_INTENT_SCOPE_GLOBAL and "color" in segment["kinds"] for segment in applicable_segments) else _intent_scope_label(prompt_scope)
        lines.append(
            f"- {scope_label}配色硬约束：按“{palette}”执行，保持软件/工具类高级质感；背景以干净浅色或中性色承托，指定色只做主视觉和强调色，不要随机切换到无关蓝橙、米色或深色科技风。"
        )

    if any("density" in segment["kinds"] for segment in applicable_segments):
        scope_label = "全组" if any(segment["scope"] == DYNAMIC_INTENT_SCOPE_GLOBAL and "density" in segment["kinds"] for segment in applicable_segments) else _intent_scope_label(prompt_scope)
        lines.append(
            f"- {scope_label}密度硬约束：增加留白，减少模块数量和小字，每张只保留少量可见文字；不要底部多栏目卖点区，不要功能清单铺满画面。"
        )

    copy_segments = [
        str(segment["text"])
        for segment in applicable_segments
        if any(kind in segment["kinds"] for kind in ("copy", "visual"))
    ][:3]
    if copy_segments:
        lines.append(
            f"- {_intent_scope_label(prompt_scope)}内容取舍：结合用户意图“{'；'.join(copy_segments)}”，只提炼适合本页的一两个重点，不要逐字塞满。"
        )

    if prompt_scope == DYNAMIC_INTENT_SCOPE_COVER:
        return lines

    interaction_segments = [
        str(segment["text"])
        for segment in applicable_segments
        if "interaction" in segment["kinds"]
    ][:2]
    if interaction_segments:
        lines.append(
            f"- 内容页互动话术：可轻量放入 1 句评论引导，如“你遇到过这些排版难题吗？”；不要做成大促销主标题。参考意图：{'；'.join(interaction_segments)}。"
        )

    benefit_segments = [
        str(segment["text"])
        for segment in applicable_segments
        if "benefit" in segment["kinds"]
    ][:2]
    if benefit_segments:
        if prompt_scope == DYNAMIC_INTENT_SCOPE_ENDING:
            lines.append(
                f"- 结尾福利表达：只作为底部或角标的轻 CTA，例如“关注+收藏，领模板合集”；不要做成大面积促销横幅。参考意图：{'；'.join(benefit_segments)}。"
            )
        else:
            lines.append("- 福利信息只可作为很小的提醒或留到结尾页，不要抢走本页步骤/内容重点。")

    return lines


def _build_dynamic_intent_prompt_guardrail(*, intent: str, prompt_scope: str) -> str:
    is_cover = prompt_scope == DYNAMIC_INTENT_SCOPE_COVER
    is_ending = prompt_scope == DYNAMIC_INTENT_SCOPE_ENDING
    forbidden_terms = _extract_forbidden_terms_from_intent(intent)
    lines = [
        DYNAMIC_INTENT_PROMPT_GUARDRAIL_MARKER,
        "- 这些规则是最终送图硬约束，高于前文的泛化卖点和模型自由发挥。",
        "- 产品特点、目标人群、笔记正文是背景信息，不要逐项变成画面里的功能清单。",
        "- 不要自行生成百分比、倍数、排名、承诺型数据或夸张收益，例如 80%+、300%+、提升十倍；只有前文明确给出具体数字时才可使用。",
    ]
    if forbidden_terms:
        lines.append(f"- 禁止出现这些可见文案：{'、'.join(forbidden_terms)}。")
    lines.extend(_build_scoped_dynamic_intent_lines(intent=intent, prompt_scope=prompt_scope))
    if is_cover:
        lines.extend([
            "- 封面可见文案最多：1 个主标题 + 1 个副文案/数据点 + 产品名或 Logo；不要展开步骤清单、功能清单、底部多栏目卖点区。",
            "- 若标题或笔记出现步骤数量，只作为封面概念或标题元素；具体步骤留给内容页，封面不要画成多个功能卡片。",
        ])
    elif is_ending:
        lines.extend([
            "- 结尾页可见文字控制在 3-5 个短句，主视觉保持工具 UI/流程总结感，CTA/福利只做轻量收束，不要做成硬广促销页。",
            "- 如果需要人物或情绪对比，只做小尺寸辅助元素，主画面仍以软件界面、卡片和清晰信息结构为核心。",
        ])
    else:
        lines.extend([
            "- 内容页可见文字控制在 3-5 个短句，最多呈现 2 个功能点或步骤，不要把产品特点全部铺满。",
            "- 内容页主视觉优先使用软件 UI、步骤卡片、流程对比或工具界面；人物只可作为小辅助元素，不要改成办公室剧情插画主场景。",
        ])
    lines.extend([
        "- 用户提到的互动话术和福利只在适合的内容页或结尾页轻量呈现，不要挤进封面。",
        "- 保持原动态表达的软件/工具类高级信息图风格，不要因为这些约束改成促销海报或大叙事插画。",
    ])
    return "\n".join(lines)


def apply_image2_dynamic_intent_guardrails(
    prompts: List[Dict[str, Any]],
    dynamic_style_params: Optional[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    intent = extract_dynamic_user_intent(dynamic_style_params)
    style_preset = _resolve_style_expression_preset(dynamic_style_params)
    if not intent and not style_preset:
        return prompts
    external_api_logo_guardrail = _extract_external_api_logo_guardrail(dynamic_style_params)

    guarded_prompts: List[Dict[str, Any]] = []
    total = len(prompts)
    for index, prompt_data in enumerate(prompts, start=1):
        prompt_text = str(prompt_data.get("prompt") or "").strip()
        if not prompt_text:
            guarded_prompts.append(prompt_data)
            continue

        guarded_prompt_text = prompt_text
        if intent and DYNAMIC_INTENT_PROMPT_GUARDRAIL_MARKER not in guarded_prompt_text:
            prompt_scope = _classify_dynamic_prompt_scope(prompt_data, index, total, intent)
            guarded_prompt_text = _limit_cover_product_features(guarded_prompt_text) if prompt_scope == DYNAMIC_INTENT_SCOPE_COVER else guarded_prompt_text
            guarded_prompt_text = (
                f"{guarded_prompt_text.rstrip()}\n\n"
                f"{_build_dynamic_intent_prompt_guardrail(intent=intent, prompt_scope=prompt_scope)}"
            )
            if external_api_logo_guardrail:
                guarded_prompt_text = (
                    f"{guarded_prompt_text.rstrip()}\n\n"
                    "# 外部 API Logo 最终硬约束:\n"
                    f"{external_api_logo_guardrail}"
                )
        if style_preset and STYLE_EXPRESSION_PROMPT_GUARDRAIL_MARKER not in guarded_prompt_text:
            guarded_prompt_text = (
                f"{guarded_prompt_text.rstrip()}\n\n"
                f"{_build_style_expression_prompt_guardrail(style_preset)}"
            )
        next_prompt_data = {
            **prompt_data,
            "prompt": guarded_prompt_text,
        }
        if style_preset:
            next_prompt_data["style_preset"] = style_preset["key"]
            next_prompt_data["style_preset_label"] = style_preset["label"]
        guarded_prompts.append(next_prompt_data)

    return guarded_prompts


def analyze_product_brief(product_brief: Optional[Dict[str, Any]]) -> Dict[str, str]:
    if not product_brief:
        return {
            "product_name": "未知",
            "target_audience": "未知",
            "product_features": "未知",
            "market_type": "未知",
            "evidence": "未提供产品背景信息",
        }

    product_name = _stringify_product_field(product_brief.get("product_name")) or "未知"
    target_audience = _stringify_product_field(product_brief.get("target_audience")) or "未知"
    product_features = _stringify_product_field(product_brief.get("product_features")) or "未知"
    combined = f"{product_name} {target_audience} {product_features}".lower()

    b2b_hits = [keyword for keyword in B2B_PRODUCT_KEYWORDS if keyword.lower() in combined]
    b2c_hits = [keyword for keyword in B2C_PRODUCT_KEYWORDS if keyword.lower() in combined]
    creator_tool_hits = [keyword for keyword in B2C_CREATOR_TOOL_KEYWORDS if keyword.lower() in combined]
    if creator_tool_hits and not any(keyword in b2b_hits for keyword in ["企业", "商家", "门店", "销售", "客服", "私域", "线索", "客资", "crm", "scrm", "saas"]):
        market_type = "To-C / 创作者工具"
        evidence = "、".join(creator_tool_hits[:6])
    elif b2b_hits and len(b2b_hits) >= len(b2c_hits):
        market_type = "To-B / 企业服务"
        evidence = "、".join(b2b_hits[:6])
    elif b2c_hits:
        market_type = "To-C / 消费产品"
        evidence = "、".join(b2c_hits[:6])
    else:
        market_type = "待模型结合笔记进一步判断"
        evidence = "未命中明确 To-B/To-C 关键词"

    return {
        "product_name": product_name,
        "target_audience": target_audience,
        "product_features": product_features,
        "market_type": market_type,
        "evidence": evidence,
    }


def build_image2_dynamic_system_prompt() -> str:
    independent_title_rule = """
7. **多图标题分工**：保持原 prompt 结构不变，仅确保多图时每张 prompt 的“笔记标题”是本张页面标题。第 1 张可以使用整篇笔记标题；第 2 张及以后必须根据本张图的 role/topic/key_message 生成独立标题，不要复用第 1 张或整篇笔记标题。
""".rstrip() if settings.IMAGE2_DYNAMIC_INDEPENDENT_TITLES_ENABLED else ""

    prompt = """
你是一位熟悉小红书软件/工具类内容的视觉策划和 Prompt 工程师。
你的任务是先判断这篇笔记需要几张图、每张图负责讲什么，再为 gpt-image-2 写轻约束生图提示词。
核心原则：不要过度设计，不要堆满信息，让 image2 在清晰边界内自然发挥审美。

# 核心工作流

## Step 1: 多图规划 (design_plan)
根据笔记复杂度智能判断需要几张图，最多 6 张，禁止为了凑满而重复出图：
1. 简短单点笔记：1 张封面。
2. 有 2-3 个卖点/痛点：2-3 张。
3. 有步骤、对比、清单、复杂工具介绍：3-4 张。
4. 有完整 SOP、多模块方法论、前后对比+步骤+总结的体系型内容：5-6 张。
每张图必须有明确角色，不能只是重复封面换文案。

## Step 2: 轻约束提示词 (prompts)
每张图的 prompt 要接近下面这种轻约束逻辑：
“生成一张小红书软件工具类封面/内容图，竖版 3:4。这是一篇 AI 工具/效率软件/运营工具类笔记，不要做成纯审美摄影海报，要做成高点击信息型图片。需要明显的标题区、卖点区、视觉主体，适合小红书内容运营/自媒体/工具推荐场景。中文标题要清晰可读。”

# 输出格式 (JSON ONLY)
你必须只输出一个 JSON 对象，严格遵循以下结构：

{
  "design_plan": {
    "note_analysis": "一句话说明这篇笔记的核心价值",
    "image_count": 3,
    "image_roles": [
      {"id": 1, "role": "cover", "topic": "封面主题", "key_message": "本张图最重要的一句话"},
      {"id": 2, "role": "benefit", "topic": "卖点解释", "key_message": "本张图最重要的一句话"}
    ]
  },
  "prompts": [
    {
      "id": 1,
      "type": "Cover",
      "title": "本张图主题",
      "role": "cover",
      "key_message": "本张核心表达",
      "prompt": "生成一张小红书软件工具类封面图，竖版 3:4。这是一篇 AI 工具/效率软件类笔记，不要做成纯审美摄影海报，要做成高点击信息型封面。需要明显的标题区、卖点区、视觉主体，适合小红书内容运营/自媒体/工具推荐场景。中文标题要清晰可读。\\n\\n图位角色：封面。\\n本张核心表达：[一句话核心表达]\\n产品：[产品名称]\\n目标人群：[目标人群]\\n产品特点：[产品特点]\\n笔记标题：[标题]\\n笔记正文：[正文摘要]"
    }
  ]
}

# 关键约束 (CRITICAL RULES)
1. **轻约束优先**：不要写工程化长 prompt，不要写复杂镜头、宏大光影、极致视觉冲击。
2. **软件/工具类小红书感**：适合 AI 工具、效率软件、运营工具、SaaS、内容生产工具等笔记。
3. **中文文案精炼**：封面主标题尽量 8-14 字；内容图可见文字控制在 3-5 个短句内。
4. **避免丑图倾向**：不要企业 BI 大屏，不要满屏蓝色霓虹，不要赛博朋克，不要复杂仪表盘，不要密集小字，不要手机壳 mockup 套娃。
5. **按内容定张数**：简单内容不要硬拆 5-6 张；只有内容本身有足够层级时才生成 5-6 张。
6. **保持自然多样**：允许浅色卡片、深色高级、软件界面感、插画卡片、杂志封面感等自然变化，但不要让所有图变成同一种白底卡片。
7. **不要出现违禁词**：不要出现真实政治人物、明星、新闻人物，不要生成二维码、条形码、手机号等。
""".strip()
    if independent_title_rule:
        prompt = f"{prompt}\n{independent_title_rule}"
    return prompt


def build_image2_dynamic_user_message(
    *,
    title: str,
    content: str,
    product_brief: Optional[Dict[str, Any]] = None,
    dynamic_style_params: Optional[Dict[str, Any]] = None,
) -> str:
    note_content = f"标题：{(title or '').strip() or '未提供标题'}\n\n正文：\n{_clip_text(content, VISUAL_PROMPT_MAX_CONTENT_CHARS) or '无正文'}"
    
    product_context = ""
    if product_brief:
        product_analysis = analyze_product_brief(product_brief)
        product_context = f"""
# 产品背景信息:
- 产品名称: {product_analysis["product_name"]}
- 目标人群: {product_analysis["target_audience"]}
- 核心特点: {product_analysis["product_features"]}
- 系统初步产品类型判断: {product_analysis["market_type"]}
- 判断依据: {product_analysis["evidence"]}
请结合上述产品类型判断继续深度解析该产品是 To-B (如SaaS、SCRM、企业服务) 还是 To-C。即使是 To-B，也要做成适合小红书阅读的软件/工具类信息图，不要做成企业 BI 大屏、复杂仪表盘或传统企业宣传海报。
"""
    
    intent_parts = []
    user_intent = ""
    # 彻底废弃对概念表达 style（如“温暖渐变卡片”）的依赖
    
    if dynamic_style_params:
        if "intent" in dynamic_style_params:
            intent = extract_dynamic_user_intent(dynamic_style_params)
            if intent:
                user_intent = intent
                intent_parts.append(f"- 补充意图: {intent}")
        if "color" in dynamic_style_params:
            intent_parts.append(f"- 颜色偏好: {dynamic_style_params['color']}")
        if "vibe" in dynamic_style_params:
            intent_parts.append(f"- 氛围偏好: {dynamic_style_params['vibe']}")
        if "layout" in dynamic_style_params:
            intent_parts.append(f"- 版式偏好: {dynamic_style_params['layout']}")
        if "element" in dynamic_style_params:
            intent_parts.append(f"- 核心元素: {dynamic_style_params['element']}")
            
    style_preset = _resolve_style_expression_preset(dynamic_style_params)
    if style_preset:
        intent_parts.append(f"- 风格预设: {style_preset['label']}")

    intent_str = "\n".join(intent_parts) if intent_parts else "- 默认采用清晰、高级、适合软件/工具类小红书的信息型视觉；让 image2 在轻约束下自然选择风格，不要过度炫技。"
    intent_guidance = _build_dynamic_intent_guidance(user_intent)
    style_guidance = _build_style_expression_guidance(style_preset)
    guidance_parts = [intent_str]
    if intent_guidance:
        guidance_parts.append(intent_guidance)
    if style_guidance:
        guidance_parts.append(style_guidance)
    intent_section = "\n".join(guidance_parts)
    
    return f"""# 用户笔记内容:
{note_content}
{product_context}
---
# 用户的风格与排版期望:
{intent_section}

请先规划图片数量和每张图的角色，再输出轻约束 image2 提示词。提示词要短、清晰、可执行，不要工程化堆词。
""".strip()

def build_image2_dynamic_messages(
    *,
    title: str,
    content: str,
    product_brief: Optional[Dict[str, Any]] = None,
    dynamic_style_params: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str]:
    return build_image2_dynamic_system_prompt(), build_image2_dynamic_user_message(
        title=title,
        content=content,
        product_brief=product_brief,
        dynamic_style_params=dynamic_style_params
    )
