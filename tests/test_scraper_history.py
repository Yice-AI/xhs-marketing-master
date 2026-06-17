import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.api.routes import scraper
from backend.database.models import Base
from backend.database.db_session import get_db
from backend.middleware.auth import get_current_user_id


def test_scraper_history_save_returns_summary_and_list_reads_it_back():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "scraper-history-test.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        app = FastAPI()
        app.include_router(scraper.router)

        def override_get_db():
            db = TestingSessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user_id] = lambda: "user-test"

        client = TestClient(app)

        payload = {
            "keyword": "排版工具",
            "notes_count": 1,
            "notes_data": [
                {
                    "id": "note-1",
                    "title": "标题",
                    "time": 1776675602.018,
                }
            ],
            "filters": {
                "sortBy": "最新",
                "noteType": "图文",
                "publishTime": "一周内",
                "searchScope": "不限",
                "location": "不限",
            },
            "product_brief": {
                "product_name": "排版工具",
                "target_audience": "内容创作者",
                "product_features": "一键排版",
            },
        }

        save_response = client.post("/api/scraper/history", json=payload)
        assert save_response.status_code == 200

        save_body = save_response.json()
        assert save_body["success"] is True
        assert save_body["data"]["task_id"]
        assert save_body["data"]["keyword"] == payload["keyword"]
        assert save_body["data"]["notes_count"] == payload["notes_count"]
        assert save_body["data"]["filters"]["noteType"] == "图文"
        assert save_body["data"]["product_brief"]["product_name"] == "排版工具"
        assert save_body["data"]["created_at"]

        history_response = client.get("/api/scraper/history")
        assert history_response.status_code == 200

        history_body = history_response.json()
        assert history_body["success"] is True
        assert len(history_body["data"]) == 1
        assert history_body["data"][0]["task_id"] == save_body["data"]["task_id"]
        assert history_body["data"][0]["filters"]["publishTime"] == "一周内"


def test_scraper_history_save_supports_collection_mode_and_source_input():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "scraper-history-mode-test.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        app = FastAPI()
        app.include_router(scraper.router)

        def override_get_db():
            db = TestingSessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user_id] = lambda: "user-test"

        client = TestClient(app)
        payload = {
            "keyword": "URL采集",
            "collection_mode": "url",
            "source_input": "https://www.xiaohongshu.com/explore/test-note",
            "notes_count": 1,
            "notes_data": [{"id": "note-1", "title": "标题"}],
        }

        response = client.post("/api/scraper/history", json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["data"]["collection_mode"] == "url"
        assert body["data"]["source_input"] == payload["source_input"]


def test_collect_by_url_returns_structured_note_from_html():
    app = FastAPI()
    app.include_router(scraper.router)
    app.dependency_overrides[get_current_user_id] = lambda: "user-test"

    client = TestClient(app)
    note_id = "69296690000000001b032cc9"
    html = f"""
    <html><body>
    <script>window.__INITIAL_STATE__={{
      "note": {{
        "noteDetailMap": {{
          "{note_id}": {{
            "note": {{
              "noteId": "{note_id}",
              "title": "测试标题",
              "desc": "测试正文",
              "time": 1764327721000,
              "user": {{
                "nickname": "测试作者",
                "avatar": "https://sns-avatar-qc.xhscdn.com/avatar/test"
              }},
              "imageList": [
                {{
                  "urlDefault": "http://sns-webpic-qc.xhscdn.com/test-image-1.jpg"
                }},
                {{
                  "infoList": [
                    {{"url": "http://sns-webpic-qc.xhscdn.com/test-image-2.jpg"}}
                  ]
                }}
              ],
              "interactInfo": {{
                "likedCount": "12",
                "collectedCount": "8",
                "commentCount": "3",
                "shareCount": "1"
              }},
              "tagList": [
                {{"name": "运营干货"}},
                {{"name": "小红书"}}
              ]
            }}
          }}
        }}
      }}
    }}</script>
    </body></html>
    """

    class FakeResponse:
        def __init__(self, text: str):
            self.text = text
            self.status_code = 200
            self.url = "https://www.xiaohongshu.com/explore/test"

        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, *args, **kwargs):
            return FakeResponse(html)

    with patch("backend.api.routes.scraper.httpx.AsyncClient", FakeAsyncClient):
        response = client.post("/api/scraper/collect-by-url", json={
            "url": f"https://www.xiaohongshu.com/explore/{note_id}?xsec_token=test-token&xsec_source=pc_search",
            "enable_comments": False,
        })

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["collection_mode"] == "url"
    assert body["data"]["note"]["title"] == "测试标题"
    assert body["data"]["note"]["desc"] == "测试正文"
    assert body["data"]["note"]["author"] == "测试作者"
    assert len(body["data"]["note"]["imageList"]) == 2


def test_collect_by_url_rejects_non_explore_urls():
    app = FastAPI()
    app.include_router(scraper.router)
    app.dependency_overrides[get_current_user_id] = lambda: "user-test"
    client = TestClient(app)

    response = client.post("/api/scraper/collect-by-url", json={
        "url": "https://www.xiaohongshu.com/user/profile/123",
        "enable_comments": False,
    })

    assert response.status_code == 400
    body = response.json()
    assert body["detail"]["code"] == "unsupported_url"
