import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, Callable

from backend.config import settings

logger = logging.getLogger(__name__)

TEXT_JOB_MAX_WORKERS = max(1, int(getattr(settings, "TEXT_JOB_MAX_WORKERS", 8)))
TEXT_JOB_MAX_CONCURRENCY = max(1, int(getattr(settings, "TEXT_JOB_MAX_CONCURRENCY", 6)))
STRATEGY_TEXT_JOB_MAX_WORKERS = max(1, int(getattr(settings, "STRATEGY_TEXT_JOB_MAX_WORKERS", 3)))
STRATEGY_TEXT_JOB_MAX_CONCURRENCY = max(1, int(getattr(settings, "STRATEGY_TEXT_JOB_MAX_CONCURRENCY", 2)))
REVISION_TEXT_JOB_MAX_WORKERS = max(1, int(getattr(settings, "REVISION_TEXT_JOB_MAX_WORKERS", 3)))
REVISION_TEXT_JOB_MAX_CONCURRENCY = max(1, int(getattr(settings, "REVISION_TEXT_JOB_MAX_CONCURRENCY", 2)))
RESEARCH_TEXT_JOB_MAX_WORKERS = max(1, int(getattr(settings, "RESEARCH_TEXT_JOB_MAX_WORKERS", 3)))
RESEARCH_TEXT_JOB_MAX_CONCURRENCY = max(1, int(getattr(settings, "RESEARCH_TEXT_JOB_MAX_CONCURRENCY", 2)))


class TextJobRunner:
    def __init__(self, *, name: str, thread_name_prefix: str, max_workers: int, concurrency_limit: int):
        self.name = name
        self.max_workers = max_workers
        self.concurrency_limit = concurrency_limit
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix=thread_name_prefix)
        self.semaphore = asyncio.Semaphore(concurrency_limit)
        self.active = 0
        self.waiting = 0
        self.completed = 0
        self.failed = 0
        self.timed_out = 0
        self.finished_after_timeout = 0

    def stats(self) -> dict[str, int]:
        return {
            "workers": self.max_workers,
            "concurrency_limit": self.concurrency_limit,
            "active": self.active,
            "waiting": self.waiting,
            "completed": self.completed,
            "failed": self.failed,
            "timed_out": self.timed_out,
            "finished_after_timeout": self.finished_after_timeout,
            "available_slots": max(0, self.concurrency_limit - self.active),
        }

    async def run(self, func: Callable[..., Any], *args: Any, timeout_seconds: float, **kwargs: Any) -> Any:
        loop = asyncio.get_running_loop()
        call = partial(func, *args, **kwargs)
        queued_at = time.monotonic()
        self.waiting += 1
        try:
            await self.semaphore.acquire()
        except Exception:
            self.waiting = max(0, self.waiting - 1)
            raise

        self.waiting = max(0, self.waiting - 1)
        self.active += 1
        queue_wait_seconds = time.monotonic() - queued_at
        logger.info(
            "[%s] start active=%s waiting=%s concurrency_limit=%s workers=%s timeout=%s queue_wait=%.3fs",
            self.name,
            self.active,
            self.waiting,
            self.concurrency_limit,
            self.max_workers,
            timeout_seconds,
            queue_wait_seconds,
        )

        started_at = time.monotonic()
        future = loop.run_in_executor(self.executor, call)
        released = False
        timed_out = False

        def release_slot(done_future: asyncio.Future) -> None:
            nonlocal released
            if released:
                return
            released = True
            runtime_seconds = time.monotonic() - started_at
            self.active = max(0, self.active - 1)
            try:
                failed = done_future.cancelled() or done_future.exception() is not None
            except asyncio.CancelledError:
                failed = True
            if timed_out:
                self.finished_after_timeout += 1
                outcome = "finished_after_timeout"
            elif failed:
                self.failed += 1
                outcome = "failed"
            else:
                self.completed += 1
                outcome = "completed"
            self.semaphore.release()
            logger.info(
                "[%s] finish outcome=%s active=%s waiting=%s concurrency_limit=%s workers=%s runtime=%.3fs",
                self.name,
                outcome,
                self.active,
                self.waiting,
                self.concurrency_limit,
                self.max_workers,
                runtime_seconds,
            )

        future.add_done_callback(release_slot)
        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout_seconds)
        except asyncio.TimeoutError:
            timed_out = True
            self.timed_out += 1
            logger.warning(
                "[%s] timeout active=%s waiting=%s concurrency_limit=%s workers=%s timeout=%s",
                self.name,
                self.active,
                self.waiting,
                self.concurrency_limit,
                self.max_workers,
                timeout_seconds,
            )
            raise


_TEXT_JOB_RUNNER = TextJobRunner(
    name="TextJobRunner",
    thread_name_prefix="text-job",
    max_workers=TEXT_JOB_MAX_WORKERS,
    concurrency_limit=TEXT_JOB_MAX_CONCURRENCY,
)
_STRATEGY_TEXT_JOB_RUNNER = TextJobRunner(
    name="StrategyTextJobRunner",
    thread_name_prefix="strategy-text-job",
    max_workers=STRATEGY_TEXT_JOB_MAX_WORKERS,
    concurrency_limit=STRATEGY_TEXT_JOB_MAX_CONCURRENCY,
)
_REVISION_TEXT_JOB_RUNNER = TextJobRunner(
    name="RevisionTextJobRunner",
    thread_name_prefix="revision-text-job",
    max_workers=REVISION_TEXT_JOB_MAX_WORKERS,
    concurrency_limit=REVISION_TEXT_JOB_MAX_CONCURRENCY,
)
_RESEARCH_TEXT_JOB_RUNNER = TextJobRunner(
    name="ResearchTextJobRunner",
    thread_name_prefix="research-text-job",
    max_workers=RESEARCH_TEXT_JOB_MAX_WORKERS,
    concurrency_limit=RESEARCH_TEXT_JOB_MAX_CONCURRENCY,
)


def get_text_job_runner_stats() -> dict[str, int]:
    return _TEXT_JOB_RUNNER.stats()


def get_strategy_text_job_runner_stats() -> dict[str, int]:
    return _STRATEGY_TEXT_JOB_RUNNER.stats()


def get_revision_text_job_runner_stats() -> dict[str, int]:
    return _REVISION_TEXT_JOB_RUNNER.stats()


def get_research_text_job_runner_stats() -> dict[str, int]:
    return _RESEARCH_TEXT_JOB_RUNNER.stats()


async def run_text_job(func: Callable[..., Any], *args: Any, timeout_seconds: float, **kwargs: Any) -> Any:
    return await _TEXT_JOB_RUNNER.run(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def run_strategy_text_job(func: Callable[..., Any], *args: Any, timeout_seconds: float, **kwargs: Any) -> Any:
    return await _STRATEGY_TEXT_JOB_RUNNER.run(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def run_revision_text_job(func: Callable[..., Any], *args: Any, timeout_seconds: float, **kwargs: Any) -> Any:
    return await _REVISION_TEXT_JOB_RUNNER.run(func, *args, timeout_seconds=timeout_seconds, **kwargs)


async def run_research_text_job(func: Callable[..., Any], *args: Any, timeout_seconds: float, **kwargs: Any) -> Any:
    return await _RESEARCH_TEXT_JOB_RUNNER.run(func, *args, timeout_seconds=timeout_seconds, **kwargs)
