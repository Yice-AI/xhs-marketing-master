from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import asyncio
import json
import re
from urllib.parse import unquote, urlparse
import httpx

from sqlalchemy.orm import Session
from sqlalchemy import inspect, text
from sqlalchemy.exc import DBAPIError, SQLAlchemyError
from backend.database.db_session import get_db
from backend.utils.logger import logger
from backend.middleware.auth import get_current_user_id
from fastapi.responses import Response
from playwright.async_api import async_playwright
from backend.config import settings
from backend.services.model_gateway_diagnostics import classify_model_gateway_error
from backend.utils.network_safety import is_safe_public_url, normalize_remote_public_url
from backend.services.product_profile_service import has_meaningful_product_brief, upsert_product_profile
from backend.services.text_job_runner import run_text_job

router = APIRouter(prefix="/api/scraper", tags=["scraper"])
XHS_NOTE_URL_PATTERN = re.compile(r"^https://www\.xiaohongshu\.com/explore/([^/?#]+)")
XHS_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class AnalyzeLocalRequest(BaseModel):
    notes: List[Dict[str, Any]]
    product_brief: Optional[Dict[str, Any]] = None


class SaveHistoryRequest(BaseModel):
    keyword: str
    collection_mode: Optional[str] = None
    source_input: Optional[str] = None
    notes_count: int
    notes_data: list
    analysis_result: Optional[dict] = None
    filters: Optional[Dict[str, Any]] = None
    product_brief: Optional[Dict[str, Any]] = None


class CollectByUrlRequest(BaseModel):
    url: str
    enable_comments: Optional[bool] = False


class RasterizeTemplateRequest(BaseModel):
    data_url: str


def _normalize_comment_payload(raw_comments: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_comments, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for item in raw_comments:
        if isinstance(item, str):
            content = item.strip()
            if content:
                normalized.append({"content": content})
            continue
        if not isinstance(item, dict):
            continue
        content = str(
            item.get("content")
            or item.get("text")
            or item.get("comment_text")
            or ""
        ).strip()
        if not content:
            continue
        normalized.append({
            "id": item.get("id") or item.get("comment_id"),
            "userName": item.get("userName") or item.get("nickname") or item.get("user_name"),
            "content": content,
            "likeCount": str(item.get("likeCount") or item.get("like_count") or "0"),
            "replyCount": str(item.get("replyCount") or item.get("sub_comment_count") or "0"),
            "time": item.get("time") or item.get("create_time"),
        })
    return normalized


def _raise_url_collection_error(status_code: int, code: str, message: str) -> None:
    raise HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _normalize_xhs_note_url(raw_url: str) -> str:
    candidate = str(raw_url or "").strip()
    if not candidate:
        _raise_url_collection_error(400, "invalid_url", "请输入要采集的小红书笔记链接。")

    parsed = urlparse(candidate)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        _raise_url_collection_error(400, "invalid_url", "链接格式不正确，请粘贴完整的小红书笔记链接。")

    normalized = candidate.replace("http://", "https://", 1)
    if not XHS_NOTE_URL_PATTERN.match(normalized):
        if "xiaohongshu.com" not in parsed.netloc.lower():
            _raise_url_collection_error(400, "invalid_url", "当前只支持小红书笔记链接。")
        _raise_url_collection_error(400, "unsupported_url", "首版仅支持小红书 explore 笔记链接。")
    return normalized


def _extract_xhs_note_id(note_url: str) -> str:
    match = XHS_NOTE_URL_PATTERN.match(note_url)
    if not match:
        _raise_url_collection_error(400, "unsupported_url", "未识别到有效的小红书笔记 ID。")
    return match.group(1).strip()


def _normalize_media_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    if not normalized:
        return ""
    if normalized.startswith("//"):
        return f"https:{normalized}"
    if normalized.startswith("http://"):
        return normalized.replace("http://", "https://", 1)
    return normalized


def _dedupe_media_urls(values: List[str]) -> List[str]:
    unique: Dict[str, str] = {}
    for item in values:
        normalized = _normalize_media_url(item)
        if not normalized:
            continue
        identity = normalized
        if "xhscdn.com" in normalized or "xiaohongshu.com" in normalized:
            without_variant = re.sub(r'![^/?#]+(?=($|[?#]))', "", normalized)
            without_query = without_variant.split("?", 1)[0].split("#", 1)[0]
            last_segment = without_query.rstrip("/").split("/")[-1] if without_query else ""
            identity = last_segment or without_variant
        if identity and identity not in unique:
            unique[identity] = normalized
    return list(unique.values())


def _pick_image_urls(image_list: Any) -> List[str]:
    if not isinstance(image_list, list):
        return []

    urls: List[str] = []
    for item in image_list:
        if not isinstance(item, dict):
            continue
        candidates = [
            item.get("url_default"),
            item.get("urlDefault"),
            item.get("url"),
            item.get("url_pre"),
            item.get("urlPre"),
        ]
        info_list = item.get("info_list") or item.get("infoList") or []
        if isinstance(info_list, list):
            for info in info_list:
                if isinstance(info, dict):
                    candidates.append(info.get("url"))
        for candidate in candidates:
            normalized = _normalize_media_url(candidate)
            if normalized and "/avatar/" not in normalized:
                urls.append(normalized)
    return _dedupe_media_urls(urls)


def _normalize_tag_list(tag_list: Any) -> List[str]:
    if not isinstance(tag_list, list):
        return []

    result: List[str] = []
    for item in tag_list:
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            if name:
                result.append(name)
        elif isinstance(item, str) and item.strip():
            result.append(item.strip())
    return result


def _extract_initial_state_note(html: str, note_id: str) -> Optional[Dict[str, Any]]:
    try:
        match = re.search(r"window\.__INITIAL_STATE__=(\{.*?\})</script>", html, re.S)
        if not match:
            return None
        state = json.loads(match.group(1).replace(":undefined", ":null").replace("undefined", '""'))
        return (
            state.get("note", {})
            .get("noteDetailMap", {})
            .get(note_id, {})
            .get("note")
        )
    except Exception:
        return None


def _classify_collect_by_url_failure(html: str) -> str:
    lowered = html.lower()
    if any(fragment in lowered for fragment in ("captcha", "verify", "验证", "登录", "login")):
        return "token_expired_or_blocked"
    if "__initial_state__" not in lowered or "noteDetailMap" not in html:
        return "token_expired_or_blocked"
    return "parse_failed"


def _map_note_detail_to_scraped_note(note_url: str, note_detail: Dict[str, Any]) -> Dict[str, Any]:
    user = note_detail.get("user") or {}
    interact = note_detail.get("interact_info") or note_detail.get("interactInfo") or {}
    image_list = _pick_image_urls(note_detail.get("image_list") or note_detail.get("imageList") or [])
    note_id = str(note_detail.get("note_id") or note_detail.get("noteId") or _extract_xhs_note_id(note_url))
    title = str(note_detail.get("title") or "").strip()
    desc = str(note_detail.get("desc") or "").strip()

    return {
        "id": note_id,
        "title": title,
        "desc": desc,
        "author": str(user.get("nickname") or user.get("nick_name") or "未知作者"),
        "authorAvatar": _normalize_media_url(user.get("avatar") or user.get("avatar_url")),
        "likes": str(interact.get("liked_count") or interact.get("likedCount") or "0"),
        "stars": str(interact.get("collected_count") or interact.get("collectedCount") or "0"),
        "views": "0",
        "shares": str(interact.get("share_count") or interact.get("shareCount") or "0"),
        "imageUrl": image_list[0] if image_list else "",
        "imageList": image_list,
        "stableImageUrl": image_list[0] if image_list else "",
        "stableImageList": image_list,
        "tags": _normalize_tag_list(note_detail.get("tag_list") or note_detail.get("tagList")),
        "ipLocation": str(note_detail.get("ip_location") or note_detail.get("ipLocation") or ""),
        "time": note_detail.get("time"),
        "noteUrl": note_url,
        "commentCount": str(interact.get("comment_count") or interact.get("commentCount") or "0"),
        "comments": [],
    }


@router.get("/image-proxy")
async def image_proxy(url: str = Query(..., description="原始图片地址")):
    try:
        normalized_url = normalize_remote_public_url(url)
        if not normalized_url:
            raise HTTPException(status_code=400, detail="图片地址不能为空")
        if not is_safe_public_url(normalized_url, allowed_hosts=settings.IMAGE_PROXY_ALLOWED_HOSTS):
            raise HTTPException(status_code=400, detail="图片地址不在允许的公网域名范围内")

        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(20.0, connect=8.0),
        ) as client:
            response = await client.get(
                normalized_url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Referer": "https://www.xiaohongshu.com/",
                    "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                },
            )

        response.raise_for_status()
        final_url = normalize_remote_public_url(str(response.url))
        if not is_safe_public_url(final_url, allowed_hosts=settings.IMAGE_PROXY_ALLOWED_HOSTS):
            raise HTTPException(status_code=400, detail="图片代理跳转到了不安全地址")

        content_type = response.headers.get("Content-Type", "image/jpeg")
        cache_control = response.headers.get("Cache-Control") or "public, max-age=86400, stale-while-revalidate=604800"
        headers = {
            "Cache-Control": cache_control,
        }
        content_length = response.headers.get("Content-Length")
        if content_length:
            headers["Content-Length"] = content_length

        return Response(
            content=response.content,
            media_type=content_type,
            headers=headers,
        )
    except httpx.HTTPStatusError as error:
        logger.warning(f"图片代理失败 HTTP {error.response.status_code}: {url}")
        raise HTTPException(status_code=error.response.status_code, detail="图片代理失败")
    except httpx.HTTPError as error:
        logger.error(f"图片代理网络异常: {error}", exc_info=True)
        raise HTTPException(status_code=502, detail="图片代理网络异常")
    except Exception as error:
        logger.error(f"图片代理失败: {error}", exc_info=True)
        raise HTTPException(status_code=500, detail="图片代理失败")


@router.post("/rasterize-template")
async def rasterize_template(request: RasterizeTemplateRequest):
    try:
        data_url = (request.data_url or "").strip()
        if not data_url.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="只支持 data:image 格式")

        width = 1080
        height = 1440
        svg = ""
        if data_url.startswith("data:image/svg+xml"):
            payload = data_url.split(",", 1)[1] if "," in data_url else ""
            svg = unquote(payload)
            width_match = re.search(r'width="(\d+)"', svg)
            height_match = re.search(r'height="(\d+)"', svg)
            if width_match:
                width = int(width_match.group(1))
            if height_match:
                height = int(height_match.group(1))

        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
            try:
                if svg:
                    await page.set_content(svg, wait_until="load")
                    await page.wait_for_timeout(500)
                    image = await page.screenshot(type="png")
                else:
                    html = f"""
                    <!doctype html>
                    <html>
                      <body style="margin:0;padding:0;background:#fff;overflow:hidden;">
                        <img
                          id="target"
                          src={json.dumps(data_url)}
                          style="display:block;width:{width}px;height:{height}px;object-fit:contain;"
                        />
                      </body>
                    </html>
                    """
                    await page.set_content(html, wait_until="load")
                    await page.wait_for_selector("#target")
                    await page.wait_for_timeout(300)
                    image = await page.locator("#target").screenshot(type="png")
            finally:
                await browser.close()

        return Response(content=image, media_type="image/png")
    except HTTPException:
        raise
    except Exception as error:
        logger.error(f"模板图光栅化失败: {error}", exc_info=True)
        raise HTTPException(status_code=500, detail="模板图光栅化失败")


@router.post("/collect-by-url")
async def collect_by_url(
    request: CollectByUrlRequest,
    _user_id: str = Depends(get_current_user_id),
):
    normalized_url = _normalize_xhs_note_url(request.url)
    note_id = _extract_xhs_note_id(normalized_url)

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(20.0, connect=8.0),
        ) as client:
            response = await client.get(
                normalized_url,
                headers={
                    "User-Agent": XHS_USER_AGENT,
                    "Referer": "https://www.xiaohongshu.com/",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                },
            )
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        logger.warning("URL采集失败 HTTP %s: %s", error.response.status_code, normalized_url)
        _raise_url_collection_error(502, "fetch_failed", f"请求小红书详情页失败：HTTP {error.response.status_code}")
    except httpx.HTTPError as error:
        logger.error("URL采集网络异常: %s", error, exc_info=True)
        _raise_url_collection_error(502, "fetch_failed", "请求小红书详情页失败，请稍后重试。")

    html = response.text or ""
    note_detail = _extract_initial_state_note(html, note_id)
    if not note_detail:
        failure_code = _classify_collect_by_url_failure(html)
        message = (
            "链接可访问，但当前未能解析到笔记详情，可能是 token 已失效、触发风控或需要登录态。"
            if failure_code == "token_expired_or_blocked"
            else "链接可访问，但未能解析到笔记正文和图片信息。"
        )
        _raise_url_collection_error(422, failure_code, message)

    try:
        scraped_note = _map_note_detail_to_scraped_note(normalized_url, note_detail)
    except HTTPException:
        raise
    except Exception as error:
        logger.error("URL采集结构化失败: %s", error, exc_info=True)
        _raise_url_collection_error(500, "parse_failed", "笔记详情解析成功，但结构化输出失败。")

    return {
        "success": True,
        "data": {
            "note": scraped_note,
            "collection_mode": "url",
            "source_input": normalized_url,
        },
    }


def _ensure_scrape_history_schema(db: Session) -> None:
    if not settings.allow_runtime_schema_fallback:
        logger.info("[Scraper] 生产模式跳过 scrape_history 运行时 schema 兜底")
        return

    if db is None:
        return

    inspector = inspect(db.bind)
    table_names = inspector.get_table_names()
    if "scrape_history" not in table_names:
        db.execute(text("""
            CREATE TABLE scrape_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id VARCHAR(64) NOT NULL,
                task_id VARCHAR(64) NOT NULL UNIQUE,
                keyword VARCHAR(128),
                collection_mode VARCHAR(32),
                source_input TEXT,
                notes_count INTEGER DEFAULT 0,
                notes_data TEXT,
                analysis_result TEXT,
                filters TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_scrape_history_user_id ON scrape_history (user_id)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS ix_scrape_history_task_id ON scrape_history (task_id)"))
        db.execute(text("CREATE INDEX IF NOT EXISTS idx_scrape_user_created ON scrape_history (user_id, created_at)"))
        db.commit()
        return

    columns = {column["name"] for column in inspector.get_columns("scrape_history")}
    if "collection_mode" not in columns:
        db.execute(text("ALTER TABLE scrape_history ADD COLUMN collection_mode VARCHAR(32)"))
        db.commit()
    if "source_input" not in columns:
        db.execute(text("ALTER TABLE scrape_history ADD COLUMN source_input TEXT"))
        db.commit()
    if "filters" not in columns:
        db.execute(text("ALTER TABLE scrape_history ADD COLUMN filters TEXT"))
        db.commit()
    if "product_brief" not in columns:
        db.execute(text("ALTER TABLE scrape_history ADD COLUMN product_brief TEXT"))
        db.commit()


def _deserialize_history_json(value: Any) -> Any:
    if not value:
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value


def _build_history_summary(history: Any) -> Dict[str, Any]:
    item = history.to_dict(include_data=False)
    item["has_analysis"] = bool(item.get("analysis_result"))
    item["analysis_result"] = None
    item["filters"] = _deserialize_history_json(item.get("filters"))
    item["product_brief"] = _deserialize_history_json(item.get("product_brief"))
    return item


def _classify_history_write_error(error: Exception) -> str:
    error_text = str(getattr(error, "orig", error) or error).lower()
    if "data too long" in error_text or "1406" in error_text:
        return "历史记录写入数据库失败：当前数据库字段容量不足，请先执行 alembic upgrade head。"
    if "max_allowed_packet" in error_text:
        return "历史记录写入数据库失败：数据库报文大小不足，请检查 MySQL 配置。"
    return "历史记录写入数据库失败，请检查数据库连接或执行最新迁移。"

@router.post("/analyze-local-data")
async def analyze_local_data(
    request: AnalyzeLocalRequest,
    user_id: str = Depends(get_current_user_id)
):
    try:
        from backend.services.content_analyzer import ContentAnalyzer, CONTENT_CATEGORIES

        analyzer = ContentAnalyzer()

        def pick_cover_images(note: Dict[str, Any]) -> List[str]:
            detail = note.get("detail", {}) or {}
            note_card = note.get("note_card", {}) or {}
            cover = note_card.get("cover", {}) or {}

            def normalize_url(value: Any) -> str:
                if not isinstance(value, str):
                    return ""
                normalized = value.strip()
                if not normalized:
                    return ""
                if normalized.startswith("//"):
                    return f"https:{normalized}"
                return normalized

            def split_image_string(value: Any) -> List[str]:
                normalized = normalize_url(value)
                if not normalized:
                    return []
                if "," not in normalized:
                    return [normalized]
                return [item for item in [normalize_url(part) for part in normalized.split(",")] if item]

            def normalize_identity(value: Any) -> str:
                candidate = normalize_url(value)
                if not candidate:
                    return ""
                if candidate.startswith("/api/scraper/image-proxy?url="):
                    encoded = candidate.split("/api/scraper/image-proxy?url=", 1)[1]
                    try:
                        candidate = unquote(encoded)
                    except Exception:
                        candidate = encoded
                if candidate.startswith("http://"):
                    candidate = candidate.replace("http://", "https://", 1)
                return candidate

            def dedupe_urls(values: List[str]) -> List[str]:
                unique: Dict[str, str] = {}
                for value in values:
                    normalized = normalize_url(value)
                    identity = normalize_identity(normalized)
                    if normalized and identity and identity not in unique:
                        unique[identity] = normalized
                return list(unique.values())

            def pick_preferred_image_url(value: Any) -> str:
                if isinstance(value, str):
                    urls = split_image_string(value)
                    return urls[0] if urls else ""
                if not isinstance(value, dict):
                    return ""
                for candidate in [
                    value.get("urlDefault"),
                    value.get("url_default"),
                    value.get("url"),
                    value.get("url_pre"),
                    (value.get("info_list") or [{}])[0].get("url") if isinstance(value.get("info_list"), list) else "",
                ]:
                    normalized = normalize_url(candidate)
                    if normalized:
                        return normalized
                return ""

            def extract_urls_from_mixed_field(value: Any) -> List[str]:
                if isinstance(value, str):
                    return split_image_string(value)
                if not isinstance(value, list):
                    preferred = pick_preferred_image_url(value)
                    return [preferred] if preferred else []
                urls: List[str] = []
                for item in value:
                    if isinstance(item, str):
                        urls.extend(split_image_string(item))
                    else:
                        preferred = pick_preferred_image_url(item)
                        if preferred:
                            urls.append(preferred)
                return [item for item in urls if item]

            def choose_primary_image_sequence(*sources: Any) -> List[str]:
                for source in sources:
                    images = dedupe_urls(extract_urls_from_mixed_field(source))
                    if images:
                        return images
                return []

            primary_images = choose_primary_image_sequence(
                note.get("imageList"),
                note.get("image_list"),
                detail.get("imageList"),
                detail.get("images_list"),
                note_card.get("image_list"),
            )
            if primary_images:
                return primary_images

            return dedupe_urls([
                pick_preferred_image_url(cover),
                pick_preferred_image_url(detail.get("cover")),
                normalize_url(note.get("imageUrl")),
                normalize_url(note.get("image_url")),
                normalize_url(note.get("cover")),
            ])

        formatted_notes = []
        for note in request.notes:
            detail = note.get("detail", {}) or {}
            title = note.get("note_card", {}).get("display_title") or note.get("detail", {}).get("title") or note.get("title", "")
            desc = detail.get("desc") or note.get("desc", "")
            user = note.get("note_card", {}).get("user", {}) or detail.get("user", {}) or {}
            comments = _normalize_comment_payload(note.get("comments"))
            
            liked_count = note.get("note_card", {}).get("interact_info", {}).get("liked_count") or detail.get("interactInfo", {}).get("likedCount") or note.get("likes", "0")
            collected_count = note.get("note_card", {}).get("interact_info", {}).get("collected_count") or detail.get("interactInfo", {}).get("collectedCount") or note.get("stars", "0")
            comment_count = (
                note.get("note_card", {}).get("interact_info", {}).get("comment_count")
                or detail.get("interactInfo", {}).get("commentCount")
                or note.get("commentCount")
                or note.get("comment_count")
                or len(comments)
            )
            share_count = note.get("note_card", {}).get("interact_info", {}).get("share_count") or note.get("shares", "0")
            image_list = pick_cover_images(note)
            
            formatted_notes.append({
                "id": note.get("id") or note.get("note_id") or title,
                "title": title,
                "desc": desc,
                "author": user.get("nickname") or user.get("nick_name") or note.get("author", "未知作者"),
                "authorAvatar": user.get("avatar") or user.get("avatar_url") or note.get("authorAvatar", ""),
                "liked_count": str(liked_count),
                "collected_count": str(collected_count),
                "comment_count": str(comment_count),
                "commentCount": str(comment_count),
                "shares": str(share_count),
                "share_count": str(share_count),
                "time": note.get("time"),
                "tags": detail.get("tags") or note.get("tags") or [],
                "imageUrl": image_list[0] if image_list else "",
                "imageList": image_list,
                "stableImageUrl": note.get("stableImageUrl") or "",
                "stableImageList": note.get("stableImageList") or [],
                "noteUrl": note.get("noteUrl") or (note.get("id") and f"https://www.xiaohongshu.com/explore/{note.get('id')}"),
                "comments": comments,
            })
            
        logger.info(f"开始分析本地数据，共 {len(formatted_notes)} 条")

        all_candidate_notes = formatted_notes
        viral_notes = analyzer.filter_viral_notes(all_candidate_notes, min_likes=50, min_collects=30)
        enriched_notes = []
        grouped_notes: Dict[str, List[Dict[str, Any]]] = {}

        for note in all_candidate_notes:
            category_info = analyzer._classify_category(note)
            score_info = analyzer._compute_note_scores(
                note,
                request.product_brief,
                category_info["content_category"]
            )
            enriched_note = {
                **note,
                **category_info,
                **score_info,
                "material_dependency": analyzer._infer_material_dependency(note, category_info["content_category"]),
            }
            enriched_notes.append(enriched_note)
            grouped_notes.setdefault(category_info["content_category"], []).append(enriched_note)

        for category_notes in grouped_notes.values():
            category_notes.sort(
                key=lambda item: (
                    item["recommendation_tier"] == "强推荐",
                    item["rewrite_value_score"],
                    item["commercial_fit_score"]
                ),
                reverse=True
            )

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

        basic_stats = analyzer.extract_basic_stats(enriched_notes)
        time_patterns = analyzer.extract_time_patterns(enriched_notes)
        ai_insights = await run_text_job(
            analyzer.analyze_with_ai,
            enriched_notes,
            category_summary,
            timeout_seconds=120.0,
        )
        real_phrases = analyzer._extract_real_phrases(enriched_notes)
        next_collection_tasks = analyzer._build_followup_tasks(category_summary, request.product_brief)

        return {
            "success": True,
            "data": {
                "viral_notes_count": len(viral_notes),
                "basic_stats": basic_stats,
                "ai_insights": ai_insights,
                "time_patterns": time_patterns,
                "benchmark_notes": enriched_notes,
                "grouped_benchmark_notes": grouped_notes,
                "category_summary": category_summary,
                "real_phrases": real_phrases,
                "next_collection_tasks": next_collection_tasks,
                "product_brief": request.product_brief or {},
            }
        }
    except ValueError as error:
        logger.warning(f"分析配置缺失: {error}")
        return {"success": False, "message": str(error), "data": None}
        
    except asyncio.TimeoutError:
        logger.error("分析本地数据 AI 洞察超时")
        return {"success": False, "message": "AI 分析超时，请稍后重试", "data": None}

    except Exception as e:
        classified = classify_model_gateway_error(e)
        if classified["kind"] != "unknown":
            raise HTTPException(status_code=classified["status_code"], detail=classified["message"])
        logger.error(f"分析本地数据失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/history")
async def save_history(
    request: SaveHistoryRequest,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ScrapeHistory
        from backend.services.product_profile_service import has_meaningful_product_brief, upsert_product_profile
        import uuid

        _ensure_scrape_history_schema(db)
        
        task_id = str(uuid.uuid4())
        
        history = ScrapeHistory(
            user_id=user_id,
            task_id=task_id,
            keyword=request.keyword,
            collection_mode=(request.collection_mode or "keyword"),
            source_input=(request.source_input or request.keyword),
            notes_count=request.notes_count,
            notes_data=json.dumps(request.notes_data, ensure_ascii=False),
            analysis_result=json.dumps(request.analysis_result, ensure_ascii=False) if request.analysis_result else None,
            filters=json.dumps(request.filters, ensure_ascii=False) if request.filters else None,
            product_brief=json.dumps(request.product_brief, ensure_ascii=False) if request.product_brief else None,
        )
        db.add(history)
        if request.product_brief and has_meaningful_product_brief(request.product_brief):
            upsert_product_profile(db, user_id, request.product_brief, preserve_research_context=False)
        db.commit()
        db.refresh(history)

        return {"success": True, "data": _build_history_summary(history)}
    except (DBAPIError, SQLAlchemyError) as e:
        logger.error(f"保存历史记录失败: {e}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=_classify_history_write_error(e))
    except Exception as e:
        logger.error(f"保存历史记录失败: {e}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/history")
async def get_histories(
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ScrapeHistory
        from backend.services.product_profile_service import has_meaningful_product_brief, upsert_product_profile

        _ensure_scrape_history_schema(db)
        
        histories = db.query(ScrapeHistory).filter(
            ScrapeHistory.user_id == user_id
        ).order_by(ScrapeHistory.created_at.desc()).all()

        history_items = []
        for history in histories:
            history_items.append(_build_history_summary(history))

        return {"success": True, "data": history_items}
    except Exception as e:
        logger.error(f"获取历史记录列表失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/history/{task_id}")
async def get_history_detail(
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ScrapeHistory

        _ensure_scrape_history_schema(db)
        
        history = db.query(ScrapeHistory).filter(
            ScrapeHistory.user_id == user_id,
            ScrapeHistory.task_id == task_id
        ).first()
        
        if not history:
            raise HTTPException(status_code=404, detail="历史记录不存在")
            
        data = history.to_dict(include_data=True)
        if data.get("notes_data"):
            data["notes_data"] = json.loads(data["notes_data"])
        if data.get("analysis_result"):
            data["analysis_result"] = json.loads(data["analysis_result"])
        if data.get("filters"):
            data["filters"] = json.loads(data["filters"])
        if data.get("product_brief"):
            data["product_brief"] = json.loads(data["product_brief"])
            
        return {"success": True, "data": data}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取历史记录详情失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.put("/history/{task_id}/analysis")
async def update_history_analysis(
    task_id: str,
    request: dict,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ScrapeHistory

        _ensure_scrape_history_schema(db)
        
        history = db.query(ScrapeHistory).filter(
            ScrapeHistory.user_id == user_id,
            ScrapeHistory.task_id == task_id
        ).first()
        
        if not history:
            raise HTTPException(status_code=404, detail="历史记录不存在")
            
        if "analysis_result" in request:
            history.analysis_result = json.dumps(request["analysis_result"], ensure_ascii=False)
        if "filters" in request:
            history.filters = json.dumps(request["filters"], ensure_ascii=False) if request["filters"] else None
        if "product_brief" in request:
            history.product_brief = json.dumps(request["product_brief"], ensure_ascii=False) if request["product_brief"] else None
            if request["product_brief"] and has_meaningful_product_brief(request["product_brief"]):
                upsert_product_profile(db, user_id, request["product_brief"], preserve_research_context=False)
        db.commit()
            
        return {"success": True}
    except Exception as e:
        logger.error(f"更新历史记录分析结果失败: {e}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/history/{task_id}")
async def delete_history(
    task_id: str,
    user_id: str = Depends(get_current_user_id),
    db: Session = Depends(get_db)
):
    try:
        from backend.database.models import ScrapeHistory

        _ensure_scrape_history_schema(db)

        history = db.query(ScrapeHistory).filter(
            ScrapeHistory.user_id == user_id,
            ScrapeHistory.task_id == task_id
        ).first()

        if not history:
            raise HTTPException(status_code=404, detail="历史记录不存在")

        db.delete(history)
        db.commit()

        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除历史记录失败: {e}", exc_info=True)
        if db:
            db.rollback()
        raise HTTPException(status_code=500, detail=str(e))
