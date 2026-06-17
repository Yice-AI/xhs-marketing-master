import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.testclient import TestClient

from backend.api.models import CreateNoteJobRequest, LogoFixJobRequest
from backend.api.routes import external
from backend.config import settings
from backend.services.external_note_jobs import (
    _artifact_is_expired,
    _auto_fix_external_logo_images,
    _build_external_dynamic_logo_intent,
    _build_external_dynamic_style_params,
    _build_external_logo_fix_prompt,
    _build_external_logo_qc_prompt,
    _build_external_logo_postprocess_summary,
    _builtin_logo_reference_paths,
    _compact_text_result_for_storage,
    _external_logo_reference_urls,
    create_external_logo_fix_job,
    _materialize_png_files,
    _normalize_external_logo_qc_item,
    _resolve_external_image_mode,
    _resolve_external_strategy_user_id,
    _resolve_external_target_image_count,
    _select_note_strategy,
    _select_visual_style,
    _start_image_workflow,
)
from backend.utils.task_manager import TaskStatus, task_manager


class ExternalNoteJobHelpersTest(unittest.TestCase):
    def test_select_visual_style_keeps_requested_style_when_perturbation_disabled(self):
        selected, metadata = _select_visual_style(
            "温暖渐变卡片",
            diversity_level="high",
            variation_seed="seed-1",
            perturbation_enabled=False,
        )
        self.assertEqual(selected, "温暖渐变卡片")
        self.assertEqual(metadata["requested_visual_style"], "温暖渐变卡片")

    def test_select_visual_style_is_stable_for_same_seed(self):
        first, _ = _select_visual_style(
            "温暖渐变卡片",
            diversity_level="medium",
            variation_seed="seed-2",
            perturbation_enabled=True,
        )
        second, _ = _select_visual_style(
            "温暖渐变卡片",
            diversity_level="medium",
            variation_seed="seed-2",
            perturbation_enabled=True,
        )
        self.assertEqual(first, second)

    def test_select_note_strategy_prefers_requested_style(self):
        selected, metadata = _select_note_strategy(
            [
                {"id": "s-1", "visualDirection": "general"},
                {"id": "s-2", "visualDirection": "tutorial"},
            ],
            requested_style="tutorial",
            selected_strategy_id="",
            diversity_level="medium",
            variation_seed="seed-3",
            perturbation_enabled=False,
        )
        self.assertIsNotNone(selected)
        self.assertEqual(selected["id"], "s-2")
        self.assertEqual(metadata["selected_strategy_style"], "tutorial")

    def test_artifact_expiry_parser_handles_future_and_past(self):
        self.assertFalse(_artifact_is_expired("2099-01-01T00:00:00+00:00"))
        self.assertTrue(_artifact_is_expired("2000-01-01T00:00:00+00:00"))
        self.assertFalse(_artifact_is_expired(None))

    def test_compact_text_result_for_storage_keeps_json_fields_and_drops_large_fields(self):
        compacted = _compact_text_result_for_storage({
            "title": "标题",
            "final_body": "正文",
            "content": "正文",
            "product_brief": {"product_name": "Demo"},
            "research_context": {
                "source_documents": [
                    {
                        "url": "https://example.com",
                        "title": "Example",
                        "summary": "摘要",
                        "contentSnippet": "不应保留",
                        "status": "fetched",
                    }
                ]
            },
            "source_documents": [
                {
                    "url": "https://example.com",
                    "title": "Example",
                    "summary": "摘要",
                    "contentSnippet": "不应保留",
                    "status": "fetched",
                }
            ],
            "note_visual_plan": {"cover_claim": "claim", "intro_hook": "hook", "card_plan": [1, 2, 3]},
            "compose_result": {"very": "large"},
        })
        self.assertEqual(compacted["title"], "标题")
        self.assertEqual(compacted["body"], "正文")
        self.assertEqual(compacted["tags"], None)
        self.assertNotIn("research_context", compacted)
        self.assertNotIn("compose_result", compacted)

    @patch("backend.services.external_note_jobs.scraper.rasterize_template", new_callable=AsyncMock)
    @patch("backend.services.external_note_jobs.get_external_artifacts_dir")
    def test_materialize_png_files_rasterizes_non_base64_data_url(self, mocked_artifacts_dir, mocked_rasterize):
        with tempfile.TemporaryDirectory() as temp_dir:
            mocked_artifacts_dir.return_value = Path(temp_dir)
            mocked_rasterize.return_value = Response(content=b"png-bytes", media_type="image/png")

            files = asyncio.run(_materialize_png_files(
                "image-task-1",
                ["data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22/%3E"],
            ))

            self.assertEqual(files[0]["mime_type"], "image/png")
            saved_path = Path(temp_dir) / "image-task-1" / "image_1.png"
            self.assertTrue(saved_path.exists())
            self.assertEqual(saved_path.read_bytes(), b"png-bytes")

    @patch("backend.services.external_note_jobs.EXTERNAL_IMAGE_RETRY_AFTER_SECONDS", 1)
    @patch("backend.services.external_note_jobs.EXTERNAL_IMAGE_MAX_ATTEMPTS_PER_ITEM", 2)
    @patch("backend.services.external_note_jobs.asyncio.sleep", new_callable=AsyncMock)
    @patch("backend.services.external_note_jobs.visual.run_generate_task")
    @patch("backend.services.external_note_jobs.visual.analyze_and_generate", new_callable=AsyncMock)
    def test_start_image_workflow_retries_slow_item_with_same_prompt(
        self,
        mocked_analyze,
        mocked_run_generate,
        mocked_sleep,
    ):
        source_task_id = task_manager.create_task(
            "生成图片 1/1",
            metadata={
                "workflow_index": 1,
                "workflow_total": 1,
                "prompt": "same final prompt",
                "aspect_ratio": "3:4",
                "image_size": "1K",
                "model": "gpt-image-2",
                "task_kind": "image",
                "stage": "generating",
            },
        )
        task_manager.update_task_sync(source_task_id, status=TaskStatus.RUNNING, progress=30)
        task_manager.tasks[source_task_id].started_at = task_manager.tasks[source_task_id].started_at.replace(year=2000)
        image_task_id = task_manager.create_task(
            "外部笔记图片任务",
            metadata={"task_kind": "external_image_job", "client_id": "client-a"},
        )
        mocked_analyze.return_value = {"task_ids": [source_task_id]}

        async def finish_retry(*_args, **_kwargs):
            retry_task_ids = [
                task_id for task_id, task in task_manager.tasks.items()
                if task.metadata.get("source_task_id") == source_task_id
            ]
            if retry_task_ids:
                retry_task_id = retry_task_ids[-1]
                task_manager.update_task_sync(
                    retry_task_id,
                    status=TaskStatus.COMPLETED,
                    progress=100,
                    result={"success": True, "images": ["/static/images/retry.png"], "paths": ["/tmp/retry.png"]},
                    metadata={"stage": "completed"},
                )

        mocked_sleep.side_effect = finish_retry

        images = asyncio.run(_start_image_workflow(
            image_task_id=image_task_id,
            request=CreateNoteJobRequest(
                product_name="Demo",
                target_audience="运营",
                product_features="功能",
                image_mode="动态表达",
            ),
            client_id="client-a",
            image_context={"title": "标题", "final_body": "正文", "selected_visual_style": "温暖渐变卡片"},
            resolved_image_mode="image2_dynamic",
            target_image_count=1,
            job_started_monotonic=None,
        ))

        self.assertEqual(images, ["/static/images/retry.png"])
        retry_task_ids = [
            task_id for task_id, task in task_manager.tasks.items()
            if task.metadata.get("source_task_id") == source_task_id
        ]
        self.assertEqual(len(retry_task_ids), 1)
        retry_task = task_manager.get_task(retry_task_ids[0])
        self.assertEqual((retry_task["metadata"] or {})["prompt"], "same final prompt")
        self.assertEqual((retry_task["metadata"] or {})["external_retry_attempt"], 2)

    @patch("backend.services.external_note_jobs.asyncio.sleep", new_callable=AsyncMock)
    @patch("backend.services.external_note_jobs.visual.analyze_and_generate", new_callable=AsyncMock)
    def test_start_image_workflow_uses_actual_submitted_count_as_expected(
        self,
        mocked_analyze,
        _mocked_sleep,
    ):
        source_task_ids = []
        for index in range(1, 4):
            task_id = task_manager.create_task(
                f"生成图片 {index}/4",
                metadata={
                    "workflow_index": index,
                    "workflow_total": 4,
                    "prompt": f"prompt {index}",
                    "task_kind": "image",
                    "stage": "completed",
                },
            )
            task_manager.update_task_sync(
                task_id,
                status=TaskStatus.COMPLETED,
                progress=100,
                result={"success": True, "images": [f"/static/images/{index}.png"], "paths": [f"/tmp/{index}.png"]},
                metadata={"stage": "completed"},
            )
            source_task_ids.append(task_id)

        image_task_id = task_manager.create_task(
            "外部笔记图片任务",
            metadata={"task_kind": "external_image_job", "client_id": "client-a"},
        )
        mocked_analyze.return_value = {"task_ids": source_task_ids, "requested_image_count": 4, "actual_submitted_count": 3}

        images = asyncio.run(_start_image_workflow(
            image_task_id=image_task_id,
            request=CreateNoteJobRequest(
                product_name="Demo",
                target_audience="运营",
                product_features="功能",
                image_mode="动态表达",
            ),
            client_id="client-a",
            image_context={"title": "标题", "final_body": "正文", "selected_visual_style": "温暖渐变卡片"},
            resolved_image_mode="image2_dynamic",
            target_image_count=4,
            job_started_monotonic=None,
        ))

        self.assertEqual(images, ["/static/images/1.png", "/static/images/2.png", "/static/images/3.png"])
        image_task = task_manager.get_task(image_task_id)
        metadata = image_task["metadata"] or {}
        self.assertEqual(metadata["expected_image_count"], 3)
        self.assertEqual(metadata["ready_image_count"], 3)
        self.assertEqual(image_task["message"], "图片生成中（3/3）")

    def test_resolve_external_target_image_count_uses_card_plan_for_concept_mode(self):
        count = _resolve_external_target_image_count(
            {"card_plan": [
                {"card_type": "封面卡"},
                {"card_type": "功能卡"},
                {"card_type": "步骤卡"},
                {"card_type": "收口卡"},
            ]},
            resolved_image_mode="concept",
            note_strategy={"visualDirection": "tutorial"},
        )
        self.assertEqual(count, 4)

    def test_resolve_external_target_image_count_minimum_is_one(self):
        count = _resolve_external_target_image_count(
            {"card_plan": [{"card_type": "封面卡"}]},
            resolved_image_mode="concept",
        )
        self.assertEqual(count, 3)

    def test_resolve_external_target_image_count_defaults_to_dynamic_planning_limit(self):
        count = _resolve_external_target_image_count(
            {"card_plan": [{"card_type": "封面卡"}]},
            resolved_image_mode="image2_dynamic",
        )
        self.assertEqual(count, 4)

    def test_resolve_external_target_image_count_uses_explicit_requested_count_as_dynamic_limit(self):
        count = _resolve_external_target_image_count(
            {"card_plan": [{"card_type": "封面卡"}]},
            resolved_image_mode="image2_dynamic",
            requested_image_count=4,
            image_count_provided=True,
        )
        self.assertEqual(count, 4)

    def test_resolve_external_image_mode_allows_dynamic_expression(self):
        self.assertEqual(_resolve_external_image_mode("动态表达"), "image2_dynamic")
        self.assertEqual(_resolve_external_image_mode("image2_dynamic"), "image2_dynamic")

    def test_resolve_external_strategy_user_id_uses_api_client_by_default(self):
        self.assertEqual(
            _resolve_external_strategy_user_id("external-api:abc123", None),
            "api:external-api:abc123",
        )

    def test_resolve_external_strategy_user_id_separates_external_operator(self):
        first = _resolve_external_strategy_user_id("external-api:abc123", "operator-a")
        second = _resolve_external_strategy_user_id("external-api:abc123", "operator-b")

        self.assertEqual(first, "api:external-api:abc123:operator-a")
        self.assertEqual(second, "api:external-api:abc123:operator-b")
        self.assertNotEqual(first, second)

    def test_resolve_external_strategy_user_id_compacts_long_values(self):
        resolved = _resolve_external_strategy_user_id(
            "external-api:" + "a" * 80,
            "operator-" + "b" * 80,
        )

        self.assertLessEqual(len(resolved), 64)
        self.assertTrue(resolved.startswith("api:operator-"))

    def test_build_external_dynamic_logo_intent_adds_yiban_guardrails(self):
        intent = _build_external_dynamic_logo_intent(CreateNoteJobRequest(
            product_name="壹伴助手",
            target_audience="公众号运营者",
            product_features="排版、素材、AI 写作",
            product_urls=["https://yiban.io"],
            must_include="壹伴",
            banned_terms="微伴助手",
            image_mode="动态表达",
        ))

        self.assertIn("品牌 Logo 视觉约束", intent)
        self.assertIn("「壹伴助手」", intent)
        self.assertIn("「壹伴」", intent)
        self.assertIn("「微伴」", intent)
        self.assertIn("「一伴」", intent)
        self.assertIn("绿色圆形底", intent)
        self.assertIn("白色几何 Y 形", intent)
        self.assertIn("不要画成叶子", intent)

    def test_build_external_logo_qc_prompt_requires_yiban_official_shape(self):
        prompt = _build_external_logo_qc_prompt(CreateNoteJobRequest(
            product_name="壹伴助手",
            target_audience="公众号运营者",
            product_features="排版、素材、AI 写作",
            product_urls=["https://yiban.io"],
            image_mode="动态表达",
        ))

        self.assertIn("绿色圆形底", prompt)
        self.assertIn("白色几何 Y 形", prompt)
        self.assertIn("official_logo_reference", prompt)
        self.assertIn("不是叶子", prompt)
        self.assertIn("need_fix=true", prompt)
        self.assertIn("detected_logo_shape", prompt)

    def test_builtin_logo_reference_paths_include_yiban_assets(self):
        paths = _builtin_logo_reference_paths("壹伴助手")

        self.assertGreaterEqual(len(paths), 1)
        self.assertTrue(any(path.name == "yiban_icon.png" for path in paths))
        self.assertTrue(all(path.exists() for path in paths))

    def test_external_logo_reference_urls_prefers_explicit_logo_urls(self):
        request = CreateNoteJobRequest(
            product_name="Demo",
            target_audience="内容运营",
            product_features="AI 写作",
            product_urls=["https://example.com/product.png"],
            logo_reference_urls=["https://cdn.example.com/logo.png"],
        )

        self.assertEqual(_external_logo_reference_urls(request), ["https://cdn.example.com/logo.png"])

    def test_external_logo_reference_urls_falls_back_to_product_image_urls(self):
        request = CreateNoteJobRequest(
            product_name="Demo",
            target_audience="内容运营",
            product_features="AI 写作",
            product_urls=["https://example.com/product", "https://cdn.example.com/logo.webp"],
        )

        self.assertEqual(_external_logo_reference_urls(request), ["https://cdn.example.com/logo.webp"])

    def test_build_external_dynamic_style_params_only_applies_to_dynamic_mode(self):
        request = CreateNoteJobRequest(
            product_name="Uplog",
            target_audience="自媒体",
            product_features="一键导入、模板套用",
            product_urls=["https://example.com"],
            banned_terms="Upload, UpLog",
        )

        dynamic_params = _build_external_dynamic_style_params(request, "image2_dynamic")
        self.assertIsNotNone(dynamic_params)
        self.assertIn("Uplog", dynamic_params["intent"])
        self.assertIn("Upload", dynamic_params["intent"])
        self.assertEqual(dynamic_params["external_api_logo_guardrail"], dynamic_params["intent"])
        self.assertIsNone(_build_external_dynamic_style_params(request, "concept"))

    def test_build_external_logo_postprocess_summary_merges_qc_and_fix_state(self):
        summary = _build_external_logo_postprocess_summary(
            [
                {"need_fix": True, "fix_status": "fixed"},
                {"need_fix": False, "fix_status": "skipped"},
            ],
            qc_summary={"qc_ran": True, "qc_summary": "发现 1 处异常"},
            auto_fix_summary={
                "auto_fix_ran": True,
                "fixed": 1,
                "failed": 0,
                "skipped": 1,
                "reference_logo_count": 1,
            },
        )

        self.assertTrue(summary["qc_ran"])
        self.assertTrue(summary["auto_fix_ran"])
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["need_fix"], 1)
        self.assertEqual(summary["fixed"], 1)
        self.assertEqual(summary["skipped"], 1)
        self.assertEqual(summary["reference_logo_count"], 1)
        self.assertEqual(summary["qc_summary"], "发现 1 处异常")

    def test_build_external_logo_postprocess_summary_keeps_qc_reference_count_without_fix(self):
        summary = _build_external_logo_postprocess_summary(
            [{"need_fix": False, "fix_status": "skipped"}],
            qc_summary={"qc_ran": True, "reference_logo_count": 2},
            auto_fix_summary={"auto_fix_ran": False, "reference_logo_count": 0},
        )

        self.assertEqual(summary["reference_logo_count"], 2)

    def test_normalize_external_logo_qc_item_flags_yiban_paper_plane_shape(self):
        item = _normalize_external_logo_qc_item(
            {
                "status": "ok",
                "need_fix": False,
                "detected_brand_text": "壹伴助手",
                "detected_logo_shape": "绿色圆形底，白色纸飞机/发送按钮图形",
                "reason": "品牌文字正确",
            },
            product_name="壹伴助手",
        )

        self.assertEqual(item["status"], "suspect")
        self.assertTrue(item["need_fix"])
        self.assertIn("纸飞机", item["reason"])

    def test_normalize_external_logo_qc_item_flags_yiban_check_mark_shape(self):
        item = _normalize_external_logo_qc_item(
            {
                "status": "ok",
                "need_fix": False,
                "detected_brand_text": "壹伴助手",
                "detected_logo_shape": "绿色圆形底，白色对勾图标",
                "reason": "颜色和品牌字正确",
            },
            product_name="壹伴助手",
        )

        self.assertEqual(item["status"], "suspect")
        self.assertTrue(item["need_fix"])
        self.assertIn("对勾", item["reason"])

    def test_normalize_external_logo_qc_item_flags_yiban_seven_shape(self):
        item = _normalize_external_logo_qc_item(
            {
                "status": "ok",
                "need_fix": False,
                "detected_brand_text": "壹伴助手",
                "detected_logo_shape": "绿色圆形底，白色数字7形图标",
                "reason": "接近参考图",
            },
            product_name="壹伴助手",
        )

        self.assertEqual(item["status"], "suspect")
        self.assertTrue(item["need_fix"])
        self.assertIn("数字", item["reason"])

    def test_normalize_external_logo_qc_item_requires_explicit_yiban_y_shape(self):
        item = _normalize_external_logo_qc_item(
            {
                "status": "ok",
                "need_fix": False,
                "detected_brand_text": "壹伴助手",
                "detected_logo_shape": "绿色圆形底，白色图案接近参考图",
                "reason": "未发现错误品牌字样",
            },
            product_name="壹伴助手",
        )

        self.assertEqual(item["status"], "suspect")
        self.assertTrue(item["need_fix"])
        self.assertIn("Y 形/折角", item["reason"])

    def test_build_external_logo_fix_prompt_matches_batch_logo_fix_contract(self):
        prompt = _build_external_logo_fix_prompt(
            CreateNoteJobRequest(
                product_name="壹伴助手",
                target_audience="公众号运营者",
                product_features="排版、素材、AI 写作",
                product_urls=["https://yiban.io"],
                image_mode="动态表达",
            ),
            {"reason": "图标像对勾"},
        )

        self.assertIn("把图里的品牌 logo 换成参考图里的 logo", prompt)
        self.assertIn("其他内容", prompt)
        self.assertIn("绿色圆形底", prompt)
        self.assertIn("白色几何 Y 形", prompt)

    def test_create_external_logo_fix_job_uses_external_image_job_contract(self):
        job = create_external_logo_fix_job(
            LogoFixJobRequest(
                image_urls=["https://cdn.example.com/poster.png"],
                logo_reference_urls=["https://cdn.example.com/logo.png"],
                product_name="Demo",
            ),
            "external-api:test",
        )

        self.assertIn("image_task_id", job)

    @patch("backend.services.external_note_jobs.image_job_slot")
    @patch("backend.services.external_note_jobs._download_external_logo_reference_assets", new_callable=AsyncMock)
    @patch("backend.services.external_note_jobs.visual.resolve_image_edit_config")
    @patch("backend.services.external_note_jobs.visual._resolve_image_provider")
    @patch("backend.services.external_note_jobs.ImageGenerator")
    def test_auto_fix_external_logo_images_uses_logo_runner_and_all_references(
        self,
        mocked_generator_cls,
        mocked_resolve_provider,
        mocked_resolve_config,
        mocked_download_refs,
        mocked_image_slot,
    ):
        class DummySlot:
            async def __aenter__(self):
                return 0

            async def __aexit__(self, exc_type, exc, tb):
                return False

        mocked_image_slot.return_value = DummySlot()
        mocked_download_refs.return_value = [
            "/tmp/logo_1.png",
            "/tmp/logo_2.png",
            "/tmp/logo_3.png",
            "/tmp/logo_4.png",
        ]
        mocked_resolve_config.return_value = ("key", "https://example.com/v1", "gpt-image-2", None, None, None)
        mocked_resolve_provider.return_value = "custom"

        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "image_1.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\n")
            fixed_path = Path(temp_dir) / "fixed.png"
            fixed_path.write_bytes(b"\x89PNG\r\n\x1a\nfixed")
            generator = mocked_generator_cls.return_value
            generator.edit_image.return_value = [str(fixed_path)]

            qc_items, summary = asyncio.run(_auto_fix_external_logo_images(
                request=CreateNoteJobRequest(
                    product_name="壹伴助手",
                    target_audience="公众号运营者",
                    product_features="排版、素材、AI 写作",
                    product_urls=["https://yiban.io"],
                    image_mode="动态表达",
                ),
                client_id="external-api:test",
                image_task_id="image-task-1",
                image_paths=[image_path],
                qc_items=[{"index": 1, "need_fix": True, "fix_status": "pending"}],
            ))

        mocked_image_slot.assert_called_once()
        self.assertEqual(mocked_image_slot.call_args.kwargs["policy_key"], "logo_replacement")
        self.assertEqual(mocked_image_slot.call_args.kwargs["owner_id"], "external-api:test")
        self.assertEqual(generator.edit_image.call_args.args[5], mocked_download_refs.return_value)
        self.assertFalse(generator.edit_image.call_args.args[6])
        self.assertEqual(generator.edit_image.call_args.args[7], "logo_replacement")
        self.assertEqual(qc_items[0]["fix_status"], "fixed")
        self.assertEqual(summary["fixed"], 1)
        self.assertEqual(summary["reference_logo_count"], 4)


class ExternalNoteJobRouteTest(unittest.TestCase):
    def setUp(self):
        self.original_enabled = settings.EXTERNAL_API_ENABLED
        self.original_keys = settings.EXTERNAL_API_KEYS
        settings.EXTERNAL_API_ENABLED = True
        settings.EXTERNAL_API_KEYS = ["test-key"]

        app = FastAPI()
        app.include_router(external.router)
        self.client = TestClient(app)

    def tearDown(self):
        settings.EXTERNAL_API_ENABLED = self.original_enabled
        settings.EXTERNAL_API_KEYS = self.original_keys

    def test_create_note_job_requires_api_key(self):
        response = self.client.post("/api/external/note-jobs", json={})
        self.assertEqual(response.status_code, 401)

    def test_create_note_job_rejects_unknown_image_mode(self):
        response = self.client.post(
            "/api/external/note-jobs",
            headers={"Authorization": "Bearer test-key"},
            json={
                "product_name": "Uplog",
                "target_audience": "内容运营",
                "product_features": "把网页内容改成小红书笔记",
                "product_urls": ["https://example.com/product"],
                "image_mode": "unknown-mode",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("不支持的 image_mode", response.json()["detail"])

    def test_create_note_job_rejects_template_compose_mode(self):
        response = self.client.post(
            "/api/external/note-jobs",
            headers={"Authorization": "Bearer test-key"},
            json={
                "product_name": "Uplog",
                "target_audience": "内容运营",
                "product_features": "把网页内容改成小红书笔记",
                "product_urls": ["https://example.com/product"],
                "image_mode": "模板拼装",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("当前外部 API 暂只支持", response.json()["detail"])
        self.assertIn("概念表达", response.json()["detail"])
        self.assertIn("动态表达", response.json()["detail"])

    @patch("backend.api.routes.external.run_external_note_batch", new_callable=AsyncMock)
    @patch(
        "backend.api.routes.external.create_external_note_batch",
        return_value={
            "batch_id": "batch-test-1",
            "text_task_id": "text-test-1",
            "image_task_id": "image-test-1",
        },
    )
    def test_create_note_job_returns_batch_and_two_task_ids(self, mocked_create_batch, _mocked_task):
        response = self.client.post(
            "/api/external/note-jobs",
            headers={"Authorization": "Bearer test-key"},
            json={
                "product_name": "Uplog",
                "target_audience": "内容运营",
                "product_features": "把网页内容改成小红书笔记",
                "product_urls": ["https://example.com/product"],
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["batch_id"], "batch-test-1")
        self.assertEqual(body["text_task_id"], "text-test-1")
        self.assertEqual(body["image_task_id"], "image-test-1")
        mocked_create_batch.assert_called_once()

    @patch("backend.api.routes.external.can_accept_external_note_job", return_value=(False, "外部 API 任务队列已满，请稍后再提交"))
    def test_create_note_job_rejects_when_external_runner_queue_is_full(self, _mocked_can_accept):
        response = self.client.post(
            "/api/external/note-jobs",
            headers={"Authorization": "Bearer test-key"},
            json={
                "product_name": "Uplog",
                "target_audience": "内容运营",
                "product_features": "把网页内容改成小红书笔记",
                "product_urls": ["https://example.com/product"],
            },
        )
        self.assertEqual(response.status_code, 429)
        self.assertIn("队列已满", response.json()["detail"])

    @patch("backend.api.routes.external.run_external_logo_fix_job", new_callable=AsyncMock)
    @patch(
        "backend.api.routes.external.create_external_logo_fix_job",
        return_value={"image_task_id": "logo-fix-test-1"},
    )
    def test_create_logo_fix_job_returns_image_task_id(self, mocked_create_job, _mocked_task):
        response = self.client.post(
            "/api/external/logo-fix-jobs",
            headers={"Authorization": "Bearer test-key"},
            json={
                "image_urls": ["https://cdn.example.com/poster.png"],
                "logo_reference_urls": ["https://cdn.example.com/logo.png"],
                "product_name": "壹伴助手",
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["image_task_id"], "logo-fix-test-1")
        self.assertEqual(body["status"], "pending")
        mocked_create_job.assert_called_once()

    @patch(
        "backend.api.routes.external.get_external_note_job_runner_stats",
        return_value={
            "concurrency_limit": 2,
            "per_client_concurrency_limit": 2,
            "queue_max_size": 20,
            "active": 1,
            "waiting": 0,
        },
    )
    def test_get_note_runner_status_returns_payload(self, _mocked_stats):
        response = self.client.get(
            "/api/external/note-runner/status",
            headers={"Authorization": "Bearer test-key"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["concurrency_limit"], 2)
        self.assertEqual(body["active"], 1)

    @patch("backend.api.routes.external.get_external_text_job_status")
    def test_get_text_job_status_returns_payload(self, mocked_get_status):
        mocked_get_status.return_value = {
            "task_id": "text-test-2",
            "status": "completed",
            "progress": 100,
            "message": "done",
            "error": None,
            "created_at": "2026-04-28T00:00:00",
            "started_at": "2026-04-28T00:00:01",
            "completed_at": "2026-04-28T00:00:10",
            "result": {
                "title": "标题",
                "body": "正文",
                "tags": ["标签A"],
            },
        }
        response = self.client.get(
            "/api/external/text-jobs/text-test-2",
            headers={"Authorization": "Bearer test-key"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["text_task_id"], "text-test-2")
        self.assertEqual(body["status"], "completed")
        self.assertEqual(body["result"]["title"], "标题")
        self.assertEqual(body["result"]["body"], "正文")

    @patch("backend.api.routes.external.get_external_image_job_status")
    def test_get_image_job_status_returns_payload(self, mocked_get_status):
        mocked_get_status.return_value = {
            "task_id": "image-test-2",
            "status": "completed",
            "progress": 100,
            "message": "done",
            "error": None,
            "created_at": "2026-04-28T00:00:00",
            "started_at": "2026-04-28T00:00:01",
            "completed_at": "2026-04-28T00:00:10",
            "result": {
                "status": "awaiting_ack",
                "images": [
                    {
                        "index": 1,
                        "file_name": "image_1.png",
                        "download_url": "http://localhost:3000/api/external/image-jobs/image-test-2/files/1",
                        "mime_type": "image/png",
                    }
                ],
                "image_count": 1,
                "expected_image_count": 1,
                "ready_image_count": 1,
                "image_items": [
                    {
                        "index": 1,
                        "task_id": "upstream-image-1",
                        "status": "completed",
                        "progress": 100,
                        "message": "图片生成完成",
                        "stage": "completed",
                        "runtime_seconds": 78,
                        "prompt_length": 123,
                        "model": "gpt-image-2",
                    }
                ],
                "requested_image_mode": "概念表达",
                "visual_mode_resolved": "concept",
                "artifact_expires_at": "2099-01-01T00:00:00+00:00",
                "downloaded_acknowledged": False,
                "deleted_at": None,
                "logo_quality_checks": [{"index": 1, "status": "ok"}],
                "logo_fix_summary": {"qc_ran": True, "auto_fix_ran": False, "total": 1, "need_fix": 0, "fixed": 0, "failed": 0, "skipped": 1},
            },
        }
        response = self.client.get(
            "/api/external/image-jobs/image-test-2",
            headers={"Authorization": "Bearer test-key"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["image_task_id"], "image-test-2")
        self.assertEqual(body["status"], "awaiting_ack")
        self.assertEqual(body["images"][0]["mime_type"], "image/png")
        self.assertEqual(body["expected_image_count"], 1)
        self.assertEqual(body["ready_image_count"], 1)
        self.assertEqual(body["image_items"][0]["task_id"], "upstream-image-1")
        self.assertEqual(body["image_items"][0]["runtime_seconds"], 78)
        self.assertEqual(body["requested_image_mode"], "概念表达")
        self.assertEqual(body["visual_mode_resolved"], "concept")
        self.assertEqual(body["logo_quality_checks"][0]["status"], "ok")
        self.assertFalse(body["logo_fix_summary"]["auto_fix_ran"])

    @patch("backend.api.routes.external.get_external_image_job_file")
    def test_download_image_job_file_returns_png(self, mocked_get_file):
        with tempfile.TemporaryDirectory() as temp_dir:
            image_path = Path(temp_dir) / "image_1.png"
            image_path.write_bytes(b"\x89PNG\r\n\x1a\n")
            mocked_get_file.return_value = image_path
            response = self.client.get(
                "/api/external/image-jobs/image-test-3/files/1",
                headers={"Authorization": "Bearer test-key"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/png")

    @patch("backend.api.routes.external.acknowledge_external_image_job")
    def test_ack_image_job_returns_deleted_status(self, mocked_ack):
        mocked_ack.return_value = {
            "task_id": "image-test-4",
            "status": "completed",
            "progress": 100,
            "message": "图片已确认接收并删除",
            "error": None,
            "created_at": "2026-04-28T00:00:00",
            "started_at": "2026-04-28T00:00:01",
            "completed_at": "2026-04-28T00:00:10",
            "result": {
                "status": "deleted",
                "images": [],
                "image_count": 0,
                "requested_image_mode": "概念表达",
                "visual_mode_resolved": "concept",
                "artifact_expires_at": "2099-01-01T00:00:00+00:00",
                "downloaded_acknowledged": True,
                "deleted_at": "2026-04-28T00:01:00+00:00",
                "logo_quality_checks": [{"index": 1, "status": "ok"}],
                "logo_fix_summary": {"qc_ran": True, "auto_fix_ran": True, "total": 1, "need_fix": 1, "fixed": 1, "failed": 0, "skipped": 0},
            },
        }
        response = self.client.post(
            "/api/external/image-jobs/image-test-4/ack",
            headers={"Authorization": "Bearer test-key"},
            json={"downloaded_files": [1], "receiver": "client-a"},
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "deleted")
        self.assertTrue(body["downloaded_acknowledged"])
        self.assertEqual(body["visual_mode_resolved"], "concept")
        self.assertEqual(body["logo_quality_checks"][0]["status"], "ok")
        self.assertTrue(body["logo_fix_summary"]["auto_fix_ran"])


if __name__ == "__main__":
    unittest.main()
