import asyncio
import os
import json
import re
from datetime import datetime
from typing import Dict, List, Optional
from playwright.async_api import BrowserContext, Page, async_playwright


class XHSCollectionService:
    
    def __init__(self):
        self.browser_context: Optional[BrowserContext] = None
        self.context_page: Optional[Page] = None
        self.user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        self.index_url = "https://www.xiaohongshu.com"
        self.user_data_dir = os.path.join(
            os.getcwd(),
            "browser_data",
            "xhs_user_data_dir"
        )
    
    async def start_collection(
        self,
        keywords: str,
        max_notes_count: int = 20,
        sort_type: str = "general",
        enable_comments: bool = False,
        max_comments_per_note: int = 10,
        headless: bool = True
    ) -> dict:
        try:
            if not os.path.exists(self.user_data_dir):
                return {
                    "success": False,
                    "message": "未检测到登录状态，请先完成登录",
                    "data": None
                }
            
            async with async_playwright() as playwright:
                crashpad_dir = os.path.join(self.user_data_dir, "Crashpad")
                os.makedirs(crashpad_dir, exist_ok=True)
                
                self.browser_context = await playwright.chromium.launch_persistent_context(
                    user_data_dir=self.user_data_dir,
                    headless=headless,
                    user_agent=self.user_agent,
                    viewport={"width": 1920, "height": 1080},
                    args=[
                        "--disable-blink-features=AutomationControlled",
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-crash-reporter",
                        "--disable-breakpad"
                    ]
                )
                
                self.context_page = self.browser_context.pages[0] if self.browser_context.pages else await self.browser_context.new_page()
                
                await self.context_page.goto(
                    self.index_url, 
                    wait_until="domcontentloaded",
                    timeout=60000
                )
                await asyncio.sleep(3)
                
                is_logged_in = await self._check_login_status()
                if not is_logged_in:
                    await self.cleanup()
                    return {
                        "success": False,
                        "message": "登录状态已失效，请重新登录",
                        "data": None
                    }
                
                print(f"[XHSCollectionService] 开始采集关键词: {keywords}")
                
                all_notes = []
                keyword_list = [kw.strip() for kw in keywords.split(",") if kw.strip()]
                
                for keyword in keyword_list:
                    notes = await self._search_keyword(
                        keyword=keyword,
                        max_count=max_notes_count,
                        enable_comments=enable_comments,
                        max_comments_per_note=max_comments_per_note
                    )
                    all_notes.extend(notes)
                
                output_file = None
                if all_notes:
                    output_file = self._save_notes_to_file(all_notes, keywords)
                
                await self.cleanup()
                
                return {
                    "success": True,
                    "message": f"采集完成，共获取 {len(all_notes)} 条笔记",
                    "data": {
                        "notes_count": len(all_notes),
                        "output_file": output_file,
                        "notes": all_notes
                    }
                }
                
        except Exception as e:
            print(f"[XHSCollectionService] ========== 采集异常 ==========")
            print(f"[XHSCollectionService] ✗ 采集过程出错: {e}")
            print(f"[XHSCollectionService] 详细错误信息:")
            import traceback
            traceback.print_exc()
            print(f"[XHSCollectionService] 已采集数据: {len(collected_notes)} 条")
            print(f"[XHSCollectionService] ==========================================")
            await self.cleanup()
            return {
                "success": False,
                "message": f"采集失败: {str(e)}",
                "data": None
            }
    
    async def _check_login_status(self) -> bool:
        try:
            await self.context_page.wait_for_timeout(2000)
            
            login_selectors = [
                "xpath=//a[contains(@href, '/user/profile')]",
                "xpath=//div[contains(@class, 'login')]//button[contains(text(), '登录')]",
                "xpath=//span[text()='登录']"
            ]
            
            for selector in login_selectors:
                try:
                    is_login_button = await self.context_page.is_visible(selector, timeout=3000)
                    if is_login_button and '登录' in selector:
                        return False
                    elif is_login_button and 'profile' in selector:
                        return True
                except Exception:
                    continue
            
            cookies = await self.browser_context.cookies()
            has_auth_cookies = any(
                cookie.get('name') in ['web_session', 'webId', 'a1', 'websectiga']
                for cookie in cookies
            )
            
            return has_auth_cookies
            
        except Exception as e:
            print(f"[XHSCollectionService] 检查登录状态失败: {e}")
            return False
    
    async def _search_keyword(
        self,
        keyword: str,
        max_count: int,
        enable_comments: bool,
        max_comments_per_note: int
    ) -> List[Dict]:
        collected_notes = []
        
        try:
            search_url = f"https://www.xiaohongshu.com/search_result?keyword={keyword}&source=web_search_result_notes"
            print(f"[XHSCollectionService] ========== 开始采集关键词: {keyword} ==========")
            print(f"[XHSCollectionService] 目标采集数量: {max_count} 条")
            print(f"[XHSCollectionService] 正在导航至搜索页面...")
            print(f"[XHSCollectionService] URL: {search_url}")
            
            await self.context_page.goto(
                search_url, 
                wait_until="domcontentloaded",
                timeout=60000
            )
            print(f"[XHSCollectionService] 页面加载完成，等待内容渲染...")
            await asyncio.sleep(5)
            print(f"[XHSCollectionService] 内容渲染完成")
            
            scroll_count = 0
            max_scrolls = max(3, max_count // 10)
            
            print(f"[XHSCollectionService] 开始提取笔记卡片...")
            
            while scroll_count < max_scrolls and len(collected_notes) < max_count:
                print(f"[XHSCollectionService] 第 {scroll_count + 1} 次扫描页面...")
                note_cards = await self.context_page.query_selector_all("section.note-item, div.note-item, a.cover.ld.mask")
                
                if not note_cards:
                    note_cards = await self.context_page.query_selector_all("xpath=//section[contains(@class, 'note')]")
                
                if not note_cards:
                    note_cards = await self.context_page.query_selector_all("xpath=//a[contains(@href, '/explore/')]")
                
                print(f"[XHSCollectionService] 当前页面发现 {len(note_cards)} 个笔记卡片")
                
                for idx, card in enumerate(note_cards[len(collected_notes):], len(collected_notes) + 1):
                    if len(collected_notes) >= max_count:
                        break
                    
                    try:
                        print(f"[XHSCollectionService] 正在处理第 {idx} 个卡片...")
                        note_data = await self._extract_note_from_card(card)
                        if note_data:
                            if enable_comments:
                                note_data["comments"] = await self._get_note_comments_from_detail(
                                    note_data.get("note_url"),
                                    max_comments_per_note
                                )
                            collected_notes.append(note_data)
                            print(f"[XHSCollectionService] ✓ 成功采集笔记: {note_data['title'][:20]}... (ID: {note_data['note_id']})")
                            print(f"[XHSCollectionService] 进度: {len(collected_notes)}/{max_count} 条")
                    except Exception as e:
                         print(f"[XHSCollectionService]   ✗ 提取笔记数据失败: {e}")
                         print(f"[XHSCollectionService]   → 跳过该卡片，继续处理下一个...")
                         continue
                
                if len(collected_notes) < max_count:
                    print(f"[XHSCollectionService] 当前已采集 {len(collected_notes)} 条，继续向下滚动...")
                    await self.context_page.evaluate("window.scrollBy(0, window.innerHeight)")
                    print(f"[XHSCollectionService] 等待新内容加载...")
                    await self.context_page.wait_for_timeout(2000)
                    scroll_count += 1
                    print(f"[XHSCollectionService] 滚动完成 ({scroll_count}/{max_scrolls})")
                else:
                    print(f"[XHSCollectionService] 已达到目标采集数量，停止滚动")
            
        except Exception as e:
            print(f"[XHSCollectionService] ========== 采集异常 ==========")
            print(f"[XHSCollectionService] ✗ 搜索关键词 {keyword} 出错: {e}")
            print(f"[XHSCollectionService] 详细错误信息:")
            import traceback
            traceback.print_exc()
            print(f"[XHSCollectionService] 已采集数据: {len(collected_notes)} 条")
            print(f"[XHSCollectionService] ==========================================")
        
        print(f"[XHSCollectionService] ========== 采集完成 ==========")
        print(f"[XHSCollectionService] 总计采集: {len(collected_notes)} 条笔记")
        print(f"[XHSCollectionService] 目标数量: {max_count} 条")
        print(f"[XHSCollectionService] 完成率: {len(collected_notes)/max_count*100:.1f}%")
        return collected_notes
    
    async def _extract_note_from_card(self, card) -> Optional[Dict]:
        try:
            note_url = ""
            if await card.get_attribute("href"):
                note_url = await card.get_attribute("href")
            else:
                link_elem = await card.query_selector("a[href*='/explore/']")
                if not link_elem:
                    link_elem = await card.query_selector("a")
                note_url = await link_elem.get_attribute("href") if link_elem else ""
            
            if note_url and not note_url.startswith("http"):
                note_url = f"https://www.xiaohongshu.com{note_url}"
            
            if not note_url or "/explore/" not in note_url:
                return None
            
            note_id = ""
            match = re.search(r'/explore/([a-f0-9]+)', note_url)
            if match:
                note_id = match.group(1)
            
            title = ""
            title_selectors = [".title", "span.title", "div.title", "xpath=//span[contains(@class, 'title')]"]
            for selector in title_selectors:
                try:
                    title_elem = await card.query_selector(selector)
                    if title_elem:
                        title = await title_elem.inner_text()
                        break
                except:
                    continue
            
            author_name = ""
            author_selectors = [".author-wrapper .name", ".name", "span.name", "xpath=//span[contains(@class, 'name')]"]
            for selector in author_selectors:
                try:
                    author_elem = await card.query_selector(selector)
                    if author_elem:
                        author_name = await author_elem.inner_text()
                        break
                except:
                    continue
            
            likes_count = 0
            likes_selectors = [".footer .like-wrapper .count", ".like-count", "span.count", "xpath=//span[contains(@class, 'count')]"]
            for selector in likes_selectors:
                try:
                    likes_elem = await card.query_selector(selector)
                    if likes_elem:
                        likes_text = await likes_elem.inner_text()
                        likes_count = self._parse_count(likes_text)
                        break
                except:
                    continue
            
            cover_url = ""
            cover_selectors = ["img.cover", "img", "xpath=//img"]
            for selector in cover_selectors:
                try:
                    cover_elem = await card.query_selector(selector)
                    if cover_elem:
                        cover_url = await cover_elem.get_attribute("src")
                        if cover_url:
                            break
                except:
                    continue
            
            note_data = {
                "note_id": note_id,
                "type": "normal",
                "title": title.strip() if title else f"笔记_{note_id}",
                "desc": "",
                "video_url": "",
                "time": int(datetime.now().timestamp() * 1000),
                "last_update_time": int(datetime.now().timestamp() * 1000),
                "user_id": "",
                "nickname": author_name.strip() if author_name else "未知作者",
                "avatar": "",
                "liked_count": str(likes_count),
                "collected_count": "0",
                "comment_count": "0",
                "share_count": "0",
                "ip_location": "",
                "image_list": cover_url or "",
                "tag_list": "",
                "last_modify_ts": int(datetime.now().timestamp() * 1000),
                "note_url": note_url,
                "source_keyword": "",
                "xsec_token": ""
            }
            
            detail_data = await self._get_note_detail_data(note_url)
            if detail_data:
                note_data.update(detail_data)
            
            return note_data
        except Exception as e:
            print(f"[XHSCollectionService] 提取卡片数据失败: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    async def _get_note_detail_data(self, note_url: str) -> Optional[Dict]:
        if not note_url:
            return None
        
        try:
            print(f"[XHSCollectionService]   → 打开新标签页获取详细信息...")
            new_page = await self.browser_context.new_page()
            print(f"[XHSCollectionService]   → 正在导航至笔记详情页...")
            print(f"[XHSCollectionService]   → URL: {note_url}")
            await new_page.goto(note_url, wait_until="domcontentloaded", timeout=30000)
            print(f"[XHSCollectionService]   → 页面加载完成，等待内容渲染...")
            await new_page.wait_for_timeout(3000)
            print(f"[XHSCollectionService]   → 开始提取详细数据...")
            
            detail_data = {}
            
            desc_selectors = [
                "#detail-desc",
                ".note-content",
                "div[id*='detail']",
                "xpath=//div[contains(@class, 'desc')]",
                "xpath=//span[contains(@class, 'desc')]"
            ]
            
            desc = ""
            for selector in desc_selectors:
                try:
                    desc_elem = await new_page.query_selector(selector)
                    if desc_elem:
                        desc = await desc_elem.inner_text()
                        if desc and len(desc.strip()) > 10:
                            break
                except Exception:
                    continue
            
            if desc:
                detail_data["desc"] = desc.strip()
                print(f"[XHSCollectionService]   → ✓ 获取正文内容，长度: {len(desc)} 字符")
            
            user_id_selectors = [
                "xpath=//a[contains(@href, '/user/profile/')]",
                "xpath=//div[contains(@class, 'user')]//a[contains(@href, '/user/')]"
            ]
            
            for selector in user_id_selectors:
                try:
                    user_link = await new_page.query_selector(selector)
                    if user_link:
                        href = await user_link.get_attribute("href")
                        if href:
                            user_id_match = re.search(r'/user/profile/([a-f0-9]+)', href)
                            if user_id_match:
                                detail_data["user_id"] = user_id_match.group(1)
                                print(f"[XHSCollectionService]   → ✓ 获取用户ID: {detail_data['user_id']}")
                                break
                except Exception:
                    continue
            
            avatar_selectors = [
                "xpath=//div[contains(@class, 'user')]//img",
                "xpath=//img[contains(@class, 'avatar')]"
            ]
            
            for selector in avatar_selectors:
                try:
                    avatar_elem = await new_page.query_selector(selector)
                    if avatar_elem:
                        avatar_url = await avatar_elem.get_attribute("src")
                        if avatar_url:
                            detail_data["avatar"] = avatar_url
                            print(f"[XHSCollectionService]   → ✓ 获取头像URL")
                            break
                except Exception:
                    continue
            
            interact_selectors = {
                "collected_count": [".collect-count", "xpath=//span[contains(@class, 'collect')]"],
                "comment_count": [".comment-count", "xpath=//span[contains(@class, 'comment')]"],
                "share_count": [".share-count", "xpath=//span[contains(@class, 'share')]"]
            }
            
            for key, selectors in interact_selectors.items():
                for selector in selectors:
                    try:
                        elem = await new_page.query_selector(selector)
                        if elem:
                            text = await elem.inner_text()
                            count = self._parse_count(text)
                            detail_data[key] = str(count)
                            print(f"[XHSCollectionService]   → ✓ 获取{key}: {count}")
                            break
                    except Exception:
                        continue
            
            tag_selectors = [
                "xpath=//a[contains(@class, 'tag')]",
                "xpath=//span[contains(@class, 'tag')]"
            ]
            
            tags = []
            for selector in tag_selectors:
                try:
                    tag_elems = await new_page.query_selector_all(selector)
                    for tag_elem in tag_elems:
                        tag_text = await tag_elem.inner_text()
                        if tag_text and tag_text.strip():
                            tags.append(tag_text.strip())
                    if tags:
                        break
                except Exception:
                    continue
            
            if tags:
                detail_data["tag_list"] = ",".join(tags)
                print(f"[XHSCollectionService]   → ✓ 获取标签: {len(tags)} 个")
            
            ip_selectors = [
                "xpath=//span[contains(text(), 'IP属地')]",
                "xpath=//span[contains(@class, 'ip')]"
            ]
            
            for selector in ip_selectors:
                try:
                    ip_elem = await new_page.query_selector(selector)
                    if ip_elem:
                        ip_text = await ip_elem.inner_text()
                        if "IP属地" in ip_text:
                            detail_data["ip_location"] = ip_text.replace("IP属地：", "").replace("IP属地", "").strip()
                            print(f"[XHSCollectionService]   → ✓ 获取IP属地: {detail_data['ip_location']}")
                            break
                except Exception:
                    continue
            
            image_selectors = [
                "xpath=//div[contains(@class, 'carousel')]//img",
                "xpath=//div[contains(@class, 'swiper')]//img",
                "xpath=//img[contains(@class, 'note-image')]"
            ]
            
            images = []
            for selector in image_selectors:
                try:
                    img_elems = await new_page.query_selector_all(selector)
                    for img_elem in img_elems:
                        img_url = await img_elem.get_attribute("src")
                        if img_url and img_url not in images:
                            images.append(img_url)
                    if images:
                        break
                except Exception:
                    continue
            
            if images:
                detail_data["image_list"] = ",".join(images)
                print(f"[XHSCollectionService]   → ✓ 获取图片: {len(images)} 张")
            
            print(f"[XHSCollectionService]   → 关闭详情页标签...")
            await new_page.close()
            
            print(f"[XHSCollectionService]   → ✓ 详细信息获取完成，共 {len(detail_data)} 个字段")
            return detail_data
            
        except Exception as e:
            print(f"[XHSCollectionService]   → ✗ 获取笔记详细信息失败: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    async def _get_note_desc_from_detail(self, note_url: str) -> str:
        if not note_url:
            return ""
        
        try:
            print(f"[XHSCollectionService]   → 打开新标签页获取正文...")
            new_page = await self.browser_context.new_page()
            print(f"[XHSCollectionService]   → 正在导航至笔记详情页...")
            print(f"[XHSCollectionService]   → URL: {note_url}")
            await new_page.goto(note_url, wait_until="domcontentloaded", timeout=30000)
            print(f"[XHSCollectionService]   → 页面加载完成，等待内容渲染...")
            await new_page.wait_for_timeout(3000)
            print(f"[XHSCollectionService]   → 开始提取正文内容...")
            
            desc_selectors = [
                "#detail-desc",
                ".note-content",
                "div[id*='detail']",
                "xpath=//div[contains(@class, 'desc')]",
                "xpath=//span[contains(@class, 'desc')]"
            ]
            
            desc = ""
            print(f"[XHSCollectionService]   → 尝试 {len(desc_selectors)} 个选择器...")
            for idx, selector in enumerate(desc_selectors, 1):
                try:
                    print(f"[XHSCollectionService]   → 尝试选择器 {idx}/{len(desc_selectors)}: {selector}")
                    desc_elem = await new_page.query_selector(selector)
                    if desc_elem:
                        desc = await desc_elem.inner_text()
                        if desc and len(desc.strip()) > 10:
                            print(f"[XHSCollectionService]   → ✓ 选择器匹配成功")
                            break
                        else:
                            print(f"[XHSCollectionService]   → ✗ 内容过短，继续尝试...")
                    else:
                        print(f"[XHSCollectionService]   → ✗ 未找到元素")
                except Exception as e:
                    print(f"[XHSCollectionService]   → ✗ 选择器失败: {e}")
                    continue
            
            print(f"[XHSCollectionService]   → 关闭详情页标签...")
            await new_page.close()
            
            if desc:
                print(f"[XHSCollectionService]   → ✓ 成功获取正文内容，长度: {len(desc)} 字符")
            else:
                print(f"[XHSCollectionService]   → ✗ 未能获取正文内容")
            
            return desc.strip() if desc else ""
            
        except Exception as e:
            print(f"[XHSCollectionService]   → ✗ 获取笔记正文失败: {e}")
            import traceback
            traceback.print_exc()
            return ""
    
    async def _get_note_comments_from_detail(self, note_url: str, max_count: int) -> List[Dict]:
        if not note_url:
            return []
        
        comments = []
        try:
            new_page = await self.browser_context.new_page()
            await new_page.goto(note_url, wait_until="networkidle")
            await new_page.wait_for_timeout(3000)
            
            comment_elems = await new_page.query_selector_all(".comment-item")
            
            for elem in comment_elems[:max_count]:
                try:
                    user_elem = await elem.query_selector(".user-name")
                    user_name = await user_elem.inner_text() if user_elem else ""
                    
                    content_elem = await elem.query_selector(".content")
                    content = await content_elem.inner_text() if content_elem else ""
                    
                    likes_elem = await elem.query_selector(".like-count")
                    likes_text = await likes_elem.inner_text() if likes_elem else "0"
                    likes_count = self._parse_count(likes_text)
                    
                    comments.append({
                        "user_name": user_name.strip(),
                        "content": content.strip(),
                        "likes_count": likes_count
                    })
                except Exception:
                    continue
            
            await new_page.close()
        except Exception as e:
            print(f"[XHSCollectionService] 获取评论失败: {e}")
        
        return comments
    
    def _parse_count(self, count_text: str) -> int:
        count_text = count_text.strip().lower()
        if not count_text or count_text == "-":
            return 0
        
        try:
            if "w" in count_text or "万" in count_text:
                num = float(re.sub(r'[^0-9.]', '', count_text))
                return int(num * 10000)
            elif "k" in count_text or "千" in count_text:
                num = float(re.sub(r'[^0-9.]', '', count_text))
                return int(num * 1000)
            else:
                return int(re.sub(r'[^0-9]', '', count_text))
        except Exception:
            return 0
    
    def _save_notes_to_file(self, notes: List[Dict], keywords: str) -> str:
        print(f"[XHSCollectionService] ========== 开始保存数据 ==========")
        data_dir = os.path.join(os.getcwd(), "src", "data")
        os.makedirs(data_dir, exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_keywords = keywords.replace(",", "_")[:30]
        filename = f"xhs_notes_{safe_keywords}_{timestamp}.json"
        filepath = os.path.join(data_dir, filename)
        
        print(f"[XHSCollectionService] 文件名: {filename}")
        print(f"[XHSCollectionService] 保存路径: {filepath}")
        print(f"[XHSCollectionService] 数据条数: {len(notes)} 条")
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(notes, f, ensure_ascii=False, indent=2)
        
        file_size = os.path.getsize(filepath)
        print(f"[XHSCollectionService] ✓ 数据保存成功")
        print(f"[XHSCollectionService] 文件大小: {file_size/1024:.2f} KB")
        print(f"[XHSCollectionService] ========== 保存完成 ==========")
        return filepath
    
    async def cleanup(self):
        try:
            if self.browser_context:
                await self.browser_context.close()
        except Exception as e:
            print(f"[XHSCollectionService] 清理资源失败: {e}")
