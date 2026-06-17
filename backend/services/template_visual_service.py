from __future__ import annotations

from html import escape
from typing import Any, Dict, List, Optional
from urllib.parse import quote
from uuid import uuid4


CANVAS_WIDTH = 1080
CANVAS_HEIGHT = 1440
DEFAULT_TEMPLATE_KIND = "feature_hero"
DEFAULT_STYLE_VARIANTS: Dict[str, str] = {
    "feature_hero": "freeform_stage",
    "benefit_grid": "highlight_screenshot_grid",
    "step_guide": "step_text_image",
}
DEFAULT_FRAME_STYLES: Dict[str, str] = {
    "feature_hero": "soft_gradient_card",
    "benefit_grid": "soft_gradient_card",
    "step_guide": "soft_gradient_card",
}
TEMPLATE_KINDS = {
    "feature_hero",
    "step_guide",
    "benefit_grid",
    "before_after",
    "faq_card",
}

FEATURE_KEYWORD_GROUPS: Dict[str, List[str]] = {
    "一键导入": ["一键导入", "内容导入", "素材导入", "导入素材", "导入内容", "导入页", "导入功能", "文章导入", "公众号导入", "飞书导入", "notion导入", "本地上传", "复制粘贴"],
    "AI写作": ["AI写作", "AI辅助写作", "AI辅助", "AI整理表达", "AI整理", "写作工具栏", "智能写作", "标题开头", "提重点", "文案整理", "理顺标题", "补开头"],
    "智能排版": ["智能排版", "AI排版", "自动排版", "一键排版", "排版成稿", "智能成稿", "正文结构", "结构识别"],
    "自动分页": ["自动分页", "模板分页", "分页成稿", "分页排版", "分页页", "分页功能", "卡片分页", "分页", "分镜", "多页"],
    "违规检测": ["违规检测", "风险检测", "风险检查", "发前检查", "发布检查", "发布前检测", "发布前检查", "检测页", "检查页", "敏感词", "敏感词检测", "小红书检测"],
    "模板": ["模板", "模板库", "套模板", "版式模板", "风格模板", "模板套用", "套用模板"],
    "水印": ["水印", "添加水印", "品牌水印", "卡片水印", "素材保护"],
    "销售订单": ["销售订单", "订单管理", "订单后台", "订单页面", "销售单", "成交订单"],
    "客户管理": ["客户管理", "客户列表", "客户画像", "客户资料", "用户管理"],
    "数据看板": ["数据看板", "经营看板", "销售看板", "分析看板", "统计报表", "数据报表", "分析报表"],
    "渠道活码": ["渠道活码", "活码", "渠道码", "二维码活码", "员工活码", "客户活码"],
    "SOP": ["SOP", "sop", "标准作业", "自动化SOP", "跟进SOP", "SOP流程"],
    "群发": ["群发", "群发助手", "消息群发", "批量触达", "触达"],
    "任务宝": ["任务宝", "裂变", "拉新", "邀请", "助力"],
}

TEMPLATE_PACK_PRESETS: Dict[str, Dict[str, Any]] = {
    "product_feature_story": {
        "page_count": 5,
        "card_types": ["封面卡", "功能卡", "功能卡", "步骤卡", "收口卡"],
        "template_kinds": ["feature_hero", "benefit_grid", "benefit_grid", "step_guide", "feature_hero"],
        "density": "balanced",
    },
    "tutorial_steps": {
        "page_count": 6,
        "card_types": ["封面卡", "步骤卡", "步骤卡", "步骤卡", "功能卡", "收口卡"],
        "template_kinds": ["feature_hero", "step_guide", "step_guide", "step_guide", "benefit_grid", "feature_hero"],
        "density": "balanced",
    },
    "comparison_story": {
        "page_count": 4,
        "card_types": ["封面卡", "功能卡", "对比卡", "收口卡"],
        "template_kinds": ["feature_hero", "benefit_grid", "before_after", "feature_hero"],
        "density": "balanced",
    },
}

THEME_PRESETS: Dict[str, Dict[str, str]] = {
    "warm": {
        "background": "linear-gradient(180deg, #FFF7ED 0%, #FFE4E6 100%)",
        "panel": "#FFFFFF",
        "panel_soft": "#FFF1F2",
        "text": "#1F2937",
        "muted": "#6B7280",
        "accent": "#F97316",
        "accent_soft": "#FED7AA",
    },
    "cool": {
        "background": "linear-gradient(180deg, #EFF6FF 0%, #E0F2FE 100%)",
        "panel": "#FFFFFF",
        "panel_soft": "#F0F9FF",
        "text": "#0F172A",
        "muted": "#64748B",
        "accent": "#2563EB",
        "accent_soft": "#BFDBFE",
    },
    "forest": {
        "background": "linear-gradient(180deg, #F0FDF4 0%, #DCFCE7 100%)",
        "panel": "#FFFFFF",
        "panel_soft": "#ECFDF5",
        "text": "#14532D",
        "muted": "#4B5563",
        "accent": "#16A34A",
        "accent_soft": "#BBF7D0",
    },
    "graphite": {
        "background": "linear-gradient(180deg, #F8FAFC 0%, #E2E8F0 100%)",
        "panel": "#FFFFFF",
        "panel_soft": "#F1F5F9",
        "text": "#111827",
        "muted": "#6B7280",
        "accent": "#334155",
        "accent_soft": "#CBD5E1",
    },
}


def normalize_template_kind(value: Optional[str]) -> str:
    normalized = (value or "").strip().lower()
    aliases = {
        "模板拼装": DEFAULT_TEMPLATE_KIND,
        "template_compose": DEFAULT_TEMPLATE_KIND,
        "feature_hero": "feature_hero",
        "step_guide": "step_guide",
        "benefit_grid": "benefit_grid",
        "before_after": "before_after",
        "faq_card": "faq_card",
    }
    resolved = aliases.get(normalized, normalized or DEFAULT_TEMPLATE_KIND)
    return resolved if resolved in TEMPLATE_KINDS else DEFAULT_TEMPLATE_KIND


def resolve_style_variant(template_kind: str, card_type: Optional[str] = None) -> Optional[str]:
    if template_kind == "feature_hero" and card_type in {"封面卡", "收口卡"}:
        return "text_cover_bold"
    return DEFAULT_STYLE_VARIANTS.get(template_kind)


def resolve_frame_style(template_kind: str) -> Optional[str]:
    return DEFAULT_FRAME_STYLES.get(template_kind)


def build_default_style_slots(style_variant: Optional[str]) -> Dict[str, str]:
    if style_variant == "text_cover_bold":
        return {
            "brandText": "品牌名",
            "topRightText": "系列封面",
            "stickerText": "重点速看",
            "introPrefix": "这组图会讲清楚：",
            "introEmoji": "",
            "bottomLabel": "继续往下看",
            "bottomHeadline": "核心内容在后面",
        }
    return {}


def _split_text_items(value: str, limit: int = 6) -> List[str]:
    if not value:
        return []
    chunks = []
    for raw in value.replace("；", "\n").replace("。", "\n").replace("|", "\n").splitlines():
        item = raw.strip(" \t-•·0123456789、.：:")
        if item:
            chunks.append(item)
    deduped: List[str] = []
    for item in chunks:
        if item not in deduped:
            deduped.append(item)
    return deduped[:limit]


def _short_text(value: str, limit: int) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _extract_feature_labels(value: str) -> List[str]:
    lowered = (value or "").lower()
    labels: List[str] = []
    for label, aliases in FEATURE_KEYWORD_GROUPS.items():
        if any(alias.lower() in lowered for alias in aliases):
            labels.append(label)
    if "自动分页" in labels and "模板" in labels:
        labels = [label for label in labels if label != "模板"]
    return labels


def _merge_unique_texts(*groups: List[str]) -> List[str]:
    merged: List[str] = []
    for group in groups:
        for item in group:
            text = str(item or "").strip()
            if text and text not in merged:
                merged.append(text)
    return merged


def _pick_theme(brand_style: Optional[str]) -> str:
    text = (brand_style or "").lower()
    if any(keyword in text for keyword in ("企业", "专业", "蓝", "科技", "扁平")):
        return "cool"
    if any(keyword in text for keyword in ("森林", "绿色", "自然", "清新")):
        return "forest"
    if any(keyword in text for keyword in ("极简", "黑白", "灰", "高级")):
        return "graphite"
    return "warm"


def recommend_template_kinds(content: str, reference_assets: Optional[List[Dict[str, Any]]] = None) -> List[str]:
    asset_count = len(reference_assets or [])
    text = (content or "").lower()
    if asset_count >= 2 or any(keyword in text for keyword in ("步骤", "第一步", "第二步", "教程", "流程")):
        return ["step_guide", "benefit_grid", "feature_hero"]
    if any(keyword in text for keyword in ("对比", "前后", "之前", "之后", "before", "after")):
        return ["before_after", "benefit_grid", "feature_hero"]
    if any(keyword in text for keyword in ("问题", "faq", "常见", "答疑")):
        return ["faq_card", "benefit_grid", "feature_hero"]
    return ["feature_hero", "benefit_grid", "step_guide"]


def build_note_visual_plan(
    *,
    title: str,
    content: str,
    product_name: str,
    target_audience: str,
    product_features: str,
    reference_assets: Optional[List[Dict[str, Any]]] = None,
    note_strategy: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    content_items = _split_text_items(content, limit=8)
    product_feature_items = _split_text_items(product_features, limit=8)
    strategy_benefits = [
        str(item).strip()
        for item in list((note_strategy or {}).get("coreBenefits") or [])
        if str(item).strip()
    ]
    strategy_recommended_cards = [
        str(item).strip()
        for item in list((note_strategy or {}).get("recommendedCardPlan") or [])
        if str(item).strip()
    ]
    all_context_text = " ".join([
        title or "",
        content or "",
        product_name or "",
        product_features or "",
        " ".join(strategy_benefits),
        " ".join(strategy_recommended_cards),
    ])
    feature_labels = _extract_feature_labels(all_context_text)
    feature_keywords = ("功能", "后台", "页面", "截图", "活码", "客户", "数据", "看板", "导入", "写作", "排版", "分页", "模板", "违规", "检测", "检查", "敏感词", "水印", "群发", "任务宝", "sop", "SOP", "教程", "步骤", "流程", "怎么用", "操作")
    is_feature_driven_note = bool(feature_labels) or any(keyword in all_context_text for keyword in feature_keywords)
    bullet_candidates = content_items or product_feature_items
    card_plan: List[Dict[str, Any]] = []
    visual_direction = str((note_strategy or {}).get("visualDirection") or "").lower()
    strategy_pain_points = [
        str(item).strip()
        for item in list((note_strategy or {}).get("corePainPoints") or [])
        if str(item).strip()
    ]
    if is_feature_driven_note:
        bullet_candidates = _merge_unique_texts(feature_labels, strategy_benefits, strategy_recommended_cards, bullet_candidates, product_feature_items)

    card_plan.append({
        "card_type": "封面卡",
        "template_kind": "feature_hero",
        "title": _short_text(title or product_name or "产品功能介绍", 24),
        "summary": _short_text(content or product_features or f"{product_name} 亮点速览", 42),
    })

    if is_feature_driven_note:
        max_feature_cards = 4 if len(bullet_candidates) >= 4 else 3
        for feature in bullet_candidates[:max_feature_cards]:
            card_plan.append({
                "card_type": "功能卡",
                "template_kind": "benefit_grid",
                "title": _short_text(feature, 22),
                "summary": _short_text(f"{feature}，适合 {target_audience or '目标用户'}", 42),
            })
    else:
        for point in bullet_candidates[:3]:
            card_plan.append({
                "card_type": "观点卡",
                "template_kind": "benefit_grid",
                "title": _short_text(point, 22),
                "summary": _short_text(point, 42),
            })

    if visual_direction == "tutorial" or any(keyword in content for keyword in ("步骤", "教程", "流程", "第一步")):
        steps = _split_text_items(content, limit=4) or bullet_candidates[:4]
        for idx, step in enumerate(steps[:3], start=1):
            card_plan.append({
                "card_type": "步骤卡",
                "template_kind": "step_guide",
                "title": f"步骤 {idx}",
                "summary": _short_text(step, 38),
            })

    if visual_direction == "general" and strategy_pain_points:
        card_plan.append({
            "card_type": "功能卡",
            "template_kind": "benefit_grid",
            "title": "为什么值得看",
            "summary": _short_text(" / ".join(strategy_pain_points[:2]), 38),
        })

    if any(keyword in content for keyword in ("对比", "之前", "之后", "before", "after")):
        card_plan.append({
            "card_type": "对比卡",
            "template_kind": "before_after",
            "title": "新旧方式对比",
            "summary": "用一张对比图讲清楚升级前后差异",
        })

    card_plan.append({
        "card_type": "收口卡",
        "template_kind": "feature_hero",
        "title": "适合谁用",
        "summary": _short_text(target_audience or f"适合正在关注 {product_name} 的用户", 38),
    })

    return {
        "cover_claim": _short_text(title or product_name or "产品功能介绍", 26),
        "intro_hook": _short_text(content or product_features or f"{product_name} 的核心卖点", 46),
        "card_plan": card_plan[:6],
    }


def resolve_template_pack_key(note_visual_plan: Optional[Dict[str, Any]], content: str = "") -> str:
    card_plan = list((note_visual_plan or {}).get("card_plan") or [])
    card_types = [str(item.get("card_type") or "") for item in card_plan]
    text = (content or "").lower()
    if "对比卡" in card_types or any(keyword in text for keyword in ("对比", "before", "after", "之前", "之后")):
        return "comparison_story"
    if card_types.count("步骤卡") >= 2 or any(keyword in text for keyword in ("步骤", "教程", "流程", "第一步")):
        return "tutorial_steps"
    return "product_feature_story"


def _resolve_primary_asset(reference_assets: Optional[List[Dict[str, Any]]], primary_reference_asset_id: Optional[str]) -> Optional[Dict[str, Any]]:
    assets = [asset for asset in (reference_assets or []) if isinstance(asset, dict)]
    if not assets:
        return None
    if primary_reference_asset_id:
        matched = next((asset for asset in assets if str(asset.get("id") or "") == str(primary_reference_asset_id)), None)
        if matched:
            return matched
    return assets[0]


def _build_screenshots(reference_assets: Optional[List[Dict[str, Any]]], primary_reference_asset_id: Optional[str]) -> List[Dict[str, Any]]:
    primary = _resolve_primary_asset(reference_assets, primary_reference_asset_id)
    assets = [asset for asset in (reference_assets or []) if isinstance(asset, dict)]
    ordered = []
    if primary:
        ordered.append(primary)
    for asset in assets:
        if primary and asset.get("id") == primary.get("id"):
            continue
        ordered.append(asset)
    screenshots: List[Dict[str, Any]] = []
    for index, asset in enumerate(ordered[:3], start=1):
        screenshots.append({
            "assetId": asset.get("id"),
            "url": asset.get("url"),
            "label": asset.get("original_name") or f"截图 {index}",
            "width": asset.get("width"),
            "height": asset.get("height"),
            "crop": {"x": 50, "y": 50, "zoom": 1},
        })
    return screenshots


def _pick_card_screenshots(
    template_kind: str,
    screenshots: List[Dict[str, Any]],
    index: int,
) -> List[Dict[str, Any]]:
    if not screenshots:
        return []
    if template_kind == "before_after":
        if len(screenshots) >= 2:
            return screenshots[:2]
        return screenshots[:1]
    if template_kind == "step_guide":
        return screenshots[: min(3, len(screenshots))]
    if template_kind == "feature_hero":
        return screenshots[index % len(screenshots):] + screenshots[: index % len(screenshots)]
    return screenshots[:1]


def _normalize_card_plan(
    visual_plan: Dict[str, Any],
    *,
    card_count_limit: Optional[int],
    template_pack_key: str,
) -> List[Dict[str, Any]]:
    preset = TEMPLATE_PACK_PRESETS.get(template_pack_key, TEMPLATE_PACK_PRESETS["product_feature_story"])
    input_plan = list(visual_plan.get("card_plan") or [])

    if not input_plan:
        input_plan = [
            {
                "card_type": card_type,
                "template_kind": template_kind,
                "title": "",
                "summary": "",
            }
            for card_type, template_kind in zip(preset["card_types"], preset["template_kinds"])
        ]

    normalized: List[Dict[str, Any]] = []
    for index, item in enumerate(input_plan):
        preset_kind = preset["template_kinds"][index] if index < len(preset["template_kinds"]) else None
        preset_type = preset["card_types"][index] if index < len(preset["card_types"]) else "功能卡"
        normalized.append({
            "card_type": item.get("card_type") or preset_type,
            "template_kind": normalize_template_kind(str(item.get("template_kind") or preset_kind or DEFAULT_TEMPLATE_KIND)),
            "title": _short_text(str(item.get("title") or ""), 24),
            "summary": _short_text(str(item.get("summary") or ""), 42),
        })

    if len(normalized) < 3:
        while len(normalized) < 3:
            index = len(normalized)
            normalized.append({
                "card_type": preset["card_types"][min(index, len(preset["card_types"]) - 1)],
                "template_kind": preset["template_kinds"][min(index, len(preset["template_kinds"]) - 1)],
                "title": "",
                "summary": "",
            })

    normalized[0]["card_type"] = "封面卡"
    normalized[0]["template_kind"] = "feature_hero"
    normalized[-1]["card_type"] = "收口卡"
    normalized[-1]["template_kind"] = "feature_hero"

    limit = max(3, min(card_count_limit or preset["page_count"], 6))
    return normalized[:limit]


def _build_slots(template_kind: str, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    slots: List[Dict[str, Any]] = [
        {"type": "title", "content": payload["title"]},
        {"type": "subtitle", "content": payload["subtitle"]},
        {"type": "background_shape", "theme": payload["themeKey"]},
    ]
    if payload.get("screenshots"):
        slots.append({"type": "screenshot_frame", "content": payload["screenshots"]})
    if template_kind == "step_guide":
        slots.append({"type": "step_list", "content": payload["steps"]})
    elif template_kind == "benefit_grid":
        slots.append({"type": "feature_grid", "content": payload["features"]})
    elif template_kind == "before_after":
        slots.append({"type": "before_after", "content": payload["screenshots"][:2]})
    elif template_kind == "faq_card":
        slots.append({"type": "bullet_list", "content": payload["faqItems"]})
    else:
        slots.append({"type": "bullet_list", "content": payload["bullets"]})
    slots.append({"type": "cta_badge", "content": payload["ctaText"]})
    return slots


def render_template_svg_data_url(payload: Dict[str, Any]) -> str:
    theme = THEME_PRESETS.get(payload.get("themeKey"), THEME_PRESETS["warm"])
    density = payload.get("density") or "balanced"
    compact = density == "compact"
    title = escape(payload.get("title") or "")
    subtitle = escape(payload.get("subtitle") or "")
    cta_text = escape(payload.get("ctaText") or "")
    screenshots = payload.get("screenshots") or []
    screenshot = screenshots[0] if screenshots else None
    second_screenshot = screenshots[1] if len(screenshots) > 1 else None

    def _feature_cards(items: List[Dict[str, Any]]) -> str:
        cards = []
        for item in items[:4]:
            cards.append(
                f"""
                <div style="flex:1 1 0;min-width:0;border-radius:24px;background:{theme['panel_soft']};padding:22px 18px;">
                  <div style="font-size:20px;font-weight:800;color:{theme['text']};line-height:1.3;">{escape(item.get('title') or '')}</div>
                  <div style="margin-top:10px;font-size:14px;line-height:1.6;color:{theme['muted']};">{escape(item.get('description') or '')}</div>
                </div>
                """
            )
        return "".join(cards)

    def _bullet_items(items: List[str]) -> str:
        bullets = []
        for item in items[:4]:
            bullets.append(
                f"""
                <div style="display:flex;align-items:flex-start;gap:12px;">
                  <div style="margin-top:6px;width:10px;height:10px;border-radius:999px;background:{theme['accent']};flex:0 0 auto;"></div>
                  <div style="font-size:18px;line-height:1.65;color:{theme['text']};font-weight:600;">{escape(item)}</div>
                </div>
                """
            )
        return "".join(bullets)

    def _step_items(items: List[Dict[str, str]]) -> str:
        steps = []
        for index, item in enumerate(items[:4], start=1):
            steps.append(
                f"""
                <div style="display:flex;gap:14px;padding:18px 0;border-top:{'none' if index == 1 else '1px solid rgba(15,23,42,0.08)'};">
                  <div style="width:36px;height:36px;border-radius:999px;background:{theme['accent_soft']};color:{theme['accent']};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;flex:0 0 auto;">{index}</div>
                  <div>
                    <div style="font-size:18px;font-weight:800;color:{theme['text']};">步骤 {index}</div>
                    <div style="margin-top:6px;font-size:15px;line-height:1.7;color:{theme['muted']};">{escape(item.get('description') or item.get('title') or '')}</div>
                  </div>
                </div>
                """
            )
        return "".join(steps)

    body_html = ""
    template_kind = payload.get("templateKind") or DEFAULT_TEMPLATE_KIND
    if template_kind == "benefit_grid":
        body_html = f"""
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;">
            {_feature_cards(payload.get("features") or [])}
          </div>
        """
    elif template_kind == "step_guide":
        body_html = f"""
          <div style="border-radius:28px;background:{theme['panel']};padding:{'24px' if compact else '30px'};box-shadow:0 20px 45px rgba(15,23,42,0.08);">
            {_step_items(payload.get("steps") or [])}
          </div>
        """
    elif template_kind == "before_after":
        before = screenshot
        after = second_screenshot or screenshot
        body_html = f"""
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;">
            <div style="border-radius:28px;background:{theme['panel']};padding:16px;box-shadow:0 20px 45px rgba(15,23,42,0.08);">
              <div style="font-size:18px;font-weight:800;color:{theme['text']};margin-bottom:10px;">之前</div>
              <div style="border-radius:20px;overflow:hidden;background:#E5E7EB;height:320px;">
                <img src="{escape((before or {}).get('url') or '')}" style="width:100%;height:100%;object-fit:cover;object-position:center;" />
              </div>
            </div>
            <div style="border-radius:28px;background:{theme['panel']};padding:16px;box-shadow:0 20px 45px rgba(15,23,42,0.08);">
              <div style="font-size:18px;font-weight:800;color:{theme['text']};margin-bottom:10px;">之后</div>
              <div style="border-radius:20px;overflow:hidden;background:#E5E7EB;height:320px;">
                <img src="{escape((after or {}).get('url') or '')}" style="width:100%;height:100%;object-fit:cover;object-position:center;" />
              </div>
            </div>
          </div>
        """
    elif template_kind == "faq_card":
        body_html = f"""
          <div style="display:flex;flex-direction:column;gap:14px;">
            {_feature_cards(payload.get("faqItems") or [])}
          </div>
        """
    else:
        body_html = f"""
          <div style="display:grid;grid-template-columns:{'1.1fr 0.9fr' if screenshot else '1fr'};gap:20px;align-items:stretch;">
            <div style="display:flex;flex-direction:column;gap:16px;">
              {_bullet_items(payload.get("bullets") or [])}
            </div>
            {f'''
            <div style="border-radius:32px;background:{theme['panel']};padding:14px;box-shadow:0 20px 45px rgba(15,23,42,0.08);">
              <div style="border-radius:24px;overflow:hidden;background:#E5E7EB;height:100%;">
                <img src="{escape(screenshot.get('url') or '')}" style="width:100%;height:100%;object-fit:cover;object-position:center;" />
              </div>
            </div>
            ''' if screenshot else ''}
          </div>
        """

    screenshot_strip = ""
    if template_kind == "step_guide" and screenshots:
        cards = []
        for shot in screenshots[:3]:
            cards.append(
                f"""
                <div style="flex:1 1 0;border-radius:22px;overflow:hidden;background:{theme['panel']};padding:10px;box-shadow:0 16px 35px rgba(15,23,42,0.08);">
                  <div style="border-radius:16px;overflow:hidden;height:180px;background:#E5E7EB;">
                    <img src="{escape(shot.get('url') or '')}" style="width:100%;height:100%;object-fit:cover;object-position:center;" />
                  </div>
                </div>
                """
            )
        screenshot_strip = f'<div style="display:flex;gap:12px;margin-top:18px;">{"".join(cards)}</div>'

    svg = f"""
<svg xmlns="http://www.w3.org/2000/svg" width="{CANVAS_WIDTH}" height="{CANVAS_HEIGHT}" viewBox="0 0 {CANVAS_WIDTH} {CANVAS_HEIGHT}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:{CANVAS_WIDTH}px;height:{CANVAS_HEIGHT}px;box-sizing:border-box;background:{theme['background']};padding:{'56px' if compact else '72px'} 60px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:inline-flex;align-items:center;gap:10px;border-radius:999px;padding:10px 18px;background:{theme['accent_soft']};color:{theme['accent']};font-size:20px;font-weight:800;">模板拼装</div>
        <div></div>
      </div>
      <div style="margin-top:28px;font-size:{'58px' if compact else '68px'};font-weight:900;line-height:1.1;color:{theme['text']};letter-spacing:-0.04em;">{title}</div>
      <div style="margin-top:18px;font-size:{'24px' if compact else '28px'};line-height:1.55;color:{theme['muted']};font-weight:600;">{subtitle}</div>
      <div style="margin-top:34px;flex:1 1 auto;border-radius:36px;background:{theme['panel']};padding:{'28px' if compact else '36px'};box-shadow:0 24px 60px rgba(15,23,42,0.08);display:flex;flex-direction:column;justify-content:space-between;">
        <div>{body_html}{screenshot_strip}</div>
        <div style="margin-top:22px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div style="max-width:70%;font-size:18px;line-height:1.6;color:{theme['muted']};font-weight:600;">{escape(payload.get('footerNote') or '')}</div>
          <div style="display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:16px 26px;background:{theme['accent']};color:#FFFFFF;font-size:20px;font-weight:800;box-shadow:0 14px 30px rgba(15,23,42,0.15);white-space:nowrap;">{cta_text}</div>
        </div>
      </div>
    </div>
  </foreignObject>
</svg>
""".strip()
    return f"data:image/svg+xml;charset=UTF-8,{quote(svg)}"


def compose_template_payload(
    *,
    title: str,
    content: str,
    product_brief: Optional[Dict[str, Any]],
    reference_assets: Optional[List[Dict[str, Any]]],
    primary_reference_asset_id: Optional[str],
    template_kind: Optional[str],
    brand_style: Optional[str],
    note_visual_plan: Optional[Dict[str, Any]] = None,
    card_type: Optional[str] = None,
) -> Dict[str, Any]:
    product_brief = product_brief or {}
    visual_plan = note_visual_plan or build_note_visual_plan(
        title=title,
        content=content,
        product_name=str(product_brief.get("product_name") or ""),
        target_audience=str(product_brief.get("target_audience") or ""),
        product_features=str(product_brief.get("product_features") or ""),
        reference_assets=reference_assets,
    )
    recommended_kinds = recommend_template_kinds(content, reference_assets=reference_assets)
    resolved_template_kind = normalize_template_kind(template_kind or recommended_kinds[0])
    style_variant = resolve_style_variant(resolved_template_kind, card_type)
    frame_style = resolve_frame_style(resolved_template_kind)
    theme_key = _pick_theme(brand_style)
    screenshots = _build_screenshots(reference_assets, primary_reference_asset_id)
    bullet_source = _split_text_items(str(product_brief.get("product_features") or content), limit=4)
    step_source = _split_text_items(content, limit=4) or bullet_source[:4]

    editable_payload = {
        "version": 1,
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "templateKind": resolved_template_kind,
        "styleVariant": style_variant,
        "frameStyle": frame_style,
        "brandStyle": brand_style or "",
        "themeKey": theme_key,
        "density": "balanced",
        "badgeText": "模板拼装",
        "title": _short_text(visual_plan.get("cover_claim") or title or "产品介绍图", 26),
        "subtitle": _short_text(visual_plan.get("intro_hook") or content or "用结构化卡片讲清楚产品价值", 56),
        "ctaText": "立即查看",
        "footerNote": _short_text((product_brief.get("target_audience") or "") and f"适合：{product_brief.get('target_audience')}" or "适合产品介绍、功能说明、步骤拆解场景", 36),
        "bullets": bullet_source[:4],
        "features": [
            {"title": _short_text(item, 18), "description": _short_text(item, 28)}
            for item in bullet_source[:4]
        ],
        "steps": [
            {"title": f"步骤 {index}", "description": _short_text(item, 34)}
            for index, item in enumerate(step_source[:4], start=1)
        ],
        "faqItems": [
            {"title": f"Q{index}", "description": _short_text(item, 34)}
            for index, item in enumerate(step_source[:4], start=1)
        ],
        "screenshots": screenshots,
        "noteVisualPlan": visual_plan,
        "styleSlots": build_default_style_slots(style_variant),
    }
    slots = _build_slots(resolved_template_kind, editable_payload)
    rendered_image_url = render_template_svg_data_url(editable_payload)

    return {
        "canvas": {"width": CANVAS_WIDTH, "height": CANVAS_HEIGHT},
        "template_kind": resolved_template_kind,
        "recommended_template_kinds": recommended_kinds,
        "slots": slots,
        "rendered_image_url": rendered_image_url,
        "editable_payload": editable_payload,
        "note_visual_plan": visual_plan,
    }


def compose_template_series_payload(
    *,
    title: str,
    content: str,
    product_brief: Optional[Dict[str, Any]],
    reference_assets: Optional[List[Dict[str, Any]]],
    primary_reference_asset_id: Optional[str],
    brand_style: Optional[str],
    note_visual_plan: Optional[Dict[str, Any]] = None,
    card_count_limit: Optional[int] = None,
) -> Dict[str, Any]:
    product_brief = product_brief or {}
    visual_plan = note_visual_plan or build_note_visual_plan(
        title=title,
        content=content,
        product_name=str(product_brief.get("product_name") or ""),
        target_audience=str(product_brief.get("target_audience") or ""),
        product_features=str(product_brief.get("product_features") or ""),
        reference_assets=reference_assets,
    )
    template_pack_key = resolve_template_pack_key(visual_plan, content)
    theme_key = _pick_theme(brand_style)
    all_screenshots = _build_screenshots(reference_assets, primary_reference_asset_id)
    card_plan = _normalize_card_plan(
        visual_plan,
        card_count_limit=card_count_limit,
        template_pack_key=template_pack_key,
    )
    project_id = f"visual-project-{uuid4().hex[:10]}"
    cards: List[Dict[str, Any]] = []

    for index, card in enumerate(card_plan):
        card_title = str(card.get("title") or "")
        card_summary = str(card.get("summary") or "")
        payload = compose_template_payload(
            title=card_title or title,
            content=card_summary or content,
            product_brief=product_brief,
            reference_assets=reference_assets,
            primary_reference_asset_id=primary_reference_asset_id,
            template_kind=card.get("template_kind"),
            brand_style=brand_style,
            note_visual_plan=visual_plan,
            card_type=card.get("card_type"),
        )
        screenshots = _pick_card_screenshots(payload["template_kind"], all_screenshots, index)
        payload["editable_payload"]["screenshots"] = screenshots
        payload["editable_payload"]["title"] = card_title or payload["editable_payload"]["title"]
        payload["editable_payload"]["subtitle"] = card_summary or payload["editable_payload"]["subtitle"]
        payload["editable_payload"]["themeKey"] = theme_key
        payload["editable_payload"]["styleVariant"] = resolve_style_variant(payload["template_kind"], card.get("card_type"))
        payload["editable_payload"]["frameStyle"] = resolve_frame_style(payload["template_kind"])
        payload["editable_payload"]["styleSlots"] = build_default_style_slots(payload["editable_payload"].get("styleVariant"))
        payload["editable_payload"]["density"] = TEMPLATE_PACK_PRESETS.get(template_pack_key, TEMPLATE_PACK_PRESETS["product_feature_story"])["density"]
        payload["rendered_image_url"] = render_template_svg_data_url(payload["editable_payload"])
        payload["slots"] = _build_slots(payload["template_kind"], payload["editable_payload"])

        rendered_asset = {
            "id": f"{project_id}-card-{index + 1}",
            "url": payload["rendered_image_url"],
            "sourceType": "template_compose",
            "mode": "模板拼装",
            "promptLabel": card.get("card_type") or f"第 {index + 1} 页",
            "promptText": card_summary or card_title or "",
            "variantKey": payload["template_kind"],
            "styleVariant": payload["editable_payload"].get("styleVariant"),
            "layoutFamily": "template_compose",
            "visualFocus": card.get("card_type") or "组图模板页",
            "visualModeResolved": "template_compose",
            "templateKind": payload["template_kind"],
            "editablePayload": payload["editable_payload"],
            "referenceAssetIds": [item.get("assetId") for item in screenshots if item.get("assetId")],
            "isProcessing": False,
        }
        cards.append({
            "cardId": f"{project_id}-card-{index + 1}",
            "cardType": card.get("card_type") or f"第 {index + 1} 页",
            "templateKind": payload["template_kind"],
            "title": payload["editable_payload"]["title"],
            "summary": payload["editable_payload"]["subtitle"],
            "document": payload.get("document"),
            "renderedAsset": rendered_asset,
            "status": "draft",
            "sourceRefs": rendered_asset["referenceAssetIds"],
            "composeResult": payload,
        })

    for card in cards:
        if not card.get("document"):
            card["document"] = {
                "id": card["cardId"],
                "canvas": card["composeResult"]["canvas"],
                "templateKind": card["composeResult"]["editable_payload"]["templateKind"],
                "styleVariant": card["composeResult"]["editable_payload"].get("styleVariant"),
                "theme": card["composeResult"]["editable_payload"]["themeKey"],
                "density": card["composeResult"]["editable_payload"]["density"],
                "modules": [],
                "assets": card["composeResult"]["editable_payload"]["screenshots"],
                "noteVisualPlan": visual_plan,
                "renderVersion": 1,
                "meta": {
                    "title": card["title"],
                    "subtitle": card["summary"],
                    "ctaText": card["composeResult"]["editable_payload"].get("ctaText"),
                    "footerNote": card["composeResult"]["editable_payload"].get("footerNote"),
                    "brandStyle": brand_style or "",
                },
            }

    project = {
        "projectId": project_id,
        "title": title,
        "body": content,
        "noteVisualPlan": visual_plan,
        "cards": [
            {
                key: value
                for key, value in card.items()
                if key != "composeResult"
            }
            for card in cards
        ],
        "coverCardId": cards[0]["cardId"] if cards else "",
        "activeCardId": cards[0]["cardId"] if cards else "",
        "templatePackKey": template_pack_key,
        "brandStyle": brand_style or "",
        "status": "draft",
    }

    return {
        "project": project,
        "cards": project["cards"],
        "note_visual_plan": visual_plan,
        "template_pack_key": template_pack_key,
    }
