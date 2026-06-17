import json
import os
from pathlib import Path
from typing import Any, Dict, List

try:
    from dotenv import dotenv_values
    env_file = Path(__file__).parent.parent.parent / ".env"
    env_file_local = Path(__file__).parent.parent.parent / ".env.local"
    env_file_production = Path(__file__).parent.parent.parent / ".env.production"
    merged_env: dict[str, str] = {}
    for candidate in (env_file, env_file_production, env_file_local):
        if not candidate.exists():
            continue
        merged_env.update(
            {
                key: value
                for key, value in dotenv_values(candidate).items()
                if value is not None
            }
        )
    for key, value in merged_env.items():
        os.environ.setdefault(key, value)
except ImportError:
    pass


def _split_csv(value: str, default: List[str]) -> List[str]:
    entries = [item.strip() for item in value.split(",") if item.strip()]
    return entries or default


def _split_config_list(value: str, default: List[str]) -> List[str]:
    normalized = value.strip()
    if not normalized:
        return default

    if normalized.startswith("["):
        try:
            parsed = json.loads(normalized)
            if isinstance(parsed, list):
                entries = [str(item).strip() for item in parsed if str(item).strip()]
                return entries or default
        except Exception:
            pass

    return _split_csv(normalized, default)


def _parse_int_mapping(value: str, default: Dict[str, int]) -> Dict[str, int]:
    normalized = str(value or "").strip()
    if not normalized:
        return dict(default)

    parsed_items: Dict[str, Any] = {}
    if normalized.startswith("{"):
        try:
            parsed = json.loads(normalized)
            if isinstance(parsed, dict):
                parsed_items = parsed
        except Exception:
            parsed_items = {}
    else:
        for item in normalized.split(","):
            if not item.strip() or "=" not in item:
                continue
            key, raw_value = item.split("=", 1)
            parsed_items[key.strip()] = raw_value.strip()

    merged = dict(default)
    for key, raw_value in parsed_items.items():
        normalized_key = str(key or "").strip().lower()
        if not normalized_key:
            continue
        try:
            merged[normalized_key] = max(1, int(raw_value))
        except (TypeError, ValueError):
            continue
    return merged


class Settings:
    environment: str = os.getenv("ENVIRONMENT", os.getenv("ENV", "development")).lower()
    api_host: str = os.getenv("API_HOST", "0.0.0.0")
    api_port: int = int(os.getenv("API_PORT", "8000"))
    log_level: str = os.getenv("LOG_LEVEL", "INFO")
    app_base_url: str = os.getenv("APP_BASE_URL", "http://localhost:3000").rstrip("/")
    web_dist_dir: str = os.getenv("WEB_DIST_DIR", "dist")
    downloads_dir: str = os.getenv("DOWNLOADS_DIR", "public/downloads")
    release_manifest_path: str = os.getenv("RELEASE_MANIFEST_PATH", "public/downloads/release-manifest.json")
    static_images_dir: str = os.getenv("STATIC_IMAGES_DIR", "src/data/images")
    upload_dir: str = os.getenv("UPLOAD_DIR", "uploads")
    max_upload_size: int = int(os.getenv("MAX_UPLOAD_SIZE", str(10 * 1024 * 1024)))
    cors_origins: List[str] = _split_csv(
        os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000",
        ),
        [
            "http://localhost:5173",
            "http://localhost:3000",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:3000",
        ],
    )
    extension_allowed_origins: List[str] = _split_csv(
        os.getenv(
            "EXTENSION_ALLOWED_ORIGINS",
            "http://localhost:3000, http://127.0.0.1:3000, http://localhost:5173, http://127.0.0.1:5173",
        ),
        [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
    )
    OPENROUTER_API_KEY: str = os.getenv("OPENROUTER_API_KEY", "")
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    ANTHROPIC_BASE_URL: str = os.getenv("ANTHROPIC_BASE_URL", "https://api.example.com/v1")
    ANTHROPIC_BACKUP_API_KEY: str = os.getenv("ANTHROPIC_BACKUP_API_KEY", "")
    TUZI_API_KEY: str = os.getenv("TUZI_API_KEY", "")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")
    MINIMAX_API_KEY: str = os.getenv("MINIMAX_API_KEY", "")
    IMAGE_GEN_API_KEY: str = os.getenv("IMAGE_GEN_API_KEY", "")
    IMAGE_GEN_API_KEYS: List[str] = _split_config_list(os.getenv("IMAGE_GEN_API_KEYS", ""), [])
    IMAGE_GEN_BASE_URL: str = os.getenv("IMAGE_GEN_BASE_URL", "https://api.example.com/v1")
    IMAGE_GEN_BACKUP_API_KEY: str = os.getenv("IMAGE_GEN_BACKUP_API_KEY", "")
    IMAGE_GEN_BACKUP_BASE_URL: str = os.getenv("IMAGE_GEN_BACKUP_BASE_URL", "")
    # Legacy default image-generation model used by concept/default flows.
    # Prefer CONCEPT_IMAGE_MODEL for clarity; keep IMAGE_GEN_MODEL as a backwards-compatible alias.
    CONCEPT_IMAGE_MODEL: str = os.getenv("CONCEPT_IMAGE_MODEL", os.getenv("IMAGE_GEN_MODEL", "gemini-3-pro-image"))
    IMAGE_GEN_MODEL: str = CONCEPT_IMAGE_MODEL
    IMAGE2_GEN_MODEL: str = os.getenv("IMAGE2_GEN_MODEL", "gpt-image-2")
    IMAGE_EDIT_API_KEY: str = os.getenv("IMAGE_EDIT_API_KEY", "")
    IMAGE_EDIT_BASE_URL: str = os.getenv("IMAGE_EDIT_BASE_URL", "")
    IMAGE_EDIT_MODEL: str = os.getenv("IMAGE_EDIT_MODEL", "gpt-image-2")
    IMAGE_EDIT_FALLBACK_MODEL: str = os.getenv("IMAGE_EDIT_FALLBACK_MODEL", "")
    IMAGE_GEN_FALLBACK_BASE_URL: str = os.getenv("IMAGE_GEN_FALLBACK_BASE_URL", "")
    IMAGE_GEN_FALLBACK_MODEL: str = os.getenv("IMAGE_GEN_FALLBACK_MODEL", "")
    IMAGE_GEN_FALLBACK_API_KEY: str = os.getenv("IMAGE_GEN_FALLBACK_API_KEY", "")
    TEXT_GEN_BASE_URL: str = os.getenv("TEXT_GEN_BASE_URL", "https://api.example.com/v1")
    TEXT_GEN_MODEL: str = os.getenv("TEXT_GEN_MODEL", "gpt-5.4")
    TEXT_GEN_FALLBACK_BASE_URL: str = os.getenv("TEXT_GEN_FALLBACK_BASE_URL", "")
    TEXT_GEN_FALLBACK_MODEL: str = os.getenv("TEXT_GEN_FALLBACK_MODEL", "claude-sonnet-4-6")
    TEXT_GEN_FALLBACK_API_KEY: str = os.getenv("TEXT_GEN_FALLBACK_API_KEY", "")
    TEXT_GENERATION_REQUEST_TIMEOUT_SECONDS: int = int(os.getenv("TEXT_GENERATION_REQUEST_TIMEOUT_SECONDS", "90"))
    TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED: bool = os.getenv(
        "TEXT_GENERATION_CANDIDATE_JUDGE_ENABLED",
        "false",
    ).lower() in {"1", "true", "yes", "on"}
    TEXT_JOB_MAX_WORKERS: int = int(os.getenv("TEXT_JOB_MAX_WORKERS", "8"))
    TEXT_JOB_MAX_CONCURRENCY: int = int(os.getenv("TEXT_JOB_MAX_CONCURRENCY", "6"))
    IMAGE_JOB_MAX_CONCURRENCY: int = int(os.getenv("IMAGE_JOB_MAX_CONCURRENCY", "2"))
    IMAGE_JOB_MAX_CONCURRENCY_PER_USER: int = int(os.getenv("IMAGE_JOB_MAX_CONCURRENCY_PER_USER", "1"))
    IMAGE2_DYNAMIC_JOB_MAX_CONCURRENCY_PER_USER: int = int(os.getenv("IMAGE2_DYNAMIC_JOB_MAX_CONCURRENCY_PER_USER", "4"))
    STYLE_EXPRESSION_JOB_MAX_CONCURRENCY_PER_USER: int = int(os.getenv("STYLE_EXPRESSION_JOB_MAX_CONCURRENCY_PER_USER", "4"))
    MATERIAL_FUSION_JOB_MAX_CONCURRENCY_PER_USER: int = int(os.getenv("MATERIAL_FUSION_JOB_MAX_CONCURRENCY_PER_USER", "2"))
    IMAGE_EDIT_JOB_MAX_CONCURRENCY_PER_USER: int = int(os.getenv("IMAGE_EDIT_JOB_MAX_CONCURRENCY_PER_USER", "2"))
    LOGO_REPLACEMENT_JOB_MAX_CONCURRENCY_PER_USER: int = int(os.getenv("LOGO_REPLACEMENT_JOB_MAX_CONCURRENCY_PER_USER", "2"))
    IMAGE_JOB_POLICY_LIMITS: Dict[str, int] = _parse_int_mapping(
        os.getenv("IMAGE_JOB_POLICY_LIMITS", ""),
        {
            "image2_dynamic": IMAGE2_DYNAMIC_JOB_MAX_CONCURRENCY_PER_USER,
            "style_expression": STYLE_EXPRESSION_JOB_MAX_CONCURRENCY_PER_USER,
            "material_fusion": MATERIAL_FUSION_JOB_MAX_CONCURRENCY_PER_USER,
            "image_edit": IMAGE_EDIT_JOB_MAX_CONCURRENCY_PER_USER,
            "logo_replacement": LOGO_REPLACEMENT_JOB_MAX_CONCURRENCY_PER_USER,
            "concept": IMAGE_JOB_MAX_CONCURRENCY_PER_USER,
        },
    )
    IMAGE_GEN_MAX_CONCURRENCY_PER_KEY: int = int(os.getenv("IMAGE_GEN_MAX_CONCURRENCY_PER_KEY", "2"))
    INTERVIEW_MODEL: str = os.getenv("INTERVIEW_MODEL", "gpt-5.4")
    INTERVIEW_REQUEST_TIMEOUT_SECONDS: int = int(os.getenv("INTERVIEW_REQUEST_TIMEOUT_SECONDS", "60"))
    PROMPT_GEN_MODEL: str = os.getenv("PROMPT_GEN_MODEL", "gpt-5.4")
    IMAGE2_DYNAMIC_INDEPENDENT_TITLES_ENABLED: bool = os.getenv(
        "IMAGE2_DYNAMIC_INDEPENDENT_TITLES_ENABLED",
        "true",
    ).lower() in {"1", "true", "yes", "on"}
    MODEL_GATEWAY_MODE: str = os.getenv("MODEL_GATEWAY_MODE", "direct_with_fallback")
    CHECK_MODEL_GATEWAY_ON_STARTUP: bool = os.getenv("CHECK_MODEL_GATEWAY_ON_STARTUP", "false").lower() in {"1", "true", "yes", "on"}
    MODEL_GATEWAY_HEALTHCHECK_TIMEOUT_SECONDS: int = int(os.getenv("MODEL_GATEWAY_HEALTHCHECK_TIMEOUT_SECONDS", "10"))
    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "dev-secret-key-change-in-production")
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_DAYS: int = int(os.getenv("JWT_EXPIRE_DAYS", "7"))
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
    AUTH_REQUIRED: bool = os.getenv("AUTH_REQUIRED", "true").lower() in {"1", "true", "yes", "on"}
    ALLOW_DEV_AUTH_BYPASS: bool = os.getenv("ALLOW_DEV_AUTH_BYPASS", "true").lower() in {"1", "true", "yes", "on"}
    DEFAULT_DEV_USER_ID: str = os.getenv("DEFAULT_DEV_USER_ID", "dev-local-user")
    EXTERNAL_API_ENABLED: bool = os.getenv("EXTERNAL_API_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
    EXTERNAL_API_KEYS: List[str] = _split_config_list(os.getenv("EXTERNAL_API_KEYS", ""), [])
    EXTERNAL_API_RATE_LIMIT_PER_MINUTE: int = int(os.getenv("EXTERNAL_API_RATE_LIMIT_PER_MINUTE", "60"))
    EXTERNAL_NOTE_JOB_MAX_CONCURRENCY: int = int(os.getenv("EXTERNAL_NOTE_JOB_MAX_CONCURRENCY", "2"))
    EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT: int = int(os.getenv("EXTERNAL_NOTE_JOB_MAX_CONCURRENCY_PER_CLIENT", "2"))
    EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE: int = int(os.getenv("EXTERNAL_NOTE_JOB_QUEUE_MAX_SIZE", "20"))
    EXTERNAL_ARTIFACTS_DIR: str = os.getenv("EXTERNAL_ARTIFACTS_DIR", "shared/external-artifacts")
    EXTERNAL_ARTIFACT_TTL_HOURS: int = int(os.getenv("EXTERNAL_ARTIFACT_TTL_HOURS", "24"))
    EXTERNAL_IMAGE_LOGO_QC_ENABLED: bool = os.getenv("EXTERNAL_IMAGE_LOGO_QC_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
    EXTERNAL_IMAGE_LOGO_AUTO_FIX_ENABLED: bool = os.getenv("EXTERNAL_IMAGE_LOGO_AUTO_FIX_ENABLED", "true").lower() in {"1", "true", "yes", "on"}
    EXTERNAL_IMAGE_LOGO_QC_TIMEOUT_SECONDS: int = int(os.getenv("EXTERNAL_IMAGE_LOGO_QC_TIMEOUT_SECONDS", "120"))
    EXTERNAL_IMAGE_LOGO_FIX_TIMEOUT_SECONDS: int = int(os.getenv("EXTERNAL_IMAGE_LOGO_FIX_TIMEOUT_SECONDS", "180"))
    EXTERNAL_IMAGE_LOGO_POSTPROCESS_BUDGET_SECONDS: int = int(os.getenv("EXTERNAL_IMAGE_LOGO_POSTPROCESS_BUDGET_SECONDS", "300"))
    EXTERNAL_IMAGE_JOB_TARGET_TIMEOUT_SECONDS: int = int(os.getenv("EXTERNAL_IMAGE_JOB_TARGET_TIMEOUT_SECONDS", "900"))
    RUNTIME_SCHEMA_FALLBACK: bool = os.getenv(
        "RUNTIME_SCHEMA_FALLBACK",
        "false" if os.getenv("ENVIRONMENT", os.getenv("ENV", "development")).lower() == "production" else "true",
    ).lower() in {"1", "true", "yes", "on"}
    IMAGE_PROXY_ALLOWED_HOSTS: List[str] = _split_csv(
        os.getenv("IMAGE_PROXY_ALLOWED_HOSTS", "xhscdn.com,xiaohongshu.com"),
        ["xhscdn.com", "xiaohongshu.com"],
    )
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "mysql+pymysql://root:password@127.0.0.1:3306/xhs_marketing",
    )
    SQL_ECHO: bool = os.getenv("SQL_ECHO", "false").lower() in {"1", "true", "yes", "on"}

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def allow_runtime_schema_fallback(self) -> bool:
        return (not self.is_production) and self.RUNTIME_SCHEMA_FALLBACK


settings = Settings()
