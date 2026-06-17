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
            reason = "对标笔记主要是内容方法或泛教程，产品最多辅助完成其中一部分，不应抢主线。"
            risk = "如果把每个步骤都映射成功能，会把方法论笔记改成产品教程，降低原文吸引力。"
            allowed = "内容方法是主线；产品只可在结尾、附赠页或少量步骤中轻承接。"
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
        diagnosis_text = json.dumps(benchmark_fit, ensure_ascii=False, indent=2)
        creative_run_id = _build_strategy_creative_run_id()
        shared_diversity_prompt = f"""
【本轮创意批次】
creative_run_id: {creative_run_id}

这个 ID 不是历史记忆，也不是固定模板，只用于提醒你：同一产品每次生成策略时，都要重新完成一次真实策划发散，不要沿用最稳的老套路。

生成前请在内部先从产品资料/对标内容里挖出 6-8 个“具体矛盾命题”，再选择底层逻辑差异最大的 3 个命题进入最终 JSON；不要输出内部发散过程，最终只输出原有策略字段。
具体矛盾命题指真实用户会遇到的业务断点、认知误区、执行卡点、决策阻力或风险后果，不是“老板诊断/增长链路/合规风控/教程/种草”这类大类型标签。
三套策略不能只是同一个方向换词，至少要在以下 5 项中有 4 项明显不同：目标人群/具体场景、开头钩子、痛点组织方式、利益证明方式、产品角色或无产品承接方式、recommendedCardPlan 的分页推进。
contentAngle 要写成清晰可执行的策划角度；可参考教程型/卖点种草型/问题解决型/功能推荐型，但不限于这些，也可以自由命名；禁止使用抽象黑话。
多样化不能牺牲产品真实性、对标约束、卡片可执行性，也不能改变前端、生文、生图依赖的字段结构。
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
所有方向都必须保持“内容主线 + 产品轻承接”，但三套不能只是同一个轻承接位置换词。
差异要来自对标主线选择、产品承接点、产品出现位置、产品出现身份、卡片推进方式；不允许扩展成产品主导或完整产品教程。
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
                        "label": "内容主线轻承接",
                        "summary": f"保留对标笔记的方法或话题主线，{product_name_for_strategy}只在结尾或附赠页作为辅助工具轻带。",
                        "targetAudience": target_audience_insights[0] if target_audience_insights else "会被对标方法吸引的用户",
                        "corePainPoints": ["想照着方法做", "希望减少执行成本"],
                        "coreBenefits": ["保留原文方法吸引力", "产品只辅助执行不抢主线", "更像自然经验分享"],
                        "contentAngle": benchmark_category or "方法复刻型",
                        "noteGoal": f"让内容先成立，再把{product_name_for_strategy}作为执行辅助或基础设施示例轻轻带出",
                        "visualDirection": "tutorial",
                        "recommendedCardPlan": ["对标式封面", "方法开场页", "核心步骤页", "执行提醒页", f"产品轻承接页：用{product_name_for_strategy}作为辅助例子，不展开成产品种草", "互动收束页"],
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
                        "noteGoal": f"保护对标内容资产，同时明确{product_name_for_strategy}只在一个合理辅助位置出现",
                        "visualDirection": "tutorial",
                        "recommendedCardPlan": ["强方法封面", "原文式问题页", "步骤拆解页", "注意事项页", f"辅助工具页：{product_name_for_strategy}承接其中一个执行难点", "结尾互动页"],
                        "suggestedTitle": benchmark_title or "这套方法可以先收藏",
                    },
                    {
                        "id": "benchmark_assist_optional",
                        "label": "可选工具辅助版",
                        "summary": "把产品定义为可选辅助，不作为内容证明的前提，避免把对标笔记改成产品教程。",
                        "targetAudience": "对标原文人群与产品潜在人群的交集",
                        "corePainPoints": use_cases[:2] or ["想做但缺少顺手工具", "执行链路比较碎"],
                        "coreBenefits": core_features[:2] or ["降低执行成本", "让流程更顺"],
                        "contentAngle": "轻工具承接型",
                        "noteGoal": f"让用户先认可内容方法，再自然理解{product_name_for_strategy}的可选辅助价值",
                        "visualDirection": "general",
                        "recommendedCardPlan": ["原文钩子封面", "方法价值页", "步骤推进页", f"轻工具承接页：说明{product_name_for_strategy}能辅助哪一步", "总结页"],
                        "suggestedTitle": benchmark_title or "按这套思路做会顺很多",
                    },
                ]
                prompt = f"""你是小红书爆款仿写策划助手。现在不要直接写正文，而是先根据已选对标笔记，输出 3 套“内容主线 + 产品轻承接”的笔记策略方案。

本次对标可迁移性诊断：
{diagnosis_text}

要求：
1. 对标笔记的爆点、标题风格、切入角度、卡片节奏和表达重心必须是主线
2. 产品只能作为辅助承接，通常出现在最后 1-2 段、附赠页、工具辅助页或某一个执行环节
3. 不允许把每个步骤都映射成产品功能，不允许写成完整产品教程
4. 可以参考产品信息判断“哪里能轻带”，但不能让产品抢走原文爆点
5. recommendedCardPlan 必须具体到封面卡、方法卡、承接卡、结尾卡，保证卡片策略质量
6. 每套策略必须明确写出产品承接点：产品在哪一页/哪一段出现、以什么身份出现、承接原文哪个问题
7. 每套策略的 recommendedCardPlan 必须至少包含 1 个明确的“产品轻承接页/工具辅助页/基础设施示例页”，并点名当前产品名称；但其它卡片仍以对标原文爆点为主
8. noteGoal 或 summary 里必须说明产品只是辅助承接，不是本篇主角
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
      "label": "显示名",
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
                    {**item, "benchmarkFit": benchmark_fit, "productUsageMode": product_usage_mode}
                    for item in fallback_strategies
                ],
                "benchmark_fit": benchmark_fit,
                "product_usage_mode": product_usage_mode,
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
                    normalized.append({
                        "id": item.get("id") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["id"],
                        "label": item.get("label") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["label"],
                        "summary": item.get("summary") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["summary"],
                        "targetAudience": item.get("targetAudience") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["targetAudience"],
                        "corePainPoints": item.get("corePainPoints") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["corePainPoints"],
                        "coreBenefits": item.get("coreBenefits") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["coreBenefits"],
                        "contentAngle": item.get("contentAngle") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["contentAngle"],
                        "noteGoal": item.get("noteGoal") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["noteGoal"],
                        "visualDirection": item.get("visualDirection") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["visualDirection"],
                        "recommendedCardPlan": item.get("recommendedCardPlan") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["recommendedCardPlan"],
                        "suggestedTitle": item.get("suggestedTitle") or fallback_strategies[min(index, len(fallback_strategies) - 1)]["suggestedTitle"],
                        "benchmarkFit": item.get("benchmarkFit") or benchmark_fit,
                        "productUsageMode": item.get("productUsageMode") or product_usage_mode,
                    })

                if not normalized:
                    raise ValueError("策略模型返回的 strategies 为空，请重试生成")

                selected_strategy_id = payload.get("selected_strategy_id") or normalized[0]["id"]
                return {
                    "selected_strategy_id": selected_strategy_id,
                    "strategies": normalized,
                    "benchmark_fit": benchmark_fit,
                    "product_usage_mode": product_usage_mode,
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
