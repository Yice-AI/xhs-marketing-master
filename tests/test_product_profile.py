import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.api.routes import product_profile
from backend.database.db_session import get_db
from backend.database.models import Base
from backend.middleware.auth import get_current_user_id


def _build_client():
    temp_dir = tempfile.TemporaryDirectory()
    db_path = Path(temp_dir.name) / "product-profile-test.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    app = FastAPI()
    app.include_router(product_profile.router)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user_id] = lambda: "user-product-profile"
    return TestClient(app), temp_dir


def test_product_profile_save_and_get_current():
    client, temp_dir = _build_client()
    try:
        payload = {
            "product_brief": {
                "product_name": "排版工具",
                "target_audience": "内容创作者",
                "product_features": "一键排版",
                "reference_urls": ["https://example.com"],
            }
        }

        save_response = client.put("/api/product-profile/current", json=payload)
        assert save_response.status_code == 200
        assert save_response.json()["data"]["product_brief"]["product_name"] == "排版工具"

        get_response = client.get("/api/product-profile/current")
        assert get_response.status_code == 200
        assert get_response.json()["data"]["product_brief"]["product_features"] == "一键排版"
    finally:
        temp_dir.cleanup()


def test_product_profile_research_context_reuses_cache():
    client, temp_dir = _build_client()
    try:
        product_brief = {
            "product_name": "排版工具",
            "target_audience": "内容创作者",
            "product_features": "一键排版",
        }
        research_context = {
            "product_name": "排版工具",
            "summary": "面向内容创作者的一键排版工具",
            "source_documents": [],
        }

        with patch(
            "backend.api.routes.product_profile.NoteStrategyService.build_research_context",
            return_value=research_context,
        ) as mocked_build:
            first_response = client.post("/api/product-profile/research-context", json={
                "product_brief": product_brief,
            })
            second_response = client.post("/api/product-profile/research-context", json={
                "product_brief": product_brief,
            })

        assert first_response.status_code == 200
        assert first_response.json()["cached"] is False
        assert second_response.status_code == 200
        assert second_response.json()["cached"] is True
        mocked_build.assert_called_once()
    finally:
        temp_dir.cleanup()
