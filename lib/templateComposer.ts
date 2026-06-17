import { TemplateComposeDocument, TemplateComposeEditablePayload, TemplateComposeModule, TemplateComposeResult, TemplateFrameStyle, TemplateModuleLayout, TemplateScreenshot, TemplateStyleVariant } from '../types';
import {
  getStandardHeaderScale,
  getTemplateCanvasPadding,
  getTemplateContentScale,
  getStructuredContentDisplayProfile,
  getTextCoverDisplayContent,
  getTextCoverScaleProfile,
  getTextCoverSpacingProfile,
  shouldShowTextCoverSticker,
  TEMPLATE_CONTENT_LIMITS,
  truncateTemplateText,
} from './templatePreviewLayout';
import { getFrameTemplateProfile, TEXT_COVER_PROFILE } from './templateFixedProfiles';

const THEMES: Record<string, Record<string, string>> = {
  warm: {
    background: 'linear-gradient(180deg, #FFF7ED 0%, #FFE4E6 100%)',
    panel: '#FFFFFF',
    panelSoft: '#FFF1F2',
    text: '#1F2937',
    muted: '#6B7280',
    accent: '#F97316',
    accentSoft: '#FED7AA',
  },
  cool: {
    background: 'linear-gradient(180deg, #EFF6FF 0%, #E0F2FE 100%)',
    panel: '#FFFFFF',
    panelSoft: '#F0F9FF',
    text: '#0F172A',
    muted: '#64748B',
    accent: '#2563EB',
    accentSoft: '#BFDBFE',
  },
  forest: {
    background: 'linear-gradient(180deg, #F0FDF4 0%, #DCFCE7 100%)',
    panel: '#FFFFFF',
    panelSoft: '#ECFDF5',
    text: '#14532D',
    muted: '#4B5563',
    accent: '#16A34A',
    accentSoft: '#BBF7D0',
  },
  graphite: {
    background: 'linear-gradient(180deg, #F8FAFC 0%, #E2E8F0 100%)',
    panel: '#FFFFFF',
    panelSoft: '#F1F5F9',
    text: '#111827',
    muted: '#6B7280',
    accent: '#334155',
    accentSoft: '#CBD5E1',
  },
};

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const DEFAULT_BADGE_TEXT = '模板拼装';
const DEFAULT_MODULE_LAYOUT = { offsetX: 0, offsetY: 0 };
const FEATURE_HERO_FREE_LAYOUT_DEFAULTS: Record<'bullet_group' | 'screenshot_frame', Required<Pick<TemplateModuleLayout, 'x' | 'y' | 'width' | 'height'>>> = {
  bullet_group: { x: 0.02, y: 0.06, width: 0.28, height: 0.7 },
  screenshot_frame: { x: 0.26, y: 0.1, width: 0.72, height: 0.56 },
};
const FEATURE_HERO_FREE_LAYOUT_MIN: Record<'bullet_group' | 'screenshot_frame', Required<Pick<TemplateModuleLayout, 'width' | 'height'>>> = {
  bullet_group: { width: 0.24, height: 0.26 },
  screenshot_frame: { width: 0.3, height: 0.38 },
};
const STYLE_VARIANTS_BY_TEMPLATE: Record<string, TemplateStyleVariant[]> = {
  feature_hero: ['freeform_stage', 'text_cover_bold'],
  benefit_grid: ['highlight_screenshot_grid', 'annotated_highlight_grid'],
  step_guide: ['step_text_image', 'step_focus_screenshot'],
  before_after: [],
  faq_card: [],
};
const DEFAULT_STYLE_VARIANT_BY_TEMPLATE: Record<string, TemplateStyleVariant> = {
  feature_hero: 'freeform_stage',
  benefit_grid: 'highlight_screenshot_grid',
  step_guide: 'step_text_image',
};
const FRAME_STYLES_BY_TEMPLATE: Record<string, TemplateFrameStyle[]> = {
  feature_hero: ['soft_gradient_card', 'sunset_glow_card', 'editorial_outline_card', 'notebook_tape_card', 'split_banner_card'],
  benefit_grid: ['soft_gradient_card', 'sunset_glow_card', 'editorial_outline_card', 'notebook_tape_card', 'split_banner_card'],
  step_guide: ['soft_gradient_card', 'sunset_glow_card', 'editorial_outline_card', 'notebook_tape_card', 'split_banner_card'],
};
const DEFAULT_FRAME_STYLE_BY_TEMPLATE: Record<string, TemplateFrameStyle> = {
  feature_hero: 'soft_gradient_card',
  benefit_grid: 'soft_gradient_card',
  step_guide: 'soft_gradient_card',
};
const DEFAULT_STYLE_SLOTS_BY_VARIANT: Partial<Record<TemplateStyleVariant, Record<string, string>>> = {
  text_cover_bold: {
    brandText: '小红书@品牌名',
    topRightText: '收藏关注不迷路',
    stickerText: '超详细',
    introPrefix: '',
    introEmoji: '',
    bottomLabel: '',
    bottomHeadline: '运营人都在看',
  },
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const getTemplateStyleVariants = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind']
) => STYLE_VARIANTS_BY_TEMPLATE[String(templateKind)] || [];

export const getDefaultStyleVariant = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  cardType?: string | null
): TemplateStyleVariant | undefined => {
  if (templateKind === 'feature_hero' && ['封面卡', '收口卡'].includes(String(cardType || ''))) {
    return 'text_cover_bold';
  }
  return DEFAULT_STYLE_VARIANT_BY_TEMPLATE[String(templateKind)];
};

export const getTemplateFrameStyles = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind']
) => FRAME_STYLES_BY_TEMPLATE[String(templateKind)] || [];

export const resolveTemplateFrameStyle = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  frameStyle?: TemplateFrameStyle | string | null
): TemplateFrameStyle | undefined => {
  const supported = getTemplateFrameStyles(templateKind);
  if (!supported.length) {
    return undefined;
  }
  if (frameStyle && supported.includes(frameStyle as TemplateFrameStyle)) {
    return frameStyle as TemplateFrameStyle;
  }
  return DEFAULT_FRAME_STYLE_BY_TEMPLATE[String(templateKind)];
};

export const getDefaultStyleSlots = (
  styleVariant?: TemplateStyleVariant | string | null
): Record<string, string> => ({
  ...(DEFAULT_STYLE_SLOTS_BY_VARIANT[(styleVariant || '') as TemplateStyleVariant] || {}),
});

const resolveStyleSlots = (
  styleVariant?: TemplateStyleVariant | string | null,
  styleSlots?: Record<string, string>
) => ({
  ...getDefaultStyleSlots(styleVariant),
  ...(styleSlots || {}),
});

export const resolveTemplateStyleVariant = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  styleVariant?: TemplateStyleVariant | string | null,
  cardType?: string | null
): TemplateStyleVariant | undefined => {
  const supported = getTemplateStyleVariants(templateKind);
  if (!supported.length) {
    return undefined;
  }
  if (styleVariant && supported.includes(styleVariant as TemplateStyleVariant)) {
    return styleVariant as TemplateStyleVariant;
  }
  return getDefaultStyleVariant(templateKind, cardType);
};

export const getDefaultScreenshotFitMode = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind']
) => (templateKind === 'feature_hero' ? 'contain' as const : 'cover' as const);

const normalizeCrop = (
  screenshot?: TemplateScreenshot,
  templateKind?: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind']
) => ({
  x: typeof screenshot?.crop?.x === 'number' ? screenshot.crop.x : 50,
  y: typeof screenshot?.crop?.y === 'number' ? screenshot.crop.y : 50,
  zoom: typeof screenshot?.crop?.zoom === 'number' ? screenshot.crop.zoom : 1,
  fitMode: screenshot?.crop?.fitMode === 'contain'
    ? 'contain' as const
    : getDefaultScreenshotFitMode(templateKind || 'feature_hero'),
});

export const isWhitePanelFreeLayoutModule = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  moduleType: TemplateComposeModule['type'],
  styleVariant?: TemplateStyleVariant | string | null
) => (
  templateKind === 'feature_hero'
  && resolveTemplateStyleVariant(templateKind, styleVariant) === 'freeform_stage'
  && (moduleType === 'bullet_group' || moduleType === 'screenshot_frame')
);

const getFeatureHeroDefaultLayout = (
  moduleType: 'bullet_group' | 'screenshot_frame',
  screenshot?: TemplateScreenshot
) => {
  if (moduleType === 'bullet_group') {
    return FEATURE_HERO_FREE_LAYOUT_DEFAULTS.bullet_group;
  }

  const fallback = FEATURE_HERO_FREE_LAYOUT_DEFAULTS.screenshot_frame;
  const width = typeof screenshot?.width === 'number' ? screenshot.width : 0;
  const height = typeof screenshot?.height === 'number' ? screenshot.height : 0;
  if (!width || !height) {
    return fallback;
  }

  const aspectRatio = width / height;
  const maxWidth = 0.72;
  const maxHeight = 0.84;
  const minWidth = FEATURE_HERO_FREE_LAYOUT_MIN.screenshot_frame.width;
  const minHeight = FEATURE_HERO_FREE_LAYOUT_MIN.screenshot_frame.height;
  let resolvedWidth = maxWidth;
  let resolvedHeight = resolvedWidth / aspectRatio;

  if (resolvedHeight > maxHeight) {
    resolvedHeight = maxHeight;
    resolvedWidth = resolvedHeight * aspectRatio;
  }
  if (resolvedWidth < minWidth) {
    resolvedWidth = minWidth;
    resolvedHeight = resolvedWidth / aspectRatio;
  }
  if (resolvedHeight < minHeight) {
    resolvedHeight = minHeight;
    resolvedWidth = resolvedHeight * aspectRatio;
  }

  resolvedWidth = clamp(resolvedWidth, minWidth, maxWidth);
  resolvedHeight = clamp(resolvedHeight, minHeight, maxHeight);

  return {
    x: 0.26 + (maxWidth - resolvedWidth),
    y: 0.1 + (maxHeight - resolvedHeight) / 2,
    width: resolvedWidth,
    height: resolvedHeight,
  };
};

const normalizeFeatureHeroFreeLayout = (
  layout: TemplateComposeModule['layout'] | undefined,
  moduleType: 'bullet_group' | 'screenshot_frame',
  screenshot?: TemplateScreenshot
): TemplateModuleLayout => {
  const defaults = getFeatureHeroDefaultLayout(moduleType, screenshot);
  const minSize = FEATURE_HERO_FREE_LAYOUT_MIN[moduleType];
  const fallbackX = defaults.x + (typeof layout?.offsetX === 'number' ? layout.offsetX : 0);
  const fallbackY = defaults.y + (typeof layout?.offsetY === 'number' ? layout.offsetY : 0);
  const width = clamp(
    typeof layout?.width === 'number' ? layout.width : defaults.width,
    minSize.width,
    1
  );
  const height = clamp(
    typeof layout?.height === 'number' ? layout.height : defaults.height,
    minSize.height,
    1
  );
  const x = clamp(typeof layout?.x === 'number' ? layout.x : fallbackX, 0, 1 - width);
  const y = clamp(typeof layout?.y === 'number' ? layout.y : fallbackY, 0, 1 - height);

  return {
    ...layout,
    x,
    y,
    width,
    height,
    offsetX: typeof layout?.offsetX === 'number' ? layout.offsetX : 0,
    offsetY: typeof layout?.offsetY === 'number' ? layout.offsetY : 0,
  };
};

const buildFeatureHeroBoxStyle = (layout: TemplateModuleLayout) => [
  'position:absolute',
  `left:${(layout.x || 0) * 100}%`,
  `top:${(layout.y || 0) * 100}%`,
  `width:${(layout.width || 0) * 100}%`,
  `height:${(layout.height || 0) * 100}%`,
].join(';');

export const getModuleOffsetBounds = (
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  moduleType: TemplateComposeModule['type'],
  styleVariant?: TemplateStyleVariant | string | null
) => {
  if (isWhitePanelFreeLayoutModule(templateKind, moduleType, styleVariant)) {
    return { x: 0, y: 0 };
  }
  if (moduleType === 'screenshot_frame') {
    switch (templateKind) {
      case 'before_after':
        return { x: 0.08, y: 0.08 };
      case 'step_guide':
        return { x: 0.06, y: 0.06 };
      default:
        return { x: 0.12, y: 0.1 };
    }
  }

  if (moduleType === 'bullet_group') {
    return templateKind === 'feature_hero'
      ? { x: 0.1, y: 0.12 }
      : { x: 0, y: 0 };
  }

  return { x: 0, y: 0 };
};

export const normalizeModuleLayout = (
  layout: TemplateComposeModule['layout'] | undefined,
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  moduleType: TemplateComposeModule['type'],
  options?: {
    referenceScreenshot?: TemplateScreenshot;
    styleVariant?: TemplateStyleVariant | string | null;
  }
): TemplateModuleLayout => {
  if (isWhitePanelFreeLayoutModule(templateKind, moduleType, options?.styleVariant)) {
    return normalizeFeatureHeroFreeLayout(
      layout,
      moduleType as 'bullet_group' | 'screenshot_frame',
      options?.referenceScreenshot
    );
  }

  const bounds = getModuleOffsetBounds(templateKind, moduleType, options?.styleVariant);
  const rawOffsetX = typeof layout?.offsetX === 'number' ? layout.offsetX : 0;
  const rawOffsetY = typeof layout?.offsetY === 'number' ? layout.offsetY : 0;

  return {
    ...layout,
    offsetX: Math.max(-bounds.x, Math.min(bounds.x, rawOffsetX)),
    offsetY: Math.max(-bounds.y, Math.min(bounds.y, rawOffsetY)),
  };
};

const buildModuleTransformStyle = (
  canvas: { width: number; height: number },
  templateKind: TemplateComposeDocument['templateKind'] | TemplateComposeEditablePayload['templateKind'],
  moduleType: TemplateComposeModule['type'],
  styleVariant?: TemplateStyleVariant | string | null,
  layout?: TemplateComposeModule['layout']
) => {
  const normalizedLayout = normalizeModuleLayout(layout, templateKind, moduleType, { styleVariant });
  return `transform:translate(${(normalizedLayout.offsetX || 0) * canvas.width}px, ${(normalizedLayout.offsetY || 0) * canvas.height}px);`;
};

const buildImageStyle = (shot?: TemplateScreenshot): string => {
  const crop = normalizeCrop(shot);
  return [
    'position:absolute',
    'inset:0',
    'width:100%',
    'height:100%',
    `object-fit:${crop.fitMode}`,
    `object-position:${crop.x}% ${crop.y}%`,
    `transform:scale(${crop.zoom})`,
    `transform-origin:${crop.x}% ${crop.y}%`,
  ].join(';');
};

const buildImageMarkup = (shot?: TemplateScreenshot, background = '#E5E7EB') => `
  <div style="position:relative;width:100%;height:100%;overflow:hidden;background:${background};">
    ${shot?.url
      ? `<img src="${escapeHtml(shot.url)}" style="${buildImageStyle(shot)}" />`
      : `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#E2E8F0 0%,#CBD5E1 100%);color:#64748B;font-size:28px;font-weight:700;letter-spacing:0.04em;">点击插入截图</div>`}
  </div>
`;

const getFrameAppearance = (
  theme: Record<string, string>,
  frameStyle?: TemplateFrameStyle | string | null
) => {
  switch (frameStyle) {
    case 'notebook_tape_card':
      return {
        canvasBackground: 'linear-gradient(180deg, #FFFDF7 0%, #F5EFE4 100%)',
        panelBackground: '#FFFCF6',
        panelBorder: '1px solid rgba(120,113,108,0.14)',
        panelShadow: '0 24px 60px rgba(120,113,108,0.10)',
        shellBorderRadius: '30px',
        mutedAccent: '#8B5E3C',
      };
    case 'split_banner_card':
      return {
        canvasBackground: 'linear-gradient(180deg, #F8FAFC 0%, #EEF2FF 100%)',
        panelBackground: '#FFFFFF',
        panelBorder: '1px solid rgba(59,130,246,0.12)',
        panelShadow: '0 26px 70px rgba(59,130,246,0.12)',
        shellBorderRadius: '30px',
        mutedAccent: '#2563EB',
      };
    case 'sunset_glow_card':
      return {
        canvasBackground: 'linear-gradient(140deg, #FFF2E2 0%, #FFD7C6 42%, #FFC7B2 100%)',
        panelBackground: 'linear-gradient(180deg, rgba(255,250,245,0.94) 0%, rgba(255,241,232,0.98) 100%)',
        panelBorder: '1px solid rgba(249,115,22,0.18)',
        panelShadow: '0 30px 90px rgba(249,115,22,0.18)',
        shellBorderRadius: '34px',
        mutedAccent: '#EA580C',
      };
    case 'editorial_outline_card':
      return {
        canvasBackground: 'linear-gradient(180deg, #FFFDF9 0%, #F4EBDD 100%)',
        panelBackground: '#FFFDF8',
        panelBorder: '2px solid rgba(31,41,55,0.18)',
        panelShadow: '0 22px 50px rgba(15,23,42,0.06)',
        shellBorderRadius: '32px',
        mutedAccent: '#1F2937',
      };
    default:
      return {
        canvasBackground: 'linear-gradient(180deg, #FFF8F1 0%, #FCEEE7 100%)',
        panelBackground: '#FFFEFC',
        panelBorder: '1px solid rgba(148,163,184,0.16)',
        panelShadow: '0 28px 70px rgba(15,23,42,0.10)',
        shellBorderRadius: '36px',
        mutedAccent: theme.accent,
      };
  }
};

const getTextCoverAppearance = (frameStyle?: TemplateFrameStyle | string | null) => {
  switch (frameStyle) {
    case 'sunset_glow_card':
      return {
        background: '#FFF7F0',
        ink: '#2B211C',
        subInk: '#6A4A3A',
        accent: '#C96A2B',
        border: '#7A4A2A',
        ctaBg: '#2B211C',
      };
    case 'split_banner_card':
      return {
        background: '#F7FAFE',
        ink: '#132033',
        subInk: '#406080',
        accent: '#2563EB',
        border: '#2D5B9A',
        ctaBg: '#132033',
      };
    case 'notebook_tape_card':
      return {
        background: '#FFFDF7',
        ink: '#26211B',
        subInk: '#7C6856',
        accent: '#8B5E3C',
        border: '#7C6856',
        ctaBg: '#3A2A1F',
      };
    case 'editorial_outline_card':
      return {
        background: '#FFFDF8',
        ink: '#111111',
        subInk: '#4B4B4B',
        accent: '#2A2A2A',
        border: '#2A2A2A',
        ctaBg: '#111111',
      };
    default:
      return {
        background: '#FCFCFA',
        ink: '#111111',
        subInk: '#565656',
        accent: '#3A3A3A',
        border: '#4A4A4A',
        ctaBg: '#202020',
      };
  }
};

export const renderTemplateAssetDataUrl = (
  payload: TemplateComposeEditablePayload,
  options?: {
    moduleLayouts?: Partial<Record<TemplateComposeModule['type'], TemplateComposeModule['layout']>>;
  }
): string => {
  const theme = THEMES[payload.themeKey] || THEMES.warm;
  const compact = payload.density === 'compact';
  const styleVariant = resolveTemplateStyleVariant(payload.templateKind, payload.styleVariant);
  const frameStyle = resolveTemplateFrameStyle(payload.templateKind, payload.frameStyle);
  const frameAppearance = getFrameAppearance(theme, frameStyle);
  const textCoverAppearance = getTextCoverAppearance(frameStyle);
  const styleSlots = resolveStyleSlots(styleVariant, payload.styleSlots);
  const displayHeaderTitle = truncateTemplateText(payload.title, TEMPLATE_CONTENT_LIMITS.title + 12);
  const displayHeaderSubtitle = truncateTemplateText(payload.subtitle || '', TEMPLATE_CONTENT_LIMITS.subtitle + 12);
  const displayTextCover = getTextCoverDisplayContent(payload.title, payload.subtitle || '全流程', styleSlots.bottomHeadline || '');
  const textCoverScale = getTextCoverScaleProfile(displayTextCover.title, displayTextCover.subtitle || '全流程', displayTextCover.bottomHeadline || '');
  const textCoverSpacing = getTextCoverSpacingProfile(displayTextCover.title, displayTextCover.subtitle || '全流程', displayTextCover.bottomHeadline || '');
  const showTextCoverSticker = shouldShowTextCoverSticker(displayTextCover.title, displayTextCover.subtitle || '全流程', styleSlots.stickerText);
  const standardHeaderScale = getStandardHeaderScale(payload.templateKind, styleVariant, payload.title, payload.subtitle, frameStyle);
  const frameTemplateProfile = getFrameTemplateProfile(frameStyle);
  const canvasPadding = getTemplateCanvasPadding(styleVariant);
  const screenshots = payload.screenshots || [];
  const screenshot = screenshots[0];
  const secondScreenshot = screenshots[1] || screenshots[0];
  const badgeText = payload.badgeText || DEFAULT_BADGE_TEXT;
  const moduleLayouts = options?.moduleLayouts || {};
  const bulletGroupTransform = buildModuleTransformStyle(payload.canvas, payload.templateKind, 'bullet_group', styleVariant, moduleLayouts.bullet_group);
  const screenshotFrameTransform = buildModuleTransformStyle(payload.canvas, payload.templateKind, 'screenshot_frame', styleVariant, moduleLayouts.screenshot_frame);
  const bulletGroupLayout = normalizeModuleLayout(moduleLayouts.bullet_group, payload.templateKind, 'bullet_group', { styleVariant });
  const screenshotFrameLayout = normalizeModuleLayout(moduleLayouts.screenshot_frame, payload.templateKind, 'screenshot_frame', {
    referenceScreenshot: screenshot,
    styleVariant,
  });
  const usesEditorialShell = frameStyle === 'editorial_outline_card' && styleVariant !== 'text_cover_bold';
  const usesSunsetShell = frameStyle === 'sunset_glow_card' && styleVariant !== 'text_cover_bold';
  const usesNotebookShell = frameStyle === 'notebook_tape_card' && styleVariant !== 'text_cover_bold';
  const usesSplitShell = frameStyle === 'split_banner_card' && styleVariant !== 'text_cover_bold';
  const usesSoftShell = !usesSunsetShell && !usesEditorialShell && !usesNotebookShell && !usesSplitShell && styleVariant !== 'text_cover_bold';
  const benefitProfile = getStructuredContentDisplayProfile('benefit_grid', payload.features || []);
  const faqProfile = getStructuredContentDisplayProfile('faq_card', payload.faqItems || []);
  const stepProfile = getStructuredContentDisplayProfile('step_guide', payload.steps || []);
  const contentItemCount = payload.templateKind === 'benefit_grid'
    ? Math.min(8, Math.max(1, (payload.features || []).length || 1))
    : payload.templateKind === 'faq_card'
      ? Math.min(4, Math.max(1, (payload.faqItems || []).length || 1))
      : payload.templateKind === 'step_guide'
        ? Math.min(4, Math.max(1, (payload.steps || []).length || 1))
        : payload.templateKind === 'feature_hero'
          ? Math.min(4, Math.max(1, (payload.bullets || []).length || 1))
          : 2;
  const contentScale = getTemplateContentScale(payload.templateKind, contentItemCount, styleVariant);
  const bodyText = truncateTemplateText(String(payload.bodyText || ''), (
    payload.templateKind === 'benefit_grid'
      ? TEMPLATE_CONTENT_LIMITS.bodyTextBenefit
      : payload.templateKind === 'step_guide'
        ? TEMPLATE_CONTENT_LIMITS.bodyTextStep
        : payload.templateKind === 'faq_card'
          ? TEMPLATE_CONTENT_LIMITS.bodyTextFaq
          : TEMPLATE_CONTENT_LIMITS.footer
  ));

  const bulletItems = (payload.bullets || [])
    .slice(0, 4)
    .map((item) => `
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <div style="margin-top:6px;width:10px;height:10px;border-radius:999px;background:${theme.accent};flex:0 0 auto;"></div>
        <div style="font-size:${contentScale.bullet}px;line-height:1.56;color:${theme.text};font-weight:650;">${escapeHtml(truncateTemplateText(item, TEMPLATE_CONTENT_LIMITS.bullet))}</div>
      </div>
    `)
    .join('');

  const featureCards = (payload.features || [])
    .slice(0, benefitProfile.maxItems)
    .map((item) => `
      <div style="flex:1 1 0;min-width:0;border-radius:24px;background:${theme.panelSoft};padding:22px 18px;">
        <div style="font-size:${contentScale.featureTitle}px;font-weight:850;color:${theme.text};line-height:1.24;">${escapeHtml(truncateTemplateText(item.title, TEMPLATE_CONTENT_LIMITS.featureTitle))}</div>
        <div style="margin-top:12px;font-size:${contentScale.featureDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description, TEMPLATE_CONTENT_LIMITS.featureDescription))}</div>
      </div>
    `)
    .join('');

  const stepItems = (payload.steps || [])
    .slice(0, stepProfile.maxItems)
    .map((item, index) => `
      <div style="display:flex;gap:14px;padding:18px 0;border-top:${index === 0 ? 'none' : '1px solid rgba(15,23,42,0.08)'};">
        <div style="width:38px;height:38px;border-radius:999px;background:${theme.accentSoft};color:${theme.accent};display:flex;align-items:center;justify-content:center;font-size:${contentScale.stepIndex}px;font-weight:900;flex:0 0 auto;">${index + 1}</div>
        <div>
          <div style="font-size:${contentScale.stepTitle}px;font-weight:850;color:${theme.text};line-height:1.24;">步骤 ${index + 1}</div>
          <div style="margin-top:8px;font-size:${contentScale.stepDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description || item.title, TEMPLATE_CONTENT_LIMITS.stepDescription))}</div>
        </div>
      </div>
    `)
    .join('');

  const faqCards = (payload.faqItems || [])
    .slice(0, faqProfile.maxItems)
    .map((item) => `
      <div style="border-radius:24px;background:${theme.panelSoft};padding:24px 22px;">
        <div style="font-size:${contentScale.faqTitle}px;font-weight:850;color:${theme.text};line-height:1.24;">${escapeHtml(truncateTemplateText(item.title, TEMPLATE_CONTENT_LIMITS.faqTitle))}</div>
        <div style="margin-top:12px;font-size:${contentScale.faqDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description, TEMPLATE_CONTENT_LIMITS.faqDescription))}</div>
      </div>
    `)
    .join('');

  const bodyTextMarkup = bodyText
    ? `
      <div style="border-radius:24px;background:${theme.panel};padding:22px 20px;border:1px solid rgba(15,23,42,0.06);box-shadow:0 18px 36px rgba(15,23,42,0.06);">
        <div style="font-size:${Math.max(22, contentScale.featureDescription)}px;line-height:1.7;color:${theme.text};font-weight:650;white-space:pre-line;">${escapeHtml(bodyText)}</div>
      </div>
    `
    : '';

  let body = '';
  switch (payload.templateKind) {
    case 'feature_hero':
      if (styleVariant === 'text_cover_bold') {
        body = `
          <div style="display:flex;flex-direction:column;justify-content:space-between;height:100%;padding:6px 4px 0;color:${textCoverAppearance.ink};font-family:'Arial Black','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">
            <div>
              <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;font-size:${textCoverScale.topMeta}px;font-weight:900;letter-spacing:-0.03em;color:${textCoverAppearance.subInk};">
                <div>${escapeHtml(styleSlots.brandText || badgeText)}</div>
                <div>${escapeHtml(styleSlots.topRightText || '')}</div>
              </div>
              <div style="margin-top:${textCoverSpacing.titleMarginTop}px;max-width:${TEXT_COVER_PROFILE.titleMaxWidth};font-size:${textCoverScale.title}px;font-weight:900;line-height:${textCoverScale.titleLineHeight || TEXT_COVER_PROFILE.titleLineHeight};color:${textCoverAppearance.ink};letter-spacing:${textCoverScale.titleTracking};white-space:pre-line;word-break:${TEXT_COVER_PROFILE.wordBreak};overflow-wrap:${TEXT_COVER_PROFILE.overflowWrap};">${escapeHtml(displayTextCover.title)}</div>
              <div style="margin-top:16px;display:flex;flex-direction:column;gap:${textCoverSpacing.dividerGap}px;">
                <div style="height:${textCoverScale.divider}px;background:${textCoverAppearance.accent};"></div>
                <div style="height:${textCoverScale.divider}px;background:${textCoverAppearance.accent};"></div>
              </div>
              <div style="margin-top:${textCoverSpacing.subtitleMarginTop}px;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
                <div style="flex:1;max-width:${showTextCoverSticker ? TEXT_COVER_PROFILE.subtitleMaxWidth : '100%'};font-size:${textCoverScale.subtitle}px;font-weight:900;line-height:${textCoverScale.subtitleLineHeight || 0.96};color:${textCoverAppearance.ink};letter-spacing:${textCoverScale.subtitleTracking};white-space:pre-line;word-break:${TEXT_COVER_PROFILE.wordBreak};overflow-wrap:${TEXT_COVER_PROFILE.overflowWrap};">${escapeHtml(displayTextCover.subtitle || '全流程')}</div>
                ${showTextCoverSticker ? `<div style="border:6px solid ${textCoverAppearance.border};border-radius:999px;padding:${textCoverSpacing.stickerPadding};font-size:${textCoverScale.sticker}px;font-weight:900;line-height:1;color:${textCoverAppearance.border};white-space:nowrap;">${escapeHtml(styleSlots.stickerText || '')}</div>` : ''}
              </div>
              ${payload.footerNote ? `<div style="margin-top:26px;font-size:${textCoverScale.footer}px;line-height:${textCoverScale.footerLineHeight};font-weight:700;color:${textCoverAppearance.subInk};opacity:0.82;">${escapeHtml(payload.footerNote)}</div>` : ''}
            </div>
            <div style="padding-top:${textCoverSpacing.bottomPaddingTop}px;">
              <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;">
                <div style="max-width:${TEXT_COVER_PROFILE.bottomHeadlineMaxWidth};padding-top:${textCoverSpacing.footerTopMargin}px;font-size:${textCoverScale.bottomHeadline}px;font-weight:900;line-height:0.92;letter-spacing:-0.1em;color:${textCoverAppearance.accent};white-space:pre-line;">${escapeHtml(displayTextCover.bottomHeadline || '')}</div>
                ${payload.ctaText ? `<div style="display:inline-flex;align-items:center;justify-content:center;border-radius:999px;padding:${textCoverScale.ctaPadding};background:${textCoverAppearance.ctaBg};color:#FFFFFF;font-size:${textCoverScale.cta}px;font-weight:800;white-space:nowrap;">${escapeHtml(payload.ctaText)}</div>` : ''}
              </div>
            </div>
          </div>
        `;
      } else {
        body = `
          <div style="position:relative;flex:1 1 auto;min-height:0;height:100%;">
            <div style="${buildFeatureHeroBoxStyle(bulletGroupLayout)};display:flex;flex-direction:column;gap:16px;overflow:hidden;">
              ${bulletItems || `<div style="font-size:${contentScale.bulletPlaceholder}px;line-height:1.6;color:#94A3B8;font-weight:700;">点击右侧新增文案项</div>`}
            </div>
            <div style="${buildFeatureHeroBoxStyle(screenshotFrameLayout)};">
                ${buildImageMarkup(screenshot, 'transparent')}
            </div>
          </div>
        `;
      }
      break;
    case 'benefit_grid':
      body = `
        <div style="display:flex;flex-direction:column;gap:16px;">
          ${screenshot ? `
            <div style="border-radius:28px;overflow:hidden;border:${frameStyle === 'editorial_outline_card' ? '2px solid rgba(31,41,55,0.16)' : '1px solid rgba(15,23,42,0.05)'};background:${frameAppearance.panelBackground};box-shadow:${frameAppearance.panelShadow};${screenshotFrameTransform}">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(15,23,42,0.06);background:${theme.panelSoft};">
                <div style="font-size:${contentScale.panelEyebrow}px;font-weight:900;letter-spacing:0.08em;color:${theme.accent};">${styleVariant === 'annotated_highlight_grid' ? '重点标注' : '亮点截图'}</div>
                <div style="font-size:${contentScale.panelHint}px;font-weight:650;color:${theme.muted};">${styleVariant === 'annotated_highlight_grid' ? '结合说明看重点区域' : '聚焦核心卖点'}</div>
              </div>
              <div style="padding:16px;">
                <div style="position:relative;aspect-ratio:16 / 10;border-radius:22px;overflow:hidden;background:#E5E7EB;">
                  ${buildImageMarkup(screenshot)}
                  ${styleVariant === 'annotated_highlight_grid' ? (payload.features || []).slice(0, 2).map((item, index) => `
                    <div style="position:absolute;${index === 0 ? 'left:22px;top:20px;' : 'right:22px;bottom:20px;'}display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;background:rgba(255,255,255,0.92);box-shadow:0 10px 24px rgba(15,23,42,0.12);font-size:${contentScale.panelHint}px;font-weight:800;color:${theme.text};">
                      <span style="display:inline-flex;width:22px;height:22px;border-radius:999px;align-items:center;justify-content:center;background:${theme.accent};color:#fff;font-size:12px;font-weight:900;">${index + 1}</span>
                      ${escapeHtml(truncateTemplateText(item.title, TEMPLATE_CONTENT_LIMITS.annotation))}
                    </div>
                  `).join('') : ''}
                </div>
              </div>
            </div>
          ` : ''}
          ${benefitProfile.layout === 'stack'
            ? `<div style="display:flex;justify-content:center;"><div style="width:72%;">${featureCards}</div></div>`
            : `
              <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;">
                ${(payload.features || []).slice(0, benefitProfile.maxItems).map((item) => `
                  <div style="border-radius:24px;background:${theme.panelSoft};padding:22px 18px;">
                    <div style="font-size:${contentScale.featureTitle}px;font-weight:850;color:${theme.text};line-height:1.24;">${escapeHtml(truncateTemplateText(item.title, TEMPLATE_CONTENT_LIMITS.featureTitle))}</div>
                    <div style="margin-top:12px;font-size:${contentScale.featureDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description, TEMPLATE_CONTENT_LIMITS.featureDescription))}</div>
                  </div>
                `).join('')}
              </div>
            `}
          ${bodyTextMarkup ? `<div style="margin-top:18px;min-height:${Math.round(payload.canvas.height * benefitProfile.bodyTextRatio)}px;">${bodyTextMarkup}</div>` : ''}
        </div>
      `;
      break;
    case 'step_guide':
      body = styleVariant === 'step_focus_screenshot'
        ? `
          <div style="display:flex;flex-direction:column;gap:16px;">
            ${screenshot ? `
              <div style="border-radius:28px;overflow:hidden;background:${theme.panelSoft};padding:14px;box-shadow:0 20px 45px rgba(15,23,42,0.08);${screenshotFrameTransform}">
                <div style="border-radius:22px;overflow:hidden;background:#E5E7EB;aspect-ratio:16 / 10;">
                  ${buildImageMarkup(screenshot)}
                </div>
              </div>
            ` : ''}
            <div style="border-radius:28px;background:${theme.panel};padding:${compact ? '22px' : '26px'};box-shadow:0 20px 45px rgba(15,23,42,0.08);display:flex;flex-direction:column;gap:12px;">
              ${(payload.steps || []).slice(0, Math.min(3, stepProfile.maxItems)).map((item, index) => `
                <div style="display:flex;gap:14px;align-items:flex-start;padding:${index > 0 ? '12px 0 0' : '0'};border-top:${index > 0 ? '1px solid rgba(15,23,42,0.08)' : 'none'};">
                  <div style="width:36px;height:36px;border-radius:999px;background:${theme.accentSoft};color:${theme.accent};display:flex;align-items:center;justify-content:center;font-size:${contentScale.stepIndex}px;font-weight:900;flex:0 0 auto;">${index + 1}</div>
                  <div style="font-size:${contentScale.stepDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description || item.title, TEMPLATE_CONTENT_LIMITS.stepDescription))}</div>
                </div>
              `).join('')}
            </div>
            ${bodyTextMarkup ? `<div style="margin-top:18px;min-height:${Math.round(payload.canvas.height * stepProfile.bodyTextRatio)}px;">${bodyTextMarkup}</div>` : ''}
          </div>
        `
        : `
          <div style="display:flex;flex-direction:column;gap:16px;">
            ${screenshot ? `
              <div style="border-radius:28px;overflow:hidden;background:${theme.panelSoft};padding:14px;box-shadow:0 20px 45px rgba(15,23,42,0.08);${screenshotFrameTransform}">
                <div style="border-radius:22px;overflow:hidden;background:#E5E7EB;aspect-ratio:16 / 10;">
                  ${buildImageMarkup(screenshot)}
                </div>
              </div>
            ` : ''}
            <div style="border-radius:28px;background:${theme.panel};padding:${compact ? '24px' : '30px'};box-shadow:0 20px 45px rgba(15,23,42,0.08);">${stepItems}</div>
            ${bodyTextMarkup ? `<div style="margin-top:18px;min-height:${Math.round(payload.canvas.height * stepProfile.bodyTextRatio)}px;">${bodyTextMarkup}</div>` : ''}
          </div>
        `;
      break;
    case 'before_after':
      body = `
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;${screenshotFrameTransform}">
          <div style="border-radius:28px;background:${theme.panel};padding:16px;box-shadow:0 20px 45px rgba(15,23,42,0.08);">
            <div style="font-size:${contentScale.comparisonLabel}px;font-weight:850;color:${theme.text};margin-bottom:10px;">之前</div>
            <div style="border-radius:20px;overflow:hidden;background:#E5E7EB;height:320px;">
              ${buildImageMarkup(screenshot)}
            </div>
          </div>
          <div style="border-radius:28px;background:${theme.panel};padding:16px;box-shadow:0 20px 45px rgba(15,23,42,0.08);">
            <div style="font-size:${contentScale.comparisonLabel}px;font-weight:850;color:${theme.text};margin-bottom:10px;">之后</div>
            <div style="border-radius:20px;overflow:hidden;background:#E5E7EB;height:320px;">
              ${buildImageMarkup(secondScreenshot)}
            </div>
          </div>
        </div>
      `;
      break;
    case 'faq_card':
      body = faqProfile.layout === 'stack'
        ? `<div style="display:flex;flex-direction:column;gap:16px;${faqProfile.count === 1 ? 'align-items:center;' : ''}">
          ${(payload.faqItems || [])
            .slice(0, faqProfile.maxItems)
            .map((item, index) => `
              <div style="width:${faqProfile.count === 1 ? '72%' : '100%'};border-radius:24px;background:${theme.panelSoft};padding:24px 22px;">
                <div style="display:inline-flex;border-radius:999px;padding:6px 12px;background:${theme.accentSoft};color:${theme.accent};font-size:${contentScale.faqBadge}px;font-weight:800;">Q${index + 1}</div>
                <div style="margin-top:12px;font-size:${contentScale.faqTitle}px;font-weight:850;color:${theme.text};line-height:1.24;">${escapeHtml(truncateTemplateText(item.title, TEMPLATE_CONTENT_LIMITS.faqTitle))}</div>
                <div style="margin-top:12px;font-size:${contentScale.faqDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description, TEMPLATE_CONTENT_LIMITS.faqDescription))}</div>
              </div>
            `).join('')}
        </div>
        ${bodyTextMarkup ? `<div style="margin-top:18px;min-height:${Math.round(payload.canvas.height * faqProfile.bodyTextRatio)}px;">${bodyTextMarkup}</div>` : ''}`
        : `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;">
          ${(payload.faqItems || [])
            .slice(0, faqProfile.maxItems)
            .map((item, index) => `
              <div style="border-radius:24px;background:${theme.panelSoft};padding:24px 22px;">
                <div style="display:inline-flex;border-radius:999px;padding:6px 12px;background:${theme.accentSoft};color:${theme.accent};font-size:${contentScale.faqBadge}px;font-weight:800;">Q${index + 1}</div>
                <div style="margin-top:12px;font-size:${contentScale.faqTitle}px;font-weight:850;color:${theme.text};line-height:1.24;">${escapeHtml(truncateTemplateText(item.title, TEMPLATE_CONTENT_LIMITS.faqTitle))}</div>
                <div style="margin-top:12px;font-size:${contentScale.faqDescription}px;line-height:1.62;color:${theme.muted};">${escapeHtml(truncateTemplateText(item.description, TEMPLATE_CONTENT_LIMITS.faqDescription))}</div>
              </div>
            `).join('')}
        </div>
        ${bodyTextMarkup ? `<div style="margin-top:18px;min-height:${Math.round(payload.canvas.height * faqProfile.bodyTextRatio)}px;">${bodyTextMarkup}</div>` : ''}`;
      break;
    default:
      body = `
        <div style="display:grid;grid-template-columns:${screenshot ? '1.1fr 0.9fr' : '1fr'};gap:20px;align-items:stretch;">
          <div style="display:flex;flex-direction:column;gap:16px;${bulletGroupTransform}">${bulletItems}</div>
          ${screenshot ? `
          <div style="border-radius:32px;background:${theme.panel};padding:14px;box-shadow:0 20px 45px rgba(15,23,42,0.08);${screenshotFrameTransform}">
            <div style="border-radius:24px;overflow:hidden;background:#E5E7EB;height:100%;">
              ${buildImageMarkup(screenshot)}
            </div>
          </div>` : ''}
        </div>
      `;
  }

  const screenshotStrip = '';
  const defaultHeader = styleVariant === 'text_cover_bold'
    ? ''
    : usesSunsetShell
    ? `
      <div style="position:relative;">
        <div style="position:absolute;right:-34px;top:-26px;width:280px;height:126px;background:linear-gradient(135deg, rgba(234,88,12,0.18) 0%, rgba(251,146,60,0.36) 100%);transform:rotate(-9deg);border-radius:28px;"></div>
        <div style="position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
          <div style="display:inline-flex;align-items:center;gap:10px;border-radius:18px;padding:12px 18px;background:rgba(255,255,255,0.76);backdrop-filter:blur(8px);color:${theme.text};font-size:${standardHeaderScale.badge}px;font-weight:900;box-shadow:0 18px 34px rgba(249,115,22,0.18);">${escapeHtml(badgeText)}</div>
          <div style="padding-top:8px;font-size:${standardHeaderScale.minor}px;font-weight:800;letter-spacing:0.08em;color:${theme.text};opacity:0.68;">PROMO FRAME</div>
        </div>
      </div>
      <div style="margin-top:26px;position:relative;">
        <div style="position:absolute;left:-8px;top:10px;width:120px;height:14px;background:rgba(255,255,255,0.72);border-radius:999px;"></div>
        <div style="position:relative;font-size:${standardHeaderScale.title}px;font-weight:900;line-height:1.02;color:${theme.text};letter-spacing:-0.05em;white-space:pre-line;">${escapeHtml(displayHeaderTitle)}</div>
        <div style="margin-top:16px;max-width:78%;font-size:${standardHeaderScale.subtitle}px;line-height:1.55;color:${theme.text};opacity:0.72;font-weight:700;">${escapeHtml(displayHeaderSubtitle)}</div>
      </div>
    `
    : usesNotebookShell
    ? `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="display:inline-flex;align-items:center;gap:10px;border-radius:${frameTemplateProfile.badgeRadius};padding:${frameTemplateProfile.badgePadding};background:#FFF7ED;color:${theme.text};font-size:${standardHeaderScale.badge}px;font-weight:800;border:1px dashed rgba(120,113,108,0.26);">${escapeHtml(badgeText)}</div>
        <div style="display:flex;gap:8px;">
          <div style="width:44px;height:16px;border-radius:6px;background:rgba(250,204,21,0.45);transform:rotate(8deg);"></div>
          <div style="width:44px;height:16px;border-radius:6px;background:rgba(59,130,246,0.22);transform:rotate(-7deg);"></div>
        </div>
      </div>
        <div style="margin-top:${frameTemplateProfile.titleMarginTop}px;">
        <div style="max-width:${frameTemplateProfile.titleMaxWidth};font-size:${standardHeaderScale.title}px;font-weight:900;line-height:${frameTemplateProfile.titleLineHeight};color:${theme.text};letter-spacing:${frameTemplateProfile.titleTracking};white-space:pre-line;">${escapeHtml(displayHeaderTitle)}</div>
        <div style="margin-top:${frameTemplateProfile.subtitleMarginTop}px;max-width:${frameTemplateProfile.subtitleMaxWidth};font-size:${standardHeaderScale.subtitle}px;line-height:${frameTemplateProfile.subtitleLineHeight};color:${theme.muted};font-weight:600;">${escapeHtml(displayHeaderSubtitle)}</div>
        <div style="margin-top:18px;height:2px;background:repeating-linear-gradient(90deg, rgba(120,113,108,0.28) 0 12px, rgba(120,113,108,0) 12px 20px);"></div>
      </div>
    `
    : usesSplitShell
    ? `
        <div style="display:flex;align-items:flex-start;gap:18px;">
        <div style="width:18px;height:${compact ? '144px' : '164px'};border-radius:10px;background:linear-gradient(180deg, #2563EB 0%, #22C55E 100%);flex:0 0 auto;"></div>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div style="display:inline-flex;align-items:center;gap:10px;border-radius:${frameTemplateProfile.badgeRadius};padding:${frameTemplateProfile.badgePadding};background:#EFF6FF;color:#2563EB;font-size:${standardHeaderScale.badge}px;font-weight:800;">${escapeHtml(badgeText)}</div>
            <div style="font-size:${standardHeaderScale.minor}px;font-weight:800;color:${theme.muted};letter-spacing:0.08em;">SPLIT FRAME</div>
          </div>
          <div style="margin-top:${frameTemplateProfile.titleMarginTop}px;max-width:${frameTemplateProfile.titleMaxWidth};font-size:${standardHeaderScale.title}px;font-weight:900;line-height:${frameTemplateProfile.titleLineHeight};color:${theme.text};letter-spacing:${frameTemplateProfile.titleTracking};white-space:pre-line;">${escapeHtml(displayHeaderTitle)}</div>
          <div style="margin-top:${frameTemplateProfile.subtitleMarginTop}px;max-width:${frameTemplateProfile.subtitleMaxWidth};font-size:${standardHeaderScale.subtitle}px;line-height:${frameTemplateProfile.subtitleLineHeight};color:${theme.muted};font-weight:650;">${escapeHtml(displayHeaderSubtitle)}</div>
        </div>
      </div>
    `
    : usesSoftShell
    ? `
        <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:inline-flex;align-items:center;gap:10px;border-radius:${frameTemplateProfile.badgeRadius};padding:${frameTemplateProfile.badgePadding};background:#FFFFFF;color:${theme.accent};font-size:${standardHeaderScale.badge}px;font-weight:800;box-shadow:${frameTemplateProfile.badgeShadow || '0 12px 24px rgba(15,23,42,0.08)'};">${escapeHtml(badgeText)}</div>
        <div style="width:72px;height:22px;border-radius:6px;background:rgba(255,228,182,0.72);transform:rotate(8deg);"></div>
      </div>
      <div style="margin-top:${frameTemplateProfile.titleMarginTop}px;">
        <div style="max-width:${frameTemplateProfile.titleMaxWidth};font-size:${standardHeaderScale.title}px;font-weight:900;line-height:${frameTemplateProfile.titleLineHeight};color:${theme.text};letter-spacing:${frameTemplateProfile.titleTracking};white-space:pre-line;">${escapeHtml(displayHeaderTitle)}</div>
        <div style="margin-top:${frameTemplateProfile.subtitleMarginTop}px;max-width:${frameTemplateProfile.subtitleMaxWidth};font-size:${standardHeaderScale.subtitle}px;line-height:${frameTemplateProfile.subtitleLineHeight};color:${theme.muted};font-weight:600;">${escapeHtml(displayHeaderSubtitle)}</div>
      </div>
    `
    : `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:inline-flex;align-items:center;gap:10px;border-radius:${usesEditorialShell ? '0' : '999px'};padding:${usesEditorialShell ? '0' : '10px 18px'};background:${usesEditorialShell ? 'transparent' : theme.accentSoft};color:${usesEditorialShell ? theme.text : theme.accent};font-size:${standardHeaderScale.badge}px;font-weight:800;letter-spacing:${usesEditorialShell ? '0.08em' : 'normal'};">${escapeHtml(usesEditorialShell ? (styleSlots.brandText || badgeText) : badgeText)}</div>
        <div></div>
      </div>
      <div style="margin-top:${usesEditorialShell ? '22px' : '28px'};display:flex;align-items:flex-start;gap:${usesEditorialShell ? '22px' : '0'};">
        ${usesEditorialShell ? `<div style="width:18px;height:${compact ? '120px' : '140px'};background:${theme.text};opacity:0.72;flex:0 0 auto;"></div>` : ''}
        <div style="flex:1;">
          <div style="max-width:${frameTemplateProfile.titleMaxWidth};font-size:${standardHeaderScale.title}px;font-weight:900;line-height:${usesEditorialShell ? frameTemplateProfile.titleLineHeight : frameTemplateProfile.titleLineHeight};color:${theme.text};letter-spacing:${frameTemplateProfile.titleTracking};white-space:pre-line;">${escapeHtml(displayHeaderTitle)}</div>
          <div style="margin-top:${frameTemplateProfile.subtitleMarginTop + 2}px;max-width:${frameTemplateProfile.subtitleMaxWidth};font-size:${standardHeaderScale.subtitle}px;line-height:${frameTemplateProfile.subtitleLineHeight};color:${theme.muted};font-weight:600;">${escapeHtml(displayHeaderSubtitle)}</div>
          ${usesEditorialShell ? `<div style="margin-top:14px;width:86%;height:8px;background:${theme.text};opacity:0.78;"></div>` : ''}
        </div>
      </div>
    `;

  const panelBody = payload.templateKind === 'feature_hero' && styleVariant === 'text_cover_bold'
    ? `
      <div style="margin-top:26px;flex:1 1 auto;min-height:0;">
        ${body}
      </div>
    `
    : usesEditorialShell
    ? `
      <div style="margin-top:34px;flex:1 1 auto;display:flex;flex-direction:column;min-height:0;">
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:20px;font-weight:800;color:${theme.text};letter-spacing:0.08em;">
          <div>${escapeHtml(styleSlots.topRightText || 'EDITORIAL FRAME')}</div>
          ${payload.ctaText ? `<div style="display:inline-flex;align-items:center;justify-content:center;border:2px solid rgba(31,41,55,0.72);padding:14px 24px;border-radius:999px;font-size:24px;font-weight:800;color:${theme.text};white-space:nowrap;">${escapeHtml(payload.ctaText)}</div>` : ''}
        </div>
        <div style="margin-top:28px;flex:1 1 auto;min-height:0;">
          ${body}
        </div>
        <div style="margin-top:20px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;">
          <div style="max-width:68%;font-size:20px;line-height:1.65;color:${theme.muted};font-weight:600;">${escapeHtml(payload.footerNote || '')}</div>
          <div style="font-size:${compact ? '44px' : '56px'};font-weight:900;line-height:0.95;color:${theme.text};opacity:0.08;letter-spacing:0.04em;">${escapeHtml(styleSlots.bottomHeadline || displayHeaderTitle)}</div>
        </div>
      </div>
    `
    : payload.templateKind === 'feature_hero'
    ? `
          <div style="margin-top:34px;flex:1 1 auto;border-radius:${frameAppearance.shellBorderRadius};background:${frameAppearance.panelBackground};border:${frameAppearance.panelBorder};padding:${compact ? '28px' : '36px'};box-shadow:${usesSunsetShell ? '0 30px 80px rgba(249,115,22,0.16), inset 0 1px 0 rgba(255,255,255,0.52)' : frameAppearance.panelShadow};display:flex;flex-direction:column;min-height:0;position:relative;overflow:hidden;transform:${usesSunsetShell ? 'rotate(-1.2deg)' : 'none'};">
        ${usesSunsetShell ? `<div style="position:absolute;top:-60px;right:-40px;width:220px;height:220px;border-radius:999px;background:radial-gradient(circle, rgba(251,146,60,0.26) 0%, rgba(251,146,60,0) 72%);"></div><div style="position:absolute;left:-40px;top:110px;width:180px;height:180px;border-radius:999px;background:radial-gradient(circle, rgba(244,114,182,0.18) 0%, rgba(244,114,182,0) 72%);"></div>` : ''}
        ${usesSoftShell ? `<div style="position:absolute;right:42px;top:16px;width:84px;height:24px;border-radius:7px;background:rgba(255,228,182,0.72);transform:rotate(9deg);"></div>` : ''}
        ${usesNotebookShell ? `<div style="position:absolute;left:26px;top:20px;width:calc(100% - 52px);height:calc(100% - 40px);border-radius:24px;border:1px dashed rgba(120,113,108,0.14);pointer-events:none;"></div><div style="position:absolute;right:30px;bottom:22px;width:70px;height:18px;border-radius:6px;background:rgba(250,204,21,0.28);transform:rotate(-8deg);"></div>` : ''}
        ${usesSplitShell ? `<div style="position:absolute;left:0;top:0;width:18px;height:100%;background:linear-gradient(180deg,#2563EB 0%, #22C55E 100%);"></div><div style="position:absolute;right:26px;top:22px;width:86px;height:10px;border-radius:999px;background:rgba(37,99,235,0.18);"></div>` : ''}
        <div style="flex:1 1 auto;min-height:0;display:flex;flex-direction:column;">
          ${body}${screenshotStrip}
        </div>
          <div style="margin-top:18px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div style="max-width:70%;font-size:${frameTemplateProfile.footerFontSize}px;line-height:1.6;color:${theme.muted};font-weight:600;">${escapeHtml(payload.footerNote || '')}</div>
          <div style="display:inline-flex;align-items:center;justify-content:center;border-radius:${frameTemplateProfile.ctaRadius};padding:${frameTemplateProfile.ctaPadding};background:${theme.accent};color:#FFFFFF;font-size:${frameTemplateProfile.ctaFontSize}px;font-weight:800;box-shadow:0 14px 30px rgba(15,23,42,0.15);white-space:nowrap;">${escapeHtml(payload.ctaText)}</div>
        </div>
      </div>
    `
    : `
      <div style="margin-top:34px;flex:1 1 auto;border-radius:${usesEditorialShell ? '0' : frameAppearance.shellBorderRadius};background:${usesEditorialShell ? 'transparent' : frameAppearance.panelBackground};border:${usesEditorialShell ? 'none' : frameAppearance.panelBorder};padding:${usesEditorialShell ? '0' : (compact ? '28px' : '36px')};box-shadow:${usesEditorialShell ? 'none' : frameAppearance.panelShadow};display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden;">
        ${usesSunsetShell ? `<div style="position:absolute;left:-40px;bottom:-50px;width:220px;height:220px;border-radius:999px;background:radial-gradient(circle, rgba(249,115,22,0.18) 0%, rgba(249,115,22,0) 72%);"></div><div style="position:absolute;right:26px;top:22px;width:120px;height:12px;border-radius:999px;background:rgba(255,255,255,0.54);"></div>` : ''}
        ${usesSoftShell ? `<div style="position:absolute;right:40px;top:16px;width:84px;height:24px;border-radius:7px;background:rgba(255,228,182,0.72);transform:rotate(9deg);"></div>` : ''}
        ${usesNotebookShell ? `<div style="position:absolute;left:28px;top:20px;width:calc(100% - 56px);height:calc(100% - 40px);border-radius:24px;border:1px dashed rgba(120,113,108,0.14);pointer-events:none;"></div>` : ''}
        ${usesSplitShell ? `<div style="position:absolute;left:0;top:0;width:18px;height:100%;background:linear-gradient(180deg,#2563EB 0%, #22C55E 100%);"></div>` : ''}
        <div>${body}${screenshotStrip}</div>
        <div style="margin-top:22px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
          <div style="max-width:70%;font-size:${frameTemplateProfile.footerFontSize}px;line-height:1.6;color:${theme.muted};font-weight:600;">${escapeHtml(payload.footerNote || '')}</div>
          <div style="display:inline-flex;align-items:center;justify-content:center;border-radius:${frameTemplateProfile.ctaRadius};padding:${frameTemplateProfile.ctaPadding};background:${theme.accent};color:#FFFFFF;font-size:${frameTemplateProfile.ctaFontSize}px;font-weight:800;box-shadow:0 14px 30px rgba(15,23,42,0.15);white-space:nowrap;">${escapeHtml(payload.ctaText)}</div>
        </div>
      </div>
    `;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${payload.canvas.width}" height="${payload.canvas.height}" viewBox="0 0 ${payload.canvas.width} ${payload.canvas.height}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${payload.canvas.width}px;height:${payload.canvas.height}px;box-sizing:border-box;background:${styleVariant === 'text_cover_bold' ? textCoverAppearance.background : frameAppearance.canvasBackground};padding:${canvasPadding.y}px ${canvasPadding.x}px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif;display:flex;flex-direction:column;overflow:hidden;">
          ${defaultHeader}
          ${panelBody}
        </div>
      </foreignObject>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
};

export const editablePayloadToDocument = (
  payload: TemplateComposeEditablePayload,
  options?: {
    id?: string;
    brandStyle?: string;
    cardType?: string | null;
  }
): TemplateComposeDocument => {
  const styleVariant = resolveTemplateStyleVariant(payload.templateKind, payload.styleVariant, options?.cardType);
  const frameStyle = resolveTemplateFrameStyle(payload.templateKind, payload.frameStyle);
  const styleSlots = resolveStyleSlots(styleVariant, payload.styleSlots);
  const screenshotVisible = styleVariant === 'text_cover_bold'
    ? false
    : payload.templateKind === 'feature_hero' && styleVariant === 'freeform_stage'
      ? true
      : (payload.screenshots || []).length > 0;
  const contentVisible = !(payload.templateKind === 'feature_hero' && styleVariant === 'text_cover_bold');
  const modules: TemplateComposeModule[] = [
    {
      id: 'badge',
      type: 'badge_block',
      visible: true,
      order: 1,
      content: payload.badgeText || DEFAULT_BADGE_TEXT,
    },
    {
      id: 'title',
      type: 'title_block',
      visible: true,
      order: 3,
      content: payload.title,
    },
    {
      id: 'subtitle',
      type: 'subtitle_block',
      visible: true,
      order: 4,
      content: payload.subtitle,
    },
    {
      id: 'screenshots',
      type: 'screenshot_frame',
      visible: screenshotVisible,
      order: 5,
      content: (payload.screenshots || []).map((shot) => ({
        ...shot,
        crop: normalizeCrop(shot, payload.templateKind),
      })),
      layout: {
        ...normalizeModuleLayout(undefined, payload.templateKind, 'screenshot_frame', {
          referenceScreenshot: payload.screenshots?.[0],
          styleVariant,
        }),
        fitMode: getDefaultScreenshotFitMode(payload.templateKind),
      },
    },
    {
      id: 'primary-content',
      type:
        payload.templateKind === 'step_guide'
          ? 'step_group'
          : payload.templateKind === 'benefit_grid'
            ? 'feature_grid'
            : payload.templateKind === 'before_after'
              ? 'comparison_group'
              : payload.templateKind === 'faq_card'
                ? 'feature_grid'
                : 'bullet_group',
      visible: contentVisible,
      order: 6,
      layout: payload.templateKind === 'feature_hero'
        ? normalizeModuleLayout(undefined, payload.templateKind, 'bullet_group', { styleVariant })
        : undefined,
      content:
        payload.templateKind === 'step_guide'
          ? payload.steps
          : payload.templateKind === 'benefit_grid'
            ? payload.features
            : payload.templateKind === 'before_after'
              ? payload.screenshots
              : payload.templateKind === 'faq_card'
                ? payload.faqItems
                : payload.bullets,
    },
    {
      id: 'body-text',
      type: 'body_text_block',
      visible: Boolean(payload.bodyText) && ['benefit_grid', 'step_guide', 'faq_card'].includes(String(payload.templateKind)),
      order: 7,
      content: payload.bodyText || '',
    },
    {
      id: 'cta',
      type: 'cta_badge',
      visible: Boolean(payload.ctaText),
      order: 8,
      content: payload.ctaText,
    },
    {
      id: 'footer',
      type: 'footer_note',
      visible: Boolean(payload.footerNote),
      order: 9,
      content: payload.footerNote || '',
    },
  ];

  return {
    id: options?.id || `template-doc-${Date.now()}`,
    canvas: payload.canvas,
    templateKind: payload.templateKind,
    styleVariant,
    frameStyle,
    theme: payload.themeKey,
    density: payload.density,
    modules,
    assets: (payload.screenshots || []).map((shot) => ({
      ...shot,
      crop: normalizeCrop(shot, payload.templateKind),
    })),
    noteVisualPlan: payload.noteVisualPlan,
    renderVersion: 1,
    meta: {
      title: payload.title,
      subtitle: payload.subtitle,
      ctaText: payload.ctaText,
      footerNote: payload.footerNote,
      bodyText: payload.bodyText || '',
      brandStyle: options?.brandStyle || payload.brandStyle,
      styleSlots,
    },
  };
};

export const normalizeTemplateComposeDocument = (document: TemplateComposeDocument): TemplateComposeDocument => {
  const badgeContent = String(document.modules.find((module) => module.type === 'badge_block')?.content || DEFAULT_BADGE_TEXT);
  const styleVariant = resolveTemplateStyleVariant(document.templateKind, document.styleVariant);
  const frameStyle = resolveTemplateFrameStyle(document.templateKind, document.frameStyle);

  const hasBadgeModule = document.modules.some((module) => module.type === 'badge_block');
  const normalizedAssets = (document.assets || []).map((asset) => ({
    ...asset,
    crop: normalizeCrop(asset, document.templateKind),
  }));

  const normalizedModules = document.modules.map((module) => {
    if (module.type === 'screenshot_frame') {
      return {
        ...module,
        layout: normalizeModuleLayout(module.layout, document.templateKind, module.type, {
          referenceScreenshot: ((module.content as TemplateScreenshot[]) || normalizedAssets)?.[0] || normalizedAssets[0],
          styleVariant,
        }),
        content: ((module.content as TemplateScreenshot[]) || normalizedAssets).map((shot) => ({
          ...shot,
          crop: normalizeCrop(shot, document.templateKind),
          })),
        };
    }
    if (module.type === 'bullet_group') {
      return {
        ...module,
        layout: normalizeModuleLayout(module.layout, document.templateKind, module.type, { styleVariant }),
      };
    }
    return module;
  });

  const modulesWithMeta = [
    ...(hasBadgeModule
      ? normalizedModules.map((module) =>
          module.type === 'badge_block' ? { ...module, content: badgeContent, order: 1 } : module
        )
      : [{
          id: 'badge',
          type: 'badge_block' as const,
          visible: true,
          order: 1,
          content: badgeContent,
        }, ...normalizedModules]),
  ];

  const finalModules = modulesWithMeta.filter((module) => module.type !== 'canvas_meta');

  const reOrderedModules = finalModules
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((module, index) => ({
      ...module,
      order:
        module.type === 'badge_block'
          ? 1
          : Math.max(index + 1, 2),
    }));

  return {
    ...document,
    styleVariant,
    frameStyle,
    modules: reOrderedModules,
    assets: normalizedAssets,
  };
};

export const documentToEditablePayload = (document: TemplateComposeDocument): TemplateComposeEditablePayload => {
  const titleModule = document.modules.find((module) => module.type === 'title_block');
  const subtitleModule = document.modules.find((module) => module.type === 'subtitle_block');
  const badgeModule = document.modules.find((module) => module.type === 'badge_block');
  const contentModule = document.modules.find((module) =>
    ['bullet_group', 'feature_grid', 'step_group', 'comparison_group'].includes(module.type)
  );
  const screenshotModule = document.modules.find((module) => module.type === 'screenshot_frame');
  const ctaModule = document.modules.find((module) => module.type === 'cta_badge');
  const footerModule = document.modules.find((module) => module.type === 'footer_note');
  const bodyTextModule = document.modules.find((module) => module.type === 'body_text_block');

  const screenshots = (((screenshotModule?.content as TemplateScreenshot[]) || document.assets || [])).map((shot) => ({
    ...shot,
    crop: normalizeCrop(shot, document.templateKind),
  }));

  return {
    version: document.renderVersion || 1,
    canvas: document.canvas,
    templateKind: document.templateKind,
    styleVariant: resolveTemplateStyleVariant(document.templateKind, document.styleVariant),
    frameStyle: resolveTemplateFrameStyle(document.templateKind, document.frameStyle),
    brandStyle: document.meta?.brandStyle,
    themeKey: document.theme,
    density: document.density,
    badgeText: String(badgeModule?.content || DEFAULT_BADGE_TEXT),
    title: String(titleModule?.content || document.meta?.title || ''),
    subtitle: String(subtitleModule?.content || document.meta?.subtitle || ''),
    ctaText: String(ctaModule?.content || document.meta?.ctaText || ''),
    footerNote: String(footerModule?.content || document.meta?.footerNote || ''),
    bodyText: String(bodyTextModule?.content || document.meta?.bodyText || ''),
    bullets: document.templateKind === 'feature_hero' ? ((contentModule?.content as string[]) || []) : [],
    features: document.templateKind === 'benefit_grid' || document.templateKind === 'faq_card'
      ? ((contentModule?.content as Array<{ title: string; description: string }>) || [])
      : [],
    steps: document.templateKind === 'step_guide'
      ? ((contentModule?.content as Array<{ title: string; description: string }>) || [])
      : [],
    faqItems: document.templateKind === 'faq_card'
      ? ((contentModule?.content as Array<{ title: string; description: string }>) || [])
      : [],
    screenshots,
    noteVisualPlan: document.noteVisualPlan,
    styleSlots: resolveStyleSlots(document.styleVariant, document.meta?.styleSlots),
  };
};

export const renderTemplateDocumentDataUrl = (document: TemplateComposeDocument): string => {
  const payload = documentToEditablePayload(document);
  const moduleLayouts = Object.fromEntries(
    document.modules.map((module) => [
      module.type,
      normalizeModuleLayout(module.layout, document.templateKind, module.type, {
        styleVariant: document.styleVariant,
        referenceScreenshot: module.type === 'screenshot_frame'
          ? (((module.content as TemplateScreenshot[]) || document.assets || [])[0])
          : undefined,
      }),
    ])
  ) as Partial<Record<TemplateComposeModule['type'], TemplateComposeModule['layout']>>;
  return renderTemplateAssetDataUrl(payload, { moduleLayouts });
};

export const patchDocumentModule = (
  document: TemplateComposeDocument,
  moduleId: string,
  updates: Partial<TemplateComposeModule>
): TemplateComposeDocument => ({
  ...document,
  renderVersion: (document.renderVersion || 1) + 1,
  modules: document.modules.map((module) =>
    module.id === moduleId
      ? {
          ...module,
          ...updates,
        }
      : module
  ),
});

export const patchDocumentAssets = (
  document: TemplateComposeDocument,
  assets: TemplateScreenshot[]
): TemplateComposeDocument => {
  const styleVariant = resolveTemplateStyleVariant(document.templateKind, document.styleVariant);
  const nextDocument = {
    ...document,
    renderVersion: (document.renderVersion || 1) + 1,
    assets: assets.map((asset) => ({
      ...asset,
      crop: normalizeCrop(asset, document.templateKind),
    })),
  };
  return patchDocumentModule(nextDocument, 'screenshots', {
    content: nextDocument.assets,
    visible: styleVariant === 'text_cover_bold'
      ? false
      : document.templateKind === 'feature_hero' && styleVariant === 'freeform_stage'
        ? true
        : nextDocument.assets.length > 0,
  });
};

export const patchDocumentModuleLayout = (
  document: TemplateComposeDocument,
  moduleId: string,
  layoutUpdates: Partial<TemplateModuleLayout>
): TemplateComposeDocument => {
  const targetModule = document.modules.find((module) => module.id === moduleId);
  if (!targetModule) {
    return document;
  }
  const nextLayout = normalizeModuleLayout({
    ...normalizeModuleLayout(targetModule.layout, document.templateKind, targetModule.type, {
      styleVariant: document.styleVariant,
      referenceScreenshot: targetModule.type === 'screenshot_frame' ? document.assets[0] : undefined,
    }),
    ...layoutUpdates,
  }, document.templateKind, targetModule.type, {
    styleVariant: document.styleVariant,
    referenceScreenshot: targetModule.type === 'screenshot_frame' ? document.assets[0] : undefined,
  });

  return patchDocumentModule(document, moduleId, {
    layout: nextLayout,
  });
};

export const withDocumentFromComposeResult = (result: TemplateComposeResult, brandStyle?: string): TemplateComposeResult => {
  if (result.document) {
    return result;
  }
  return {
    ...result,
    document: editablePayloadToDocument(result.editable_payload, { brandStyle }),
  };
};

export const applyDocumentStyleVariant = (
  document: TemplateComposeDocument,
  styleVariant: TemplateStyleVariant | string | undefined,
  options?: {
    cardType?: string | null;
  }
): TemplateComposeDocument => {
  const payload = documentToEditablePayload(document);
  return editablePayloadToDocument({
    ...payload,
    styleVariant,
    frameStyle: document.frameStyle,
    styleSlots: document.meta?.styleSlots,
  }, {
    id: document.id,
    brandStyle: document.meta?.brandStyle,
    cardType: options?.cardType,
  });
};
