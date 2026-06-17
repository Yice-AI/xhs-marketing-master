import base64
import os
import sys
from io import BytesIO

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from PIL import Image

from backend.services.image_generator import ImageGenerator
from backend.services.image_generator import build_image_candidate_chain
from backend.services.model_gateway_diagnostics import (
    _uses_chat_completions_image_probe,
    classify_model_gateway_error,
)
from backend.api.routes import visual


def test_classify_model_gateway_error_prefers_invalid_model_over_request_id_digits():
    error = (
        "Error code: 503 - {'error': {'code': 'model_not_found', "
        "'message': '分组 default 下模型 gemini-3-pro-image-preview 无可用渠道 "
        "（distributor） (request id: 202604291401296511847369ztoCGF4)', "
        "'type': 'new_api_error'}}"
    )

    classified = classify_model_gateway_error(error)

    assert classified["kind"] == "invalid_model"
    assert classified["status_code"] == 502


def test_image_generator_recognizes_current_gemini_image_models():
    generator = ImageGenerator(api_key="test-key", base_url="https://api.example.com/v1", model="gemini-3-pro-image")

    assert generator._supports_chat_completions_image_generation("gemini-3-pro-image") is True
    assert generator._supports_chat_completions_image_generation("gemini-3.1-flash-image") is True


def test_probe_uses_chat_completions_for_current_gemini_image_aliases():
    assert _uses_chat_completions_image_probe("gemini-3-pro-image") is True
    assert _uses_chat_completions_image_probe("gemini-3.1-flash-image") is True
    assert _uses_chat_completions_image_probe("gpt-image-1") is False


def _tiny_png_base64() -> str:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), (255, 0, 0)).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def test_extract_image_url_from_content_supports_markdown_data_urls():
    generator = ImageGenerator(api_key="test-key", base_url="https://api.example.com/v1", model="gemini-3-pro-image")
    tiny_png = _tiny_png_base64()
    content = f"![image](data:image/png;base64,{tiny_png})"

    image_url = generator._extract_image_url_from_content(content)

    assert image_url == f"data:image/png;base64,{tiny_png}"


def test_generate_chat_image_accepts_data_url_in_message_content(monkeypatch, tmp_path):
    generator = ImageGenerator(api_key="test-key", base_url="https://api.example.com/v1", model="gemini-3-pro-image")
    tiny_png = _tiny_png_base64()

    class FakeResponse:
        status_code = 200
        text = "ok"
        headers = {"content-type": "application/json"}

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": f"![image](data:image/png;base64,{tiny_png})",
                        }
                    }
                ]
            }

    monkeypatch.setattr("backend.services.image_generator.requests.post", lambda *args, **kwargs: FakeResponse())
    monkeypatch.setattr("backend.services.image_generator.time.sleep", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "backend.services.image_generator.ImageGenerator._get_datetime_filename",
        lambda self: "20260429_152100",
    )

    output_files = generator.generate_via_openai_compatible_chat_image(
        prompt="test prompt",
        output_dir=str(tmp_path),
    )

    assert len(output_files) == 1
    assert os.path.exists(output_files[0])


def test_generate_chat_image_uses_unique_filename_suffix(monkeypatch, tmp_path):
    generator = ImageGenerator(api_key="test-key", base_url="https://api.example.com/v1", model="gemini-3-pro-image")
    tiny_png = _tiny_png_base64()
    suffixes = iter(["aaa11111", "bbb22222"])

    class FakeResponse:
        status_code = 200
        text = "ok"
        headers = {"content-type": "application/json"}

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": f"![image](data:image/png;base64,{tiny_png})",
                        }
                    }
                ]
            }

    monkeypatch.setattr("backend.services.image_generator.requests.post", lambda *args, **kwargs: FakeResponse())
    monkeypatch.setattr("backend.services.image_generator.time.sleep", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "backend.services.image_generator.ImageGenerator._get_datetime_filename",
        lambda self: "20260429_153300",
    )
    monkeypatch.setattr(
        "backend.services.image_generator.ImageGenerator._unique_suffix",
        lambda self: next(suffixes),
    )

    first = generator.generate_via_openai_compatible_chat_image(
        prompt="test prompt",
        output_dir=str(tmp_path),
    )
    second = generator.generate_via_openai_compatible_chat_image(
        prompt="test prompt",
        output_dir=str(tmp_path),
    )

    assert first[0] != second[0]
    assert first[0].endswith("_aaa11111.png")
    assert second[0].endswith("_bbb22222.png")


def test_generate_native_image_requests_identity_encoding(monkeypatch, tmp_path):
    generator = ImageGenerator(api_key="test-key", base_url="https://api.example.com/v1", model="gpt-image-2")
    tiny_png = _tiny_png_base64()
    captured_headers = {}
    captured_payload = {}

    class FakeResponse:
        status_code = 200
        text = "ok"

        def json(self):
            return {"data": [{"b64_json": tiny_png}]}

    def fake_post(*args, **kwargs):
        captured_headers.update(kwargs["headers"])
        captured_payload.update(kwargs["json"])
        return FakeResponse()

    monkeypatch.setattr("backend.services.image_generator.requests.post", fake_post)
    monkeypatch.setattr(
        "backend.services.image_generator.ImageGenerator._get_datetime_filename",
        lambda self: "20260528_185000",
    )
    monkeypatch.setattr(
        "backend.services.image_generator.ImageGenerator._unique_suffix",
        lambda self: "native001",
    )

    output_files = generator.generate(
        prompt="test prompt",
        output_dir=str(tmp_path),
        aspect_ratio="3:4",
    )

    assert captured_headers["Accept-Encoding"] == "identity"
    assert "response_format" not in captured_payload
    assert len(output_files) == 1
    assert os.path.exists(output_files[0])


def test_edit_image_tuzi_accepts_data_uri_url(monkeypatch, tmp_path):
    generator = ImageGenerator(api_key="test-key", base_url="https://api.tu-zi.com/v1", model="gpt-image-2", provider="tuzi")
    tiny_png = _tiny_png_base64()
    source_path = tmp_path / "source.png"
    source_path.write_bytes(base64.b64decode(tiny_png))
    captured_kwargs = {}

    class FakeImages:
        def edit(self, **kwargs):
            captured_kwargs.update(kwargs)

            class ImageData:
                url = f"data:image/png;base64,{tiny_png}"
                b64_json = None

            class Result:
                data = [ImageData()]

            return Result()

    class FakeOpenAI:
        def __init__(self, **kwargs):
            self.images = FakeImages()

    def fail_get(*args, **kwargs):
        raise AssertionError("data URI should not be downloaded with requests.get")

    monkeypatch.setattr("openai.OpenAI", FakeOpenAI)
    monkeypatch.setattr("backend.services.image_generator.requests.get", fail_get)
    monkeypatch.setattr(
        "backend.services.image_generator.ImageGenerator._get_datetime_filename",
        lambda self: "20260508_015905",
    )

    output_files = generator._edit_image_tuzi(
        image_path=str(source_path),
        edit_prompt="make it cleaner",
        output_path=tmp_path,
        aspect_ratio="1:1",
        image_size="1K",
    )

    assert len(output_files) == 1
    assert os.path.exists(output_files[0])
    assert captured_kwargs["model"] == "gpt-image-2"
    assert "response_format" not in captured_kwargs


def test_build_image_candidate_chain_skips_gemini_on_backup_key_without_permission():
    candidates = build_image_candidate_chain(
        primary_model="gemini-3-pro-image",
        primary_base_url="https://api.example.com/v1",
        primary_api_key="primary-key",
        backup_same_model_api_key="backup-key",
        backup_same_model_base_url="https://api.example.com/v1",
    )

    assert len(candidates) == 1
    assert candidates[0]["model"] == "gemini-3-pro-image"
    assert candidates[0]["api_key"] == "primary-key"


def test_build_image_candidate_chain_uses_backup_key_for_explicit_non_gemini_fallback():
    candidates = build_image_candidate_chain(
        primary_model="gemini-3-pro-image",
        primary_base_url="https://api.example.com/v1",
        primary_api_key="primary-key",
        backup_same_model_api_key="backup-key",
        backup_same_model_base_url="https://api.example.com/v1",
        fallback_models=["gpt-image-2"],
        fallback_api_key="backup-key",
        fallback_base_url="https://api.openai.com/v1",
    )

    assert len(candidates) == 2
    assert candidates[1]["model"] == "gpt-image-2"
    assert candidates[1]["api_key"] == "backup-key"
    assert candidates[1]["base_url"] == "https://api.openai.com/v1"


def test_build_image_candidate_chain_expands_primary_key_pool(monkeypatch):
    monkeypatch.setattr("backend.services.image_generator.settings.IMAGE_GEN_API_KEYS", ["pool-key-1", "pool-key-2"])

    candidates = build_image_candidate_chain(
        primary_model="gpt-image-2",
        primary_base_url="https://api.example.com/v1",
        primary_api_key="primary-key",
    )

    assert [candidate["api_key"] for candidate in candidates] == ["primary-key", "pool-key-1", "pool-key-2"]
    assert [candidate["key_slot"] for candidate in candidates] == ["primary", "pool:1", "pool:2"]


def test_build_image_candidate_chain_dedupes_backup_key_already_in_pool(monkeypatch):
    monkeypatch.setattr("backend.services.image_generator.settings.IMAGE_GEN_API_KEYS", ["primary-key", "backup-key"])

    candidates = build_image_candidate_chain(
        primary_model="gpt-image-2",
        primary_base_url="https://api.example.com/v1",
        primary_api_key="primary-key",
        backup_same_model_api_key="backup-key",
        backup_same_model_base_url="https://api.example.com/v1",
    )

    assert [candidate["api_key"] for candidate in candidates] == ["primary-key", "backup-key"]
    assert [candidate["key_slot"] for candidate in candidates] == ["primary", "pool:2"]


def test_build_image_candidate_chain_adds_backup_key_to_non_gemini_pool(monkeypatch):
    monkeypatch.setattr("backend.services.image_generator.settings.IMAGE_GEN_API_KEYS", ["pool-key-1"])

    candidates = build_image_candidate_chain(
        primary_model="gpt-image-2",
        primary_base_url="https://api.example.com/v1",
        primary_api_key="primary-key",
        backup_same_model_api_key="backup-key",
        backup_same_model_base_url="https://api.example.com/v1",
    )

    assert [candidate["api_key"] for candidate in candidates] == ["primary-key", "pool-key-1", "backup-key"]
    assert [candidate["key_slot"] for candidate in candidates] == ["primary", "pool:1", "backup"]


def test_build_image_candidate_chain_keeps_gemini_backup_out_of_primary_pool(monkeypatch):
    monkeypatch.setattr("backend.services.image_generator.settings.IMAGE_GEN_API_KEYS", ["pool-key-1"])

    candidates = build_image_candidate_chain(
        primary_model="gemini-3-pro-image",
        primary_base_url="https://api.example.com/v1",
        primary_api_key="primary-key",
        backup_same_model_api_key="backup-key",
        backup_same_model_base_url="https://api.example.com/v1",
    )

    assert [candidate["api_key"] for candidate in candidates] == ["primary-key", "pool-key-1"]


def test_model_candidate_cooldown_moves_bad_image_key_behind_healthy_keys(monkeypatch):
    monkeypatch.setattr(visual, "_MODEL_CANDIDATE_COOLDOWNS", {})
    candidates = [
        {
            "provider": "custom",
            "base_url": "https://api.example.com/v1",
            "model": "gpt-image-2",
            "api_key": "primary-key",
            "label": "primary",
        },
        {
            "provider": "custom",
            "base_url": "https://api.example.com/v1",
            "model": "gpt-image-2",
            "api_key": "pool-key",
            "label": "pool",
        },
    ]

    visual._mark_model_candidate_unhealthy(candidates[0], kind="image", reason="permission_denied")
    ordered = visual._prefer_healthy_model_candidates(candidates, kind="image")

    assert [candidate["api_key"] for candidate in ordered] == ["pool-key", "primary-key"]


def test_style_expression_resolves_to_independent_mode():
    assert visual.resolve_visual_mode("动态表达") == "image2_dynamic"
    assert visual.resolve_visual_mode("image2_dynamic") == "image2_dynamic"
    assert visual.resolve_visual_mode("风格表达") == "style_expression"
    assert visual.resolve_visual_mode("多风格表达") == "style_expression"
    assert visual.resolve_visual_mode("style_expression") == "style_expression"


def test_dynamic_design_plan_image_count_clamps_to_six():
    design_plan = visual._extract_dynamic_design_plan({"design_plan": {"image_count": 8}})

    assert design_plan["image_count"] == 6


def test_image2_dynamic_candidates_stay_on_gpt_image(monkeypatch):
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_API_KEY", "primary-key")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_API_KEYS", ["pool-key"])
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_BACKUP_API_KEY", "backup-key")
    monkeypatch.setattr("backend.api.routes.visual.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_BASE_URL", "https://api.example.com/v1")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_BACKUP_BASE_URL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_FALLBACK_BASE_URL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_FALLBACK_MODEL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_EDIT_API_KEY", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_EDIT_BASE_URL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_EDIT_FALLBACK_MODEL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE2_GEN_MODEL", "gpt-image-2")

    candidates = visual._resolve_image_generation_candidates(mode="image2_dynamic")

    assert candidates
    assert {candidate["model"] for candidate in candidates} == {"gpt-image-2"}
    assert [candidate["api_key"] for candidate in candidates] == ["primary-key", "pool-key", "backup-key"]


def test_style_expression_candidates_reuse_image2_quality_chain(monkeypatch):
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_API_KEY", "primary-key")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_API_KEYS", ["pool-key"])
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_BACKUP_API_KEY", "backup-key")
    monkeypatch.setattr("backend.api.routes.visual.settings.ANTHROPIC_BACKUP_API_KEY", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_BASE_URL", "https://api.example.com/v1")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_BACKUP_BASE_URL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_FALLBACK_API_KEY", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_FALLBACK_BASE_URL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_GEN_FALLBACK_MODEL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_EDIT_API_KEY", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_EDIT_BASE_URL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE_EDIT_FALLBACK_MODEL", "")
    monkeypatch.setattr("backend.api.routes.visual.settings.IMAGE2_GEN_MODEL", "gpt-image-2")

    candidates = visual._resolve_image_generation_candidates(mode="style_expression")

    assert candidates
    assert {candidate["model"] for candidate in candidates} == {"gpt-image-2"}
    assert [candidate["api_key"] for candidate in candidates] == ["primary-key", "pool-key", "backup-key"]


def test_style_expression_builds_independent_prompt_strategy():
    _, user_message, prompt_strategy = visual._build_visual_messages(
        title="私域 SOP 怎么搭",
        content="正文",
        style="cyberpunk",
        mode="风格表达",
        material_summary=None,
        reference_summary=None,
        reference_assets=None,
        primary_reference_asset_id=None,
        dynamic_style_params={"style_preset": "运营干货手绘卡"},
    )

    assert prompt_strategy == "style_expression"
    assert "风格表达预设" in user_message
    assert "饱和青绿色背景" in user_message
    assert "白色/浅奶白撕纸质感大纸张" in user_message


def test_dynamic_expression_ignores_style_expression_preset_params():
    _, user_message, prompt_strategy = visual._build_visual_messages(
        title="私域 SOP 怎么搭",
        content="正文",
        style="cyberpunk",
        mode="动态表达",
        material_summary=None,
        reference_summary=None,
        reference_assets=None,
        primary_reference_asset_id=None,
        dynamic_style_params={"intent": "整体更清爽", "style_preset": "运营干货手绘卡"},
    )

    guarded = visual._sanitize_image2_dynamic_style_params(
        {"intent": "整体更清爽", "style_preset": "运营干货手绘卡"},
        prompt_strategy,
    )

    assert prompt_strategy == "image2_dynamic"
    assert guarded == {"intent": "整体更清爽"}
    assert "补充意图" in user_message
    assert "风格表达预设" not in user_message
    assert "运营干货手绘卡" not in user_message
