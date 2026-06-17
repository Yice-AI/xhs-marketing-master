import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.api.routes import creative_drafts
from backend.database.models import Base
from backend.database.db_session import get_db
from backend.middleware.auth import get_current_user_id


def create_app(session_factory, user_id: str = "user-test"):
    app = FastAPI()
    app.include_router(creative_drafts.router)

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_id] = lambda: user_id
    return app


def sample_payload(title: str = "测试草稿", session_key: str = "session-1"):
    return {
        "title": title,
        "session_key": session_key,
        "source_context": "product:uplog",
        "snapshot_version": 1,
        "content_payload": {
            "workspace": "CREATION",
            "session_key": session_key,
            "creationState": {
                "productName": "uplog",
                "targetAudience": "内容创作者",
                "productFeatures": "一键排版",
                "contentStyle": "seed",
                "visualStyle": "温暖渐变卡片",
                "strategyMode": "research_first",
                "isGenerating": False,
                "generationStep": 0,
                "generationProgress": 0,
                "generationMessage": "",
                "prompts": [],
                "promptCount": 0,
                "localGeneratedContent": None,
                "generatedTags": [],
                "draftSessionKey": session_key,
            },
            "creationEditorState": {
                "rewriteMode": "结构仿写",
                "imageMode": "概念表达",
                "visualStyle": "温暖渐变卡片",
                "templatePageCount": 5,
                "templateCopyStyle": "通用种草",
                "templateKind": "feature_hero",
                "templateFrameStyle": "soft_gradient_card",
                "salesIntensity": 45,
                "colloquialLevel": 75,
                "authenticityLevel": 80,
                "materialSummary": "",
                "referenceSummary": "",
                "selectedAssetIds": [],
                "primaryReferenceAssetId": "",
                "researchContext": None,
                "strategyOptions": [],
                "selectedStrategyId": "",
            },
            "generatedNote": None,
            "rewriteSession": None,
            "selectedBenchmarkNote": None,
            "referenceAssets": [],
            "latestProductBrief": None,
            "studioContentState": None,
        },
        "preview_payload": {
            "content_mode_label": "概念表达",
            "has_studio_edit": False,
            "body_preview": "测试正文摘要",
            "cover_image_url": "",
        },
    }


def test_creative_drafts_autosave_updates_existing_latest_auto():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "creative-drafts-test.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        client = TestClient(create_app(session_factory))

        first = client.post("/api/creative-drafts/autosave", json=sample_payload(title="第一版"))
        assert first.status_code == 200
        first_id = first.json()["data"]["draft_id"]

        second_payload = sample_payload(title="第二版")
        second_payload["preview_payload"]["body_preview"] = "已更新摘要"
        second = client.post("/api/creative-drafts/autosave", json=second_payload)
        assert second.status_code == 200
        second_body = second.json()["data"]
        assert second_body["draft_id"] == first_id
        assert second_body["title"] == "第二版"


def test_creative_drafts_create_and_list_manual_drafts():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "creative-drafts-list.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        client = TestClient(create_app(session_factory))
        create_response = client.post("/api/creative-drafts", json=sample_payload(title="手动保存草稿", session_key="session-manual"))
        assert create_response.status_code == 200
        assert create_response.json()["data"]["status"] == "manual_saved"

        list_response = client.get("/api/creative-drafts")
        assert list_response.status_code == 200
        drafts = list_response.json()["data"]
        assert len(drafts) == 1
        assert drafts[0]["title"] == "手动保存草稿"


def test_creative_drafts_detail_updates_last_opened_and_can_be_updated():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "creative-drafts-detail.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        client = TestClient(create_app(session_factory))
        create_response = client.post("/api/creative-drafts", json=sample_payload(title="待更新草稿", session_key="session-detail"))
        draft_id = create_response.json()["data"]["draft_id"]

        detail_response = client.get(f"/api/creative-drafts/{draft_id}")
        assert detail_response.status_code == 200
        assert detail_response.json()["data"]["last_opened_at"] is not None

        update_response = client.put(f"/api/creative-drafts/{draft_id}", json={"title": "已更新标题"})
        assert update_response.status_code == 200
        assert update_response.json()["data"]["title"] == "已更新标题"


def test_creative_drafts_are_isolated_per_user():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = Path(temp_dir) / "creative-drafts-user.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        session_factory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        owner_client = TestClient(create_app(session_factory, user_id="owner"))
        stranger_client = TestClient(create_app(session_factory, user_id="stranger"))

        create_response = owner_client.post("/api/creative-drafts", json=sample_payload(title="仅本人可见", session_key="session-owner"))
        draft_id = create_response.json()["data"]["draft_id"]

        detail_response = stranger_client.get(f"/api/creative-drafts/{draft_id}")
        assert detail_response.status_code == 404
