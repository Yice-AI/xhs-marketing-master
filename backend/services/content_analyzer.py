import json
import math
import os
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional

from openai import OpenAI

from backend.config import settings
from backend.utils.logger import logger


DEFAULT_TEXT_GEN_BASE_URL = "https://api.example.com/v1"
DEFAULT_TEXT_GEN_MODEL = "gpt-5.4"
DEFAULT_TEXT_GEN_FALLBACK_MODEL = "claude-sonnet-4-6"
DEFAULT_ANTHROPIC_BASE_URL = "https://api.example.com/v1"
def _get_text_model_fallback() -> str:
    configured = getattr(settings, "TEXT_GEN_FALLBACK_MODEL", DEFAULT_TEXT_GEN_FALLBACK_MODEL)
    return str(configured or "").strip()

CONTENT_CATEGORIES = {
    "测评类": ["测评", "评测", "实测", "对比", "开箱", "试用", "体验", "实拍"],
    "主推产品类": ["必入", "推荐", "种草", "安利", "回购", "闭眼入", "宝藏", "神器", "好物"],
    "场景种草类": ["通勤", "租房", "卧室", "桌面", "办公室", "约会", "出差", "旅行", "日常"],
    "分享经验类": ["分享", "经验", "总结", "合集", "清单", "干货", "攻略", "方法"],
    "对比避坑类": ["避坑", "别买", "千万别", "平替", "踩雷", "对比", "选购", "区别"],
    "情绪共鸣类": ["治愈", "崩溃", "焦虑", "后悔", "感动", "救命", "谁懂", "被拿捏", "破防"],
    "教程类": ["教程", "步骤", "怎么", "如何", "手把手", "新手", "指南", "入门"],
}

MATERIAL_DEPENDENCY_RULES = {
    "需物料图": ["开箱", "包装", "细节", "外观", "实拍", "产品图", "上脸", "上身", "试色", "材质"],
    "需场景图": ["场景", "客厅", "卧室", "桌面", "办公室", "通勤", "旅行", "氛围", "摆拍"],
    "需真人感素材": ["本人", "真人", "上身", "上脸", "自拍", "素颜", "试穿", "穿搭"],
}

FOLLOWUP_KEYWORDS = {
    "测评类": ["测评", "实测", "真实体验", "对比"],
    "主推产品类": ["推荐", "必入", "回购", "种草"],
    "场景种草类": ["场景", "通勤", "桌面", "日常"],
    "分享经验类": ["经验", "干货", "合集", "总结"],
    "对比避坑类": ["避坑", "平替", "对比", "别买"],
    "情绪共鸣类": ["救命", "谁懂", "后悔", "被治愈"],
    "教程类": ["教程", "步骤", "怎么选", "新手"],
}

AI_PHRASE_MARKERS = [
    "家人们谁懂",
    "真的绝了",
    "闭眼入",
    "冲就完事",
    "姐妹们",
    "宝子们",
    "狠狠",
    "直接封神",
    "谁懂啊",
    "一定要试试",
]

DEFAULT_SEARCH_FILTERS = {
    "sortBy": "综合",
    "noteType": "不限",
    "publishTime": "不限",
    "searchScope": "不限",
    "location": "不限",
}


def normalize_openai_base_url(base_url: Optional[str], fallback: str) -> str:
    normalized = (base_url or fallback).rstrip("/")
    if not normalized.endswith("/v1"):
        normalized = f"{normalized}/v1"
    return normalized


def get_text_generation_base_url() -> str:
    configured = getattr(settings, "TEXT_GEN_BASE_URL", DEFAULT_TEXT_GEN_BASE_URL)
    return normalize_openai_base_url(configured, DEFAULT_TEXT_GEN_BASE_URL)


def get_anthropic_base_url() -> str:
    configured = getattr(settings, "ANTHROPIC_BASE_URL", DEFAULT_ANTHROPIC_BASE_URL)
    return normalize_openai_base_url(configured, DEFAULT_ANTHROPIC_BASE_URL)


def get_text_generation_model() -> str:
    return getattr(settings, "TEXT_GEN_MODEL", DEFAULT_TEXT_GEN_MODEL)


def get_text_generation_model_candidates(
    config: Optional[Dict[str, str]] = None,
    *,
    current_model: Optional[str] = None,
) -> List[str]:
    primary = get_text_generation_model()
    fallback = _get_text_model_fallback()
    config_name = str((config or {}).get("name") or "")
    if config_name == "text_gateway_fallback":
        ordered = [fallback or primary]
    else:
        ordered = [primary, fallback]
    if current_model and config_name != "text_gateway_fallback":
        ordered = [current_model, *ordered]
    deduped: List[str] = []
    for model in ordered:
        if model and model not in deduped:
            deduped.append(model)
    return deduped


def _looks_like_placeholder_secret(value: str) -> bool:
    lowered = str(value or "").strip().lower()
    if not lowered:
        return True
    placeholder_markers = [
        "your-",
        "replace",
        "placeholder",
        "example",
        "changeme",
        "填入",
        "这里",
    ]
    return any(marker in lowered for marker in placeholder_markers)


def get_text_generation_config_candidates() -> List[Dict[str, str]]:
    candidates: List[Dict[str, str]] = []
    primary_candidates: List[Dict[str, str]] = []

    text_fallback_api_key = getattr(settings, "TEXT_GEN_FALLBACK_API_KEY", "")
    text_fallback_base_url = getattr(settings, "TEXT_GEN_FALLBACK_BASE_URL", "")

    anthropic_api_key = getattr(settings, "ANTHROPIC_API_KEY", "")
    if anthropic_api_key and not _looks_like_placeholder_secret(anthropic_api_key):
        primary_candidates.append({
            "name": "anthropic_gateway",
            "api_key": anthropic_api_key,
            "base_url": get_anthropic_base_url(),
        })

    anthropic_backup_api_key = getattr(settings, "ANTHROPIC_BACKUP_API_KEY", "")
    if anthropic_backup_api_key and not _looks_like_placeholder_secret(anthropic_backup_api_key):
        primary_candidates.append({
            "name": "anthropic_gateway_backup",
            "api_key": anthropic_backup_api_key,
            "base_url": get_anthropic_base_url(),
        })

    image_api_key = getattr(settings, "IMAGE_GEN_API_KEY", "")
    if image_api_key and not _looks_like_placeholder_secret(image_api_key):
        primary_candidates.append({
            "name": "image_gateway",
            "api_key": image_api_key,
            "base_url": normalize_openai_base_url(
                getattr(settings, "IMAGE_GEN_BASE_URL", DEFAULT_ANTHROPIC_BASE_URL),
                DEFAULT_ANTHROPIC_BASE_URL,
            ),
        })

    image_pooled_api_keys = [
        str(key or "").strip()
        for key in getattr(settings, "IMAGE_GEN_API_KEYS", [])
        if str(key or "").strip() and not _looks_like_placeholder_secret(str(key or "").strip())
    ]
    for index, pooled_api_key in enumerate(image_pooled_api_keys, start=1):
        primary_candidates.append({
            "name": f"image_gateway_pool_{index}",
            "api_key": pooled_api_key,
            "base_url": normalize_openai_base_url(
                getattr(settings, "IMAGE_GEN_BASE_URL", DEFAULT_ANTHROPIC_BASE_URL),
                DEFAULT_ANTHROPIC_BASE_URL,
            ),
        })

    image_backup_api_key = getattr(settings, "IMAGE_GEN_BACKUP_API_KEY", "")
    if image_backup_api_key and not _looks_like_placeholder_secret(image_backup_api_key):
        primary_candidates.append({
            "name": "image_gateway_backup",
            "api_key": image_backup_api_key,
            "base_url": normalize_openai_base_url(
                getattr(settings, "IMAGE_GEN_BASE_URL", DEFAULT_ANTHROPIC_BASE_URL),
                DEFAULT_ANTHROPIC_BASE_URL,
            ),
        })

    candidates.extend(primary_candidates)

    if text_fallback_api_key and text_fallback_base_url and not _looks_like_placeholder_secret(text_fallback_api_key):
        candidates.append({
            "name": "text_gateway_fallback",
            "api_key": text_fallback_api_key,
            "base_url": normalize_openai_base_url(
                text_fallback_base_url,
                DEFAULT_TEXT_GEN_BASE_URL,
            ),
        })

    if primary_candidates:
        deduped: List[Dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for candidate in candidates:
            key = (candidate["api_key"], candidate["base_url"])
            if key in seen:
                continue
            seen.add(key)
            deduped.append(candidate)
        return deduped

    openai_api_key = getattr(settings, "OPENAI_API_KEY", "")
    if openai_api_key and not _looks_like_placeholder_secret(openai_api_key):
        candidates.append({
            "name": "openai_official",
            "api_key": openai_api_key,
            "base_url": "https://api.openai.com/v1",
        })

    openrouter_api_key = getattr(settings, "OPENROUTER_API_KEY", "")
    if openrouter_api_key and not _looks_like_placeholder_secret(openrouter_api_key):
        candidates.append({
            "name": "openrouter_gateway",
            "api_key": openrouter_api_key,
            "base_url": "https://openrouter.ai/api/v1",
        })

    gemini_api_key = getattr(settings, "GEMINI_API_KEY", "")
    if gemini_api_key and not _looks_like_placeholder_secret(gemini_api_key):
        candidates.append({
            "name": "gemini_openai_compat",
            "api_key": gemini_api_key,
            "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        })

    minimax_api_key = getattr(settings, "MINIMAX_API_KEY", "")
    if minimax_api_key and not _looks_like_placeholder_secret(minimax_api_key):
        candidates.append({
            "name": "minimax_official",
            "api_key": minimax_api_key,
            "base_url": "https://api.minimaxi.com/v1",
        })

    deduped: List[Dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for candidate in candidates:
        key = (candidate["api_key"], candidate["base_url"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _summarize_text_key_source(api_key: Optional[str]) -> str:
    value = (api_key or "").strip()
    if not value:
        return "missing"
    candidates = [
        ("ANTHROPIC_API_KEY", getattr(settings, "ANTHROPIC_API_KEY", "")),
        ("IMAGE_GEN_API_KEY", getattr(settings, "IMAGE_GEN_API_KEY", "")),
        ("OPENAI_API_KEY", getattr(settings, "OPENAI_API_KEY", "")),
        ("OPENROUTER_API_KEY", getattr(settings, "OPENROUTER_API_KEY", "")),
        ("GEMINI_API_KEY", getattr(settings, "GEMINI_API_KEY", "")),
        ("MINIMAX_API_KEY", getattr(settings, "MINIMAX_API_KEY", "")),
    ]
    for name, configured in candidates:
        if value == (configured or "").strip():
            return name
    return "unknown_runtime_source"


def _mask_secret(secret: Optional[str]) -> str:
    value = (secret or "").strip()
    if not value:
        return "missing"
    if len(value) <= 10:
        return f"{value[:3]}***"
    return f"{value[:8]}...{value[-4:]}"


def _log_text_generation_diagnostics(scene: str, *, api_key: Optional[str], base_url: Optional[str], model: Optional[str]) -> None:
    logger.info(
        "[TEXT_DIAG] scene=%s model=%s base_url=%s key_source=%s key=%s mode=%s",
        scene,
        model or "",
        base_url or "",
        _summarize_text_key_source(api_key),
        _mask_secret(api_key),
        getattr(settings, "MODEL_GATEWAY_MODE", ""),
    )


def is_retryable_text_generation_error(error: Exception) -> bool:
    error_text = str(error).lower()
    retryable_fragments = [
        "403",
        "401",
        "invalid api key",
        "api key not valid",
        "api_key_invalid",
        "invalid_argument",
        "permission",
        "permission_error",
        "model_not_found",
        "unknown model",
        "not found",
        "404",
        "closed env",
        "当前模型不可用",
        "rate limit",
        "429",
        "500",
        "server_error",
        "server had an error",
        "connection error",
        "resource has been exhausted",
        "timeout",
        "timed out",
        "service unavailable",
        "502",
        "503",
        "504",
        "模型未返回文本内容",
        "模型返回了空文本内容",
        "模型未返回可解析的 json 文本",
        "模型输出被截断",
        "正文不完整",
        "确认稿正文不完整",
        "访谈正文不完整",
        "文案优化模型未返回文本内容",
        "提示词模型未返回可解析内容",
    ]
    return any(fragment in error_text for fragment in retryable_fragments)


def resolve_text_generation_config(api_key: Optional[str] = None) -> tuple[str, str]:
    if api_key:
        resolved = (api_key, get_text_generation_base_url())
        _log_text_generation_diagnostics("resolve_text_generation_config:manual", api_key=resolved[0], base_url=resolved[1], model=get_text_generation_model())
        return resolved

    config_candidates = get_text_generation_config_candidates()
    if config_candidates:
        first = config_candidates[0]
        resolved = (first["api_key"], first["base_url"])
        _log_text_generation_diagnostics(
            f"resolve_text_generation_config:{first['name']}",
            api_key=resolved[0],
            base_url=resolved[1],
            model=get_text_generation_model(),
        )
        return resolved

    raise ValueError("文本分析 API Key 未配置！请设置 ANTHROPIC_API_KEY、IMAGE_GEN_API_KEY、OPENAI_API_KEY、OPENROUTER_API_KEY 或 GEMINI_API_KEY。")


class ContentAnalyzer:
    def __init__(self, api_key: Optional[str] = None):
        self.api_key, self.base_url = resolve_text_generation_config(api_key)
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=60.0,
            max_retries=0,
            default_headers={"Accept-Encoding": "identity"},
        )
        self.model_id = get_text_generation_model()

    def load_notes_from_json(self, json_file_path: str) -> List[Dict[str, Any]]:
        if not os.path.exists(json_file_path):
            raise FileNotFoundError(f"文件不存在: {json_file_path}")
        with open(json_file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        raise ValueError("JSON 文件格式错误，应为笔记列表")

    def _parse_int(self, value: Any) -> int:
        if value is None:
            return 0
        try:
            return int(str(value).replace(",", "").replace("w", "0000").replace("k", "000").strip() or "0")
        except (TypeError, ValueError):
            return 0

    def _parse_tags(self, tag_value: Any) -> List[str]:
        if not tag_value:
            return []
        if isinstance(tag_value, list):
            return [str(tag).strip().replace("#", "") for tag in tag_value if str(tag).strip()]
        if isinstance(tag_value, str):
            return [tag.strip().replace("#", "") for tag in re.split(r"[\s,，]+", tag_value) if tag.strip()]
        return []

    def _normalize_text(self, text: str) -> str:
        return re.sub(r"\s+", " ", text or "").strip()

    def _collect_note_text(self, note: Dict[str, Any]) -> str:
        title = self._normalize_text(str(note.get("title", "")))
        desc = self._normalize_text(str(note.get("desc", "")))
        tags = " ".join(self._parse_tags(note.get("tag_list", "")))
        source_keyword = self._normalize_text(str(note.get("source_keyword", "")))
        comment_text = " ".join(
            self._normalize_text(str(comment.get("content", "")))
            for comment in (note.get("comments") or [])[:6]
            if isinstance(comment, dict)
        )
        return " ".join(part for part in [title, desc, tags, source_keyword, comment_text] if part)

    def _tokenize(self, text: str) -> List[str]:
        return re.findall(r"[\u4e00-\u9fff]{2,}|[a-z0-9]{2,}", self._normalize_text(text).lower())

    def filter_viral_notes(self, notes: List[Dict[str, Any]], min_likes: int = 100, min_collects: int = 50) -> List[Dict[str, Any]]:
        return [
            note for note in notes
            if self._parse_int(note.get("liked_count")) >= min_likes or self._parse_int(note.get("collected_count")) >= min_collects
        ]

    def extract_basic_stats(self, notes: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not notes:
            return {"total_notes": 0, "avg_title_length": 0, "avg_content_length": 0, "emoji_usage_rate": 0, "avg_likes": 0, "avg_collects": 0, "avg_comments": 0}
        emoji_pattern = re.compile(
            "["
            "\U0001F600-\U0001F64F"
            "\U0001F300-\U0001F5FF"
            "\U0001F680-\U0001F6FF"
            "\U0001F1E0-\U0001F1FF"
            "\U00002702-\U000027B0"
            "\U000024C2-\U0001F251"
            "]+",
            flags=re.UNICODE,
        )
        total = len(notes)
        return {
            "total_notes": total,
            "avg_title_length": round(sum(len(str(note.get("title", ""))) for note in notes) / total, 1),
            "avg_content_length": round(sum(len(str(note.get("desc", ""))) for note in notes) / total, 1),
            "emoji_usage_rate": round(sum(1 for note in notes if emoji_pattern.search(str(note.get("title", ""))) or emoji_pattern.search(str(note.get("desc", "")))) / total * 100, 1),
            "avg_likes": round(sum(self._parse_int(note.get("liked_count")) for note in notes) / total, 1),
            "avg_collects": round(sum(self._parse_int(note.get("collected_count")) for note in notes) / total, 1),
            "avg_comments": round(sum(self._parse_int(note.get("comment_count")) for note in notes) / total, 1),
        }

    def extract_time_patterns(self, notes: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not notes:
            return {"hour_distribution": {}, "best_publish_hours": []}
        hour_counts = Counter()
        for note in notes:
            timestamp = note.get("time")
            if timestamp:
                try:
                    dt = datetime.fromtimestamp(int(timestamp) / 1000)
                    hour_counts[dt.hour] += 1
                except (ValueError, TypeError):
                    continue
        sorted_hours = sorted(hour_counts.items(), key=lambda item: item[1], reverse=True)
        return {"hour_distribution": dict(hour_counts), "best_publish_hours": [hour for hour, _ in sorted_hours[:3]]}

    def _classify_category(self, note: Dict[str, Any]) -> Dict[str, Any]:
        text = self._collect_note_text(note)
        category_scores: Dict[str, int] = {}
        for category, keywords in CONTENT_CATEGORIES.items():
            score = sum(2 if keyword in str(note.get("title", "")) else 1 for keyword in keywords if keyword in text)
            if category == "教程类" and re.search(r"(怎么|如何|步骤|教程)", text):
                score += 2
            category_scores[category] = score
        best = max(category_scores, key=category_scores.get) if category_scores else "分享经验类"
        if category_scores.get(best, 0) <= 0:
            best = "分享经验类" if len(str(note.get("desc", ""))) >= 80 else "主推产品类"
        secondary = sorted(category_scores.items(), key=lambda item: item[1], reverse=True)[:2]
        return {
            "content_category": best,
            "category_scores": category_scores,
            "secondary_categories": [name for name, score in secondary if score > 0 and name != best],
        }

    def _infer_material_dependency(self, note: Dict[str, Any], category: str) -> str:
        text = self._collect_note_text(note)
        for dependency, keywords in MATERIAL_DEPENDENCY_RULES.items():
            if any(keyword in text for keyword in keywords):
                return dependency
        if category in {"测评类", "主推产品类"}:
            return "需物料图"
        if category == "场景种草类":
            return "需场景图"
        return "纯概念"

    def _product_overlap_score(self, note: Dict[str, Any], product_brief: Optional[Dict[str, Any]]) -> int:
        if not product_brief:
            return 10
        note_tokens = set(self._tokenize(self._collect_note_text(note)))
        if not note_tokens:
            return 10
        weighted_fields = [
            ("product_name", 9, 24),
            ("product_features", 7, 26),
            ("target_audience", 6, 20),
            ("brand_tone", 3, 10),
            ("must_include", 4, 12),
        ]
        score = 0
        has_any_field = False
        for field_name, token_weight, max_field_score in weighted_fields:
            field_tokens = set(self._tokenize(str(product_brief.get(field_name, ""))))
            if not field_tokens:
                continue
            has_any_field = True
            overlap_count = len(note_tokens & field_tokens)
            if overlap_count <= 0:
                continue
            score += min(max_field_score, overlap_count * token_weight)
        if not has_any_field:
            return 10
        return min(45, score)

    def _engagement_score(self, note: Dict[str, Any]) -> int:
        raw = self._parse_int(note.get("liked_count")) * 0.45 + self._parse_int(note.get("collected_count")) * 0.8 + self._parse_int(note.get("comment_count")) * 0.55
        return min(28, int(math.log1p(raw) * 4.8))

    def _compute_note_scores(self, note: Dict[str, Any], product_brief: Optional[Dict[str, Any]], category: str) -> Dict[str, Any]:
        overlap = self._product_overlap_score(note, product_brief)
        engagement = self._engagement_score(note)
        completeness_bonus = 8 if len(str(note.get("desc", ""))) >= 60 else 3
        structure_bonus = 6 if any(mark in str(note.get("desc", "")) for mark in ["1.", "2.", "3.", "①", "②", "✅", "👉"]) else 2
        category_bonus = 7 if category in {"测评类", "主推产品类", "场景种草类"} else 4
        comment_bonus = 5 if len(note.get("comments") or []) >= 3 else 0
        commercial_fit_score = min(100, 24 + overlap + int(engagement * 0.8) + category_bonus + comment_bonus)
        rewrite_value_score = min(100, 18 + overlap + engagement + completeness_bonus + structure_bonus + comment_bonus)
        if rewrite_value_score >= 76 and commercial_fit_score >= 64:
            tier = "强推荐"
        elif rewrite_value_score >= 58 or commercial_fit_score >= 52:
            tier = "可参考"
        else:
            tier = "仅做灵感"
        reasons: List[str] = []
        if overlap >= 15:
            reasons.append("和当前产品关键词重合度高")
        if engagement >= 20:
            reasons.append("互动数据较强")
        if structure_bonus >= 6:
            reasons.append("正文结构清晰，适合结构仿写")
        if not reasons:
            reasons.append("适合做选题或表达方式参考")
        return {
            "commercial_fit_score": commercial_fit_score,
            "rewrite_value_score": rewrite_value_score,
            "recommendation_tier": tier,
            "recommendation_reason": "；".join(reasons),
        }

    def _extract_real_phrases(self, notes: List[Dict[str, Any]]) -> List[str]:
        phrases: Counter[str] = Counter()
        for note in notes:
            comment_list = note.get("comments") or []
            if isinstance(comment_list, list):
                for comment in comment_list:
                    if not isinstance(comment, dict):
                        continue
                    sentence = self._normalize_text(str(comment.get("content", ""))).strip("，,、 ")
                    if 6 <= len(sentence) <= 28 and not any(marker in sentence for marker in AI_PHRASE_MARKERS):
                        phrases[sentence] += 2
            text = self._normalize_text(str(note.get("desc", "")))
            for sentence in re.split(r"[。！？\n]", text):
                sentence = sentence.strip("，,、 ")
                if 6 <= len(sentence) <= 24 and not any(marker in sentence for marker in AI_PHRASE_MARKERS):
                    phrases[sentence] += 1
        return [phrase for phrase, _ in phrases.most_common(15)]

    def _build_followup_tasks(self, category_summary: Dict[str, Dict[str, Any]], product_brief: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        tasks: List[Dict[str, Any]] = []
        base_keywords: List[str] = []
        if product_brief:
            if str(product_brief.get("product_name", "")).strip():
                base_keywords.append(str(product_brief.get("product_name", "")).strip())
            base_keywords.extend(self._tokenize(str(product_brief.get("product_features", "")))[:4])
            base_keywords.extend(self._tokenize(str(product_brief.get("target_audience", "")))[:3])
        for category, summary in category_summary.items():
            if summary["benchmark_sufficiency"] == "充足":
                continue
            keyword_seeds = [seed for seed in base_keywords if seed]
            keyword_seeds.extend(FOLLOWUP_KEYWORDS.get(category, [])[:2])
            keyword_seeds = list(dict.fromkeys(keyword_seeds))[:4] or FOLLOWUP_KEYWORDS.get(category, ["种草"])
            filters = dict(DEFAULT_SEARCH_FILTERS)
            if category in {"场景种草类", "情绪共鸣类"}:
                filters["sortBy"] = "最新"
            elif category == "测评类":
                filters["sortBy"] = "最多点赞"
            else:
                filters["sortBy"] = "综合"

            if category == "场景种草类":
                filters["noteType"] = "图文"
            elif category == "教程类":
                filters["publishTime"] = "半年内"
            elif category == "情绪共鸣类":
                filters["publishTime"] = "一周内"

            tasks.append({
                "category": category,
                "reason": summary["sufficiency_reason"],
                "keywords": keyword_seeds,
                "keyword_text": " ".join(keyword_seeds),
                "filters": filters,
                "max_notes_count": 18 if summary["strong_recommend_count"] == 0 else 12,
                "enable_comments": category in {"情绪共鸣类", "教程类", "测评类"},
                "max_comments_per_note": 15,
            })
        return tasks

    def analyze_with_ai(self, notes: List[Dict[str, Any]], category_summary: Optional[Dict[str, Any]] = None) -> str:
        if not notes:
            return "没有足够的数据进行分析"
        sample_notes = notes[:8]
        notes_text = ""
        for i, note in enumerate(sample_notes, 1):
            notes_text += f"\n笔记 {i}:\n分类: {note.get('content_category', '未知')}\n标题: {note.get('title', '')}\n正文: {str(note.get('desc', ''))[:180]}...\n推荐层级: {note.get('recommendation_tier', '未知')}\n点赞: {note.get('liked_count', '0')}, 收藏: {note.get('collected_count', '0')}\n---\n"
        category_text = ""
        if category_summary:
            for category, summary in category_summary.items():
                category_text += f"- {category}: {summary['note_count']} 条，强推荐 {summary['strong_recommend_count']} 条，样本{summary['benchmark_sufficiency']}\n"
        prompt = f"""请基于以下小红书对标池结果，给出适合创作工作台使用的分析结论。

分类概览：
{category_text}

样本：
{notes_text}

请输出：
1. 当前最值得重点仿写的内容类型
2. 哪些类型样本还不够，需要补采什么方向
3. 文案创作时最该保留的结构和最该避免的 AI 套话
4. 用简洁条目表达，适合直接展示给运营人员
"""
        try:
            last_error: Optional[Exception] = None
            for model_id in get_text_generation_model_candidates(current_model=self.model_id):
                try:
                    response = self.client.chat.completions.create(
                        model=model_id,
                        messages=[{"role": "user", "content": prompt}],
                        temperature=0.4,
                        max_tokens=1200,
                    )
                    self.model_id = model_id
                    return response.choices[0].message.content
                except Exception as model_error:
                    last_error = model_error
                    error_text = str(model_error).lower()
                    if "404" not in error_text and "not found" not in error_text:
                        break
            raise last_error or RuntimeError("文本分析模型调用失败")
        except Exception as e:
            return f"AI 分析失败: {str(e)}"

    def analyze(self, json_file_path: str, min_likes: int = 100, min_collects: int = 50, product_brief: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        all_notes = self.load_notes_from_json(json_file_path)
        viral_notes = self.filter_viral_notes(all_notes, min_likes, min_collects)
        enriched_notes: List[Dict[str, Any]] = []
        grouped_notes: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for note in viral_notes:
            category_info = self._classify_category(note)
            score_info = self._compute_note_scores(note, product_brief, category_info["content_category"])
            enriched = {
                **note,
                **category_info,
                **score_info,
                "material_dependency": self._infer_material_dependency(note, category_info["content_category"]),
            }
            enriched_notes.append(enriched)
            grouped_notes[category_info["content_category"]].append(enriched)
        for notes in grouped_notes.values():
            notes.sort(key=lambda item: (item["recommendation_tier"] == "强推荐", item["rewrite_value_score"], item["commercial_fit_score"]), reverse=True)

        category_summary: Dict[str, Dict[str, Any]] = {}
        for category in CONTENT_CATEGORIES.keys():
            notes = grouped_notes.get(category, [])
            strong_count = sum(1 for note in notes if note["recommendation_tier"] == "强推荐")
            avg_rewrite = round(sum(note["rewrite_value_score"] for note in notes) / len(notes), 1) if notes else 0
            sufficiency = "充足"
            reason = "强推荐样本数量满足当前仿写需求。"
            if strong_count < 8:
                sufficiency = "不足"
                reason = f"强推荐样本仅 {strong_count} 条，建议继续补采同类对标。"
            elif avg_rewrite < 68:
                sufficiency = "偏弱"
                reason = "虽然样本数量够，但整体可仿写价值一般，建议补更强样本。"
            category_summary[category] = {
                "note_count": len(notes),
                "strong_recommend_count": strong_count,
                "avg_rewrite_value_score": avg_rewrite,
                "benchmark_sufficiency": sufficiency,
                "sufficiency_reason": reason,
            }

        return {
            "source_file": json_file_path,
            "total_notes_in_file": len(all_notes),
            "viral_notes_count": len(viral_notes),
            "filter_criteria": {"min_likes": min_likes, "min_collects": min_collects},
            "product_brief": product_brief or {},
            "basic_stats": self.extract_basic_stats(enriched_notes),
            "time_patterns": self.extract_time_patterns(enriched_notes),
            "ai_insights": self.analyze_with_ai(enriched_notes, category_summary),
            "benchmark_notes": enriched_notes,
            "grouped_benchmark_notes": dict(grouped_notes),
            "category_summary": category_summary,
            "real_phrases": self._extract_real_phrases(enriched_notes),
            "next_collection_tasks": self._build_followup_tasks(category_summary, product_brief),
            "analyzed_at": datetime.now().isoformat(),
        }
