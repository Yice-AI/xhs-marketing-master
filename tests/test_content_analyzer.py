from backend.services.content_analyzer import (
    ContentAnalyzer,
    get_text_generation_config_candidates,
    get_text_generation_model_candidates,
    resolve_text_generation_config,
)


def test_resolve_text_generation_config_prefers_openrouter(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "openrouter-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "")
    monkeypatch.setattr(
        "backend.services.content_analyzer.settings.TEXT_GEN_BASE_URL",
        "https://openrouter.ai/api/v1",
    )

    api_key, base_url = resolve_text_generation_config()

    assert api_key == "openrouter-key"
    assert base_url == "https://openrouter.ai/api/v1"


def test_resolve_text_generation_config_supports_anthropic(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "anthropic-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr(
        "backend.services.content_analyzer.settings.ANTHROPIC_BASE_URL",
        "https://claude.example/",
    )
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "")

    api_key, base_url = resolve_text_generation_config()

    assert api_key == "anthropic-key"
    assert base_url == "https://claude.example/v1"


def test_resolve_text_generation_config_supports_gemini_without_image_key(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "gemini-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "")

    api_key, base_url = resolve_text_generation_config()

    assert api_key == "gemini-key"
    assert base_url == "https://generativelanguage.googleapis.com/v1beta/openai/"


def test_resolve_text_generation_config_supports_text_fallback_gateway(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "fallback-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "https://fallback.example")

    api_key, base_url = resolve_text_generation_config()

    assert api_key == "fallback-key"
    assert base_url == "https://fallback.example/v1"


def test_resolve_text_generation_config_prefers_primary_before_text_fallback(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "anthropic-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BASE_URL", "https://claude.example")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "fallback-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "https://fallback.example")

    api_key, base_url = resolve_text_generation_config()

    assert api_key == "anthropic-key"
    assert base_url == "https://claude.example/v1"


def test_text_model_candidates_try_same_gateway_fallback_model(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_MODEL", "gpt-5.4")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_MODEL", "gpt-4.1-mini")

    primary_models = get_text_generation_model_candidates({"name": "anthropic_gateway"}, current_model="gpt-5.4")
    fallback_models = get_text_generation_model_candidates({"name": "text_gateway_fallback"}, current_model="gpt-5.4")

    assert primary_models == ["gpt-5.4", "gpt-4.1-mini"]
    assert fallback_models == ["gpt-4.1-mini"]


def test_text_generation_candidates_do_not_mix_generic_gateways_when_primary_exists(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "anthropic-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "anthropic-backup")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEYS", [])
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "test-openrouter-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "your-gemini-api-key-here")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "minimax-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "")

    candidates = get_text_generation_config_candidates()

    assert [candidate["name"] for candidate in candidates] == [
        "anthropic_gateway",
        "anthropic_gateway_backup",
    ]


def test_text_generation_candidates_ignore_placeholder_keys(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEYS", [])
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "your-gemini-api-key-here")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "")

    candidates = get_text_generation_config_candidates()

    assert candidates == []


def test_text_generation_candidates_include_image_key_pool(monkeypatch):
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_API_KEY", "primary-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEY", "image-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_API_KEYS", ["image-key", "pool-key-2"])
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BACKUP_API_KEY", "backup-key")
    monkeypatch.setattr("backend.services.content_analyzer.settings.IMAGE_GEN_BASE_URL", "https://claude.example")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENAI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.OPENROUTER_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.GEMINI_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.MINIMAX_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.services.content_analyzer.settings.TEXT_GEN_FALLBACK_BASE_URL", "")

    candidates = get_text_generation_config_candidates()

    assert [candidate["api_key"] for candidate in candidates] == [
        "primary-key",
        "image-key",
        "pool-key-2",
        "backup-key",
    ]


def test_build_followup_tasks_contains_structured_filters():
    analyzer = ContentAnalyzer.__new__(ContentAnalyzer)

    tasks = analyzer._build_followup_tasks(
        {
            "教程类": {
                "benchmark_sufficiency": "不足",
                "sufficiency_reason": "需要更多教程类样本",
                "strong_recommend_count": 0,
            }
        },
        {
            "product_name": "护眼台灯",
            "product_features": "宿舍 学习 桌面",
        },
    )

    assert len(tasks) == 1
    assert tasks[0]["filters"]["sortBy"] == "综合"
    assert tasks[0]["filters"]["publishTime"] == "半年内"
    assert tasks[0]["keyword_text"]
