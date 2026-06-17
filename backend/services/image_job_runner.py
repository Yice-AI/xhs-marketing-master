import asyncio
import logging
import time
from contextlib import asynccontextmanager
from collections import defaultdict
from typing import AsyncIterator, Callable, Optional

from backend.config import settings

logger = logging.getLogger(__name__)

IMAGE_JOB_MAX_CONCURRENCY = max(1, int(getattr(settings, "IMAGE_JOB_MAX_CONCURRENCY", 2)))
IMAGE_JOB_MAX_CONCURRENCY_PER_USER = max(1, int(getattr(settings, "IMAGE_JOB_MAX_CONCURRENCY_PER_USER", 1)))
IMAGE_GEN_MAX_CONCURRENCY_PER_KEY = max(1, int(getattr(settings, "IMAGE_GEN_MAX_CONCURRENCY_PER_KEY", 2)))
IMAGE_JOB_POLICY_LIMITS = {
    str(key).strip().lower(): max(1, int(value))
    for key, value in dict(getattr(settings, "IMAGE_JOB_POLICY_LIMITS", {}) or {}).items()
    if str(key).strip()
}

_IMAGE_JOB_SEMAPHORE = asyncio.Semaphore(IMAGE_JOB_MAX_CONCURRENCY)
_OWNER_SEMAPHORES: dict[tuple[str, int], asyncio.Semaphore] = {}
_RESOURCE_SEMAPHORES: dict[str, asyncio.Semaphore] = defaultdict(
    lambda: asyncio.Semaphore(IMAGE_GEN_MAX_CONCURRENCY_PER_KEY)
)
_ACTIVE_IMAGE_JOBS = 0
_WAITING_IMAGE_JOBS = 0
_COMPLETED_IMAGE_JOBS = 0
_FAILED_IMAGE_JOBS = 0
_ACTIVE_IMAGE_JOBS_BY_OWNER: dict[str, int] = {}
_ACTIVE_IMAGE_JOBS_BY_RESOURCE: dict[str, int] = {}
_ACTIVE_IMAGE_JOBS_BY_POLICY: dict[str, int] = {}


class ImageJobCancelled(RuntimeError):
    pass


def _normalize_owner_id(owner_id: Optional[str]) -> str:
    return str(owner_id or "").strip()


def _normalize_resource_id(resource_id: Optional[str]) -> str:
    return str(resource_id or "").strip()


def _normalize_policy_key(policy_key: Optional[str]) -> str:
    return str(policy_key or "").strip().lower()


def resolve_image_job_policy_limit(policy_key: Optional[str], owner_concurrency_limit: Optional[int] = None) -> int:
    if owner_concurrency_limit is None:
        normalized_policy = _normalize_policy_key(policy_key)
        return IMAGE_JOB_POLICY_LIMITS.get(normalized_policy, IMAGE_JOB_MAX_CONCURRENCY_PER_USER)
    return max(1, int(owner_concurrency_limit))


def get_image_job_runner_stats() -> dict[str, int]:
    return {
        "concurrency_limit": IMAGE_JOB_MAX_CONCURRENCY,
        "per_user_concurrency_limit": IMAGE_JOB_MAX_CONCURRENCY_PER_USER,
        "per_key_concurrency_limit": IMAGE_GEN_MAX_CONCURRENCY_PER_KEY,
        "policy_limits": dict(IMAGE_JOB_POLICY_LIMITS),
        "active": _ACTIVE_IMAGE_JOBS,
        "waiting": _WAITING_IMAGE_JOBS,
        "completed": _COMPLETED_IMAGE_JOBS,
        "failed": _FAILED_IMAGE_JOBS,
        "available_slots": max(0, IMAGE_JOB_MAX_CONCURRENCY - _ACTIVE_IMAGE_JOBS),
        "active_owners": len(_ACTIVE_IMAGE_JOBS_BY_OWNER),
        "active_resources": len(_ACTIVE_IMAGE_JOBS_BY_RESOURCE),
        "active_policies": len(_ACTIVE_IMAGE_JOBS_BY_POLICY),
        "active_by_policy": dict(_ACTIVE_IMAGE_JOBS_BY_POLICY),
        "active_by_owner": dict(_ACTIVE_IMAGE_JOBS_BY_OWNER),
        "active_by_resource": dict(_ACTIVE_IMAGE_JOBS_BY_RESOURCE),
    }


@asynccontextmanager
async def image_job_slot(
    task_id: str,
    *,
    job_type: str,
    label: Optional[str] = None,
    owner_id: Optional[str] = None,
    policy_key: Optional[str] = None,
    owner_concurrency_limit: Optional[int] = None,
    resource_id: Optional[str] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> AsyncIterator[float]:
    global _ACTIVE_IMAGE_JOBS, _WAITING_IMAGE_JOBS, _COMPLETED_IMAGE_JOBS, _FAILED_IMAGE_JOBS

    queued_at = time.monotonic()
    normalized_owner_id = _normalize_owner_id(owner_id)
    normalized_resource_id = _normalize_resource_id(resource_id)
    normalized_policy_key = _normalize_policy_key(policy_key)
    owner_limit = resolve_image_job_policy_limit(normalized_policy_key, owner_concurrency_limit)
    owner_semaphore = None
    if normalized_owner_id:
        owner_key = (normalized_owner_id, owner_limit)
        owner_semaphore = _OWNER_SEMAPHORES.get(owner_key)
        if owner_semaphore is None:
            owner_semaphore = asyncio.Semaphore(owner_limit)
            _OWNER_SEMAPHORES[owner_key] = owner_semaphore
    resource_semaphore = _RESOURCE_SEMAPHORES[normalized_resource_id] if normalized_resource_id else None
    _WAITING_IMAGE_JOBS += 1
    global_slot_acquired = False
    owner_slot_acquired = False
    resource_slot_acquired = False

    async def acquire_with_cancel(semaphore: asyncio.Semaphore) -> None:
        while True:
            if should_cancel and should_cancel():
                raise ImageJobCancelled("image job was cancelled before acquiring a runner slot")
            try:
                await asyncio.wait_for(semaphore.acquire(), timeout=0.5)
                return
            except asyncio.TimeoutError:
                continue

    try:
        if owner_semaphore is not None:
            await acquire_with_cancel(owner_semaphore)
            owner_slot_acquired = True
        if resource_semaphore is not None:
            await acquire_with_cancel(resource_semaphore)
            resource_slot_acquired = True
        await acquire_with_cancel(_IMAGE_JOB_SEMAPHORE)
        global_slot_acquired = True
    except Exception:
        _WAITING_IMAGE_JOBS = max(0, _WAITING_IMAGE_JOBS - 1)
        if resource_slot_acquired and resource_semaphore is not None:
            resource_semaphore.release()
        if owner_slot_acquired and owner_semaphore is not None:
            owner_semaphore.release()
        raise

    _WAITING_IMAGE_JOBS = max(0, _WAITING_IMAGE_JOBS - 1)
    _ACTIVE_IMAGE_JOBS += 1
    if normalized_owner_id:
        _ACTIVE_IMAGE_JOBS_BY_OWNER[normalized_owner_id] = _ACTIVE_IMAGE_JOBS_BY_OWNER.get(normalized_owner_id, 0) + 1
    if normalized_resource_id:
        _ACTIVE_IMAGE_JOBS_BY_RESOURCE[normalized_resource_id] = _ACTIVE_IMAGE_JOBS_BY_RESOURCE.get(normalized_resource_id, 0) + 1
    if normalized_policy_key:
        _ACTIVE_IMAGE_JOBS_BY_POLICY[normalized_policy_key] = _ACTIVE_IMAGE_JOBS_BY_POLICY.get(normalized_policy_key, 0) + 1
    queue_wait_seconds = time.monotonic() - queued_at
    started_at = time.monotonic()
    logger.info(
        "[ImageJobRunner] start task_id=%s job_type=%s policy=%s label=%s owner=%s resource=%s active=%s waiting=%s concurrency_limit=%s per_user_limit=%s per_key_limit=%s queue_wait=%.3fs",
        task_id,
        job_type,
        normalized_policy_key or "",
        label or "",
        normalized_owner_id or "",
        normalized_resource_id or "",
        _ACTIVE_IMAGE_JOBS,
        _WAITING_IMAGE_JOBS,
        IMAGE_JOB_MAX_CONCURRENCY,
        owner_limit,
        IMAGE_GEN_MAX_CONCURRENCY_PER_KEY,
        queue_wait_seconds,
    )

    succeeded = False
    try:
        yield queue_wait_seconds
        succeeded = True
    finally:
        runtime_seconds = time.monotonic() - started_at
        _ACTIVE_IMAGE_JOBS = max(0, _ACTIVE_IMAGE_JOBS - 1)
        if normalized_owner_id:
            next_owner_count = max(0, _ACTIVE_IMAGE_JOBS_BY_OWNER.get(normalized_owner_id, 0) - 1)
            if next_owner_count:
                _ACTIVE_IMAGE_JOBS_BY_OWNER[normalized_owner_id] = next_owner_count
            else:
                _ACTIVE_IMAGE_JOBS_BY_OWNER.pop(normalized_owner_id, None)
        if normalized_resource_id:
            next_resource_count = max(0, _ACTIVE_IMAGE_JOBS_BY_RESOURCE.get(normalized_resource_id, 0) - 1)
            if next_resource_count:
                _ACTIVE_IMAGE_JOBS_BY_RESOURCE[normalized_resource_id] = next_resource_count
            else:
                _ACTIVE_IMAGE_JOBS_BY_RESOURCE.pop(normalized_resource_id, None)
        if normalized_policy_key:
            next_policy_count = max(0, _ACTIVE_IMAGE_JOBS_BY_POLICY.get(normalized_policy_key, 0) - 1)
            if next_policy_count:
                _ACTIVE_IMAGE_JOBS_BY_POLICY[normalized_policy_key] = next_policy_count
            else:
                _ACTIVE_IMAGE_JOBS_BY_POLICY.pop(normalized_policy_key, None)
        if succeeded:
            _COMPLETED_IMAGE_JOBS += 1
            outcome = "completed"
        else:
            _FAILED_IMAGE_JOBS += 1
            outcome = "failed"
        if global_slot_acquired:
            _IMAGE_JOB_SEMAPHORE.release()
        if resource_slot_acquired and resource_semaphore is not None:
            resource_semaphore.release()
        if owner_slot_acquired and owner_semaphore is not None:
            owner_semaphore.release()
        logger.info(
            "[ImageJobRunner] finish outcome=%s task_id=%s job_type=%s policy=%s owner=%s resource=%s active=%s waiting=%s concurrency_limit=%s per_user_limit=%s per_key_limit=%s runtime=%.3fs",
            outcome,
            task_id,
            job_type,
            normalized_policy_key or "",
            normalized_owner_id or "",
            normalized_resource_id or "",
            _ACTIVE_IMAGE_JOBS,
            _WAITING_IMAGE_JOBS,
            IMAGE_JOB_MAX_CONCURRENCY,
            owner_limit,
            IMAGE_GEN_MAX_CONCURRENCY_PER_KEY,
            runtime_seconds,
        )
