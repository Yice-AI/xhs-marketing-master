import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from backend.api.models import (
    CreateNoteJobRequest,
    CreateNoteJobResponse,
    ImageAckRequest,
    ImageJobStatusResponse,
    LogoFixJobRequest,
    LogoFixJobResponse,
    TextJobStatusResponse,
)
from backend.middleware.external_api import get_external_api_client_id
from backend.services.external_note_jobs import (
    acknowledge_external_image_job,
    can_accept_external_note_job,
    create_external_logo_fix_job,
    create_external_note_batch,
    get_external_note_job_runner_stats,
    get_external_image_job_file,
    get_external_image_job_status,
    get_external_text_job_status,
    run_external_logo_fix_job,
    run_external_note_batch,
)


router = APIRouter(prefix="/api/external", tags=["external"])


@router.post("/note-jobs", response_model=CreateNoteJobResponse)
async def create_note_job(
    request: CreateNoteJobRequest,
    client_id: str = Depends(get_external_api_client_id),
):
    accepted, reject_reason = can_accept_external_note_job(client_id)
    if not accepted:
        raise HTTPException(status_code=429, detail=reject_reason)

    batch = create_external_note_batch(request, client_id)
    asyncio.create_task(
        run_external_note_batch(
            batch["batch_id"],
            batch["text_task_id"],
            batch["image_task_id"],
            request,
            client_id,
        )
    )
    return CreateNoteJobResponse(
        success=True,
        message="笔记双任务批次已创建",
        batch_id=batch["batch_id"],
        text_task_id=batch["text_task_id"],
        image_task_id=batch["image_task_id"],
        status="pending",
    )


@router.post("/logo-fix-jobs", response_model=LogoFixJobResponse)
async def create_logo_fix_job(
    request: LogoFixJobRequest,
    client_id: str = Depends(get_external_api_client_id),
):
    job = create_external_logo_fix_job(request, client_id)
    asyncio.create_task(
        run_external_logo_fix_job(
            job["image_task_id"],
            request,
            client_id,
        )
    )
    return LogoFixJobResponse(
        success=True,
        message="Logo 批量修图任务已创建",
        image_task_id=job["image_task_id"],
        status="pending",
    )


@router.get("/note-runner/status")
async def get_note_runner_status(
    _client_id: str = Depends(get_external_api_client_id),
):
    return get_external_note_job_runner_stats()


@router.get("/text-jobs/{text_task_id}", response_model=TextJobStatusResponse)
async def get_text_job_status(
    text_task_id: str,
    client_id: str = Depends(get_external_api_client_id),
):
    task = get_external_text_job_status(text_task_id, client_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return TextJobStatusResponse(
        text_task_id=task["task_id"],
        status=task["status"],
        progress=task.get("progress") or 0,
        message=task.get("message"),
        error=task.get("error"),
        created_at=task.get("created_at"),
        started_at=task.get("started_at"),
        completed_at=task.get("completed_at"),
        result=task.get("result"),
    )


@router.get("/image-jobs/{image_task_id}", response_model=ImageJobStatusResponse)
async def get_image_job_status(
    image_task_id: str,
    client_id: str = Depends(get_external_api_client_id),
):
    task = get_external_image_job_status(image_task_id, client_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    result = task.get("result") or {}
    return ImageJobStatusResponse(
        image_task_id=task["task_id"],
        status=(result.get("status") if isinstance(result, dict) else None) or task["status"],
        progress=task.get("progress") or 0,
        message=task.get("message"),
        error=task.get("error"),
        created_at=task.get("created_at"),
        started_at=task.get("started_at"),
        completed_at=task.get("completed_at"),
        images=(result.get("images") if isinstance(result, dict) else []) or [],
        image_count=(result.get("image_count") if isinstance(result, dict) else 0) or 0,
        expected_image_count=(result.get("expected_image_count") if isinstance(result, dict) else None),
        ready_image_count=(result.get("ready_image_count") if isinstance(result, dict) else None),
        image_items=(result.get("image_items") if isinstance(result, dict) else []) or [],
        requested_image_mode=(result.get("requested_image_mode") if isinstance(result, dict) else None),
        visual_mode_resolved=(result.get("visual_mode_resolved") if isinstance(result, dict) else None),
        artifact_expires_at=(result.get("artifact_expires_at") if isinstance(result, dict) else None),
        downloaded_acknowledged=(result.get("downloaded_acknowledged") if isinstance(result, dict) else False) or False,
        deleted_at=(result.get("deleted_at") if isinstance(result, dict) else None),
        logo_quality_checks=(result.get("logo_quality_checks") if isinstance(result, dict) else []) or [],
        logo_fix_summary=(result.get("logo_fix_summary") if isinstance(result, dict) else None),
    )


@router.get("/image-jobs/{image_task_id}/files/{index}")
async def download_image_job_file(
    image_task_id: str,
    index: int,
    client_id: str = Depends(get_external_api_client_id),
):
    image_path = get_external_image_job_file(image_task_id, index, client_id)
    return FileResponse(
        image_path,
        media_type="image/png",
        filename=f"{image_task_id}_{index}.png",
    )


@router.post("/image-jobs/{image_task_id}/ack", response_model=ImageJobStatusResponse)
async def ack_image_job(
    image_task_id: str,
    request: ImageAckRequest,
    client_id: str = Depends(get_external_api_client_id),
):
    task = acknowledge_external_image_job(image_task_id, client_id, request)
    result = task.get("result") or {}
    return ImageJobStatusResponse(
        image_task_id=task["task_id"],
        status=(result.get("status") if isinstance(result, dict) else None) or task["status"],
        progress=task.get("progress") or 0,
        message=task.get("message"),
        error=task.get("error"),
        created_at=task.get("created_at"),
        started_at=task.get("started_at"),
        completed_at=task.get("completed_at"),
        images=(result.get("images") if isinstance(result, dict) else []) or [],
        image_count=(result.get("image_count") if isinstance(result, dict) else 0) or 0,
        expected_image_count=(result.get("expected_image_count") if isinstance(result, dict) else None),
        ready_image_count=(result.get("ready_image_count") if isinstance(result, dict) else None),
        image_items=(result.get("image_items") if isinstance(result, dict) else []) or [],
        requested_image_mode=(result.get("requested_image_mode") if isinstance(result, dict) else None),
        visual_mode_resolved=(result.get("visual_mode_resolved") if isinstance(result, dict) else None),
        artifact_expires_at=(result.get("artifact_expires_at") if isinstance(result, dict) else None),
        downloaded_acknowledged=(result.get("downloaded_acknowledged") if isinstance(result, dict) else False) or False,
        deleted_at=(result.get("deleted_at") if isinstance(result, dict) else None),
        logo_quality_checks=(result.get("logo_quality_checks") if isinstance(result, dict) else []) or [],
        logo_fix_summary=(result.get("logo_fix_summary") if isinstance(result, dict) else None),
    )
