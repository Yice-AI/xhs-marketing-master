import sys
from pathlib import Path
from datetime import datetime
import json
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from backend.config import settings
from backend.config.paths import get_downloads_dir, get_release_manifest_path, get_static_images_dir, get_uploads_dir
from backend.database.init_db import init_database
from backend.services.model_gateway_diagnostics import build_model_gateway_summary, run_startup_model_gateway_probe_if_enabled
from backend.utils.logger import logger
from backend.utils.errors import AppException
from backend.utils.image_task_store import fail_orphaned_local_image_tasks_after_startup
from backend.api.models import HealthResponse
from backend.api.routes import auth, scraper, visual, image_proxy, interview, external, creative_drafts, product_profile


app = FastAPI(
    title="小红书自动化工具 API",
    description="插件优先的小红书采集、分析、创作与历史记录 API",
    version="2.0.0",
    docs_url="/docs",
    redoc_url="/redoc"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

logger.info("[App] 启动模式: environment=%s auth_required=%s", settings.environment, settings.AUTH_REQUIRED)

app.include_router(auth.router)
app.include_router(scraper.router)
app.include_router(interview.router)
app.include_router(product_profile.router)
app.include_router(visual.router)
app.include_router(external.router)
app.include_router(creative_drafts.router)
app.include_router(image_proxy.router, prefix="/api")

images_dir = get_static_images_dir()
images_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static/images", StaticFiles(directory=str(images_dir)), name="images")
uploads_dir = get_uploads_dir()
uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/static/uploads", StaticFiles(directory=str(uploads_dir)), name="uploads")
downloads_dir = get_downloads_dir()
downloads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/downloads", StaticFiles(directory=str(downloads_dir)), name="downloads")


@app.exception_handler(AppException)
async def app_exception_handler(request: Request, exc: AppException):
    
    logger.error(
        f"[AppException] {exc.error_code} - {exc.message}",
        extra={
            "error_code": exc.error_code,
            "details": exc.details,
            "path": request.url.path
        }
    )
    
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error_code": exc.error_code,
            "message": exc.user_message,
            "details": exc.details
        }
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    import traceback
    error_traceback = traceback.format_exc()
    
    logger.error(
        f"Unhandled exception at {request.url.path}: {exc}",
        extra={
            "path": request.url.path,
            "method": request.method,
            "traceback": error_traceback
        },
        exc_info=True
    )
    
    from backend.utils.errors import ErrorCode
    
    return JSONResponse(
        status_code=500,
        content={
            "error_code": ErrorCode.INTERNAL_ERROR,
            "message": "服务器内部错误,请稍后重试",
            "details": {}
        }
    )


@app.get("/api/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(
        status="healthy",
        timestamp=datetime.now().isoformat(),
        services={
            "backend": "running",
            "static_files": "configured",
            "mode": "authenticated",
            "deployment_mode": settings.environment,
            "product_mode": "plugin_first",
            "model_gateway": build_model_gateway_summary(),
        }
    )


@app.get("/")
async def root():
    return {
        "message": "小红书自动化工具 API",
        "version": "2.0.0",
        "mode": "plugin_first",
        "docs": "/docs"
    }


@app.get("/api/release-manifest")
async def get_release_manifest():
    manifest_path = get_release_manifest_path()
    if not manifest_path.exists():
        return {
            "latestVersion": "0.1.0",
            "minSupportedVersion": "0.1.0",
            "downloadUrl": "/downloads/crx-xhs-marketing-extension-0.1.0.zip",
            "notes": "暂未生成正式插件包，默认回退到主仓扩展包 xhs-marketing-extension 0.1.0。",
            "publishedAt": None,
            "releaseId": None,
            "buildMarker": None,
        }

    with manifest_path.open("r", encoding="utf-8") as file:
        return json.load(file)


@app.get("/health")
async def health_check_root():
    return {"status": "healthy"}


@app.on_event("startup")
async def startup_event():
    init_database()
    interrupted_image_tasks = fail_orphaned_local_image_tasks_after_startup()
    model_gateway_summary = build_model_gateway_summary()
    logger.info("=" * 50)
    logger.info("  小红书自动化工具 - 插件优先模式")
    logger.info("=" * 50)
    logger.info("  ✅ Web 工作台负责采集编排、AI 创作和历史记录")
    logger.info("  ✅ 浏览器扩展负责小红书页面交互、采集与发布执行")
    logger.info("  📌 Web 工作台: %s", settings.app_base_url)
    logger.info("  📌 扩展工程: ./extension")
    logger.info("=" * 50)
    logger.info("🚀 FastAPI 服务启动成功")
    logger.info(f"📁 项目根目录: {project_root}")
    logger.info(f"🖼️  图片目录: {images_dir}")
    logger.info(f"📦 素材目录: {uploads_dir}")
    logger.info(f"🧩 插件目录: {downloads_dir}")
    logger.info(f"🌐 CORS 允许源: {settings.cors_origins}")
    if interrupted_image_tasks:
        logger.warning("⚠️ 已结束 %s 个服务重启前遗留的本地生图任务", interrupted_image_tasks)
    logger.info("[MODEL_GATEWAY] summary=%s", model_gateway_summary)
    run_startup_model_gateway_probe_if_enabled()


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("👋 FastAPI 服务关闭")


if __name__ == "__main__":
    import uvicorn
    
    logger.info("=" * 60)
    logger.info("🚀 启动小红书自动化工具 API 服务")
    logger.info("=" * 60)
    
    uvicorn.run(
        app,
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level.lower()
    )
