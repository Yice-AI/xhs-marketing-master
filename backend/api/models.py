from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, List, Any, Dict, Literal


class HealthResponse(BaseModel):
    status: str
    timestamp: str
    services: Dict[str, Any]


class SearchFilters(BaseModel):
    sortBy: str = "综合"
    noteType: str = "不限"
    publishTime: str = "不限"
    searchScope: str = "不限"
    location: str = "不限"


class CollectRequest(BaseModel):
    keywords: str
    max_notes: int = 10
    sort_type: str = "general"
    filters: Optional[SearchFilters] = None


class CollectResponse(BaseModel):
    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None


class AnalyzeRequest(BaseModel):
    note_content: List[Dict[str, Any]]


class AnalyzeResponse(BaseModel):
    success: bool
    prompts: List[Dict[str, Any]]


class GenerateImageRequest(BaseModel):
    prompt: str
    count: int = 1
    aspect_ratio: str = "1:1"
    image_size: str = "1K"


class GenerateImageResponse(BaseModel):
    success: bool
    message: str
    task_id: str
    data: Optional[Dict[str, Any]] = None


class TaskStatusResponse(BaseModel):
    status: str
    progress: int = 0
    message: Optional[str] = None
    data: Optional[Any] = None
    error: Optional[str] = None


class EditImageRequest(BaseModel):
    image_id: str
    prompt: str
    aspect_ratio: str = "3:4"
    image_size: str = "1K"
    reference_asset_ids: List[str] = Field(default_factory=list)
    upload_reference_asset_ids: List[str] = Field(default_factory=list)
    material_fusion_serial_mode: bool = False
    reference_metadata_only: bool = False
    edit_purpose: Optional[str] = None
    candidate_seed: Optional[str] = None
    candidate_offset: Optional[int] = None
    trace_metadata: Dict[str, Any] = Field(default_factory=dict)


class EditImageResponse(BaseModel):
    success: bool
    message: str
    task_id: str
    data: Optional[Dict[str, Any]] = None


class PolishContentRequest(BaseModel):
    text: str
    instruction: str
    type: str = "body"  # title, body, all


class PolishContentResponse(BaseModel):
    success: bool
    message: str
    polished_text: str


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)
    email: Optional[EmailStr] = None

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("用户名不能为空")
        return normalized


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("username")
    @classmethod
    def normalize_username(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("用户名不能为空")
        return normalized


class AuthUserResponse(BaseModel):
    user_id: str
    username: str
    email: Optional[str] = None
    is_active: bool = True


class AuthTokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: AuthUserResponse


class ReleaseManifestResponse(BaseModel):
    latestVersion: str
    minSupportedVersion: str
    downloadUrl: str
    notes: Optional[str] = None
    publishedAt: Optional[str] = None
    releaseId: Optional[str] = None
    buildMarker: Optional[str] = None


NoteStrategyStyle = Literal["benefit", "tutorial", "review", "general", "auto"]
DiversityLevel = Literal["low", "medium", "high"]


class CreateNoteJobRequest(BaseModel):
    product_name: str
    target_audience: str
    product_features: str
    product_urls: List[str] = Field(default_factory=list)
    logo_reference_urls: List[str] = Field(default_factory=list, max_length=4)
    external_user_id: Optional[str] = Field(default=None, max_length=128)
    brand_tone: Optional[str] = None
    must_include: Optional[str] = None
    banned_terms: Optional[str] = None
    content_style: Optional[str] = None
    strategy_mode: Literal["benchmark_first", "research_first"] = "research_first"
    note_strategy_style: NoteStrategyStyle = "auto"
    image_mode: str = "概念表达"
    image_count: int = Field(default=3, ge=1, le=6)
    visual_style: Optional[str] = None
    template_kind: Optional[str] = None
    template_frame_style: Optional[str] = None
    variation_seed: Optional[str] = None
    diversity_level: DiversityLevel = "medium"
    style_perturbation_enabled: bool = True


class CreateNoteJobResponse(BaseModel):
    success: bool
    message: str
    batch_id: str
    text_task_id: str
    image_task_id: str
    status: str = "pending"


class TextJobStatusResponse(BaseModel):
    text_task_id: str
    status: str
    progress: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    result: Optional[Dict[str, Any]] = None


class ImageArtifactItem(BaseModel):
    index: int
    file_name: str
    download_url: str
    mime_type: str = "image/png"


class ExternalImageItemStatus(BaseModel):
    index: int
    task_id: Optional[str] = None
    status: str
    progress: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    stage: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    runtime_seconds: Optional[int] = None
    prompt_length: Optional[int] = None
    image_queue_wait_seconds: Optional[float] = None
    retry_count: Optional[int] = None
    external_retry_attempt: Optional[int] = None
    source_task_id: Optional[str] = None
    model: Optional[str] = None


class ImageJobStatusResponse(BaseModel):
    image_task_id: str
    status: str
    progress: int = 0
    message: Optional[str] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    images: List[ImageArtifactItem] = Field(default_factory=list)
    image_count: int = 0
    expected_image_count: Optional[int] = None
    ready_image_count: Optional[int] = None
    image_items: List[ExternalImageItemStatus] = Field(default_factory=list)
    requested_image_mode: Optional[str] = None
    visual_mode_resolved: Optional[str] = None
    artifact_expires_at: Optional[str] = None
    downloaded_acknowledged: bool = False
    deleted_at: Optional[str] = None
    logo_quality_checks: List[Dict[str, Any]] = Field(default_factory=list)
    logo_fix_summary: Optional[Dict[str, Any]] = None


class ImageAckRequest(BaseModel):
    downloaded_files: List[int] = Field(default_factory=list)
    receiver: Optional[str] = None
    received_at: Optional[str] = None


class LogoFixJobRequest(BaseModel):
    image_urls: List[str] = Field(min_length=1, max_length=6)
    logo_reference_urls: List[str] = Field(min_length=1, max_length=4)
    product_name: str = "品牌"
    external_user_id: Optional[str] = Field(default=None, max_length=128)
    prompt: str = "把图里的品牌 logo 换成参考图里的 logo。其他内容保持不变。"


class LogoFixJobResponse(BaseModel):
    success: bool
    message: str
    image_task_id: str
    status: str = "pending"
