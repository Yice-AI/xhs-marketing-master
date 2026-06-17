import axios, { AxiosHeaders, AxiosInstance } from 'axios';
import { BenchmarkNote, CreativeDraftDetail, CreativeDraftSnapshot, CreativeDraftSummary, ImageMode, InterviewResponse, MaterialFusionPlanItem, NoteRevisionRequest, NoteRevisionResponse, NoteStrategy, NoteVisualPlan, ProductBrief, ProductProfile, ReferenceAsset, ResearchContext, RewriteMode, ScrapeCollectionMode, SearchFilters, TemplateComposeResult, TemplateComposeSeriesResult, TemplateKind, UrlCollectionRequest, UrlCollectionResponse } from '../types';
import { AuthUser, clearStoredAuth, getStoredAccessToken } from './authStorage';

const API_BASE_URL = '/api';
const AUTH_REQUEST_TIMEOUT_MS = 15_000;
const HISTORY_REQUEST_TIMEOUT_MS = 15_000;
const INTERVIEW_REQUEST_TIMEOUT_MS = 210_000;
const AUTH_REQUIRED_EVENT = 'xhs:auth-required';
const DEFAULT_AUTH_REQUIRED_MESSAGE = '请先登录工作台后再继续当前操作。';
const DEFAULT_AUTH_EXPIRED_MESSAGE = '登录态已失效，请重新登录后再继续当前操作。';
const INTERVIEW_AUTH_REQUIRED_MESSAGE = '请先登录工作台后再开始访谈。';
const INTERVIEW_AUTH_EXPIRED_MESSAGE = '登录态已失效，请重新登录后继续访谈。';
const TEXT_TASK_POLL_INTERVAL_MS = 1500;
const TEXT_TASK_TIMEOUT_MS = 10 * 60 * 1000;

type VisualTaskSnapshot<T = any> = {
  task_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  message?: string;
  result?: T;
  error?: string;
  progress?: number;
};

export class AuthRequiredError extends Error {
  readonly code = 'AUTH_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

const isBrowser = () => typeof window !== 'undefined';

const emitAuthRequired = (message: string) => {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, {
    detail: { message },
  }));
};

export const getAuthRequiredEventName = () => AUTH_REQUIRED_EVENT;

export const isAuthRequiredError = (error: unknown): error is AuthRequiredError => error instanceof AuthRequiredError;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type NormalizeAppErrorOptions = {
  timeoutMessage?: string;
  networkErrorMessage?: string;
};

type ValidationDetailItem = {
  type?: unknown;
  loc?: unknown;
  msg?: unknown;
  ctx?: unknown;
};

const FIELD_LABELS: Record<string, string> = {
  username: '用户名',
  password: '密码',
  email: '邮箱',
};

const VALIDATION_FALLBACK_MESSAGE = '输入内容不符合要求，请检查后重试。';

const getFieldLabelFromLocation = (loc: unknown) => {
  if (!Array.isArray(loc)) return '';
  for (let index = loc.length - 1; index >= 0; index -= 1) {
    const segment = loc[index];
    if (typeof segment !== 'string') continue;
    const normalized = segment.trim();
    if (!normalized || normalized === 'body') continue;
    return FIELD_LABELS[normalized] || normalized;
  }
  return '';
};

const tryExtractPositiveNumber = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

const formatValidationDetailItem = (detail: ValidationDetailItem) => {
  const type = typeof detail?.type === 'string' ? detail.type.trim() : '';
  const rawMessage = typeof detail?.msg === 'string' ? detail.msg.trim() : '';
  const ctx = detail?.ctx && typeof detail.ctx === 'object' ? detail.ctx as Record<string, unknown> : null;
  const fieldLabel = getFieldLabelFromLocation(detail?.loc);

  const minLength = tryExtractPositiveNumber(ctx?.min_length);
  if (type === 'missing' || /field required/i.test(rawMessage)) {
    return `${fieldLabel || '必填项'}不能为空`;
  }

  if (type === 'string_too_short' || /at least\s+\d+\s+characters/i.test(rawMessage)) {
    if (fieldLabel === '密码' && minLength) {
      return `密码不能少于 ${minLength} 位`;
    }
    if (fieldLabel && minLength) {
      return `${fieldLabel}至少需要 ${minLength} 个字符`;
    }
    if (minLength) {
      return `输入内容至少需要 ${minLength} 个字符`;
    }
  }

  if (type.includes('email') || /valid email/i.test(rawMessage)) {
    return '邮箱格式不正确';
  }

  if (
    type.includes('string_type') ||
    type.includes('type_error') ||
    /valid string/i.test(rawMessage) ||
    /input should be a valid string/i.test(rawMessage)
  ) {
    return `${fieldLabel || '输入内容'}格式不正确`;
  }

  if (fieldLabel && /format/i.test(rawMessage)) {
    return `${fieldLabel}格式不正确`;
  }

  if (rawMessage) {
    return fieldLabel && !rawMessage.includes(fieldLabel) ? `${fieldLabel}：${rawMessage}` : rawMessage;
  }

  return fieldLabel ? `${fieldLabel}格式不正确` : VALIDATION_FALLBACK_MESSAGE;
};

const normalizeErrorDetailMessage = (detail: unknown, fallback: string) => {
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => formatValidationDetailItem((item || {}) as ValidationDetailItem))
      .filter((message): message is string => typeof message === 'string' && message.trim().length > 0);

    if (messages.length > 0) {
      return messages.join('；');
    }
  }

  if (detail && typeof detail === 'object') {
    const record = detail as Record<string, unknown>;
    for (const key of ['message', 'msg', 'detail', 'error']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }

  return fallback;
};

export const normalizeAppErrorMessage = (
  error: unknown,
  fallback = '请求失败，请稍后重试',
  options: NormalizeAppErrorOptions = {}
) => {
  if (isAuthRequiredError(error)) {
    return error.message;
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED' && options.timeoutMessage) {
      return options.timeoutMessage;
    }
    if (error.code === 'ERR_NETWORK' && options.networkErrorMessage) {
      return options.networkErrorMessage;
    }

    const detail = error.response?.data?.detail;
    const message = error.response?.data?.message;
    const normalizedDetail = normalizeErrorDetailMessage(detail, '');
    if (normalizedDetail) return normalizedDetail;
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof error.message === 'string' && error.message.trim()) return error.message;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
};

class APIClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 300000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.client.interceptors.request.use((config) => {
      const requestUrl = String(config.url || '');
      const token = getStoredAccessToken();

      if (this.requestRequiresAuth(requestUrl) && !token) {
        const message = this.buildPreflightAuthMessage(requestUrl);
        this.handleAuthRequired(message);
        return Promise.reject(new AuthRequiredError(message));
      }

      if (token) {
        const headers = AxiosHeaders.from(config.headers || {});
        headers.set('Authorization', `Bearer ${token}`);
        config.headers = headers;
      }

      return config;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (this.isAuthenticationFailure(error)) {
          const requestUrl = String(error.config?.url || '');
          const message = this.buildExpiredAuthMessage(requestUrl);
          this.handleAuthRequired(message);
          return Promise.reject(new AuthRequiredError(message));
        }
        if (error.code === 'ECONNABORTED') {
          console.error('请求超时，请稍后重试');
        }
        return Promise.reject(error);
      }
    );
  }

  private requestRequiresAuth(url: string) {
    const normalized = url.trim();
    if (!normalized) return true;
    return ![
      '/auth/login',
      '/auth/register',
      '/health',
    ].some((prefix) => normalized.startsWith(prefix));
  }

  private isAuthenticationFailure(error: unknown) {
    if (!axios.isAxiosError(error)) return false;

    const status = error.response?.status;
    const detail = String(error.response?.data?.detail || '').toLowerCase();

    return status === 401 || [
      'authorization',
      '登录态已失效',
      '认证令牌',
      '缺少用户标识',
      'unauthorized',
      'bearer',
    ].some((fragment) => detail.includes(fragment.toLowerCase()));
  }

  private handleAuthRequired(message: string) {
    clearStoredAuth();
    emitAuthRequired(message);
  }

  private buildPreflightAuthMessage(url: string) {
    if (this.isInterviewRequest(url)) {
      return INTERVIEW_AUTH_REQUIRED_MESSAGE;
    }
    if (this.isVisualGenerationRequest(url)) {
      return '请先登录工作台后再生成图片。';
    }
    return DEFAULT_AUTH_REQUIRED_MESSAGE;
  }

  private buildExpiredAuthMessage(url: string) {
    if (this.isInterviewRequest(url)) {
      return INTERVIEW_AUTH_EXPIRED_MESSAGE;
    }
    if (this.isVisualGenerationRequest(url)) {
      return '登录态已失效，请重新登录后再生成图片。';
    }
    return DEFAULT_AUTH_EXPIRED_MESSAGE;
  }

  private isInterviewRequest(url: string) {
    return [
      '/interview/start',
      '/interview/message',
      '/interview/session',
    ].some((prefix) => url.startsWith(prefix));
  }

  private isVisualGenerationRequest(url: string) {
    return [
      '/visual/analyze',
      '/visual/compose-template',
      '/visual/compose-template-series',
      '/visual/generate',
      '/visual/dynamic-image',
      '/visual/workflow',
      '/visual/task/',
      '/visual/edit',
    ].some((prefix) => url.startsWith(prefix));
  }

  async register(params: { username: string; password: string; email?: string }) {
    const response = await this.client.post('/auth/register', params, {
      timeout: AUTH_REQUEST_TIMEOUT_MS,
    });
    return response.data as { access_token: string; token_type: string; user: AuthUser };
  }

  async login(params: { username: string; password: string }) {
    const response = await this.client.post('/auth/login', params, {
      timeout: AUTH_REQUEST_TIMEOUT_MS,
    });
    return response.data as { access_token: string; token_type: string; user: AuthUser };
  }

  async getCurrentUser() {
    const response = await this.client.get('/auth/me', {
      timeout: AUTH_REQUEST_TIMEOUT_MS,
    });
    return response.data as AuthUser;
  }

  async startInterview(productBrief?: Partial<ProductBrief> | null) {
    const response = await this.client.post('/interview/start', productBrief ? {
      product_brief: productBrief,
    } : {}, {
      timeout: INTERVIEW_REQUEST_TIMEOUT_MS,
    });
    return response.data as InterviewResponse & { session_id: string };
  }

  async sendInterviewMessage(sessionId: string, message: string) {
    const response = await this.client.post('/interview/message', {
      session_id: sessionId,
      message,
    }, {
      timeout: INTERVIEW_REQUEST_TIMEOUT_MS,
    });
    return response.data as InterviewResponse;
  }

  async getCurrentInterviewSession() {
    const response = await this.client.get('/interview/session/current', {
      timeout: HISTORY_REQUEST_TIMEOUT_MS,
    });
    return response.data as { success: boolean; data: any | null };
  }

  async saveInterviewUISnapshot(sessionId: string, uiSnapshot: any) {
    const response = await this.client.put(`/interview/session/${sessionId}/ui`, {
      ui_snapshot: uiSnapshot,
    }, {
      timeout: HISTORY_REQUEST_TIMEOUT_MS,
    });
    return response.data as { success: boolean; data: any };
  }

  async checkHealth() {
    const response = await this.client.get('/health');
    return response.data;
  }

  async analyzeLocalNotes(notes: any[], productBrief?: Partial<ProductBrief>) {
    const response = await this.client.post('/scraper/analyze-local-data', {
      notes,
      product_brief: productBrief,
    });
    return response.data;
  }

  async collectByUrl(payload: UrlCollectionRequest) {
    const response = await this.client.post('/scraper/collect-by-url', payload);
    return response.data as { success: boolean; data: UrlCollectionResponse; message?: string };
  }

  async saveScrapeHistory(data: {
    keyword: string;
    collection_mode?: ScrapeCollectionMode;
    source_input?: string;
    notes_count: number;
    notes_data: any[];
    analysis_result?: any;
    filters?: SearchFilters;
    product_brief?: ProductBrief;
  }) {
    const response = await this.client.post('/scraper/history', data);
    return response.data;
  }

  async getScrapeHistories() {
    const response = await this.client.get('/scraper/history', {
      timeout: HISTORY_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  }

  async getCurrentProductProfile() {
    const response = await this.client.get('/product-profile/current', {
      timeout: HISTORY_REQUEST_TIMEOUT_MS,
    });
    return response.data as { success: boolean; data: ProductProfile | null };
  }

  async updateCurrentProductProfile(productBrief: Partial<ProductBrief>) {
    const response = await this.client.put('/product-profile/current', {
      product_brief: productBrief,
    }, {
      timeout: HISTORY_REQUEST_TIMEOUT_MS,
    });
    return response.data as { success: boolean; data: ProductProfile };
  }

  async getOrGenerateProductResearchContext(params: {
    product_brief?: Partial<ProductBrief> | null;
    reference_assets?: ReferenceAsset[];
    benchmark_note?: BenchmarkNote;
    force_refresh?: boolean;
  }): Promise<{ success: boolean; message: string; data: ResearchContext; cached?: boolean; profile?: ProductProfile }> {
    const response = await this.client.post('/product-profile/research-context', {
      product_brief: params.product_brief || null,
      reference_assets: params.reference_assets || [],
      benchmark_note: params.benchmark_note || null,
      force_refresh: params.force_refresh || false,
    });
    return response.data;
  }

  async getScrapeHistoryDetail(taskId: string) {
    const response = await this.client.get(`/scraper/history/${taskId}`, {
      timeout: HISTORY_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  }

  async updateScrapeHistoryAnalysis(taskId: string, payload: { analysis_result?: any; filters?: SearchFilters; product_brief?: ProductBrief }) {
    const response = await this.client.put(`/scraper/history/${taskId}/analysis`, {
      ...payload,
    });
    return response.data;
  }

  async deleteScrapeHistory(taskId: string) {
    const response = await this.client.delete(`/scraper/history/${taskId}`);
    return response.data;
  }

  async autosaveCreativeDraft(payload: {
    title: string;
    session_key: string;
    source_context?: string | null;
    snapshot_version?: number;
    content_payload: CreativeDraftSnapshot;
    preview_payload: Record<string, any>;
  }) {
    const response = await this.client.post('/creative-drafts/autosave', payload);
    return response.data as { success: boolean; data: CreativeDraftDetail };
  }

  async createCreativeDraft(payload: {
    title: string;
    session_key: string;
    source_context?: string | null;
    snapshot_version?: number;
    content_payload: CreativeDraftSnapshot;
    preview_payload: Record<string, any>;
  }) {
    const response = await this.client.post('/creative-drafts', payload);
    return response.data as { success: boolean; data: CreativeDraftDetail };
  }

  async getCreativeDrafts() {
    const response = await this.client.get('/creative-drafts');
    return response.data as { success: boolean; data: CreativeDraftSummary[] };
  }

  async getCreativeDraftDetail(draftId: string) {
    const response = await this.client.get(`/creative-drafts/${draftId}`);
    return response.data as { success: boolean; data: CreativeDraftDetail };
  }

  async updateCreativeDraft(draftId: string, payload: { title?: string; status?: string }) {
    const response = await this.client.put(`/creative-drafts/${draftId}`, payload);
    return response.data as { success: boolean; data: CreativeDraftDetail };
  }

  async deleteCreativeDraft(draftId: string) {
    const response = await this.client.delete(`/creative-drafts/${draftId}`);
    return response.data as { success: boolean };
  }

  async analyzeContent(params: {
    title: string;
    content: string;
    style?: string;
    mode?: ImageMode;
    material_summary?: string;
    reference_summary?: string;
    reference_assets?: ReferenceAsset[];
    primary_reference_asset_id?: string;
    product_brief?: Partial<ProductBrief>;
    template_kind?: TemplateKind | string;
    dynamic_style_params?: Record<string, any>;
  }) {
    const response = await this.client.post('/visual/analyze', {
      title: params.title,
      content: params.content,
      style: params.style || 'cyberpunk',
      mode: params.mode || '动态表达',
      material_summary: params.material_summary || '',
      reference_summary: params.reference_summary || '',
      reference_assets: params.reference_assets || [],
      primary_reference_asset_id: params.primary_reference_asset_id || '',
      product_brief: params.product_brief || null,
      template_kind: params.template_kind || '',
      dynamic_style_params: params.dynamic_style_params,
    });
    return response.data;
  }

  async composeTemplate(params: {
    title: string;
    content: string;
    product_brief?: Partial<ProductBrief>;
    reference_assets?: ReferenceAsset[];
    primary_reference_asset_id?: string;
    template_kind?: TemplateKind | string;
    brand_style?: string;
    note_visual_plan?: NoteVisualPlan | null;
  }): Promise<{ success: boolean; message: string; data: TemplateComposeResult }> {
    const response = await this.client.post('/visual/compose-template', {
      title: params.title,
      content: params.content,
      product_brief: params.product_brief || null,
      reference_assets: params.reference_assets || [],
      primary_reference_asset_id: params.primary_reference_asset_id || '',
      template_kind: params.template_kind || '',
      brand_style: params.brand_style || '',
      note_visual_plan: params.note_visual_plan || null,
    });
    return response.data;
  }

  async composeTemplateSeries(params: {
    title: string;
    content: string;
    product_brief?: Partial<ProductBrief>;
    reference_assets?: ReferenceAsset[];
    primary_reference_asset_id?: string;
    brand_style?: string;
    note_visual_plan?: NoteVisualPlan | null;
    card_count_limit?: number;
  }): Promise<{ success: boolean; message: string; data: TemplateComposeSeriesResult }> {
    const response = await this.client.post('/visual/compose-template-series', {
      title: params.title,
      content: params.content,
      product_brief: params.product_brief || null,
      reference_assets: params.reference_assets || [],
      primary_reference_asset_id: params.primary_reference_asset_id || '',
      brand_style: params.brand_style || '',
      note_visual_plan: params.note_visual_plan || null,
      card_count_limit: params.card_count_limit || null,
    });
    return response.data;
  }

  async generateImage(params: {
    prompt: string;
    count?: number;
    aspect_ratio?: string;
    image_size?: string;
  }) {
    const response = await this.client.post('/visual/generate', {
      prompt: params.prompt,
      count: params.count || 1,
      aspect_ratio: params.aspect_ratio || '3:4',
      image_size: params.image_size || '1K',
    });
    return response.data;
  }

  async runWorkflow(params: {
    client_request_id?: string;
    title: string;
    content: string;
    style?: string;
    image_count?: number;
    mode?: ImageMode;
    material_summary?: string;
    reference_summary?: string;
    reference_assets?: ReferenceAsset[];
    primary_reference_asset_id?: string;
    prompts?: any[];
    product_brief?: Partial<ProductBrief>;
    template_kind?: TemplateKind | string;
    dynamic_style_params?: Record<string, any>;
    material_fusion_plan?: MaterialFusionPlanItem[];
    design_plan?: Record<string, any> | null;
    prompt_stats?: Record<string, any> | null;
  }) {
    const response = await this.client.post('/visual/workflow', {
      client_request_id: params.client_request_id || '',
      title: params.title,
      content: params.content,
      style: params.style || 'cyberpunk',
      image_count: params.image_count || 1,
      mode: params.mode || '动态表达',
      material_summary: params.material_summary || '',
      reference_summary: params.reference_summary || '',
      reference_assets: params.reference_assets || [],
      primary_reference_asset_id: params.primary_reference_asset_id || '',
      prompts: params.prompts || [],
      product_brief: params.product_brief || null,
      template_kind: params.template_kind || '',
      dynamic_style_params: params.dynamic_style_params,
      material_fusion_plan: params.material_fusion_plan || null,
      design_plan: params.design_plan || null,
      prompt_stats: params.prompt_stats || null,
    });
    return response.data;
  }

  async generateDynamicImage(params: {
    client_request_id?: string;
    title: string;
    tags?: string[];
    image_count?: number;
    style?: string;
    content?: string;
    dynamic_style_params?: Record<string, any>;
    product_brief?: Partial<ProductBrief>;
  }) {
    const response = await this.client.post('/visual/dynamic-image', {
      client_request_id: params.client_request_id || '',
      title: params.title,
      tags: params.tags || [],
      image_count: params.image_count || 1,
      style: params.style || 'cyberpunk',
      content: params.content || '',
      dynamic_style_params: params.dynamic_style_params || null,
      product_brief: params.product_brief || null,
    });
    return response.data;
  }

  async getReferenceAssets() {
    const response = await this.client.get('/visual/assets');
    return response.data;
  }

  async uploadReferenceAsset(file: File, metadata?: {
    source?: string;
    display_name?: string;
    note?: string;
    tags?: string[];
    ai_hint?: string;
  }) {
    const formData = new FormData();
    formData.append('file', file);
    if (metadata?.source) formData.append('source', metadata.source);
    if (metadata?.display_name) formData.append('display_name', metadata.display_name);
    if (metadata?.note) formData.append('note', metadata.note);
    if (metadata?.tags?.length) formData.append('tags', metadata.tags.join(','));
    if (metadata?.ai_hint) formData.append('ai_hint', metadata.ai_hint);
    const response = await this.client.post('/visual/assets', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  }

  async updateReferenceAsset(assetId: string, params: {
    display_name?: string;
    note?: string;
    tags?: string[];
    ai_hint?: string;
    source?: string;
  }) {
    const response = await this.client.patch(`/visual/assets/${assetId}`, params);
    return response.data;
  }

  async organizeReferenceAssets(params: {
    asset_ids?: string[];
    product_brief?: Partial<ProductBrief>;
  }) {
    const response = await this.client.post('/visual/assets/organize', {
      asset_ids: params.asset_ids || [],
      product_brief: params.product_brief || null,
    });
    return response.data as { success: boolean; message: string; data: ReferenceAsset[]; updated_count?: number };
  }

  async deleteReferenceAsset(assetId: string) {
    const response = await this.client.delete(`/visual/assets/${assetId}`);
    return response.data;
  }

  async getVisualTaskStatus(taskId: string) {
    const response = await this.client.get(`/visual/task/${taskId}`);
    return response.data;
  }

  async cancelVisualTask(taskId: string) {
    const response = await this.client.post(`/visual/task/${taskId}/cancel`);
    return response.data;
  }

  private async waitForTextTask<T>(taskId: string, timeoutMs = TEXT_TASK_TIMEOUT_MS): Promise<T> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const snapshot = await this.getVisualTaskStatus(taskId) as VisualTaskSnapshot<T>;
      if (snapshot.status === 'completed') {
        if (snapshot.result == null) {
          throw new Error(snapshot.message || '任务完成但没有返回结果');
        }
        return snapshot.result;
      }
      if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
        throw new Error(snapshot.error || snapshot.message || '任务失败，请稍后重试');
      }
      await sleep(TEXT_TASK_POLL_INTERVAL_MS);
    }
    throw new Error('任务等待超时，请稍后查看结果或重试');
  }

  async getAllVisualTasks() {
    const response = await this.client.get('/visual/tasks');
    return response.data;
  }

  async getImageRunnerStatus() {
    const response = await this.client.get('/visual/image-runner/status');
    return response.data as {
      success: boolean;
      runner: {
        concurrency_limit: number;
        active: number;
        waiting: number;
        completed: number;
        failed: number;
        available_slots: number;
      };
    };
  }

  async getPublishQuota() {
    const response = await this.client.get('/visual/publish-quota');
    return response.data;
  }

  async generateContent(params: {
    product_name: string;
    target_audience: string;
    product_features: string;
    content_style?: string;
    ai_insights?: string;
    benchmark_note?: BenchmarkNote;
    rewrite_mode?: RewriteMode;
    brand_tone?: string;
    must_include?: string;
    banned_terms?: string;
    real_phrases?: string[];
    sales_intensity?: number;
    colloquial_level?: number;
    authenticity_level?: number;
    research_context?: ResearchContext | null;
    note_strategy?: NoteStrategy | null;
  }) {
    const response = await this.client.post('/visual/generate-content-async', {
      ...params,
      content_style: params.content_style || 'seed',
    });
    return this.waitForTextTask(response.data.task_id);
  }

  async generateResearchContext(params: {
    product_brief: Partial<ProductBrief>;
    reference_assets?: ReferenceAsset[];
    benchmark_note?: BenchmarkNote;
  }): Promise<{ success: boolean; message: string; data: ResearchContext }> {
    const response = await this.client.post('/visual/notes/research-context', {
      product_brief: params.product_brief || null,
      reference_assets: params.reference_assets || [],
      benchmark_note: params.benchmark_note || null,
    });
    return response.data;
  }

  async generateNoteStrategy(params: {
    research_context: ResearchContext;
    benchmark_note?: BenchmarkNote;
    real_phrases?: string[];
    strategy_mode?: 'benchmark_first' | 'research_first';
    strategy_feedback?: string;
  }): Promise<{ success: boolean; message: string; data: { strategies: NoteStrategy[]; selected_strategy_id?: string; fallback_used?: boolean; fallback_reason?: string; benchmark_fit?: NoteStrategy['benchmarkFit']; product_usage_mode?: NoteStrategy['productUsageMode'] } }> {
    const response = await this.client.post('/visual/notes/strategy', {
      research_context: params.research_context,
      benchmark_note: params.benchmark_note || null,
      real_phrases: params.real_phrases || [],
      strategy_mode: params.strategy_mode || 'research_first',
      strategy_feedback: params.strategy_feedback || '',
    });
    return response.data;
  }

  async reviseNote(params: NoteRevisionRequest): Promise<NoteRevisionResponse> {
    const response = await this.client.post('/visual/revise-note-async', {
      ...params,
      closing: params.closing || '',
      selected_scope: params.selected_scope || null,
      rewrite_session: params.rewrite_session || null,
      product_brief: params.product_brief || null,
      benchmark_note: params.benchmark_note || null,
      note_strategy: params.note_strategy || null,
    });
    return this.waitForTextTask<NoteRevisionResponse>(response.data.task_id);
  }

  async generateNoteVisualPlan(params: {
    title: string;
    content: string;
    product_brief?: Partial<ProductBrief> | null;
    note_strategy?: NoteStrategy | null;
    reference_assets?: ReferenceAsset[];
  }): Promise<{ success: boolean; message: string; data: NoteVisualPlan }> {
    const response = await this.client.post('/visual/notes/visual-plan', {
      title: params.title,
      content: params.content,
      product_brief: params.product_brief || null,
      note_strategy: params.note_strategy || null,
      reference_assets: params.reference_assets || [],
    });
    return response.data;
  }

  async editImage(params: {
    image_id: string;
    prompt: string;
    aspect_ratio?: string;
    image_size?: string;
    reference_asset_ids?: string[];
    upload_reference_asset_ids?: string[];
    material_fusion_serial_mode?: boolean;
    reference_metadata_only?: boolean;
    edit_purpose?: string;
    candidate_seed?: string;
    candidate_offset?: number;
    trace_metadata?: Record<string, any>;
  }) {
    const response = await this.client.post('/visual/edit', {
      image_id: params.image_id,
      prompt: params.prompt,
      aspect_ratio: params.aspect_ratio || '3:4',
      image_size: params.image_size || '1K',
      reference_asset_ids: params.reference_asset_ids || [],
      upload_reference_asset_ids: params.upload_reference_asset_ids || [],
      material_fusion_serial_mode: params.material_fusion_serial_mode || false,
      reference_metadata_only: params.reference_metadata_only || false,
      edit_purpose: params.edit_purpose || null,
      candidate_seed: params.candidate_seed || null,
      candidate_offset: typeof params.candidate_offset === 'number' ? params.candidate_offset : null,
      trace_metadata: params.trace_metadata || {},
    });
    return response.data;
  }

  async polishContent(params: {
    text: string;
    instruction: string;
    type?: string;
  }) {
    const response = await this.client.post('/visual/polish-content-async', {
      text: params.text,
      instruction: params.instruction,
      type: params.type || 'body',
    });
    return this.waitForTextTask(response.data.task_id);
  }
}

export const apiClient = new APIClient();
export default apiClient;
