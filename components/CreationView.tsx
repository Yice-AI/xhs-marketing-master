import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNote } from '../contexts/NoteContext';
import { usePersistence } from '../contexts/PersistenceContext';
import { useScraperContext } from '../contexts/ScraperContext';
import apiClient, { normalizeAppErrorMessage } from '../services/apiClient';
import { buildCreativeDraftPreview, buildCreativeDraftSourceContext, buildCreativeDraftTitle, CREATIVE_DRAFT_SNAPSHOT_VERSION, hasMeaningfulCreativeDraftSnapshot, serializeReferenceAssetsForDraft } from '../lib/creativeDrafts';
import { buildProductBriefSignature, createEmptyProductBrief, getMissingProductBriefFields, normalizeProductBrief, parseProductBriefUrlsText, productBriefUrlsToText } from '../lib/productBrief';
import CreativeDraftDrawer from './CreativeDraftDrawer';
import ReferenceAssetLibrary from './ReferenceAssetLibrary';
import {
  Asset,
  CreationEditorState,
  CreativeDraftDetail,
  CreativeDraftSnapshot,
  CreationMode,
  GeneratedContent,
  ImageMode,
  InterviewData,
  MaterialAssetRole,
  MaterialFusionDraft,
  MaterialFusionPlanItem,
  NoteEditScope,
  NoteRevisionResult,
  NoteStrategy,
  NoteVisualPlan,
  PendingNoteConfirmation,
  ReferenceAsset,
  ResearchContext,
  RewriteMode,
  TemplateFrameStyle,
  RewriteSession,
  TemplateKind,
} from '../types';
import { editablePayloadToDocument, withDocumentFromComposeResult } from '../lib/templateComposer';
import { buildVisualProjectFromSeriesResult } from '../lib/visualProject';
import { buildTemplateAssetForStudio } from '../lib/templateAssetRenderer';
import { sanitizeMarkdownForXhs } from '../lib/xhsContent';

interface CreationViewProps {
  mode: CreationMode;
  interviewData?: InterviewData;
  generatedContent?: GeneratedContent;
  onEnterStudio: () => void;
}

const rewriteModes: RewriteMode[] = ['轻仿写', '结构仿写', '深改原创'];
const imageModes: ImageMode[] = ['动态表达', '风格表达', '物料融合', '模板拼装'];
const DYNAMIC_EXPRESSION_MAX_IMAGE_COUNT = 6;
const MATERIAL_FUSION_MAX_IMAGE_COUNT = 6;
const styleExpressionPresets = [
  {
    value: '运营干货手绘卡',
    label: '运营干货手绘卡',
    description: '青绿外底、白色撕纸、粗黑手写字，适合运营干货爆款图。',
    swatches: ['#18B8B5', '#fffdf4', '#111111', '#facc15'],
    previewUrl: '/style-previews/handdrawn-operations.webp',
  },
  {
    value: '方法论笔记本',
    label: '方法论笔记本',
    description: '线圈笔记本、分页标签、适合 SOP、清单和步骤。',
    swatches: ['#0f172a', '#f7f2e8', '#14b8a6', '#f97316'],
    previewUrl: '/style-previews/notebook-method.webp',
  },
  {
    value: '清爽流程信息图',
    label: '清爽流程信息图',
    description: '白底流程、箭头节点、适合步骤、对比和流程说明。',
    swatches: ['#0284c7', '#f8fafc', '#22c55e', '#334155'],
    previewUrl: '/style-previews/clean-flow.webp',
  },
  {
    value: 'SaaS功能卡片',
    label: 'SaaS功能卡片',
    description: '高级工具卡片、界面抽象、适合 ToB/SaaS 产品价值。',
    swatches: ['#2563eb', '#ecfeff', '#0f172a', '#10b981'],
    previewUrl: '/style-previews/saas-feature-cards.webp',
  },
  {
    value: '爆款封面大字报',
    label: '爆款封面大字报',
    description: '强标题、强对比色块、适合首图点击和核心观点。',
    swatches: ['#ef4444', '#fef3c7', '#111827', '#ffffff'],
    previewUrl: '/style-previews/bold-cover.webp',
  },
] as const;
const styleExpressionPresetValues = styleExpressionPresets.map((preset) => preset.value);
const legacyStylePresetMap: Record<string, (typeof styleExpressionPresets)[number]['value']> = {
  温暖渐变卡片: '运营干货手绘卡',
  笔记卡片风: '方法论笔记本',
  极简文字海报: '清爽流程信息图',
  赛博朋克: '爆款封面大字报',
  企业级扁平海报: 'SaaS功能卡片',
};
const normalizeImageMode = (value?: ImageMode | string): ImageMode => {
  if (value === '概念表达') return '风格表达';
  if (value === '动态表达' || value === '风格表达' || value === '物料融合' || value === '模板拼装') return value;
  return '动态表达';
};
const normalizeStyleExpressionPreset = (value?: string): string => {
  const raw = String(value || '').trim();
  if (styleExpressionPresetValues.includes(raw as (typeof styleExpressionPresets)[number]['value'])) return raw;
  return legacyStylePresetMap[raw] || '运营干货手绘卡';
};
const isDynamicQualityImageMode = (value?: ImageMode | string) => value === '动态表达' || value === '风格表达' || value === '概念表达';
const isStyleExpressionImageMode = (value?: ImageMode | string) => value === '风格表达' || value === '概念表达';
const rewriteModeDescriptions: Record<RewriteMode, string> = {
  轻仿写: '保留灵感，只借语气和局部表达',
  结构仿写: '沿用对标节奏，替换成当前产品',
  深改原创: '只保留方向，重新组织成原创笔记',
};
const productUsageMeta = {
  research_only: {
    label: '产品研究生成',
    shortLabel: '产品研究',
    description: '未选择对标笔记，本次按产品资料、研究结论和策略方向生成。',
    className: 'bg-emerald-500/15 text-emerald-100 border-emerald-400/20',
  },
  product_main: {
    label: '产品主导',
    shortLabel: '产品主导',
    description: '对标爆点和产品价值强相关，策略会围绕产品信息展开。',
    className: 'bg-emerald-500/15 text-emerald-100 border-emerald-400/20',
  },
  product_assist: {
    label: '产品轻承接',
    shortLabel: '轻承接',
    description: '对标内容是主线，产品只在合适位置作为辅助承接。',
    className: 'bg-cyan-500/15 text-cyan-100 border-cyan-400/20',
  },
  no_product: {
    label: '不带产品',
    shortLabel: '不带产品',
    description: '只复刻对标的结构、节奏和流量钩子，不使用产品信息。',
    className: 'bg-amber-500/15 text-amber-100 border-amber-400/20',
  },
};
const resolveProductUsageMode = (strategy: NoteStrategy | null | undefined, hasBenchmark: boolean) => {
  if (!hasBenchmark) {
    return 'research_only';
  }
  return strategy?.productUsageMode || strategy?.benchmarkFit?.product_usage_mode || 'product_main';
};
const imageModeDescriptions: Record<ImageMode, string> = {
  概念表达: '旧版概念入口，会自动升级为风格表达',
  风格表达: '基于动态表达质量链路，选择稳定的系列视觉风格',
  物料融合: '适合把 Logo、产品截图、页面素材融入海报',
  模板拼装: '适合多页组图和教程结构',
  动态表达: '让模型按内容自动定画面语言',
};
const imageModeBadges: Record<ImageMode, string> = {
  概念表达: '旧版兼容',
  风格表达: '多风格',
  物料融合: '强素材参考',
  模板拼装: '可进工作台',
  动态表达: 'AI 定风格',
};
const templatePageCounts = [3, 4, 5, 6] as const;
const MATERIAL_FUSION_AUTO_PRIMARY_SCORE_THRESHOLD = 16;
const templateCopyStyles = [
  {
    value: '通用种草',
    label: '通用种草',
    description: '正文更通用，图里讲过程，文案讲价值和适合谁。',
    brandTone: '真实种草、轻引导、不堆砌步骤，像真人推荐',
    mustInclude: '正文重点写价值、收益、适合人群，不要把图片里的每一步机械复述',
  },
  {
    value: '教程引导',
    label: '教程引导',
    description: '正文强调看图照做、注意事项和适用场景。',
    brandTone: '像经验型教程分享，清楚、有帮助、不过度营销',
    mustInclude: '正文补充适合谁、注意事项、常见误区，步骤细节主要交给图片表达',
  },
  {
    value: '转化推荐',
    label: '转化推荐',
    description: '正文更强调收益、推荐理由和行动引导。',
    brandTone: '更有推荐感和转化感，但仍然要克制、真实、不硬卖',
    mustInclude: '正文突出解决什么问题、核心收益、为什么推荐，可加入轻度行动引导',
  },
] as const;
const templateFrameStyles: Array<{ value: TemplateFrameStyle; label: string; description: string }> = [
  { value: 'soft_gradient_card', label: '清爽白板', description: '更干净、更利落，适合稳定讲解' },
  { value: 'sunset_glow_card', label: '宣传海报', description: '暖色斜切 + 发光氛围，更适合强传播' },
  { value: 'editorial_outline_card', label: '杂志留白', description: '大留白 + 编辑排版，更像参考图' },
  { value: 'notebook_tape_card', label: '便签手账', description: '胶带便签感，更轻松更像笔记' },
  { value: 'split_banner_card', label: '分栏横幅', description: '彩色侧条，更现代更有信息感' },
];

const getTemplateComposeVisualStyle = (frameStyle: TemplateFrameStyle): string => {
  switch (frameStyle) {
    case 'sunset_glow_card':
      return '温暖渐变卡片';
    case 'notebook_tape_card':
      return '笔记卡片风';
    case 'editorial_outline_card':
      return '极简文字海报';
    case 'split_banner_card':
      return '企业级扁平海报';
    default:
      return '温暖渐变卡片';
  }
};

const splitSearchTerms = (value: string) => Array.from(new Set(
  String(value || '')
    .toLowerCase()
    .split(/[\s,，。；;：:、|/\\#\n\r\t（）()【】\[\]{}"'“”‘’]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
)).slice(0, 80);

const scoreReferenceAssetForContext = (
  asset: ReferenceAsset,
  contextText: string,
  productName: string
) => {
  const assetText = [
    asset.display_name,
    asset.original_name,
    asset.source,
    ...(asset.tags || []),
    asset.note,
    asset.ai_hint,
  ].filter(Boolean).join(' ').toLowerCase();
  const contextTerms = splitSearchTerms(contextText);
  const productTerms = splitSearchTerms(productName);
  const assetLooksUseful = /(logo|品牌|截图|页面|官网|落地页|后台|界面|产品|功能|价格|案例|海报|参考|风格|竞品|ui|screenshot)/i.test(assetText);

  let score = asset.source === 'project_library' ? 2 : asset.source === 'chat_attachment' ? 1 : 0;
  if (assetLooksUseful) score += 2;
  for (const term of productTerms) {
    if (assetText.includes(term)) score += 5;
  }
  for (const term of contextTerms) {
    if (assetText.includes(term)) score += 2;
  }
  if ((asset.tags || []).length > 0) score += 1;
  if (asset.ai_hint) score += 2;
  if (asset.note) score += 1;
  return score;
};

const getReferenceAssetSearchText = (asset: ReferenceAsset) => [
  asset.display_name,
  asset.original_name,
  asset.source,
  ...(asset.tags || []),
  asset.note,
  asset.ai_hint,
].filter(Boolean).join(' ').toLowerCase();

const inferMaterialAssetRole = (asset: ReferenceAsset): MaterialAssetRole => {
  const text = getReferenceAssetSearchText(asset);
  const identityText = [
    asset.display_name,
    asset.original_name,
    asset.note,
  ].filter(Boolean).join(' ').toLowerCase();
  const tagText = (asset.tags || []).join(' ').toLowerCase();
  const explicitNonCompetitor = /(不是竞品|非竞品|不要识别为竞品|别识别为竞品|不是竞品图|不是对标|非对标|not competitor|not a competitor)/i.test(text);
  const explicitCompetitor = /(竞品|对标|竞对|别人家的|其他品牌|其他产品|benchmark|competitor|仅参考结构|只参考结构|不要直接使用|不直接使用|不可直接使用)/i.test(text);
  const looksLikeUiPage = /(功能|客户|数据|分析|看板|后台|设置|列表|详情|页面|界面|截图|活码|导入|写作|排版|分页|模板|违规|检测|检查|敏感词|水印|群发|任务宝|sop|screen|screenshot|dashboard|crm|scrm)/i.test(text);
  const identityLooksLikeUiPage = /(功能|客户|数据|分析|看板|后台|设置|列表|详情|页面|界面|截图|活码|导入|写作|排版|分页|模板|违规|检测|检查|敏感词|水印|群发|任务宝|sop|screen|screenshot|dashboard|crm|scrm)/i.test(identityText);
  const identityLooksLikeLogo = /(logo|纯logo|产品logo|品牌logo|logo图|logo素材|蓝底logo|白底logo|标志|品牌标识|商标|品牌露出|品牌水印|brand mark|brandmark|logotype)/i.test(identityText);
  const hasLogoTag = /(^|\s)(logo|品牌标识|品牌logo)(\s|$)/i.test(tagText);
  if (identityLooksLikeLogo || (hasLogoTag && !identityLooksLikeUiPage && !looksLikeUiPage)) return 'logo';
  if (!explicitNonCompetitor && explicitCompetitor) return 'competitor_reference';
  if (looksLikeUiPage) return 'feature_screenshot';
  if (/(品牌|配色|风格|官网|落地页|视觉|色彩|brand|style)/i.test(text)) return 'brand_style';
  if (/(首页|产品|app|小程序|网页|官网|系统|product|home)/i.test(text)) return 'product_page';
  return 'supporting';
};

const materialAssetRoleLabels: Record<MaterialAssetRole, string> = {
  logo: 'Logo',
  product_page: '产品页',
  feature_screenshot: '功能图',
  brand_style: '品牌风格',
  competitor_reference: '竞品参考',
  supporting: '其他素材',
};

const materialFeatureKeywordGroups: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: '渠道活码', aliases: ['渠道活码', '活码', '渠道码', '二维码活码', '员工活码', '客户活码'] },
  { canonical: '客户管理', aliases: ['客户管理', '客户列表', '客户画像', '客户资料', '用户管理'] },
  { canonical: '销售订单', aliases: ['销售订单', '订单管理', '订单', '订单后台', '订单页面', '销售单', '成交订单'] },
  { canonical: '数据看板', aliases: ['数据看板', '经营看板', '销售看板', '分析看板', '统计报表', '数据报表', '分析报表'] },
  { canonical: '一键导入', aliases: ['一键导入', '内容导入', '素材导入', '导入素材', '导入内容', '导入页', '导入功能', '文章导入', '公众号导入', '飞书导入', 'notion导入', '本地上传', '复制粘贴'] },
  { canonical: 'AI写作', aliases: ['AI写作', 'AI辅助写作', 'AI辅助', 'AI整理表达', 'AI整理', '写作工具栏', '智能写作', '标题开头', '提重点', '文案整理', '理顺标题', '补开头'] },
  { canonical: '智能排版', aliases: ['智能排版', 'AI排版', '自动排版', '一键排版', '排版成稿', '智能成稿', '正文结构', '结构识别'] },
  { canonical: '自动分页', aliases: ['自动分页', '模板分页', '分页成稿', '分页排版', '分页页', '分页功能', '卡片分页', '分页', '分镜', '多页'] },
  { canonical: '水印', aliases: ['水印', '添加水印', '品牌水印', '卡片水印', '素材保护'] },
  { canonical: '违规检测', aliases: ['违规检测', '风险检测', '风险检查', '发前检查', '发布检查', '发布前检测', '发布前检查', '检测页', '检查页', '敏感词', '敏感词检测', '小红书检测'] },
  { canonical: '模板', aliases: ['模板', '模板库', '套模板', '版式模板', '风格模板', '模板套用', '套用模板'] },
  { canonical: 'AI总结', aliases: ['AI总结', '网页总结', '视频总结', 'PDF总结', '图片总结', '总结'] },
  { canonical: '生词本', aliases: ['生词本', '生词', '高亮注释', '单词本', '词汇'] },
  { canonical: '双语对照', aliases: ['双语对照', '双语', '翻译对照', '中英对照'] },
  { canonical: '大模型', aliases: ['大模型', '模型选择', 'AI模型'] },
  { canonical: 'SOP', aliases: ['sop', 'SOP', '标准作业', '自动化SOP', '跟进SOP', 'SOP流程'] },
  { canonical: '群发', aliases: ['群发', '群发助手', '消息群发', '批量触达', '触达'] },
  { canonical: '任务宝', aliases: ['任务宝', '裂变', '拉新', '邀请', '助力'] },
  { canonical: '企业微信', aliases: ['企业微信', '企微', '私域运营', '私域客户'] },
  { canonical: '销售管理', aliases: ['销售管理', '线索管理', '商机管理', '客户跟进', '销售跟进', '转化分析'] },
  { canonical: '产品首页', aliases: ['产品首页', '产品页', '官网首页', '落地页', '主页', 'home'] },
];

const extractMaterialFeatureKeywords = (value: string) => {
  const text = String(value || '').toLowerCase();
  const keywords = materialFeatureKeywordGroups
    .filter((group) => group.aliases.some((alias) => text.includes(alias.toLowerCase())))
    .map((group) => group.canonical);
  const normalized = Array.from(new Set(keywords));
  return normalized.includes('自动分页') ? normalized.filter((keyword) => keyword !== '模板') : normalized;
};

const getMaterialKeywordMatches = (assetText: string, requiredKeywords: string[]) => {
  const assetKeywords = extractMaterialFeatureKeywords(assetText);
  return requiredKeywords.filter((keyword) => assetKeywords.includes(keyword));
};

const getMaterialKeywordRequirement = (requiredKeywords: string[]) => {
  if (requiredKeywords.length <= 1) return requiredKeywords.length;
  return 1;
};

const compactMaterialPlanText = (value: string, limit = 88) => {
  const normalized = sanitizeMarkdownForXhs(String(value || ''))
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/--ar\s+\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trim()}…`;
};

const extractMaterialCopyPlanSnippet = (value: string) => {
  const text = String(value || '');
  const match = text.match(/\[Chinese Copy Plan\]([\s\S]*?)(?:\n\s*\[[^\]]+\]|--ar|$)/i);
  if (!match?.[1]) return '';
  return compactMaterialPlanText(match[1].replace(/^[\s\-*•]+/gm, ''), 70);
};

const buildMaterialVisualFocus = (card: {
  title?: string;
  summary?: string;
  visual_focus?: string;
  visualFocus?: string;
  contentSummary?: string;
  key_message?: string;
  rationale?: string;
  prompt?: string;
}) => {
  const focus = compactMaterialPlanText(card.visualFocus || card.visual_focus || '', 72);
  if (focus) return focus.startsWith('画面重点') ? focus : `画面重点：${focus}`;
  const keyMessage = compactMaterialPlanText(card.key_message || '', 72);
  if (keyMessage) return `画面重点：${keyMessage}`;
  const copyPlan = extractMaterialCopyPlanSnippet(card.prompt || '');
  if (copyPlan) return `画面重点：${copyPlan}`;
  const summary = compactMaterialPlanText(card.contentSummary || card.rationale || card.summary || '', 72);
  if (summary) return `画面重点：${summary}`;
  return compactMaterialPlanText(card.title || '', 72);
};

const extractMaterialRequiredKeywordsForCard = (card: {
  title?: string;
  summary?: string;
  visualFocus?: string;
  visual_focus?: string;
  contentSummary?: string;
}, index: number) => {
  const focusedText = [
    card.title,
    card.visualFocus,
    card.visual_focus,
  ].filter(Boolean).join(' ');
  let keywords = extractMaterialFeatureKeywords(focusedText);
  if (keywords.length === 0) {
    keywords = extractMaterialFeatureKeywords([
      card.contentSummary,
      card.summary,
    ].filter(Boolean).join(' '));
  }
  const limit = index === 0 ? 1 : 2;
  return keywords.slice(0, limit);
};

const isMaterialCardFeatureDriven = (needText: string, requiredKeywords: string[]) => {
  if (requiredKeywords.length > 0) return true;
  return /(功能|步骤|教程|流程|后台|页面|界面|截图|演示|操作|设置|列表|详情|看板|数据|客户|活码|导入|写作|排版|分页|模板|违规|检测|检查|敏感词|水印|群发|任务宝|sop|product|feature|dashboard|screen|screenshot)/i.test(needText);
};

const isMaterialCardBrandOnly = (needText: string) => (
  /(痛点|共鸣|观点|情绪|为什么|适合谁|总结|收口|价值|理念|误区|焦虑|建议|推荐|封面|首图)/i.test(needText)
  && !/(功能|后台|页面|截图|活码|导入|写作|排版|分页|模板|违规|检测|检查|敏感词|水印|客户管理|数据看板|群发|任务宝|sop|步骤|教程|流程)/i.test(needText)
);

const buildMaterialNeedText = (item: Pick<MaterialFusionPlanItem, 'title' | 'summary' | 'role' | 'requiredHint' | 'visualFocus' | 'contentSummary'>) => [
  item.title,
  item.summary,
  item.visualFocus,
  item.contentSummary,
  item.role,
  item.requiredHint,
].filter(Boolean).join(' ').toLowerCase();

const scoreMaterialAssetForNeed = (
  asset: ReferenceAsset,
  needText: string,
  requiredKeywords: string[],
) => {
  const assetText = getReferenceAssetSearchText(asset);
  const role = inferMaterialAssetRole(asset);
  let score = 0;
  if (role === 'competitor_reference' || role === 'logo' || role === 'brand_style') return -100;
  if (role === 'feature_screenshot' && requiredKeywords.length > 0) {
    const overlap = getMaterialKeywordMatches(assetText, requiredKeywords);
    if (overlap.length < getMaterialKeywordRequirement(requiredKeywords)) return -50;
    score += overlap.length * 10;
  }
  if (requiredKeywords.length === 0 && isMaterialCardFeatureDriven(needText, requiredKeywords)) {
    return -40;
  }
  if (role === 'feature_screenshot' && requiredKeywords.length === 0 && !isMaterialCardFeatureDriven(needText, requiredKeywords)) {
    return -30;
  }
  if (role === 'feature_screenshot') score += 4;
  if (role === 'product_page') score += 3;
  if (role === 'supporting') score += 1;
  const needTerms = splitSearchTerms(needText);
  for (const term of needTerms) {
    if (assetText.includes(term)) score += 2;
  }
  if (/(封面|首图|核心|综合|总结|价值|卖点)/.test(needText) && role === 'product_page') score += 4;
  if (/(功能|步骤|能力|客户|数据|分析|看板|后台|设置|列表|详情|导入|写作|排版|分页|模板|违规|检测|检查|敏感词|水印)/.test(needText) && role === 'feature_screenshot') score += 5;
  if ((asset.tags || []).length > 0) score += 1;
  if (asset.ai_hint) score += 2;
  return score;
};

const explainMaterialMatchFailure = (
  needText: string,
  requiredKeywords: string[],
) => {
  if (requiredKeywords.length > 0) {
    return `缺少匹配 ${requiredKeywords.join('、')} 的主素材`;
  }
  if (isMaterialCardFeatureDriven(needText, requiredKeywords)) {
    return '这张卡片需要具体功能图，但文案里没有可和素材标签稳定对齐的功能关键词';
  }
  return '素材库里没有足够贴合这张卡片的主物料';
};

const canUseMaterialAssetAsPrimary = (asset: ReferenceAsset | null | undefined) => {
  if (!asset) return false;
  const role = inferMaterialAssetRole(asset);
  return role !== 'logo' && role !== 'brand_style' && role !== 'competitor_reference';
};

const buildMaterialFusionPlanItems = (params: {
  cards: Array<{ card_type?: string; title?: string; summary?: string; visual_focus?: string; visualFocus?: string; contentSummary?: string; key_message?: string; rationale?: string; prompt?: string }>;
  candidateAssets: ReferenceAsset[];
  globalAssetIds: string[];
  overrides: Record<string, string>;
  fallbackTitle: string;
  fallbackSummary: string;
}): MaterialFusionPlanItem[] => {
  const cards = params.cards.length > 0 ? params.cards : [
    { card_type: 'cover', title: '封面', summary: params.fallbackTitle || params.fallbackSummary || '核心卖点' },
    { card_type: 'feature', title: '功能亮点', summary: params.fallbackSummary || '关键功能说明' },
    { card_type: 'summary', title: '综合总结', summary: params.fallbackSummary || '产品价值总结' },
  ];
  const primaryCandidateAssets = params.candidateAssets.filter((asset) => {
    const role = inferMaterialAssetRole(asset);
    return !params.globalAssetIds.includes(asset.id) && role !== 'logo' && role !== 'brand_style' && role !== 'competitor_reference';
  });
  const usedPrimaryAssetIds = new Set<string>();
  return cards.slice(0, MATERIAL_FUSION_MAX_IMAGE_COUNT).map((card, index) => {
    const id = `${index + 1}-${card.card_type || 'card'}`;
    const contentSummary = compactMaterialPlanText(card.contentSummary || card.summary || card.rationale || card.key_message || '', 96);
    const visualFocus = buildMaterialVisualFocus(card);
    const requiredHint = index === 0
      ? '封面通常需要产品首页、核心页面或可代表产品的主视觉截图'
      : /(总结|综合|收口|价值|闭环|summary|final)/i.test(`${card.card_type} ${card.title} ${card.summary}`)
        ? '综合页可复用产品首页、核心功能页或品牌素材'
        : '功能页最好匹配对应功能截图，避免 AI 编造真实界面';
    const cardIntentText = [
      card.title || `第 ${index + 1} 张`,
      card.summary || '',
      visualFocus,
      contentSummary,
      card.card_type || '',
    ].filter(Boolean).join(' ').toLowerCase();
    const needText = buildMaterialNeedText({
      title: card.title || `第 ${index + 1} 张`,
      summary: card.summary || '',
      visualFocus,
      contentSummary,
      role: card.card_type || '',
      requiredHint,
    });
    const requiredKeywords = extractMaterialRequiredKeywordsForCard({
      title: card.title,
      summary: card.summary,
      visualFocus,
      contentSummary,
    }, index);
    const primaryRequired = !isMaterialCardBrandOnly(cardIntentText) && isMaterialCardFeatureDriven(cardIntentText, requiredKeywords);
    const ranked = primaryCandidateAssets
      .map((asset) => ({ asset, score: scoreMaterialAssetForNeed(asset, needText, requiredKeywords) }))
      .sort((left, right) => {
        if (usedPrimaryAssetIds.has(left.asset.id) !== usedPrimaryAssetIds.has(right.asset.id)) {
          return usedPrimaryAssetIds.has(left.asset.id) ? 1 : -1;
        }
        return right.score - left.score;
      });
    const overrideId = params.overrides[id];
    const overrideAsset = overrideId ? params.candidateAssets.find((asset) => asset.id === overrideId) : null;
    const overrideRank = overrideAsset
      ? ranked.find((item) => item.asset.id === overrideAsset.id) || { asset: overrideAsset, score: scoreMaterialAssetForNeed(overrideAsset, needText, requiredKeywords) }
      : null;
    const overrideCanBePrimary = canUseMaterialAssetAsPrimary(overrideAsset);
    const bestUnused = ranked.find((item) => (
      !usedPrimaryAssetIds.has(item.asset.id)
      && primaryRequired
      && item.score >= MATERIAL_FUSION_AUTO_PRIMARY_SCORE_THRESHOLD
    ));
    const overrideAccepted = Boolean(overrideAsset && overrideCanBePrimary);
    const recommended = overrideAccepted ? overrideAsset : bestUnused?.asset || null;
    const recommendedScore = recommended
      ? ranked.find((item) => item.asset.id === recommended.id)?.score
        ?? (recommended.id === overrideAsset?.id ? overrideRank?.score : undefined)
      : undefined;
    if (recommended?.id) {
      usedPrimaryAssetIds.add(recommended.id);
    }
    const hasPrimary = Boolean(recommended?.id);
    const selectionSource = overrideAccepted ? 'manual' : hasPrimary ? 'auto' : undefined;
    return {
      id,
      index: index + 1,
      title: card.title || `第 ${index + 1} 张`,
      summary: card.summary || '',
      contentSummary,
      visualFocus,
      role: card.card_type || '',
      requiredHint,
      requiredKeywords,
      primaryRequired,
      matchScore: recommendedScore,
      matchReason: recommended
        ? selectionSource === 'manual'
          ? '手动选择：将按这张素材作为主画面生成；如画面内容不贴合，建议换图或补图'
          : requiredKeywords.length > 0
            ? `自动匹配到：${requiredKeywords.join('、')}`
            : '自动匹配到当前卡片的产品/功能素材需求'
        : overrideAsset && !overrideAccepted
          ? '所选素材是 Logo、品牌风格或竞品参考，不能作为主物料；Logo 会作为全局素材进入每张图'
        : primaryRequired
          ? explainMaterialMatchFailure(needText, requiredKeywords)
          : '当前卡片更适合品牌露出或轻风格画面，不自动硬配主素材',
      selectionSource,
      primaryAssetId: recommended?.id,
      globalAssetIds: params.globalAssetIds,
      status: hasPrimary ? 'ready' : 'missing',
      missingReason: hasPrimary
        ? undefined
        : overrideAsset && !overrideAccepted
          ? '所选素材不能作为主物料，请换成产品页或功能截图'
          : primaryRequired
            ? explainMaterialMatchFailure(needText, requiredKeywords)
            : '这张不强制使用主物料，可补充更贴合的产品素材后再生成。',
    };
  });
};

const renderTemplateFramePreview = (frameStyle: TemplateFrameStyle) => {
  switch (frameStyle) {
    case 'sunset_glow_card':
      return (
        <div className="relative h-20 overflow-hidden rounded-2xl border border-orange-200/50 bg-gradient-to-br from-[#fff1df] via-[#ffd8cb] to-[#ffc7bc] p-3">
          <div className="absolute -right-3 -top-4 h-14 w-14 rounded-full bg-orange-300/40 blur-2xl" />
          <div className="absolute bottom-3 left-3 h-9 w-20 rounded-[18px] bg-white/78 shadow-[0_8px_24px_rgba(255,255,255,0.22)]" />
          <div className="absolute bottom-4 right-3 h-5 w-24 rounded-full bg-white/55" />
          <div className="absolute left-3 top-3 h-3 w-12 rounded-full bg-white/70" />
        </div>
      );
    case 'editorial_outline_card':
      return (
        <div className="h-20 rounded-2xl bg-gradient-to-br from-[#fffdf7] to-[#efe6d8] p-3">
          <div className="grid h-full grid-cols-[10px_1fr] gap-3">
            <div className="rounded-sm bg-slate-700/80" />
            <div className="flex flex-col justify-between">
              <div>
                <div className="h-3 w-2/3 rounded bg-slate-900/85" />
                <div className="mt-1.5 h-2 w-4/5 rounded bg-slate-700/55" />
              </div>
              <div className="h-8 rounded-xl border border-slate-700/15 bg-white/72" />
            </div>
          </div>
        </div>
      );
    case 'notebook_tape_card':
      return (
        <div className="h-20 rounded-2xl bg-gradient-to-br from-[#fffdf7] to-[#f5eee1] p-3">
          <div className="flex items-center justify-between">
            <div className="h-5 w-20 rounded-md border border-stone-400/25 border-dashed bg-[#fff7ed]" />
            <div className="flex gap-1">
              <div className="h-3 w-8 rotate-[8deg] rounded bg-yellow-300/55" />
              <div className="h-3 w-8 -rotate-[7deg] rounded bg-sky-300/35" />
            </div>
          </div>
          <div className="mt-2 h-[2px]" style={{ background: 'repeating-linear-gradient(90deg, rgba(120,113,108,0.28) 0 10px, rgba(120,113,108,0) 10px 16px)' }} />
          <div className="mt-3 h-8 rounded-xl border border-stone-400/15 border-dashed bg-white/72" />
        </div>
      );
    case 'split_banner_card':
      return (
        <div className="h-20 rounded-2xl bg-gradient-to-br from-[#f7fafc] to-[#eef3ff] p-3">
          <div className="grid h-full grid-cols-[10px_1fr] gap-3">
            <div className="rounded bg-gradient-to-b from-blue-600 via-cyan-500 to-emerald-500" />
            <div className="flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <div className="h-3 w-16 rounded-full bg-blue-100" />
                <div className="h-2.5 w-12 rounded-full bg-blue-600/15" />
              </div>
              <div className="h-8 rounded-xl bg-white/82" />
            </div>
          </div>
        </div>
      );
    default:
      return (
        <div className="relative h-20 rounded-2xl border border-white/40 bg-gradient-to-br from-[#fff8ef] via-[#ffe9e2] to-[#ffe0e8] p-3">
          <div className="absolute right-4 top-2 h-3 w-12 rotate-[8deg] rounded-[5px] bg-[#ffe4b6]/80" />
          <div className="h-full rounded-[18px] bg-white/90 shadow-[0_10px_30px_rgba(255,255,255,0.16)]" />
        </div>
      );
  }
};

const resolvePreferredRewriteBody = (session?: Partial<RewriteSession> | null, fallback?: string) => {
  const finalBody = sanitizeMarkdownForXhs(session?.final_body || '').trim();
  const deep = sanitizeMarkdownForXhs(session?.deep_polish_body || '').trim();
  const minimal = sanitizeMarkdownForXhs(session?.minimal_polish_body || '').trim();
  const polished = sanitizeMarkdownForXhs(session?.polished_body || '').trim();
  const draft = sanitizeMarkdownForXhs(session?.body_draft || '').trim();
  const fallbackText = sanitizeMarkdownForXhs(fallback || '').trim();

  if (finalBody) {
    return finalBody;
  }

  if (deep) {
    return deep;
  }

  if (minimal) {
    return minimal;
  }

  if (polished && draft) {
    const polishedIsTooShort = polished.length < Math.max(80, Math.floor(draft.length * 0.45));
    if (!polishedIsTooShort) {
      return polished;
    }
    return draft;
  }

  return polished || draft || fallbackText;
};

const REWRITE_SNIPPET_LENGTH = 220;
const REWRITE_LIST_PREVIEW_COUNT = 3;

const buildRewriteSnippet = (value?: string | null, maxLength = REWRITE_SNIPPET_LENGTH) => {
  const normalized = sanitizeMarkdownForXhs(value || '').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}...`;
};

const normalizeRewriteBodyForCompare = (value?: string | null) => sanitizeMarkdownForXhs(value || '').replace(/\s+/g, '');

const dedupeRewriteBodySections = <T extends { content?: string | null; key?: string; derivedFrom?: string }>(sections: T[]) => {
  const seen = new Set<string>();
  return sections.filter((section) => {
    const key = normalizeRewriteBodyForCompare(section.content);
    if (!key) return false;
    if (section.key === 'final' || section.key === section.derivedFrom) {
      seen.add(key);
      return true;
    }
    if (seen.has(key) && section.key !== section.derivedFrom) return false;
    seen.add(key);
    return true;
  });
};

const buildRewriteDiffMeta = (base?: string | null, candidate?: string | null) => {
  const baseKey = normalizeRewriteBodyForCompare(base);
  const candidateKey = normalizeRewriteBodyForCompare(candidate);
  if (!baseKey || !candidateKey) {
    return { changed: false, changedParagraphs: 0, totalParagraphs: 0, changeRatio: 0 };
  }
  const baseParagraphSet = new Set(
    _splitParagraphsForUi(base || '').map((item) => normalizeRewriteBodyForCompare(item)).filter(Boolean)
  );
  const candidateParagraphs = _splitParagraphsForUi(candidate || '');
  const changedParagraphs = candidateParagraphs.filter((paragraph) => {
    const key = normalizeRewriteBodyForCompare(paragraph);
    return key && !baseParagraphSet.has(key);
  }).length;
  let sharedPrefix = 0;
  const maxShared = Math.min(baseKey.length, candidateKey.length);
  while (sharedPrefix < maxShared && baseKey[sharedPrefix] === candidateKey[sharedPrefix]) {
    sharedPrefix += 1;
  }
  const roughChangedChars = Math.max(baseKey.length, candidateKey.length) - sharedPrefix;
  const changeRatio = Math.min(1, roughChangedChars / Math.max(1, candidateKey.length));
  return {
    changed: baseKey !== candidateKey,
    changedParagraphs,
    totalParagraphs: candidateParagraphs.length,
    changeRatio,
  };
};

const resolveRewriteDiffBase = (session?: RewriteSession | null, sectionKey?: string) => {
  if (!session) return '';
  if (sectionKey === 'minimal') return session.body_draft || '';
  if (sectionKey === 'deep') return session.minimal_polish_body || session.body_draft || '';
  if (sectionKey === 'polished' && session.final_body_source === 'deep_polish') {
    return session.minimal_polish_body || session.body_draft || '';
  }
  return session.body_draft || '';
};

const describeRewriteDiffBase = (sectionKey?: string, finalBodySource?: string) => {
  if (sectionKey === 'deep' || (sectionKey === 'polished' && finalBodySource === 'deep_polish')) {
    return '轻改版';
  }
  return '正文主稿';
};

const _splitParagraphsForUi = (value: string) => sanitizeMarkdownForXhs(value || '')
  .split(/\n{2,}|\n/)
  .map((paragraph) => paragraph.trim())
  .filter(Boolean);

const buildRewriteChangePairs = (base?: string | null, candidate?: string | null) => {
  const baseParagraphs = _splitParagraphsForUi(base || '');
  const candidateParagraphs = _splitParagraphsForUi(candidate || '');
  const maxLength = Math.max(baseParagraphs.length, candidateParagraphs.length);
  const pairs: Array<{
    id: string;
    index: number;
    before: string;
    after: string;
    type: 'changed' | 'added' | 'removed';
  }> = [];

  for (let index = 0; index < maxLength; index += 1) {
    const before = baseParagraphs[index] || '';
    const after = candidateParagraphs[index] || '';
    const beforeKey = normalizeRewriteBodyForCompare(before);
    const afterKey = normalizeRewriteBodyForCompare(after);
    if (beforeKey === afterKey) continue;
    pairs.push({
      id: `${index}-${before.slice(0, 8)}-${after.slice(0, 8)}`,
      index,
      before,
      after,
      type: before ? (after ? 'changed' : 'removed') : 'added',
    });
  }

  return pairs;
};

const buildRewriteFullComparePair = (base?: string | null, candidate?: string | null) => {
  const before = sanitizeMarkdownForXhs(base || '').trim();
  const after = sanitizeMarkdownForXhs(candidate || '').trim();
  if (!before && !after) return [];
  return [{
    id: 'full-compare',
    index: 0,
    before,
    after,
    type: before ? (after ? 'changed' : 'removed') : 'added',
  }];
};

const sanitizeRewriteSessionForEditor = (session: RewriteSession): RewriteSession => ({
  ...session,
  title_candidates: Array.isArray(session.title_candidates)
    ? session.title_candidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [],
  opening_candidates: Array.isArray(session.opening_candidates)
    ? session.opening_candidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [],
  content_outline: Array.isArray(session.content_outline)
    ? session.content_outline.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [],
  body_draft: sanitizeMarkdownForXhs(session.body_draft || ''),
  minimal_polish_body: sanitizeMarkdownForXhs(session.minimal_polish_body || ''),
  polished_body: sanitizeMarkdownForXhs(session.polished_body || ''),
  deep_polish_body: sanitizeMarkdownForXhs(session.deep_polish_body || ''),
  final_body: sanitizeMarkdownForXhs(session.final_body || ''),
});

const CREATION_STRATEGY_DRAFT_KEY = 'xhs_creation_strategy_draft';
const CREATION_PRODUCT_BRIEF_COLLAPSED_KEY = 'xhs_creation_product_brief_collapsed';
const CREATION_RUNTIME_STATUS_KEY = 'xhs_creation_runtime_status';
const CREATION_IMAGE_SUBMIT_LOCK_KEY = 'xhs_creation_image_submit_lock';
const CREATION_IMAGE_SUBMIT_LOCK_TTL_MS = 30 * 60 * 1000;
type CreationStatusTone = 'idle' | 'loading' | 'success' | 'error';
type CreationWorkspacePanel = 'product' | 'strategy' | 'draft' | 'visual' | 'support';

type CreationRuntimeStatus = {
  message: string;
  tone: CreationStatusTone;
  updatedAt: string;
};

const readImageSubmitLock = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const stored = window.localStorage.getItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
    if (!stored) {
      return false;
    }
    const parsed = JSON.parse(stored) as { startedAt?: string } | null;
    const startedAt = parsed?.startedAt ? Date.parse(parsed.startedAt) : 0;
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > CREATION_IMAGE_SUBMIT_LOCK_TTL_MS) {
      window.localStorage.removeItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to read image submit lock', error);
    window.localStorage.removeItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
    return false;
  }
};

const readImageSubmitLockPayload = (): { startedAt?: string; clientRequestId?: string; taskIds?: string[] } | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored) as { startedAt?: string; clientRequestId?: string; taskIds?: string[] } | null;
    const startedAt = parsed?.startedAt ? Date.parse(parsed.startedAt) : 0;
    if (!Number.isFinite(startedAt) || Date.now() - startedAt > CREATION_IMAGE_SUBMIT_LOCK_TTL_MS) {
      window.localStorage.removeItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('Failed to read image submit lock payload', error);
    window.localStorage.removeItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
    return null;
  }
};

const createImageClientRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `image-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

interface CreationStrategyDraft {
  productBriefSignature: string;
  strategyMode: 'benchmark_first' | 'research_first';
  benchmarkNoteId: string | null;
  researchContext: ResearchContext | null;
  strategyOptions: NoteStrategy[];
  selectedStrategyId: string;
  updatedAt: string;
}

const buildPendingConfirmationFromSession = (params: {
  session: RewriteSession;
  title?: string;
  noteVisualPlan?: NoteVisualPlan | null;
}): PendingNoteConfirmation => {
  const titleCandidates = Array.isArray(params.session.title_candidates)
    ? params.session.title_candidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [];
  const openingCandidates = Array.isArray(params.session.opening_candidates)
    ? params.session.opening_candidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [];
  const outline = Array.isArray(params.session.content_outline)
    ? params.session.content_outline.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [];
  return {
    title: sanitizeMarkdownForXhs(params.title || titleCandidates[0] || '').trim(),
    opening: sanitizeMarkdownForXhs(openingCandidates[0] || ''),
    outline,
    body: sanitizeMarkdownForXhs(resolvePreferredRewriteBody(params.session)),
    closing: '',
    titleCandidates,
    openingCandidates,
    finalBodySource: String(params.session.final_body_source || 'final'),
    noteVisualPlan: params.noteVisualPlan || null,
    lastCustomInstruction: '',
    lastDetectedScope: null,
    lastReasoningSummary: '',
    lastRevisionResult: null,
    previousSnapshot: null,
    confirmedForImageGeneration: false,
    updatedAt: new Date().toISOString(),
  };
};

const CreationView: React.FC<CreationViewProps> = ({ mode, interviewData, generatedContent, onEnterStudio }) => {
  const { generatedNote, setGeneratedNote, exportGeneratedNoteState, restoreGeneratedNoteState } = useNote();
  const { creationState, setCreationState, exportCreationState, restoreCreationState, rotateDraftSessionKey } = usePersistence();
  const {
    selectedBenchmarkNote,
    setSelectedBenchmarkNote,
    latestProductBrief,
    setLatestProductBrief,
    setProductBriefStatus,
    referenceAssets,
    setReferenceAssets,
    realPhrases,
    rewriteSession,
    setRewriteSession,
  } = useScraperContext();

  const [rewriteMode, setRewriteMode] = useState<RewriteMode>('结构仿写');
  const [imageMode, setImageMode] = useState<ImageMode>('动态表达');
  const [visualStyle, setVisualStyle] = useState(() => normalizeStyleExpressionPreset(creationState.visualStyle));
  const [templatePageCount, setTemplatePageCount] = useState<number>(5);
  const [templateCopyStyle, setTemplateCopyStyle] = useState<(typeof templateCopyStyles)[number]['value']>('通用种草');
  const [templateKind, setTemplateKind] = useState<TemplateKind>('feature_hero');
  const [templateFrameStyle, setTemplateFrameStyle] = useState<TemplateFrameStyle>('soft_gradient_card');
  const [salesIntensity, setSalesIntensity] = useState(45);
  const [colloquialLevel, setColloquialLevel] = useState(75);
  const [authenticityLevel, setAuthenticityLevel] = useState(80);
  const [materialSummary, setMaterialSummary] = useState('');
  const [referenceSummary, setReferenceSummary] = useState('');
  const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
  const [primaryReferenceAssetId, setPrimaryReferenceAssetId] = useState<string>('');
  const [materialPlanOverrides, setMaterialPlanOverrides] = useState<Record<string, string>>({});
  const [materialFusionDraft, setMaterialFusionDraft] = useState<MaterialFusionDraft | null>(null);
  const [isOrganizingAssets, setIsOrganizingAssets] = useState(false);
  const [selectingMaterialItemId, setSelectingMaterialItemId] = useState<string | null>(null);
  const [isUploadingAsset, setIsUploadingAsset] = useState(false);
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [isProductBriefCollapsed, setIsProductBriefCollapsed] = useState(false);
  const [researchContext, setResearchContext] = useState<ResearchContext | null>(null);
  const [strategyOptions, setStrategyOptions] = useState<NoteStrategy[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [strategyFeedback, setStrategyFeedback] = useState('');
  const [isStrategyPanelCollapsed, setIsStrategyPanelCollapsed] = useState(false);
  const [isGeneratingStrategy, setIsGeneratingStrategy] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [hasImageSubmitLock, setHasImageSubmitLock] = useState<boolean>(() => readImageSubmitLock());
  const [cancelableImageTaskIds, setCancelableImageTaskIds] = useState<string[]>([]);
  const [isDraftDrawerOpen, setIsDraftDrawerOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState<CreationStatusTone>('idle');
  const [isStrategyOptionsExpanded, setIsStrategyOptionsExpanded] = useState(false);
  const [isSupportAnalysisOpen, setIsSupportAnalysisOpen] = useState(true);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingNoteConfirmation | null>(generatedNote?.pendingConfirmation || null);
  const [isSuggestedAssetConfirmOpen, setIsSuggestedAssetConfirmOpen] = useState(false);
  const [skipSuggestedAssetsOnce, setSkipSuggestedAssetsOnce] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState('');
  const [selectedRevisionScope, setSelectedRevisionScope] = useState<NoteEditScope | ''>('');
  const [isRevisingNote, setIsRevisingNote] = useState(false);
  const [activeConfirmTool, setActiveConfirmTool] = useState<'custom' | 'structure' | 'tone'>('custom');
  const [isStructurePanelOpen, setIsStructurePanelOpen] = useState(false);
  const [selectedRewriteBodyKey, setSelectedRewriteBodyKey] = useState<string>('final');
  const [isRewriteBodyExpanded, setIsRewriteBodyExpanded] = useState(false);
  const [activeWorkspacePanel, setActiveWorkspacePanel] = useState<CreationWorkspacePanel>('product');
  const cancelGenerationRef = useRef<boolean>(false);
  const activeImageTaskIdsRef = useRef<string[]>([]);
  const activeImagePollingRunRef = useRef(0);
  const activeImageClientRequestIdRef = useRef<string>('');
  const previousStrategySignatureRef = useRef<string>('');
  const autoDraftFingerprintRef = useRef('');
  const autoDraftTimerRef = useRef<number | null>(null);
  const productSectionRef = useRef<HTMLElement | null>(null);
  const strategySectionRef = useRef<HTMLElement | null>(null);
  const confirmationSectionRef = useRef<HTMLDivElement | null>(null);
  const generationConfigSectionRef = useRef<HTMLElement | null>(null);
  const statusBannerRef = useRef<HTMLDivElement | null>(null);
  const hydratedInterviewSignatureRef = useRef('');
  const benchmarkStrategyFocusRef = useRef('');
  const imageGenerationInFlightRef = useRef(false);
  const activeSession = rewriteSession || generatedNote?.rewriteSession || null;
  const effectiveVisualStyle = imageMode === '模板拼装'
    ? getTemplateComposeVisualStyle(templateFrameStyle)
    : isDynamicQualityImageMode(imageMode) || imageMode === '物料融合'
      ? ''
      : visualStyle;

  useEffect(() => {
    const payload = readImageSubmitLockPayload();
    if (payload?.clientRequestId) {
      activeImageClientRequestIdRef.current = payload.clientRequestId;
      imageGenerationInFlightRef.current = true;
      setHasImageSubmitLock(true);
    }
  }, []);
  const productBrief = useMemo(() => normalizeProductBrief({
    ...createEmptyProductBrief(),
    product_name: latestProductBrief?.product_name || interviewData?.productName || creationState.productName || '',
    target_audience: latestProductBrief?.target_audience || interviewData?.targetAudience || creationState.targetAudience || '',
    product_features: latestProductBrief?.product_features || interviewData?.coreFeatures || creationState.productFeatures || '',
    brand_tone: latestProductBrief?.brand_tone || '真实体验感、像真人分享、不硬卖',
    must_include: latestProductBrief?.must_include || '',
    banned_terms: latestProductBrief?.banned_terms || '',
    reference_urls: latestProductBrief?.reference_urls || [],
  }), [creationState.productFeatures, creationState.productName, creationState.targetAudience, interviewData?.coreFeatures, interviewData?.productName, interviewData?.targetAudience, latestProductBrief]);
  const productBriefSignature = useMemo(() => buildProductBriefSignature(productBrief), [productBrief]);
  const missingProductBriefFields = useMemo(() => getMissingProductBriefFields(productBrief), [productBrief]);
  const productBriefCompletionCount = Math.max(0, 3 - missingProductBriefFields.length);
  const hasProductBriefEssentials = missingProductBriefFields.length === 0;
  const productFeaturePreview = buildRewriteSnippet(productBrief.product_features, 150);
  const researchInsightCount = (researchContext?.target_audience_insights?.length || 0)
    + (researchContext?.core_features?.length || 0)
    + (researchContext?.use_cases?.length || 0)
    + (researchContext?.differentiators?.length || 0);
  const selectedReferenceAssetCount = selectedAssetIds.length;
  const strategyMode: 'benchmark_first' | 'research_first' = creationState.strategyMode === 'benchmark_first' && selectedBenchmarkNote
    ? 'benchmark_first'
    : 'research_first';
  const isBenchmarkFirstStrategy = strategyMode === 'benchmark_first';

  useEffect(() => {
    if (mode !== 'interview' || !generatedContent) {
      return;
    }

    const signature = JSON.stringify({
      title: generatedContent.title,
      content: generatedContent.content,
      productName: interviewData?.productName || '',
      coreFeatures: interviewData?.coreFeatures || '',
      targetAudience: interviewData?.targetAudience || '',
      styleDirection: interviewData?.styleDirection || '',
    });
    if (hydratedInterviewSignatureRef.current === signature) {
      return;
    }
    hydratedInterviewSignatureRef.current = signature;

    const nextProductBrief = normalizeProductBrief({
      ...createEmptyProductBrief(),
      product_name: interviewData?.productName || '',
      target_audience: interviewData?.targetAudience || '',
      product_features: interviewData?.coreFeatures || '',
      brand_tone: interviewData?.styleDirection || '真实体验感、像真人分享、不硬卖',
    });
    const nextTitle = sanitizeMarkdownForXhs(generatedContent.title || nextProductBrief.product_name || '访谈生成笔记').trim();
    const nextBody = sanitizeMarkdownForXhs(generatedContent.content || '');
    const nextStyle = normalizeStyleExpressionPreset(interviewData?.styleDirection || visualStyle);
    const firstParagraph = nextBody.split(/\n{2,}|\n/).map((item) => item.trim()).find(Boolean) || '';
    const session = sanitizeRewriteSessionForEditor(generatedContent.rewriteSession || {
      product_info: nextProductBrief,
      rewrite_mode: rewriteMode,
      title_candidates: [nextTitle].filter(Boolean),
      opening_candidates: firstParagraph ? [firstParagraph] : [],
      content_outline: [],
      body_draft: nextBody,
      minimal_polish_body: nextBody,
      polished_body: nextBody,
      final_body: nextBody,
      final_body_source: 'interview',
      replacement_phrases: [],
      tags: [],
      rationale: '来自云端访谈结果。',
      de_ai_report: {
        summary: '已从云端访谈带入初稿，可直接修改确认或继续生成策略。',
      },
      high_risk_ai_sentences: [],
    });
    session.product_info = session.product_info || nextProductBrief;
    session.final_body = sanitizeMarkdownForXhs(session.final_body || nextBody);
    session.polished_body = sanitizeMarkdownForXhs(session.polished_body || session.final_body || nextBody);
    session.body_draft = sanitizeMarkdownForXhs(session.body_draft || session.final_body || nextBody);
    session.title_candidates = session.title_candidates?.length ? session.title_candidates : [nextTitle].filter(Boolean);
    const nextPending = buildPendingConfirmationFromSession({
      session,
      title: nextTitle,
      noteVisualPlan: null,
    });

    setLatestProductBrief(nextProductBrief);
    setCreationState((prev) => ({
      ...prev,
      productName: nextProductBrief.product_name,
      targetAudience: nextProductBrief.target_audience,
      productFeatures: nextProductBrief.product_features,
      visualStyle: nextStyle,
      strategyMode: 'research_first',
    }));
    setVisualStyle(nextStyle);
    setSelectedBenchmarkNote(null);
    setRewriteSession(session);
    setResearchContext(null);
    setStrategyOptions(generatedContent.noteStrategy ? [generatedContent.noteStrategy] : []);
    setSelectedStrategyId(generatedContent.noteStrategy?.id || '');
    setPendingConfirmation(nextPending);
    setRevisionInstruction('');
    setGeneratedNote({
      title: nextTitle,
      content: nextBody,
      finalBody: nextBody,
      style: nextStyle,
      imageMode,
      imageModeLabel: imageMode,
      referenceAssetIds: [],
      primaryReferenceAssetId: '',
      assets: [],
      taskIds: [],
      prompts: [],
      tags: generatedContent.tags || session.tags || [],
      benchmarkNote: null,
      rewriteSession: session,
      productBrief: nextProductBrief,
      researchContext: null,
      strategy: generatedContent.noteStrategy || null,
      strategyOptions: generatedContent.noteStrategy ? [generatedContent.noteStrategy] : [],
      noteVisualPlan: null,
      templateComposeResult: null,
      templateComposeDraft: null,
      templateDraftStatus: null,
      visualProject: null,
      pendingConfirmation: nextPending,
    });

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CREATION_STRATEGY_DRAFT_KEY);
      window.localStorage.removeItem(CREATION_RUNTIME_STATUS_KEY);
      window.localStorage.removeItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
    }
    clearImageSubmitLock();
    setStatus('');
    setStatusTone('idle');
  }, [
    generatedContent,
    imageMode,
    interviewData?.coreFeatures,
    interviewData?.productName,
    interviewData?.styleDirection,
    interviewData?.targetAudience,
    mode,
    rewriteMode,
    setCreationState,
    setGeneratedNote,
    setLatestProductBrief,
    setRewriteSession,
    setSelectedBenchmarkNote,
    visualStyle,
  ]);

  useEffect(() => {
    const fetchReferenceAssets = async () => {
      try {
        const response = await apiClient.getReferenceAssets();
        if (response.success) {
          setReferenceAssets(response.data || []);
        }
      } catch (error) {
        console.error('Failed to fetch reference assets:', error);
      }
    };

    void fetchReferenceAssets();
  }, [setReferenceAssets]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const stored = window.localStorage.getItem(CREATION_PRODUCT_BRIEF_COLLAPSED_KEY);
      if (stored == null) {
        return;
      }
      setIsProductBriefCollapsed(stored === '1');
    } catch (error) {
      console.error('Failed to load product brief collapse state', error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(CREATION_PRODUCT_BRIEF_COLLAPSED_KEY, isProductBriefCollapsed ? '1' : '0');
    } catch (error) {
      console.error('Failed to persist product brief collapse state', error);
    }
  }, [isProductBriefCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const stored = window.localStorage.getItem(CREATION_STRATEGY_DRAFT_KEY);
      if (!stored) {
        return;
      }
      const parsed = JSON.parse(stored) as CreationStrategyDraft | null;
      if (!parsed || parsed.productBriefSignature !== productBriefSignature) {
        return;
      }
      if ((parsed.strategyMode || 'research_first') !== strategyMode) {
        return;
      }
      if ((parsed.benchmarkNoteId || null) !== (selectedBenchmarkNote?.id || null)) {
        return;
      }
      setResearchContext(parsed.researchContext || null);
      setStrategyOptions(Array.isArray(parsed.strategyOptions) ? parsed.strategyOptions : []);
      setSelectedStrategyId(parsed.selectedStrategyId || parsed.strategyOptions?.[0]?.id || '');
    } catch (error) {
      console.error('Failed to restore creation strategy draft', error);
    }
  }, [productBriefSignature, selectedBenchmarkNote?.id, strategyMode]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      if (!researchContext && strategyOptions.length === 0) {
        window.localStorage.removeItem(CREATION_STRATEGY_DRAFT_KEY);
        return;
      }
      const payload: CreationStrategyDraft = {
        productBriefSignature,
        strategyMode,
        benchmarkNoteId: selectedBenchmarkNote?.id || null,
        researchContext,
        strategyOptions,
        selectedStrategyId,
        updatedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(CREATION_STRATEGY_DRAFT_KEY, JSON.stringify(payload));
    } catch (error) {
      console.error('Failed to persist creation strategy draft', error);
    }
  }, [productBriefSignature, researchContext, selectedBenchmarkNote?.id, selectedStrategyId, strategyMode, strategyOptions]);

  useEffect(() => {
    if (!rewriteSession) {
      return;
    }
    const sanitizedSession = sanitizeRewriteSessionForEditor(rewriteSession);
    if (JSON.stringify(sanitizedSession) !== JSON.stringify(rewriteSession)) {
      setRewriteSession(sanitizedSession);
    }
  }, [rewriteSession, setRewriteSession]);

  useEffect(() => {
    const nextPending = generatedNote?.pendingConfirmation || null;
    if (JSON.stringify(nextPending) !== JSON.stringify(pendingConfirmation)) {
      setPendingConfirmation(nextPending);
      setRevisionInstruction(nextPending?.lastCustomInstruction || '');
    }
  }, [generatedNote?.pendingConfirmation]);

  useEffect(() => {
    if (!generatedNote) {
      return;
    }
    if (generatedNote.researchContext && !researchContext) {
      setResearchContext(generatedNote.researchContext);
    }
    if (Array.isArray(generatedNote.strategyOptions) && generatedNote.strategyOptions.length > 0 && strategyOptions.length === 0) {
      setStrategyOptions(generatedNote.strategyOptions);
    }
    const restoredStrategyId = generatedNote.strategy?.id || generatedNote.strategyOptions?.[0]?.id || '';
    if (restoredStrategyId && !selectedStrategyId) {
      setSelectedStrategyId(restoredStrategyId);
    }
  }, [generatedNote, researchContext, selectedStrategyId, strategyOptions.length]);

  useEffect(() => {
    if (pendingConfirmation || !activeSession) {
      return;
    }
    const restoredPending = buildPendingConfirmationFromSession({
      session: activeSession,
      title: generatedNote?.title,
      noteVisualPlan: generatedNote?.noteVisualPlan || null,
    });
    setPendingConfirmation(restoredPending);
    if (generatedNote && !generatedNote.pendingConfirmation) {
      setGeneratedNote({
        ...generatedNote,
        pendingConfirmation: restoredPending,
      });
    }
  }, [activeSession, generatedNote, pendingConfirmation, setGeneratedNote]);

  useEffect(() => {
    if (!pendingConfirmation || !confirmationSectionRef.current) {
      return;
    }
    setActiveWorkspacePanel('draft');
    confirmationSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pendingConfirmation?.updatedAt]);

  useEffect(() => {
    if (pendingConfirmation?.confirmedForImageGeneration) {
      setActiveWorkspacePanel('visual');
    }
  }, [pendingConfirmation?.confirmedForImageGeneration]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const stored = window.localStorage.getItem(CREATION_RUNTIME_STATUS_KEY);
      if (!stored) {
        return;
      }
      const parsed = JSON.parse(stored) as Partial<CreationRuntimeStatus> | null;
      const nextMessage = typeof parsed?.message === 'string' ? parsed.message.trim() : '';
      const nextTone = parsed?.tone === 'loading' || parsed?.tone === 'success' || parsed?.tone === 'error' || parsed?.tone === 'idle'
        ? parsed.tone
        : 'idle';
      if (!nextMessage) {
        return;
      }
      setStatus(nextMessage);
      setStatusTone(nextTone);
    } catch (error) {
      console.error('Failed to restore runtime status', error);
    }
  }, []);

  useEffect(() => {
    const taskIds = generatedNote?.taskIds || [];
    const hasExistingAssets = Boolean(generatedNote?.assets?.length);
    const isTemplateMode = generatedNote?.visualModeResolved === 'template_compose';

    if (!generatedNote || taskIds.length === 0 || hasExistingAssets || isTemplateMode || isGenerating) {
      return;
    }
    const activeTaskKey = activeImageTaskIdsRef.current.join('|');
    if (activeTaskKey && activeTaskKey === taskIds.join('|')) {
      return;
    }

    let cancelled = false;
    const pollingRunId = activeImagePollingRunRef.current + 1;
    activeImagePollingRunRef.current = pollingRunId;
    activeImageTaskIdsRef.current = taskIds;
    setCancelableImageTaskIds(taskIds);
    pushLoadingStatus('检测到上次未完成的出图任务，正在恢复结果...');
    pollTaskStatus(taskIds, generatedNote.prompts || [], pollingRunId)
      .then((assets) => {
        if (cancelled || activeImagePollingRunRef.current !== pollingRunId || assets.length === 0) {
          return;
        }
        setGeneratedNote({
          ...generatedNote,
          assets,
        });
        setCancelableImageTaskIds([]);
        activeImageTaskIdsRef.current = [];
        pushSuccessStatus(`已恢复 ${assets.length} 张已生成图片。`);
      })
      .catch((error) => {
        if (cancelled || activeImagePollingRunRef.current !== pollingRunId) {
          return;
        }
        console.error('Failed to recover pending visual tasks', error);
        pushErrorStatus('上次出图任务未完全完成，已保留初稿和任务记录。');
      });

    return () => {
      cancelled = true;
      if (activeImagePollingRunRef.current === pollingRunId) {
        activeImagePollingRunRef.current += 1;
      }
    };
  }, [generatedNote?.taskIds?.join('|'), generatedNote?.assets?.length, isGenerating]);

  useEffect(() => {
    const hasMeaningfulDraft = Boolean(
      (latestProductBrief?.product_name || '').trim()
      || (creationState.productName || '').trim()
      || (generatedNote?.title || '').trim()
      || (generatedNote?.content || '').trim()
      || (rewriteSession?.body_draft || '').trim()
    );
    if (!hasMeaningfulDraft) {
      return;
    }

    const fingerprint = JSON.stringify({
      draftSessionKey: creationState.draftSessionKey,
      productName: latestProductBrief?.product_name || creationState.productName || '',
      generatedTitle: generatedNote?.title || '',
      generatedContentLength: generatedNote?.content?.length || 0,
      generatedAssetIds: (generatedNote?.assets || []).map((asset) => asset.id).join('|'),
      rewriteBodyLength: rewriteSession?.body_draft?.length || 0,
      selectedBenchmarkNoteId: selectedBenchmarkNote?.id || '',
      referenceAssetIds: referenceAssets.map((asset) => asset.id).join('|'),
      selectedAssetIds: selectedAssetIds.join('|'),
      primaryReferenceAssetId,
      imageMode,
      visualStyle,
      materialSummaryLength: materialSummary.length,
      referenceSummaryLength: referenceSummary.length,
      strategyCount: strategyOptions.length,
      selectedStrategyId,
    });
    if (fingerprint === autoDraftFingerprintRef.current) {
      return;
    }

    if (autoDraftTimerRef.current !== null) {
      window.clearTimeout(autoDraftTimerRef.current);
    }

    autoDraftTimerRef.current = window.setTimeout(() => {
      void saveCreativeDraft('autosave')
        .then(() => {
          autoDraftFingerprintRef.current = fingerprint;
        })
        .catch((error) => {
          console.error('Creative draft autosave failed:', error);
        });
    }, 4000);

    return () => {
      if (autoDraftTimerRef.current !== null) {
        window.clearTimeout(autoDraftTimerRef.current);
        autoDraftTimerRef.current = null;
      }
    };
  }, [
    creationState.draftSessionKey,
    creationState.productName,
    generatedNote?.assets,
    generatedNote?.content,
    generatedNote?.title,
    imageMode,
    latestProductBrief,
    materialSummary,
    primaryReferenceAssetId,
    referenceAssets,
    referenceSummary,
    rewriteSession,
    selectedBenchmarkNote,
    selectedAssetIds,
    selectedStrategyId,
    strategyOptions.length,
    visualStyle,
  ]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        const snapshot = buildCreativeDraftSnapshot();
        if (hasMeaningfulCreativeDraftSnapshot(snapshot)) {
          void saveCreativeDraft('autosave').catch((error) => {
            console.error('Creative draft visibility autosave failed:', error);
          });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [buildCreativeDraftSnapshot, saveCreativeDraft]);

  const selectedReferenceAssets = useMemo(
    () => referenceAssets.filter((asset) => selectedAssetIds.includes(asset.id)),
    [referenceAssets, selectedAssetIds]
  );
  const canUseReferenceAssetsForMode = imageMode === '物料融合' || imageMode === '模板拼装';
  const activeReferenceAssets = canUseReferenceAssetsForMode ? selectedReferenceAssets : [];
  const materialCandidateAssets = imageMode === '物料融合' ? referenceAssets : activeReferenceAssets;
  const activeStrategy = useMemo(
    () => strategyOptions.find((item) => item.id === selectedStrategyId) || strategyOptions[0] || null,
    [selectedStrategyId, strategyOptions]
  );
  const activeProductUsageMode = resolveProductUsageMode(activeStrategy, Boolean(selectedBenchmarkNote)) as keyof typeof productUsageMeta;
  const activeProductUsageMeta = productUsageMeta[activeProductUsageMode] || productUsageMeta.product_main;
  const activeBenchmarkFit = activeStrategy?.benchmarkFit || null;
  const suggestedReferenceAssets = useMemo(() => {
    if (!canUseReferenceAssetsForMode) {
      return [];
    }
    const contextText = [
      productBrief.product_name,
      productBrief.target_audience,
      productBrief.product_features,
      productBrief.must_include,
      materialSummary,
      referenceSummary,
      pendingConfirmation?.title,
      pendingConfirmation?.body,
      activeStrategy?.label,
      activeStrategy?.summary,
    ].filter(Boolean).join('\n');
    return referenceAssets
      .filter((asset) => !selectedAssetIds.includes(asset.id))
      .map((asset) => ({
        asset,
        score: scoreReferenceAssetForContext(asset, contextText, productBrief.product_name),
      }))
      .filter((item) => item.score >= 4)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map((item) => item.asset);
  }, [activeStrategy?.label, activeStrategy?.summary, canUseReferenceAssetsForMode, materialSummary, pendingConfirmation?.body, pendingConfirmation?.title, productBrief, referenceAssets, referenceSummary, selectedAssetIds]);
  const primaryReferenceAsset = useMemo(
    () => activeReferenceAssets.find((asset) => asset.id === primaryReferenceAssetId) || activeReferenceAssets[0] || null,
    [activeReferenceAssets, primaryReferenceAssetId]
  );
  const materialAssetBuckets = useMemo(() => {
    const buckets: Record<MaterialAssetRole, ReferenceAsset[]> = {
      logo: [],
      product_page: [],
      feature_screenshot: [],
      brand_style: [],
      competitor_reference: [],
      supporting: [],
    };
    for (const asset of materialCandidateAssets) {
      buckets[inferMaterialAssetRole(asset)].push(asset);
    }
    return buckets;
  }, [materialCandidateAssets]);
  const globalMaterialAssetIds = useMemo(() => {
    const ids = [
      ...materialAssetBuckets.logo.map((asset) => asset.id),
      ...materialAssetBuckets.brand_style.map((asset) => asset.id),
    ];
    return Array.from(new Set(ids));
  }, [materialAssetBuckets]);
  const materialFusionPreviewPlan = useMemo<MaterialFusionPlanItem[]>(() => {
    const planCards = pendingConfirmation?.noteVisualPlan?.card_plan?.length
      ? pendingConfirmation.noteVisualPlan.card_plan
      : (activeStrategy?.recommendedCardPlan || []).map((item, index) => ({
          card_type: index === 0 ? 'cover' : index === 1 ? 'feature' : index === 2 ? 'feature' : 'summary',
          template_kind: '',
          title: item,
          summary: item,
        }));
    return buildMaterialFusionPlanItems({
      cards: planCards,
      candidateAssets: materialCandidateAssets,
      globalAssetIds: globalMaterialAssetIds,
      overrides: materialPlanOverrides,
      fallbackTitle: pendingConfirmation?.title || productBrief.product_name || '核心卖点',
      fallbackSummary: productBrief.product_features || productBrief.must_include || '产品价值总结',
    });
  }, [activeStrategy?.recommendedCardPlan, globalMaterialAssetIds, materialCandidateAssets, materialPlanOverrides, pendingConfirmation?.noteVisualPlan?.card_plan, pendingConfirmation?.title, productBrief.must_include, productBrief.product_features, productBrief.product_name]);
  const materialFusionPlan = (materialFusionDraft?.planItems || materialFusionPreviewPlan).slice(0, MATERIAL_FUSION_MAX_IMAGE_COUNT);
  const hasMaterialFusionDraft = Boolean(materialFusionDraft);
  const materialFusionReadyItems = materialFusionPlan.filter((item) => item.status === 'ready');
  const materialFusionMissingItems = materialFusionPlan.filter((item) => item.status === 'missing');
  const materialFusionRequiredMissingItems = materialFusionMissingItems.filter((item) => item.primaryRequired !== false);
  const materialFusionSkippedItems = materialFusionMissingItems.filter((item) => item.primaryRequired === false);
  const shouldShowSuggestedReferenceAssets = canUseReferenceAssetsForMode
    && imageMode !== '物料融合'
    && suggestedReferenceAssets.length > 0
    && !hasMaterialFusionDraft;
  const materialFusionPrimaryAssetIds = materialFusionReadyItems
    .map((item) => item.primaryAssetId)
    .filter((item): item is string => Boolean(item));
  const materialFusionWorkflowAssets = imageMode === '物料融合'
    ? materialCandidateAssets.filter((asset) => {
        const relatedIds = new Set<string>([
          ...materialFusionPrimaryAssetIds,
          ...globalMaterialAssetIds,
        ]);
        return relatedIds.has(asset.id);
      })
    : activeReferenceAssets;
  const selectingMaterialItem = selectingMaterialItemId
    ? materialFusionPlan.find((item) => item.id === selectingMaterialItemId) || null
    : null;
  const generationReadinessItems = [
    {
      label: '产品信息',
      value: hasProductBriefEssentials ? '已补齐' : `缺 ${missingProductBriefFields.length} 项`,
      isReady: hasProductBriefEssentials,
    },
    {
      label: '策略方向',
      value: activeStrategy ? activeStrategy.label : '未生成',
      isReady: Boolean(activeStrategy),
    },
    {
      label: '素材辅助',
      value: selectedReferenceAssetCount > 0 ? `已选 ${selectedReferenceAssetCount} 张` : '可选',
      isReady: selectedReferenceAssetCount > 0,
    },
  ];
  const strategyPreviewActionLabel = isGeneratingStrategy
    ? '生成策略中...'
    : activeStrategy
      ? '刷新策略'
      : '预生成策略';
  const pushStatus = (message: string, tone: CreationStatusTone) => {
    setStatus(message);
    setStatusTone(tone);
    if (typeof window !== 'undefined') {
      try {
        const payload: CreationRuntimeStatus = {
          message,
          tone,
          updatedAt: new Date().toISOString(),
        };
        window.localStorage.setItem(CREATION_RUNTIME_STATUS_KEY, JSON.stringify(payload));
      } catch (error) {
        console.error('Failed to persist runtime status', error);
      }
    }
  };
  const pushLoadingStatus = (message: string) => pushStatus(message, 'loading');
  const pushSuccessStatus = (message: string) => pushStatus(message, 'success');
  const pushErrorStatus = (message: string) => pushStatus(message, 'error');
  const currentStepNumber = pendingConfirmation ? 4 : (strategyOptions.length > 0 || researchContext ? 3 : 1);
  const hasDraftOrConfirmedNote = Boolean(pendingConfirmation || activeSession || generatedNote?.rewriteSession);
  const isStrategyStepReady = Boolean(activeStrategy || hasDraftOrConfirmedNote);
  const workspacePanels: Array<{
    key: CreationWorkspacePanel;
    label: string;
    detail: string;
    status: string;
    isReady: boolean;
    isAvailable: boolean;
  }> = [
    {
      key: 'product',
      label: '产品信息',
      detail: hasProductBriefEssentials ? productBrief.product_name || '信息已补齐' : `还缺 ${missingProductBriefFields.length} 项`,
      status: hasProductBriefEssentials ? '已完成' : '待补齐',
      isReady: hasProductBriefEssentials,
      isAvailable: true,
    },
    {
      key: 'strategy',
      label: '策略方案',
      detail: activeStrategy ? activeStrategy.label : strategyOptions.length > 0 ? `${strategyOptions.length} 套策略` : '生成后选择方向',
      status: activeStrategy ? '已选择' : strategyOptions.length > 0 ? '待选择' : '待生成',
      isReady: Boolean(activeStrategy),
      isAvailable: true,
    },
    {
      key: 'draft',
      label: '笔记初稿',
      detail: pendingConfirmation?.title || (activeSession ? '已生成正文' : '策略后生成'),
      status: pendingConfirmation?.confirmedForImageGeneration ? '已确认' : pendingConfirmation ? '待确认' : activeSession ? '可查看' : '待生成',
      isReady: Boolean(pendingConfirmation?.confirmedForImageGeneration),
      isAvailable: true,
    },
    {
      key: 'visual',
      label: '出图配置',
      detail: imageMode === '物料融合'
        ? `物料融合 · ${materialFusionReadyItems.length} 可生成 / ${materialFusionRequiredMissingItems.length} 必选待指定 / ${materialFusionSkippedItems.length} 将跳过`
        : `${imageMode}${selectedReferenceAssetCount > 0 ? ` · ${selectedReferenceAssetCount} 张素材` : ''}`,
      status: pendingConfirmation?.confirmedForImageGeneration ? '可出图' : pendingConfirmation ? '待确认文案' : '待初稿',
      isReady: Boolean(generatedNote?.assets?.length),
      isAvailable: true,
    },
    {
      key: 'support',
      label: '辅助分析',
      detail: activeSession ? `风险句 ${activeSession.high_risk_ai_sentences?.length || 0} 条` : '正文生成后查看',
      status: activeSession ? '可查看' : '待生成',
      isReady: Boolean(activeSession && (activeSession.high_risk_ai_sentences?.length || 0) === 0),
      isAvailable: true,
    },
  ];
  const workflowSteps = [
    {
      key: 'product',
      label: '产品信息',
      detail: hasProductBriefEssentials ? productBrief.product_name || '信息已补齐' : `还缺 ${missingProductBriefFields.length} 项`,
      isReady: hasProductBriefEssentials,
      isActive: !hasProductBriefEssentials,
      ref: productSectionRef,
    },
    {
      key: 'strategy',
      label: '策略方向',
      detail: activeStrategy ? activeStrategy.label : hasDraftOrConfirmedNote ? '已随初稿完成' : '先生成策略',
      isReady: isStrategyStepReady,
      isActive: hasProductBriefEssentials && !isStrategyStepReady,
      ref: strategySectionRef,
    },
    {
      key: 'draft',
      label: '文案确认',
      detail: pendingConfirmation ? (pendingConfirmation.confirmedForImageGeneration ? '已确认' : '待确认') : '生成初稿后出现',
      isReady: Boolean(pendingConfirmation?.confirmedForImageGeneration),
      isActive: Boolean(pendingConfirmation && !pendingConfirmation.confirmedForImageGeneration),
      ref: confirmationSectionRef,
    },
    {
      key: 'visual',
      label: '出图配置',
      detail: `${imageMode}${selectedReferenceAssetCount > 0 ? ` · ${selectedReferenceAssetCount} 张素材` : ''}`,
      isReady: Boolean(pendingConfirmation?.confirmedForImageGeneration),
      isActive: Boolean(pendingConfirmation?.confirmedForImageGeneration),
      ref: generationConfigSectionRef,
    },
  ];
  const scrollToWorkflowSection = (ref: React.RefObject<HTMLElement | HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const supportAnalysisSummary = useMemo(() => ({
    source: activeSession?.final_body_source
      ? (activeSession.final_body_source === 'deep_polish' ? '深改版' : activeSession.final_body_source === 'minimal_polish' ? '轻改版' : '正文主稿')
      : '未生成',
    deAi: activeSession?.de_ai_report?.summary || '暂无去 AI 味摘要',
    riskCount: activeSession?.high_risk_ai_sentences?.length || 0,
  }), [activeSession]);
  const hasGeneratedFlow = Boolean(rewriteSession || pendingConfirmation || generatedNote || researchContext || strategyOptions.length > 0);
  const workflowResetDisabled = isGenerating || isGeneratingStrategy || isRevisingNote;
  const hasExistingStrategyFlow = Boolean(researchContext || strategyOptions.length > 0 || activeStrategy || pendingConfirmation || generatedNote);
  const hasExistingDraftFlow = Boolean(rewriteSession || pendingConfirmation || generatedNote);
  const hasCancelableImageTasks = cancelableImageTaskIds.length > 0;
  const hasRecoverableImageTasks = Boolean(
    generatedNote?.taskIds?.length
    && !generatedNote?.assets?.length
    && generatedNote.visualModeResolved !== 'template_compose'
  );
  const hasActiveImageTasks = isGenerating || hasImageSubmitLock || hasCancelableImageTasks || hasRecoverableImageTasks;

  const persistImageSubmitLock = (clientRequestId?: string, taskIds?: string[]) => {
    imageGenerationInFlightRef.current = true;
    setHasImageSubmitLock(true);
    const nextClientRequestId = clientRequestId || activeImageClientRequestIdRef.current || createImageClientRequestId();
    activeImageClientRequestIdRef.current = nextClientRequestId;
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(CREATION_IMAGE_SUBMIT_LOCK_KEY, JSON.stringify({
          startedAt: new Date().toISOString(),
          clientRequestId: nextClientRequestId,
          taskIds: taskIds || [],
        }));
      } catch (error) {
        console.error('Failed to persist image submit lock', error);
      }
    }
  };

  const clearImageSubmitLock = () => {
    imageGenerationInFlightRef.current = false;
    activeImageClientRequestIdRef.current = '';
    setHasImageSubmitLock(false);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CREATION_IMAGE_SUBMIT_LOCK_KEY);
    }
  };

  const reserveImageGenerationSubmit = () => {
    if (hasActiveImageTasks || imageGenerationInFlightRef.current || readImageSubmitLock()) {
      pushLoadingStatus('已有生图任务正在提交或生成中，请稍候...');
      return '';
    }
    const clientRequestId = createImageClientRequestId();
    persistImageSubmitLock(clientRequestId);
    return clientRequestId;
  };

  const clearLocalImageTaskState = () => {
    setCancelableImageTaskIds([]);
    activeImageTaskIdsRef.current = [];
    clearImageSubmitLock();
    setIsGenerating(false);
    setGeneratedNote((prev) => prev
      ? {
          ...prev,
          taskIds: [],
        }
      : prev
    );
  };

  const structureSummary = useMemo(() => {
    if (!pendingConfirmation?.outline?.length) {
      return '当前未整理结构';
    }
    return pendingConfirmation.outline.slice(0, 4).join(' / ');
  }, [pendingConfirmation?.outline]);

  const syncPendingConfirmationToNote = (nextPending: PendingNoteConfirmation | null, nextSession?: RewriteSession | null) => {
    if (!generatedNote) {
      return;
    }
    setGeneratedNote({
      ...generatedNote,
      title: nextPending?.title || generatedNote.title,
      content: nextPending?.body || generatedNote.content,
      finalBody: nextPending?.body || generatedNote.finalBody,
      rewriteSession: nextSession === undefined ? generatedNote.rewriteSession : nextSession,
      pendingConfirmation: nextPending,
      noteVisualPlan: nextPending?.noteVisualPlan || generatedNote.noteVisualPlan || null,
    });
  };

  const buildConfirmedRewriteSession = (
    session: RewriteSession,
    confirmation: PendingNoteConfirmation,
    confirmedTitle: string,
    confirmedBody: string,
  ) => sanitizeRewriteSessionForEditor({
    ...session,
    title_candidates: [confirmedTitle, ...session.title_candidates.filter((item) => item !== confirmedTitle)].slice(0, 5),
    opening_candidates: [confirmation.opening, ...session.opening_candidates.filter((item) => item !== confirmation.opening)].filter(Boolean).slice(0, 5),
    content_outline: confirmation.outline,
    polished_body: confirmedBody,
    final_body: confirmedBody,
    final_body_source: 'custom_revision',
    revision_notes: confirmation.lastCustomInstruction
      ? [...(session.revision_notes || []), `确认稿修改：${confirmation.lastCustomInstruction}`]
      : (session.revision_notes || []),
  });

  const pollTaskStatus = async (taskIds: string[], prompts: any[], pollingRunId: number): Promise<Asset[]> => {
    activeImageTaskIdsRef.current = taskIds;
    setCancelableImageTaskIds(taskIds);
    const assetMap = new Map<string, Asset>();
    const promptByTaskId = new Map<string, any>();
    taskIds.forEach((taskId, index) => {
      promptByTaskId.set(taskId, prompts[index] || null);
    });
    for (let attempt = 0; attempt < 3600; attempt++) {
      if (activeImagePollingRunRef.current !== pollingRunId) {
        throw new Error('图片轮询已被新的任务接管。');
      }
      if (cancelGenerationRef.current) {
        throw new Error('已手动取消生成。');
      }
      const statusResults = await Promise.allSettled(taskIds.map((taskId) => apiClient.getVisualTaskStatus(taskId)));
      const transientStatusFailures = statusResults.filter((item) => item.status === 'rejected');
      const results = statusResults
        .filter((item): item is PromiseFulfilledResult<any> => item.status === 'fulfilled')
        .map((item) => item.value);
      if (results.length === 0) {
        pushLoadingStatus('状态查询短暂超时，云端生图任务仍在继续，正在重试...');
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      const completed = results.filter((item) => item?.status === 'completed');
      const failed = results.filter((item) => item?.status === 'failed');
      const running = results.filter((item) => item?.status === 'running');
      const pending = results.filter((item) => item?.status === 'pending');

      completed.forEach((task) => {
        const firstImage = task.result?.images?.[0];
        if (firstImage && !assetMap.has(task.task_id)) {
          const promptMeta = promptByTaskId.get(task.task_id);
          assetMap.set(task.task_id, {
            id: task.task_id,
            url: firstImage,
            mode: imageMode,
            promptLabel: promptMeta?.type || `方案 ${taskIds.indexOf(task.task_id) + 1}`,
            promptText: promptMeta?.prompt || '',
            variantKey: promptMeta?.variant_key || promptMeta?.variantKey,
            layoutFamily: promptMeta?.layout_family || promptMeta?.layoutFamily,
            visualFocus: promptMeta?.visual_focus || promptMeta?.visualFocus,
            visualModeResolved: task.metadata?.visual_mode_resolved,
            editSourceAssetId: task.metadata?.edit_source_asset_id,
            editPreservationMode: task.metadata?.edit_preservation_mode,
            referenceAssetIds: task.metadata?.reference_asset_ids,
          });
        }
      });

      const allTerminal = completed.length + failed.length === taskIds.length;

      if (allTerminal) {
        if (activeImagePollingRunRef.current === pollingRunId) {
          setCancelableImageTaskIds([]);
          activeImageTaskIdsRef.current = [];
        }
        const assets = taskIds
          .map((taskId) => assetMap.get(taskId))
          .filter((asset): asset is Asset => Boolean(asset));
        if (assets.length > 0) {
          if (failed.length > 0) {
            pushErrorStatus(`部分图片已完成，${failed.length} 张失败；你可以先继续使用已生成图片。`);
          }
          return assets;
        }
        throw new Error(failed[0]?.error || '图片生成失败');
      }

      const activeProgress = [...running, ...pending].reduce((max, task) => {
        const progress = typeof task?.progress === 'number' ? task.progress : 0;
        return Math.max(max, progress);
      }, 0);
      const activeTasks = [...running, ...pending];
      const activeMessages = activeTasks
        .map((task) => task?.message)
        .filter((message): message is string => Boolean(message && message.trim()));
      const activeProvider = activeTasks.find((task) => task?.metadata?.active_provider)?.metadata?.active_provider;
      const retrying = activeTasks.some((task) => ['retrying', 'fallback_generating'].includes(task?.metadata?.stage));
      const fallbackUsed = activeTasks.some((task) => Boolean(task?.metadata?.fallback_used));
      const headline = activeMessages[0] || (running.length > 0 ? '正在生成图片' : '正在准备图片任务');
      const detail = [
        `实际提交 ${taskIds.length} 张`,
        `已完成 ${completed.length}/${taskIds.length}`,
        running.length > 0 ? `生成中 ${running.length} 张` : null,
        pending.length > 0 ? `等待中 ${pending.length} 张` : null,
        activeProvider ? `当前后端 ${activeProvider}` : null,
        retrying ? '正在重试/切换后端' : null,
        fallbackUsed ? '已启用备用后端' : null,
        activeProgress > 0 ? `当前进度 ${activeProgress}%` : null,
        transientStatusFailures.length > 0 ? `状态查询重试 ${transientStatusFailures.length} 个` : null,
      ].filter(Boolean).join('，');
      if (activeImagePollingRunRef.current === pollingRunId) {
        pushLoadingStatus(detail ? `${headline}（${detail}）` : headline);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    throw new Error('图片生成耗时较长，请稍后回来查看任务结果。');
  };

  const updateProductBriefField = <K extends keyof typeof productBrief>(key: K, value: (typeof productBrief)[K]) => {
    const nextBrief = normalizeProductBrief({
      ...productBrief,
      [key]: value,
    });
    setLatestProductBrief(nextBrief);
    setProductBriefStatus((prev) => ({
      ...prev,
      updatedAt: new Date().toISOString(),
      isDirty: prev.analysisSignature ? prev.analysisSignature !== buildProductBriefSignature(nextBrief) : false,
    }));
  };

  function buildCreativeDraftSnapshot(): CreativeDraftSnapshot {
    const exportedCreationState = exportCreationState();
    const exportedGeneratedNote = exportGeneratedNoteState();
    const creationEditorState: CreationEditorState = {
      rewriteMode,
      imageMode,
      visualStyle,
      templatePageCount,
      templateCopyStyle,
      templateKind,
      templateFrameStyle,
      salesIntensity,
      colloquialLevel,
      authenticityLevel,
      materialSummary,
      referenceSummary,
      selectedAssetIds,
      primaryReferenceAssetId,
      researchContext,
      strategyOptions,
      selectedStrategyId,
    };
    return {
      workspace: exportedGeneratedNote ? 'STUDIO' : 'CREATION',
      session_key: exportedCreationState.draftSessionKey,
      creationState: exportedCreationState,
      creationEditorState,
      generatedNote: exportedGeneratedNote,
      rewriteSession,
      selectedBenchmarkNote: selectedBenchmarkNote || null,
      referenceAssets: serializeReferenceAssetsForDraft(referenceAssets),
      latestProductBrief: productBrief,
      studioContentState: exportedGeneratedNote?.studioDraftState || null,
    };
  }

  async function saveCreativeDraft(mode: 'autosave' | 'manual', explicitTitle?: string) {
    const snapshot = buildCreativeDraftSnapshot();
    if (!hasMeaningfulCreativeDraftSnapshot(snapshot)) {
      return null;
    }

    const title = buildCreativeDraftTitle({
      explicitTitle,
      generatedNote,
      latestProductBrief: productBrief,
    });
    const sourceContext = buildCreativeDraftSourceContext({
      selectedBenchmarkNote,
      latestProductBrief: productBrief,
    });
    const previewPayload = buildCreativeDraftPreview({
      snapshot,
      generatedNote,
      rewriteSession,
      studioContentState: snapshot.studioContentState,
    });

    if (mode === 'autosave') {
      const response = await apiClient.autosaveCreativeDraft({
        title,
        session_key: snapshot.session_key,
        source_context: sourceContext,
        snapshot_version: CREATIVE_DRAFT_SNAPSHOT_VERSION,
        content_payload: snapshot,
        preview_payload: previewPayload,
      });
      return response.data;
    }

    const response = await apiClient.createCreativeDraft({
      title,
      session_key: snapshot.session_key,
      source_context: sourceContext,
      snapshot_version: CREATIVE_DRAFT_SNAPSHOT_VERSION,
      content_payload: snapshot,
      preview_payload: previewPayload,
    });
    rotateDraftSessionKey();
    pushSuccessStatus(`草稿《${title}》已保存到云端草稿箱。`);
    return response.data;
  }

  async function restoreCreativeDraft(draft: CreativeDraftDetail) {
    const snapshot = draft.content_payload;
    restoreCreationState(snapshot.creationState);
    setRewriteMode(snapshot.creationEditorState?.rewriteMode || '结构仿写');
    setImageMode(normalizeImageMode(snapshot.creationEditorState?.imageMode || '动态表达'));
    setVisualStyle(normalizeStyleExpressionPreset(snapshot.creationEditorState?.visualStyle));
    setTemplatePageCount(snapshot.creationEditorState?.templatePageCount || 5);
    setTemplateCopyStyle((snapshot.creationEditorState?.templateCopyStyle as (typeof templateCopyStyles)[number]['value']) || '通用种草');
    setTemplateKind(snapshot.creationEditorState?.templateKind || 'feature_hero');
    setTemplateFrameStyle(snapshot.creationEditorState?.templateFrameStyle || 'soft_gradient_card');
    setSalesIntensity(snapshot.creationEditorState?.salesIntensity ?? 45);
    setColloquialLevel(snapshot.creationEditorState?.colloquialLevel ?? 75);
    setAuthenticityLevel(snapshot.creationEditorState?.authenticityLevel ?? 80);
    setMaterialSummary(snapshot.creationEditorState?.materialSummary || '');
    setReferenceSummary(snapshot.creationEditorState?.referenceSummary || '');
    setSelectedAssetIds(snapshot.creationEditorState?.selectedAssetIds || []);
    setPrimaryReferenceAssetId(snapshot.creationEditorState?.primaryReferenceAssetId || '');
    setResearchContext(snapshot.creationEditorState?.researchContext || null);
    setStrategyOptions(snapshot.creationEditorState?.strategyOptions || []);
    setSelectedStrategyId(snapshot.creationEditorState?.selectedStrategyId || snapshot.creationEditorState?.strategyOptions?.[0]?.id || '');
    restoreGeneratedNoteState(snapshot.generatedNote || null);
    setLatestProductBrief(snapshot.latestProductBrief || null);
    setReferenceAssets(Array.isArray(snapshot.referenceAssets) ? snapshot.referenceAssets : []);
    setSelectedBenchmarkNote(snapshot.selectedBenchmarkNote || null);
    setRewriteSession(snapshot.rewriteSession || null);
    pushSuccessStatus(`已恢复云端草稿《${draft.title}》。`);
    if (snapshot.workspace === 'STUDIO' && snapshot.generatedNote) {
      onEnterStudio();
    }
  }

  async function handleManualSaveCreativeDraft() {
    try {
      const defaultTitle = buildCreativeDraftTitle({
        generatedNote,
        latestProductBrief: productBrief,
      });
      const nextTitle = window.prompt('请输入草稿标题', defaultTitle);
      if (!nextTitle) return;
      await saveCreativeDraft('manual', nextTitle);
    } catch (error) {
      alert(`保存草稿失败：${normalizeAppErrorMessage(error, '未知错误')}`);
    }
  }

  useEffect(() => {
    if (!previousStrategySignatureRef.current) {
      previousStrategySignatureRef.current = productBriefSignature;
      return;
    }
    if (previousStrategySignatureRef.current === productBriefSignature) {
      return;
    }
    previousStrategySignatureRef.current = productBriefSignature;
    setResearchContext(null);
    setStrategyOptions([]);
    setSelectedStrategyId('');
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CREATION_STRATEGY_DRAFT_KEY);
    }
  }, [productBriefSignature]);

  const handleToggleReferenceAsset = (assetId: string) => {
    setSelectedAssetIds((prev) => {
      if (prev.includes(assetId)) {
        const nextIds = prev.filter((id) => id !== assetId);
        if (primaryReferenceAssetId === assetId) {
          setPrimaryReferenceAssetId(nextIds[0] || '');
        }
        return nextIds;
      }
      const nextIds = [...prev, assetId];
      if (!primaryReferenceAssetId) {
        setPrimaryReferenceAssetId(assetId);
      }
      return nextIds;
    });
  };

  const handleApplySuggestedReferenceAssets = () => {
    if (suggestedReferenceAssets.length === 0) return;
    const suggestedIds = suggestedReferenceAssets.map((asset) => asset.id);
    setSelectedAssetIds((prev) => Array.from(new Set([...prev, ...suggestedIds])));
    setPrimaryReferenceAssetId((prev) => prev || suggestedIds[0] || '');
    pushSuccessStatus(`已补充 ${suggestedReferenceAssets.length} 张候选素材，后续出图会作为参考。`);
  };

  const handleConfirmGenerateClick = () => {
    if (imageMode === '物料融合' && !materialFusionDraft) {
      void generateMaterialFusionDraft();
      return;
    }
    if (hasActiveImageTasks || imageGenerationInFlightRef.current || readImageSubmitLock()) {
      pushLoadingStatus('已有生图任务正在提交或生成中，请稍候...');
      return;
    }
    if (shouldShowSuggestedReferenceAssets && !skipSuggestedAssetsOnce) {
      setIsSuggestedAssetConfirmOpen(true);
      return;
    }
    const clientRequestId = reserveImageGenerationSubmit();
    if (!clientRequestId) {
      return;
    }
    setSkipSuggestedAssetsOnce(false);
    void confirmAndGenerateImages(clientRequestId);
  };

  const handleUseSuggestedAssetsAndGenerate = () => {
    const clientRequestId = reserveImageGenerationSubmit();
    if (!clientRequestId) {
      return;
    }
    handleApplySuggestedReferenceAssets();
    setIsSuggestedAssetConfirmOpen(false);
    setSkipSuggestedAssetsOnce(true);
    window.setTimeout(() => {
      void confirmAndGenerateImages(clientRequestId);
    }, 0);
  };

  const handleSkipSuggestedAssetsAndGenerate = () => {
    const clientRequestId = reserveImageGenerationSubmit();
    if (!clientRequestId) {
      return;
    }
    setIsSuggestedAssetConfirmOpen(false);
    setSkipSuggestedAssetsOnce(true);
    window.setTimeout(() => {
      void confirmAndGenerateImages(clientRequestId);
    }, 0);
  };

  const scrollToGenerationConfig = () => {
    setActiveWorkspacePanel('visual');
    generationConfigSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pushSuccessStatus('文案已确认。请在生成配置区确认图片模式、素材和风格后出图。');
  };

  const scrollToConfirmationSection = () => {
    setActiveWorkspacePanel('draft');
    confirmationSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pushSuccessStatus('初稿已生成。请在确认区修改到满意后，再进入出图配置。');
  };

  const clearGeneratedWorkflow = (options: { keepStrategy?: boolean; silent?: boolean } = {}) => {
    cancelGenerationRef.current = true;
    setIsGenerating(false);
    setRewriteSession(null);
    setPendingConfirmation(null);
    setRevisionInstruction('');
    setSelectedRevisionScope('');
    setSelectedRewriteBodyKey('final');
    setIsRewriteBodyExpanded(false);
    setGeneratedNote(null);
    if (!options.keepStrategy) {
      setResearchContext(null);
      setStrategyOptions([]);
      setSelectedStrategyId('');
      setIsStrategyPanelCollapsed(false);
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(CREATION_STRATEGY_DRAFT_KEY);
      }
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(CREATION_RUNTIME_STATUS_KEY);
    }
    if (!options.silent) {
      pushSuccessStatus(options.keepStrategy ? '已清除当前初稿和出图草稿，保留策略方向。' : '已清除当前流程，产品信息、对标笔记和素材选择已保留。');
    }
  };

  useEffect(() => {
    const benchmarkId = selectedBenchmarkNote?.id || '';
    if (mode !== 'scraper' || creationState.strategyMode !== 'benchmark_first' || !benchmarkId) {
      return;
    }

    const focusKey = `${benchmarkId}:${productBriefSignature}`;
    if (benchmarkStrategyFocusRef.current === focusKey) {
      return;
    }

    const previousFocusKey = benchmarkStrategyFocusRef.current;
    benchmarkStrategyFocusRef.current = focusKey;
    if (previousFocusKey && hasGeneratedFlow && !workflowResetDisabled) {
      clearGeneratedWorkflow({ silent: true });
      pushSuccessStatus('已切换对标笔记，请在策略方案里重新生成方向。');
    }
    setActiveWorkspacePanel('strategy');
  }, [
    creationState.strategyMode,
    hasGeneratedFlow,
    mode,
    productBriefSignature,
    selectedBenchmarkNote?.id,
    workflowResetDisabled,
  ]);

  const handleClearGeneratedWorkflow = () => {
    if (!hasGeneratedFlow || isGenerating || isGeneratingStrategy || isRevisingNote) {
      return;
    }
    const confirmed = window.confirm('清除当前策略、初稿、确认稿和出图草稿？产品信息、对标笔记和素材选择会保留。');
    if (!confirmed) {
      return;
    }
    clearGeneratedWorkflow();
  };

  const handleRegenerateStrategy = async () => {
    if (isGenerating || isGeneratingStrategy || isRevisingNote) {
      return;
    }
    const shouldConfirm = Boolean(rewriteSession || pendingConfirmation || generatedNote || strategyOptions.length > 0);
    if (shouldConfirm && !window.confirm('重新生成策略会清除当前初稿、确认稿和出图草稿，继续吗？')) {
      return;
    }
    clearGeneratedWorkflow({ silent: true });
    pushLoadingStatus('已清理旧策略和初稿，正在重新生成策略...');
    window.setTimeout(() => {
      void generateStrategy();
    }, 0);
  };

  const handleRegenerateDraft = async () => {
    if (isGenerating || isGeneratingStrategy || isRevisingNote) {
      return;
    }
    const shouldConfirm = Boolean(rewriteSession || pendingConfirmation || generatedNote);
    if (shouldConfirm && !window.confirm('重新生成初稿会覆盖当前正文、确认稿和出图草稿，当前策略会保留。继续吗？')) {
      return;
    }
    clearGeneratedWorkflow({ keepStrategy: true, silent: true });
    pushLoadingStatus(activeStrategy ? '已清理旧初稿，正在按当前策略重新生成正文...' : '已清理旧初稿，正在先生成策略再写正文...');
    window.setTimeout(() => {
      void generateNoteDraft();
    }, 0);
  };

  const handleUploadReferenceAsset = async (file: File) => {
    try {
      setIsUploadingAsset(true);
      const response = await apiClient.uploadReferenceAsset(file);
      if (!response.success) {
        throw new Error(response.message || '上传失败');
      }
      const uploaded = response.data as ReferenceAsset;
      setReferenceAssets((prev) => [uploaded, ...prev]);
      setSelectedAssetIds((prev) => [uploaded.id, ...prev]);
      setPrimaryReferenceAssetId(uploaded.id);
      pushSuccessStatus(`素材《${uploaded.original_name}》已上传，可用于提示词、构图和产品细节校准。`);
    } catch (error: any) {
      console.error(error);
      alert(`上传素材失败：${normalizeAppErrorMessage(error, '未知错误')}`);
    } finally {
      setIsUploadingAsset(false);
    }
  };

  const handleDeleteReferenceAsset = async (assetId: string) => {
    try {
      setDeletingAssetId(assetId);
      const response = await apiClient.deleteReferenceAsset(assetId);
      if (!response.success) {
        throw new Error(response.message || '删除失败');
      }
      setReferenceAssets((prev) => prev.filter((asset) => asset.id !== assetId));
      setSelectedAssetIds((prev) => prev.filter((id) => id !== assetId));
      if (primaryReferenceAssetId === assetId) {
        const fallbackAsset = referenceAssets.find((asset) => asset.id !== assetId && selectedAssetIds.includes(asset.id));
        setPrimaryReferenceAssetId(fallbackAsset?.id || '');
      }
    } catch (error: any) {
      console.error(error);
      alert(`删除素材失败：${normalizeAppErrorMessage(error, '未知错误')}`);
    } finally {
      setDeletingAssetId(null);
    }
  };

  const handleUpdateReferenceAsset = async (
    assetId: string,
    updates: { display_name?: string; tags?: string[]; ai_hint?: string }
  ) => {
    try {
      const response = await apiClient.updateReferenceAsset(assetId, updates);
      if (!response.success) {
        throw new Error(response.message || '更新失败');
      }
      const updated = response.data as ReferenceAsset;
      setReferenceAssets((prev) => prev.map((asset) => asset.id === assetId ? updated : asset));
      pushSuccessStatus(`素材《${updated.display_name || updated.original_name}》备注已更新。`);
    } catch (error: any) {
      console.error(error);
      alert(`更新素材备注失败：${normalizeAppErrorMessage(error, '未知错误')}`);
    }
  };

  const handleOrganizeReferenceAssets = async () => {
    if (materialCandidateAssets.length === 0) {
      alert('请先上传素材。');
      return;
    }
    try {
      setIsOrganizingAssets(true);
      pushLoadingStatus('正在用 AI 整理素材名称、标签和说明...');
      const response = await apiClient.organizeReferenceAssets({
        asset_ids: materialCandidateAssets.map((asset) => asset.id),
        product_brief: productBrief,
      });
      if (!response.success) {
        throw new Error(response.message || '整理失败');
      }
      const organized = response.data as ReferenceAsset[];
      setReferenceAssets((prev) => prev.map((asset) => organized.find((item) => item.id === asset.id) || asset));
      setMaterialFusionDraft(null);
      setMaterialPlanOverrides({});
      pushSuccessStatus(`已整理 ${response.updated_count ?? organized.length} 张素材，请检查标签后再生成融合方案。`);
    } catch (error: any) {
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      alert(`AI 整理素材失败：${errorMessage}`);
      pushErrorStatus(`AI 整理素材失败：${errorMessage}`);
    } finally {
      setIsOrganizingAssets(false);
    }
  };

  const generateStrategy = async () => {
    cancelGenerationRef.current = false;
    const missingFields = getMissingProductBriefFields(productBrief);
    if (missingFields.length > 0) {
      alert(`请先补全产品参数：${missingFields.join('、')}`);
      return null;
    }

    setLatestProductBrief(productBrief);
    setIsGeneratingStrategy(true);
    pushLoadingStatus(isBenchmarkFirstStrategy ? '正在理解产品资料并贴合对标笔记...' : '正在理解产品资料...');

    try {
      const researchResponse = await apiClient.getOrGenerateProductResearchContext({
        product_brief: productBrief,
        reference_assets: imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets,
        benchmark_note: selectedBenchmarkNote || undefined,
      });
      const nextResearchContext = researchResponse.data;
      if (researchResponse.profile?.product_brief) {
        setLatestProductBrief(researchResponse.profile.product_brief);
      }
      setResearchContext(nextResearchContext);

      pushLoadingStatus(researchResponse.cached ? '已复用产品资料解析缓存，正在生成笔记策略...' : '正在生成笔记策略...');
      const strategyResponse = await apiClient.generateNoteStrategy({
        research_context: nextResearchContext,
        benchmark_note: selectedBenchmarkNote || undefined,
        real_phrases: realPhrases,
        strategy_mode: strategyMode,
        strategy_feedback: strategyFeedback,
      });
      const nextStrategies = strategyResponse.data?.strategies || [];
      const nextSelectedId = strategyResponse.data?.selected_strategy_id || nextStrategies[0]?.id || '';
      const strategyFallbackUsed = Boolean(strategyResponse.data?.fallback_used);
      setStrategyOptions(nextStrategies);
      setSelectedStrategyId(nextSelectedId);
      setIsStrategyPanelCollapsed(false);
      if (strategyFallbackUsed) {
        pushErrorStatus(nextStrategies.length > 0
          ? `模型策略生成未成功，已临时使用本地兜底策略 ${nextStrategies.length} 套。可稍后重生成，或查看云端日志里的 fallback_reason。`
          : '模型策略生成未成功，且本地兜底策略为空，请稍后重试。');
      } else {
        pushSuccessStatus(nextStrategies.length > 0
          ? `${isBenchmarkFirstStrategy ? '已基于对标笔记' : '已基于产品研究'}生成 ${nextStrategies.length} 套笔记策略，先选方向再生成正文和组图。`
          : '笔记策略已生成。');
      }
      return {
        researchContext: nextResearchContext,
        strategies: nextStrategies,
        selectedStrategyId: nextSelectedId,
      };
    } catch (error: any) {
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      alert(`生成策略失败：${errorMessage}`);
      pushErrorStatus(`生成策略失败：${errorMessage}`);
      return null;
    } finally {
      setIsGeneratingStrategy(false);
    }
  };

  const applyPendingConfirmation = (updater: PendingNoteConfirmation | ((prev: PendingNoteConfirmation | null) => PendingNoteConfirmation | null) | null) => {
    const nextPending = typeof updater === 'function'
      ? (updater as (prev: PendingNoteConfirmation | null) => PendingNoteConfirmation | null)(pendingConfirmation)
      : updater;
    setPendingConfirmation(nextPending);
    syncPendingConfirmationToNote(nextPending, rewriteSession || undefined);
  };

  const generateNoteDraft = async () => {
    cancelGenerationRef.current = false;
    const missingFields = getMissingProductBriefFields(productBrief);
    if (missingFields.length > 0) {
      alert(`请先补全产品参数：${missingFields.join('、')}`);
      return;
    }
    let nextResearchContext = researchContext;
    let nextStrategy = activeStrategy;
    let nextStrategyOptions = strategyOptions;
    if (!nextResearchContext || !nextStrategy) {
      const strategyBundle = await generateStrategy();
      if (!strategyBundle) {
        return;
      }
      nextResearchContext = strategyBundle.researchContext;
      nextStrategyOptions = strategyBundle.strategies;
      nextStrategy = strategyBundle.strategies.find((item) => item.id === strategyBundle.selectedStrategyId) || strategyBundle.strategies[0] || null;
      if (!nextStrategy) {
        alert('还没有可用的笔记策略，请先重新生成策略。');
        return;
      }
    }

    setLatestProductBrief(productBrief);

    setIsGenerating(true);
    pushLoadingStatus(isBenchmarkFirstStrategy ? '正在沿着对标笔记方向生成仿写与正文...' : selectedBenchmarkNote ? '正在结合灵感增强器生成仿写与正文...' : '正在根据笔记策略生成正文...');

    try {
      const activeTemplateCopyStyle = templateCopyStyles.find((item) => item.value === templateCopyStyle) || templateCopyStyles[0];
      const effectiveBrandTone = imageMode === '模板拼装'
        ? [productBrief.brand_tone, `笔记文案策略：${activeTemplateCopyStyle.brandTone}`].filter(Boolean).join('；')
        : productBrief.brand_tone;
      const effectiveMustInclude = imageMode === '模板拼装'
        ? [productBrief.must_include, activeTemplateCopyStyle.mustInclude].filter(Boolean).join('；')
        : productBrief.must_include;
      const response = await apiClient.generateContent({
        product_name: productBrief.product_name,
        target_audience: productBrief.target_audience,
        product_features: productBrief.product_features,
        benchmark_note: selectedBenchmarkNote || undefined,
        rewrite_mode: rewriteMode,
        brand_tone: effectiveBrandTone,
        must_include: effectiveMustInclude,
        banned_terms: productBrief.banned_terms,
        real_phrases: realPhrases,
        sales_intensity: salesIntensity,
        colloquial_level: colloquialLevel,
        authenticity_level: authenticityLevel,
        research_context: nextResearchContext,
        note_strategy: nextStrategy,
      });

      if (!response.success) {
        throw new Error(response.message || '生成失败');
      }

      const rawSession: RewriteSession = response.rewrite_session || {
        benchmark_note: selectedBenchmarkNote || undefined,
        product_info: productBrief,
        rewrite_mode: rewriteMode,
        title_candidates: [nextStrategy?.suggestedTitle, response.title].filter((item): item is string => Boolean(item && item.trim())),
        opening_candidates: nextStrategy ? [nextStrategy.summary] : [],
        content_outline: nextStrategy?.recommendedCardPlan || [],
        body_draft: response.content || '',
        minimal_polish_body: response.content || '',
        polished_body: response.final_body || response.content || '',
        final_body: response.final_body || response.content || '',
        final_body_source: 'draft',
        replacement_phrases: [],
        tags: response.tags || [],
        rationale: nextStrategy?.summary || '已根据研究策略生成正文。',
        de_ai_report: {
          summary: isBenchmarkFirstStrategy ? '已沿着对标笔记策略并结合产品研究生成正文。' : selectedBenchmarkNote ? '已结合研究策略和灵感增强器生成正文。' : '已根据产品研究和笔记策略生成正文。',
        },
        high_risk_ai_sentences: [],
      };
      const session = sanitizeRewriteSessionForEditor(rawSession);
      setRewriteSession(session);
      setCreationState((prev) => ({
        ...prev,
        productName: productBrief.product_name,
        targetAudience: productBrief.target_audience,
        productFeatures: productBrief.product_features,
        visualStyle: effectiveVisualStyle,
      }));

      const titleForVisual = sanitizeMarkdownForXhs(session.title_candidates?.[0] || productBrief.product_name);
      const contentForVisual = resolvePreferredRewriteBody(session, generatedContent?.content);
      const noteVisualPlan: NoteVisualPlan | undefined = response.note_visual_plan;

      const nextPending = buildPendingConfirmationFromSession({
        session,
        title: titleForVisual,
        noteVisualPlan: noteVisualPlan || null,
      });
      setPendingConfirmation(nextPending);
      setRevisionInstruction('');
      setGeneratedNote({
        title: sanitizeMarkdownForXhs(titleForVisual),
        content: nextPending.body,
        finalBody: sanitizeMarkdownForXhs(nextPending.body),
        style: effectiveVisualStyle,
        imageMode,
        imageModeLabel: imageMode === '模板拼装' ? `${imageMode} / ${templatePageCount}页 / ${templateCopyStyle}` : imageMode,
        referenceAssetIds: activeReferenceAssets.map((asset) => asset.id),
        primaryReferenceAssetId: primaryReferenceAsset?.id,
        assets: [],
        taskIds: [],
        prompts: [],
        tags: session.tags || [],
        benchmarkNote: selectedBenchmarkNote,
        rewriteSession: session,
        productBrief,
        researchContext: nextResearchContext,
        strategy: nextStrategy,
        strategyOptions: nextStrategyOptions,
        noteVisualPlan: noteVisualPlan || null,
        templateComposeResult: null,
        templateComposeDraft: null,
        templateDraftStatus: null,
        visualProject: null,
        pendingConfirmation: nextPending,
      });
      pushSuccessStatus('笔记初稿已生成，请先确认内容、修改满意后再继续出图。');
    } catch (error: any) {
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      alert(`生成失败：${errorMessage}`);
      pushErrorStatus(`生成失败：${errorMessage}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCancelGeneration = () => {
    if (hasActiveImageTasks) {
      cancelGenerationRef.current = true;
      activeImagePollingRunRef.current += 1;
      const taskIds = Array.from(new Set(cancelableImageTaskIds.length > 0
        ? cancelableImageTaskIds
        : activeImageTaskIdsRef.current.length > 0
        ? activeImageTaskIdsRef.current
        : generatedNote?.taskIds || []));
      clearLocalImageTaskState();
      pushStatus('已取消云端生图任务', 'idle');
      if (taskIds.length > 0) {
        void Promise.allSettled(taskIds.map((taskId) => apiClient.cancelVisualTask(taskId)))
          .then((results) => {
            const failedCount = results.filter((result) => result.status === 'rejected').length;
            if (failedCount > 0) {
              pushErrorStatus(`已停止页面等待，但 ${failedCount} 个云端任务取消失败。`);
              return;
            }
            pushStatus('已取消云端生图任务', 'idle');
          });
      }
    }
  };

  const buildConfirmedMaterialFusionSession = () => {
    if (!pendingConfirmation || !activeSession) {
      return null;
    }
    const confirmedTitle = sanitizeMarkdownForXhs(pendingConfirmation.title || '').trim();
    const confirmedBody = sanitizeMarkdownForXhs(pendingConfirmation.body || '').trim();
    if (!confirmedTitle || !confirmedBody) {
      return null;
    }
    const confirmedSession = buildConfirmedRewriteSession(activeSession, pendingConfirmation, confirmedTitle, confirmedBody);
    return { confirmedTitle, confirmedBody, confirmedSession };
  };

  const buildMaterialFusionPlanFromPrompts = (
    prompts: any[],
    noteVisualPlan: NoteVisualPlan | null,
  ) => {
    const notePlanCards = noteVisualPlan?.card_plan?.length ? noteVisualPlan.card_plan : [];
    const strategyCards = (activeStrategy?.recommendedCardPlan || []).map((item, index) => ({
      card_type: index === 0 ? 'cover' : index === 1 || index === 2 ? 'feature' : 'summary',
      template_kind: '',
      title: item,
      summary: item,
      visualFocus: `画面重点：围绕「${compactMaterialPlanText(item, 28)}」选择对应产品页面或功能截图`,
    }));
    const promptCards = Array.isArray(prompts) && prompts.length > 0
      ? prompts.map((prompt, index) => ({
          card_type: prompt?.type || prompt?.role || `image_${index + 1}`,
          title: prompt?.title || prompt?.key_message || `第 ${index + 1} 张`,
          summary: prompt?.rationale || prompt?.key_message || prompt?.visual_focus || '',
          contentSummary: prompt?.rationale || prompt?.key_message || '',
          visualFocus: buildMaterialVisualFocus(prompt || {}),
          key_message: prompt?.key_message,
          rationale: prompt?.rationale,
          prompt: prompt?.prompt,
        }))
      : [];
    const baseCards = notePlanCards.length > 1
      ? notePlanCards
      : strategyCards.length > 1
        ? strategyCards
        : notePlanCards.length > 0
          ? notePlanCards
          : promptCards;
    const planCards = baseCards.map((card, index) => {
      const promptCard = promptCards[index];
      return {
        ...card,
        contentSummary: compactMaterialPlanText(
          (card as any).contentSummary || card.summary || promptCard?.contentSummary || promptCard?.summary || '',
          96,
        ),
        visualFocus: buildMaterialVisualFocus({
          ...promptCard,
          ...card,
          visualFocus: (card as any).visualFocus || (card as any).visual_focus || promptCard?.visualFocus,
        }),
      };
    });
    return buildMaterialFusionPlanItems({
      cards: planCards,
      candidateAssets: materialCandidateAssets,
      globalAssetIds: globalMaterialAssetIds,
      overrides: materialPlanOverrides,
      fallbackTitle: pendingConfirmation?.title || productBrief.product_name || '核心卖点',
      fallbackSummary: productBrief.product_features || productBrief.must_include || '产品价值总结',
    });
  };

  const generateMaterialFusionDraft = async () => {
    cancelGenerationRef.current = false;
    if (!pendingConfirmation) {
      alert('请先生成笔记初稿。');
      return;
    }
    if (!activeSession) {
      alert('当前初稿上下文已丢失，请重新生成一次笔记初稿。');
      return;
    }
    if (materialCandidateAssets.length === 0) {
      alert('物料融合模式需要先上传或选择素材。');
      return;
    }
    const confirmed = buildConfirmedMaterialFusionSession();
    if (!confirmed) {
      alert('请先补全确认稿标题和正文。');
      return;
    }
    const effectiveVisualStyle = visualStyle;

    setIsGenerating(true);
    pushLoadingStatus('正在生成融合方案和图片提示词...');
    try {
      setRewriteSession(confirmed.confirmedSession);
      const notePlanResponse = await apiClient.generateNoteVisualPlan({
        title: confirmed.confirmedTitle,
        content: confirmed.confirmedBody,
        product_brief: productBrief,
        note_strategy: activeStrategy,
        reference_assets: materialFusionWorkflowAssets.length > 0 ? materialFusionWorkflowAssets : materialCandidateAssets,
      });
      if (cancelGenerationRef.current) throw new Error('已手动取消生成。');
      const nextNoteVisualPlan = notePlanResponse.data;
      const nextPending = {
        ...pendingConfirmation,
        noteVisualPlan: nextNoteVisualPlan,
        confirmedForImageGeneration: true,
        updatedAt: new Date().toISOString(),
      };
      setPendingConfirmation(nextPending);
      syncPendingConfirmationToNote(nextPending, confirmed.confirmedSession);

      const analyzeResult = await apiClient.analyzeContent({
        title: confirmed.confirmedTitle,
        content: confirmed.confirmedBody,
        style: effectiveVisualStyle,
        mode: imageMode,
        material_summary: materialSummary,
        reference_summary: referenceSummary,
        reference_assets: materialCandidateAssets,
        primary_reference_asset_id: primaryReferenceAsset?.id || materialCandidateAssets[0]?.id,
        product_brief: productBrief,
        template_kind: templateKind,
      });
      if (cancelGenerationRef.current) throw new Error('已手动取消生成。');

      const analyzedPrompts = analyzeResult.prompts || [];
      const planItems = buildMaterialFusionPlanFromPrompts(analyzedPrompts, nextNoteVisualPlan || null)
        .slice(0, MATERIAL_FUSION_MAX_IMAGE_COUNT);
      const nextDraft: MaterialFusionDraft = {
        title: confirmed.confirmedTitle,
        content: confirmed.confirmedBody,
        style: effectiveVisualStyle,
        prompts: analyzedPrompts,
        designPlan: analyzeResult.data?.design_plan || null,
        promptStats: analyzeResult.data?.prompt_stats || null,
        noteVisualPlan: nextNoteVisualPlan || null,
        planItems,
        referenceAssetIds: materialCandidateAssets.map((asset) => asset.id),
        primaryReferenceAssetId: planItems.find((item) => item.primaryAssetId)?.primaryAssetId || primaryReferenceAsset?.id,
        createdAt: new Date().toISOString(),
      };
      setMaterialFusionDraft(nextDraft);
      pushSuccessStatus(`融合方案已生成，共 ${planItems.length} 张。请确认每张图的主物料后再出图。`);
    } catch (error: any) {
      if (error.message === '已手动取消生成。') {
        activeImageTaskIdsRef.current = [];
        return;
      }
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      alert(`生成融合方案失败：${errorMessage}`);
      pushErrorStatus(`生成融合方案失败：${errorMessage}`);
    } finally {
      if (!cancelGenerationRef.current) {
        activeImageTaskIdsRef.current = [];
      }
      setIsGenerating(false);
    }
  };

  const confirmAndGenerateImages = async (reservedClientRequestId?: string) => {
    cancelGenerationRef.current = false;
    const existingLock = readImageSubmitLockPayload();
    if (
      (imageGenerationInFlightRef.current && activeImageClientRequestIdRef.current !== reservedClientRequestId)
      || (existingLock?.clientRequestId && existingLock.clientRequestId !== reservedClientRequestId)
    ) {
      pushLoadingStatus('已有生图任务正在提交或生成中，请稍候...');
      return;
    }
    if (!pendingConfirmation) {
      alert('请先生成笔记初稿。');
      return;
    }
    if (!activeSession) {
      alert('当前初稿上下文已丢失，请重新生成一次笔记初稿。');
      return;
    }

    const confirmedTitle = sanitizeMarkdownForXhs(pendingConfirmation.title || '').trim();
    const confirmedBody = sanitizeMarkdownForXhs(pendingConfirmation.body || '').trim();
    if (!confirmedTitle || !confirmedBody) {
      alert('请先补全确认稿标题和正文。');
      return;
    }
    if (imageMode === '物料融合' && materialCandidateAssets.length === 0) {
      alert('物料融合模式需要先选择素材。');
      return;
    }
    if (imageMode === '物料融合' && !materialFusionDraft) {
      alert('请先生成融合方案，再确认素材并出图。');
      return;
    }
    if (imageMode === '物料融合' && materialFusionReadyItems.length === 0) {
      alert('当前融合方案没有可生成的主素材卡片。请补充更贴合笔记内容的产品素材，或改用动态表达/风格表达。');
      return;
    }
    if (imageMode === '物料融合' && materialFusionRequiredMissingItems.length > 0) {
      const missingDetails = materialFusionRequiredMissingItems
        .slice(0, 4)
        .map((item) => `第 ${item.index} 张：${item.missingReason || item.matchReason || '缺少匹配素材'}`)
        .join('\n');
      alert(`物料融合还有 ${materialFusionRequiredMissingItems.length} 张卡片缺少和文案对应的主素材，请补充对应功能截图后再生成。\n${missingDetails}`);
      return;
    }
    
    // 风格表达是独立模式，内部复用 image2 动态质量链路；视觉 preset 只作为风格约束传入。
    const effectiveVisualStyle = imageMode === '模板拼装'
      ? getTemplateComposeVisualStyle(templateFrameStyle)
      : isDynamicQualityImageMode(imageMode) || imageMode === '物料融合'
        ? ''
        : visualStyle;
    const selectedStylePreset = normalizeStyleExpressionPreset(visualStyle);
    const dynamicStyleParams = isDynamicQualityImageMode(imageMode)
      ? {
          intent: materialSummary,
          ...(isStyleExpressionImageMode(imageMode) ? { style_preset: selectedStylePreset } : {}),
        }
      : undefined;

    const clientRequestId = reservedClientRequestId || createImageClientRequestId();
    persistImageSubmitLock(clientRequestId);
    setIsGenerating(true);
    pushLoadingStatus('正在同步确认稿并重新生成视觉规划...');

    let pollingWasSuperseded = false;
    try {
      const confirmedSession = buildConfirmedRewriteSession(activeSession, pendingConfirmation, confirmedTitle, confirmedBody);
      setRewriteSession(confirmedSession);

      const notePlanResponse = imageMode === '物料融合' && materialFusionDraft?.noteVisualPlan
        ? { data: materialFusionDraft.noteVisualPlan }
        : await apiClient.generateNoteVisualPlan({
        title: confirmedTitle,
        content: confirmedBody,
        product_brief: productBrief,
        note_strategy: activeStrategy,
        reference_assets: imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets,
      });
      if (cancelGenerationRef.current) throw new Error('已手动取消生成。');
      const nextNoteVisualPlan = notePlanResponse.data;
      const nextPending = {
        ...pendingConfirmation,
        noteVisualPlan: nextNoteVisualPlan,
        confirmedForImageGeneration: true,
        updatedAt: new Date().toISOString(),
      };
      setPendingConfirmation(nextPending);
      syncPendingConfirmationToNote(nextPending, confirmedSession);

      if (imageMode === '模板拼装') {
        pushLoadingStatus('确认完成，正在生成模板拼装结果...');
        const composeSeriesResult = await apiClient.composeTemplateSeries({
          title: confirmedTitle,
          content: confirmedBody,
          product_brief: productBrief,
          reference_assets: imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets,
          primary_reference_asset_id: primaryReferenceAsset?.id,
          brand_style: effectiveVisualStyle,
          note_visual_plan: nextNoteVisualPlan || null,
          card_count_limit: templatePageCount,
        });
        if (cancelGenerationRef.current) throw new Error('已手动取消生成。');
        let visualProject = await buildVisualProjectFromSeriesResult(composeSeriesResult.data, { status: 'draft' });
        if (cancelGenerationRef.current) throw new Error('已手动取消生成。');
        visualProject = {
          ...visualProject,
          cards: await Promise.all(visualProject.cards.map(async (card) => {
            if (!['feature_hero', 'benefit_grid', 'step_guide'].includes(String(card.templateKind))) {
              return card;
            }
            const nextDocument = {
              ...card.document,
              frameStyle: templateFrameStyle,
            };
            const renderedAsset = await buildTemplateAssetForStudio({
              document: nextDocument,
              sourceAsset: {
                ...card.renderedAsset,
                editablePayload: {
                  ...card.renderedAsset.editablePayload,
                  frameStyle: templateFrameStyle,
                },
              },
              promptLabel: card.cardType,
              promptText: card.summary,
            });
            return {
              ...card,
              document: nextDocument,
              renderedAsset,
            };
          })),
        };
        const firstCard = visualProject.cards[0];
        const firstComposeResult = firstCard?.composeResult
          ? withDocumentFromComposeResult(firstCard.composeResult, effectiveVisualStyle)
          : null;
        const templateDocument = firstCard?.document
          || (firstComposeResult?.document || null)
          || (firstCard?.renderedAsset.editablePayload
            ? editablePayloadToDocument(firstCard.renderedAsset.editablePayload, { brandStyle: effectiveVisualStyle })
            : null);

        setGeneratedNote({
          title: confirmedTitle,
          content: confirmedBody,
          finalBody: confirmedBody,
          style: effectiveVisualStyle,
          imageMode,
          imageModeLabel: `${imageMode} / ${templatePageCount}页 / ${templateCopyStyle}`,
          visualModeResolved: 'template_compose',
          primaryReferenceAssetId: primaryReferenceAsset?.id,
          referenceAssetIds: (imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets).map((asset) => asset.id),
          assets: visualProject.cards.map((card) => card.renderedAsset),
          taskIds: [],
          prompts: [],
          tags: confirmedSession.tags || [],
          benchmarkNote: selectedBenchmarkNote,
          rewriteSession: confirmedSession,
          productBrief,
          researchContext,
          strategy: activeStrategy,
          strategyOptions,
          noteVisualPlan: visualProject.noteVisualPlan || nextNoteVisualPlan || null,
          templateComposeResult: firstComposeResult,
          templateComposeDraft: templateDocument,
          templateDraftStatus: 'draft',
          visualProject,
          pendingConfirmation: nextPending,
        });

        pushSuccessStatus(`模板拼装完成，已生成 ${visualProject.cards.length} 张组图草稿，正在打开编辑器...`);
        setTimeout(() => onEnterStudio(), 300);
        return;
      }

      pushLoadingStatus(imageMode === '物料融合' ? '融合方案已确认，正在提交物料编辑任务...' : '确认完成，正在生成图片提示词...');
      const analyzeResult = imageMode === '物料融合' && materialFusionDraft
        ? {
            prompts: materialFusionDraft.prompts,
            data: {
              design_plan: materialFusionDraft.designPlan || null,
              prompt_stats: materialFusionDraft.promptStats || null,
            },
          }
        : await apiClient.analyzeContent({
        title: confirmedTitle,
        content: confirmedBody,
        style: effectiveVisualStyle,
        mode: imageMode,
        material_summary: materialSummary,
        reference_summary: referenceSummary,
        reference_assets: imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets,
        primary_reference_asset_id: imageMode === '物料融合' ? materialFusionReadyItems[0]?.primaryAssetId || primaryReferenceAsset?.id : primaryReferenceAsset?.id,
        product_brief: productBrief,
        template_kind: templateKind,
        dynamic_style_params: dynamicStyleParams,
      });
      if (cancelGenerationRef.current) throw new Error('已手动取消生成。');

      const analyzedPrompts = analyzeResult.prompts || [];
      const plannedImageCount = Number(
        analyzeResult.data?.recommended_image_count
        ?? analyzeResult.data?.design_plan?.image_count
        ?? 0
      );
      const workflowImageCount = isDynamicQualityImageMode(imageMode)
        ? Math.max(
            1,
            Math.min(
              DYNAMIC_EXPRESSION_MAX_IMAGE_COUNT,
              Number.isFinite(plannedImageCount) && plannedImageCount > 0
                ? Math.floor(plannedImageCount)
                : Math.min(3, analyzedPrompts.length || 3),
            ),
          )
        : imageMode === '物料融合'
          ? Math.max(1, Math.min(MATERIAL_FUSION_MAX_IMAGE_COUNT, materialFusionReadyItems.length))
          : 3;

      pushLoadingStatus(imageMode === '物料融合'
        ? '图片提示词已生成，正在按顺序提交物料融合编辑任务，Logo 和功能图会一起作为参考素材...'
        : '图片提示词已生成，正在提交生图任务...');
      const workflowResult = await apiClient.runWorkflow({
        client_request_id: clientRequestId,
        title: confirmedTitle,
        content: confirmedBody,
        style: effectiveVisualStyle,
        image_count: workflowImageCount,
        mode: imageMode,
        material_summary: materialSummary,
        reference_summary: referenceSummary,
        reference_assets: imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets,
        primary_reference_asset_id: imageMode === '物料融合' ? materialFusionReadyItems[0]?.primaryAssetId || primaryReferenceAsset?.id : primaryReferenceAsset?.id,
        prompts: analyzedPrompts,
        product_brief: productBrief,
        template_kind: templateKind,
        dynamic_style_params: dynamicStyleParams,
        material_fusion_plan: imageMode === '物料融合' ? materialFusionReadyItems : undefined,
        design_plan: analyzeResult.data?.design_plan || null,
        prompt_stats: analyzeResult.data?.prompt_stats || null,
      });
      if (cancelGenerationRef.current) {
        const createdTaskIds = workflowResult.task_ids || [];
        if (createdTaskIds.length > 0) {
          void Promise.allSettled(createdTaskIds.map((taskId) => apiClient.cancelVisualTask(taskId)));
        }
        throw new Error('已手动取消生成。');
      }
      activeImageTaskIdsRef.current = workflowResult.task_ids || [];
      persistImageSubmitLock(clientRequestId, workflowResult.task_ids || []);
      const pollingRunId = activeImagePollingRunRef.current + 1;
      activeImagePollingRunRef.current = pollingRunId;

      pushLoadingStatus(`生图任务已创建，实际提交 ${workflowResult.actual_submitted_count || workflowResult.task_ids?.length || 0} 张，正在调用生成...`);
      const finalPrompts = workflowResult.prompts || analyzeResult.prompts || [];
      flushSync(() => {
        setGeneratedNote({
          title: confirmedTitle,
          content: confirmedBody,
          finalBody: confirmedBody,
          style: effectiveVisualStyle,
          imageMode,
          imageModeLabel: imageMode,
          visualModeResolved: workflowResult.visual_mode_resolved,
          primaryReferenceAssetId: workflowResult.edit_source_asset_id || primaryReferenceAsset?.id,
          editPreservationMode: workflowResult.edit_preservation_mode,
          referenceAssetIds: (imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets).map((asset) => asset.id),
          assets: [],
          taskIds: workflowResult.task_ids || [],
          prompts: finalPrompts,
          tags: confirmedSession.tags || [],
          benchmarkNote: selectedBenchmarkNote,
          rewriteSession: confirmedSession,
          productBrief,
          researchContext,
          strategy: activeStrategy,
          strategyOptions,
          noteVisualPlan: nextNoteVisualPlan || null,
          pendingConfirmation: nextPending,
        });
      });
      const assets = await pollTaskStatus(workflowResult.task_ids || [], finalPrompts, pollingRunId);
      if (activeImagePollingRunRef.current !== pollingRunId || activeImageClientRequestIdRef.current !== clientRequestId) {
        throw new Error('图片轮询已被新的任务接管。');
      }

      setGeneratedNote({
        title: confirmedTitle,
        content: confirmedBody,
        finalBody: confirmedBody,
        style: effectiveVisualStyle,
        imageMode,
        imageModeLabel: imageMode,
        visualModeResolved: workflowResult.visual_mode_resolved,
        primaryReferenceAssetId: workflowResult.edit_source_asset_id || primaryReferenceAsset?.id,
        editPreservationMode: workflowResult.edit_preservation_mode,
        referenceAssetIds: (imageMode === '物料融合' ? materialFusionWorkflowAssets : activeReferenceAssets).map((asset) => asset.id),
        assets,
        taskIds: workflowResult.task_ids || [],
        prompts: finalPrompts,
        tags: confirmedSession.tags || [],
        benchmarkNote: selectedBenchmarkNote,
        rewriteSession: confirmedSession,
        productBrief,
        researchContext,
        strategy: activeStrategy,
        strategyOptions,
        noteVisualPlan: nextNoteVisualPlan || null,
        pendingConfirmation: nextPending,
      });

      pushSuccessStatus('确认稿已完成出图，正在进入工作台...');
      clearImageSubmitLock();
      setTimeout(() => onEnterStudio(), 600);
    } catch (error: any) {
      if (error.message === '图片轮询已被新的任务接管。') {
        pollingWasSuperseded = true;
        return;
      }
      if (error.message === '已手动取消生成。') {
        return;
      }
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      alert(`出图失败：${errorMessage}`);
      pushErrorStatus(`出图失败：${errorMessage}`);
    } finally {
      if (!pollingWasSuperseded) {
        clearImageSubmitLock();
        setIsGenerating(false);
      }
    }
  };

  const applyCustomRevision = async () => {
    if (!pendingConfirmation) {
      alert('请先生成笔记初稿。');
      return;
    }
    if (!activeSession) {
      alert('当前初稿上下文已丢失，请重新生成一次笔记初稿。');
      return;
    }
    const instruction = sanitizeMarkdownForXhs(revisionInstruction || '').trim();
    if (!instruction) {
      alert('请输入修改指令。');
      return;
    }

    setIsRevisingNote(true);
    pushLoadingStatus('正在根据你的指令修改确认稿...');
    try {
      const response = await apiClient.reviseNote({
        title: pendingConfirmation.title,
        opening: pendingConfirmation.opening,
        outline: pendingConfirmation.outline,
        body: pendingConfirmation.body,
        closing: pendingConfirmation.closing,
        instruction,
        selected_scope: selectedRevisionScope || null,
        rewrite_session: activeSession,
        product_brief: productBrief,
        benchmark_note: selectedBenchmarkNote || null,
        note_strategy: activeStrategy,
      });
      const data = response.data as NoteRevisionResult;
      const nextPending: PendingNoteConfirmation = {
        ...pendingConfirmation,
        title: sanitizeMarkdownForXhs(data.updated_fields.title || pendingConfirmation.title).trim(),
        opening: sanitizeMarkdownForXhs(data.updated_fields.opening || pendingConfirmation.opening),
        outline: Array.isArray(data.updated_fields.outline) ? data.updated_fields.outline : pendingConfirmation.outline,
        body: sanitizeMarkdownForXhs(data.updated_fields.body || pendingConfirmation.body),
        closing: sanitizeMarkdownForXhs(data.updated_fields.closing || pendingConfirmation.closing),
        noteVisualPlan: data.note_visual_plan || pendingConfirmation.noteVisualPlan || null,
        lastCustomInstruction: instruction,
        lastDetectedScope: data.detected_scope,
        lastReasoningSummary: data.reasoning_summary,
        lastRevisionResult: data,
        previousSnapshot: {
          title: pendingConfirmation.title,
          opening: pendingConfirmation.opening,
          outline: pendingConfirmation.outline,
          body: pendingConfirmation.body,
          closing: pendingConfirmation.closing,
        },
        confirmedForImageGeneration: false,
        updatedAt: new Date().toISOString(),
      };
      const nextSession = sanitizeRewriteSessionForEditor(data.updated_rewrite_session);
      setRewriteSession(nextSession);
      setPendingConfirmation(nextPending);
      syncPendingConfirmationToNote(nextPending, nextSession);
      pushSuccessStatus('确认稿已更新，你可以继续微调，或者直接确认出图。');
    } catch (error: any) {
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      alert(`修改失败：${errorMessage}`);
      pushErrorStatus(`修改失败：${errorMessage}`);
    } finally {
      setIsRevisingNote(false);
    }
  };

  const revertLastRevision = () => {
    if (!pendingConfirmation?.previousSnapshot) {
      return;
    }
    const nextPending: PendingNoteConfirmation = {
      ...pendingConfirmation,
      ...pendingConfirmation.previousSnapshot,
      previousSnapshot: null,
      confirmedForImageGeneration: false,
      updatedAt: new Date().toISOString(),
    };
    setPendingConfirmation(nextPending);
    syncPendingConfirmationToNote(nextPending, activeSession || undefined);
    pushSuccessStatus('已撤回到上一次修改前的确认稿。');
  };

  const handleToneShortcut = (instruction: string) => {
    setActiveConfirmTool('tone');
    setSelectedRevisionScope('body');
    setRevisionInstruction(instruction);
  };

  useEffect(() => {
    setSelectedRewriteBodyKey('final');
    setIsRewriteBodyExpanded(false);
    if (activeSession) {
      setIsSupportAnalysisOpen(true);
    }
  }, [activeSession?.final_body, activeSession?.body_draft, activeSession?.polished_body, activeSession?.minimal_polish_body, activeSession?.deep_polish_body]);

  const rewriteBodySections = useMemo(() => {
    if (!activeSession) return [];

    const finalBody = activeSession.final_body || resolvePreferredRewriteBody(activeSession);
    const finalSource = activeSession.final_body_source
      ? `最终采用来源：${activeSession.final_body_source === 'deep_polish' ? '深改版' : activeSession.final_body_source === 'minimal_polish' ? '轻改版' : activeSession.final_body_source === 'custom_revision' ? '确认稿' : '正文主稿'}`
      : '';
    const finalSourceLabel = activeSession.final_body_source === 'deep_polish'
      ? '深改版'
      : activeSession.final_body_source === 'minimal_polish'
        ? '轻改版'
        : activeSession.final_body_source === 'custom_revision'
          ? '确认稿'
        : activeSession.final_body_source === 'draft'
          ? '正文主稿'
          : '';

    return dedupeRewriteBodySections([
      {
        key: 'final',
        label: finalSourceLabel ? `最终采用稿（${finalSourceLabel}）` : '最终采用稿',
        content: finalBody,
        derivedFrom: activeSession.final_body_source,
        toneClassName: 'border-sky-500/20 bg-sky-500/8',
        textClassName: 'text-slate-100',
        badge: '优先查看',
        hint: pendingConfirmation ? '当前确认稿将直接用于后续出图。' : (finalSource || '当前用于发布和后续编辑的正文版本。'),
        featured: true,
      },
      {
        key: 'draft',
        label: '正文主稿',
        content: activeSession.body_draft,
        derivedFrom: 'draft',
        toneClassName: 'border-white/10 bg-black/20',
        textClassName: 'text-slate-300',
        badge: '基础稿',
        hint: '原始生成结果，适合对照查看结构完整性。',
        featured: false,
      },
      {
        key: 'polished',
        label: '去 AI 味后稿',
        content: activeSession.polished_body,
        derivedFrom: activeSession.final_body_source,
        toneClassName: 'border-emerald-500/12 bg-emerald-500/5',
        textClassName: 'text-slate-200',
        badge: '润色稿',
        hint: '默认去 AI 味清洗后的版本。',
        featured: false,
      },
      ...(activeSession.final_body_source === 'minimal_polish' ? [] : [{
        key: 'minimal',
        label: '轻改版',
        content: activeSession.minimal_polish_body,
        derivedFrom: 'minimal',
        toneClassName: 'border-emerald-500/12 bg-emerald-500/5',
        textClassName: 'text-slate-200',
        badge: '轻改',
        hint: '保留原始结构的轻量调整版。',
        featured: false,
      }]),
      ...(activeSession.final_body_source === 'deep_polish' ? [] : [{
        key: 'deep',
        label: '深改版',
        content: activeSession.deep_polish_body,
        derivedFrom: 'deep',
        toneClassName: 'border-violet-500/12 bg-violet-500/5',
        textClassName: 'text-slate-200',
        badge: '深改',
        hint: '表达变化更大，适合对比语气和改写力度。',
        featured: false,
      }]),
    ]);
  }, [activeSession, pendingConfirmation]);

  const activeRewriteBodySection = useMemo(() => {
    if (rewriteBodySections.length === 0) return null;
    return rewriteBodySections.find((section) => section.key === selectedRewriteBodyKey) || rewriteBodySections[0];
  }, [rewriteBodySections, selectedRewriteBodyKey]);
  const activeRewriteDiffBase = useMemo(() => (
    resolveRewriteDiffBase(activeSession, activeRewriteBodySection?.key)
  ), [activeRewriteBodySection?.key, activeSession]);
  const activeRewriteDiffBaseLabel = useMemo(() => (
    describeRewriteDiffBase(activeRewriteBodySection?.key, activeSession?.final_body_source)
  ), [activeRewriteBodySection?.key, activeSession?.final_body_source]);
  const activeRewriteDiffMeta = useMemo(() => (
    buildRewriteDiffMeta(activeRewriteDiffBase, activeRewriteBodySection?.content)
  ), [activeRewriteBodySection?.content, activeRewriteDiffBase]);
  const activeRewriteParagraphs = useMemo(() => {
    if (!activeRewriteBodySection?.content) return [];
    const baseParagraphSet = new Set(
      _splitParagraphsForUi(activeRewriteDiffBase).map((item) => normalizeRewriteBodyForCompare(item)).filter(Boolean)
    );
    return _splitParagraphsForUi(activeRewriteBodySection.content).map((paragraph, index) => ({
      id: `${index}-${paragraph.slice(0, 12)}`,
      text: paragraph,
      changed: activeRewriteBodySection.key !== 'draft' && !baseParagraphSet.has(normalizeRewriteBodyForCompare(paragraph)),
    }));
  }, [activeRewriteBodySection?.content, activeRewriteBodySection?.key, activeRewriteDiffBase]);
  const activeRewriteChangePairs = useMemo(() => (
    activeRewriteBodySection?.key === 'draft'
      ? []
      : buildRewriteChangePairs(activeRewriteDiffBase, activeRewriteBodySection?.content)
  ), [activeRewriteBodySection?.content, activeRewriteBodySection?.key, activeRewriteDiffBase]);
  const activeRewriteComparePairs = useMemo(() => {
    if (activeRewriteBodySection?.key === 'draft') return [];
    return activeRewriteChangePairs.length > 0
      ? activeRewriteChangePairs
      : buildRewriteFullComparePair(activeRewriteDiffBase, activeRewriteBodySection?.content);
  }, [activeRewriteBodySection?.content, activeRewriteBodySection?.key, activeRewriteChangePairs, activeRewriteDiffBase]);

  const activeCanvasScope = useMemo<NoteEditScope | ''>(() => {
    const selectedScope = (selectedRevisionScope || '').trim() as NoteEditScope | '';
    if (selectedScope) {
      return selectedScope;
    }
    const detectedScope = String(pendingConfirmation?.lastDetectedScope || '').trim();
    if (detectedScope === 'title' || detectedScope === 'body' || detectedScope === 'outline' || detectedScope === 'full_note') {
      return detectedScope as NoteEditScope;
    }
    return '';
  }, [pendingConfirmation?.lastDetectedScope, selectedRevisionScope]);

  const isTitleScopeActive = activeCanvasScope === 'title' || activeCanvasScope === 'full_note';
  const isBodyScopeActive = activeCanvasScope === 'body' || activeCanvasScope === 'full_note';
  const isTitleRevising = isRevisingNote && isTitleScopeActive;
  const isBodyRevising = isRevisingNote && isBodyScopeActive;

  const deAiScoreCards = useMemo(() => {
    if (!activeSession?.de_ai_report) {
      return [];
    }
    const report = activeSession.de_ai_report;
    return [
      { label: '套话密度', value: report.formula_density ?? '--' },
      { label: '情绪堆叠', value: report.emotion_word_overload ?? '--' },
      { label: '节奏机械感', value: report.sentence_rhythm_risk ?? '--' },
      { label: '评论词差距', value: report.comment_voice_gap ?? '--' },
    ];
  }, [activeSession]);
  const hasDeAiMetric = useMemo(() => {
    const report = activeSession?.de_ai_report;
    if (!report) return false;
    return [
      report.formula_density,
      report.emotion_word_overload,
      report.sentence_rhythm_risk,
      report.comment_voice_gap,
    ].some((value) => typeof value === 'number');
  }, [activeSession?.de_ai_report]);
  const deAiReportRows = useMemo(() => {
    if (!activeSession) return [];
    return [
      {
        label: '报告状态',
        value: hasDeAiMetric ? '已生成量化评分' : '当前稿缺少量化评分',
      },
      {
        label: '采用来源',
        value: supportAnalysisSummary.source,
      },
      activeSession.guardrail_stage ? {
        label: '保护阶段',
        value: activeSession.guardrail_stage === 'deep_polish'
          ? '深改版通过'
          : activeSession.guardrail_stage === 'minimal_polish'
            ? '轻改版通过'
            : '正文主稿保护',
      } : null,
      activeSession.polish_guardrail_reason ? {
        label: '保护原因',
        value: activeSession.polish_guardrail_reason,
      } : null,
      activeSession.guardrail_repairs_applied?.length ? {
        label: '修复记录',
        value: activeSession.guardrail_repairs_applied.slice(0, 3).join('；'),
      } : null,
    ].filter((item): item is { label: string; value: string } => Boolean(item?.value));
  }, [activeSession, hasDeAiMetric, supportAnalysisSummary.source]);

  const statusPresentation = useMemo(() => {
    switch (statusTone) {
      case 'loading':
        return {
          icon: 'progress_activity',
          wrapperClassName: 'border-sky-400/20 bg-sky-400/10 text-sky-50',
          labelClassName: 'text-sky-100/75',
          iconClassName: 'text-sky-200 animate-spin',
          label: '当前任务进行中',
        };
      case 'success':
        return {
          icon: 'check_circle',
          wrapperClassName: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-50',
          labelClassName: 'text-emerald-100/75',
          iconClassName: 'text-emerald-200',
          label: '当前任务已完成',
        };
      case 'error':
        return {
          icon: 'error',
          wrapperClassName: 'border-rose-400/20 bg-rose-400/10 text-rose-50',
          labelClassName: 'text-rose-100/75',
          iconClassName: 'text-rose-200',
          label: '当前任务有异常',
        };
      default:
        return {
          icon: 'notifications',
          wrapperClassName: 'border-white/5 bg-white/[0.03] text-slate-100',
          labelClassName: 'text-slate-400',
          iconClassName: 'text-slate-300',
          label: '当前任务状态',
        };
    }
  }, [statusTone]);

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="px-4 py-6 lg:px-8 lg:py-8">
        <div className="mx-auto grid max-w-[1480px] grid-cols-1 gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="hidden xl:block">
            <div className="custom-scrollbar fixed top-8 z-30 max-h-[calc(100vh-64px)] w-[280px] overflow-y-auto rounded-[30px] border border-slate-700/35 bg-[linear-gradient(180deg,rgba(17,23,34,0.96),rgba(8,10,16,0.98))] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.34)] backdrop-blur-xl">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-slate-600/45 bg-slate-900/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-xhs-red" />
                  Workflow
                </div>
                <div className="mt-4 text-lg font-semibold text-white">笔记制作流程</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">按阶段定位内容，把主要动作留在当前区。</div>
              </div>

              <div className="relative mt-5 space-y-2.5">
                {workflowSteps.map((step, index) => (
                  <button
                    key={step.key}
                    type="button"
                    onClick={() => {
                      const panelKey = step.key === 'visual' ? 'visual' : step.key === 'draft' ? 'draft' : step.key === 'strategy' ? 'strategy' : 'product';
                      setActiveWorkspacePanel(panelKey);
                      scrollToWorkflowSection(step.ref);
                    }}
                    className={`group relative w-full rounded-[20px] border px-3 py-3 text-left transition ${
                      step.isActive
                        ? 'border-xhs-red/35 bg-[linear-gradient(135deg,rgba(255,36,77,0.2),rgba(255,36,77,0.055))] shadow-[0_14px_34px_rgba(255,36,77,0.16)]'
                        : step.isReady
                          ? 'border-emerald-400/12 bg-[linear-gradient(135deg,rgba(52,211,153,0.14),rgba(52,211,153,0.045))] hover:border-emerald-300/20'
                          : 'border-slate-700/45 bg-slate-900/32 hover:border-slate-600/60 hover:bg-slate-800/38'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-4 ring-[#111620] ${
                        step.isReady
                          ? 'bg-emerald-400 text-slate-950 shadow-[0_0_0_1px_rgba(52,211,153,0.28),0_10px_24px_rgba(52,211,153,0.2)]'
                          : step.isActive
                            ? 'bg-xhs-red text-white shadow-[0_0_0_1px_rgba(255,36,77,0.28),0_10px_24px_rgba(255,36,77,0.22)]'
                            : 'bg-white/[0.08] text-slate-500'
                      }`}>
                        {step.isReady ? (
                          <span className="material-symbols-outlined text-[16px]">check</span>
                        ) : (
                          index + 1
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className={`block text-sm font-semibold ${step.isActive || step.isReady ? 'text-white' : 'text-slate-300'}`}>{step.label}</span>
                          {step.isActive && (
                            <span className="rounded-full bg-xhs-red/20 px-2 py-0.5 text-[10px] font-medium text-rose-100">当前</span>
                          )}
                        </span>
                        <span className="mt-1 block truncate text-xs text-slate-500">{step.detail}</span>
                      </span>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-5 overflow-hidden rounded-[22px] border border-slate-700/45 bg-slate-950/34">
                <div className="border-b border-slate-700/40 px-4 py-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">当前动作</div>
                </div>
                <div className="px-4 py-3 text-sm font-medium leading-6 text-white">
                  {pendingConfirmation
                    ? pendingConfirmation.confirmedForImageGeneration
                      ? '检查素材与图片模式后出图'
                      : '确认文案，再进入出图配置'
                    : activeStrategy
                      ? '用当前策略写初稿'
                      : '补齐信息并生成策略'}
                </div>
              </div>
            </div>
          </aside>

          <div className="min-w-0 space-y-8">
          <section className="space-y-2">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h2 className="text-3xl font-bold text-white">研究驱动笔记台</h2>
                <p className="text-slate-400 text-sm">按步骤完成产品理解、策略选择、初稿确认和出图。当前聚焦步骤：Step {currentStepNumber}。</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setIsDraftDrawerOpen(true)}
                  className="h-11 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-200 hover:bg-white/10"
                >
                  创作草稿箱
                </button>
                {hasGeneratedFlow && (
                  <button
                    type="button"
                    onClick={handleClearGeneratedWorkflow}
                    disabled={workflowResetDisabled}
                    className={`h-11 rounded-xl border px-4 text-sm font-medium transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-red-400/24 bg-red-500/[0.08] text-red-100 hover:bg-red-500/15'}`}
                  >
                    清除流程
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleManualSaveCreativeDraft()}
                  className="h-11 rounded-xl bg-white px-4 text-sm font-medium text-slate-900 hover:bg-slate-100"
                >
                  保存草稿
                </button>
              </div>
            </div>
            <div ref={statusBannerRef} className={`sticky top-4 z-20 mt-4 rounded-3xl border px-5 py-4 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur ${statusPresentation.wrapperClassName}`}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className={`text-[11px] font-semibold uppercase tracking-[0.24em] ${statusPresentation.labelClassName}`}>
                    {statusPresentation.label}
                  </div>
                  <div className="mt-2 flex items-start gap-3">
                    <span className={`material-symbols-outlined text-[18px] ${statusPresentation.iconClassName}`}>
                      {statusPresentation.icon}
                    </span>
                    <div className="min-w-0 text-sm leading-6">
                      {status || '当前还没有进行中的任务。生成初稿、修改确认稿、确认出图后的进度都会显示在这里。'}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {hasActiveImageTasks && (
                    <button
                      type="button"
                      onClick={handleCancelGeneration}
                      className="h-9 rounded-xl border border-red-400/30 bg-red-500/15 px-3 text-xs font-semibold text-red-100 transition hover:bg-red-500/25"
                    >
                      取消生图
                    </button>
                  )}
                  <div className="rounded-full border border-white/10 bg-black/10 px-3 py-1.5 text-xs text-white/70">
                    Step {currentStepNumber}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="sticky top-4 z-10 overflow-hidden rounded-[30px] border border-white/[0.06] bg-[linear-gradient(180deg,rgba(18,24,36,0.96),rgba(10,14,22,0.96))] p-3 shadow-[0_22px_70px_rgba(0,0,0,0.28)] backdrop-blur-xl">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-5">
              {workspacePanels.map((panel) => {
                const isSelected = activeWorkspacePanel === panel.key;
                return (
                  <button
                    key={panel.key}
                    type="button"
                    disabled={!panel.isAvailable}
                    onClick={() => setActiveWorkspacePanel(panel.key)}
                    className={`min-h-[88px] rounded-[22px] border px-3 py-3 text-left transition ${
                      isSelected
                        ? 'border-xhs-red/45 bg-[linear-gradient(135deg,rgba(255,36,77,0.22),rgba(255,255,255,0.07))] shadow-[0_14px_34px_rgba(255,36,77,0.16)]'
                        : panel.isAvailable
                          ? 'border-white/8 bg-white/[0.045] hover:border-white/14 hover:bg-white/[0.07]'
                          : 'cursor-not-allowed border-white/[0.04] bg-white/[0.02] opacity-55'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-sm font-semibold ${isSelected || panel.isReady ? 'text-white' : 'text-slate-300'}`}>{panel.label}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        panel.isReady
                          ? 'bg-emerald-400/14 text-emerald-100'
                          : isSelected
                            ? 'bg-xhs-red/20 text-rose-100'
                            : 'bg-white/[0.06] text-slate-400'
                      }`}>
                        {panel.status}
                      </span>
                    </div>
                    <div className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{panel.detail}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {activeWorkspacePanel === 'draft' && !pendingConfirmation && (
            <section className="rounded-3xl border border-dashed border-white/10 bg-xhs-card p-6 text-center">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Step 3 / Draft</div>
              <h3 className="mt-2 text-xl font-semibold text-white">还没有可确认的笔记初稿</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-400">
                可以先在策略方案里选择方向并生成初稿；如果页面刚恢复，系统会自动尝试从已保存正文恢复确认区。
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setActiveWorkspacePanel('strategy')}
                  className="h-11 rounded-xl border border-white/10 bg-white/5 px-5 text-sm font-semibold text-slate-200 hover:bg-white/10"
                >
                  去策略方案
                </button>
                <button
                  type="button"
                  onClick={activeStrategy ? handleRegenerateDraft : generateStrategy}
                  disabled={isGenerating || isGeneratingStrategy}
                  className={`h-11 rounded-xl px-5 text-sm font-semibold ${(isGenerating || isGeneratingStrategy) ? 'cursor-not-allowed bg-slate-700 text-slate-300' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
                >
                  {activeStrategy ? (hasExistingDraftFlow ? '重生成初稿' : '用当前策略写初稿') : strategyPreviewActionLabel}
                </button>
              </div>
            </section>
          )}

          {pendingConfirmation && activeWorkspacePanel === 'draft' && (
            <section ref={confirmationSectionRef} className="scroll-mt-24 space-y-6 overflow-hidden rounded-[36px] border border-white/[0.04] bg-xhs-card/70 p-6 shadow-xl backdrop-blur-md">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="max-w-3xl">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.32em] text-emerald-300/72">Step 4 / Creative Workbench</div>
                  <h3 className="mt-3 text-[34px] font-semibold tracking-[-0.055em] text-white">最后一次精修笔记，再进入图片制作</h3>
                  <p className="mt-2 text-sm text-slate-400">用工作台的方式处理文稿、语气和结构，不再让长框和多余信息干扰你。</p>
                </div>
                <div className="flex flex-wrap gap-2 xl:justify-end">
                  <button
                    type="button"
                    onClick={handleRegenerateDraft}
                    disabled={workflowResetDisabled}
                    className={`h-9 rounded-xl border px-3 text-xs font-semibold transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/[0.05] text-slate-200 hover:bg-white/[0.1]'}`}
                  >
                    重生成初稿
                  </button>
                  <button
                    type="button"
                    onClick={handleRegenerateStrategy}
                    disabled={workflowResetDisabled}
                    className={`h-9 rounded-xl border px-3 text-xs font-semibold transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/[0.05] text-slate-200 hover:bg-white/[0.1]'}`}
                  >
                    重生成策略
                  </button>
                  <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200">来源：{pendingConfirmation.finalBodySource || '初稿'}</span>
                  <span className="rounded-full border border-white/8 bg-white/[0.04] px-3 py-1.5 text-xs text-slate-200">作用域：{pendingConfirmation.lastDetectedScope || '自动'}</span>
                  <span className={`rounded-full px-3 py-1.5 text-xs ${pendingConfirmation.lastCustomInstruction ? 'border border-amber-400/22 bg-amber-400/10 text-amber-100' : 'border border-emerald-400/20 bg-emerald-400/10 text-emerald-100'}`}>
                    {pendingConfirmation.lastCustomInstruction ? '已修改未确认' : '待确认'}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.08fr)_340px] xl:items-start">
                <div className="rounded-[30px] border border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.024),rgba(255,255,255,0.01))] p-4">
                  <div className="w-full rounded-[30px] border border-[#d7cfbe]/18 bg-[linear-gradient(180deg,#f6efe4_0%,#efe5d6_100%)] px-7 py-6 shadow-[0_30px_70px_rgba(0,0,0,0.2)]">
                    <div className="flex items-center justify-between gap-3 border-b border-black/6 pb-4">
                      <div>
                        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#897b65]">Manuscript Canvas</div>
                        <div className="mt-1 text-sm text-[#726755]">像编辑一篇真正要发出去的笔记一样，把内容修到满意。</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]" />
                        <span className="h-2.5 w-2.5 rounded-full bg-[#d5cdbf]" />
                        <span className="h-2.5 w-2.5 rounded-full bg-[#ece5dc]" />
                      </div>
                    </div>

                    <div className="mt-6 space-y-6">
                      <div className={`relative overflow-hidden rounded-[30px] p-2 transition-all ${isTitleScopeActive ? 'bg-emerald-400/10 ring-2 ring-emerald-400/45 shadow-[0_0_0_1px_rgba(16,185,129,0.08)]' : ''} ${isTitleRevising ? 'manuscript-revising-shell' : ''}`}>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <label className="block text-[11px] uppercase tracking-[0.18em] text-[#897b65]">标题</label>
                          {isTitleScopeActive ? (
                            <span className="rounded-full border border-emerald-500/25 bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                              {isTitleRevising ? '修改中' : '当前选中'}
                            </span>
                          ) : null}
                        </div>
                        <div className="relative">
                          <textarea
                            value={pendingConfirmation.title}
                            onChange={(e) => applyPendingConfirmation((prev) => prev ? { ...prev, title: e.target.value, confirmedForImageGeneration: false, updatedAt: new Date().toISOString() } : prev)}
                            rows={2}
                            className={`min-h-[108px] w-full rounded-[26px] border bg-white/48 px-5 py-4 text-[30px] font-semibold leading-[1.22] tracking-[-0.05em] text-[#171311] resize-none placeholder:text-[#ac9f8d] shadow-[inset_0_1px_0_rgba(255,255,255,0.58)] ${
                              isTitleScopeActive ? 'border-emerald-500/35' : 'border-black/8'
                            } ${isTitleRevising ? 'opacity-70 blur-[1.2px]' : ''}`}
                            placeholder="输入这篇笔记的标题"
                          />
                          {isTitleRevising ? (
                            <div className="manuscript-revising-overlay pointer-events-none absolute inset-0 rounded-[26px]">
                              <div className="manuscript-revising-sheen" />
                              <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
                                <span className="rounded-full border border-emerald-500/25 bg-white/55 px-3 py-1.5 text-xs font-medium text-emerald-800 shadow-sm backdrop-blur-md">
                                  正在修改标题...
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className={`relative overflow-hidden rounded-[30px] p-2 transition-all ${isBodyScopeActive ? 'bg-emerald-400/10 ring-2 ring-emerald-400/45 shadow-[0_0_0_1px_rgba(16,185,129,0.08)]' : ''} ${isBodyRevising ? 'manuscript-revising-shell' : ''}`}>
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <label className="block text-[11px] uppercase tracking-[0.18em] text-[#897b65]">正文</label>
                          {isBodyScopeActive ? (
                            <span className="rounded-full border border-emerald-500/25 bg-emerald-500/12 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                              {isBodyRevising ? '修改中' : '当前选中'}
                            </span>
                          ) : null}
                        </div>
                        <div className={`relative rounded-[28px] border bg-white/40 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.52)] ${isBodyScopeActive ? 'border-emerald-500/35' : 'border-black/8'}`}>
                          <textarea
                            value={pendingConfirmation.body}
                            onChange={(e) => applyPendingConfirmation((prev) => prev ? { ...prev, body: e.target.value, confirmedForImageGeneration: false, updatedAt: new Date().toISOString() } : prev)}
                            rows={14}
                            className={`h-[420px] max-h-[52vh] w-full rounded-[22px] bg-transparent px-4 py-4 text-[17px] leading-8 text-[#26211d] resize-none placeholder:text-[#ac9f8d] ${isBodyRevising ? 'opacity-70 blur-[1.2px]' : ''}`}
                            placeholder="直接改正文，不需要先看候选。"
                          />
                          {isBodyRevising ? (
                            <div className="manuscript-revising-overlay pointer-events-none absolute inset-0 rounded-[28px]">
                              <div className="manuscript-revising-sheen" />
                              <div className="absolute inset-x-0 top-5 flex justify-center">
                                <span className="rounded-full border border-emerald-500/25 bg-white/55 px-3 py-1.5 text-xs font-medium text-emerald-800 shadow-sm backdrop-blur-md">
                                  正在修改正文...
                                </span>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-4 text-xs text-[#7d7262]">
                        <span>{pendingConfirmation.body.trim().length} 字</span>
                        <span>最近更新：{new Date(pendingConfirmation.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                        <span>{pendingConfirmation.lastCustomInstruction ? '当前有未确认修改' : '当前内容还未确认'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex min-h-[540px] flex-col rounded-[30px] border border-white/5 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">AI 优化工具箱</div>

                    <div className="mt-4 space-y-3">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveConfirmTool('custom');
                          setIsStructurePanelOpen(false);
                        }}
                        className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${activeConfirmTool === 'custom' ? 'border-cyan-400/50 bg-cyan-400/8 shadow-[0_10px_30px_rgba(56,189,248,0.12)]' : 'border-white/8 bg-white/[0.03] hover:border-white/14'}`}
                      >
                        <div className="text-sm font-semibold text-white">自定义指令</div>
                        <div className="mt-1 text-xs text-slate-400">输入一句要求，系统帮你定向优化</div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveConfirmTool('structure');
                          setIsStructurePanelOpen((prev) => !prev);
                        }}
                        className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${activeConfirmTool === 'structure' ? 'border-emerald-400/45 bg-emerald-400/8 shadow-[0_10px_30px_rgba(52,211,153,0.1)]' : 'border-white/8 bg-white/[0.03] hover:border-white/14'}`}
                      >
                        <div className="text-sm font-semibold text-white">结构调整</div>
                        <div className="mt-1 text-xs text-slate-400 line-clamp-2">当前结构：{structureSummary}</div>
                      </button>

                      <button
                        type="button"
                        onClick={() => setActiveConfirmTool('tone')}
                        className={`w-full rounded-[22px] border px-4 py-4 text-left transition ${activeConfirmTool === 'tone' ? 'border-violet-400/45 bg-violet-400/8 shadow-[0_10px_30px_rgba(167,139,250,0.1)]' : 'border-white/8 bg-white/[0.03] hover:border-white/14'}`}
                      >
                        <div className="text-sm font-semibold text-white">语气优化</div>
                        <div className="mt-1 text-xs text-slate-400">更口语、更真实、更利落</div>
                      </button>
                    </div>

                    <div className="mt-4 min-h-[180px]">
                    {activeConfirmTool === 'custom' && (
                      <div className="rounded-[24px] border border-white/8 bg-black/20 p-4">
                        <div className="grid grid-cols-4 gap-2 rounded-2xl bg-white/[0.03] p-1">
                          {[
                            { key: '', label: '自动' },
                            { key: 'title', label: '标题' },
                            { key: 'body', label: '正文' },
                            { key: 'full_note', label: '整篇' },
                          ].map((item) => {
                            const active = (selectedRevisionScope || '') === item.key;
                            return (
                              <button
                                key={item.key || 'auto'}
                                type="button"
                                onClick={() => setSelectedRevisionScope(item.key as NoteEditScope | '')}
                                className={`h-10 rounded-xl text-sm transition ${active ? 'bg-white text-slate-900 font-medium' : 'text-slate-300 hover:bg-white/5'}`}
                              >
                                {item.label}
                              </button>
                            );
                          })}
                        </div>
                        <input
                          value={revisionInstruction}
                          onChange={(e) => setRevisionInstruction(e.target.value)}
                          placeholder="例如：整篇更口语；标题更像真实分享"
                          className="mt-4 h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-white placeholder:text-slate-600"
                        />
                      </div>
                    )}

                    {activeConfirmTool === 'structure' && isStructurePanelOpen && (
                      <div className="rounded-[24px] border border-emerald-500/15 bg-emerald-500/[0.05] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.18em] text-emerald-200/70">结构摘要</div>
                            <div className="mt-2 text-sm leading-6 text-slate-200 line-clamp-3">{structureSummary}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setIsStructurePanelOpen(false)}
                            className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-slate-300 hover:bg-white/[0.08]"
                          >
                            收起
                          </button>
                        </div>
                        <textarea
                          value={pendingConfirmation.outline.join('\n')}
                          onChange={(e) => applyPendingConfirmation((prev) => prev ? {
                            ...prev,
                            outline: e.target.value.split('\n').map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean),
                            confirmedForImageGeneration: false,
                            updatedAt: new Date().toISOString(),
                          } : prev)}
                          rows={4}
                          className="mt-4 h-32 w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-7 text-white resize-none"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRevisionScope('outline');
                            setRevisionInstruction('请重组当前结构，让表达更清晰、更适合小红书阅读节奏。');
                            setActiveConfirmTool('custom');
                            setIsStructurePanelOpen(false);
                          }}
                          className="mt-3 h-11 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 text-sm font-medium text-emerald-50 hover:bg-emerald-400/15"
                        >
                          重组当前结构
                        </button>
                      </div>
                    )}

                    {activeConfirmTool === 'tone' && (
                      <div className="flex flex-wrap gap-2">
                        {[
                          '让语气更口语一点，像真人在分享经验。',
                          '保留信息量，但表达更利落、更干净。',
                          '减少营销感，改得更像真实种草笔记。',
                        ].map((instruction) => (
                          <button
                            key={instruction}
                            type="button"
                            onClick={() => handleToneShortcut(instruction)}
                            className={`rounded-full border px-3 py-2 text-xs transition ${
                              activeConfirmTool === 'tone' && revisionInstruction === instruction
                                ? 'border-emerald-300/60 bg-emerald-300/18 text-emerald-50 shadow-[0_0_0_1px_rgba(110,231,183,0.12)]'
                                : 'border-white/10 bg-white/[0.04] text-slate-200 hover:bg-white/[0.08]'
                            }`}
                          >
                            {instruction}
                          </button>
                        ))}
                      </div>
                    )}
                    </div>

                    <div className="mt-auto pt-5">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={applyCustomRevision}
                        disabled={isRevisingNote}
                        className={`h-11 rounded-xl px-5 text-sm font-medium ${isRevisingNote ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-white text-slate-900 hover:bg-slate-100'}`}
                      >
                        {isRevisingNote ? '修改中...' : '应用修改'}
                      </button>
                      <button
                        type="button"
                        onClick={revertLastRevision}
                        disabled={!pendingConfirmation.previousSnapshot}
                        className={`h-11 rounded-xl px-5 text-sm font-medium ${pendingConfirmation.previousSnapshot ? 'bg-white/5 text-slate-200 hover:bg-white/10' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
                      >
                        撤回
                      </button>
                    </div>
                    {hasActiveImageTasks ? (
                      <button
                        type="button"
                        onClick={handleCancelGeneration}
                        className="mt-3 h-12 w-full rounded-xl px-5 text-sm font-semibold bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
                      >
                        取消出图
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={scrollToGenerationConfig}
                        className="mt-3 h-12 w-full rounded-xl px-5 text-sm font-semibold bg-white text-slate-950 hover:bg-slate-100"
                      >
                        文案确认，进入出图配置
                      </button>
                    )}

                    {(pendingConfirmation.lastReasoningSummary || pendingConfirmation.lastCustomInstruction) && (
                      <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm text-slate-300">
                        <div className="line-clamp-2">{pendingConfirmation.lastCustomInstruction || '无最近指令'}</div>
                        <div className="mt-1 text-xs text-slate-500">{pendingConfirmation.lastReasoningSummary || '暂无系统说明'}</div>
                      </div>
                    )}
                    </div>
                  </div>
                </div>
              </div>
            </section>
          )}

          {activeWorkspacePanel === 'product' && (
          <section ref={productSectionRef} className="scroll-mt-24 rounded-[28px] border border-white/[0.04] bg-xhs-card/80 p-6 shadow-[0_22px_70px_rgba(0,0,0,0.24)] backdrop-blur-md space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-3xl">
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Step 1 / Product Brief</div>
                <h3 className="mt-2 text-2xl font-semibold text-white">云端产品信息</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">展开时专心补充事实，收起后只保留可扫读的产品摘要和云端理解状态。</p>
              </div>
              <button
                type="button"
                onClick={() => setIsProductBriefCollapsed((current) => !current)}
                className="inline-flex h-10 items-center gap-2 self-start rounded-xl bg-white/[0.05] px-4 text-sm font-medium text-slate-200 transition hover:bg-white/[0.08]"
              >
                <span className="material-symbols-outlined text-[18px]">
                  {isProductBriefCollapsed ? 'unfold_more' : 'unfold_less'}
                </span>
                {isProductBriefCollapsed ? '展开产品信息' : '收起为摘要'}
              </button>
            </div>

            {isProductBriefCollapsed ? (
              <div className="rounded-3xl bg-black/20 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.1fr,0.9fr]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">摘要视图</div>
                        <div className="mt-2 text-2xl font-semibold text-white">{productBrief.product_name || '未填写产品名称'}</div>
                        <div className="mt-2 text-sm leading-6 text-slate-400">{productBrief.target_audience || '未填写目标人群'}</div>
                      </div>
                      <div className={`rounded-full px-3 py-1 text-xs font-medium ${hasProductBriefEssentials ? 'bg-emerald-400/12 text-emerald-100' : 'bg-amber-400/12 text-amber-100'}`}>
                        必填 {productBriefCompletionCount}/3
                      </div>
                    </div>
                    <div className="mt-4 text-sm leading-6 text-slate-300 line-clamp-3">
                      {productFeaturePreview || '还没有产品定位、核心功能或使用场景。展开后补充这些信息，策略会更稳。'}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full bg-white/[0.05] px-3 py-1 text-xs text-slate-300">语气：{productBrief.brand_tone || '未填写'}</span>
                      <span className="rounded-full bg-white/[0.05] px-3 py-1 text-xs text-slate-300">资料：{productBrief.reference_urls?.length || 0} 个来源</span>
                      <span className="rounded-full bg-white/[0.05] px-3 py-1 text-xs text-slate-300">必提：{productBrief.must_include ? '已配置' : '无'}</span>
                      <span className="rounded-full bg-white/[0.05] px-3 py-1 text-xs text-slate-300">避词：{productBrief.banned_terms ? '已配置' : '无'}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
                    <div className="rounded-2xl bg-white/[0.04] p-4">
                      <div className="text-xs text-slate-500">研究结论</div>
                      <div className="mt-2 text-lg font-semibold text-white">{researchContext ? '已生成' : '未生成'}</div>
                    </div>
                    <div className="rounded-2xl bg-white/[0.04] p-4">
                      <div className="text-xs text-slate-500">洞察项</div>
                      <div className="mt-2 text-lg font-semibold text-white">{researchInsightCount}</div>
                    </div>
                    <div className="rounded-2xl bg-white/[0.04] p-4">
                      <div className="text-xs text-slate-500">评论表达</div>
                      <div className="mt-2 text-lg font-semibold text-white">{realPhrases.length}</div>
                    </div>
                    <div className="rounded-2xl bg-white/[0.04] p-4">
                      <div className="text-xs text-slate-500">对标来源</div>
                      <div className="mt-2 text-lg font-semibold text-white">{selectedBenchmarkNote ? '已选' : '未选'}</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1.18fr,0.82fr]">
                <div className="rounded-3xl bg-black/20 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">必要信息</div>
                      <div className="mt-1 text-sm text-slate-400">产品名、人群和核心特点决定策略质量。</div>
                    </div>
                    <div className={`rounded-full px-3 py-1 text-xs font-medium ${hasProductBriefEssentials ? 'bg-emerald-400/10 text-emerald-100' : 'bg-amber-400/10 text-amber-100'}`}>
                      已完成 {productBriefCompletionCount}/3
                    </div>
                  </div>
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <input
                        value={productBrief.product_name}
                        onChange={(e) => updateProductBriefField('product_name', e.target.value)}
                        placeholder="产品名称"
                        className="h-12 px-4 bg-xhs-panel/80 border border-white/[0.08] rounded-xl text-white outline-none transition focus:border-white/20"
                      />
                      <input
                        value={productBrief.target_audience}
                        onChange={(e) => updateProductBriefField('target_audience', e.target.value)}
                        placeholder="目标人群"
                        className="h-12 px-4 bg-xhs-panel/80 border border-white/[0.08] rounded-xl text-white outline-none transition focus:border-white/20"
                      />
                    </div>
                    <input
                      value={productBrief.brand_tone}
                      onChange={(e) => updateProductBriefField('brand_tone', e.target.value)}
                      placeholder="品牌语气"
                      className="h-12 w-full px-4 bg-xhs-panel/80 border border-white/[0.08] rounded-xl text-white outline-none transition focus:border-white/20"
                    />
                    <textarea
                      value={productBrief.product_features}
                      onChange={(e) => updateProductBriefField('product_features', e.target.value)}
                      rows={5}
                      placeholder="产品特点、使用场景、体验细节"
                      className="w-full px-4 py-3 bg-xhs-panel/80 border border-white/[0.08] rounded-2xl text-white resize-none outline-none transition focus:border-white/20"
                    />
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                      <input
                        value={productBrief.must_include}
                        onChange={(e) => updateProductBriefField('must_include', e.target.value)}
                        placeholder="必须提及内容"
                        className="h-12 px-4 bg-xhs-panel/80 border border-white/[0.08] rounded-xl text-white outline-none transition focus:border-white/20"
                      />
                      <input
                        value={productBrief.banned_terms}
                        onChange={(e) => updateProductBriefField('banned_terms', e.target.value)}
                        placeholder="不想出现的词"
                        className="h-12 px-4 bg-xhs-panel/80 border border-white/[0.08] rounded-xl text-white outline-none transition focus:border-white/20"
                      />
                    </div>
                    <textarea
                      value={productBriefUrlsToText(productBrief)}
                      onChange={(e) => updateProductBriefField('reference_urls', parseProductBriefUrlsText(e.target.value))}
                      rows={3}
                      placeholder="产品资料链接，一行一个。支持官网、帮助中心、落地页、产品介绍页"
                      className="w-full px-4 py-3 bg-xhs-panel/80 border border-white/[0.08] rounded-2xl text-white resize-none outline-none transition focus:border-white/20"
                    />
                  </div>
                </div>

                <div className="rounded-3xl bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.025))] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">云端理解板</div>
                      <div className="mt-2 text-sm text-slate-300">{hasProductBriefEssentials ? '信息已就绪，可以生成策略。' : `还缺：${missingProductBriefFields.join('、')}`}</div>
                    </div>
                    <div className={`rounded-full px-3 py-1 text-xs font-medium ${hasProductBriefEssentials ? 'bg-emerald-500/15 text-emerald-100' : 'bg-amber-500/15 text-amber-100'}`}>
                      {hasProductBriefEssentials ? '可分析' : '待补齐'}
                    </div>
                  </div>

                  <div className="mt-5 grid grid-cols-3 gap-2">
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <div className="text-[11px] text-slate-500">资料</div>
                      <div className="mt-1 text-lg font-semibold text-white">{productBrief.reference_urls?.length || 0}</div>
                    </div>
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <div className="text-[11px] text-slate-500">评论</div>
                      <div className="mt-1 text-lg font-semibold text-white">{realPhrases.length}</div>
                    </div>
                    <div className="rounded-2xl bg-black/20 px-3 py-3">
                      <div className="text-[11px] text-slate-500">洞察</div>
                      <div className="mt-1 text-lg font-semibold text-white">{researchInsightCount}</div>
                    </div>
                  </div>

                  <div className="mt-4 space-y-3">
                    <div className={`rounded-2xl px-4 py-3 ${selectedBenchmarkNote ? 'bg-[linear-gradient(135deg,rgba(244,63,94,0.16),rgba(0,0,0,0.18))]' : 'bg-black/20'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-xs text-slate-500">{isBenchmarkFirstStrategy ? '对标主来源' : '策略来源'}</div>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] ${selectedBenchmarkNote ? 'bg-xhs-red text-white' : 'bg-white/[0.06] text-slate-400'}`}>
                          {selectedBenchmarkNote ? (isBenchmarkFirstStrategy ? '对标优先' : selectedBenchmarkNote.recommendation_tier) : '研究优先'}
                        </span>
                      </div>
                      <div className="mt-2 text-sm font-medium leading-6 text-white line-clamp-2">
                        {selectedBenchmarkNote ? selectedBenchmarkNote.title : '未选择对标笔记，系统会按产品事实和资料来源生成策略。'}
                      </div>
                      {selectedBenchmarkNote && (
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-rose-100/70">
                          <span className="rounded-full bg-white/[0.07] px-2 py-0.5">{selectedBenchmarkNote.content_category}</span>
                          <span className="rounded-full bg-white/[0.07] px-2 py-0.5">{selectedBenchmarkNote.recommendation_tier}</span>
                          <span className="rounded-full bg-white/[0.07] px-2 py-0.5">{selectedBenchmarkNote.material_dependency}</span>
                        </div>
                      )}
                    </div>
                    <div className="rounded-2xl bg-black/20 px-4 py-3 text-sm leading-6 text-slate-300">
                      <div className="text-xs text-slate-500">研究摘要</div>
                      <div className="mt-2 line-clamp-3">{researchContext?.summary || '生成策略后，这里会沉淀产品定位、人群和使用场景。'}</div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={generateStrategy}
                    disabled={isGeneratingStrategy || isGenerating}
                    className={`mt-4 h-10 w-full rounded-xl text-sm font-semibold transition ${isGeneratingStrategy || isGenerating ? 'bg-white/[0.05] text-slate-500 cursor-not-allowed' : 'bg-white/[0.07] text-slate-200 hover:bg-white/[0.11]'}`}
                  >
                    {strategyPreviewActionLabel}
                  </button>
                  <div className="mt-2 text-center text-xs text-slate-500">也可以直接生成初稿，系统会先自动生成策略。</div>
                </div>
              </div>
            )}
          </section>
          )}

          {(researchContext || strategyOptions.length > 0 || activeWorkspacePanel === 'strategy') && activeWorkspacePanel === 'strategy' && (
            <section ref={strategySectionRef} className="scroll-mt-24 bg-xhs-card border border-white/5 rounded-3xl p-6 space-y-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Step 2 / Note Strategy</div>
                  <h3 className="mt-2 text-xl font-semibold text-white">先确认当前策略，再决定是否切换方向</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    当前方向默认展开，其余方向和研究来源收进详情里，减少首屏干扰。
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveWorkspacePanel('draft')}
                    className="px-4 h-11 rounded-xl border border-emerald-400/25 bg-emerald-400/10 text-sm font-medium text-emerald-50 hover:bg-emerald-400/15"
                  >
                    去笔记初稿
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsStrategyPanelCollapsed((prev) => !prev)}
                    className="px-4 h-11 rounded-xl border border-white/10 bg-white/5 text-sm font-medium text-slate-200 hover:bg-white/10"
                  >
                    {isStrategyPanelCollapsed ? '展开策略' : '收起策略'}
                  </button>
                  <button
                    type="button"
                    onClick={hasExistingStrategyFlow ? handleRegenerateStrategy : generateStrategy}
                    disabled={workflowResetDisabled}
                    className={`px-5 h-11 rounded-xl text-sm font-medium ${workflowResetDisabled ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-white text-slate-900 hover:bg-slate-100'}`}
                  >
                    {hasExistingStrategyFlow ? '重生成策略' : strategyPreviewActionLabel}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-black/20 p-4 text-sm text-slate-300">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{isBenchmarkFirstStrategy ? '策略来源' : '当前策略参考'}</div>
                <div className="mt-2">
                  {selectedBenchmarkNote
                    ? `当前策略会先判断《${selectedBenchmarkNote.title}》的爆点是否适合产品介入，再决定产品主导、轻承接或不带产品。`
                    : '当前没有对标笔记，系统会优先按产品研究结果生成策略。'}
                </div>
                {activeBenchmarkFit && (
                  <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.03] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${activeProductUsageMeta.className}`}>
                        {activeProductUsageMeta.label}
                      </span>
                      {typeof activeBenchmarkFit.confidence === 'number' && (
                        <span className="text-xs text-slate-500">判断置信度 {activeBenchmarkFit.confidence}%</span>
                      )}
                    </div>
                    <div className="mt-2 text-sm leading-6 text-slate-300">
                      {activeBenchmarkFit.product_fit_reason || activeProductUsageMeta.description}
                    </div>
                    {activeBenchmarkFit.risk_if_product_inserted && (
                      <div className="mt-1 text-xs leading-5 text-slate-500">硬加风险：{activeBenchmarkFit.risk_if_product_inserted}</div>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                  <div className="flex-1">
                    <label className="block text-xs uppercase tracking-[0.18em] text-slate-500">策略纠偏</label>
                    <textarea
                      value={strategyFeedback}
                      onChange={(event) => setStrategyFeedback(event.target.value)}
                      rows={2}
                      placeholder="例如：对标笔记核心是 618 大促，请把限时活动、囤货理由、优惠心智放进策略主线"
                      className="mt-2 min-h-[72px] w-full resize-none rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm leading-6 text-slate-100 placeholder:text-slate-600 focus:border-cyan-400/40 focus:ring-0"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={generateStrategy}
                    disabled={isGeneratingStrategy || isGenerating || !strategyFeedback.trim()}
                    className={`h-11 rounded-xl px-5 text-sm font-medium ${isGeneratingStrategy || isGenerating || !strategyFeedback.trim() ? 'cursor-not-allowed bg-slate-700 text-slate-400' : 'bg-cyan-300 text-slate-950 hover:bg-cyan-200'}`}
                  >
                    按想法重生成
                  </button>
                </div>
              </div>

              {!activeStrategy && strategyOptions.length === 0 && (
                <div className="rounded-3xl border border-dashed border-white/10 bg-black/18 px-5 py-10 text-center">
                  <div className="text-base font-semibold text-white">还没有生成策略</div>
                  <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">
                    策略会根据产品信息、对标笔记和素材生成。生成后这里会展示多个方向供你选择。
                  </div>
                  <button
                    type="button"
                    onClick={generateStrategy}
                    disabled={isGeneratingStrategy || isGenerating}
                    className={`mt-5 h-11 rounded-xl px-5 text-sm font-semibold ${isGeneratingStrategy || isGenerating ? 'cursor-not-allowed bg-slate-700 text-slate-300' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
                  >
                    {strategyPreviewActionLabel}
                  </button>
                </div>
              )}

              {activeStrategy && (
                <div className="rounded-[28px] border border-xhs-red/20 bg-[linear-gradient(135deg,rgba(239,68,68,0.14),rgba(239,68,68,0.04))] p-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                    <div className="max-w-3xl">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="inline-flex whitespace-nowrap rounded-full bg-xhs-red px-3 py-1 text-[11px] font-semibold text-white">当前方向</div>
                        <div className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-semibold ${isBenchmarkFirstStrategy ? 'bg-rose-500/20 text-rose-100' : 'bg-white/10 text-slate-200'}`}>
                          {isBenchmarkFirstStrategy ? '来源：对标优先' : '来源：研究优先'}
                        </div>
                        {activeBenchmarkFit && (
                          <div className={`inline-flex whitespace-nowrap rounded-full border px-3 py-1 text-[11px] font-semibold ${activeProductUsageMeta.className}`}>
                            {activeProductUsageMeta.shortLabel}
                          </div>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <h4 className="text-2xl font-semibold text-white">{activeStrategy.label}</h4>
                        <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">{activeStrategy.contentAngle}</span>
                        <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">{activeStrategy.targetAudience}</span>
                      </div>
                      <p className="mt-3 text-sm leading-6 text-slate-200">{activeStrategy.summary}</p>
                      <p className="mt-3 text-xs leading-5 text-slate-400">
                        {activeBenchmarkFit
                          ? activeProductUsageMeta.description
                          : isBenchmarkFirstStrategy
                            ? '这套策略会优先保留对标笔记的切入角度、卡片结构和叙事节奏，研究资料只负责校准当前产品信息。'
                            : '这套策略主要根据产品研究结论生成，对标笔记仅作轻量灵感参考。'}
                      </p>
                      {activeBenchmarkFit?.allowed_product_usage && (
                        <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 p-3 text-xs leading-5 text-slate-300">
                          <span className="text-slate-500">产品介入说明：</span>{activeBenchmarkFit.allowed_product_usage}
                        </div>
                      )}
                    </div>
                    <div className="grid min-w-[260px] grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                      <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">核心痛点</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {activeStrategy.corePainPoints.slice(0, 3).map((item) => (
                            <span key={item} className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-200">{item}</span>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">核心卖点</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {activeStrategy.coreBenefits.slice(0, 3).map((item) => (
                            <span key={item} className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-100">{item}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {!isStrategyPanelCollapsed && researchContext && (
                <details className="group rounded-2xl border border-white/8 bg-white/5 p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-500">研究详情</div>
                      <div className="mt-1 text-sm text-slate-300">展开查看人群、功能、场景和来源详情</div>
                    </div>
                    <span className="text-xs text-slate-500 transition group-open:rotate-180">⌄</span>
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                      <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                        <div className="text-xs text-slate-500">适合人群</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(researchContext.target_audience_insights || []).slice(0, 4).map((item) => (
                            <span key={item} className="rounded-full bg-white/10 px-3 py-1 text-xs text-slate-200">{item}</span>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                        <div className="text-xs text-slate-500">核心功能</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(researchContext.core_features || []).slice(0, 4).map((item) => (
                            <span key={item} className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs text-emerald-100">{item}</span>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                        <div className="text-xs text-slate-500">使用场景</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(researchContext.use_cases || []).slice(0, 4).map((item) => (
                            <span key={item} className="rounded-full bg-sky-500/10 px-3 py-1 text-xs text-sky-100">{item}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                    {!!researchContext.source_documents?.length && (
                      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        {researchContext.source_documents.map((doc) => (
                          <div key={doc.url} className="rounded-2xl border border-white/8 bg-black/20 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-sm font-medium text-white line-clamp-1">{doc.title || doc.url}</div>
                              <span className={`rounded-full px-2 py-1 text-[11px] ${doc.status === 'failed' ? 'bg-amber-500/15 text-amber-200' : doc.status === 'search_result' ? 'bg-sky-500/15 text-sky-100' : 'bg-emerald-500/15 text-emerald-100'}`}>
                                {doc.status === 'failed' ? '读取失败' : doc.status === 'search_result' ? '搜索补全' : '已读取'}
                              </span>
                            </div>
                            <div className="mt-2 text-xs text-slate-500 line-clamp-1">{doc.url}</div>
                            <div className="mt-3 text-sm leading-6 text-slate-300">{doc.summary}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              )}

              {!isStrategyPanelCollapsed && strategyOptions.length > 0 && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-500">可切换方向</div>
                    <div className="text-xs text-slate-500">已生成 {strategyOptions.length} 套策略</div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                    {strategyOptions.map((strategy, strategyIndex) => {
                      const isActive = strategy.id === activeStrategy?.id;
                      const strategyUsageMode = resolveProductUsageMode(strategy, Boolean(selectedBenchmarkNote)) as keyof typeof productUsageMeta;
                      const strategyUsageMeta = productUsageMeta[strategyUsageMode] || productUsageMeta.product_main;
                      return (
                        <button
                          key={strategy.id}
                          type="button"
                          onClick={() => setSelectedStrategyId(strategy.id)}
                          className={`group relative flex h-full min-h-[520px] flex-col overflow-hidden rounded-[24px] border text-left transition ${isActive ? 'border-xhs-red/80 bg-[linear-gradient(180deg,rgba(239,68,68,0.14),rgba(255,255,255,0.035))] shadow-[0_18px_44px_rgba(239,68,68,0.16)]' : 'border-white/10 bg-white/[0.045] hover:border-white/20 hover:bg-white/[0.065]'}`}
                        >
                          <div className={`h-1 w-full ${isActive ? 'bg-xhs-red' : 'bg-white/10 group-hover:bg-white/20'}`} />
                          <div className="flex flex-1 flex-col p-5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                                  方案 {String(strategyIndex + 1).padStart(2, '0')}
                                </div>
                                <h4 className="mt-3 line-clamp-2 text-lg font-semibold leading-7 text-white">
                                  {strategy.label}
                                </h4>
                              </div>
                              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                                <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium ${strategyUsageMeta.className}`}>
                                  {strategyUsageMeta.shortLabel}
                                </span>
                                {isActive && (
                                  <span className="inline-flex whitespace-nowrap rounded-full bg-xhs-red px-2.5 py-1 text-[11px] font-semibold text-white shadow-[0_8px_18px_rgba(239,68,68,0.24)]">
                                    已选
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="mt-4 rounded-2xl border border-white/8 bg-black/18 px-4 py-3">
                              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">策略角度</div>
                              <div className="mt-1 line-clamp-3 text-xs leading-5 text-slate-300">{strategy.contentAngle}</div>
                            </div>

                            <p className="mt-4 line-clamp-4 text-sm leading-6 text-slate-200">{strategy.summary}</p>

                            <div className="mt-5 rounded-2xl border border-white/8 bg-white/[0.035] px-4 py-3">
                              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">核心人群</div>
                              <div className="mt-1 text-sm leading-6 text-slate-200">{strategy.targetAudience}</div>
                            </div>

                            <div className="mt-5 grid grid-cols-1 gap-3">
                              <div>
                                <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">痛点</div>
                                <div className="mt-2 space-y-2">
                                  {strategy.corePainPoints.slice(0, 3).map((item) => (
                                    <div key={item} className="flex gap-2 text-sm leading-5 text-slate-300">
                                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-300/70" />
                                      <span>{item}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">卖点</div>
                                <div className="mt-2 space-y-2">
                                  {strategy.coreBenefits.slice(0, 3).map((item) => (
                                    <div key={item} className="flex gap-2 text-sm leading-5 text-emerald-50">
                                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-300" />
                                      <span>{item}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>

                            <div className="mt-auto pt-5">
                              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">推荐分页</div>
                              <div className="mt-3 space-y-2">
                                {strategy.recommendedCardPlan.slice(0, 4).map((item, cardIndex) => (
                                  <div key={`${item}-${cardIndex}`} className="flex items-start gap-3 rounded-xl border border-sky-300/10 bg-sky-400/8 px-3 py-2.5">
                                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-300/15 text-[11px] font-semibold text-sky-100">
                                      {cardIndex + 1}
                                    </span>
                                    <span className="text-sm leading-5 text-sky-50">{item}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          )}

          {activeWorkspacePanel === 'visual' && (
          <section ref={generationConfigSectionRef} className="scroll-mt-24 bg-xhs-card border border-white/5 rounded-3xl p-6 space-y-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Step 3 / Generate Draft</div>
                <h3 className="mt-2 text-xl font-semibold text-white">生成配置</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">先定正文改写强度，再定图片表达方式。素材只作为产品、场景和风格辅助，不混入旧模式概念。</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr,1fr,1fr]">
              <div>
                <label className="block text-xs text-slate-500 mb-2">仿写模式</label>
                <div className="flex flex-wrap gap-2">
                  {rewriteModes.map((item) => (
                    <button
                      key={item}
                      type="button"
                      title={rewriteModeDescriptions[item]}
                      onClick={() => setRewriteMode(item)}
                      className={`h-10 rounded-xl px-4 text-sm font-medium transition ${rewriteMode === item ? 'bg-xhs-red text-white shadow-[0_10px_24px_rgba(255,36,77,0.18)]' : 'bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]'}`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-500 mb-2">图片模式</label>
                <div className="flex flex-wrap gap-2">
                  {imageModes.map((item) => (
                    <button
                      key={item}
                      type="button"
                      title={imageModeDescriptions[item]}
                      onClick={() => setImageMode(item)}
                      className={`h-10 rounded-xl px-4 text-sm font-medium transition ${imageMode === item ? 'bg-white text-slate-950 shadow-[0_10px_24px_rgba(255,255,255,0.08)]' : 'bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]'}`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div className={`rounded-2xl px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${isDynamicQualityImageMode(imageMode) ? 'bg-[linear-gradient(135deg,rgba(14,165,233,0.15),rgba(15,23,42,0.42))]' : 'bg-[linear-gradient(135deg,rgba(16,185,129,0.13),rgba(15,23,42,0.42))]'}`}>
                <div className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-semibold ${isDynamicQualityImageMode(imageMode) ? 'bg-sky-100 text-slate-950' : 'bg-emerald-100 text-slate-950'}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${isDynamicQualityImageMode(imageMode) ? 'bg-sky-500' : 'bg-emerald-500'}`} />
                  {isStyleExpressionImageMode(imageMode) ? '风格表达模式' : imageMode === '动态表达' ? '动态表达模式' : imageMode === '物料融合' ? '物料融合模式' : '模板拼装模式'}
                </div>
                <div className={`mt-3 text-sm font-semibold ${isDynamicQualityImageMode(imageMode) ? 'text-sky-50' : 'text-emerald-50'}`}>
                  {isStyleExpressionImageMode(imageMode)
                    ? '独立风格模式，复用动态表达质量'
                    : imageMode === '动态表达'
                      ? '由 AI 动态推演 5 维风格'
                      : imageMode === '物料融合'
                        ? '先分配主素材，再逐图融合编辑'
                        : '先定组图结构，再进工作台精修'}
                </div>
                <div className={`mt-1 text-xs leading-5 ${isDynamicQualityImageMode(imageMode) ? 'text-sky-50/70' : 'text-emerald-50/70'}`}>
                  {isStyleExpressionImageMode(imageMode)
                    ? `当前预设：${normalizeStyleExpressionPreset(visualStyle)}。AI 仍会先按内容判断 1-${DYNAMIC_EXPRESSION_MAX_IMAGE_COUNT} 张，不会为了风格凑图。`
                    : imageMode === '动态表达'
                      ? `无需选择固定风格，大模型将根据笔记内容和下方意图输入，智能规划最多 ${DYNAMIC_EXPRESSION_MAX_IMAGE_COUNT} 张。`
                      : imageMode === '物料融合'
                        ? '系统会按融合方案为每张图分配主素材，其他素材只作为品牌、截图或局部细节参考。'
                        : '适合多页组图和教程结构，系统会自动匹配页面结构，后续还能继续微调。'}
                </div>
              </div>
            </div>

            {isStyleExpressionImageMode(imageMode) && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
                {styleExpressionPresets.map((preset) => {
                  const selected = normalizeStyleExpressionPreset(visualStyle) === preset.value;
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setVisualStyle(preset.value)}
                      title={preset.description}
                      className={`group overflow-hidden rounded-2xl border text-left transition ${selected ? 'border-sky-300 bg-sky-400/12 shadow-[0_12px_28px_rgba(56,189,248,0.12)]' : 'border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.07]'}`}
                    >
                      <div className="relative flex h-40 items-center justify-center bg-slate-950/70 p-2 md:h-44 xl:h-40">
                        <img
                          src={preset.previewUrl}
                          alt={`${preset.label}预览`}
                          loading="lazy"
                          className="h-full w-auto max-w-full rounded-xl object-contain shadow-[0_10px_24px_rgba(0,0,0,0.22)] transition duration-300 group-hover:scale-[1.03]"
                        />
                        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-slate-950/88 to-transparent" />
                        <span className={`absolute right-3 top-3 h-2.5 w-2.5 rounded-full border border-white/40 ${selected ? 'bg-sky-300' : 'bg-slate-500'}`} />
                        {selected && (
                          <span className="absolute left-3 top-3 rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-slate-950">
                            已选择
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        <div className="flex min-h-[38px] items-start justify-between gap-2">
                          <span className="text-[13px] font-semibold leading-5 text-white">{preset.label}</span>
                          <div className="flex shrink-0 gap-1">
                            {preset.swatches.map((color) => (
                              <span
                                key={color}
                                className="h-3.5 w-3.5 rounded-full border border-white/15"
                                style={{ backgroundColor: color }}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="mt-2 min-h-[40px] text-xs leading-5 text-slate-300">{preset.description}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {generationReadinessItems.map((item) => (
                <span
                  key={item.label}
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${item.isReady ? 'bg-emerald-400/10 text-emerald-100' : 'bg-white/[0.05] text-slate-400'}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${item.isReady ? 'bg-emerald-300' : 'bg-slate-600'}`} />
                  {item.label}：{item.value}
                </span>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-slate-500 mb-2">销售感 {salesIntensity}</label>
                <input type="range" min="10" max="100" value={salesIntensity} onChange={(e) => setSalesIntensity(Number(e.target.value))} className="w-full" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-2">口语化 {colloquialLevel}</label>
                <input type="range" min="10" max="100" value={colloquialLevel} onChange={(e) => setColloquialLevel(Number(e.target.value))} className="w-full" />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-2">真实体验感 {authenticityLevel}</label>
                <input type="range" min="10" max="100" value={authenticityLevel} onChange={(e) => setAuthenticityLevel(Number(e.target.value))} className="w-full" />
              </div>
            </div>

            {isDynamicQualityImageMode(imageMode) && (
              <div className="grid grid-cols-1 gap-4">
                <textarea
                  value={materialSummary}
                  onChange={(e) => setMaterialSummary(e.target.value)}
                  rows={3}
                  placeholder={isStyleExpressionImageMode(imageMode) ? '风格表达模式下，可补充内容意图或局部偏好，如封面更精简、整体青绿、第二页强调流程。' : '动态表达模式下，可以补充您的任意意图，如颜色偏好、核心元素等'}
                  className="w-full px-4 py-3 bg-xhs-panel/80 border border-white/15 rounded-2xl text-white resize-none"
                />
              </div>
            )}

            {imageMode === '物料融合' && (
              <section className="overflow-hidden rounded-[28px] border border-amber-300/18 bg-[linear-gradient(135deg,rgba(245,158,11,0.12),rgba(15,23,42,0.44))]">
                <div className="border-b border-amber-100/10 p-5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-2xl">
                      <div className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-slate-950">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        物料融合模式
                      </div>
                      <div className="mt-3 text-sm font-semibold text-amber-50">先整理素材标签，生成融合方案后再逐图分配主物料</div>
                      <div className="mt-1 text-xs leading-5 text-amber-50/72">
                        AI 会基于素材名称、备注和标签生成更清晰的素材说明；等系统确定最终出图张数和每张图主题后，再推荐对应主物料。
                      </div>
                    </div>
                    <div className="rounded-2xl border border-amber-200/16 bg-black/18 px-4 py-3 text-sm text-amber-50">
                      {hasMaterialFusionDraft ? '融合方案' : '素材准备'}：{materialFusionReadyItems.length} 张可生成 / {materialFusionRequiredMissingItems.length} 张必选待指定 / {materialFusionSkippedItems.length} 张将跳过
                    </div>
                  </div>
                  <textarea
                    value={materialSummary}
                    onChange={(e) => setMaterialSummary(e.target.value)}
                    rows={3}
                    placeholder="补充融合要求，例如：每张图都加品牌 Logo；产品截图保持真实；竞品图只参考结构，不要直接使用"
                    className="mt-4 w-full resize-none rounded-2xl border border-amber-100/15 bg-black/20 px-4 py-3 text-sm text-white outline-none transition placeholder:text-amber-50/35 focus:border-amber-200/35"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-[0.95fr,1.05fr]">
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-1">
                    <div className="rounded-2xl border border-white/10 bg-black/16 p-4">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-100/70">素材识别</div>
                        <div className="text-[11px] text-amber-50/50">素材库 {materialCandidateAssets.length} 张</div>
                      </div>
                      <button
                        type="button"
                        onClick={handleOrganizeReferenceAssets}
                        disabled={isOrganizingAssets || materialCandidateAssets.length === 0}
                        className={`mt-3 h-9 w-full rounded-xl text-xs font-semibold transition ${isOrganizingAssets || materialCandidateAssets.length === 0 ? 'bg-slate-700 text-slate-400 cursor-not-allowed' : 'bg-amber-100 text-slate-950 hover:bg-amber-50'}`}
                      >
                        {isOrganizingAssets ? 'AI 整理中...' : 'AI 整理素材标签'}
                      </button>
                      <div className="mt-4 grid grid-cols-3 gap-2">
                        {(Object.keys(materialAssetBuckets) as MaterialAssetRole[]).map((role) => (
                          <div key={role} className="rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2">
                            <div className="text-[11px] text-slate-400">{materialAssetRoleLabels[role]}</div>
                            <div className="mt-1 text-lg font-semibold text-white">{materialAssetBuckets[role].length}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-black/16 p-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-100/70">全局素材</div>
                      <div className="mt-2 text-xs leading-5 text-slate-400">Logo 和品牌风格会默认加入每张图，帮助统一品牌露出和视觉气质。</div>
                      <div className="mt-3 grid max-h-[196px] grid-cols-1 gap-2 overflow-y-auto pr-1">
                        {globalMaterialAssetIds.length > 0 ? globalMaterialAssetIds.map((assetId) => {
                          const asset = materialCandidateAssets.find((item) => item.id === assetId);
                          if (!asset) return null;
                          return (
                            <div key={assetId} className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.04] p-2">
                              <img src={asset.url} alt={asset.display_name || asset.original_name} className="h-10 w-10 rounded-lg object-cover bg-black/30" />
                              <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-white">{asset.display_name || asset.original_name}</div>
                                <div className="text-[11px] text-amber-100/60">{materialAssetRoleLabels[inferMaterialAssetRole(asset)]}</div>
                              </div>
                            </div>
                          );
                        }) : (
                          <div className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-500">
                            暂未识别到 Logo 或品牌风格素材
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-white/10 bg-black/16 p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-100/70">{hasMaterialFusionDraft ? '组图素材分配' : '融合方案'}</div>
                        <div className="mt-1 text-xs text-slate-400">
                          {hasMaterialFusionDraft
                            ? '已按最终提示词生成图片结构，请逐张确认主物料。'
                            : '还不知道最终出几张图前，不需要先选每张图的物料。'}
                        </div>
                      </div>
                      {hasMaterialFusionDraft && (
                        <div className="flex flex-wrap gap-2">
                          {materialFusionRequiredMissingItems.length > 0 && (
                            <div className="rounded-full bg-rose-500/12 px-3 py-1 text-xs text-rose-100">
                              {materialFusionRequiredMissingItems.length} 张必选待指定
                            </div>
                          )}
                          {materialFusionSkippedItems.length > 0 && (
                            <div className="rounded-full bg-sky-500/12 px-3 py-1 text-xs text-sky-100">
                              {materialFusionSkippedItems.length} 张将跳过
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={generateMaterialFusionDraft}
                            disabled={isGenerating}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${isGenerating ? 'bg-slate-700 text-slate-400 cursor-not-allowed' : 'bg-white/10 text-amber-50 hover:bg-white/15'}`}
                          >
                            重新生成方案
                          </button>
                        </div>
                      )}
                    </div>

                    {!hasMaterialFusionDraft ? (
                      <div className="mt-4 rounded-2xl border border-dashed border-amber-100/20 bg-black/18 px-5 py-8 text-center">
                        <div className="text-sm font-semibold text-white">还没有生成融合方案</div>
                        <div className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-400">
                          点击下方按钮后，系统会先生成最终图片张数、每张图主题和提示词草案，再根据这些内容推荐主物料。
                        </div>
                        <button
                          type="button"
                          onClick={generateMaterialFusionDraft}
                          disabled={isGenerating || materialCandidateAssets.length === 0}
                          className={`mt-5 h-11 rounded-xl px-5 text-sm font-semibold ${isGenerating || materialCandidateAssets.length === 0 ? 'bg-slate-700 text-slate-400 cursor-not-allowed' : 'bg-amber-100 text-slate-950 hover:bg-amber-50'}`}
                        >
                          生成融合方案
                        </button>
                      </div>
                    ) : (
                    <div className="mt-4 max-h-[520px] space-y-3 overflow-y-auto pr-1">
                      {materialFusionPlan.map((item) => {
                        const primaryAsset = materialCandidateAssets.find((asset) => asset.id === item.primaryAssetId);
                        const availablePrimaryAssets = materialCandidateAssets;
                        return (
                          <div key={item.id} className={`rounded-2xl border p-3 ${item.status === 'ready' ? 'border-emerald-300/14 bg-emerald-300/[0.05]' : 'border-rose-300/18 bg-rose-500/[0.06]'}`}>
                            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr),170px] lg:items-start">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${item.status === 'ready' ? 'bg-emerald-100 text-slate-950' : 'bg-rose-100 text-slate-950'}`}>
                                    {item.status === 'ready' ? '可生成' : '待指定'}
                                  </span>
                                  <span className="text-xs text-slate-400">第 {item.index} 张</span>
                                </div>
                                <div className="mt-2 text-sm font-semibold text-white">{item.title}</div>
                                <div className="mt-1 line-clamp-2 text-xs font-medium leading-5 text-amber-50/85">{item.visualFocus || item.summary || item.requiredHint}</div>
                                {item.contentSummary && item.contentSummary !== item.visualFocus && (
                                  <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{item.contentSummary}</div>
                                )}
                                <div className="mt-1 text-[11px] leading-4 text-slate-500">{item.requiredHint}</div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {(item.requiredKeywords || []).map((keyword) => (
                                    <span key={keyword} className="rounded-full bg-amber-100/10 px-2 py-0.5 text-[11px] text-amber-100">
                                      {keyword}
                                    </span>
                                  ))}
                                  {!item.primaryRequired && (
                                    <span className="rounded-full bg-sky-100/10 px-2 py-0.5 text-[11px] text-sky-100">
                                      不强制主素材
                                    </span>
                                  )}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => setSelectingMaterialItemId(item.id)}
                                className="h-10 w-full rounded-xl border border-white/10 bg-[#111722] px-3 text-xs font-semibold text-white outline-none transition hover:border-amber-200/40 hover:bg-[#162033]"
                              >
                                {primaryAsset ? '更换主物料' : '从全部素材选择'}
                              </button>
                            </div>
                            <div className="mt-3 flex min-h-[56px] items-center gap-3 rounded-xl border border-white/8 bg-black/16 p-2">
                              {primaryAsset ? (
                                <>
                                  <img src={primaryAsset.url} alt={primaryAsset.display_name || primaryAsset.original_name} className="h-12 w-12 rounded-lg object-cover bg-black/30" />
                                  <div className="min-w-0">
                                    <div className="truncate text-xs font-medium text-white">{primaryAsset.display_name || primaryAsset.original_name}</div>
                                    <div className="mt-0.5 text-[11px] text-slate-500">{materialAssetRoleLabels[inferMaterialAssetRole(primaryAsset)]} · Logo {item.globalAssetIds.length} 张 · {item.selectionSource === 'manual' ? '手动选择' : '自动推荐'}</div>
                                    {item.matchReason && (
                                      <div className="mt-0.5 line-clamp-1 text-[11px] text-emerald-100/70">{item.matchReason}</div>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <div className="px-2 py-1 text-xs leading-5 text-rose-100/80">
                                  {item.matchReason || (availablePrimaryAssets.length > 0 ? '请从全部素材中选择一张主物料' : '素材库里还没有可作为主物料的图片')}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </div>
                </div>
              </section>
            )}

            {imageMode === '模板拼装' && (
              <div className="overflow-hidden rounded-[30px] border border-[#23343a] bg-[linear-gradient(180deg,#121720_0%,#10141c_100%)] p-6 shadow-[0_24px_60px_rgba(0,0,0,0.28)]">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="max-w-[680px]">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[#7fb7a4]">Template Compose</div>
                    <div className="mt-3 text-[24px] font-semibold tracking-[-0.02em] text-white">一键确定组图方向，再进工作台精修</div>
                    <div className="mt-2 text-sm leading-6 text-slate-400">
                      先定页数，再挑一个外框样式，系统会自动匹配页面结构，进工作台后还能继续微调。
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    <span className="rounded-full border border-[#27363d] bg-[#171d26] px-3 py-1.5 text-xs text-slate-300">自动匹配结构</span>
                    <span className="rounded-full border border-[#27363d] bg-[#171d26] px-3 py-1.5 text-xs text-slate-300">支持多页组图</span>
                    <span className="rounded-full border border-[#27363d] bg-[#171d26] px-3 py-1.5 text-xs text-slate-300">后续可继续微调</span>
                  </div>
                </div>

                <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr,1.1fr]">
                  <section className="rounded-[24px] border border-[#26323a] bg-[#141922] p-4">
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7fb7a4]">组图页数</div>
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      {templatePageCounts.map((count) => (
                        <button
                          key={count}
                          type="button"
                          onClick={() => setTemplatePageCount(count)}
                          className={`rounded-[20px] border px-4 py-4 text-left transition ${
                            templatePageCount === count
                              ? 'border-[#4ea58c] bg-[linear-gradient(180deg,rgba(78,165,140,0.18),rgba(78,165,140,0.08))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                              : 'border-[#26323a] bg-[#181e28] hover:border-[#33424a] hover:bg-[#1b222d]'
                          }`}
                        >
                          <div className={`text-sm font-medium ${templatePageCount === count ? 'text-white' : 'text-slate-200'}`}>{count} 页</div>
                          <div className={`mt-1 text-xs leading-5 ${templatePageCount === count ? 'text-emerald-100/70' : 'text-slate-500'}`}>
                            {count === 3 ? '封面 / 内容 / 收口' : count === 4 ? '封面 / 内容 / 内容 / 收口' : count === 5 ? '封面 / 3页内容 / 收口' : '封面 / 4页内容 / 收口'}
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-4 rounded-[18px] border border-dashed border-[#2a3940] bg-[#10151d] px-3 py-2.5 text-xs leading-5 text-slate-500">
                      先决定这组图想做成几页，进入工作台后仍然可以继续加页、删页和调整顺序。
                    </div>
                  </section>

                  <section className="rounded-[24px] border border-[#26323a] bg-[#141922] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7fb7a4]">笔记文案风格</div>
                      <div className="text-[11px] text-slate-500">会影响正文生成策略</div>
                    </div>
                    <div className="mt-4 grid grid-cols-1 gap-3">
                      {templateCopyStyles.map((item) => (
                        <button
                          key={item.value}
                          type="button"
                          onClick={() => setTemplateCopyStyle(item.value)}
                          className={`rounded-[20px] border px-4 py-3 text-left transition ${
                            templateCopyStyle === item.value
                              ? 'border-[#4ea58c] bg-[linear-gradient(180deg,rgba(78,165,140,0.18),rgba(78,165,140,0.08))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                              : 'border-[#26323a] bg-[#181e28] hover:border-[#33424a] hover:bg-[#1b222d]'
                          }`}
                        >
                          <div>
                            <div className={`text-sm font-medium ${templateCopyStyle === item.value ? 'text-white' : 'text-slate-200'}`}>{item.label}</div>
                            <div className={`mt-1 text-xs leading-5 ${templateCopyStyle === item.value ? 'text-emerald-100/70' : 'text-slate-500'}`}>{item.description}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4">
                  <section className="rounded-[24px] border border-[#26323a] bg-[#141922] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#7fb7a4]">外框样式</div>
                      <div className="text-[11px] text-slate-500">影响每页卡片结构外观，系统会自动同步对应气质</div>
                    </div>
                    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {templateFrameStyles.map((style) => (
                        <button
                          key={style.value}
                          type="button"
                          onClick={() => setTemplateFrameStyle(style.value)}
                          className={`rounded-[20px] border px-4 py-3 text-left transition ${
                            templateFrameStyle === style.value
                              ? 'border-[#4ea58c] bg-[linear-gradient(180deg,rgba(78,165,140,0.18),rgba(78,165,140,0.08))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
                              : 'border-[#26323a] bg-[#181e28] hover:border-[#33424a] hover:bg-[#1b222d]'
                          }`}
                        >
                          <div className="mb-3">{renderTemplateFramePreview(style.value)}</div>
                          <div className={`text-sm font-medium ${templateFrameStyle === style.value ? 'text-white' : 'text-slate-200'}`}>{style.label}</div>
                          <div className={`mt-1 text-xs leading-5 ${templateFrameStyle === style.value ? 'text-emerald-100/70' : 'text-slate-500'}`}>{style.description}</div>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            )}

            {shouldShowSuggestedReferenceAssets && (
              <section className="rounded-[24px] border border-sky-400/15 bg-sky-400/[0.06] p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-200/80">
                      {imageMode === '物料融合' ? '可补充素材' : '候选参考素材'}
                    </div>
                    <div className="mt-1 text-sm text-slate-300">
                      {imageMode === '物料融合'
                        ? '这些只是可补充进素材库的候选，不会覆盖已生成的逐图主素材分配。'
                        : '根据产品信息、正文和素材备注，系统认为这些素材适合参与本次出图。'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleApplySuggestedReferenceAssets}
                    className="h-10 rounded-xl bg-white px-4 text-sm font-semibold text-slate-950 transition hover:bg-slate-100"
                  >
                    补充候选素材
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
                  {suggestedReferenceAssets.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => handleToggleReferenceAsset(asset.id)}
                      className="group overflow-hidden rounded-2xl border border-white/10 bg-black/20 text-left transition hover:border-sky-300/40 hover:bg-black/30"
                    >
                      <img src={asset.url} alt={asset.display_name || asset.original_name} className="h-28 w-full object-cover bg-black/30" />
                      <div className="p-3">
                        <div className="truncate text-sm font-medium text-white">{asset.display_name || asset.original_name}</div>
                        <div className="mt-1 line-clamp-1 text-xs text-sky-100/70">
                          {asset.tags?.length ? asset.tags.map((tag) => `#${tag}`).join(' ') : asset.ai_hint || '可作为产品/品牌参考'}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {canUseReferenceAssetsForMode && (
              <ReferenceAssetLibrary
                assets={referenceAssets}
                selectedAssetIds={selectedAssetIds}
                primaryAssetId={primaryReferenceAsset?.id || null}
                onToggleAsset={handleToggleReferenceAsset}
                onSetPrimaryAsset={setPrimaryReferenceAssetId}
                onUpload={handleUploadReferenceAsset}
                onDelete={handleDeleteReferenceAsset}
                onUpdate={handleUpdateReferenceAsset}
                isUploading={isUploadingAsset}
                deletingAssetId={deletingAssetId}
              />
            )}

            {pendingConfirmation && (
              <div className="rounded-[28px] border border-emerald-400/18 bg-emerald-400/[0.07] p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-200/80">Final Step</div>
                    <div className="mt-2 text-lg font-semibold text-white">配置已确认后，在这里完成最终出图</div>
                    <div className="mt-1 text-sm leading-6 text-emerald-50/72">
                      当前将使用确认稿正文、{imageMode} 模式{canUseReferenceAssetsForMode ? `、${activeReferenceAssets.length > 0 ? `${activeReferenceAssets.length} 张参考素材` : '未选择素材'}` : ''}进行生成。
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    {hasActiveImageTasks ? (
                      <button
                        type="button"
                        onClick={handleCancelGeneration}
                        className="h-12 rounded-xl border border-red-500/30 bg-red-500/20 px-6 text-sm font-semibold text-red-300 hover:bg-red-500/30"
                      >
                        取消出图
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleConfirmGenerateClick}
                        className="h-12 rounded-xl bg-emerald-500 px-6 text-sm font-semibold text-white shadow-[0_16px_36px_rgba(16,185,129,0.18)] hover:bg-emerald-400"
                      >
                        {imageMode === '物料融合'
                          ? (materialFusionDraft ? '确认素材并出图' : '生成融合方案')
                          : '确认并出图'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}



            <div className="rounded-3xl bg-black/20 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_auto_minmax(250px,auto)] 2xl:items-center">
                <div className="min-w-0 2xl:max-w-[560px]">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">下一步</div>
                  {pendingConfirmation ? (
                    <>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={`${pendingConfirmation.confirmedForImageGeneration ? 'bg-emerald-500' : 'bg-xhs-red'} rounded-full px-2.5 py-1 text-[11px] font-semibold text-white`}>
                          {pendingConfirmation.confirmedForImageGeneration ? '文案已确认' : '初稿待确认'}
                        </span>
                        <span className="text-sm font-semibold text-white">{pendingConfirmation.title || '笔记初稿'}</span>
                        {activeStrategy && <span className="text-xs text-slate-500">{activeStrategy.contentAngle}</span>}
                      </div>
                      <div className="mt-2 text-sm leading-6 text-slate-400">
                        {pendingConfirmation.confirmedForImageGeneration
                          ? '文案已经确认，可以继续检查图片模式、素材和风格后出图。'
                          : '初稿已经生成，先到确认区修改标题和正文；满意后再进入出图配置。'}
                      </div>
                    </>
                  ) : activeStrategy ? (
                    <>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-xhs-red px-2.5 py-1 text-[11px] font-semibold text-white">当前策略</span>
                        <span className="text-sm font-semibold text-white">{activeStrategy.label}</span>
                        <span className="text-xs text-slate-500">{activeStrategy.contentAngle}</span>
                      </div>
                      <div className="mt-2 text-sm leading-6 text-slate-400">确认这个方向后写初稿；初稿生成后会进入确认区，修改满意后再出图。</div>
                    </>
                  ) : (
                    <div className="mt-2 text-sm leading-6 text-slate-400">先生成并选择笔记策略，再写初稿。策略会根据产品信息、对标笔记和素材自动生成。</div>
                  )}
                </div>
                <div className="flex w-full items-center 2xl:justify-center">
                  <div className="grid w-full max-w-[260px] grid-cols-3 overflow-hidden rounded-2xl border border-white/6 bg-white/[0.04] p-1 text-[11px] text-slate-400">
                    <div className={`flex h-8 items-center justify-center gap-1.5 rounded-xl px-2 ${activeStrategy ? 'bg-emerald-400/12 text-emerald-100' : ''}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${activeStrategy ? 'bg-emerald-300' : 'bg-slate-600'}`} />
                      <span className="whitespace-nowrap">策略</span>
                    </div>
                    <div className={`flex h-8 items-center justify-center gap-1.5 rounded-xl px-2 ${activeSession ? 'bg-emerald-400/12 text-emerald-100' : ''}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${activeSession ? 'bg-emerald-300' : 'bg-slate-600'}`} />
                      <span className="whitespace-nowrap">初稿</span>
                    </div>
                    <div className={`flex h-8 items-center justify-center gap-1.5 rounded-xl px-2 ${pendingConfirmation?.confirmedForImageGeneration ? 'bg-emerald-400/12 text-emerald-100' : ''}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${pendingConfirmation?.confirmedForImageGeneration ? 'bg-emerald-300' : 'bg-slate-600'}`} />
                      <span className="whitespace-nowrap">出图</span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                  {hasGeneratedFlow && (
                    <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                      <button
                        type="button"
                        onClick={handleRegenerateStrategy}
                        disabled={workflowResetDisabled}
                        className={`h-9 whitespace-nowrap rounded-xl border px-3 text-xs font-semibold transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/[0.05] text-slate-200 hover:bg-white/[0.1]'}`}
                      >
                        重生成策略
                      </button>
                      <button
                        type="button"
                        onClick={handleRegenerateDraft}
                        disabled={workflowResetDisabled}
                        className={`h-9 whitespace-nowrap rounded-xl border px-3 text-xs font-semibold transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/[0.05] text-slate-200 hover:bg-white/[0.1]'}`}
                      >
                        重生成初稿
                      </button>
                    </div>
                  )}
                  {hasActiveImageTasks && (
                    <button
                      type="button"
                      onClick={handleCancelGeneration}
                      className="px-6 h-12 rounded-xl font-semibold bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
                    >
                      取消生成
                    </button>
                  )}
                  {pendingConfirmation ? (
                    <button
                      type="button"
                      onClick={pendingConfirmation.confirmedForImageGeneration ? scrollToGenerationConfig : scrollToConfirmationSection}
                      disabled={isGenerating || isGeneratingStrategy}
                      className={`h-12 min-w-[156px] whitespace-nowrap rounded-xl px-6 font-semibold ${(isGenerating || isGeneratingStrategy) ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : pendingConfirmation.confirmedForImageGeneration ? 'bg-emerald-500 text-white hover:bg-emerald-400' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
                    >
                      {pendingConfirmation.confirmedForImageGeneration ? '进入出图配置' : '继续确认初稿'}
                    </button>
                  ) : activeStrategy ? (
                    <button
                      onClick={generateNoteDraft}
                      disabled={isGenerating || isGeneratingStrategy}
                      className={`h-12 min-w-[164px] whitespace-nowrap rounded-xl px-6 font-semibold ${(isGenerating || isGeneratingStrategy) ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-xhs-red text-white hover:bg-xhs-dark'}`}
                    >
                      {isGenerating ? '生成中...' : '用当前策略写初稿'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={generateStrategy}
                      disabled={isGenerating || isGeneratingStrategy}
                      className={`h-12 min-w-[132px] whitespace-nowrap rounded-xl px-6 font-semibold ${(isGenerating || isGeneratingStrategy) ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
                    >
                      {strategyPreviewActionLabel}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
          )}

          {activeWorkspacePanel === 'support' && !activeSession && (
            <section className="rounded-3xl border border-dashed border-white/10 bg-xhs-card p-6 text-center">
              <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">Support Analysis</div>
              <h3 className="mt-2 text-xl font-semibold text-white">辅助分析会在初稿生成后出现</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-400">
                这里会展示候选标题、正文版本、去 AI 味分析和风险句。当前还没有初稿数据，所以先生成或恢复初稿即可。
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setActiveWorkspacePanel('draft')}
                  className="h-11 rounded-xl border border-white/10 bg-white/5 px-5 text-sm font-semibold text-slate-200 hover:bg-white/10"
                >
                  去笔记初稿
                </button>
                <button
                  type="button"
                  onClick={activeStrategy ? generateNoteDraft : generateStrategy}
                  disabled={isGenerating || isGeneratingStrategy}
                  className={`h-11 rounded-xl px-5 text-sm font-semibold ${(isGenerating || isGeneratingStrategy) ? 'cursor-not-allowed bg-slate-700 text-slate-300' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
                >
                  {activeStrategy ? '用当前策略写初稿' : strategyPreviewActionLabel}
                </button>
              </div>
            </section>
          )}

          {activeSession && activeWorkspacePanel === 'support' && (
            <section className="space-y-6">
              <details
                open={isSupportAnalysisOpen}
                onToggle={(event) => setIsSupportAnalysisOpen((event.currentTarget as HTMLDetailsElement).open)}
                className="bg-xhs-card border border-white/5 rounded-3xl p-6"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">辅助分析</div>
                    <h3 className="mt-2 text-xl font-semibold text-white">查看候选、版本对比和去 AI 味分析</h3>
                    <p className="mt-2 text-sm text-slate-400">
                      当前采用稿来源：{supportAnalysisSummary.source} · 去 AI 味摘要：{supportAnalysisSummary.deAi} · 风险句 {supportAnalysisSummary.riskCount} 条
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleRegenerateDraft();
                      }}
                      disabled={workflowResetDisabled}
                      className={`rounded-full border px-3 py-1 text-xs transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}`}
                    >
                      重生成初稿
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleRegenerateStrategy();
                      }}
                      disabled={workflowResetDisabled}
                      className={`rounded-full border px-3 py-1 text-xs transition ${workflowResetDisabled ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}`}
                    >
                      重生成策略
                    </button>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">
                      {isSupportAnalysisOpen ? '收起' : '展开创作分析'}
                    </span>
                  </div>
                </summary>

                <div className="mt-6 space-y-6">
                  <div className="bg-black/10 border border-white/6 rounded-3xl p-6">
                    <h4 className="text-lg font-semibold text-white mb-4">正文版本对比</h4>
                    <div className="grid grid-cols-1 gap-6">
                      <div className="space-y-3">
                    <div className="rounded-2xl border border-white/6 bg-white/[0.03] p-3.5">
                      <div className="mb-3 flex flex-wrap gap-2">
                        {rewriteBodySections.map((section) => (
                          <button
                            key={section.key}
                            onClick={() => {
                              setSelectedRewriteBodyKey(section.key);
                              setIsRewriteBodyExpanded(false);
                            }}
                            className={`rounded-full border px-3 py-1.5 text-xs transition ${
                              activeRewriteBodySection?.key === section.key
                                ? 'border-white/20 bg-white text-slate-900'
                                : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                            }`}
                          >
                            {section.label}
                          </button>
                        ))}
                      </div>

                      {activeRewriteBodySection && (
                        <div
                          className={`rounded-2xl border p-4 ${activeRewriteBodySection.toneClassName} ${activeRewriteBodySection.featured ? 'shadow-[0_16px_40px_rgba(56,189,248,0.08)]' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-base font-semibold text-white">{activeRewriteBodySection.label}</p>
                                <span className={`rounded-full px-2.5 py-1 text-[11px] ${activeRewriteBodySection.featured ? 'bg-sky-400/16 text-sky-200' : 'bg-white/8 text-slate-300'}`}>
                                  {activeRewriteBodySection.badge}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-slate-400">{activeRewriteBodySection.hint}</p>
                            </div>
                            <button
                              onClick={() => setIsRewriteBodyExpanded((prev) => !prev)}
                              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:bg-white/10"
                            >
                              {isRewriteBodyExpanded ? '收起全文' : '展开全文'}
                            </button>
                          </div>
                          {activeRewriteBodySection.key !== 'draft' && (
                            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                              <div className="rounded-2xl border border-white/6 bg-black/15 px-3 py-2">
                                <div className="text-[11px] text-slate-500">对比基准</div>
                                <div className="mt-1 text-xs font-semibold text-slate-200">{activeRewriteDiffBaseLabel}</div>
                              </div>
                              <div className="rounded-2xl border border-emerald-400/12 bg-emerald-400/[0.06] px-3 py-2">
                                <div className="text-[11px] text-emerald-100/60">改动段落</div>
                                <div className="mt-1 text-xs font-semibold text-emerald-100">
                                  {activeRewriteDiffMeta.changedParagraphs}/{activeRewriteDiffMeta.totalParagraphs || 0}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-sky-400/12 bg-sky-400/[0.06] px-3 py-2">
                                <div className="text-[11px] text-sky-100/60">粗略变化</div>
                                <div className="mt-1 text-xs font-semibold text-sky-100">
                                  {activeRewriteDiffMeta.changed ? `${Math.round(activeRewriteDiffMeta.changeRatio * 100)}%` : '无明显差异'}
                                </div>
                              </div>
                            </div>
                          )}
                          {activeRewriteComparePairs.length > 0 && (
                            <div className="mt-4 rounded-2xl border border-emerald-400/12 bg-emerald-400/[0.045] p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <div className="text-sm font-semibold text-emerald-50">改动清单</div>
                                  <div className="mt-1 text-xs text-emerald-100/60">共 {activeRewriteComparePairs.length} 处，全部按左右对照展示</div>
                                </div>
                                <span className="rounded-full bg-emerald-400/12 px-2.5 py-1 text-[11px] text-emerald-100">
                                  {activeRewriteBodySection.label}
                                </span>
                              </div>
                              <div className="custom-scrollbar mt-4 max-h-[560px] space-y-3 overflow-y-auto pr-2">
                                {activeRewriteComparePairs.map((pair) => (
                                  <div key={pair.id} className="overflow-hidden rounded-2xl border border-white/8 bg-black/18">
                                    <div className="border-b border-white/6 px-3 py-2 text-[11px] text-slate-500">
                                      {pair.id === 'full-compare' ? '全文对比' : `第 ${pair.index + 1} 段 · ${pair.type === 'added' ? '新增' : pair.type === 'removed' ? '删除' : '改写'}`}
                                    </div>
                                    <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
                                      <div className="border-b border-white/6 p-3 md:border-b-0 md:border-r">
                                        <div className="mb-2 text-[11px] font-semibold text-slate-500">原稿</div>
                                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-slate-400">
                                          {pair.before || '无'}
                                        </p>
                                      </div>
                                      <div className="p-3">
                                        <div className="mb-2 text-[11px] font-semibold text-emerald-100/70">改后</div>
                                        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-emerald-50">
                                          {pair.after || '无'}
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="mt-4 rounded-2xl bg-black/10 px-4 py-4">
                            <div className="mb-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                              <span>{isRewriteBodyExpanded ? '全文视图' : '摘要预览'}{activeRewriteBodySection.key !== 'draft' ? ` · 浅绿色为相对${activeRewriteDiffBaseLabel}的改动段落` : ''}</span>
                              <span>{activeRewriteBodySection.content.trim().length} 字</span>
                            </div>
                            {isRewriteBodyExpanded ? (
                              <div className="custom-scrollbar max-h-[420px] space-y-3 overflow-y-auto pr-2 text-sm leading-7">
                                {activeRewriteParagraphs.map((paragraph) => (
                                  <p
                                    key={paragraph.id}
                                    className={`whitespace-pre-wrap break-words rounded-xl px-3 py-2 ${paragraph.changed ? 'border border-emerald-400/18 bg-emerald-400/[0.08] text-emerald-50' : activeRewriteBodySection.textClassName}`}
                                  >
                                    {paragraph.text}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <div
                                className={`custom-scrollbar whitespace-pre-wrap break-words text-sm leading-7 ${activeRewriteBodySection.textClassName} line-clamp-[8]`}
                              >
                                {buildRewriteSnippet(activeRewriteBodySection.content, 360)}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="bg-white/[0.03] border border-white/6 rounded-3xl p-6">
                      <h4 className="text-lg font-semibold text-white mb-4">去 AI 味报告</h4>
                      <div className="grid grid-cols-2 gap-3">
                        {deAiScoreCards.map((card) => (
                          <div key={card.label} className="rounded-2xl bg-white/5 p-4">
                            <p className="text-xs text-slate-500">{card.label}</p>
                            <p className={`mt-2 text-2xl font-bold ${card.value === '--' ? 'text-slate-500' : 'text-white'}`}>{card.value}</p>
                          </div>
                        ))}
                      </div>
                      {!hasDeAiMetric && (
                        <div className="mt-4 rounded-2xl border border-sky-400/15 bg-sky-400/[0.06] p-4 text-sm leading-6 text-sky-100/85">
                          这篇稿子来自旧正文生成路径，缺少四项量化评分；重新生成初稿后会走新版策略正文流程，并返回完整去 AI 味报告。
                        </div>
                      )}
                      <p className="text-sm text-slate-300 mt-4">{activeSession.de_ai_report?.summary || '暂无去 AI 味摘要。'}</p>
                      {deAiReportRows.length > 0 && (
                        <div className="mt-4 space-y-2">
                          {deAiReportRows.map((row) => (
                            <div key={row.label} className="flex gap-3 rounded-2xl bg-black/15 px-4 py-3 text-sm">
                              <span className="w-20 shrink-0 text-slate-500">{row.label}</span>
                              <span className="min-w-0 flex-1 text-slate-200">{row.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {activeSession.final_body_source === 'draft' && (
                        <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-sm text-amber-200">
                          当前采用正文主稿：{activeSession.polish_guardrail_reason || '轻改版和深改版都未通过完整性保护。'}
                        </div>
                      )}
                    </div>

                    <div className="bg-white/[0.03] border border-white/6 rounded-3xl p-6 space-y-4">
                      <div>
                        <h4 className="text-lg font-semibold text-white mb-4">风险句与替换句库</h4>
                        <div className="space-y-2">
                          {activeSession.high_risk_ai_sentences.length > 0 ? activeSession.high_risk_ai_sentences.map((sentence) => (
                            <div key={sentence} className="rounded-xl bg-rose-500/8 border border-rose-500/10 p-3 text-rose-100 text-sm">
                              {sentence}
                            </div>
                          )) : <div className="text-slate-400 text-sm">没有检测到明显高风险 AI 句子。</div>}
                        </div>
                      </div>
                      <div>
                        <p className="text-xs text-slate-500 mb-2">替换句库</p>
                        <div className="flex flex-wrap gap-2">
                          {activeSession.replacement_phrases.map((phrase) => (
                            <span key={phrase} className="px-3 py-1.5 rounded-full bg-white/5 text-slate-300 text-sm">{phrase}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </details>
            </section>
          )}
        </div>
      </div>
      </div>
      <CreativeDraftDrawer
        isOpen={isDraftDrawerOpen}
        onClose={() => setIsDraftDrawerOpen(false)}
        onImport={restoreCreativeDraft}
      />
      {selectingMaterialItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-5xl overflow-hidden rounded-3xl border border-white/10 bg-[#141821] shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <div className="text-base font-semibold text-white">选择主物料</div>
                <div className="mt-1 text-sm text-slate-400">第 {selectingMaterialItem.index} 张：{selectingMaterialItem.title}</div>
              </div>
              <button type="button" onClick={() => setSelectingMaterialItemId(null)} className="rounded-xl p-2 text-slate-500 hover:bg-white/10 hover:text-white">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="max-h-[70vh] overflow-y-auto p-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {materialCandidateAssets.map((asset) => {
                  const role = inferMaterialAssetRole(asset);
                  const isSelected = selectingMaterialItem.primaryAssetId === asset.id;
                  const canSelectAsPrimary = canUseMaterialAssetAsPrimary(asset);
                  return (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => {
                        if (!canSelectAsPrimary) {
                          alert('Logo、品牌风格和竞品参考会作为全局参考进入图片，不能作为某一页的主物料。请选择产品页或功能截图。');
                          return;
                        }
                        setMaterialPlanOverrides((prev) => ({
                          ...prev,
                          [selectingMaterialItem.id]: asset.id,
                        }));
                        setMaterialFusionDraft((prev) => prev
                                  ? {
                                      ...prev,
                                      planItems: prev.planItems.slice(0, MATERIAL_FUSION_MAX_IMAGE_COUNT).map((planItem) => planItem.id === selectingMaterialItem.id
                                        ? {
                                            ...planItem,
                                            primaryAssetId: asset.id,
                                            matchScore: scoreMaterialAssetForNeed(
                                              asset,
                                              buildMaterialNeedText(planItem),
                                              planItem.requiredKeywords || [],
                                            ),
                                            matchReason: '手动选择：将按这张素材作为主画面生成；如画面内容不贴合，建议换图或补图',
                                            selectionSource: 'manual',
                                            status: 'ready',
                                            missingReason: undefined,
                                          }
                                        : planItem),
                                    }
                          : prev);
                        setSelectedAssetIds((prev) => Array.from(new Set([...prev, asset.id])));
                        setPrimaryReferenceAssetId((prev) => prev || asset.id);
                        setSelectingMaterialItemId(null);
                      }}
                      className={`overflow-hidden rounded-2xl border text-left transition ${!canSelectAsPrimary ? 'border-white/6 bg-black/10 opacity-55' : isSelected ? 'border-amber-200 bg-amber-200/10' : 'border-white/10 bg-black/20 hover:border-amber-200/30 hover:bg-black/30'}`}
                    >
                      <div className="grid grid-cols-[92px_1fr] gap-3 p-3">
                        <img src={asset.url} alt={asset.display_name || asset.original_name} className="h-20 w-[92px] rounded-xl object-cover bg-black/30" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-amber-100">{materialAssetRoleLabels[role]}</span>
                            {isSelected && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-slate-950">当前</span>}
                            {!canSelectAsPrimary && <span className="rounded-full bg-slate-700 px-2 py-0.5 text-[11px] text-slate-300">全局参考</span>}
                          </div>
                          <div className="mt-2 truncate text-sm font-semibold text-white">{asset.display_name || asset.original_name}</div>
                          <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{asset.ai_hint || asset.note || '暂无 AI 说明'}</div>
                          {asset.tags?.length ? (
                            <div className="mt-2 line-clamp-1 text-[11px] text-sky-100/70">{asset.tags.slice(0, 4).map((tag) => `#${tag}`).join(' ')}</div>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
      {isSuggestedAssetConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-3xl overflow-hidden rounded-3xl border border-white/10 bg-[#141821] shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <div className="text-base font-semibold text-white">发现可用于本次出图的素材</div>
                <div className="mt-1 text-sm text-slate-400">系统根据产品信息、确认稿和素材备注找到了这些参考图。你可以采用后再出图，也可以跳过。</div>
              </div>
              <button type="button" onClick={() => setIsSuggestedAssetConfirmOpen(false)} className="rounded-xl p-2 text-slate-500 hover:bg-white/10 hover:text-white">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 p-5 md:grid-cols-3">
              {suggestedReferenceAssets.map((asset) => (
                <div key={asset.id} className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                  <img src={asset.url} alt={asset.display_name || asset.original_name} className="h-36 w-full object-cover bg-black/30" />
                  <div className="space-y-2 p-3">
                    <div className="truncate text-sm font-medium text-white">{asset.display_name || asset.original_name}</div>
                    <div className="line-clamp-2 text-xs leading-5 text-slate-400">
                      {asset.ai_hint || asset.note || (asset.tags?.length ? asset.tags.map((tag) => `#${tag}`).join(' ') : '可作为产品/品牌参考')}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-3 border-t border-white/10 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={handleSkipSuggestedAssetsAndGenerate}
                className="h-11 rounded-xl border border-white/10 px-4 text-sm text-slate-300 transition hover:bg-white/10"
              >
                不使用，继续出图
              </button>
              <button
                type="button"
                onClick={handleUseSuggestedAssetsAndGenerate}
                className="h-11 rounded-xl bg-white px-4 text-sm font-semibold text-slate-950 transition hover:bg-slate-100"
              >
                采用并出图
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CreationView;
