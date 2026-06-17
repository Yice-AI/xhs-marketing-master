import { TEXT_COVER_PROFILE } from './templateFixedProfiles';

const PUNCTUATION_MARKS = ['，', '。', '！', '？', '：', '；', ',', '.', '!', '?', ':', ';', '、'];
const ELLIPSIS = '…';

export const TEMPLATE_CONTENT_LIMITS = {
  title: 28,
  subtitle: 36,
  coverSticker: 6,
  coverBottomHeadline: 10,
  bodyTextBenefit: 90,
  bodyTextStep: 80,
  bodyTextFaq: 80,
  footer: 24,
  bullet: 20,
  featureTitle: 14,
  featureDescription: 24,
  stepTitle: 14,
  stepDescription: 24,
  faqTitle: 14,
  faqDescription: 24,
  annotation: 10,
} as const;

export type TemplateContentScale = {
  bullet: number;
  bulletPlaceholder: number;
  panelEyebrow: number;
  panelHint: number;
  featureTitle: number;
  featureDescription: number;
  faqBadge: number;
  faqTitle: number;
  faqDescription: number;
  stepIndex: number;
  stepTitle: number;
  stepDescription: number;
  comparisonLabel: number;
  cta: number;
};

export type StructuredContentDisplayProfile = {
  count: number;
  maxItems: number;
  tier: 'sparse' | 'balanced' | 'dense';
  layout: 'stack' | 'grid' | 'steps';
  bodyTextRatio: number;
};

export type TemplateModuleInputRules = {
  maxItems?: number;
  singleLineLimit?: number;
  titleLimit?: number;
  descriptionLimit?: number;
  bodyTextLimit?: number;
};

const normalizeText = (value: string) => String(value || '').replace(/\r/g, '').trim();
export const countCompactChars = (value: string) => normalizeText(value).replace(/\s+/g, '').length;

export const clampCompactChars = (value: string, maxChars: number) => {
  const source = String(value || '').replace(/\r/g, '');
  if (!source || maxChars <= 0) {
    return '';
  }

  let compactCount = 0;
  let output = '';
  for (const char of source) {
    const isCompact = /\s/.test(char) ? 0 : 1;
    if (compactCount + isCompact > maxChars) {
      break;
    }
    compactCount += isCompact;
    output += char;
  }
  return output;
};

const truncateText = (value: string, maxLength: number) => {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  return `${truncated}${ELLIPSIS}`;
};

const wrapLineByWidth = (sourceLine: string, lineWidth: number) => {
  const wrappedLines: string[] = [];
  let cursor = 0;

  while (cursor < sourceLine.length) {
    const remaining = sourceLine.slice(cursor);
    if (remaining.length <= lineWidth) {
      wrappedLines.push(remaining.trim());
      break;
    }

    const slice = remaining.slice(0, lineWidth);
    const punctuationIndex = Math.max(
      ...PUNCTUATION_MARKS.map((mark) => slice.lastIndexOf(mark))
    );
    const cut = punctuationIndex >= Math.max(2, lineWidth - 4) ? punctuationIndex + 1 : lineWidth;
    wrappedLines.push(remaining.slice(0, cut).trim());
    cursor += cut;
  }

  return wrappedLines.filter(Boolean);
};

const clampWrappedLines = (lines: string[], maxLines: number, lastLineWidth: number) => {
  if (lines.length <= maxLines) {
    return lines;
  }

  const nextLines = lines.slice(0, maxLines);
  const mergedOverflow = [nextLines[maxLines - 1], ...lines.slice(maxLines)].join('');
  nextLines[maxLines - 1] = truncateText(mergedOverflow, Math.max(2, lastLineWidth));
  return nextLines;
};

const wrapTextBlock = (
  value: string,
  options: {
    preferredWidths: number[];
    maxLines: number;
    maxLength: number;
  }
) => {
  const normalized = truncateText(value, options.maxLength);
  if (!normalized) {
    return '';
  }

  const sourceLines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  const widths = options.preferredWidths.filter(Boolean);
  const fallbackWidth = widths[widths.length - 1];

  for (const width of widths) {
    const wrapped = sourceLines.flatMap((line) => wrapLineByWidth(line, width));
    if (wrapped.length <= options.maxLines) {
      return wrapped.join('\n');
    }
  }

  const wrapped = sourceLines.flatMap((line) => wrapLineByWidth(line, fallbackWidth));
  return clampWrappedLines(wrapped, options.maxLines, fallbackWidth).join('\n');
};

export const getDisplayLineCount = (value: string) => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }
  return normalized.split('\n').filter(Boolean).length;
};

export const truncateTemplateText = truncateText;

export const getTextCoverDisplayContent = (
  title: string,
  subtitle: string,
  footerText: string
) => ({
  title: wrapTextBlock(title, {
    preferredWidths: [8, 7, 6, 5],
    maxLines: 4,
    maxLength: TEMPLATE_CONTENT_LIMITS.title + 8,
  }),
  subtitle: wrapTextBlock(subtitle, {
    preferredWidths: [10, 9, 8, 7],
    maxLines: 4,
    maxLength: TEMPLATE_CONTENT_LIMITS.subtitle,
  }),
  bottomHeadline: wrapTextBlock(footerText, {
    preferredWidths: [6, 5, 4],
    maxLines: 3,
    maxLength: TEMPLATE_CONTENT_LIMITS.coverBottomHeadline,
  }),
});

export const shouldShowTextCoverSticker = (
  title: string,
  subtitle: string,
  stickerText?: string
) => {
  if (!normalizeText(stickerText || '')) {
    return false;
  }

  const titleLines = getDisplayLineCount(title);
  const subtitleLines = getDisplayLineCount(subtitle);
  const titleLength = normalizeText(title).replace(/\n/g, '').length;
  const subtitleLength = normalizeText(subtitle).replace(/\n/g, '').length;

  return titleLines <= 4 && subtitleLines <= 2 && (titleLength + subtitleLength) <= 34;
};

export const getTextCoverSpacingProfile = (
  title: string,
  subtitle: string,
  footerText: string
) => {
  const titleLines = getDisplayLineCount(title);
  const subtitleLines = getDisplayLineCount(subtitle);
  const footerLines = getDisplayLineCount(footerText);

  if (titleLines >= 4 || subtitleLines >= 4) {
    return {
      titleMarginTop: 16,
      dividerGap: 4,
      subtitleMarginTop: 12,
      centerBlockMarginTop: 0,
      footerTopMargin: 10,
      bottomPaddingTop: 8,
      stickerPadding: '12px 22px',
    };
  }

  if (titleLines >= 3 || subtitleLines >= 3 || footerLines >= 2) {
    return {
      titleMarginTop: 18,
      dividerGap: 5,
      subtitleMarginTop: 14,
      centerBlockMarginTop: 0,
      footerTopMargin: 12,
      bottomPaddingTop: 10,
      stickerPadding: '14px 24px',
    };
  }

  return {
    titleMarginTop: TEXT_COVER_PROFILE.titleMarginTop,
    dividerGap: TEXT_COVER_PROFILE.dividerGap,
    subtitleMarginTop: TEXT_COVER_PROFILE.subtitleMarginTop,
    centerBlockMarginTop: TEXT_COVER_PROFILE.centerBlockMarginTop,
    footerTopMargin: TEXT_COVER_PROFILE.footerTopMargin,
    bottomPaddingTop: TEXT_COVER_PROFILE.bottomPaddingTop,
    stickerPadding: TEXT_COVER_PROFILE.stickerPadding,
  };
};

export const getTextCoverScaleProfile = (
  title: string,
  subtitle: string,
  footerText: string
) => {
  const titleLines = getDisplayLineCount(title);
  const subtitleLines = getDisplayLineCount(subtitle);
  const footerLines = getDisplayLineCount(footerText);
  const titleLength = normalizeText(title).replace(/\n/g, '').length;
  const subtitleLength = normalizeText(subtitle).replace(/\n/g, '').length;
  const densityScore = titleLines * 2.1 + subtitleLines * 1.3 + footerLines * 0.7 + titleLength * 0.24 + subtitleLength * 0.1;

  if (titleLines >= 4 || subtitleLines >= 4 || densityScore >= 24) {
    return {
      topMeta: 20,
      title: 106,
      titleTracking: '-0.055em',
      titleLineHeight: 0.92,
      divider: 6,
      subtitle: 64,
      subtitleTracking: '-0.02em',
      subtitleLineHeight: 1.02,
      sticker: 26,
      footer: 22,
      footerLineHeight: 1.38,
      cta: 24,
      ctaPadding: '14px 24px',
      intro: 0,
      bottomLabel: 0,
      bottomHeadline: 108,
    };
  }

  if (titleLines >= 3 || subtitleLines >= 3 || densityScore >= 18) {
    return {
      topMeta: 22,
      title: 116,
      titleTracking: '-0.07em',
      titleLineHeight: 0.88,
      divider: 6,
      subtitle: 82,
      subtitleTracking: '-0.03em',
      subtitleLineHeight: 0.96,
      sticker: 32,
      footer: 23,
      footerLineHeight: 1.34,
      cta: 24,
      ctaPadding: '16px 26px',
      intro: 0,
      bottomLabel: 0,
      bottomHeadline: 124,
    };
  }

  return {
    topMeta: 24,
    title: 132,
    titleTracking: '-0.08em',
    titleLineHeight: 0.84,
    divider: 7,
    subtitle: 96,
    subtitleTracking: '-0.04em',
    subtitleLineHeight: 0.94,
    sticker: 36,
    footer: 24,
    footerLineHeight: 1.3,
    cta: 26,
    ctaPadding: '18px 30px',
    intro: 0,
    bottomLabel: 0,
    bottomHeadline: 132,
  };
};

export const getStandardHeaderScale = (
  templateKind: string,
  styleVariant: string | null | undefined,
  title: string,
  subtitle: string,
  frameStyle?: string | null
) => {
  const score = (title || '').replace(/\s+/g, '').length * 1.06 + (subtitle || '').replace(/\s+/g, '').length * 0.46;
  const isFreeformStage = templateKind === 'feature_hero' && styleVariant === 'freeform_stage';
  const isStructuredContent = ['benefit_grid', 'step_guide', 'faq_card', 'before_after'].includes(templateKind);
  const isSplitFrame = frameStyle === 'split_banner_card';
  const isEditorialFrame = frameStyle === 'editorial_outline_card';
  const isSunsetFrame = frameStyle === 'sunset_glow_card';
  const isNotebookFrame = frameStyle === 'notebook_tape_card';
  const isSoftFrame = !frameStyle || frameStyle === 'soft_gradient_card';

  if (isSplitFrame) {
    if (score >= 34) {
      return { title: 76, subtitle: 28, badge: 18, minor: 13 };
    }
    if (score >= 22) {
      return { title: 84, subtitle: 30, badge: 19, minor: 14 };
    }
    return { title: 92, subtitle: 32, badge: 20, minor: 15 };
  }

  if (isEditorialFrame) {
    if (score >= 34) {
      return { title: 72, subtitle: 26, badge: 17, minor: 13 };
    }
    if (score >= 22) {
      return { title: 80, subtitle: 28, badge: 18, minor: 14 };
    }
    return { title: 88, subtitle: 30, badge: 19, minor: 14 };
  }

  if (isSunsetFrame) {
    if (score >= 34) {
      return { title: 70, subtitle: 26, badge: 17, minor: 13 };
    }
    if (score >= 22) {
      return { title: 78, subtitle: 28, badge: 18, minor: 13 };
    }
    return { title: 86, subtitle: 30, badge: 19, minor: 14 };
  }

  if (isNotebookFrame) {
    if (score >= 34) {
      return { title: 68, subtitle: 26, badge: 17, minor: 12 };
    }
    if (score >= 22) {
      return { title: 76, subtitle: 28, badge: 18, minor: 13 };
    }
    return { title: 84, subtitle: 30, badge: 19, minor: 13 };
  }

  if (isSoftFrame) {
    if (score >= 34) {
      return { title: 70, subtitle: 26, badge: 16, minor: 12 };
    }
    if (score >= 22) {
      return { title: 78, subtitle: 28, badge: 17, minor: 12 };
    }
    return { title: 86, subtitle: 30, badge: 18, minor: 13 };
  }

  if (isFreeformStage) {
    if (score >= 34) {
      return { title: 62, subtitle: 24, badge: 15, minor: 12 };
    }
    if (score >= 22) {
      return { title: 70, subtitle: 26, badge: 16, minor: 12 };
    }
    return { title: 78, subtitle: 28, badge: 17, minor: 13 };
  }

  if (isStructuredContent) {
    if (score >= 34) {
      return { title: 68, subtitle: 26, badge: 15, minor: 12 };
    }
    if (score >= 22) {
      return { title: 76, subtitle: 28, badge: 16, minor: 12 };
    }
    return { title: 84, subtitle: 30, badge: 17, minor: 13 };
  }

  if (score >= 34) {
    return { title: 70, subtitle: 26, badge: 15, minor: 12 };
  }
  if (score >= 22) {
    return { title: 78, subtitle: 28, badge: 16, minor: 12 };
  }
  return { title: 86, subtitle: 30, badge: 17, minor: 13 };
};

export const getTemplateContentScale = (
  templateKind: string,
  itemCount = 4,
  _styleVariant?: string | null
): TemplateContentScale => {
  const normalizedCount = templateKind === 'benefit_grid'
    ? Math.max(1, Math.min(8, itemCount || 1))
    : Math.max(1, Math.min(4, itemCount || 1));

  if (templateKind === 'benefit_grid') {
    if (normalizedCount === 1) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 18,
        panelHint: 17,
        featureTitle: 42,
        featureDescription: 28,
        faqBadge: 16,
        faqTitle: 34,
        faqDescription: 24,
        stepIndex: 21,
        stepTitle: 32,
        stepDescription: 24,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    if (normalizedCount === 2) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 18,
        panelHint: 17,
        featureTitle: 38,
        featureDescription: 26,
        faqBadge: 16,
        faqTitle: 34,
        faqDescription: 24,
        stepIndex: 21,
        stepTitle: 32,
        stepDescription: 24,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    if (normalizedCount === 3) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 17,
        panelHint: 16,
        featureTitle: 36,
        featureDescription: 24,
        faqBadge: 16,
        faqTitle: 34,
        faqDescription: 24,
        stepIndex: 21,
        stepTitle: 32,
        stepDescription: 24,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    return {
      bullet: 30,
      bulletPlaceholder: 19,
      panelEyebrow: 16,
      panelHint: 15,
      featureTitle: normalizedCount <= 6 ? 28 : 24,
      featureDescription: normalizedCount <= 6 ? 20 : 18,
      faqBadge: 16,
      faqTitle: 34,
      faqDescription: 24,
      stepIndex: 21,
      stepTitle: 32,
      stepDescription: 24,
      comparisonLabel: 26,
      cta: 28,
    };
  }

  if (templateKind === 'faq_card') {
    if (normalizedCount <= 2) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 18,
        panelHint: 17,
        featureTitle: 36,
        featureDescription: 24,
        faqBadge: 16,
        faqTitle: 38,
        faqDescription: 26,
        stepIndex: 21,
        stepTitle: 32,
        stepDescription: 24,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    if (normalizedCount === 3) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 18,
        panelHint: 17,
        featureTitle: 36,
        featureDescription: 24,
        faqBadge: 16,
        faqTitle: 34,
        faqDescription: 24,
        stepIndex: 21,
        stepTitle: 32,
        stepDescription: 24,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    return {
      bullet: 30,
      bulletPlaceholder: 19,
      panelEyebrow: 18,
      panelHint: 17,
      featureTitle: 36,
      featureDescription: 24,
      faqBadge: 16,
      faqTitle: 30,
      faqDescription: 22,
      stepIndex: 21,
      stepTitle: 32,
      stepDescription: 24,
      comparisonLabel: 26,
      cta: 28,
    };
  }

  if (templateKind === 'step_guide') {
    if (normalizedCount <= 2) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 18,
        panelHint: 17,
        featureTitle: 36,
        featureDescription: 24,
        faqBadge: 16,
        faqTitle: 34,
        faqDescription: 24,
        stepIndex: 22,
        stepTitle: 34,
        stepDescription: 26,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    if (normalizedCount === 3) {
      return {
        bullet: 30,
        bulletPlaceholder: 19,
        panelEyebrow: 18,
        panelHint: 17,
        featureTitle: 36,
        featureDescription: 24,
        faqBadge: 16,
        faqTitle: 34,
        faqDescription: 24,
        stepIndex: 21,
        stepTitle: 32,
        stepDescription: 24,
        comparisonLabel: 26,
        cta: 28,
      };
    }
    return {
      bullet: 30,
      bulletPlaceholder: 19,
      panelEyebrow: 18,
      panelHint: 17,
      featureTitle: 36,
      featureDescription: 24,
      faqBadge: 16,
      faqTitle: 34,
      faqDescription: 24,
      stepIndex: 21,
      stepTitle: 30,
      stepDescription: 22,
      comparisonLabel: 26,
      cta: 28,
    };
  }

  if (templateKind === 'feature_hero') {
    return {
      bullet: 30,
      bulletPlaceholder: 19,
      panelEyebrow: 18,
      panelHint: 17,
      featureTitle: 36,
      featureDescription: 24,
      faqBadge: 16,
      faqTitle: 34,
      faqDescription: 24,
      stepIndex: 21,
      stepTitle: 32,
      stepDescription: 24,
      comparisonLabel: 26,
      cta: 28,
    };
  }

  return {
    bullet: 30,
    bulletPlaceholder: 19,
    panelEyebrow: 18,
    panelHint: 17,
    featureTitle: 36,
    featureDescription: 24,
    faqBadge: 16,
    faqTitle: 34,
    faqDescription: 24,
    stepIndex: 21,
    stepTitle: 32,
    stepDescription: 24,
    comparisonLabel: 26,
    cta: 28,
  };
};

export const getStructuredContentDisplayProfile = (
  templateKind: string,
  items: Array<{ title?: string; description?: string }>
): StructuredContentDisplayProfile => {
  const rawCount = items.length || 1;
  const count = templateKind === 'benefit_grid'
    ? Math.max(1, Math.min(8, rawCount))
    : Math.max(1, Math.min(4, rawCount));
  const tier = count <= 2 ? 'sparse' : count <= 4 ? 'balanced' : 'dense';

  if (templateKind === 'benefit_grid') {
    if (count === 1) {
      return { count, maxItems: 8, tier, layout: 'stack', bodyTextRatio: 0.28 };
    }
    return {
      count,
      maxItems: 8,
      tier,
      layout: 'grid',
      bodyTextRatio: count <= 2 ? 0.26 : count <= 4 ? 0.3 : 0.36,
    };
  }

  if (templateKind === 'faq_card') {
    if (count <= 2) {
      return { count, maxItems: 4, tier, layout: 'stack', bodyTextRatio: 0.28 };
    }
    return { count, maxItems: 4, tier, layout: 'grid', bodyTextRatio: 0.32 };
  }

  if (templateKind === 'step_guide') {
    return { count, maxItems: 4, tier, layout: 'steps', bodyTextRatio: count <= 2 ? 0.26 : 0.3 };
  }

  return { count, maxItems: 4, tier, layout: 'stack', bodyTextRatio: 0.3 };
};

export const getTemplateModuleInputRules = (
  templateKind: string,
  moduleType: string
): TemplateModuleInputRules => {
  if (moduleType === 'title_block') {
    return { singleLineLimit: TEMPLATE_CONTENT_LIMITS.title };
  }
  if (moduleType === 'subtitle_block') {
    return { descriptionLimit: TEMPLATE_CONTENT_LIMITS.subtitle };
  }
  if (moduleType === 'footer_note') {
    return { descriptionLimit: TEMPLATE_CONTENT_LIMITS.footer };
  }
  if (moduleType === 'body_text_block') {
    if (templateKind === 'benefit_grid') {
      return { bodyTextLimit: TEMPLATE_CONTENT_LIMITS.bodyTextBenefit };
    }
    if (templateKind === 'step_guide') {
      return { bodyTextLimit: TEMPLATE_CONTENT_LIMITS.bodyTextStep };
    }
    if (templateKind === 'faq_card') {
      return { bodyTextLimit: TEMPLATE_CONTENT_LIMITS.bodyTextFaq };
    }
    return {};
  }
  if (moduleType === 'bullet_group') {
    return { maxItems: 4, singleLineLimit: TEMPLATE_CONTENT_LIMITS.bullet };
  }
  if (moduleType === 'step_group') {
    return {
      maxItems: 4,
      titleLimit: TEMPLATE_CONTENT_LIMITS.stepTitle,
      descriptionLimit: TEMPLATE_CONTENT_LIMITS.stepDescription,
    };
  }
  if (moduleType === 'feature_grid' && templateKind === 'faq_card') {
    return {
      maxItems: 4,
      titleLimit: TEMPLATE_CONTENT_LIMITS.faqTitle,
      descriptionLimit: TEMPLATE_CONTENT_LIMITS.faqDescription,
    };
  }
  if (moduleType === 'feature_grid') {
    return {
      maxItems: templateKind === 'benefit_grid' ? 8 : 4,
      titleLimit: TEMPLATE_CONTENT_LIMITS.featureTitle,
      descriptionLimit: TEMPLATE_CONTENT_LIMITS.featureDescription,
    };
  }
  return {};
};

export const getTemplateCanvasPadding = (styleVariant?: string | null) => (
  styleVariant === 'text_cover_bold'
    ? { x: 40, y: 40 }
    : { x: 48, y: 56 }
);

export const getTemplateViewportScale = (
  containerWidth: number,
  containerHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  mode: 'editor' | 'thumbnail' | 'preview'
) => {
  const inset = mode === 'preview' ? 0.995 : mode === 'thumbnail' ? 0.995 : 0.92;
  const fallback = mode === 'preview' ? 0.42 : mode === 'thumbnail' ? 0.16 : 0.46;

  if (!containerWidth || !containerHeight || !canvasWidth || !canvasHeight) {
    return fallback;
  }

  return Math.max(0.05, Math.min(
    (containerWidth * inset) / canvasWidth,
    (containerHeight * inset) / canvasHeight
  ));
};
