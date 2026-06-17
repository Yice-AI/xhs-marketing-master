import asyncio
import unittest

from backend.config.settings import _parse_int_mapping
from backend.api.routes.visual import (
    _clear_logo_replacement_resource_cooldown,
    _edit_candidate_resource_id,
    _logo_replacement_resource_cooldown_ids,
    _mark_logo_replacement_resource_unhealthy,
    _prefer_available_edit_candidates,
    _resolve_edit_owner_concurrency_limit,
    _resolve_image_owner_concurrency_limit,
    _resolve_workflow_concurrency,
)
from backend.services import image_job_runner
from backend.services.image_job_runner import resolve_image_job_policy_limit


def _clear_runner_counters() -> None:
    image_job_runner._ACTIVE_IMAGE_JOBS = 0
    image_job_runner._WAITING_IMAGE_JOBS = 0
    image_job_runner._COMPLETED_IMAGE_JOBS = 0
    image_job_runner._FAILED_IMAGE_JOBS = 0
    image_job_runner._ACTIVE_IMAGE_JOBS_BY_OWNER = {}
    image_job_runner._ACTIVE_IMAGE_JOBS_BY_RESOURCE = {}
    image_job_runner._ACTIVE_IMAGE_JOBS_BY_POLICY = {}


class ImageJobRunnerTest(unittest.TestCase):
    def test_image_job_slot_limits_concurrent_work(self):
        async def scenario():
            original_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY
            original_per_user_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER
            original_per_key_limit = image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY
            original_semaphore = image_job_runner._IMAGE_JOB_SEMAPHORE
            original_owner_semaphores = image_job_runner._OWNER_SEMAPHORES
            original_resource_semaphores = image_job_runner._RESOURCE_SEMAPHORES
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = 2
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = 1
            image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = 2
            image_job_runner._IMAGE_JOB_SEMAPHORE = asyncio.Semaphore(2)
            image_job_runner._OWNER_SEMAPHORES = {}
            image_job_runner._RESOURCE_SEMAPHORES = image_job_runner.defaultdict(
                lambda: asyncio.Semaphore(image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY)
            )
            _clear_runner_counters()
            observed_active = 0

            async def worker(index: int):
                nonlocal observed_active
                async with image_job_runner.image_job_slot(f"task-{index}", job_type="test"):
                    observed_active = max(observed_active, image_job_runner._ACTIVE_IMAGE_JOBS)
                    await asyncio.sleep(0.02)

            try:
                await asyncio.gather(*(worker(index) for index in range(5)))
                self.assertEqual(observed_active, 2)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["completed"], 5)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["active"], 0)
            finally:
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = original_limit
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = original_per_user_limit
                image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = original_per_key_limit
                image_job_runner._IMAGE_JOB_SEMAPHORE = original_semaphore
                image_job_runner._OWNER_SEMAPHORES = original_owner_semaphores
                image_job_runner._RESOURCE_SEMAPHORES = original_resource_semaphores
                _clear_runner_counters()

        asyncio.run(scenario())

    def test_image_job_slot_limits_concurrent_work_per_owner(self):
        async def scenario():
            original_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY
            original_per_user_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER
            original_per_key_limit = image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY
            original_semaphore = image_job_runner._IMAGE_JOB_SEMAPHORE
            original_owner_semaphores = image_job_runner._OWNER_SEMAPHORES
            original_resource_semaphores = image_job_runner._RESOURCE_SEMAPHORES
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = 2
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = 1
            image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = 2
            image_job_runner._IMAGE_JOB_SEMAPHORE = asyncio.Semaphore(2)
            image_job_runner._OWNER_SEMAPHORES = {}
            image_job_runner._RESOURCE_SEMAPHORES = image_job_runner.defaultdict(
                lambda: asyncio.Semaphore(image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY)
            )
            _clear_runner_counters()
            observed_active = 0
            observed_owner_active = 0
            starts: list[str] = []

            async def worker(owner_id: str, index: int):
                nonlocal observed_active, observed_owner_active
                async with image_job_runner.image_job_slot(
                    f"{owner_id}-{index}",
                    job_type="test",
                    owner_id=owner_id,
                ):
                    starts.append(f"{owner_id}-{index}")
                    observed_active = max(observed_active, image_job_runner._ACTIVE_IMAGE_JOBS)
                    observed_owner_active = max(
                        observed_owner_active,
                        image_job_runner._ACTIVE_IMAGE_JOBS_BY_OWNER.get(owner_id, 0),
                    )
                    await asyncio.sleep(0.02)

            try:
                await asyncio.gather(
                    worker("user-a", 1),
                    worker("user-a", 2),
                    worker("user-b", 1),
                    worker("user-b", 2),
                )
                self.assertEqual(observed_active, 2)
                self.assertEqual(observed_owner_active, 1)
                self.assertIn("user-b-1", starts[:2])
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["completed"], 4)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["active"], 0)
            finally:
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = original_limit
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = original_per_user_limit
                image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = original_per_key_limit
                image_job_runner._IMAGE_JOB_SEMAPHORE = original_semaphore
                image_job_runner._OWNER_SEMAPHORES = original_owner_semaphores
                image_job_runner._RESOURCE_SEMAPHORES = original_resource_semaphores
                _clear_runner_counters()

        asyncio.run(scenario())

    def test_image_job_slot_limits_concurrent_work_per_resource(self):
        async def scenario():
            original_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY
            original_per_user_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER
            original_per_key_limit = image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY
            original_semaphore = image_job_runner._IMAGE_JOB_SEMAPHORE
            original_owner_semaphores = image_job_runner._OWNER_SEMAPHORES
            original_resource_semaphores = image_job_runner._RESOURCE_SEMAPHORES
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = 4
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = 4
            image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = 2
            image_job_runner._IMAGE_JOB_SEMAPHORE = asyncio.Semaphore(4)
            image_job_runner._OWNER_SEMAPHORES = {}
            image_job_runner._RESOURCE_SEMAPHORES = image_job_runner.defaultdict(
                lambda: asyncio.Semaphore(image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY)
            )
            _clear_runner_counters()
            observed_resource_active = 0

            async def worker(index: int):
                nonlocal observed_resource_active
                async with image_job_runner.image_job_slot(
                    f"task-{index}",
                    job_type="test",
                    owner_id=f"user-{index}",
                    resource_id="key-a",
                ):
                    observed_resource_active = max(
                        observed_resource_active,
                        image_job_runner._ACTIVE_IMAGE_JOBS_BY_RESOURCE.get("key-a", 0),
                    )
                    await asyncio.sleep(0.02)

            try:
                await asyncio.gather(*(worker(index) for index in range(4)))
                self.assertEqual(observed_resource_active, 2)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["completed"], 4)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["active"], 0)
            finally:
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = original_limit
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = original_per_user_limit
                image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = original_per_key_limit
                image_job_runner._IMAGE_JOB_SEMAPHORE = original_semaphore
                image_job_runner._OWNER_SEMAPHORES = original_owner_semaphores
                image_job_runner._RESOURCE_SEMAPHORES = original_resource_semaphores
                _clear_runner_counters()

        asyncio.run(scenario())

    def test_gpt_image_2_workflow_uses_provider_concurrency(self):
        concurrency = _resolve_workflow_concurrency([
            {
                "provider": "custom",
                "model": "gpt-image-2",
            }
        ])

        self.assertEqual(concurrency, 4)

    def test_gemini_workflow_keeps_conservative_concurrency(self):
        concurrency = _resolve_workflow_concurrency([
            {
                "provider": "custom",
                "model": "gemini-3-pro-image",
            }
        ])

        self.assertEqual(concurrency, 2)

    def test_owner_concurrency_limits_are_mode_specific(self):
        self.assertEqual(resolve_image_job_policy_limit("image2_dynamic"), 4)
        self.assertEqual(resolve_image_job_policy_limit("style_expression"), 4)
        self.assertEqual(resolve_image_job_policy_limit("material_fusion"), 2)
        self.assertEqual(resolve_image_job_policy_limit("image_edit"), 2)
        self.assertEqual(resolve_image_job_policy_limit("logo_replacement"), 2)
        self.assertEqual(resolve_image_job_policy_limit("concept"), 1)
        self.assertEqual(
            _resolve_image_owner_concurrency_limit({"visual_mode_resolved": "image2_dynamic"}),
            4,
        )
        self.assertEqual(
            _resolve_image_owner_concurrency_limit({"visual_mode_resolved": "style_expression"}),
            4,
        )
        self.assertEqual(
            _resolve_edit_owner_concurrency_limit({"visual_mode_resolved": "material_fusion"}),
            2,
        )
        self.assertEqual(
            _resolve_edit_owner_concurrency_limit({}),
            2,
        )
        self.assertEqual(
            _resolve_edit_owner_concurrency_limit({"edit_purpose": "logo_replacement"}),
            2,
        )
        self.assertEqual(
            _resolve_image_owner_concurrency_limit({"visual_mode_resolved": "concept"}),
            1,
        )

    def test_policy_limit_mapping_supports_compact_and_json_env_shapes(self):
        default = {"image2_dynamic": 4, "concept": 1}

        self.assertEqual(
            _parse_int_mapping("image2_dynamic=5,concept=2,bad=x", default),
            {"image2_dynamic": 5, "concept": 2},
        )
        self.assertEqual(
            _parse_int_mapping('{"image_edit": 3, "logo_replacement": "2"}', default),
            {"image2_dynamic": 4, "concept": 1, "image_edit": 3, "logo_replacement": 2},
        )

    def test_logo_replacement_resource_cooldown_ids_can_be_cleared(self):
        resource_id = "image_edit:test-cooldown"
        _mark_logo_replacement_resource_unhealthy(resource_id, reason="test")
        try:
            self.assertIn(resource_id, _logo_replacement_resource_cooldown_ids())
        finally:
            _clear_logo_replacement_resource_cooldown(resource_id)

        self.assertNotIn(resource_id, _logo_replacement_resource_cooldown_ids())

    def test_logo_replacement_prefers_non_cooled_resource(self):
        slow_candidate = {
            "provider": "custom",
            "base_url": "https://example.test/v1",
            "model": "gpt-image-2",
            "api_key": "slow-key",
        }
        healthy_candidate = {
            "provider": "custom",
            "base_url": "https://example.test/v1",
            "model": "gpt-image-2",
            "api_key": "healthy-key",
        }
        slow_resource = _edit_candidate_resource_id(slow_candidate)
        _mark_logo_replacement_resource_unhealthy(slow_resource, reason="test")
        try:
            ordered = _prefer_available_edit_candidates([slow_candidate, healthy_candidate], avoid_resource_ids=_logo_replacement_resource_cooldown_ids())
            self.assertEqual(ordered[0]["api_key"], "healthy-key")
            self.assertEqual(ordered[-1]["api_key"], "slow-key")
        finally:
            _clear_logo_replacement_resource_cooldown(slow_resource)

    def test_image_job_slot_allows_override_per_owner_limit(self):
        async def scenario():
            original_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY
            original_per_user_limit = image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER
            original_per_key_limit = image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY
            original_semaphore = image_job_runner._IMAGE_JOB_SEMAPHORE
            original_owner_semaphores = image_job_runner._OWNER_SEMAPHORES
            original_resource_semaphores = image_job_runner._RESOURCE_SEMAPHORES
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = 4
            image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = 1
            image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = 4
            image_job_runner._IMAGE_JOB_SEMAPHORE = asyncio.Semaphore(4)
            image_job_runner._OWNER_SEMAPHORES = {}
            image_job_runner._RESOURCE_SEMAPHORES = image_job_runner.defaultdict(
                lambda: asyncio.Semaphore(image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY)
            )
            _clear_runner_counters()
            observed_owner_active = 0

            async def worker(index: int):
                nonlocal observed_owner_active
                async with image_job_runner.image_job_slot(
                    f"task-{index}",
                    job_type="test",
                    owner_id="same-user",
                    owner_concurrency_limit=4,
                    resource_id=f"key-{index}",
                ):
                    observed_owner_active = max(
                        observed_owner_active,
                        image_job_runner._ACTIVE_IMAGE_JOBS_BY_OWNER.get("same-user", 0),
                    )
                    await asyncio.sleep(0.02)

            try:
                await asyncio.gather(*(worker(index) for index in range(4)))
                self.assertEqual(observed_owner_active, 4)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["completed"], 4)
                self.assertEqual(image_job_runner.get_image_job_runner_stats()["active"], 0)
            finally:
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY = original_limit
                image_job_runner.IMAGE_JOB_MAX_CONCURRENCY_PER_USER = original_per_user_limit
                image_job_runner.IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = original_per_key_limit
                image_job_runner._IMAGE_JOB_SEMAPHORE = original_semaphore
                image_job_runner._OWNER_SEMAPHORES = original_owner_semaphores
                image_job_runner._RESOURCE_SEMAPHORES = original_resource_semaphores
                _clear_runner_counters()

        asyncio.run(scenario())
