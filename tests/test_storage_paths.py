from pathlib import Path

from backend.config import settings
from backend.config.paths import get_static_images_dir, get_uploads_dir, resolve_runtime_path


def test_resolve_runtime_path_keeps_absolute_path():
    project_root = Path("/tmp/project-root")
    configured_path = Path("/var/lib/xhs/shared/images")

    resolved = resolve_runtime_path(configured_path, project_root=project_root)

    assert resolved == configured_path


def test_resolve_runtime_path_resolves_relative_path_against_project_root():
    project_root = Path("/tmp/project-root")

    resolved = resolve_runtime_path("src/data/images", project_root=project_root)

    assert resolved == project_root / "src/data/images"


def test_storage_dir_helpers_follow_runtime_settings():
    original_static_images_dir = settings.static_images_dir
    original_upload_dir = settings.upload_dir

    try:
        settings.static_images_dir = "/srv/xhs/shared/images"
        settings.upload_dir = "/srv/xhs/shared/uploads"

        assert get_static_images_dir() == Path("/srv/xhs/shared/images")
        assert get_uploads_dir() == Path("/srv/xhs/shared/uploads")
    finally:
        settings.static_images_dir = original_static_images_dir
        settings.upload_dir = original_upload_dir
