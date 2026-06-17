from pathlib import Path
import os
from typing import Union

from .settings import settings


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def resolve_runtime_path(configured_path: Union[str, Path], project_root: Path = PROJECT_ROOT) -> Path:
    path = configured_path if isinstance(configured_path, Path) else Path(configured_path)
    return path if path.is_absolute() else project_root / path


def get_static_images_dir() -> Path:
    return resolve_runtime_path(settings.static_images_dir)


def get_uploads_dir() -> Path:
    return resolve_runtime_path(settings.upload_dir)


def get_downloads_dir() -> Path:
    return resolve_runtime_path(settings.downloads_dir)


def get_release_manifest_path() -> Path:
    return resolve_runtime_path(settings.release_manifest_path)


def get_external_artifacts_dir() -> Path:
    return resolve_runtime_path(settings.EXTERNAL_ARTIFACTS_DIR)


class PathConfig:
    
    PROJECT_ROOT = PROJECT_ROOT
    
    BROWSER_DATA_DIR = PROJECT_ROOT / "browser_data"
    SINGLE_USER_DATA_DIR = BROWSER_DATA_DIR / "single_user_data_dir"
    POOL_DATA_DIR = BROWSER_DATA_DIR / "pool_data"
    
    DATA_DIR = PROJECT_ROOT / "data"
    JSON_DIR = DATA_DIR / "json"
    IMAGES_DIR = DATA_DIR / "images"
    LOGS_DIR = DATA_DIR / "logs"
    
    BIN_DIR = PROJECT_ROOT / "bin"
    MCP_SERVICE_DIR = PROJECT_ROOT / "mcp-service"
    
    @classmethod
    def ensure_dirs(cls):
        cls.BROWSER_DATA_DIR.mkdir(parents=True, exist_ok=True)
        cls.SINGLE_USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
        cls.POOL_DATA_DIR.mkdir(parents=True, exist_ok=True)
        cls.DATA_DIR.mkdir(parents=True, exist_ok=True)
        cls.JSON_DIR.mkdir(parents=True, exist_ok=True)
        cls.IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        cls.LOGS_DIR.mkdir(parents=True, exist_ok=True)
        cls.BIN_DIR.mkdir(parents=True, exist_ok=True)
    
    @classmethod
    def get_user_data_dir(cls, user_id: str = "default", mode: str = "single_user") -> Path:
        if mode == "single_user":
            return cls.SINGLE_USER_DATA_DIR
        else:
            user_dir = cls.POOL_DATA_DIR / f"{user_id}_user_data_dir"
            user_dir.mkdir(parents=True, exist_ok=True)
            return user_dir


paths = PathConfig()
paths.ensure_dirs()
