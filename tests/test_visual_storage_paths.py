import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.api.routes import visual
from backend.database.db_session import get_db
from backend.database.models import Base
from backend.middleware.user_context import get_current_user_id


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc`\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_visual_helpers_and_asset_routes_use_runtime_storage_dirs():
    original_static_images_dir = visual.settings.static_images_dir
    original_upload_dir = visual.settings.upload_dir

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_root = Path(temp_dir)
        image_dir = temp_root / "shared" / "images"
        upload_dir = temp_root / "shared" / "uploads"
        image_dir.mkdir(parents=True, exist_ok=True)
        upload_dir.mkdir(parents=True, exist_ok=True)

        db_path = temp_root / "visual-storage.db"
        engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
        TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        Base.metadata.create_all(bind=engine)

        app = FastAPI()
        app.include_router(visual.router)

        def override_get_db():
            db = TestingSessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user_id] = lambda: "user-test"

        client = TestClient(app)

        try:
            visual.settings.static_images_dir = str(image_dir)
            visual.settings.upload_dir = str(upload_dir)

            generated_image = image_dir / "existing-image.png"
            generated_image.write_bytes(PNG_1X1)
            assert visual._resolve_generated_image_path("existing-image") == generated_image

            upload_response = client.post(
                "/api/visual/assets",
                files={"file": ("sample.png", PNG_1X1, "image/png")},
            )
            assert upload_response.status_code == 200

            upload_body = upload_response.json()
            assert upload_body["success"] is True
            relative_path = upload_body["data"]["url"].removeprefix("/static/uploads/")
            uploaded_file = upload_dir / relative_path
            assert uploaded_file.exists()
            assert upload_body["data"]["url"] == f"/static/uploads/{relative_path}"

            asset_id = upload_body["data"]["id"]
            delete_response = client.delete(f"/api/visual/assets/{asset_id}")
            assert delete_response.status_code == 200
            assert not uploaded_file.exists()
        finally:
            visual.settings.static_images_dir = original_static_images_dir
            visual.settings.upload_dir = original_upload_dir
