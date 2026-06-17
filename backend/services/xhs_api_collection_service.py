import asyncio
import json
from typing import Dict, List, Optional, Callable
from datetime import datetime
from pathlib import Path

from playwright.async_api import BrowserContext, Page

from .xhs_api_client import XHSApiClient


class XHSApiCollectionService:
    
    def __init__(self, playwright_page: Page, browser_context: BrowserContext):
        self.api_client = XHSApiClient(playwright_page, browser_context)
        self.collected_notes = []
    
    async def collect_notes(
        self,
        keyword: str,
        max_count: int = 20,
        sort: str = "general",
        progress_callback: Optional[Callable] = None
    ) -> List[Dict]:
        self.collected_notes = []
        
        page = 1
        page_size = 20
        total_collected = 0
        
        if progress_callback:
            await progress_callback(f"开始采集关键词: {keyword}")
        
        while total_collected < max_count:
            try:
                if progress_callback:
                    await progress_callback(f"正在采集第 {page} 页...")
                
                result = await self.api_client.search_notes(
                    keyword=keyword,
                    page=page,
                    page_size=page_size,
                    sort=sort
                )
                
                if not result or not result.get("items"):
                    if progress_callback:
                        await progress_callback("没有更多内容了")
                    break
                
                items = result.get("items", [])
                valid_items = [
                    item for item in items 
                    if item.get("model_type") not in ("rec_query", "hot_query")
                ]
                
                if progress_callback:
                    await progress_callback(f"第 {page} 页找到 {len(valid_items)} 条笔记")
                
                for item in valid_items:
                    if total_collected >= max_count:
                        break
                    
                    note_data = self._extract_note_from_search_result(item, keyword)
                    if note_data:
                        self.collected_notes.append(note_data)
                        total_collected += 1
                        
                        if progress_callback:
                            await progress_callback(
                                f"已采集 {total_collected}/{max_count}: {note_data['title'][:20]}..."
                            )
                
                if not result.get("has_more", False):
                    if progress_callback:
                        await progress_callback("已到最后一页")
                    break
                
                page += 1
                await asyncio.sleep(1)
                
            except Exception as e:
                if progress_callback:
                    await progress_callback(f"采集出错: {str(e)}")
                print(f"[XHSApiCollectionService] 采集异常: {e}")
                import traceback
                traceback.print_exc()
                break
        
        if progress_callback:
            await progress_callback(f"采集完成！共采集 {total_collected} 条笔记")
        
        return self.collected_notes
    
    def _extract_note_from_search_result(self, item: Dict, keyword: str) -> Optional[Dict]:
        try:
            note_id = item.get("id", "")
            note_card = item.get("note_card", {})
            
            if not note_card:
                return None
            
            user_info = note_card.get("user", {})
            interact_info = note_card.get("interact_info", {})
            image_list = note_card.get("image_list", [])
            
            cover_url = ""
            if image_list:
                cover_url = image_list[0].get("url_default", "") or image_list[0].get("url", "")
            
            cover_url = cover_url.replace("http://", "https://")
            
            note_url = f"https://www.xiaohongshu.com/explore/{note_id}"
            
            return {
                "note_id": note_id,
                "title": note_card.get("display_title", ""),
                "desc": note_card.get("desc", ""),
                "note_url": note_url,
                "author_name": user_info.get("nickname", ""),
                "author_id": user_info.get("user_id", ""),
                "likes_count": int(interact_info.get("liked_count", "0")),
                "collected_count": int(interact_info.get("collected_count", "0")),
                "comment_count": int(interact_info.get("comment_count", "0")),
                "share_count": int(interact_info.get("share_count", "0")),
                "cover_url": cover_url,
                "note_type": note_card.get("type", "normal"),
                "keyword": keyword,
                "xsec_token": item.get("xsec_token", ""),
                "xsec_source": item.get("xsec_source", ""),
                "collected_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
        except Exception as e:
            print(f"[XHSApiCollectionService] 提取笔记数据失败: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    async def get_note_detail(self, note_id: str, xsec_token: str = "", xsec_source: str = "pc_search") -> Optional[Dict]:
        try:
            result = await self.api_client.get_note_detail(
                note_id=note_id,
                xsec_token=xsec_token,
                xsec_source=xsec_source
            )
            
            if not result:
                return None
            
            items = result.get("items", [])
            if not items:
                return None
            
            note_detail = items[0].get("note_card", {})
            return note_detail
            
        except Exception as e:
            print(f"[XHSApiCollectionService] 获取笔记详情失败: {e}")
            return None
    
    def save_to_json(self, output_dir: str = "src/data") -> str:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"xhs_notes_{timestamp}.json"
        filepath = Path(output_dir) / filename
        
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(self.collected_notes, f, ensure_ascii=False, indent=2)
        
        print(f"[XHSApiCollectionService] 数据已保存到: {filepath}")
        return str(filepath)
    
    def get_collected_notes(self) -> List[Dict]:
        return self.collected_notes
