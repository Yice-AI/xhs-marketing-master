import asyncio
import json
import hashlib
import time
from typing import Dict, List, Optional
from urllib.parse import quote
from datetime import datetime

import httpx
from playwright.async_api import BrowserContext, Page


class XHSApiClient:
    
    def __init__(self, playwright_page: Page, browser_context: BrowserContext):
        self.playwright_page = playwright_page
        self.browser_context = browser_context
        self.timeout = 60
        self._host = "https://edith.xiaohongshu.com"
        self._domain = "https://www.xiaohongshu.com"
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://www.xiaohongshu.com",
            "Referer": "https://www.xiaohongshu.com/",
        }
        self.cookie_dict = {}
    
    async def update_cookies(self):
        cookies = await self.browser_context.cookies()
        cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
        self.cookie_dict = {c['name']: c['value'] for c in cookies}
        self.headers["Cookie"] = cookie_str
    
    def _get_search_id(self) -> str:
        timestamp = int(time.time() * 1000)
        return f"{timestamp:x}"
    
    def _build_sign_string(self, uri: str, data: Optional[Dict] = None, method: str = "POST") -> str:
        if method.upper() == "POST":
            c = uri
            if data is not None:
                c += json.dumps(data, separators=(",", ":"), ensure_ascii=False)
            return c
        else:
            if not data:
                return uri
            params = []
            for key in data.keys():
                value = data[key]
                if isinstance(value, list):
                    value_str = ",".join(str(v) for v in value)
                elif value is not None:
                    value_str = str(value)
                else:
                    value_str = ""
                value_str = quote(value_str, safe='')
                params.append(f"{key}={value_str}")
            return f"{uri}?{'&'.join(params)}"
    
    def _md5_hex(self, s: str) -> str:
        return hashlib.md5(s.encode("utf-8")).hexdigest()
    
    def _get_trace_id(self) -> str:
        timestamp = int(time.time() * 1000)
        random_part = hashlib.md5(str(timestamp).encode()).hexdigest()[:16]
        return f"{random_part}{timestamp:x}"
    
    async def _sign_request(self, uri: str, data: Optional[Dict] = None, method: str = "POST") -> Dict:
        a1_value = self.cookie_dict.get("a1", "")
        
        sign_string = self._build_sign_string(uri, data, method)
        
        try:
            js_code = f"""
            (async () => {{
                const uri = {json.dumps(uri)};
                const data = {json.dumps(data or {})};
                const a1 = {json.dumps(a1_value)};
                const method = {json.dumps(method)};
                
                if (typeof window._webmsxyw === 'undefined') {{
                    return null;
                }}
                
                const signData = {{
                    signStr: uri + (method === 'POST' ? JSON.stringify(data) : ''),
                    a1: a1
                }};
                
                try {{
                    const result = window._webmsxyw(signData.signStr, signData.a1);
                    return result;
                }} catch (e) {{
                    console.error('Sign error:', e);
                    return null;
                }}
            }})()
            """
            
            result = await self.playwright_page.evaluate(js_code)
            
            if result:
                x_s = result.get("X-s", "")
                x_t = str(int(time.time() * 1000))
                
                return {
                    "X-S": x_s,
                    "X-T": x_t,
                    "X-S-Common": result.get("X-s-common", ""),
                    "X-B3-Traceid": self._get_trace_id(),
                }
            else:
                print("[XHSApiClient] 签名生成失败，使用备用方案")
                return {
                    "X-S": "",
                    "X-T": str(int(time.time() * 1000)),
                    "X-S-Common": "",
                    "X-B3-Traceid": self._get_trace_id(),
                }
                
        except Exception as e:
            print(f"[XHSApiClient] 签名异常: {e}")
            return {
                "X-S": "",
                "X-T": str(int(time.time() * 1000)),
                "X-S-Common": "",
                "X-B3-Traceid": self._get_trace_id(),
            }
    
    async def get(self, uri: str, params: Optional[Dict] = None) -> Dict:
        await self.update_cookies()
        
        sign_headers = await self._sign_request(uri, params, "GET")
        headers = {**self.headers, **sign_headers}
        
        full_url = f"{self._host}{uri}"
        
        async with httpx.AsyncClient() as client:
            response = await client.get(
                full_url,
                params=params,
                headers=headers,
                timeout=self.timeout
            )
            
            if response.status_code != 200:
                print(f"[XHSApiClient] GET 请求失败: {response.status_code}, {response.text}")
                return {}
            
            data = response.json()
            if data.get("success"):
                return data.get("data", {})
            else:
                print(f"[XHSApiClient] API 返回错误: {data}")
                return {}
    
    async def post(self, uri: str, data: Dict) -> Dict:
        await self.update_cookies()
        
        sign_headers = await self._sign_request(uri, data, "POST")
        headers = {**self.headers, **sign_headers}
        
        full_url = f"{self._host}{uri}"
        json_str = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                full_url,
                content=json_str,
                headers=headers,
                timeout=self.timeout
            )
            
            if response.status_code != 200:
                print(f"[XHSApiClient] POST 请求失败: {response.status_code}, {response.text}")
                return {}
            
            data = response.json()
            if data.get("success"):
                return data.get("data", {})
            else:
                print(f"[XHSApiClient] API 返回错误: {data}")
                return {}
    
    async def search_notes(
        self,
        keyword: str,
        page: int = 1,
        page_size: int = 20,
        sort: str = "general",
        note_type: int = 0
    ) -> Dict:
        uri = "/api/sns/web/v1/search/notes"
        search_id = self._get_search_id()
        
        data = {
            "keyword": keyword,
            "page": page,
            "page_size": page_size,
            "search_id": search_id,
            "sort": sort,
            "note_type": note_type,
        }
        
        print(f"[XHSApiClient] 搜索笔记: keyword={keyword}, page={page}")
        return await self.post(uri, data)
    
    async def get_note_detail(
        self,
        note_id: str,
        xsec_source: str = "pc_search",
        xsec_token: str = ""
    ) -> Dict:
        data = {
            "source_note_id": note_id,
            "image_formats": ["jpg", "webp", "avif"],
            "extra": {"need_body_topic": 1},
            "xsec_source": xsec_source,
            "xsec_token": xsec_token,
        }
        
        uri = "/api/sns/web/v1/feed"
        return await self.post(uri, data)
    
    async def check_login(self) -> bool:
        try:
            result = await self.search_notes(keyword="测试", page_size=1)
            return bool(result.get("items"))
        except Exception as e:
            print(f"[XHSApiClient] 检查登录状态失败: {e}")
            return False
