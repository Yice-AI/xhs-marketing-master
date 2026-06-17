export type ViewState = 'HOME' | 'SCRAPER' | 'INTERVIEW' | 'CREATION' | 'STUDIO' | 'ANALYTICS';

export interface ExtensionReleaseManifest {
  latestVersion: string;
  minSupportedVersion: string;
  downloadUrl: string;
  notes?: string | null;
  publishedAt?: string | null;
  releaseId?: string | null;
  buildMarker?: string | null;
}

export type CreationMode = 'scraper' | 'interview';
export type RewriteMode = '轻仿写' | '结构仿写' | '深改原创';
export type ImageMode = '动态表达' | '风格表达' | '物料融合' | '概念表达' | '模板拼装';
export type TemplateKind = 'feature_hero' | 'step_guide' | 'benefit_grid' | 'before_after' | 'faq_card';
export type TemplateStyleVariant =
  | 'freeform_stage'
  | 'text_cover_bold'
  | 'hero_visual_cover'
  | 'highlight_screenshot_grid'
  | 'annotated_highlight_grid'
  | 'step_text_image'
  | 'step_focus_screenshot';
export type TemplateFrameStyle =
  | 'soft_gradient_card'
  | 'sunset_glow_card'
  | 'editorial_outline_card'
  | 'notebook_tape_card'
  | 'split_banner_card';
export type SearchSortBy = '综合' | '最新' | '最多点赞' | '最多评论' | '最多收藏';
export type SearchNoteType = '不限' | '视频' | '图文';
export type SearchPublishTime = '不限' | '一天内' | '一周内' | '半年内';
export type SearchScope = '不限' | '已看过' | '未看过' | '已关注';
export type SearchLocation = '不限' | '同城' | '附近';
export type ScrapeCollectionMode = 'keyword' | 'url';
export type UrlCollectionErrorCode =
  | 'invalid_url'
  | 'unsupported_url'
  | 'token_expired_or_blocked'
  | 'fetch_failed'
  | 'parse_failed';

export interface SearchFilters {
  sortBy: SearchSortBy;
  noteType: SearchNoteType;
  publishTime: SearchPublishTime;
  searchScope: SearchScope;
  location: SearchLocation;
}

export interface ScrapedComment {
  id?: string;
  userName?: string;
  avatar?: string;
  content: string;
  likeCount?: string;
  replyCount?: string;
  time?: number;
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  sortBy: '综合',
  noteType: '不限',
  publishTime: '不限',
  searchScope: '不限',
  location: '不限',
};

export interface ScrapedNote {
  id: string;
  title: string;
  desc?: string;
  author: string;
  authorAvatar: string;
  likes: string;
  stars: string;
  views: string;
  shares?: string;
  imageUrl: string;
  imageList?: string[];
  stableImageUrl?: string;
  stableImageList?: string[];
  tags?: string[];
  ipLocation?: string;
  time?: number;
  publishedAtLabel?: string;
  noteUrl?: string;
  resolvedImageUrl?: string;
  resolvedImageList?: string[];
  commentCount?: string;
  comments?: ScrapedComment[];
}

export interface UrlCollectionRequest {
  url: string;
  enable_comments?: boolean;
}

export interface UrlCollectionResponse {
  note: ScrapedNote;
  collection_mode: ScrapeCollectionMode;
  source_input: string;
}

export interface ProductBrief {
  product_name: string;
  target_audience: string;
  product_features: string;
  brand_tone?: string;
  must_include?: string;
  banned_terms?: string;
  reference_urls?: string[];
}

export interface ResearchSourceDocument {
  url: string;
  title: string;
  summary: string;
  contentSnippet?: string;
  status?: 'fetched' | 'failed' | string;
}

export interface ProductBriefStatus {
  updatedAt: string | null;
  analysisSignature: string | null;
  isDirty: boolean;
}

export interface ProductProfile {
  id: number;
  user_id: string;
  product_brief: ProductBrief;
  research_context?: ResearchContext | null;
  source_signature?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ResearchContext {
  product_name: string;
  summary: string;
  target_audience_insights: string[];
  core_features: string[];
  use_cases: string[];
  differentiators: string[];
  faq_hints: string[];
  material_signals: string[];
  research_notes: string[];
  source_documents?: ResearchSourceDocument[];
}

export type ProductUsageMode = 'product_main' | 'product_assist' | 'no_product' | string;

export interface BenchmarkFitDiagnosis {
  fit_level?: string;
  product_usage_mode?: ProductUsageMode;
  confidence?: number;
  core_viral_driver?: string;
  product_fit_reason?: string;
  risk_if_product_inserted?: string;
  allowed_product_usage?: string;
  forbidden_moves?: string[];
  transferable_assets?: string[];
}

export interface NoteStrategy {
  id: string;
  label: string;
  summary: string;
  targetAudience: string;
  corePainPoints: string[];
  coreBenefits: string[];
  contentAngle: string;
  noteGoal: string;
  visualDirection: string;
  recommendedCardPlan: string[];
  suggestedTitle?: string;
  benchmarkFit?: BenchmarkFitDiagnosis;
  productUsageMode?: ProductUsageMode;
}

export interface BenchmarkNote extends ScrapedNote {
  content_category: string;
  category_scores?: Record<string, number>;
  secondary_categories?: string[];
  commercial_fit_score: number;
  rewrite_value_score: number;
  recommendation_tier: '强推荐' | '可参考' | '仅做灵感';
  recommendation_reason: string;
  material_dependency: '纯概念' | '需物料图' | '需场景图' | '需真人感素材' | string;
}

export interface CategorySummary {
  note_count: number;
  strong_recommend_count: number;
  avg_rewrite_value_score: number;
  benchmark_sufficiency: '充足' | '偏弱' | '不足' | string;
  sufficiency_reason: string;
}

export interface CollectionFollowupTask {
  category: string;
  reason: string;
  keywords: string[];
  keyword_text: string;
  filters: SearchFilters;
  max_notes_count: number;
  enable_comments: boolean;
  max_comments_per_note?: number;
}

export interface QualityReport {
  formula_density?: number;
  emotion_word_overload?: number;
  sentence_rhythm_risk?: number;
  comment_voice_gap?: number;
  summary?: string;
  repetition_risk?: number;
  publish_readiness?: string;
}

export interface RewriteSession {
  benchmark_note?: BenchmarkNote;
  product_info: ProductBrief;
  rewrite_mode: RewriteMode | string;
  selected_title?: string;
  title_candidates: string[];
  opening_candidates: string[];
  content_outline: string[];
  body_draft: string;
  minimal_polish_body?: string;
  deep_polish_body?: string;
  polished_body: string;
  final_body?: string;
  final_body_source?: 'deep_polish' | 'minimal_polish' | 'draft' | string;
  polished_body_fallback_used?: boolean;
  polish_guardrail_reason?: string;
  guardrail_stage?: 'minimal_polish' | 'deep_polish' | 'draft' | string;
  guardrail_repairs_applied?: string[];
  replacement_phrases: string[];
  tags: string[];
  rationale?: string;
  de_ai_report: QualityReport;
  revision_notes?: string[];
  high_risk_ai_sentences: string[];
  estimated_engagement?: string;
  candidate_judge_enabled?: boolean;
  candidate_judge_fallback_reason?: string;
  candidate_judge_quality_flags?: string[];
}

export interface NoteVisualPlanCard {
  card_type: string;
  template_kind: TemplateKind | string;
  title: string;
  summary: string;
  visual_focus?: string;
}

export interface NoteVisualPlan {
  cover_claim: string;
  intro_hook: string;
  card_plan: NoteVisualPlanCard[];
}

export interface ImageStrategy {
  mode: ImageMode;
  selected_style?: string;
  selected_palette?: string;
  visual_goal?: string;
  main_subject?: string;
  scene_description?: string;
  must_keep?: string[];
  must_avoid?: string[];
}

export interface AnalysisResult {
  viralNotesCount: number;
  basicStats: {
    avgLikes: number;
    avgCollects: number;
    avgTitleLength: number;
    emojiUsageRate: number;
    avgComments?: number;
  };
  aiInsights: string;
  benchmarkNotes: BenchmarkNote[];
  groupedBenchmarkNotes: Record<string, BenchmarkNote[]>;
  categorySummary: Record<string, CategorySummary>;
  realPhrases: string[];
  nextCollectionTasks: CollectionFollowupTask[];
  productBrief?: ProductBrief;
}

export interface ScrapeHistoryRecord {
  id: number;
  user_id: string;
  task_id: string;
  keyword: string;
  collection_mode?: ScrapeCollectionMode;
  source_input?: string;
  notes_count: number;
  created_at: string;
  notes_data?: any[];
  analysis_result?: any;
  has_analysis?: boolean;
  filters?: SearchFilters;
  product_brief?: ProductBrief | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  type?: 'text' | 'action' | 'progress' | 'image_edit' | 'text_edit';
  content: string;
  attachments?: {
    id?: string;
    name: string;
    url: string;
    fallbackUrl?: string;
  }[];
  progress?: number;
  taskId?: string;
  timestamp: string;
  isProcessing?: boolean;
  actions?: 'confirm_discard' | 'none';
  isOptimizing?: boolean;
}

export interface VisualAsset {
  id: string;
  url: string;
  status: 'ready' | 'processing';
  label: string;
}

export interface Asset {
  id: string;
  url: string;
  exportReadyUrl?: string;
  isProcessing?: boolean;
  statusText?: string;
  mode?: ImageMode | string;
  promptLabel?: string;
  promptText?: string;
  variantKey?: string;
  layoutFamily?: string;
  visualFocus?: string;
  visualModeResolved?: string;
  editSourceAssetId?: string;
  editPreservationMode?: string;
  referenceAssetIds?: string[];
  sourceType?: 'generated' | 'template_compose';
  templateKind?: TemplateKind | string;
  editablePayload?: TemplateComposeEditablePayload;
  templateDocument?: TemplateComposeDocument;
}

export interface ReferenceAsset {
  id: string;
  user_id?: string;
  file_name: string;
  original_name: string;
  url: string;
  mime_type?: string;
  size?: number;
  width?: number;
  height?: number;
  source?: 'project_library' | 'chat_attachment' | 'scraper_reference' | string;
  display_name?: string;
  note?: string;
  tags?: string[];
  ai_hint?: string;
  created_at: string;
}

export type MaterialAssetRole = 'logo' | 'product_page' | 'feature_screenshot' | 'brand_style' | 'competitor_reference' | 'supporting';

export interface MaterialFusionPlanItem {
  id: string;
  index: number;
  title: string;
  summary: string;
  contentSummary?: string;
  visualFocus?: string;
  role: string;
  requiredHint: string;
  requiredKeywords?: string[];
  matchReason?: string;
  matchScore?: number;
  selectionSource?: 'auto' | 'manual';
  primaryRequired?: boolean;
  primaryAssetId?: string;
  globalAssetIds: string[];
  status: 'ready' | 'missing';
  missingReason?: string;
}

export interface MaterialFusionDraft {
  title: string;
  content: string;
  style: string;
  prompts: any[];
  designPlan?: Record<string, any> | null;
  promptStats?: Record<string, any> | null;
  noteVisualPlan?: NoteVisualPlan | null;
  planItems: MaterialFusionPlanItem[];
  referenceAssetIds: string[];
  primaryReferenceAssetId?: string;
  createdAt: string;
}

export interface TemplateScreenshot {
  assetId?: string;
  url: string;
  label?: string;
  width?: number;
  height?: number;
  crop?: {
    x: number;
    y: number;
    zoom: number;
    fitMode?: 'cover' | 'contain';
  };
}

export interface TemplateComposeEditablePayload {
  version: number;
  canvas: {
    width: number;
    height: number;
  };
  templateKind: TemplateKind | string;
  styleVariant?: TemplateStyleVariant | string;
  frameStyle?: TemplateFrameStyle | string;
  brandStyle?: string;
  themeKey: string;
  density: 'comfortable' | 'balanced' | 'compact' | string;
  badgeText?: string;
  canvasLabel?: string;
  showCanvasLabel?: boolean;
  title: string;
  subtitle: string;
  ctaText: string;
  footerNote?: string;
  bodyText?: string;
  bullets: string[];
  features: Array<{ title: string; description: string }>;
  steps: Array<{ title: string; description: string }>;
  faqItems: Array<{ title: string; description: string }>;
  screenshots: TemplateScreenshot[];
  noteVisualPlan?: NoteVisualPlan;
  styleSlots?: Record<string, string>;
}

export interface TemplateModuleLayout {
  offsetX?: number;
  offsetY?: number;
  fitMode?: 'cover' | 'contain';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface TemplateComposeModule {
  id: string;
  type:
    | 'badge_block'
    | 'canvas_meta'
    | 'title_block'
    | 'subtitle_block'
    | 'bullet_group'
    | 'feature_grid'
    | 'step_group'
    | 'comparison_group'
    | 'body_text_block'
    | 'cta_badge'
    | 'footer_note'
    | 'screenshot_frame';
  visible: boolean;
  order: number;
  content?: any;
  layout?: TemplateModuleLayout & Record<string, any>;
  style?: Record<string, any>;
}

export interface TemplateComposeDocument {
  id: string;
  canvas: {
    width: number;
    height: number;
  };
  templateKind: TemplateKind | string;
  styleVariant?: TemplateStyleVariant | string;
  frameStyle?: TemplateFrameStyle | string;
  theme: string;
  density: 'comfortable' | 'balanced' | 'compact' | string;
  modules: TemplateComposeModule[];
  assets: TemplateScreenshot[];
  noteVisualPlan?: NoteVisualPlan;
  renderVersion: number;
  meta?: {
    title?: string;
    subtitle?: string;
    ctaText?: string;
    footerNote?: string;
    bodyText?: string;
    brandStyle?: string;
    styleSlots?: Record<string, string>;
  };
}

export type TemplateDraftStatus = 'draft' | 'applied';
export type CreativeDraftStatus = 'latest_auto' | 'manual_saved' | 'archived';
export type CreativeDraftSaveMode = 'autosave' | 'manual';
export type CreativeDraftWorkspace = 'CREATION' | 'STUDIO';

export interface TemplateComposeResult {
  canvas: {
    width: number;
    height: number;
  };
  template_kind: TemplateKind | string;
  recommended_template_kinds?: Array<TemplateKind | string>;
  slots: Array<Record<string, any>>;
  rendered_image_url: string;
  editable_payload: TemplateComposeEditablePayload;
  document?: TemplateComposeDocument;
  note_visual_plan?: NoteVisualPlan;
}

export interface TemplateComposeCard {
  cardId: string;
  cardType: string;
  templateKind: TemplateKind | string;
  title: string;
  summary: string;
  document: TemplateComposeDocument;
  composeResult?: TemplateComposeResult;
  renderedAsset: Asset;
  status: 'draft' | 'applied' | 'rendering';
  sourceRefs?: string[];
}

export interface VisualProject {
  projectId: string;
  title: string;
  body: string;
  noteVisualPlan?: NoteVisualPlan | null;
  cards: TemplateComposeCard[];
  coverCardId: string;
  activeCardId: string;
  templatePackKey?: string;
  brandStyle?: string;
  status?: 'draft' | 'applied';
}

export interface TemplateComposeSeriesResult {
  project: VisualProject;
  cards: TemplateComposeCard[];
  note_visual_plan?: NoteVisualPlan;
  template_pack_key?: string;
}

export interface ContentData {
  title: string;
  body: string;
  mainImageUrl: string;
  authorName: string;
  authorAvatar: string;
  likes: string;
  stars: string;
  comments: string;
  tags?: string[];
}

export interface CreationState {
  productName: string;
  targetAudience: string;
  productFeatures: string;
  contentStyle: string;
  visualStyle: string;
  strategyMode: 'benchmark_first' | 'research_first';
  isGenerating: boolean;
  generationStep: number;
  generationProgress: number;
  generationMessage: string;
  prompts: any[];
  promptCount: number;
  localGeneratedContent: GeneratedContent | null;
  generatedTags: string[];
  finalAssets?: Asset[];
  taskIds?: string[];
  draftSessionKey: string;
}

export interface StudioDraftState {
  title: string;
  body: string;
  mainImageUrl: string;
  activeAssetId: string;
  activeAssetIndex: number;
  updatedAt: string;
}

export type NoteEditScope = 'title' | 'opening' | 'outline' | 'body' | 'closing' | 'full_note';

export interface NoteRevisionResult {
  detected_scope: NoteEditScope;
  reasoning_summary: string;
  updated_fields: Partial<{
    title: string;
    opening: string;
    outline: string[];
    body: string;
    closing: string;
  }>;
  updated_rewrite_session: RewriteSession;
  note_visual_plan?: NoteVisualPlan | null;
}

export interface PendingNoteConfirmation {
  title: string;
  opening: string;
  outline: string[];
  body: string;
  closing: string;
  titleCandidates: string[];
  openingCandidates: string[];
  finalBodySource: string;
  noteVisualPlan?: NoteVisualPlan | null;
  lastCustomInstruction?: string;
  lastDetectedScope?: NoteEditScope | null;
  lastReasoningSummary?: string;
  lastRevisionResult?: NoteRevisionResult | null;
  previousSnapshot?: {
    title: string;
    opening: string;
    outline: string[];
    body: string;
    closing: string;
  } | null;
  confirmedForImageGeneration?: boolean;
  updatedAt: string;
}

export interface NoteRevisionRequest {
  title: string;
  opening: string;
  outline: string[];
  body: string;
  closing?: string;
  instruction: string;
  selected_scope?: NoteEditScope | null;
  rewrite_session?: RewriteSession | null;
  product_brief?: ProductBrief | null;
  benchmark_note?: BenchmarkNote | null;
  note_strategy?: NoteStrategy | null;
}

export interface NoteRevisionResponse {
  success: boolean;
  message: string;
  data: NoteRevisionResult;
}

export interface CreationEditorState {
  rewriteMode: RewriteMode;
  imageMode: ImageMode;
  visualStyle: string;
  templatePageCount: number;
  templateCopyStyle: string;
  templateKind: TemplateKind;
  templateFrameStyle: TemplateFrameStyle;
  salesIntensity: number;
  colloquialLevel: number;
  authenticityLevel: number;
  materialSummary: string;
  referenceSummary: string;
  selectedAssetIds: string[];
  primaryReferenceAssetId: string;
  researchContext: ResearchContext | null;
  strategyOptions: NoteStrategy[];
  selectedStrategyId: string;
}

export interface GeneratedNoteRecord {
  title: string;
  content: string;
  finalBody?: string;
  style: string;
  imageMode?: ImageMode | string;
  imageModeLabel?: string;
  visualModeResolved?: string;
  primaryReferenceAssetId?: string;
  editPreservationMode?: string;
  referenceAssetIds?: string[];
  assets: Asset[];
  taskIds: string[];
  prompts: any[];
  tags?: string[];
  benchmarkNote?: BenchmarkNote | null;
  rewriteSession?: RewriteSession | null;
  productBrief?: ProductBrief | null;
  researchContext?: ResearchContext | null;
  strategy?: NoteStrategy | null;
  strategyOptions?: NoteStrategy[];
  noteVisualPlan?: NoteVisualPlan | null;
  templateComposeResult?: TemplateComposeResult | null;
  templateComposeDraft?: TemplateComposeDocument | null;
  templateDraftStatus?: TemplateDraftStatus | null;
  visualProject?: VisualProject | null;
  studioDraftState?: StudioDraftState | null;
  pendingConfirmation?: PendingNoteConfirmation | null;
}

export interface InterviewData {
  productName: string;
  coreFeatures: string;
  targetAudience: string;
  styleDirection: string;
}

export interface GeneratedContent {
  title: string;
  content: string;
  rewriteSession?: RewriteSession | null;
  noteStrategy?: NoteStrategy | null;
  tags?: string[];
}

export interface CreativeDraftSnapshot {
  workspace: CreativeDraftWorkspace;
  session_key: string;
  creationState: CreationState;
  creationEditorState: CreationEditorState;
  generatedNote: GeneratedNoteRecord | null;
  rewriteSession: RewriteSession | null;
  selectedBenchmarkNote: BenchmarkNote | null;
  referenceAssets: ReferenceAsset[];
  latestProductBrief: ProductBrief | null;
  studioContentState: StudioDraftState | null;
}

export interface CreativeDraftPreviewPayload {
  content_mode_label: string;
  has_studio_edit: boolean;
  body_preview: string;
  cover_image_url?: string;
}

export interface CreativeDraftSummary {
  draft_id: string;
  title: string;
  status: CreativeDraftStatus;
  source_context?: string | null;
  session_key?: string | null;
  snapshot_version: number;
  preview_payload: CreativeDraftPreviewPayload;
  created_at: string | null;
  updated_at: string | null;
  last_opened_at?: string | null;
}

export interface CreativeDraftDetail extends CreativeDraftSummary {
  content_payload: CreativeDraftSnapshot;
}

export interface InterviewStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'completed';
}

export interface CollectedInfo {
  product_name?: string;
  product_type?: string;
  core_features?: string;
  target_audience?: string;
  style_preference?: string;
  [key: string]: string | undefined;
}

export interface InterviewMessage {
  type: 'text' | 'single_choice' | 'multiple_choice';
  content: string;
  reason?: string;
  options?: string[];
}

export interface TitleOption {
  id: number;
  title: string;
  style: string;
  rationale: string;
}

export interface InterviewResponse {
  action: 'ask' | 'show_titles' | 'complete';
  message: InterviewMessage;
  steps?: InterviewStep[];
  progress?: number;
  collected_info?: CollectedInfo;
  title_options?: TitleOption[];
  result?: {
    title?: string;
    content: string;
    collected_info: CollectedInfo;
    rewrite_session?: RewriteSession;
    note_strategy?: NoteStrategy;
    tags?: string[];
  };
}
