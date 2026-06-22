from __future__ import annotations

import html
import ipaddress
import json
import logging
import re
import time
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

import httpx
from openai import OpenAI

from backend.services.content_analyzer import (
    get_text_generation_config_candidates,
    get_text_generation_model,
    get_text_generation_model_candidates,
    is_retryable_text_generation_error,
    resolve_text_generation_config,
)
from backend.utils.ai_parser import clean_and_parse_ai_json

logger = logging.getLogger(__name__)

PRODUCT_USAGE_MAIN = "product_main"
PRODUCT_USAGE_ASSIST = "product_assist"
PRODUCT_USAGE_NONE = "no_product"
NOTE_STRATEGY_MODEL_MAX_ATTEMPTS = 4
NOTE_STRATEGY_MODEL_RETRY_BACKOFF_SECONDS = 3
ABSTRACT_STRATEGY_LABEL_SUFFIXES = ("型", "法", "框架", "路径", "模型", "模板")
ABSTRACT_STRATEGY_LABEL_RE = re.compile(r"(?:^|[｜|：:\s])[\u4e00-\u9fffA-Za-z0-9]{2,18}(?:型|法|框架|路径|模型|模板)(?:[｜|：:\s]|$)")
LABEL_NATURAL_TITLE_MARKERS = ("为什么", "怎么", "如何", "不是", "别", "真的", "到底", "？", "?", "，", "、")
AWKWARD_STRATEGY_LABEL_RE = re.compile(r"(?:更|很|非常|特别|尤其|最){1,2}最")
AWKWARD_STRATEGY_PHRASE_REPLACEMENTS = {
    "投了渠道却接不住客户": "投了很多渠道，但客户进来后没人及时跟进",
    "渠道热闹但成交安静": "渠道数据看着热闹，但真正成交的客户不清楚",
}


def _build_strategy_creative_run_id() -> str:
    """A lightweight per-run seed for prompt diversity; it is not persisted."""
    return f"run-{time.time_ns() % 1_000_000_000:09d}"


def _split_text_items(value: str, limit: int = 6) -> List[str]:
    if not value:
        return []
    chunks: List[str] = []
    for raw in re.split(r"[，,、；;。\n|]+", value):
        item = raw.strip(" \t-•·0123456789、.：:")
        if item:
            chunks.append(item)
    deduped: List[str] = []
    for item in chunks:
        if item not in deduped:
            deduped.append(item)
    return deduped[:limit]


def _compact_strategy_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def _looks_like_abstract_strategy_label(value: Any) -> bool:
    text = _compact_strategy_text(value)
    if not text:
        return False
    first_part = re.split(r"[｜|：:]", text, maxsplit=1)[0].strip()
    if first_part.endswith(ABSTRACT_STRATEGY_LABEL_SUFFIXES) and len(first_part) <= 18:
        return True
    return bool(ABSTRACT_STRATEGY_LABEL_RE.search(text))


def _looks_like_compressed_strategy_label(value: Any) -> bool:
    text = _compact_strategy_text(value)
    if not text:
        return False
    if any(marker in text for marker in LABEL_NATURAL_TITLE_MARKERS):
        return False
    if len(text) <= 14 and re.search(r"(渠道|线索|客户|团队|系统|销售|员工|老板|流量|投流|咨询|私域).{0,8}(接不住|失控|断层|沉淀|承接|转化|归因|看不见|跟不上)", text):
        return True
    return False


def _looks_like_awkward_strategy_label(value: Any) -> bool:
    text = _compact_strategy_text(value)
    if not text:
        return False
    return bool(AWKWARD_STRATEGY_LABEL_RE.search(text))


def _normalize_strategy_label(label: Any, suggested_title: Any, fallback_label: Any) -> str:
    label_text = _compact_strategy_text(label)
    suggested_title_text = _compact_strategy_text(suggested_title)
    fallback_text = _compact_strategy_text(fallback_label)

    if (
        _looks_like_compressed_strategy_label(label_text)
        or _looks_like_awkward_strategy_label(label_text)
    ) and suggested_title_text:
        return suggested_title_text
    if label_text:
        return label_text
    if suggested_title_text and not _looks_like_abstract_strategy_label(suggested_title_text):
        return suggested_title_text
    if "｜" in label_text or "|" in label_text:
        tail = re.split(r"[｜|]", label_text, maxsplit=1)[1].strip()
        if tail and not _looks_like_abstract_strategy_label(tail):
            return tail
    return label_text or fallback_text


def _rewrite_awkward_strategy_phrases(value: Any) -> Any:
    if isinstance(value, list):
        return [_rewrite_awkward_strategy_phrases(item) for item in value]
    if not isinstance(value, str):
        return value
    rewritten = value
    for source, replacement in AWKWARD_STRATEGY_PHRASE_REPLACEMENTS.items():
        rewritten = rewritten.replace(source, replacement)
    return rewritten


def _normalize_strategy_content_angle(value: Any, fallback_value: Any) -> str:
    text = _compact_strategy_text(value)
    fallback_text = _compact_strategy_text(fallback_value)
    return text or fallback_text


def _strategy_visible_text(item: Dict[str, Any]) -> str:
    parts: List[str] = []
    for key in [
        "label",
        "summary",
        "targetAudience",
        "contentAngle",
        "noteGoal",
        "suggestedTitle",
        "recommendedCardPlan",
        "corePainPoints",
        "coreBenefits",
    ]:
        value = item.get(key)
        if isinstance(value, list):
            parts.extend(str(part) for part in value if str(part).strip())
        elif value:
            parts.append(str(value))
    return " ".join(parts)


def _contains_personal_ip_launch_signal(item: Dict[str, Any]) -> bool:
    text = _strategy_visible_text(item)
    lowered = text.lower()
    return bool(
        re.search(r"(?:demo|github|开源|链接).{0,18}(?:发布|放出|上线|征集|反馈)", lowered)
        or re.search(r"(?:发布|放出|上线|征集反馈).{0,18}(?:demo|github|开源|链接|作品|项目|工具)", lowered)
        or re.search(r"(?:做成|做了|先做|长出).{0,18}(?:小工具|工具|demo)", lowered)
    )


def _strip_html_to_text(raw_html: str) -> str:
    cleaned = re.sub(r"(?is)<(script|style|noscript).*?>.*?</\1>", " ", raw_html or "")
    cleaned = re.sub(r"(?i)<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"(?i)</p>|</div>|</section>|</article>|</li>|</h\d>", "\n", cleaned)
    cleaned = re.sub(r"(?s)<[^>]+>", " ", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"[ \t\r\f\v]+", " ", cleaned)
    cleaned = re.sub(r"\n{2,}", "\n", cleaned)
    return cleaned.strip()


def _extract_html_title(raw_html: str) -> str:
    match = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw_html or "")
    if match:
        return _strip_html_to_text(match.group(1))[:120]
    og_match = re.search(r'(?is)<meta[^>]+property=["\']og:title["\'][^>]+content=["\'](.*?)["\']', raw_html or "")
    if og_match:
        return _strip_html_to_text(og_match.group(1))[:120]
    return ""


def _extract_meta_description(raw_html: str) -> str:
    patterns = [
        r'(?is)<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']',
        r'(?is)<meta[^>]+property=["\']og:description["\'][^>]+content=["\'](.*?)["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, raw_html or "")
        if match:
            return _strip_html_to_text(match.group(1))[:240]
    return ""


def _is_safe_public_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return False
        hostname = parsed.hostname or ""
        lowered = hostname.lower()
        if lowered in {"localhost", "0.0.0.0"} or lowered.endswith(".local"):
            return False
        try:
            ip = ipaddress.ip_address(lowered)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False
        except ValueError:
            if re.match(r"^(10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)", lowered):
                return False
        return True
    except Exception:
        return False


def _decode_duckduckgo_result_url(raw_url: str) -> str:
    url = str(raw_url or "").strip()
    if not url:
        return ""
    parsed = urlparse(url)
    if "duckduckgo.com" in (parsed.netloc or "") and parsed.path.startswith("/l/"):
        params = parse_qs(parsed.query or "")
        uddg = params.get("uddg") or []
        if uddg:
            return unquote(uddg[0])
    if url.startswith("//"):
        return f"https:{url}"
    return url


def _contains_no_product_instruction(text: str) -> bool:
    normalized = re.sub(r"\s+", "", str(text or "").lower())
    if not normalized:
        return False
    patterns = [
        "不要参考产品",
        "不参考产品",
        "不用产品信息",
        "不要产品信息",
        "不带产品",
        "不要带产品",
        "不要出现产品",
        "不出现产品",
        "只复刻原文",
        "只复刻结构",
        "纯结构复刻",
        "不要把产品",
        "不要硬加产品",
        "不要硬塞产品",
    ]
    return any(pattern in normalized for pattern in patterns)


def _normalize_product_usage_mode(value: Any) -> str:
    raw = str(value or "").strip().lower()
    aliases = {
        "main": PRODUCT_USAGE_MAIN,
        "product_main": PRODUCT_USAGE_MAIN,
        "strong_fit": PRODUCT_USAGE_MAIN,
        "strong": PRODUCT_USAGE_MAIN,
        "主角": PRODUCT_USAGE_MAIN,
        "产品主导": PRODUCT_USAGE_MAIN,
        "assist": PRODUCT_USAGE_ASSIST,
        "product_assist": PRODUCT_USAGE_ASSIST,
        "soft_fit": PRODUCT_USAGE_ASSIST,
        "soft": PRODUCT_USAGE_ASSIST,
        "配角": PRODUCT_USAGE_ASSIST,
        "产品辅助": PRODUCT_USAGE_ASSIST,
        "none": PRODUCT_USAGE_NONE,
        "no_product": PRODUCT_USAGE_NONE,
        "no_fit": PRODUCT_USAGE_NONE,
        "no": PRODUCT_USAGE_NONE,
        "不使用": PRODUCT_USAGE_NONE,
        "不用产品": PRODUCT_USAGE_NONE,
        "纯结构复刻": PRODUCT_USAGE_NONE,
    }
    return aliases.get(raw, PRODUCT_USAGE_MAIN)


def _keyword_score(text: str, keywords: List[str]) -> int:
    lowered = str(text or "").lower()
    score = 0
    for keyword in keywords:
        if keyword and keyword.lower() in lowered:
            score += 1
    return score


def _research_context_text(research_context: Dict[str, Any]) -> str:
    parts: List[str] = []
    for key in [
        "product_name",
        "summary",
        "target_audience_insights",
        "core_features",
        "use_cases",
        "differentiators",
        "material_signals",
    ]:
        value = research_context.get(key)
        if isinstance(value, list):
            parts.extend(str(item) for item in value if str(item).strip())
        elif value:
            parts.append(str(value))
    return " ".join(parts)


def _research_context_primary_text(research_context: Dict[str, Any]) -> str:
    parts: List[str] = []
    for key in ["product_name", "summary", "core_features", "use_cases", "differentiators"]:
        value = research_context.get(key)
        if isinstance(value, list):
            parts.extend(str(item) for item in value if str(item).strip())
        elif value:
            parts.append(str(value))
    return " ".join(parts)


def _infer_account_content_route(
    research_context: Dict[str, Any],
    *,
    product_usage_mode: str,
    normalized_strategy_mode: str,
) -> Dict[str, str]:
    text = _research_context_text(research_context)
    primary_text = _research_context_primary_text(research_context)
    lowered = text.lower()
    personal_score = _keyword_score(text, [
        "个人ip", "个人 IP", "博主", "创作者", "记录者", "创始人", "独立开发者", "主理人",
        "顾问", "设计师", "教练", "真实构建", "构建日志", "判断复盘", "踩坑", "人设",
    ])
    open_source_score = _keyword_score(primary_text, [
        "github", "开源", "cli", "命令行",
    ])
    local_score = _keyword_score(text, [
        "门店", "到店", "自提", "附近", "社区", "本地", "蛋糕", "烘焙", "咖啡", "顾客反馈",
    ])
    tool_score = _keyword_score(text, [
        "工具", "app", "工作流", "一键", "导入", "分页", "水印", "违规检查", "自动", "cli",
    ])
    saas_score = _keyword_score(text, [
        "saas", "scrm", "企业微信", "企微", "私域", "客户标签", "客户画像", "生命周期", "sop",
    ])

    primary_lowered = primary_text.lower()
    open_source_is_primary = (
        open_source_score >= 1
        and re.search(r"github|开源|cli|命令行|开源项目", primary_lowered)
        and not re.search(r"发布作品时才带|热点观点文默认不带|平常.*不强行承接", lowered)
        and not re.search(r"个人ip|个人 IP|AI 博主|AI博主|记录者型|不是标准产品种草号", primary_text)
    )

    if open_source_is_primary and personal_score >= 1:
        account_type = "open_source_project"
        route_label = "个人IP宣传自己的项目/开源工具"
        default_role = "launch"
        default_intent = "launch"
        default_usage = PRODUCT_USAGE_ASSIST
        strategy_boundary = "先讲开发者为什么做、踩过什么坑、项目如何长出来；允许出现 Demo/GitHub/开源工具，但必须像项目进展或经验复盘，不写传统广告。"
        diversity_boundary = "多样化在“开发过程、发布动机、使用场景、反馈征集、开源取舍、风险提醒”里展开，不要退化成普通工具卖点清单。"
        closing_goal = "作品发布或反馈征集，产品/链接作为项目成果自然出现"
    elif personal_score >= 2:
        account_type = "personal_ip"
        route_label = "个人IP"
        default_role = "none"
        default_intent = "case_record" if normalized_strategy_mode == "research_first" else "topic_explainer"
        default_usage = PRODUCT_USAGE_NONE if normalized_strategy_mode == "research_first" else product_usage_mode
        strategy_boundary = "内容主角是人的经历、判断、冲突、过程和观点；无对标时必须输出具体可发布选题句，每条都要有具体对象/具体动作/判断冲突，不能输出“某某型/某某法/某某框架/某某路径”这类栏目名，也不能用 XX/某个/这个/那一步 这类占位表达。"
        diversity_boundary = "多样化在“真实项目过程、判断变化、踩坑复盘、砍功能、发布 Demo、热点观点、从业务问题长出工具”里展开，但每条都要落到一个具体业务场景或真实动作，例如投放复盘、内容改写、发布前检查、客户承接、工作流拆分；不要为了变化写成产品硬广或空泛方法论。"
        closing_goal = "观点收束或读者自查；除非发布 Demo/GitHub/作品，否则不硬带产品"
    elif local_score >= 2:
        account_type = "service"
        route_label = "本地门店/服务"
        default_role = "solution"
        default_intent = "problem_solution"
        default_usage = PRODUCT_USAGE_MAIN
        strategy_boundary = "内容主角是本地消费场景、口味/服务、信任理由、顾客反馈和下单/收藏理由；不要写成 SaaS 方法论或泛运营教程。"
        diversity_boundary = "多样化在“生日、下午茶、节日礼盒、低甜口味、附近自提、真实反馈、临时送礼”等消费场景里展开。"
        closing_goal = "收藏、到店、自提或下单理由"
    elif saas_score >= 2:
        account_type = "saas"
        route_label = "普通SaaS/产品"
        default_role = "solution" if product_usage_mode == PRODUCT_USAGE_MAIN else ("none" if product_usage_mode == PRODUCT_USAGE_NONE else "assist")
        default_intent = "problem_solution" if default_role == "solution" else ("topic_explainer" if default_role == "none" else "benchmark_tips")
        default_usage = product_usage_mode
        strategy_boundary = "保持现有产品策略：围绕业务痛点、具体场景、功能收益和转化承接，不要被个人IP化或门店化。"
        diversity_boundary = "多样化在“客户来源、客户标签、画像沉淀、销售交接、生命周期、SOP 跟进、活动复盘、分群触达”等业务矛盾里展开。"
        closing_goal = "按产品介入边界自然收束"
    elif tool_score >= 2:
        account_type = "tool"
        route_label = "工具/App"
        default_role = "solution" if product_usage_mode == PRODUCT_USAGE_MAIN else ("none" if product_usage_mode == PRODUCT_USAGE_NONE else "assist")
        default_intent = "tutorial" if default_role != "none" else "topic_explainer"
        default_usage = product_usage_mode
        strategy_boundary = "内容要绑定具体工作流和执行动作；如果产品只接住其中一环，必须写成用户正在做的具体动作、工具处理方式和减少的返工成本。"
        diversity_boundary = "多样化必须围绕当前产品资料里的真实工作流展开，例如资料中明确出现的操作步骤、协作节点、检查动作、复用场景或返工成本；不要借用其他工具的固定功能词。"
        closing_goal = "用具体执行动作或读者自查自然收束"
    else:
        account_type = "product"
        route_label = "通用产品/服务"
        default_role = "solution" if product_usage_mode == PRODUCT_USAGE_MAIN else ("none" if product_usage_mode == PRODUCT_USAGE_NONE else "assist")
        default_intent = "problem_solution" if default_role == "solution" else ("topic_explainer" if default_role == "none" else "benchmark_tips")
        default_usage = product_usage_mode
        strategy_boundary = "按当前产品信息生成策略，优先保持产品真实性、用户场景和承接边界。"
        diversity_boundary = "多样化必须发生在当前产品真实场景内部，不要为了变化跳到无关账号类型。"
        closing_goal = "按产品介入边界自然收束"

    if _contains_no_product_instruction(" ".join(str(item) for item in research_context.get("material_signals") or [])):
        default_role = "none"
        default_usage = PRODUCT_USAGE_NONE

    conditional_launch_mention = re.search(
        r"才.*(?:github|demo|链接|作品)|只有.*(?:github|demo|链接|作品).*才|"
        r"平常.*不.*(?:带|出现|强行)|默认不带|发布作品时才带|发布.*时才",
        lowered,
    )
    if product_usage_mode == PRODUCT_USAGE_NONE:
        default_role = "none"
        default_usage = PRODUCT_USAGE_NONE
    elif (
        account_type == "personal_ip"
        and not conditional_launch_mention
        and re.search(r"github|开源|上线|launch|发布\s*(demo|作品|项目|工具)|放出\s*(demo|作品|项目|工具)|征集反馈", primary_lowered)
    ):
        default_role = "launch"
        default_intent = "launch"
        default_usage = PRODUCT_USAGE_ASSIST

    return {
        "account_type": account_type,
        "route_label": route_label,
        "default_product_role": default_role,
        "default_content_intent": default_intent,
        "default_product_usage_mode": default_usage,
        "strategy_boundary": strategy_boundary,
        "diversity_boundary": diversity_boundary,
        "closing_goal": closing_goal,
    }


def _should_include_account_route_prompt(
    account_route: Dict[str, str],
    *,
    effective_product_usage_mode: str,
) -> bool:
    account_type = str(account_route.get("account_type") or "").strip()
    if effective_product_usage_mode in {PRODUCT_USAGE_ASSIST, PRODUCT_USAGE_NONE}:
        return True
    return account_type in {"personal_ip", "open_source_project", "tool", "service"}


class NoteStrategyService:
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
            default_headers={"Accept-Encoding": "identity"},
        )
        self.model_id = model or get_text_generation_model()

    def _normalize_reference_urls(self, raw_urls: Any) -> List[str]:
        urls = raw_urls if isinstance(raw_urls, list) else []
        normalized: List[str] = []
        for item in urls:
            url = str(item or "").strip()
            if not url:
                continue
            if not re.match(r"^https?://", url, re.IGNORECASE):
                url = f"https://{url}"
            if url not in normalized and _is_safe_public_url(url):
                normalized.append(url)
        return normalized[:3]

    def _fetch_source_document(self, url: str) -> Dict[str, Any]:
        try:
            with httpx.Client(timeout=8.0, follow_redirects=True, headers={
                "User-Agent": "Mozilla/5.0 (compatible; XHSResearchBot/1.0; +https://example.local)",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            }) as client:
                response = client.get(url)
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                    return {
                        "url": url,
                        "title": urlparse(str(response.url)).netloc or url,
                        "summary": "该链接不是标准网页，当前仅记录为资料来源。",
                        "contentSnippet": "",
                        "status": "failed",
                    }
                html_text = response.text[:500000]
        except Exception as error:
            return {
                "url": url,
                "title": urlparse(url).netloc or url,
                "summary": f"读取失败：{error}",
                "contentSnippet": "",
                "status": "failed",
            }

        title = _extract_html_title(html_text) or urlparse(url).netloc or url
        description = _extract_meta_description(html_text)
        plain_text = _strip_html_to_text(html_text)
        content_snippet = plain_text[:1200]
        summary = description or plain_text[:220] or "已成功读取页面内容。"
        return {
            "url": str(response.url),
            "title": title,
            "summary": summary,
            "contentSnippet": content_snippet,
            "status": "fetched",
        }

    def _search_public_web(self, *, product_name: str, product_features: str, target_audience: str) -> List[Dict[str, Any]]:
        queries: List[str] = []
        feature_hint = _split_text_items(product_features, limit=2)
        if product_name:
            queries.append(f"{product_name} 官网 功能")
            queries.append(f"{product_name} {' '.join(feature_hint)} {target_audience}".strip())
        else:
            return []

        results: List[Dict[str, Any]] = []
        seen_urls: set[str] = set()

        for query in queries[:2]:
            try:
                with httpx.Client(timeout=8.0, follow_redirects=True, headers={
                    "User-Agent": "Mozilla/5.0 (compatible; XHSResearchBot/1.0; +https://example.local)",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                }) as client:
                    response = client.get("https://html.duckduckgo.com/html/", params={"q": query})
                    response.raise_for_status()
                    html_text = response.text[:250000]
            except Exception:
                continue

            link_matches = re.findall(
                r'(?is)<a[^>]+class="result__a"[^>]+href="(.*?)"[^>]*>(.*?)</a>',
                html_text,
            )
            snippet_matches = re.findall(r'(?is)<a[^>]+class="result__snippet"[^>]*>(.*?)</a>|<div[^>]+class="result__snippet"[^>]*>(.*?)</div>', html_text)
            snippets = []
            for first, second in snippet_matches:
                candidate = first or second
                snippets.append(_strip_html_to_text(candidate))

            for index, (href, title_html) in enumerate(link_matches[:5]):
                resolved_url = _decode_duckduckgo_result_url(href)
                if not _is_safe_public_url(resolved_url) or resolved_url in seen_urls:
                    continue
                seen_urls.add(resolved_url)
                title = _strip_html_to_text(title_html)[:120] or resolved_url
                summary = snippets[index] if index < len(snippets) else f"搜索结果：{title}"
                results.append({
                    "url": resolved_url,
                    "title": title,
                    "summary": summary[:240],
                    "contentSnippet": summary[:600],
                    "status": "search_result",
                })
                if len(results) >= 4:
                    return results
        return results[:4]

    def _safe_json_loads(self, content: Optional[str]) -> Dict[str, Any]:
        if content is None or not str(content).strip():
            raise ValueError("模型未返回文本内容")
        parsed = clean_and_parse_ai_json(content)
        if isinstance(parsed, dict):
            return parsed
        raise ValueError("模型未返回有效 JSON 对象")

    def _call_json(
        self,
        prompt: str,
        temperature: float = 0.5,
        max_tokens: int = 2200,
        *,
        request_timeout_seconds: float = 60.0,
        max_config_attempts: Optional[int] = None,
    ) -> Dict[str, Any]:
        errors: List[str] = []

        config_candidates = self.config_candidates[:max_config_attempts] if max_config_attempts else self.config_candidates
        for config in config_candidates:
            deduped_models = get_text_generation_model_candidates(config, current_model=self.model_id)
            client = OpenAI(
                api_key=config["api_key"],
                base_url=config["base_url"],
                timeout=request_timeout_seconds,
                max_retries=0,
                default_headers={"Accept-Encoding": "identity"},
            )
            for model_name in deduped_models:
                try:
                    response = client.chat.completions.create(
                        model=model_name,
                        messages=[{"role": "user", "content": prompt}],
                        temperature=temperature,
                        max_tokens=max_tokens,
                        response_format={"type": "json_object"},
                    )
                    content = response.choices[0].message.content if response.choices else None
                    self.api_key = config["api_key"]
                    self.base_url = config["base_url"]
                    self.client = client
                    self.model_id = model_name
                    return self._safe_json_loads(content)
                except Exception as error:
                    errors.append(f"{config['name']}::{model_name}: {error}")
                    if is_retryable_text_generation_error(error):
                        break

        raise RuntimeError("策略模型全部回退失败: " + " | ".join(errors))

    def _build_benchmark_fit_fallback(
        self,
        *,
        research_context: Dict[str, Any],
        benchmark_note: Optional[Dict[str, Any]],
        strategy_feedback: str = "",
    ) -> Dict[str, Any]:
        if not benchmark_note:
            return {
                "fit_level": "research_only",
                "product_usage_mode": PRODUCT_USAGE_MAIN,
                "confidence": 100,
                "core_viral_driver": "无对标笔记，直接依据产品研究生成策略。",
                "product_fit_reason": "未提供对标笔记，不需要做对标迁移判断。",
                "risk_if_product_inserted": "",
                "allowed_product_usage": "产品信息可作为策略主线。",
                "forbidden_moves": [],
                "transferable_assets": ["人群痛点", "产品价值", "封面钩子", "卡片结构"],
            }

        if _contains_no_product_instruction(strategy_feedback):
            return {
                "fit_level": "no_fit",
                "product_usage_mode": PRODUCT_USAGE_NONE,
                "confidence": 100,
                "core_viral_driver": "用户明确要求不参考产品信息，本次只复刻对标内容的表达结构。",
                "product_fit_reason": "显式用户指令高于产品研究和默认对标替换规则。",
                "risk_if_product_inserted": "继续加入产品名、功能或卖点会违背用户本次策略意图。",
                "allowed_product_usage": "不使用产品名、产品功能、目标人群和卖点。",
                "forbidden_moves": ["不要把对标方法映射成产品流程", "不要输出产品教程", "不要在标题或卡片里植入产品名"],
                "transferable_assets": ["标题钩子", "开头节奏", "段落推进", "卡片顺序", "互动收束"],
            }

        benchmark_text = " ".join(
            str((benchmark_note or {}).get(key) or "")
            for key in ("title", "desc", "content_category", "material_dependency")
        )
        tag_text = " ".join(str(item) for item in ((benchmark_note or {}).get("tags") or []))
        benchmark_text = f"{benchmark_text} {tag_text}"
        product_text = " ".join(
            str(research_context.get(key) or "")
            for key in ("summary", "product_name")
        )
        product_text = " ".join([
            product_text,
            " ".join(str(item) for item in research_context.get("core_features") or []),
            " ".join(str(item) for item in research_context.get("use_cases") or []),
            " ".join(str(item) for item in research_context.get("differentiators") or []),
        ])

        strong_keywords = [
            "工具", "软件", "系统", "平台", "私域", "企微", "企业微信", "scrm", "客户", "线索", "转化",
            "复购", "运营", "排版", "模板", "自动", "效率", "发布", "检测", "写作", "ai", "获客", "管理",
        ]
        soft_keywords = ["教程", "方法", "攻略", "步骤", "清单", "技巧", "怎么写", "笔记", "爆款", "网感", "标题", "封面"]
        hot_keywords = [
            "热点", "热搜", "明星", "娱乐", "情绪", "观点", "吐槽", "母亲节", "618", "双11", "开学季",
            "年终", "节日", "事件", "新闻", "普通人", "焦虑", "恋爱", "职场八卦",
        ]

        overlap_terms = [
            term for term in _split_text_items(product_text, limit=12)
            if len(term) >= 2 and term in benchmark_text
        ]
        strong_score = _keyword_score(benchmark_text, strong_keywords) + min(len(overlap_terms), 4)
        soft_score = _keyword_score(benchmark_text, soft_keywords)
        hot_score = _keyword_score(benchmark_text, hot_keywords)

        if strong_score >= 3 and strong_score >= hot_score:
            mode = PRODUCT_USAGE_MAIN
            fit_level = "strong_fit"
            reason = "对标笔记本身包含工具、业务痛点、效率或运营场景，产品信息加入后能增强内容成立度。"
            risk = "风险较低；重点是避免把对标结构改成空泛产品介绍。"
            allowed = "产品可作为策略主线，但仍要保留对标笔记的标题钩子、节奏和卡片推进。"
            forbidden = ["不要脱离对标结构写通用产品介绍"]
            assets = ["标题风格", "痛点切入", "卡片节奏", "产品价值承接", "行动收口"]
        elif hot_score >= 2 and strong_score < 3:
            mode = PRODUCT_USAGE_NONE
            fit_level = "no_fit"
            reason = "对标笔记爆点更像热点、情绪或话题流量，产品不是内容成立的必要条件。"
            risk = "硬加产品会削弱热点感和真实讨论感，让内容像广告或跑题。"
            allowed = "不使用产品信息，只复刻对标的流量钩子、情绪节奏和表达结构。"
            forbidden = ["不要出现产品名", "不要加入产品功能", "不要把热点改成产品卖点"]
            assets = ["热点钩子", "情绪开场", "观点递进", "评论互动", "卡片顺序"]
        else:
            mode = PRODUCT_USAGE_ASSIST if soft_score or strong_score else PRODUCT_USAGE_NONE
            fit_level = "soft_fit" if mode == PRODUCT_USAGE_ASSIST else "no_fit"
            reason = "对标笔记主要是内容方法或泛教程，产品只适合接住其中一个具体执行动作，不应抢主线。"
            risk = "如果把每个步骤都映射成功能，会把方法论笔记改成产品教程，降低原文吸引力。"
            allowed = "内容方法是主线；产品只放进结尾、附赠页或少量步骤中的具体工具动作。"
            forbidden = ["不要每一招都映射成产品功能", "不要把标题改成产品广告", "不要把正文写成完整产品教程"]
            assets = ["标题钩子", "教程步骤", "封面情绪", "卡片顺序", "结尾互动"]

        return {
            "fit_level": fit_level,
            "product_usage_mode": mode,
            "confidence": 72 if mode != PRODUCT_USAGE_MAIN else 78,
            "core_viral_driver": " / ".join(assets[:3]),
            "product_fit_reason": reason,
            "risk_if_product_inserted": risk,
            "allowed_product_usage": allowed,
            "forbidden_moves": forbidden,
            "transferable_assets": assets,
        }

    def diagnose_benchmark_fit(
        self,
        *,
        research_context: Dict[str, Any],
        benchmark_note: Optional[Dict[str, Any]],
        strategy_feedback: str = "",
        use_model: bool = True,
    ) -> Dict[str, Any]:
        fallback = self._build_benchmark_fit_fallback(
            research_context=research_context,
            benchmark_note=benchmark_note,
            strategy_feedback=strategy_feedback,
        )
        if not benchmark_note or _contains_no_product_instruction(strategy_feedback) or not use_model:
            return fallback

        prompt = f"""你是小红书策略总监。现在不要生成策略，先做“对标可迁移性诊断”。

核心判断原则：
只有当“当前产品信息能让对标笔记的核心爆点更成立”时，才允许产品主导。
如果产品信息只是勉强能接上，但不是原文爆点的必要条件，只能轻带。
如果产品信息会改变原文爆点、削弱热点感、让内容像广告或跑题，则禁止使用产品信息。

请先分析：
1. 这篇对标笔记真正爆的是什么：热点、情绪、观点、教程、结构、产品痛点、工具体验，还是用户身份共鸣？
2. 这个爆点和当前产品有什么自然关系？
3. 加入产品信息会增强内容，还是会破坏原文吸引力？
4. 原文最值得复刻的是哪一层：标题结构、封面情绪、卡片顺序、第一段起手、教程步骤、观点递进、热点借势、评论互动？
5. 本次策略应该保护原文流量钩子、保护产品转化，还是二者平衡？

产品研究：
{json.dumps(research_context, ensure_ascii=False)[:2600]}

对标笔记：
{json.dumps(benchmark_note or {{}}, ensure_ascii=False)[:2600]}

用户纠偏说明：
{strategy_feedback or '暂无'}

输出严格 JSON：
{{
  "fit_level": "strong_fit/soft_fit/no_fit",
  "product_usage_mode": "product_main/product_assist/no_product",
  "confidence": 0-100,
  "core_viral_driver": "原文核心爆点",
  "product_fit_reason": "为什么产品适合或不适合介入",
  "risk_if_product_inserted": "硬加产品的风险",
  "allowed_product_usage": "本次产品允许出现的位置和程度",
  "forbidden_moves": ["本次禁止怎么改"],
  "transferable_assets": ["最值得复刻的内容资产"]
}}
"""
        try:
            payload = self._call_json(
                prompt,
                temperature=0.25,
                max_tokens=1200,
                request_timeout_seconds=80.0,
                max_config_attempts=1,
            )
        except Exception as error:
            logger.warning("对标可迁移性诊断失败，使用本地诊断兜底: %s", error, exc_info=True)
            return fallback

        mode = _normalize_product_usage_mode(payload.get("product_usage_mode") or payload.get("fit_level"))
        fit_level = str(payload.get("fit_level") or fallback["fit_level"]).strip() or fallback["fit_level"]
        confidence = payload.get("confidence")
        try:
            confidence_int = max(0, min(100, int(confidence)))
        except Exception:
            confidence_int = fallback["confidence"]

        return {
            "fit_level": fit_level,
            "product_usage_mode": mode,
            "confidence": confidence_int,
            "core_viral_driver": str(payload.get("core_viral_driver") or fallback["core_viral_driver"]),
            "product_fit_reason": str(payload.get("product_fit_reason") or fallback["product_fit_reason"]),
            "risk_if_product_inserted": str(payload.get("risk_if_product_inserted") or fallback["risk_if_product_inserted"]),
            "allowed_product_usage": str(payload.get("allowed_product_usage") or fallback["allowed_product_usage"]),
            "forbidden_moves": payload.get("forbidden_moves") if isinstance(payload.get("forbidden_moves"), list) else fallback["forbidden_moves"],
            "transferable_assets": payload.get("transferable_assets") if isinstance(payload.get("transferable_assets"), list) else fallback["transferable_assets"],
        }

    def build_research_context(
        self,
        *,
        product_brief: Dict[str, Any],
        reference_assets: Optional[List[Dict[str, Any]]] = None,
        benchmark_note: Optional[Dict[str, Any]] = None,
        use_model: bool = True,
    ) -> Dict[str, Any]:
        product_name = str(product_brief.get("product_name", "") or "").strip()
        target_audience = str(product_brief.get("target_audience", "") or "").strip()
        product_features = str(product_brief.get("product_features", "") or "").strip()
        asset_names = [
            str(asset.get("original_name") or asset.get("file_name") or asset.get("id") or "").strip()
            for asset in (reference_assets or [])
            if isinstance(asset, dict)
        ]
        asset_names = [name for name in asset_names if name][:6]
        reference_urls = self._normalize_reference_urls(product_brief.get("reference_urls"))
        if use_model:
            source_documents = [self._fetch_source_document(url) for url in reference_urls]
            search_source_documents = self._search_public_web(
                product_name=product_name,
                product_features=product_features,
                target_audience=target_audience,
            )
        else:
            source_documents = []
            search_source_documents = []
        source_documents.extend([
            item for item in search_source_documents
            if item.get("url") and item.get("url") not in {doc.get("url") for doc in source_documents}
        ])
        fetched_summaries = [
            f"{doc.get('title', '')}：{doc.get('summary', '')}"
            for doc in source_documents
            if doc.get("status") in {"fetched", "search_result"}
        ]

        fallback_context = {
            "product_name": product_name,
            "summary": f"{product_name or '当前产品'}面向{target_audience or '目标用户'}，核心能力包括：{product_features or '待补充'}",
            "target_audience_insights": _split_text_items(target_audience, limit=4) or [target_audience or "对效率和结果更敏感的用户"],
            "core_features": _split_text_items(product_features, limit=6) or [product_features or "核心功能待补充"],
            "use_cases": ["日常工作提效", "内容生产或运营执行", "遇到重复性任务时更省时间"],
            "differentiators": ["强调效率与结果并重", "适合直接落地使用", "可用于教程、卖点或推荐型笔记"],
            "faq_hints": ["适合谁", "怎么上手", "和传统做法有什么差别"],
            "material_signals": (asset_names + [doc.get("title", "") for doc in source_documents if doc.get("title")])[:6] or ["暂无上传素材，将优先生成文字封面和价值说明页"],
            "research_notes": ["当前为无采集研究模式", "优先依据产品资料与素材组织表达", *(["已读取外部产品资料"] if reference_urls else []), *(["已自动搜索公开信息补全上下文"] if search_source_documents else [])],
            "source_documents": source_documents,
        }

        prompt = f"""你是小红书笔记制作系统里的产品研究助手。请根据用户提供的产品信息，先做研究理解，不要直接写正文。

目标：
1. 提炼这个产品适合谁
2. 归纳用户痛点、核心价值、适用场景
3. 总结适合后续生成笔记和图片的研究要点
4. 输出必须是结构化 JSON，不要废话

产品信息：
- 产品名称：{product_name or '未填写'}
- 目标人群：{target_audience or '未填写'}
- 产品特点：{product_features or '未填写'}
- 品牌语气：{product_brief.get('brand_tone') or '真实、口语化、不过度销售'}
- 必须提及：{product_brief.get('must_include') or '无'}
- 禁用词：{product_brief.get('banned_terms') or '无'}
- 产品资料链接：{reference_urls or '无'}

素材信息：
- 已上传素材数量：{len(asset_names)}
- 素材名称：{', '.join(asset_names) if asset_names else '暂无'}

外部资料摘要：
{chr(10).join(f"- {item}" for item in fetched_summaries[:3]) if fetched_summaries else '- 暂无'}

灵感增强器（可选参考，不要依赖）：
- 对标样本标题：{(benchmark_note or {}).get('title', '')}
- 对标样本正文：{(benchmark_note or {}).get('desc', '')}

输出严格 JSON：
{{
  "product_name": "产品名",
  "summary": "100字内总结",
  "target_audience_insights": ["..."],
  "core_features": ["..."],
  "use_cases": ["..."],
  "differentiators": ["..."],
  "faq_hints": ["..."],
  "material_signals": ["..."],
  "research_notes": ["..."],
  "source_documents": [
    {{
      "url": "来源",
      "title": "来源标题",
      "summary": "来源摘要",
      "contentSnippet": "提取到的正文片段",
      "status": "fetched"
    }}
  ]
}}
"""

        if not use_model:
            return fallback_context

        try:
            payload = self._call_json(
                prompt,
                temperature=0.45,
                max_tokens=1800,
                request_timeout_seconds=150.0,
                max_config_attempts=1,
            )
            return {
                "product_name": payload.get("product_name") or fallback_context["product_name"],
                "summary": payload.get("summary") or fallback_context["summary"],
                "target_audience_insights": payload.get("target_audience_insights") or fallback_context["target_audience_insights"],
                "core_features": payload.get("core_features") or fallback_context["core_features"],
                "use_cases": payload.get("use_cases") or fallback_context["use_cases"],
                "differentiators": payload.get("differentiators") or fallback_context["differentiators"],
                "faq_hints": payload.get("faq_hints") or fallback_context["faq_hints"],
                "material_signals": payload.get("material_signals") or fallback_context["material_signals"],
                "research_notes": payload.get("research_notes") or fallback_context["research_notes"],
                "source_documents": payload.get("source_documents") or fallback_context["source_documents"],
            }
        except Exception:
            return fallback_context

    def build_note_strategies(
        self,
        *,
        research_context: Dict[str, Any],
        benchmark_note: Optional[Dict[str, Any]] = None,
        real_phrases: Optional[List[str]] = None,
        strategy_mode: str = "research_first",
        strategy_feedback: str = "",
        recent_strategy_signals: Optional[List[str]] = None,
        use_model: bool = True,
    ) -> Dict[str, Any]:
        normalized_strategy_mode = "benchmark_first" if strategy_mode == "benchmark_first" and benchmark_note else "research_first"
        summary = str(research_context.get("summary", "") or "")
        target_audience_insights = list(research_context.get("target_audience_insights") or [])
        core_features = list(research_context.get("core_features") or [])
        use_cases = list(research_context.get("use_cases") or [])
        differentiators = list(research_context.get("differentiators") or [])
        material_signals = list(research_context.get("material_signals") or [])
        source_documents = list(research_context.get("source_documents") or [])
        benchmark_title = str((benchmark_note or {}).get("title", "") or "").strip()
        benchmark_desc = str((benchmark_note or {}).get("desc", "") or "").strip()
        raw_benchmark_tags = (benchmark_note or {}).get("tags") or []
        if isinstance(raw_benchmark_tags, str):
            benchmark_tags = [item.strip() for item in re.split(r"[\s#，,、;；]+", raw_benchmark_tags) if item.strip()]
        else:
            benchmark_tags = [str(item).strip().replace("#", "") for item in raw_benchmark_tags if str(item).strip()]
        benchmark_category = str((benchmark_note or {}).get("content_category", "") or "").strip()
        benchmark_tier = str((benchmark_note or {}).get("recommendation_tier", "") or "").strip()
        benchmark_material_dependency = str((benchmark_note or {}).get("material_dependency", "") or "").strip()
        benchmark_theme_text = " / ".join(
            item for item in [
                benchmark_title,
                benchmark_desc[:260],
                " / ".join(str(tag) for tag in benchmark_tags[:8]),
            ]
            if item
        ) or "暂无"
        feedback_text = str(strategy_feedback or "").strip() or "暂无"
        source_summary_text = "\n".join(
            f"- {doc.get('title', '')}：{doc.get('summary', '')}"
            for doc in source_documents[:3]
            if isinstance(doc, dict)
        ) or "暂无"
        real_phrase_text = " / ".join((real_phrases or [])[:8]) or "暂无"
        recent_signal_text = "\n".join(
            f"- {str(item).strip()}"
            for item in (recent_strategy_signals or [])[:6]
            if str(item).strip()
        ) or "暂无"
        product_name_for_strategy = str(research_context.get("product_name") or "当前产品")
        benchmark_fit = self.diagnose_benchmark_fit(
            research_context=research_context,
            benchmark_note=benchmark_note if normalized_strategy_mode == "benchmark_first" else None,
            strategy_feedback=strategy_feedback,
            use_model=use_model,
        )
        product_usage_mode = benchmark_fit.get("product_usage_mode") or PRODUCT_USAGE_MAIN
        account_route = _infer_account_content_route(
            research_context,
            product_usage_mode=product_usage_mode,
            normalized_strategy_mode=normalized_strategy_mode,
        )
        effective_product_usage_mode = account_route.get("default_product_usage_mode") or product_usage_mode
        diagnosis_text = json.dumps(benchmark_fit, ensure_ascii=False, indent=2)
        creative_run_id = _build_strategy_creative_run_id()
        include_account_route_prompt = _should_include_account_route_prompt(
            account_route,
            effective_product_usage_mode=effective_product_usage_mode,
        )
        account_route_prompt = f"""
【产品介入边界】
内容类型判断：{account_route["route_label"]}
产品介入模式：{effective_product_usage_mode}
边界说明：{account_route["strategy_boundary"]}
类型内发散范围：{account_route["diversity_boundary"]}
结尾落点：{account_route["closing_goal"]}

这个边界只决定产品、账号资产或链接怎么出现，不替代原有策略主引擎。
策略仍然必须从具体人群、具体场景、真实痛点、卖点/观点和卡片推进里长出来。
如果是个人IP，内容主角是人的经历、判断、冲突、过程和观点；非 Demo/GitHub/作品发布场景不要硬带产品。
如果是工具/App 且产品只接住一环，要写成读者正在做的具体执行动作，不要把全文扩成产品教程。
如果是本地门店/服务，要落到消费场景、信任理由和收藏/到店/下单动作，不要写成泛运营方法论。
"""
        if account_route["account_type"] == "personal_ip" and normalized_strategy_mode == "research_first":
            account_route_prompt += """
个人IP无对标时，三套策略至少两套必须是 no_product 的观点/复盘/判断内容；发布 Demo/GitHub 只能作为其中一套可选策略。
个人IP策略要具体到真实业务动作或真实冲突，例如“投放复盘为什么先砍自动化”“内容改写为什么先定读者场景”；禁止使用 XX、某个、某一步、这一步、那一步 这类占位表达。
"""
        account_route_prompt_for_generation = account_route_prompt if include_account_route_prompt else ""
        unified_strategy_quality_prompt = """
【统一策略质量底线】
生成前做内部自检：三套策略都要像真实业务现场、真实人会点开的选题，不要只是一组栏目名或泛泛方法论。
每套至少要看得出：谁在什么场景卡住、具体冲突是什么、继续错下去会有什么后果、这篇给出什么动作/判断/解决方案、最后怎么自然收束。
recommendedCardPlan 要有推进感：封面/开场给场景或冲突，中段拆误区/痛点/证据，后段给动作/结果/收口；不要只写“问题页/解决页/收口页”的空壳。
label 是前端策略卡片名，也是生文里的策略名称；它不是小红书正文标题，也不是空泛栏目名。要像一句具体业务矛盾或策划判断，短、清楚、有现场感，例如“客户不是没来，是卡死在交接断层”“客户很多，但高价值的人总被慢待”。不要写成“投了渠道却接不住客户”“渠道热闹但成交安静”这种压缩策划词。
suggestedTitle 才是小红书标题方向，可以更像“为什么/不是/别再/到底/怎么办”的可点击标题。
如果 label 使用“XX型”，必须同时带具体对象或具体冲突，例如“渠道归因复盘型：老板说不清哪路客户最值钱”；不要只写“资产化复盘型/需求长出来型”这类空泛栏目名。
"""
        shared_diversity_prompt = f"""
【本轮创意批次】
creative_run_id: {creative_run_id}

{account_route_prompt_for_generation}

这个 ID 不是历史记忆，也不是固定模板，只用于提醒你：同一产品每次生成策略时，都要重新完成一次真实策划发散，不要沿用最稳的老套路。

生成前请在内部先从产品资料/对标内容里挖出 6-8 个“具体矛盾命题”，再选择底层逻辑差异最大的 3 个命题进入最终 JSON；不要输出内部发散过程，最终只输出原有策略字段。
具体矛盾命题指真实用户会遇到的业务断点、认知误区、执行卡点、决策阻力或风险后果，不是“老板诊断/增长链路/合规风控/教程/种草”这类大类型标签。
三套策略不能只是同一个方向换词，至少要在以下 5 项中有 4 项明显不同：目标人群/具体场景、开头钩子、痛点组织方式、利益证明方式、产品角色或无产品承接方式、recommendedCardPlan 的分页推进。
contentAngle 要写成清晰可执行的策划角度；可参考教程型/卖点种草型/问题解决型/功能推荐型，但不限于这些，也可以自由命名；禁止使用抽象黑话。
多样化不能牺牲产品真实性、对标约束、卡片可执行性，也不能改变前端、生文、生图依赖的字段结构。

{unified_strategy_quality_prompt}

近期已覆盖的高层方向：
{recent_signal_text}
如果近期方向不为“暂无”，本轮不要把三套策略全部落回这些高层方向；可以保留其中一个最强方向，但其余策略必须从更具体的新矛盾命题中展开。
"""
        research_first_diversity_prompt = shared_diversity_prompt + """
本分支多样化边界：
没有对标笔记时，三套策略仍然必须以产品研究为核心，但不要只生成“教程/种草/问题解决”三个固定壳。
请先挖产品里的具体矛盾命题，再落成人群、痛点、卖点和分页；最终让三套像三个不同策划方向。
"""
        product_main_diversity_prompt = shared_diversity_prompt + """
本分支多样化边界：
三套策略都可以产品主导，但不能统一写成“前面铺垫、最后才提产品”。
请基于对标爆点、产品资料和当前策略，自行决定产品在标题、开头、正文、卡片中的自然呈现方式；产品表达应增强内容成立度，而不是机械复刻对标节奏。
三套策略要形成不同的产品表达路径：先找三个不同的具体矛盾命题，再分别决定产品如何成为解决这个矛盾的证据或方案。
"""
        product_assist_diversity_prompt = shared_diversity_prompt + """
本分支多样化边界：
所有方向都必须保持“内容主线 + 一个具体工具动作接入”，但三套不能只是同一个出现位置换词。
差异要来自对标主线选择、产品承接点、产品出现位置、产品出现身份、卡片推进方式；不允许扩展成产品主导或完整产品教程。
产品接入必须翻译成用户能读懂的具体动作桥：先说用户在哪个执行动作卡住，再说产品如何减少返工/漏项；可见字段只写具体执行页、检查页或工具动作页。
"""
        no_product_diversity_prompt = shared_diversity_prompt + """
本分支多样化边界：
所有方向都必须只使用对标笔记的内容资产，不允许加入产品信息。
差异要来自爆点复刻层、封面情绪、开头起手、观点/步骤推进、卡片顺序、互动收束等表达设计；不要把无产品策略写成三套同义结构。
"""
        benchmark_anchor_prompt = f"""
【对标锚点优先级】
当前选择了对标笔记时，对标相似度优先于近期避重和多样化。
三套策略里必须至少有 1 套“对标主线贴近版”，建议放在 strategies[0]；这套要保留对标笔记的核心主题、标题承诺、内容形式和卡片推进节奏。
近期已覆盖方向只能避免标题、案例和分页原样重复，不能让你避开对标笔记的核心主题；如果近期方向与对标锚点冲突，优先保留对标锚点。
第二、第三套可以多样化，但必须仍能解释它们和对标笔记的关系，不能跳成无关的产品通用策略。
对标标题锚点：{benchmark_title or "暂无"}
对标显性主题元素：{benchmark_theme_text}
"""
        product_main_diversity_prompt += benchmark_anchor_prompt
        product_assist_diversity_prompt += benchmark_anchor_prompt
        no_product_diversity_prompt += benchmark_anchor_prompt

        if normalized_strategy_mode == "benchmark_first":
            if product_usage_mode == PRODUCT_USAGE_NONE:
                fallback_strategies = [
                    {
                        "id": "benchmark_structure_only",
                        "label": "纯结构复刻",
                        "summary": "只复刻对标笔记的标题钩子、开头节奏、卡片顺序和互动收束，不使用产品信息。",
                        "targetAudience": "对标笔记原本吸引的人群",
                        "corePainPoints": ["被对标话题吸引", "想快速获得同类信息或观点"],
                        "coreBenefits": ["保留原文流量钩子", "减少产品植入带来的跳戏感", "更像自然内容而不是广告"],
                        "contentAngle": benchmark_category or "结构复刻型",
                        "noteGoal": "最大程度保护对标笔记的原始吸引力，不做产品化迁移",
                        "visualDirection": "general",
                        "recommendedCardPlan": ["对标式封面", "情绪/话题开场页", "核心观点推进页", "细节展开页", "互动收束页"],
                        "suggestedTitle": benchmark_title or "沿用这篇内容的爆点重新表达",
                    },
                    {
                        "id": "benchmark_hook_rebuild",
                        "label": "钩子节奏重建",
                        "summary": "复刻对标的点击理由和阅读推进，但主题仍保持原文方向，不转成产品教程。",
                        "targetAudience": "会被原文标题和情绪击中的用户",
                        "corePainPoints": ["对话题有兴趣", "想看更清楚的拆解"],
                        "coreBenefits": ["标题更贴近原文爆点", "卡片阅读节奏更自然", "保留评论互动空间"],
                        "contentAngle": "话题复刻型",
                        "noteGoal": "复刻高反馈内容资产，而不是替换成产品价值",
                        "visualDirection": "general",
                        "recommendedCardPlan": ["强钩子封面", "原文式起手", "观点/方法拆页", "补充解释页", "评论引导页"],
                        "suggestedTitle": benchmark_title or "把这个爆点换一种说法",
                    },
                    {
                        "id": "benchmark_card_flow",
                        "label": "卡片顺序复刻",
                        "summary": "把对标的封面、正文推进和结尾互动拆成可执行卡片结构，不加入产品卖点。",
                        "targetAudience": "对标内容原本覆盖的人群",
                        "corePainPoints": ["需要清晰结构", "希望内容更好读"],
                        "coreBenefits": ["保留卡片顺序", "保留表达风格", "避免产品信息稀释主题"],
                        "contentAngle": "卡片结构型",
                        "noteGoal": "产出一套不跳戏的高相似结构方案",
                        "visualDirection": "tutorial" if "教程" in benchmark_category else "general",
                        "recommendedCardPlan": ["封面复刻", "开场复刻", "步骤/观点复刻", "案例/细节复刻", "收束复刻"],
                        "suggestedTitle": benchmark_title or "按这篇的结构重做一版",
                    },
                ]
                prompt = f"""你是小红书爆款仿写策划助手。现在不要直接写正文，而是先根据已选对标笔记，输出 3 套“纯结构复刻”的笔记策略方案。

本次对标可迁移性诊断：
{diagnosis_text}

硬性要求：
1. 用户或诊断结果要求本次不使用产品信息，必须严格遵守
2. 不得出现产品名、产品功能、产品卖点、产品目标人群
3. 不得把对标笔记的方法、热点、观点映射成产品流程
4. 策略必须优先复刻对标笔记的标题钩子、封面情绪、卡片顺序、开头起手、观点/步骤推进和互动收束
5. recommendedCardPlan 仍要具体到封面卡、内容卡、结尾卡，保证卡片策略质量
6. 如果用户给了纠偏说明，必须优先按纠偏说明重排策略
7. 输出严格 JSON

{no_product_diversity_prompt}

当前策略模式：benchmark_first / no_product
用户纠偏说明：{feedback_text}

对标笔记标题：{benchmark_title}
对标笔记正文：{benchmark_desc}
对标笔记标签：{benchmark_tags}
对标笔记分类：{benchmark_category}
对标笔记推荐层级：{benchmark_tier}
对标笔记素材依赖：{benchmark_material_dependency}
对标显性主题元素：{benchmark_theme_text}
"""
            elif product_usage_mode == PRODUCT_USAGE_ASSIST:
                fallback_strategies = [
                    {
                        "id": "benchmark_content_main_tool_tail",
                        "label": "方法主线执行版",
                        "summary": f"保留对标笔记的方法或话题主线，{product_name_for_strategy}只接住其中一个具体执行动作。",
                        "targetAudience": target_audience_insights[0] if target_audience_insights else "会被对标方法吸引的用户",
                        "corePainPoints": ["想照着方法做", "希望减少执行成本"],
                        "coreBenefits": ["保留原文方法吸引力", "只接住一个具体执行卡点", "更像自然经验分享"],
                        "contentAngle": benchmark_category or "方法复刻型",
                        "noteGoal": f"让内容先成立，再把{product_name_for_strategy}放进一个具体执行动作里",
                        "visualDirection": "tutorial",
                        "recommendedCardPlan": ["对标式封面", "方法开场页", "核心步骤页", "执行提醒页", f"工具动作页：用{product_name_for_strategy}接住其中一个具体执行卡点，不展开成产品种草", "互动收束页"],
                        "suggestedTitle": benchmark_title or "照着这套方法先跑顺",
                    },
                    {
                        "id": "benchmark_method_first",
                        "label": "方法优先版",
                        "summary": "先完整复刻对标的方法框架，只在少量卡片中说明产品可帮助完成其中一环。",
                        "targetAudience": target_audience_insights[0] if target_audience_insights else "需要这套方法的人",
                        "corePainPoints": use_cases[:2] or ["知道方法但执行慢", "步骤多容易乱"],
                        "coreBenefits": ["方法不被广告打断", "产品出现更自然", "保留收藏价值"],
                        "contentAngle": "教程方法型",
                        "noteGoal": f"保护对标内容资产，同时明确{product_name_for_strategy}只接住一个具体执行卡点",
                        "visualDirection": "tutorial",
                        "recommendedCardPlan": ["强方法封面", "原文式问题页", "步骤拆解页", "注意事项页", f"工具动作页：{product_name_for_strategy}接住其中一个执行难点", "结尾互动页"],
                        "suggestedTitle": benchmark_title or "这套方法可以先收藏",
                    },
                    {
                        "id": "benchmark_assist_optional",
                        "label": "工具动作接入版",
                        "summary": "把产品放进一个可理解的执行动作里，不作为内容证明的前提，避免把对标笔记改成产品教程。",
                        "targetAudience": "对标原文人群与产品潜在人群的交集",
                        "corePainPoints": use_cases[:2] or ["想做但缺少顺手工具", "执行链路比较碎"],
                        "coreBenefits": core_features[:2] or ["降低执行成本", "让流程更顺"],
                        "contentAngle": "轻工具承接型",
                        "noteGoal": f"让用户先认可内容方法，再自然理解{product_name_for_strategy}能减少哪一步返工",
                        "visualDirection": "general",
                        "recommendedCardPlan": ["原文钩子封面", "方法价值页", "步骤推进页", f"执行卡点页：说明{product_name_for_strategy}能减少哪一步返工", "总结页"],
                        "suggestedTitle": benchmark_title or "按这套思路做会顺很多",
                    },
                ]
                prompt = f"""你是小红书爆款仿写策划助手。现在不要直接写正文，而是先根据已选对标笔记，输出 3 套“内容主线 + 具体工具动作接入”的笔记策略方案。

本次对标可迁移性诊断：
{diagnosis_text}

要求：
1. 对标笔记的爆点、标题风格、切入角度、卡片节奏和表达重心必须是主线
2. 产品只能接住其中一个具体执行环节，通常出现在最后 1-2 段、附赠页、检查页或某一个工具动作页
3. 不允许把每个步骤都映射成产品功能，不允许写成完整产品教程
4. 可以参考产品信息判断“哪里能轻带”，但不能让产品抢走原文爆点
5. recommendedCardPlan 必须具体到封面卡、方法卡、执行动作卡、结尾卡，保证卡片策略质量
6. 每套策略必须明确写出产品接住的是哪个读者动作：产品在哪一页/哪一段出现、以什么身份出现、解决原文里的哪个执行卡点
7. 每套策略的 recommendedCardPlan 必须至少包含 1 个明确的具体执行页/检查页/工具动作页，并点名当前产品名称；但其它卡片仍以对标原文爆点为主
8. noteGoal 或 summary 里必须说明内容主线优先，产品只接住具体执行动作；所有用户可见字段都要写成读者动作，不写内部策划判断
9. 如果用户给了纠偏说明，必须优先按纠偏说明重排策略
10. 输出严格 JSON

{product_assist_diversity_prompt}

当前策略模式：benchmark_first / product_assist
研究摘要：{summary}
目标人群洞察：{target_audience_insights}
核心功能：{core_features}
使用场景：{use_cases}
差异化价值：{differentiators}
素材信号：{material_signals}
外部资料：{source_summary_text}
真实用户表达：{real_phrase_text}
用户纠偏说明：{feedback_text}

对标笔记标题：{benchmark_title}
对标笔记正文：{benchmark_desc}
对标笔记标签：{benchmark_tags}
对标笔记分类：{benchmark_category}
对标笔记推荐层级：{benchmark_tier}
对标笔记素材依赖：{benchmark_material_dependency}
对标显性主题元素：{benchmark_theme_text}
"""
            else:
                fallback_strategies = [
                    {
                        "id": "benchmark_structure_follow",
                        "label": "对标结构跟写",
                        "summary": "优先沿着对标笔记的标题结构和卡片节奏走，再替换成当前产品的真实卖点与场景。",
                        "targetAudience": target_audience_insights[0] if target_audience_insights else "和对标笔记相近的人群",
                        "corePainPoints": use_cases[:2] or ["不知道怎么下手", "想快速做出类似效果"],
                        "coreBenefits": core_features[:3] or differentiators[:3] or ["更快复刻成功路径", "减少试错", "表达更贴近爆文节奏"],
                        "contentAngle": benchmark_category or "结构仿写型",
                        "noteGoal": "保留对标笔记的叙事节奏与吸引力，同时换成当前产品的真实价值",
                        "visualDirection": "tutorial" if "教程" in benchmark_category else "benefit",
                        "recommendedCardPlan": ["强对标封面", "共鸣问题页", "核心方法页", "价值证明页", "行动收口页"],
                        "suggestedTitle": benchmark_title or "照着这篇爆文的节奏，换成我的产品来讲",
                    },
                    {
                        "id": "benchmark_angle_translate",
                        "label": "对标角度平移",
                        "summary": "保留对标笔记的切入角度与语气，但把内容重点平移成当前产品最该讲的卖点。",
                        "targetAudience": target_audience_insights[0] if target_audience_insights else "会被对标角度打动的同类用户",
                        "corePainPoints": use_cases[:2] or ["看完很多内容还是不知道选什么", "需要更直接的决策理由"],
                        "coreBenefits": differentiators[:3] or core_features[:3] or ["角度更像热门笔记", "卖点表达更聚焦", "更容易形成转化"],
                        "contentAngle": "对标角度迁移型",
                        "noteGoal": "沿用对标爆文的切入方式，但讲清楚为什么当前产品值得选",
                        "visualDirection": "benefit",
                        "recommendedCardPlan": ["强情绪封面", "痛点放大页", "方案切入页", "卖点拆解页", "总结推荐页"],
                        "suggestedTitle": benchmark_title or "把这篇高反馈笔记的角度，换成我的产品来讲",
                    },
                    {
                        "id": "benchmark_rhythm_rebuild",
                        "label": "对标节奏重组",
                        "summary": "保留对标笔记的阅读推进感和重点顺序，重写成更适合当前产品的卡片与正文组合。",
                        "targetAudience": target_audience_insights[0] if target_audience_insights else "需要先被种草再被说服的人",
                        "corePainPoints": differentiators[:2] or ["信息很多但记不住", "不知道产品到底适不适合自己"],
                        "coreBenefits": core_features[:3] or ["节奏更顺", "重点更清楚", "更适合图文传播"],
                        "contentAngle": "对标节奏重组型",
                        "noteGoal": "保留高反馈对标的阅读体验，同时强化当前产品的真实差异点",
                        "visualDirection": "general",
                        "recommendedCardPlan": ["结果型封面", "适合谁页", "为什么值页", "怎么用页", "收口页"],
                        "suggestedTitle": benchmark_title or "沿着高反馈笔记的节奏，重新讲清楚这个产品",
                    },
                ]
                prompt = f"""你是小红书爆款仿写策划助手。现在不要直接写正文，而是先根据已选对标笔记，输出 3 套“对标优先”的笔记策略方案。

本次对标可迁移性诊断：
{diagnosis_text}

要求：
1. 策略必须优先继承对标笔记的标题风格、切入角度、卡片节奏、叙事顺序和表达重心
2. 研究结论只能用于校准真实产品信息，替换掉对标笔记里的旧产品、旧卖点、旧场景
3. 不允许把策略主轴做成纯研究导向的通用产品介绍
4. 不允许照搬对标笔记原文，要保留节奏与方法，替换成当前产品的真实价值
5. 图片和正文默认遵守“图讲过程/结构，文案讲价值/判断”
6. 必须提取并保留对标笔记里的显性主题元素、时间节点、活动名、场景词和利益点；如果对标讲 618、开学季、年终复盘等，策略里要明确映射这些元素
7. 如果用户给了纠偏说明，必须优先按纠偏说明重排策略，不要忽略
8. 输出严格 JSON

{product_main_diversity_prompt}

当前策略模式：benchmark_first
研究摘要：{summary}
目标人群洞察：{target_audience_insights}
核心功能：{core_features}
使用场景：{use_cases}
差异化价值：{differentiators}
素材信号：{material_signals}
外部资料：{source_summary_text}
真实用户表达：{real_phrase_text}
用户纠偏说明：{feedback_text}

对标笔记标题：{benchmark_title}
对标笔记正文：{benchmark_desc}
对标笔记标签：{benchmark_tags}
对标笔记分类：{benchmark_category}
对标笔记推荐层级：{benchmark_tier}
对标笔记素材依赖：{benchmark_material_dependency}
对标显性主题元素：{benchmark_theme_text}
"""
        else:
            fallback_strategies = [
                {
                    "id": "tutorial_play",
                    "label": "教程拆解",
                    "summary": "先讲适合谁和为什么值得学，再用图片拆步骤，正文补注意事项。",
                    "targetAudience": target_audience_insights[0] if target_audience_insights else "第一次接触该产品的人",
                    "corePainPoints": use_cases[:2] or ["不会用", "上手成本高"],
                    "coreBenefits": core_features[:3] or differentiators[:3] or ["更容易上手", "更快看到结果"],
                    "contentAngle": "教程型",
                    "noteGoal": "降低理解门槛，让用户愿意照着图去做",
                    "visualDirection": "tutorial",
                    "recommendedCardPlan": ["纯文字封面", "步骤页", "步骤页", "亮点页", "收口页"],
                    "suggestedTitle": "这套方法终于帮我把它用明白了",
                },
                {
                    "id": "benefit_pitch",
                    "label": "卖点种草",
                    "summary": "先把用户问题讲透，再用截图和亮点页证明产品价值。",
                    "targetAudience": target_audience_insights[0] if target_audience_insights else "正在找更高效方案的人",
                    "corePainPoints": differentiators[:2] or ["传统做法太慢", "结果不稳定"],
                    "coreBenefits": core_features[:3] or ["更省时间", "信息更清楚", "更适合实操"],
                    "contentAngle": "卖点种草型",
                    "noteGoal": "让用户快速理解为什么值得用",
                    "visualDirection": "benefit",
                    "recommendedCardPlan": ["纯文字封面", "亮点页", "亮点页", "适用人群页", "收口页"],
                    "suggestedTitle": "如果你也在被这件事困住，真的可以试试它",
                },
                {
                    "id": "problem_solution",
                    "label": "问题解决",
                    "summary": "围绕一个真实问题展开，正文讲痛点和收益，图片讲操作和结果。",
                    "targetAudience": target_audience_insights[0] if target_audience_insights else "遇到重复问题的用户",
                    "corePainPoints": use_cases[:2] or ["效率低", "容易出错"],
                    "coreBenefits": differentiators[:3] or core_features[:3] or ["减少重复劳动", "更容易复用", "更容易产出"],
                    "contentAngle": "问题解决型",
                    "noteGoal": "通过问题共鸣带出解决方案",
                    "visualDirection": "general",
                    "recommendedCardPlan": ["纯文字封面", "问题页", "解决页", "亮点页", "收口页"],
                    "suggestedTitle": "原来这个问题，真有更省力的解法",
                },
            ]
            prompt = f"""你是小红书爆款策划助手。现在不要直接写正文，而是先根据研究结论，输出 3 套不同的笔记策略方案。

要求：
1. 每套策略都要像真人策划，不要模板腔
2. 重点先讲清楚人群、痛点、卖点
3. 图片和正文不要机械重复，默认遵守“图讲过程，文案讲价值”
4. 如果有对标样本，它只是灵感增强器，不是依赖
5. 如果用户给了纠偏说明，必须优先按纠偏说明重排策略
6. 输出严格 JSON

{research_first_diversity_prompt}

当前策略模式：research_first
研究摘要：{summary}
目标人群洞察：{target_audience_insights}
核心功能：{core_features}
使用场景：{use_cases}
差异化价值：{differentiators}
素材信号：{material_signals}
外部资料：{source_summary_text}
真实用户表达：{real_phrase_text}
用户纠偏说明：{feedback_text}
参考样本标题：{benchmark_title}
"""
        prompt += """

输出严格 JSON：
{
  "selected_strategy_id": "默认建议ID",
  "strategies": [
    {
      "id": "strategy_id",
      "label": "策略卡片名：一句具体业务矛盾或策划判断，不是小红书正文标题",
      "summary": "一句策略摘要",
      "targetAudience": "这篇主要打给谁",
      "corePainPoints": ["..."],
      "coreBenefits": ["..."],
      "contentAngle": "清晰可执行的内容角度，例如教程型/卖点种草型/问题解决型/功能推荐型；也可自由命名，但不能抽象黑话",
      "noteGoal": "想达成什么效果",
      "visualDirection": "tutorial/benefit/general",
      "recommendedCardPlan": ["..."],
      "suggestedTitle": "推荐标题方向"
    }
  ]
}
"""

        if not use_model:
            return {
                "selected_strategy_id": fallback_strategies[0]["id"],
                "strategies": [
                    {
                        **item,
                        "benchmarkFit": benchmark_fit,
                        "productUsageMode": effective_product_usage_mode,
                        "accountType": account_route["account_type"],
                        "contentIntent": account_route["default_content_intent"],
                        "productRole": account_route["default_product_role"],
                        "closingGoal": account_route["closing_goal"],
                    }
                    for item in fallback_strategies
                ],
                "benchmark_fit": benchmark_fit,
                "product_usage_mode": effective_product_usage_mode,
                "fallback_used": True,
                "fallback_reason": "model_disabled",
            }

        started_at = time.monotonic()
        for attempt in range(1, NOTE_STRATEGY_MODEL_MAX_ATTEMPTS + 1):
            try:
                payload = self._call_json(
                    prompt,
                    temperature=0.72,
                    max_tokens=2600,
                    request_timeout_seconds=150.0,
                    max_config_attempts=1,
                )
                strategies = payload.get("strategies")
                if not isinstance(strategies, list) or not strategies:
                    raise ValueError("策略模型未返回有效 strategies，请重试生成")

                normalized: List[Dict[str, Any]] = []
                for index, item in enumerate(strategies[:3]):
                    if not isinstance(item, dict):
                        continue
                    item_product_usage_mode = item.get("productUsageMode") or effective_product_usage_mode
                    route_default_role = str(account_route.get("default_product_role") or "").strip()
                    default_product_role = route_default_role or (
                        "solution"
                        if item_product_usage_mode == PRODUCT_USAGE_MAIN
                        else "none" if item_product_usage_mode == PRODUCT_USAGE_NONE else "assist"
                    )
                    default_content_intent = str(account_route.get("default_content_intent") or "").strip()
                    if not default_content_intent:
                        default_content_intent = (
                            "problem_solution"
                            if default_product_role == "solution"
                            else "topic_explainer" if default_product_role == "none" else "benchmark_tips"
                        )
                    raw_content_intent = str(item.get("contentIntent") or item.get("content_intent") or "").strip()
                    raw_product_role = str(item.get("productRole") or item.get("product_role") or "").strip()
                    final_account_type = account_route["account_type"]
                    final_content_intent = raw_content_intent or default_content_intent
                    final_product_role = raw_product_role or default_product_role
                    launch_roles = {"launch", "example", "demo"}
                    if account_route["account_type"] == "personal_ip":
                        item_has_launch_signal = _contains_personal_ip_launch_signal(item)
                        route_defaults_to_launch = (
                            account_route.get("default_product_role") == "launch"
                            or account_route.get("default_content_intent") == "launch"
                        )
                        launch_like = (
                            final_content_intent == "launch"
                            or final_product_role in launch_roles
                            or (route_defaults_to_launch and item_has_launch_signal)
                            or item_has_launch_signal
                        )
                        if launch_like:
                            final_content_intent = "launch"
                            if final_product_role not in launch_roles:
                                final_product_role = "launch"
                            item_product_usage_mode = PRODUCT_USAGE_ASSIST
                        else:
                            final_product_role = "none"
                            item_product_usage_mode = PRODUCT_USAGE_NONE
                    elif account_route["account_type"] == "open_source_project":
                        if final_product_role not in {"launch", "example", "demo", "assist"}:
                            final_product_role = "launch"
                        final_content_intent = "launch" if final_product_role == "launch" else final_content_intent
                        item_product_usage_mode = PRODUCT_USAGE_ASSIST
                    elif item_product_usage_mode == PRODUCT_USAGE_NONE:
                        final_product_role = "none"
                    fallback_strategy = fallback_strategies[min(index, len(fallback_strategies) - 1)]
                    normalized_label = _normalize_strategy_label(
                        item.get("label"),
                        item.get("suggestedTitle"),
                        fallback_strategy["label"],
                    )
                    normalized_content_angle = _normalize_strategy_content_angle(
                        item.get("contentAngle"),
                        fallback_strategy["contentAngle"],
                    )
                    normalized.append({
                        "id": item.get("id") or fallback_strategy["id"],
                        "label": normalized_label,
                        "summary": _rewrite_awkward_strategy_phrases(item.get("summary") or fallback_strategy["summary"]),
                        "targetAudience": _rewrite_awkward_strategy_phrases(item.get("targetAudience") or fallback_strategy["targetAudience"]),
                        "corePainPoints": _rewrite_awkward_strategy_phrases(item.get("corePainPoints") or fallback_strategy["corePainPoints"]),
                        "coreBenefits": _rewrite_awkward_strategy_phrases(item.get("coreBenefits") or fallback_strategy["coreBenefits"]),
                        "contentAngle": normalized_content_angle,
                        "noteGoal": _rewrite_awkward_strategy_phrases(item.get("noteGoal") or fallback_strategy["noteGoal"]),
                        "visualDirection": item.get("visualDirection") or fallback_strategy["visualDirection"],
                        "recommendedCardPlan": _rewrite_awkward_strategy_phrases(item.get("recommendedCardPlan") or fallback_strategy["recommendedCardPlan"]),
                        "suggestedTitle": _rewrite_awkward_strategy_phrases(item.get("suggestedTitle") or fallback_strategy["suggestedTitle"]),
                        "benchmarkFit": item.get("benchmarkFit") or benchmark_fit,
                        "productUsageMode": item_product_usage_mode,
                        "accountType": final_account_type,
                        "contentIntent": final_content_intent,
                        "productRole": final_product_role,
                        "closingGoal": item.get("closingGoal") or item.get("closing_goal") or account_route["closing_goal"],
                    })

                if not normalized:
                    raise ValueError("策略模型返回的 strategies 为空，请重试生成")

                selected_strategy_id = payload.get("selected_strategy_id") or normalized[0]["id"]
                response_product_usage_mode = effective_product_usage_mode
                if account_route["account_type"] == "personal_ip":
                    selected_strategy = next(
                        (item for item in normalized if item.get("id") == selected_strategy_id),
                        normalized[0],
                    )
                    response_product_usage_mode = (
                        PRODUCT_USAGE_ASSIST
                        if selected_strategy.get("productRole") in {"launch", "example", "demo"}
                        else PRODUCT_USAGE_NONE
                    )
                return {
                    "selected_strategy_id": selected_strategy_id,
                    "strategies": normalized,
                    "benchmark_fit": benchmark_fit,
                    "product_usage_mode": response_product_usage_mode,
                    "fallback_used": False,
                    "fallback_reason": "",
                }
            except Exception as error:
                retryable = is_retryable_text_generation_error(error)
                if attempt < NOTE_STRATEGY_MODEL_MAX_ATTEMPTS and retryable:
                    backoff_seconds = NOTE_STRATEGY_MODEL_RETRY_BACKOFF_SECONDS * attempt
                    logger.warning(
                        "笔记策略模型生成失败，将重试: mode=%s benchmark=%s attempt=%s/%s backoff=%ss prompt_len=%s error=%s",
                        normalized_strategy_mode,
                        bool(benchmark_note),
                        attempt,
                        NOTE_STRATEGY_MODEL_MAX_ATTEMPTS,
                        backoff_seconds,
                        len(prompt),
                        error,
                        exc_info=True,
                    )
                    time.sleep(backoff_seconds)
                    continue

                runtime_seconds = time.monotonic() - started_at
                logger.error(
                    "笔记策略模型重试后仍失败，不返回本地兜底: mode=%s benchmark=%s attempts=%s prompt_len=%s runtime=%.3fs error=%s",
                    normalized_strategy_mode,
                    bool(benchmark_note),
                    attempt,
                    len(prompt),
                    runtime_seconds,
                    error,
                    exc_info=True,
                )
                raise RuntimeError(f"笔记策略模型生成失败，请稍后重试: {error}") from error
