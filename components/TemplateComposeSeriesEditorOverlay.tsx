import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Asset, ReferenceAsset, TemplateComposeCard, TemplateComposeDocument, TemplateKind, TemplateStyleVariant, VisualProject } from '../types';
import TemplateAssetPreview from './TemplateAssetPreview';
import ScaledTemplateCanvas from './ScaledTemplateCanvas';
import {
  documentToEditablePayload,
  editablePayloadToDocument,
  applyDocumentStyleVariant,
  getDefaultStyleSlots,
  getDefaultStyleVariant,
  getTemplateFrameStyles,
  getTemplateStyleVariants,
  patchDocumentAssets,
  patchDocumentModule,
  patchDocumentModuleLayout,
  renderTemplateDocumentDataUrl,
  resolveTemplateFrameStyle,
  resolveTemplateStyleVariant,
} from '../lib/templateComposer';
import { buildTemplateAssetForStudio } from '../lib/templateAssetRenderer';
import {
  TEMPLATE_CONTENT_LIMITS,
  clampCompactChars,
  countCompactChars,
  getTemplateModuleInputRules,
  getTemplateViewportScale,
} from '../lib/templatePreviewLayout';

interface TemplateComposeSeriesEditorOverlayProps {
  isOpen: boolean;
  project: VisualProject | null;
  referenceAssets: ReferenceAsset[];
  onClose: () => void;
  onDraftChange: (payload: { project: VisualProject }) => void;
  onApply: (payload: { project: VisualProject }) => void;
}

type InspectorTab = 'content' | 'layout' | 'project';

const templateKindByCardType: Record<string, TemplateKind> = {
  封面卡: 'feature_hero',
  功能卡: 'benefit_grid',
  步骤卡: 'step_guide',
  对比卡: 'before_after',
  收口卡: 'feature_hero',
};

const moduleTypeLabels: Record<string, string> = {
  title_block: '标题',
  subtitle_block: '副标题',
  screenshot_frame: '图片区',
  bullet_group: '内容区',
  feature_grid: '内容区',
  step_group: '内容区',
  body_text_block: '自由文案',
};

const styleVariantMeta: Record<string, { label: string; description: string; preview: 'text' | 'split' | 'hero' | 'grid' | 'annotated' | 'steps' | 'focus' }> = {
  freeform_stage: { label: '自由展示', description: '保留高自由度大图舞台', preview: 'split' },
  text_cover_bold: { label: '纯文字封面', description: '强标题、强断行、适合封面/收口', preview: 'text' },
  highlight_screenshot_grid: { label: '亮点截图网格', description: '上图下网格，适合卖点说明', preview: 'grid' },
  annotated_highlight_grid: { label: '标注亮点网格', description: '截图重点标注，再补卖点卡', preview: 'annotated' },
  step_text_image: { label: '步骤图文', description: '截图配步骤说明，适合教程页', preview: 'steps' },
  step_focus_screenshot: { label: '聚焦截图步骤', description: '一张大图配 2-3 条提示', preview: 'focus' },
};
const frameStyleMeta: Record<string, { label: string; description: string; preview: 'soft' | 'sunset' | 'editorial' | 'notebook' | 'split' }> = {
  soft_gradient_card: { label: '清爽白板', description: '更干净、更利落，适合稳定讲解', preview: 'soft' },
  sunset_glow_card: { label: '宣传海报', description: '暖色斜切 + 发光氛围，更适合强传播', preview: 'sunset' },
  editorial_outline_card: { label: '杂志留白', description: '无大白框，标题与截图直接排在画面里', preview: 'editorial' },
  notebook_tape_card: { label: '便签手账', description: '胶带便签感，更轻松更像笔记', preview: 'notebook' },
  split_banner_card: { label: '分栏横幅', description: '彩色侧条，更现代更有信息感', preview: 'split' },
};

const PanelSection: React.FC<{ title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode }> = ({
  title,
  hint,
  defaultOpen = false,
  children,
}) => (
  <details open={defaultOpen} className="rounded-2xl border border-white/10 bg-white/[0.03]">
    <summary className="cursor-pointer list-none px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-[0.22em] text-slate-400">{title}</div>
          {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
        </div>
        <div className="text-xs text-slate-500">展开</div>
      </div>
    </summary>
    <div className="border-t border-white/6 p-4 pt-3">{children}</div>
  </details>
);

const supportsImageRegion = (templateKind: TemplateKind | string, styleVariant?: string) =>
  String(templateKind) === 'benefit_grid'
  || String(templateKind) === 'before_after'
  || String(templateKind) === 'step_guide'
  || (String(templateKind) === 'feature_hero' && styleVariant !== 'text_cover_bold');

const supportsContentEditor = (templateKind: TemplateKind | string) =>
  ['feature_hero', 'benefit_grid', 'step_guide', 'faq_card'].includes(String(templateKind));

const supportsBodyTextModule = (templateKind: TemplateKind | string) =>
  ['benefit_grid', 'step_guide', 'faq_card'].includes(String(templateKind));

const pageTemplateOptionsByCardType: Record<string, Array<{ value: TemplateKind; label: string; description: string }>> = {
  封面卡: [
    { value: 'feature_hero', label: '封面页', description: '适合纯文字封面或自由编排首图' },
  ],
  功能卡: [
    { value: 'feature_hero', label: '自由展示', description: '大图和内容区自由编排，发挥空间最大' },
    { value: 'benefit_grid', label: '卖点页', description: '更适合亮点说明、卖点拆解' },
    { value: 'step_guide', label: '教程页', description: '更适合教程页、分步骤讲解' },
    { value: 'faq_card', label: '答疑页', description: '更适合答疑、注意事项、常见问题' },
    { value: 'before_after', label: '对比页', description: '更适合改造前后或两种方案对比' },
  ],
  步骤卡: [
    { value: 'feature_hero', label: '自由展示', description: '适合高自由度步骤讲解' },
    { value: 'step_guide', label: '教程页', description: '适合标准教程步骤页' },
    { value: 'benefit_grid', label: '卖点页', description: '适合步骤重点整理成要点卡' },
  ],
  对比卡: [
    { value: 'before_after', label: '对比页', description: '左右对比更直接' },
    { value: 'feature_hero', label: '自由展示', description: '适合更灵活的对比表达' },
  ],
  收口卡: [
    { value: 'feature_hero', label: '收口页', description: '适合纯文字收口或带 CTA 的总结页' },
  ],
};

const toLineText = (content: unknown): string => {
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object') {
        const title = 'title' in item ? String(item.title || '') : '';
        const description = 'description' in item ? String(item.description || '') : '';
        return [title, description].filter(Boolean).join(' | ');
      }
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(content || '');
};

const fromLineText = (templateKind: string, value: string): unknown => {
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (templateKind === 'feature_hero') {
    return lines;
  }
  return lines.map((line, index) => {
    const [title, ...rest] = line.split('|');
    return {
      title: title?.trim() || `条目 ${index + 1}`,
      description: rest.join('|').trim() || title?.trim() || '',
    };
  });
};

const getBodyTextModule = (document: TemplateComposeDocument | undefined | null) => (
  document?.modules.find((item) => item.type === 'body_text_block') || null
);

const sanitizeStructuredLine = (
  line: string,
  rules: ReturnType<typeof getTemplateModuleInputRules>,
  fallbackLabel: string
) => {
  const [rawTitle, ...rest] = line.split('|');
  const nextTitle = rules.titleLimit ? clampCompactChars(rawTitle.trim(), rules.titleLimit) : rawTitle.trim();
  const nextDescription = rules.descriptionLimit
    ? clampCompactChars(rest.join('|').trim(), rules.descriptionLimit)
    : rest.join('|').trim();
  return [nextTitle || fallbackLabel, nextDescription].filter(Boolean).join(' | ');
};

const sanitizeContentEditorText = (
  templateKind: string,
  moduleType: string,
  value: string
) => {
  const rules = getTemplateModuleInputRules(templateKind, moduleType);
  const lines = value.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, rules.maxItems || 99);

  if (moduleType === 'bullet_group') {
    return lines
      .map((line) => clampCompactChars(line, rules.singleLineLimit || TEMPLATE_CONTENT_LIMITS.bullet))
      .filter(Boolean)
      .join('\n');
  }

  return lines
    .map((line, index) => sanitizeStructuredLine(line, rules, `条目 ${index + 1}`))
    .filter(Boolean)
    .join('\n');
};

const buildCardDocumentWithKind = (card: TemplateComposeCard, templateKind: TemplateKind | string): TemplateComposeDocument => {
  const payload = documentToEditablePayload(card.document);
  const styleVariant = resolveTemplateStyleVariant(templateKind, undefined, card.cardType) || payload.styleVariant;
  return editablePayloadToDocument({
    ...payload,
    templateKind,
    styleVariant,
    screenshots: supportsImageRegion(templateKind, styleVariant) ? payload.screenshots : [],
    noteVisualPlan: card.document.noteVisualPlan,
  }, {
    id: card.document.id,
    brandStyle: card.document.meta?.brandStyle,
    cardType: card.cardType,
  });
};

const updateCardAsset = async (card: TemplateComposeCard): Promise<TemplateComposeCard> => {
  const renderedAsset = await buildTemplateAssetForStudio({
    document: card.document,
    sourceAsset: card.renderedAsset,
    promptLabel: card.cardType,
    promptText: card.summary,
  });
  return {
    ...card,
    renderedAsset: {
      ...renderedAsset,
      url: renderTemplateDocumentDataUrl(card.document),
    },
  };
};

const TemplateComposeSeriesEditorOverlay: React.FC<TemplateComposeSeriesEditorOverlayProps> = ({
  isOpen,
  project,
  referenceAssets,
  onClose,
  onDraftChange,
  onApply,
}) => {
  const [workingProject, setWorkingProject] = useState<VisualProject | null>(project);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeInspectorTab, setActiveInspectorTab] = useState<InspectorTab>('content');
  const [selectedModuleId, setSelectedModuleId] = useState<string>('');
  const [activeCardId, setActiveCardId] = useState<string>('');
  const [beforeAfterTarget, setBeforeAfterTarget] = useState<'before' | 'after'>('before');
  const [contentEditorText, setContentEditorText] = useState('');
  const hydratedProjectIdRef = useRef<string>('');
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const [previewViewportSize, setPreviewViewportSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!isOpen) {
      hydratedProjectIdRef.current = '';
      return;
    }
    if (project && hydratedProjectIdRef.current !== project.projectId) {
      setWorkingProject(project);
      setActiveCardId(project.activeCardId || project.cards[0]?.cardId || '');
      hydratedProjectIdRef.current = project.projectId;
    }
  }, [isOpen, project]);

  useEffect(() => {
    if (!workingProject?.cards?.length) {
      setSelectedModuleId('');
      return;
    }
    const active = workingProject.cards.find((card) => card.cardId === activeCardId) || workingProject.cards[0];
    const resolvedStyleVariant = resolveTemplateStyleVariant(active.templateKind, active.document.styleVariant, active.cardType);
    const preferredTypes = supportsImageRegion(active.templateKind, resolvedStyleVariant)
      ? ['screenshot_frame', 'bullet_group', 'feature_grid', 'step_group']
      : ['bullet_group', 'feature_grid', 'step_group'];
    const defaultSelected = active.document.modules.find((item) =>
      preferredTypes.includes(item.type) && item.visible !== false
    )?.id || active.document.modules[0]?.id || '';
    setSelectedModuleId((prev) => {
      if (prev && active.document.modules.some((item) => item.id === prev)) {
        return prev;
      }
      return defaultSelected;
    });
  }, [activeCardId, workingProject?.cards]);

  useEffect(() => {
    if (isOpen && workingProject) {
      const timer = window.setTimeout(() => onDraftChange({
        project: {
          ...workingProject,
          activeCardId,
        },
      }), 220);
      return () => window.clearTimeout(timer);
    }
  }, [activeCardId, isOpen, onDraftChange, workingProject]);

  const activeCard = useMemo(() => {
    if (!workingProject?.cards?.length) {
      return null;
    }
    return workingProject.cards.find((card) => card.cardId === activeCardId) || workingProject.cards[0];
  }, [activeCardId, workingProject]);

  const rawContentModule = activeCard?.document.modules.find((item) =>
    ['bullet_group', 'feature_grid', 'step_group'].includes(item.type)
  );
  const currentContentModule = activeCard?.document.modules.find((item) =>
    ['bullet_group', 'feature_grid', 'step_group'].includes(item.type) && item.visible !== false
  );
  const titleModule = activeCard?.document.modules.find((item) => item.type === 'title_block');
  const subtitleModule = activeCard?.document.modules.find((item) => item.type === 'subtitle_block');
  const selectedModule = activeCard?.document.modules.find((item) => item.id === selectedModuleId) || currentContentModule || activeCard?.document.modules[0];
  const rawScreenshotModule = activeCard?.document.modules.find((item) => item.type === 'screenshot_frame');
  const bodyTextModule = getBodyTextModule(activeCard?.document);
  const screenshotModule = rawScreenshotModule?.visible !== false ? rawScreenshotModule : null;
  const activeStyleVariant = resolveTemplateStyleVariant(activeCard?.templateKind || '', activeCard?.document.styleVariant, activeCard?.cardType);
  const activeFrameStyle = resolveTemplateFrameStyle(activeCard?.templateKind || '', activeCard?.document.frameStyle);
  const styleOptions = activeCard ? getTemplateStyleVariants(activeCard.templateKind).map((variant) => ({
    value: variant,
    label: styleVariantMeta[variant]?.label || variant,
    description: styleVariantMeta[variant]?.description || '',
    preview: styleVariantMeta[variant]?.preview || 'split',
  })) : [];
  const frameOptions = activeCard ? getTemplateFrameStyles(activeCard.templateKind).map((frameStyle) => ({
    value: frameStyle,
    label: frameStyleMeta[frameStyle]?.label || frameStyle,
    description: frameStyleMeta[frameStyle]?.description || '',
    preview: frameStyleMeta[frameStyle]?.preview || 'soft',
  })) : [];
  const pageTemplateOptions = activeCard
    ? (pageTemplateOptionsByCardType[activeCard.cardType] || pageTemplateOptionsByCardType['功能卡'])
    : [];
  const styleSlots = {
    ...getDefaultStyleSlots(activeStyleVariant),
    ...(activeCard?.document.meta?.styleSlots || {}),
  };
  const isTextCoverPage = activeStyleVariant === 'text_cover_bold';
  const supportsCurrentImageRegion = supportsImageRegion(activeCard?.templateKind || '', activeStyleVariant);
  const titleCharCount = countCompactChars(activeCard?.title || '');
  const subtitleCharCount = countCompactChars(activeCard?.summary || '');
  const titleRules = getTemplateModuleInputRules(activeCard?.templateKind || '', 'title_block');
  const subtitleRules = getTemplateModuleInputRules(activeCard?.templateKind || '', 'subtitle_block');
  const footerRules = getTemplateModuleInputRules(activeCard?.templateKind || '', 'footer_note');
  const contentInputRules = getTemplateModuleInputRules(activeCard?.templateKind || '', currentContentModule?.type || selectedModule?.type || '');
  const currentContentItems = Array.isArray(currentContentModule?.content) ? currentContentModule.content.length : 0;
  const maxContentItems = contentInputRules.maxItems || 4;
  const canAddContentItem = Boolean(currentContentModule) && currentContentItems < maxContentItems;
  const textCoverDensityHint = isTextCoverPage && titleCharCount + subtitleCharCount > 42
    ? '当前封面文案偏长，系统会优先保住大字标题感；胶囊标签可能自动隐藏，标题建议控制在 3-4 行内。'
    : null;
  const contentDensityHint = useMemo(() => {
    if (!selectedModule || !['bullet_group', 'feature_grid', 'step_group'].includes(selectedModule.type)) {
      return null;
    }

    const contentEditorLines = contentEditorText.split('\n').map((line) => line.trim()).filter(Boolean);

    if (selectedModule.type === 'bullet_group') {
      const overLimit = contentEditorLines.find((line) => countCompactChars(line) > TEMPLATE_CONTENT_LIMITS.bullet);
      return overLimit ? `有要点超过推荐长度（${TEMPLATE_CONTENT_LIMITS.bullet} 字内），为了放大展示，当前页会自动截短或减少展示量。` : null;
    }

    if (selectedModule.type === 'step_group') {
      const overLimit = contentEditorLines.find((line) => {
        const [rawTitle, ...rest] = line.split('|');
        const merged = rest.join('|').trim() || rawTitle.trim();
        return countCompactChars(merged) > TEMPLATE_CONTENT_LIMITS.stepDescription;
      });
      return overLimit ? `有步骤说明超过推荐长度（${TEMPLATE_CONTENT_LIMITS.stepDescription} 字内），为了放大展示，当前页可能只保留 3 步或自动截短。` : null;
    }

    const overLimit = contentEditorLines.find((line) => {
      const [rawTitle, ...rest] = line.split('|');
      const itemTitle = rawTitle.trim();
      const itemDescription = rest.join('|').trim();
      return countCompactChars(itemTitle) > TEMPLATE_CONTENT_LIMITS.featureTitle
        || countCompactChars(itemDescription) > TEMPLATE_CONTENT_LIMITS.featureDescription;
    });

    return overLimit
      ? `有卡片标题或说明超过推荐长度（标题 ${TEMPLATE_CONTENT_LIMITS.featureTitle} 字内 / 说明 ${TEMPLATE_CONTENT_LIMITS.featureDescription} 字内），为了放大展示，当前页可能减少为 2-3 个更大的信息块。`
      : null;
  }, [contentEditorText, selectedModule]);
  const moduleQuickTabs = [
    titleModule,
    subtitleModule,
    activeCard && supportsContentEditor(activeCard.templateKind) ? (currentContentModule || rawContentModule) : null,
    activeCard && supportsBodyTextModule(activeCard.templateKind) ? bodyTextModule : null,
    activeCard && supportsCurrentImageRegion ? screenshotModule : null,
  ].filter(Boolean);

  useEffect(() => {
    if (selectedModule && ['bullet_group', 'feature_grid', 'step_group'].includes(selectedModule.type)) {
      setContentEditorText(sanitizeContentEditorText(String(activeCard?.templateKind || ''), selectedModule.type, toLineText(selectedModule.content)));
      return;
    }
    if (selectedModule?.type === 'body_text_block') {
      setContentEditorText(clampCompactChars(String(selectedModule.content || ''), contentInputRules.bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit));
      return;
    }
    setContentEditorText('');
  }, [activeCard?.templateKind, contentInputRules.bodyTextLimit, selectedModule?.content, selectedModule?.id, selectedModule?.type]);

  const previewDocument = useMemo(() => {
    if (!activeCard || !selectedModule) {
      return activeCard?.document || null;
    }
    if (selectedModule.type === 'body_text_block') {
      return patchDocumentModule(activeCard.document, selectedModule.id, {
        content: clampCompactChars(contentEditorText, contentInputRules.bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit),
        visible: Boolean(contentEditorText.trim()),
      });
    }
    if (!['bullet_group', 'feature_grid', 'step_group'].includes(selectedModule.type)) {
      return activeCard?.document || null;
    }
    return patchDocumentModule(activeCard.document, selectedModule.id, {
      content: fromLineText(
        String(activeCard.templateKind),
        sanitizeContentEditorText(String(activeCard.templateKind), selectedModule.type, contentEditorText)
      ),
    });
  }, [activeCard, contentEditorText, selectedModule]);
  const activePreviewDocument = previewDocument || activeCard?.document || null;
  const activePreviewScale = useMemo(() => {
    if (!activePreviewDocument) {
      return 1;
    }
    return getTemplateViewportScale(
      previewViewportSize.width,
      previewViewportSize.height,
      activePreviewDocument.canvas.width,
      activePreviewDocument.canvas.height,
      'editor'
    );
  }, [activePreviewDocument, previewViewportSize]);

  useEffect(() => {
    const node = previewViewportRef.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setPreviewViewportSize({
        width: rect.width,
        height: rect.height,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [activeCardId]);

  if (!isOpen || !workingProject || !activeCard) {
    return null;
  }

  const setProject = async (nextProject: VisualProject) => {
    const nextCards = await Promise.all(nextProject.cards.map((card) => updateCardAsset(card)));
    setWorkingProject({
      ...nextProject,
      cards: nextCards,
    });
  };

  const updateCard = async (cardId: string, updater: (card: TemplateComposeCard) => TemplateComposeCard) => {
    const nextCards = workingProject.cards.map((card) => card.cardId === cardId ? updater(card) : card);
    await setProject({
      ...workingProject,
      cards: nextCards,
    });
  };

  const updateCurrentCardDocument = async (nextDocument: TemplateComposeDocument) => {
    await updateCard(activeCard.cardId, (card) => ({
      ...card,
      document: nextDocument,
      templateKind: nextDocument.templateKind,
      title: String(nextDocument.modules.find((item) => item.type === 'title_block')?.content || card.title),
      summary: String(nextDocument.modules.find((item) => item.type === 'subtitle_block')?.content || card.summary),
      status: 'draft',
    }));
  };

  const updateCurrentDocumentMeta = async (updates: Partial<NonNullable<TemplateComposeDocument['meta']>>) => {
    await updateCurrentCardDocument({
      ...activeCard.document,
      meta: {
        ...activeCard.document.meta,
        ...updates,
      },
    });
  };

  const updateGlobalMeta = async (field: 'theme' | 'ctaText' | 'footerNote', value: string) => {
    const nextCards = workingProject.cards.map((card) => {
      let nextDocument = card.document;
      if (field === 'theme') {
        nextDocument = { ...nextDocument, theme: value };
      }
      if (field === 'ctaText') {
        const ctaModule = nextDocument.modules.find((item) => item.type === 'cta_badge');
        if (ctaModule) {
          nextDocument = patchDocumentModule(nextDocument, ctaModule.id, { content: value });
        }
      }
      if (field === 'footerNote') {
        const footerModule = nextDocument.modules.find((item) => item.type === 'footer_note');
        if (footerModule) {
          nextDocument = patchDocumentModule(nextDocument, footerModule.id, { content: value });
        }
      }
      return {
        ...card,
        document: nextDocument,
      };
    });
    await setProject({ ...workingProject, cards: nextCards });
  };

  const activeScreenshot = activeCard.document.assets?.[0] || null;
  const isFreeformStage = activeCard.templateKind === 'feature_hero' && activeStyleVariant === 'freeform_stage';

  const openModuleEditor = (moduleId: string, preferredTab: InspectorTab = 'content') => {
    setActiveInspectorTab(preferredTab);
    setSelectedModuleId(moduleId);
  };

  const setModuleVisibility = async (moduleType: TemplateComposeDocument['modules'][number]['type'], visible: boolean) => {
    const module = activeCard.document.modules.find((item) => item.type === moduleType);
    if (!module) {
      return;
    }
    if (module.type === 'screenshot_frame' && !visible) {
      const clearedDocument = patchDocumentAssets(activeCard.document, []);
      await updateCurrentCardDocument(patchDocumentModule(clearedDocument, module.id, { visible: false }));
      return;
    }
    await updateCurrentCardDocument(patchDocumentModule(activeCard.document, module.id, { visible }));
    if (visible) {
      openModuleEditor(module.id, 'content');
    }
  };

  const addContentItem = async () => {
    if (!currentContentModule) {
      return;
    }
    const current = Array.isArray(currentContentModule.content) ? currentContentModule.content : [];
    const rules = getTemplateModuleInputRules(String(activeCard.templateKind), currentContentModule.type);
    if (current.length >= (rules.maxItems || 4)) {
      return;
    }
    const nextContent = activeCard.templateKind === 'feature_hero'
      ? [...current, `新增文案 ${current.length + 1}`]
      : [
          ...current,
          { title: `新增文案 ${current.length + 1}`, description: '补充这一项说明' },
        ];
    setSelectedModuleId(currentContentModule.id);
    await updateCurrentCardDocument(
      patchDocumentModule(activeCard.document, currentContentModule.id, { content: nextContent })
    );
  };

  const removeContentItem = async () => {
    if (!currentContentModule) {
      return;
    }
    const current = Array.isArray(currentContentModule.content) ? currentContentModule.content : [];
    const nextContent = current.slice(0, -1);
    setSelectedModuleId(currentContentModule.id);
    await updateCurrentCardDocument(
      patchDocumentModule(activeCard.document, currentContentModule.id, { content: nextContent })
    );
  };

  const commitContentEditorText = async () => {
    if (!selectedModule) {
      return;
    }
    if (selectedModule.type === 'body_text_block') {
      const sanitized = clampCompactChars(contentEditorText, contentInputRules.bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit);
      setContentEditorText(sanitized);
      await updateCurrentCardDocument(
        {
          ...patchDocumentModule(activeCard.document, selectedModule.id, {
            content: sanitized,
            visible: Boolean(sanitized.trim()),
          }),
          meta: {
            ...activeCard.document.meta,
            bodyText: sanitized,
          },
        }
      );
      return;
    }
    if (!['bullet_group', 'feature_grid', 'step_group'].includes(selectedModule.type)) {
      return;
    }
    const sanitized = sanitizeContentEditorText(String(activeCard.templateKind), selectedModule.type, contentEditorText);
    setContentEditorText(sanitized);
    await updateCurrentCardDocument(
      patchDocumentModule(activeCard.document, selectedModule.id, {
        content: fromLineText(String(activeCard.templateKind), sanitized),
      })
    );
  };

  const ensureBodyTextModule = async () => {
    if (!supportsBodyTextModule(activeCard.templateKind)) {
      return;
    }
    if (bodyTextModule) {
      setSelectedModuleId(bodyTextModule.id);
      await updateCurrentCardDocument(patchDocumentModule(activeCard.document, bodyTextModule.id, { visible: true }));
      return;
    }

    const nextId = `body-text-${Date.now()}`;
    setSelectedModuleId(nextId);
    await updateCurrentCardDocument({
      ...activeCard.document,
      modules: [
        ...activeCard.document.modules,
        {
          id: nextId,
          type: 'body_text_block',
          visible: true,
          order: 7,
          content: '',
        },
      ],
      meta: {
        ...activeCard.document.meta,
        bodyText: '',
      },
    });
  };

  const removeBodyTextModule = async () => {
    if (!bodyTextModule) {
      return;
    }
    await updateCurrentCardDocument({
      ...activeCard.document,
      modules: activeCard.document.modules.filter((item) => item.id !== bodyTextModule.id),
      meta: {
        ...activeCard.document.meta,
        bodyText: '',
      },
    });
    setSelectedModuleId(currentContentModule?.id || '');
  };

  const clearCurrentImages = async () => {
    if (!rawScreenshotModule || !supportsImageRegion(activeCard.templateKind, activeStyleVariant)) {
      return;
    }
    setSelectedModuleId(rawScreenshotModule.id);
    await updateCurrentCardDocument(patchDocumentAssets(activeCard.document, []));
  };

  const insertReferenceAssetToCard = async (asset: ReferenceAsset) => {
    if (!supportsImageRegion(activeCard.templateKind, activeStyleVariant) || !rawScreenshotModule) {
      return;
    }

    const nextShot = {
      assetId: asset.id,
      url: asset.url,
      label: asset.original_name,
      width: asset.width,
      height: asset.height,
      crop: { x: 50, y: 50, zoom: 1, fitMode: 'cover' as const },
    };

    let nextAssets = [...activeCard.document.assets];
    if (activeCard.templateKind === 'before_after') {
      const targetIndex = beforeAfterTarget === 'before' ? 0 : 1;
      nextAssets[targetIndex] = nextShot;
      nextAssets = nextAssets.filter(Boolean).slice(0, 2);
    } else {
      nextAssets = [nextShot];
    }

    setSelectedModuleId(rawScreenshotModule.id);
    await updateCurrentCardDocument(patchDocumentAssets(activeCard.document, nextAssets));
  };

  const duplicateCurrentCard = async () => {
    const duplicated: TemplateComposeCard = {
      ...activeCard,
      cardId: `${activeCard.cardId}-copy-${Date.now()}`,
      document: {
        ...activeCard.document,
        id: `${activeCard.document.id}-copy-${Date.now()}`,
      },
      renderedAsset: {
        ...activeCard.renderedAsset,
        id: `${activeCard.renderedAsset.id}-copy-${Date.now()}`,
      },
    };
    const currentIndex = workingProject.cards.findIndex((card) => card.cardId === activeCard.cardId);
    const nextCards = [...workingProject.cards];
    nextCards.splice(currentIndex + 1, 0, duplicated);
    await setProject({
      ...workingProject,
      cards: nextCards,
    });
    setActiveCardId(duplicated.cardId);
  };

  const deleteCurrentCard = async () => {
    if (workingProject.cards.length <= 3) {
      return;
    }
    const nextCards = workingProject.cards.filter((card) => card.cardId !== activeCard.cardId);
    await setProject({
      ...workingProject,
      cards: nextCards,
      coverCardId: nextCards[0]?.cardId || '',
    });
    setActiveCardId(nextCards[0]?.cardId || '');
  };

  const insertNewCard = async () => {
    const templateKind = templateKindByCardType['功能卡'];
    const styleVariant = getDefaultStyleVariant(templateKind, '功能卡');
    const document = editablePayloadToDocument({
      ...documentToEditablePayload(activeCard.document),
      templateKind,
      styleVariant,
      title: '新增页面',
      subtitle: '补充这一页的核心信息',
    }, {
      id: `template-doc-${Date.now()}`,
      brandStyle: activeCard.document.meta?.brandStyle,
      cardType: '功能卡',
    });
    const newCard: TemplateComposeCard = {
      cardId: `card-${Date.now()}`,
      cardType: '功能卡',
      templateKind,
      title: '新增页面',
      summary: '补充这一页的核心信息',
      document,
      renderedAsset: {
        ...activeCard.renderedAsset,
        id: `asset-${Date.now()}`,
      },
      status: 'draft',
      sourceRefs: [],
    };
    const currentIndex = workingProject.cards.findIndex((card) => card.cardId === activeCard.cardId);
    const nextCards = [...workingProject.cards];
    nextCards.splice(currentIndex + 1, 0, newCard);
    await setProject({
      ...workingProject,
      cards: nextCards.slice(0, 6),
    });
    setActiveCardId(newCard.cardId);
  };

  const renderStylePreview = (preview: string) => {
    switch (preview) {
      case 'text':
        return (
          <div className="h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="h-2 w-1/3 rounded-full bg-slate-700/70" />
            <div className="mt-2 h-4 w-4/5 rounded bg-slate-900/80" />
            <div className="mt-1 h-4 w-3/5 rounded bg-slate-900/80" />
            <div className="mt-2 h-1.5 w-full rounded-full bg-slate-800/70" />
          </div>
        );
      case 'hero':
        return (
          <div className="h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="h-3 w-3/4 rounded bg-slate-900/80" />
            <div className="mt-1 h-2 w-1/2 rounded bg-slate-500/70" />
            <div className="mt-2 h-7 rounded-lg bg-white/90" />
          </div>
        );
      case 'grid':
        return (
          <div className="h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="h-6 rounded-lg bg-white/90" />
            <div className="mt-2 grid grid-cols-2 gap-1">
              <div className="h-2.5 rounded bg-white/85" />
              <div className="h-2.5 rounded bg-white/85" />
              <div className="h-2.5 rounded bg-white/85" />
              <div className="h-2.5 rounded bg-white/85" />
            </div>
          </div>
        );
      case 'annotated':
        return (
          <div className="relative h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="h-8 rounded-lg bg-white/90" />
            <div className="absolute left-4 top-3 h-3 w-8 rounded-full bg-emerald-300" />
            <div className="absolute right-4 top-8 h-3 w-8 rounded-full bg-orange-300" />
            <div className="mt-2 grid grid-cols-2 gap-1">
              <div className="h-2.5 rounded bg-white/85" />
              <div className="h-2.5 rounded bg-white/85" />
            </div>
          </div>
        );
      case 'steps':
        return (
          <div className="h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="h-6 rounded-lg bg-white/90" />
            <div className="mt-2 space-y-1">
              <div className="h-2 rounded bg-white/85" />
              <div className="h-2 rounded bg-white/85" />
              <div className="h-2 rounded bg-white/85" />
            </div>
          </div>
        );
      case 'focus':
        return (
          <div className="h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="h-8 rounded-lg bg-white/90" />
            <div className="mt-2 flex gap-1">
              <div className="h-2 flex-1 rounded bg-white/85" />
              <div className="h-2 flex-1 rounded bg-white/85" />
              <div className="h-2 flex-1 rounded bg-white/85" />
            </div>
          </div>
        );
      default:
        return (
          <div className="h-16 rounded-xl bg-[#f8ede6] p-2">
            <div className="grid h-full grid-cols-[0.8fr_1.2fr] gap-2">
              <div className="rounded-lg bg-white/85" />
              <div className="space-y-1.5">
                <div className="h-2 rounded bg-white/90" />
                <div className="h-2 rounded bg-white/90" />
                <div className="h-2 rounded bg-white/90" />
              </div>
            </div>
          </div>
        );
    }
  };

  const renderFramePreview = (preview: string) => {
    switch (preview) {
      case 'sunset':
        return (
          <div className="relative h-16 overflow-hidden rounded-xl border border-orange-200 bg-gradient-to-br from-[#fff1df] to-[#ffd7cf]">
            <div className="absolute -right-2 -top-3 h-10 w-10 rounded-full bg-orange-300/40 blur-xl" />
            <div className="absolute bottom-2 left-2 h-8 w-14 rounded-full bg-white/70" />
            <div className="absolute bottom-2 right-2 h-5 w-20 rounded-full bg-white/55" />
          </div>
        );
      case 'editorial':
        return (
          <div className="h-16 rounded-xl bg-gradient-to-br from-[#fffdf7] to-[#f2e8dc] p-2">
            <div className="grid h-full grid-cols-[8px_1fr] gap-2">
              <div className="rounded-sm bg-slate-700/70" />
              <div className="flex flex-col justify-between">
                <div>
                  <div className="h-2.5 w-2/3 rounded bg-slate-900/80" />
                  <div className="mt-1 h-1.5 w-4/5 rounded bg-slate-700/70" />
                </div>
                <div className="h-6 rounded-md border border-slate-700/20 bg-white/70" />
              </div>
            </div>
          </div>
        );
      case 'notebook':
        return (
          <div className="h-16 rounded-xl bg-gradient-to-br from-[#fffdf7] to-[#f5efe4] p-2">
            <div className="flex items-center justify-between">
              <div className="h-4 w-16 rounded-md border border-stone-400/25 border-dashed bg-[#fff7ed]" />
              <div className="flex gap-1">
                <div className="h-3 w-7 rotate-[8deg] rounded bg-yellow-300/50" />
                <div className="h-3 w-7 -rotate-[7deg] rounded bg-sky-300/30" />
              </div>
            </div>
            <div className="mt-2 h-[2px]" style={{ background: 'repeating-linear-gradient(90deg, rgba(120,113,108,0.28) 0 10px, rgba(120,113,108,0) 10px 16px)' }} />
            <div className="mt-2 h-6 rounded-md border border-stone-400/15 border-dashed bg-white/70" />
          </div>
        );
      case 'split':
        return (
          <div className="h-16 rounded-xl bg-gradient-to-br from-[#f8fafc] to-[#eef2ff] p-2">
            <div className="grid h-full grid-cols-[8px_1fr] gap-2">
              <div className="rounded bg-gradient-to-b from-blue-600 to-green-500" />
              <div className="flex flex-col justify-between">
                <div className="flex items-center justify-between">
                  <div className="h-3 w-14 rounded-full bg-blue-100" />
                  <div className="h-2 w-10 rounded-full bg-blue-600/15" />
                </div>
                <div className="h-7 rounded-md bg-white/80" />
              </div>
            </div>
          </div>
        );
      default:
        return (
          <div className="relative h-16 rounded-xl border border-white/60 bg-gradient-to-br from-[#fff7ed] to-[#ffe4e6] p-2">
            <div className="absolute right-3 top-1 h-3 w-10 rotate-[8deg] rounded-[5px] bg-[#ffe4b6]/80" />
            <div className="h-full rounded-lg bg-white/90" />
          </div>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-[220] bg-[#090b10]/92 backdrop-blur-md">
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-4 lg:px-6">
          <div className="min-w-0 flex-1">
            <div className="text-sm uppercase tracking-[0.28em] text-emerald-200/70">Visual Project</div>
            <div className="mt-1 text-lg font-semibold text-white">多页模板组图编辑器</div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5">关闭</button>
            <button
              onClick={async () => {
                if (isSubmitting) return;
                setIsSubmitting(true);
                try {
                  let nextProject = workingProject;
                  if (selectedModule && ['bullet_group', 'feature_grid', 'step_group', 'body_text_block'].includes(selectedModule.type)) {
                    const committedCards = workingProject.cards.map((card) => (
                      card.cardId === activeCard.cardId
                        ? {
                            ...card,
                            document: selectedModule.type === 'body_text_block'
                              ? {
                                  ...patchDocumentModule(card.document, selectedModule.id, {
                                    content: clampCompactChars(contentEditorText, getTemplateModuleInputRules(String(card.templateKind), 'body_text_block').bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit),
                                    visible: Boolean(clampCompactChars(contentEditorText, getTemplateModuleInputRules(String(card.templateKind), 'body_text_block').bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit).trim()),
                                  }),
                                  meta: {
                                    ...card.document.meta,
                                    bodyText: clampCompactChars(contentEditorText, getTemplateModuleInputRules(String(card.templateKind), 'body_text_block').bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit),
                                  },
                                }
                              : patchDocumentModule(card.document, selectedModule.id, {
                                  content: fromLineText(
                                    String(card.templateKind),
                                    sanitizeContentEditorText(String(card.templateKind), selectedModule.type, contentEditorText)
                                  ),
                                }),
                            status: 'draft' as const,
                          }
                        : card
                    ));
                    nextProject = {
                      ...workingProject,
                      cards: await Promise.all(committedCards.map((card) => updateCardAsset(card))),
                    };
                    setWorkingProject(nextProject);
                  }
                  onApply({
                    project: {
                      ...nextProject,
                      activeCardId,
                      status: 'applied',
                    },
                  });
                } finally {
                  setIsSubmitting(false);
                }
              }}
              className="rounded-xl bg-emerald-400 px-4 py-2 text-sm font-medium text-slate-950"
            >
              {isSubmitting ? '应用中...' : '应用到工作台'}
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="w-[200px] shrink-0 overflow-y-auto border-r border-white/10 bg-black/20 p-3 lg:w-[220px] 2xl:w-[240px]">
            <div className="mb-3 text-xs uppercase tracking-[0.22em] text-slate-400">页面列表</div>
            <div className="space-y-3">
              {workingProject.cards.map((card, index) => (
                <button
                  key={card.cardId}
                  type="button"
                  onClick={() => setActiveCardId(card.cardId)}
                  className={`w-full overflow-hidden rounded-2xl border text-left transition-all ${
                    card.cardId === activeCardId
                      ? 'border-emerald-300/60 bg-emerald-300/10 shadow-[0_0_0_1px_rgba(110,231,183,0.08)]'
                      : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.05]'
                  }`}
                >
                  <div className="relative aspect-[3/4]">
                    <TemplateAssetPreview
                      asset={{
                        ...card.renderedAsset,
                        templateDocument: card.document,
                        editablePayload: documentToEditablePayload(card.document),
                        url: renderTemplateDocumentDataUrl(card.document),
                      }}
                      mode="thumbnail"
                    />
                    {card.cardId === activeCardId ? (
                      <>
                        <div className="pointer-events-none absolute inset-0 bg-emerald-300/12 ring-2 ring-inset ring-emerald-300/60" />
                        <div className="pointer-events-none absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-300 text-[13px] font-bold text-slate-950 shadow-lg">
                          ✓
                        </div>
                      </>
                    ) : null}
                  </div>
                  <div className="px-3 py-2">
                    <div className="text-xs text-slate-400">第 {index + 1} 页 · {card.cardType}</div>
                    <div className="mt-1 line-clamp-2 text-sm font-medium text-white">{card.title}</div>
                  </div>
                </button>
              ))}
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 flex-1 bg-[#0f1115] p-2 lg:p-3 xl:p-4">
              <div ref={previewViewportRef} className="relative h-full w-full overflow-auto">
                {activePreviewDocument ? (
                  <ScaledTemplateCanvas
                    document={activePreviewDocument}
                    scale={activePreviewScale}
                    presentation="embedded"
                    selectedModuleId={selectedModule?.id}
                    onModuleSelect={(moduleId) => setSelectedModuleId(moduleId)}
                    onModuleLayoutChange={(moduleId, nextLayout) => {
                      void updateCurrentCardDocument(patchDocumentModuleLayout(activeCard.document, moduleId, nextLayout));
                    }}
                  />
                ) : null}
              </div>
            </div>

            <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-white/10 bg-[#12151c] p-4 xl:w-[320px] 2xl:w-[340px]">
              <div className="space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-1">
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { value: 'content' as const, label: '内容编辑' },
                      { value: 'layout' as const, label: '布局样式' },
                      { value: 'project' as const, label: '项目设置' },
                    ].map((tab) => (
                      <button
                        key={tab.value}
                        type="button"
                        onClick={() => setActiveInspectorTab(tab.value)}
                        className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                          activeInspectorTab === tab.value
                            ? 'bg-emerald-300 text-slate-950'
                            : 'text-slate-300 hover:bg-white/5'
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">快速切换</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {titleModule ? (
                      <button
                        type="button"
                        onClick={() => openModuleEditor(titleModule.id)}
                        className={`rounded-full px-3 py-1.5 text-xs ${selectedModule?.id === titleModule.id && activeInspectorTab === 'content' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                      >
                        标题
                      </button>
                    ) : null}
                    {subtitleModule ? (
                      <button
                        type="button"
                        onClick={() => openModuleEditor(subtitleModule.id)}
                        className={`rounded-full px-3 py-1.5 text-xs ${selectedModule?.id === subtitleModule.id && activeInspectorTab === 'content' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                      >
                        副标题
                      </button>
                    ) : null}
                    {(currentContentModule || rawContentModule) ? (
                      <button
                        type="button"
                        onClick={() => openModuleEditor((currentContentModule || rawContentModule)!.id)}
                        className={`rounded-full px-3 py-1.5 text-xs ${selectedModule?.id === (currentContentModule || rawContentModule)!.id && activeInspectorTab === 'content' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                      >
                        文字区
                      </button>
                    ) : null}
                    {rawScreenshotModule && supportsCurrentImageRegion ? (
                      <button
                        type="button"
                        onClick={() => openModuleEditor(rawScreenshotModule.id)}
                        className={`rounded-full px-3 py-1.5 text-xs ${selectedModule?.id === rawScreenshotModule.id && activeInspectorTab === 'content' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                      >
                        图片区
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setActiveInspectorTab('layout')}
                      className={`rounded-full px-3 py-1.5 text-xs ${activeInspectorTab === 'layout' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                    >
                      布局样式
                    </button>
                  </div>
                </div>

                {activeInspectorTab === 'content' ? (
                  <>
                    <PanelSection title="基础信息" hint="当前页最先会改的内容" defaultOpen>
                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {moduleQuickTabs.map((module) => (
                            <button key={module!.id} type="button" onClick={() => setSelectedModuleId(module!.id)} className={`rounded-full px-3 py-1.5 text-xs ${selectedModule?.id === module!.id ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 bg-black/20 text-slate-300'}`}>
                              {moduleTypeLabels[module!.type] || module!.type}
                            </button>
                          ))}
                        </div>
                        <input value={String(activeCard.document.modules.find((item) => item.type === 'badge_block')?.content || '')} onChange={(event) => {
                          const module = activeCard.document.modules.find((item) => item.type === 'badge_block');
                          if (module) {
                            void updateCurrentCardDocument(patchDocumentModule(activeCard.document, module.id, { content: event.target.value }));
                          }
                        }} className="h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white" placeholder="左上角角标，如 模板拼装" />
                        <input value={activeCard.title} onChange={(event) => {
                          const module = activeCard.document.modules.find((item) => item.type === 'title_block');
                          if (module) {
                            void updateCurrentCardDocument(patchDocumentModule(activeCard.document, module.id, { content: clampCompactChars(event.target.value, titleRules.singleLineLimit || TEMPLATE_CONTENT_LIMITS.title) }));
                          }
                        }} className="h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white" placeholder="页面标题" />
                        <textarea value={activeCard.summary} onChange={(event) => {
                          const module = activeCard.document.modules.find((item) => item.type === 'subtitle_block');
                          if (module) {
                            void updateCurrentCardDocument(patchDocumentModule(activeCard.document, module.id, { content: clampCompactChars(event.target.value, subtitleRules.descriptionLimit || TEMPLATE_CONTENT_LIMITS.subtitle) }));
                          }
                        }} className="min-h-[78px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="页面副标题" />
                        {(titleCharCount > TEMPLATE_CONTENT_LIMITS.title + 10 || subtitleCharCount > TEMPLATE_CONTENT_LIMITS.subtitle + 12) ? (
                          <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-6 text-amber-100/85">
                            标题或副标题偏长，系统会优先保住大字封面的视觉重心；必要时会自动截短展示。封面标题建议控制在 {TEMPLATE_CONTENT_LIMITS.title + 10} 字内，副标题建议控制在 {TEMPLATE_CONTENT_LIMITS.subtitle + 12} 字内。
                          </div>
                        ) : null}
                      </div>
                    </PanelSection>

                    {isTextCoverPage ? (
                      <>
                        <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.06] px-4 py-3 text-sm text-emerald-50/85">
                          这页是纯文字封面，版式切换请去上方 `布局样式`，当前这里专注改可见文案。
                        </div>
                        <PanelSection title="封面文案" hint="纯文字封面的可见元素都在这里改" defaultOpen>
                          <div className="space-y-3">
                            <input value={styleSlots.brandText || ''} onChange={(event) => void updateCurrentDocumentMeta({ styleSlots: { ...styleSlots, brandText: event.target.value } })} className="h-11 w-full rounded-xl border border-white/10 bg-[#11151d] px-3 text-sm text-white" placeholder="左上品牌词" />
                            <input value={styleSlots.topRightText || ''} onChange={(event) => void updateCurrentDocumentMeta({ styleSlots: { ...styleSlots, topRightText: event.target.value } })} className="h-11 w-full rounded-xl border border-white/10 bg-[#11151d] px-3 text-sm text-white" placeholder="右上提示词" />
                            <input value={styleSlots.stickerText || ''} onChange={(event) => void updateCurrentDocumentMeta({ styleSlots: { ...styleSlots, stickerText: clampCompactChars(event.target.value, TEMPLATE_CONTENT_LIMITS.coverSticker) } })} className="h-11 w-full rounded-xl border border-white/10 bg-[#11151d] px-3 text-sm text-white" placeholder="中间胶囊标签" />
                            <input value={styleSlots.bottomHeadline || ''} onChange={(event) => void updateCurrentDocumentMeta({ styleSlots: { ...styleSlots, bottomHeadline: clampCompactChars(event.target.value, TEMPLATE_CONTENT_LIMITS.coverBottomHeadline) } })} className="h-11 w-full rounded-xl border border-white/10 bg-[#11151d] px-3 text-sm text-white" placeholder="底部大字（默认会放大显示）" />
                            {textCoverDensityHint ? (
                              <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-6 text-amber-100/85">
                                {textCoverDensityHint}
                              </div>
                            ) : null}
                          </div>
                        </PanelSection>
                      </>
                    ) : (
                      <PanelSection title="正文内容" hint="当前只改本页内容" defaultOpen>
                        {selectedModule && ['bullet_group', 'feature_grid', 'step_group'].includes(selectedModule.type) ? (
                          <div className="space-y-3">
                            <div className="flex gap-2">
                              <button type="button" onClick={() => void addContentItem()} disabled={!canAddContentItem} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50">新增文案项</button>
                              <button type="button" onClick={() => void removeContentItem()} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5 disabled:opacity-50" disabled={!Array.isArray(selectedModule.content) || selectedModule.content.length === 0}>删除最后一项</button>
                            </div>
                            <textarea value={contentEditorText} onChange={(event) => setContentEditorText(sanitizeContentEditorText(String(activeCard.templateKind), selectedModule.type, event.target.value))} onBlur={() => { void commitContentEditorText(); }} className="min-h-[160px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="这里就是白色内容区。每行一个要点，卡片内容可用 title | description" />
                            <div className="text-[11px] leading-5 text-slate-500">
                              当前最多 {maxContentItems} 个组件；组件少会自动放大，组件多才会回到更紧凑的尺寸。
                            </div>
                            {supportsBodyTextModule(activeCard.templateKind) ? (
                              <div className="flex gap-2">
                                <button type="button" onClick={() => void ensureBodyTextModule()} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5">
                                  {bodyTextModule ? '编辑自由文案框' : '新增自由文案框'}
                                </button>
                                {bodyTextModule ? (
                                  <button type="button" onClick={() => void removeBodyTextModule()} className="rounded-xl border border-rose-400/20 px-3 py-2 text-sm text-rose-200 hover:bg-rose-400/10">
                                    删除自由文案框
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                            {contentDensityHint ? (
                              <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs leading-6 text-amber-100/85">
                                {contentDensityHint}
                              </div>
                            ) : null}
                          </div>
                        ) : selectedModule?.type === 'body_text_block' ? (
                          <div className="space-y-3">
                            <div className="flex gap-2">
                              <button type="button" onClick={() => void removeBodyTextModule()} className="rounded-xl border border-rose-400/20 px-3 py-2 text-sm text-rose-200 hover:bg-rose-400/10">删除自由文案框</button>
                            </div>
                            <textarea value={contentEditorText} onChange={(event) => setContentEditorText(clampCompactChars(event.target.value, contentInputRules.bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit))} onBlur={() => { void commitContentEditorText(); }} className="min-h-[160px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="这里可以补一段自由说明、总结、注意事项或结尾引导" />
                            <div className="text-[11px] leading-5 text-slate-500">
                              当前自由文案上限 {contentInputRules.bodyTextLimit || TEMPLATE_CONTENT_LIMITS.bodyTextBenefit} 个紧凑字符；有内容时会自动占用下方留白区。
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <div className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-sm text-slate-400">先点上方“内容区”标签，再在这里编辑文案。</div>
                            {supportsBodyTextModule(activeCard.templateKind) ? (
                              <button type="button" onClick={() => void ensureBodyTextModule()} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5">
                                {bodyTextModule ? '编辑自由文案框' : '新增自由文案框'}
                              </button>
                            ) : null}
                          </div>
                        )}
                      </PanelSection>
                    )}

                    {isFreeformStage ? (
                      <PanelSection title="自由模块" hint="决定这页现在要不要显示文字区和图片区">
                        <div className="grid grid-cols-2 gap-2">
                          {(currentContentModule || rawContentModule) ? (
                            <button
                              type="button"
                              onClick={() => void setModuleVisibility((currentContentModule || rawContentModule)!.type, (currentContentModule || rawContentModule)!.visible === false)}
                              className={`rounded-xl border px-3 py-2 text-sm transition ${(currentContentModule || rawContentModule)!.visible !== false ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100' : 'border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                            >
                              {(currentContentModule || rawContentModule)!.visible !== false ? '隐藏文字区' : '显示文字区'}
                            </button>
                          ) : null}
                          {rawScreenshotModule ? (
                            <button
                              type="button"
                              onClick={() => void setModuleVisibility('screenshot_frame', rawScreenshotModule.visible === false)}
                              className={`rounded-xl border px-3 py-2 text-sm transition ${rawScreenshotModule.visible !== false ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-100' : 'border-white/10 bg-black/20 text-slate-300 hover:bg-white/5'}`}
                            >
                              {rawScreenshotModule.visible !== false ? '隐藏图片区' : '显示图片区'}
                            </button>
                          ) : null}
                        </div>
                        <div className="mt-3 text-xs leading-6 text-slate-500">
                          自由展示页不再强制你同时用文字和图片。先打开需要的区域，再拖到合适位置就行。
                        </div>
                      </PanelSection>
                    ) : null}

                    {supportsCurrentImageRegion ? (
                      <>
                        <PanelSection title="图片编辑" hint="插图、放大、裁切都在这里" defaultOpen>
                          {selectedModule?.type === 'screenshot_frame' ? (
                            <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
                              {activeCard.templateKind === 'before_after' ? (
                                <div className="flex gap-2">
                                  <button type="button" onClick={() => setBeforeAfterTarget('before')} className={`rounded-xl px-3 py-2 text-sm ${beforeAfterTarget === 'before' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 text-white hover:bg-white/5'}`}>当前插入到“之前”</button>
                                  <button type="button" onClick={() => setBeforeAfterTarget('after')} className={`rounded-xl px-3 py-2 text-sm ${beforeAfterTarget === 'after' ? 'bg-emerald-300 text-slate-950' : 'border border-white/10 text-white hover:bg-white/5'}`}>当前插入到“之后”</button>
                                </div>
                              ) : null}
                              <div className="flex gap-2">
                                <button type="button" onClick={() => setSelectedModuleId(rawScreenshotModule?.id || selectedModuleId)} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5">去下方点选素材</button>
                                <button type="button" onClick={() => void clearCurrentImages()} className="rounded-xl border border-rose-400/20 px-3 py-2 text-sm text-rose-200 hover:bg-rose-400/10 disabled:opacity-50" disabled={!activeCard.document.assets.length}>删除已插入图片</button>
                              </div>
                              {!activeScreenshot ? (
                                <div className="rounded-xl border border-dashed border-white/10 px-3 py-6 text-center text-sm text-slate-400">还没有插入图片。先点击下方“截图素材”，图片会进入当前页白色图片区。</div>
                              ) : (
                                <>
                                  <div className="text-sm text-slate-300">当前选中的是图片区，可以直接裁切和放大</div>
                                  <label className="block text-xs text-slate-400">
                                    放大 {activeScreenshot.crop?.zoom || 1}
                                    <input type="range" min="1" max="2.5" step="0.05" value={activeScreenshot.crop?.zoom || 1} onChange={(event) => {
                                      void updateCurrentCardDocument(patchDocumentAssets(activeCard.document, activeCard.document.assets.map((asset, index) => index === 0 ? { ...asset, crop: { x: asset.crop?.x ?? 50, y: asset.crop?.y ?? 50, zoom: Number(event.target.value), fitMode: asset.crop?.fitMode || 'cover' } } : asset)));
                                    }} className="mt-2 w-full" />
                                  </label>
                                  <label className="block text-xs text-slate-400">
                                    水平位置 {activeScreenshot.crop?.x ?? 50}
                                    <input type="range" min="0" max="100" step="1" value={activeScreenshot.crop?.x ?? 50} onChange={(event) => {
                                      void updateCurrentCardDocument(patchDocumentAssets(activeCard.document, activeCard.document.assets.map((asset, index) => index === 0 ? { ...asset, crop: { x: Number(event.target.value), y: asset.crop?.y ?? 50, zoom: asset.crop?.zoom ?? 1, fitMode: asset.crop?.fitMode || 'cover' } } : asset)));
                                    }} className="mt-2 w-full" />
                                  </label>
                                  <label className="block text-xs text-slate-400">
                                    垂直位置 {activeScreenshot.crop?.y ?? 50}
                                    <input type="range" min="0" max="100" step="1" value={activeScreenshot.crop?.y ?? 50} onChange={(event) => {
                                      void updateCurrentCardDocument(patchDocumentAssets(activeCard.document, activeCard.document.assets.map((asset, index) => index === 0 ? { ...asset, crop: { x: asset.crop?.x ?? 50, y: Number(event.target.value), zoom: asset.crop?.zoom ?? 1, fitMode: asset.crop?.fitMode || 'cover' } } : asset)));
                                    }} className="mt-2 w-full" />
                                  </label>
                                  <select value={activeScreenshot.crop?.fitMode || 'cover'} onChange={(event) => {
                                    void updateCurrentCardDocument(patchDocumentAssets(activeCard.document, activeCard.document.assets.map((asset, index) => index === 0 ? { ...asset, crop: { x: asset.crop?.x ?? 50, y: asset.crop?.y ?? 50, zoom: asset.crop?.zoom ?? 1, fitMode: event.target.value as 'cover' | 'contain' } } : asset)));
                                  }} className="h-11 w-full rounded-xl border border-white/10 bg-[#11151d] px-3 text-sm text-white">
                                    <option value="cover">铺满裁切</option>
                                    <option value="contain">完整显示</option>
                                  </select>
                                </>
                              )}
                            </div>
                          ) : (
                            <div className="rounded-xl border border-dashed border-white/10 px-3 py-5 text-sm text-slate-400">先点上方“图片区”快捷按钮，再在这里裁切、替换或删除图片。</div>
                          )}
                        </PanelSection>

                        <PanelSection title="素材选择" hint="点一下就插入到当前选中的图片区" defaultOpen>
                          <div className="grid grid-cols-2 gap-2">
                            {referenceAssets.map((asset) => (
                              <button key={asset.id} type="button" onClick={() => {
                                if (rawScreenshotModule) {
                                  setSelectedModuleId(rawScreenshotModule.id);
                                }
                                void insertReferenceAssetToCard(asset);
                              }} className="overflow-hidden rounded-xl border border-white/10 bg-black/20">
                                <img src={asset.url} alt={asset.original_name} className="aspect-square w-full object-cover" />
                                <div className="truncate px-2 py-1 text-[11px] text-slate-300">{asset.original_name}</div>
                              </button>
                            ))}
                          </div>
                        </PanelSection>
                      </>
                    ) : null}
                  </>
                ) : null}

                {activeInspectorTab === 'layout' ? (
                  <>
                    <PanelSection title="页面结构" hint="决定这页用什么信息结构" defaultOpen>
                      <div className="grid grid-cols-1 gap-2">
                        {pageTemplateOptions.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              void updateCard(activeCard.cardId, (card) => ({
                                ...card,
                                templateKind: option.value,
                                document: buildCardDocumentWithKind(card, option.value),
                              }));
                            }}
                            className={`rounded-2xl border px-3 py-3 text-left transition ${activeCard.templateKind === option.value ? 'border-emerald-300/50 bg-emerald-300/10' : 'border-white/10 bg-black/20 hover:bg-white/5'}`}
                          >
                            <div className="text-sm font-semibold text-white">{option.label}</div>
                            <div className="mt-1 text-xs text-slate-400">{option.description}</div>
                          </button>
                        ))}
                      </div>
                    </PanelSection>

                    {styleOptions.length > 0 ? (
                      <PanelSection title="页面样式" hint="同一结构下切不同排版样式" defaultOpen>
                        <div className="grid grid-cols-1 gap-2">
                          {styleOptions.map((option) => (
                            <button key={option.value} type="button" onClick={() => {
                              void updateCurrentCardDocument(applyDocumentStyleVariant(activeCard.document, option.value, {
                                cardType: activeCard.cardType,
                              }));
                            }} className={`overflow-hidden rounded-2xl border text-left transition ${activeStyleVariant === option.value ? 'border-emerald-300/50 bg-emerald-300/10' : 'border-white/10 bg-black/20 hover:bg-white/5'}`}>
                              <div className="p-2">{renderStylePreview(option.preview)}</div>
                              <div className="px-3 pb-3">
                                <div className="text-sm font-semibold text-white">{option.label}</div>
                                <div className="mt-1 text-xs text-slate-400">{option.description}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </PanelSection>
                    ) : null}

                    {frameOptions.length > 0 ? (
                      <PanelSection title="外框样式" hint="只改结构外观，不影响这页文案内容" defaultOpen>
                        <div className="grid grid-cols-1 gap-2">
                          {frameOptions.map((option) => (
                            <button key={option.value} type="button" onClick={() => {
                              void updateCurrentCardDocument({
                                ...activeCard.document,
                                frameStyle: option.value,
                              });
                            }} className={`overflow-hidden rounded-2xl border text-left transition ${activeFrameStyle === option.value ? 'border-emerald-300/50 bg-emerald-300/10' : 'border-white/10 bg-black/20 hover:bg-white/5'}`}>
                              <div className="p-2">{renderFramePreview(option.preview)}</div>
                              <div className="px-3 pb-3">
                                <div className="text-sm font-semibold text-white">{option.label}</div>
                                <div className="mt-1 text-xs text-slate-400">{option.description}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </PanelSection>
                    ) : null}

                    <PanelSection title="页面操作" hint="复制、插入、删除这一页">
                      <div className="grid grid-cols-2 gap-2">
                        <button onClick={() => void duplicateCurrentCard()} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5">复制当前页</button>
                        <button onClick={() => void insertNewCard()} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5">插入新页</button>
                        <button onClick={() => {
                          const recommendedKind = templateKindByCardType[activeCard.cardType] || 'feature_hero';
                          void updateCard(activeCard.cardId, (card) => ({
                            ...card,
                            templateKind: recommendedKind,
                            document: buildCardDocumentWithKind(card, recommendedKind),
                          }));
                        }} className="rounded-xl border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/5">一键重排</button>
                        <button onClick={() => void deleteCurrentCard()} className="rounded-xl border border-rose-400/20 px-3 py-2 text-sm text-rose-200 hover:bg-rose-400/10 disabled:opacity-50" disabled={workingProject.cards.length <= 3}>删除当前页</button>
                      </div>
                    </PanelSection>
                  </>
                ) : null}

                {activeInspectorTab === 'project' ? (
                  <PanelSection title="项目级统一设置" hint="影响整组卡片" defaultOpen>
                    <div className="space-y-3">
                      <input value={activeCard.document.theme} onChange={(event) => void updateGlobalMeta('theme', event.target.value)} className="h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white" placeholder="主题，例如 warm/cool/forest/graphite" />
                      <input value={String(activeCard.document.modules.find((item) => item.type === 'cta_badge')?.content || '')} onChange={(event) => void updateGlobalMeta('ctaText', event.target.value)} className="h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white" placeholder="统一 CTA" />
                      <textarea value={String(activeCard.document.modules.find((item) => item.type === 'footer_note')?.content || '')} onChange={(event) => void updateGlobalMeta('footerNote', clampCompactChars(event.target.value, footerRules.descriptionLimit || TEMPLATE_CONTENT_LIMITS.footer))} className="min-h-[72px] w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white" placeholder="统一页脚" />
                    </div>
                  </PanelSection>
                ) : null}
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TemplateComposeSeriesEditorOverlay;
