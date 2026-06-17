import React, { useEffect, useMemo, useRef, useState } from 'react';
import { TemplateComposeDocument, TemplateComposeModule, TemplateModuleLayout, TemplateScreenshot } from '../types';
import { getDefaultStyleSlots, getModuleOffsetBounds, isWhitePanelFreeLayoutModule, normalizeModuleLayout, resolveTemplateFrameStyle, resolveTemplateStyleVariant } from '../lib/templateComposer';
import { getFrameTemplateProfile, TEXT_COVER_PROFILE } from '../lib/templateFixedProfiles';
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
} from '../lib/templatePreviewLayout';

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
const getFrameAppearance = (
  theme: Record<string, string>,
  frameStyle?: string
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

const getTextCoverAppearance = (frameStyle?: string) => {
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

interface TemplateComposeCanvasPreviewProps {
  document: TemplateComposeDocument;
  renderMode?: 'responsive' | 'canvas';
  presentation?: 'default' | 'embedded';
  selectedModuleId?: string | null;
  onModuleSelect?: (moduleId: string) => void;
  onModuleLayoutChange?: (moduleId: string, nextLayout: Partial<TemplateModuleLayout>) => void;
}

const DEFAULT_BADGE_TEXT = '模板拼装';
const supportsImageRegion = (
  templateKind: TemplateComposeDocument['templateKind'],
  styleVariant?: string
) => (
  templateKind === 'benefit_grid'
  || templateKind === 'before_after'
  || (templateKind === 'feature_hero' && styleVariant !== 'text_cover_bold')
  || templateKind === 'step_guide'
);

const normalizeCrop = (shot?: TemplateScreenshot) => ({
  x: typeof shot?.crop?.x === 'number' ? shot.crop.x : 50,
  y: typeof shot?.crop?.y === 'number' ? shot.crop.y : 50,
  zoom: typeof shot?.crop?.zoom === 'number' ? shot.crop.zoom : 1,
  fitMode: shot?.crop?.fitMode === 'contain' ? 'contain' as const : 'cover' as const,
});

const imageFrame = (
  shot?: TemplateScreenshot,
  className?: string,
  background = '#E5E7EB',
  radiusClass = 'rounded-[24px]',
  emptyLabel = '选择截图后显示'
) => {
  const crop = normalizeCrop(shot);
  return (
    <div
      className={`relative overflow-hidden ${radiusClass} ${className || ''}`.trim()}
      style={{ background }}
    >
      {shot?.url ? (
        <img
          src={shot.url}
          alt={shot.label || '截图'}
          className="absolute inset-0 h-full w-full max-w-none"
          style={{
            objectFit: crop.fitMode,
            objectPosition: `${crop.x}% ${crop.y}%`,
            transform: `scale(${crop.zoom})`,
            transformOrigin: `${crop.x}% ${crop.y}%`,
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300 text-[12px] font-medium text-slate-500">
          {emptyLabel}
        </div>
      )}
    </div>
  );
};

const buildFreeLayoutBoxStyle = (layout: TemplateModuleLayout) => ({
  left: `${(layout.x || 0) * 100}%`,
  top: `${(layout.y || 0) * 100}%`,
  width: `${(layout.width || 0) * 100}%`,
  height: `${(layout.height || 0) * 100}%`,
});

const getFreeLayoutZIndex = (
  moduleId: string | undefined,
  selectedModuleId?: string | null,
  base = 1
) => (moduleId && selectedModuleId === moduleId ? 30 : base);

const buildModuleTranslate = (
  renderedSize: { width: number; height: number },
  canvas: { width: number; height: number },
  templateKind: TemplateComposeDocument['templateKind'],
  styleVariant: TemplateComposeDocument['styleVariant'],
  module: TemplateComposeModule | undefined
) => {
  const normalized = normalizeModuleLayout(module?.layout, templateKind, module?.type || 'bullet_group', { styleVariant });
  const scaleX = renderedSize.width / canvas.width || 1;
  const scaleY = renderedSize.height / canvas.height || 1;
  return `translate(${(normalized.offsetX || 0) * canvas.width * scaleX}px, ${(normalized.offsetY || 0) * canvas.height * scaleY}px)`;
};

const clampStyle = (lines: number): React.CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden',
});

const bodyTextPanelStyle = (theme: Record<string, string>): React.CSSProperties => ({
  background: theme.panel,
  border: '1px solid rgba(15,23,42,0.06)',
  boxShadow: '0 18px 36px rgba(15,23,42,0.06)',
});

const TemplateComposeCanvasPreview: React.FC<TemplateComposeCanvasPreviewProps> = ({
  document,
  renderMode = 'responsive',
  presentation = 'default',
  selectedModuleId,
  onModuleSelect,
  onModuleLayoutChange,
}) => {
  const theme = THEMES[document.theme] || THEMES.warm;
  const styleVariant = resolveTemplateStyleVariant(document.templateKind, document.styleVariant);
  const canvasPadding = getTemplateCanvasPadding(styleVariant);
  const frameStyle = resolveTemplateFrameStyle(document.templateKind, document.frameStyle);
  const frameAppearance = getFrameAppearance(theme, frameStyle);
  const textCoverAppearance = getTextCoverAppearance(frameStyle);
  const usesEditorialShell = frameStyle === 'editorial_outline_card' && styleVariant !== 'text_cover_bold';
  const usesSunsetShell = frameStyle === 'sunset_glow_card' && styleVariant !== 'text_cover_bold';
  const usesNotebookShell = frameStyle === 'notebook_tape_card' && styleVariant !== 'text_cover_bold';
  const usesSplitShell = frameStyle === 'split_banner_card' && styleVariant !== 'text_cover_bold';
  const usesSoftShell = !usesSunsetShell && !usesEditorialShell && !usesNotebookShell && !usesSplitShell && styleVariant !== 'text_cover_bold';
  const styleSlots = {
    ...getDefaultStyleSlots(styleVariant),
    ...(document.meta?.styleSlots || {}),
  };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentAreaRef = useRef<HTMLDivElement | null>(null);
  const [renderedSize, setRenderedSize] = useState({ width: document.canvas.width, height: document.canvas.height });
  const dragStateRef = useRef<{
    moduleId: string;
    moduleType: TemplateComposeModule['type'];
    mode: 'move' | 'resize';
    handle?: 'e' | 's' | 'se';
    startClientX: number;
    startClientY: number;
    startOffsetX: number;
    startOffsetY: number;
    startLayout?: TemplateModuleLayout;
  } | null>(null);
  const badgeModule = document.modules.find((module) => module.type === 'badge_block');
  const bulletGroupModule = document.modules.find((module) => module.type === 'bullet_group' && module.visible !== false);
  const screenshotModule = document.modules.find((module) => module.type === 'screenshot_frame' && module.visible !== false);
  const badgeText = String(badgeModule?.content || DEFAULT_BADGE_TEXT);
  const title = String(document.modules.find((module) => module.type === 'title_block')?.content || document.meta?.title || '');
  const subtitle = String(document.modules.find((module) => module.type === 'subtitle_block')?.content || document.meta?.subtitle || '');
  const contentModule = document.modules.find((module) =>
    ['bullet_group', 'feature_grid', 'step_group', 'comparison_group'].includes(module.type)
    && module.visible !== false
  );
  const bodyTextModule = document.modules.find((module) => module.type === 'body_text_block' && module.visible !== false);
  const footerNote = String(document.modules.find((module) => module.type === 'footer_note')?.content || document.meta?.footerNote || '');
  const ctaText = String(document.modules.find((module) => module.type === 'cta_badge')?.content || document.meta?.ctaText || '');
  const displayHeaderTitle = truncateTemplateText(title, TEMPLATE_CONTENT_LIMITS.title + 12);
  const displayHeaderSubtitle = truncateTemplateText(subtitle || '', TEMPLATE_CONTENT_LIMITS.subtitle + 12);
  const displayTextCover = getTextCoverDisplayContent(title, subtitle || '全流程', styleSlots.bottomHeadline || '');
  const textCoverScale = getTextCoverScaleProfile(displayTextCover.title, displayTextCover.subtitle || '全流程', displayTextCover.bottomHeadline || '');
  const textCoverSpacing = getTextCoverSpacingProfile(displayTextCover.title, displayTextCover.subtitle || '全流程', displayTextCover.bottomHeadline || '');
  const showTextCoverSticker = shouldShowTextCoverSticker(displayTextCover.title, displayTextCover.subtitle || '全流程', styleSlots.stickerText);
  const standardHeaderScale = getStandardHeaderScale(document.templateKind, styleVariant, title, subtitle, frameStyle);
  const benefitProfile = getStructuredContentDisplayProfile('benefit_grid', Array.isArray(contentModule?.content) ? contentModule.content : []);
  const faqProfile = getStructuredContentDisplayProfile('faq_card', Array.isArray(contentModule?.content) ? contentModule.content : []);
  const stepProfile = getStructuredContentDisplayProfile('step_guide', Array.isArray(contentModule?.content) ? contentModule.content : []);
  const contentItemCount = document.templateKind === 'benefit_grid'
    ? benefitProfile.count
    : document.templateKind === 'faq_card'
      ? faqProfile.count
      : document.templateKind === 'step_guide'
        ? stepProfile.count
        : document.templateKind === 'feature_hero' && Array.isArray(contentModule?.content)
          ? Math.min(4, Math.max(1, contentModule.content.length || 1))
          : 2;
  const contentScale = getTemplateContentScale(document.templateKind, contentItemCount, styleVariant);
  const frameTemplateProfile = getFrameTemplateProfile(frameStyle);
  const screenshots = document.assets || [];
  const screenshot = screenshots[0];
  const secondScreenshot = screenshots[1] || screenshots[0];
  const bodyText = truncateTemplateText(String(bodyTextModule?.content || document.meta?.bodyText || ''), document.templateKind === 'benefit_grid'
    ? TEMPLATE_CONTENT_LIMITS.bodyTextBenefit
    : document.templateKind === 'step_guide'
      ? TEMPLATE_CONTENT_LIMITS.bodyTextStep
      : TEMPLATE_CONTENT_LIMITS.bodyTextFaq);
  const interactiveModuleTypes = useMemo(() => new Set<TemplateComposeModule['type']>(['bullet_group', 'screenshot_frame']), []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setRenderedSize({
        width: rect.width || document.canvas.width,
        height: rect.height || document.canvas.height,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [document.canvas.height, document.canvas.width, renderMode]);

  useEffect(() => {
    if (!onModuleLayoutChange) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      const container = containerRef.current;
      if (!dragState || !container) {
        return;
      }

      if (isWhitePanelFreeLayoutModule(document.templateKind, dragState.moduleType, styleVariant) && dragState.startLayout) {
        const contentRect = contentAreaRef.current?.getBoundingClientRect();
        if (!contentRect) {
          return;
        }

        const deltaX = (event.clientX - dragState.startClientX) / contentRect.width;
        const deltaY = (event.clientY - dragState.startClientY) / contentRect.height;
        const nextLayout: Partial<TemplateModuleLayout> = {};

        if (dragState.mode === 'move') {
          nextLayout.x = (dragState.startLayout.x || 0) + deltaX;
          nextLayout.y = (dragState.startLayout.y || 0) + deltaY;
        } else if (dragState.handle === 'e') {
          nextLayout.width = (dragState.startLayout.width || 0) + deltaX;
        } else if (dragState.handle === 's') {
          nextLayout.height = (dragState.startLayout.height || 0) + deltaY;
        } else {
          nextLayout.width = (dragState.startLayout.width || 0) + deltaX;
          nextLayout.height = (dragState.startLayout.height || 0) + deltaY;
        }

        onModuleLayoutChange(dragState.moduleId, nextLayout);
        return;
      }

      const bounds = getModuleOffsetBounds(document.templateKind, dragState.moduleType, styleVariant);
      const rect = container.getBoundingClientRect();
      const scaleX = rect.width / document.canvas.width || 1;
      const scaleY = rect.height / document.canvas.height || 1;
      const deltaX = (event.clientX - dragState.startClientX) / (document.canvas.width * scaleX);
      const deltaY = (event.clientY - dragState.startClientY) / (document.canvas.height * scaleY);
      const nextOffsetX = Math.max(-bounds.x, Math.min(bounds.x, dragState.startOffsetX + deltaX));
      const nextOffsetY = Math.max(-bounds.y, Math.min(bounds.y, dragState.startOffsetY + deltaY));
      onModuleLayoutChange(dragState.moduleId, {
        offsetX: nextOffsetX,
        offsetY: nextOffsetY,
      });
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [document.canvas.height, document.canvas.width, document.templateKind, onModuleLayoutChange, styleVariant]);

  const beginDrag = (event: React.PointerEvent, module: TemplateComposeModule | undefined) => {
    if (!module || !interactiveModuleTypes.has(module.type) || !onModuleLayoutChange) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const normalizedLayout = normalizeModuleLayout(module.layout, document.templateKind, module.type, { styleVariant });
    dragStateRef.current = {
      moduleId: module.id,
      moduleType: module.type,
      mode: 'move',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: normalizedLayout.offsetX || 0,
      startOffsetY: normalizedLayout.offsetY || 0,
      startLayout: normalizedLayout,
    };
    onModuleSelect?.(module.id);
  };

  const beginResize = (
    event: React.PointerEvent,
    module: TemplateComposeModule | undefined,
    handle: 'e' | 's' | 'se'
  ) => {
    if (!module || !onModuleLayoutChange || !isWhitePanelFreeLayoutModule(document.templateKind, module.type, styleVariant)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const normalizedLayout = normalizeModuleLayout(module.layout, document.templateKind, module.type, { styleVariant });
    dragStateRef.current = {
      moduleId: module.id,
      moduleType: module.type,
      mode: 'resize',
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: normalizedLayout.offsetX || 0,
      startOffsetY: normalizedLayout.offsetY || 0,
      startLayout: normalizedLayout,
    };
    onModuleSelect?.(module.id);
  };

  const renderDraggableFrame = (
    module: TemplateComposeModule | undefined,
    content: React.ReactNode,
    className = ''
  ) => {
    if (!module || !interactiveModuleTypes.has(module.type)) {
      return <>{content}</>;
    }

    const isSelected = selectedModuleId === module.id;

    return (
      <div
        className={`relative ${className}`.trim()}
        onClick={(event) => {
          event.stopPropagation();
          onModuleSelect?.(module.id);
        }}
        onPointerDown={(event) => beginDrag(event, module)}
        style={{
          transform: buildModuleTranslate(renderedSize, document.canvas, document.templateKind, styleVariant, module),
          touchAction: 'none',
          cursor: onModuleLayoutChange ? 'grab' : 'default',
        }}
      >
        {content}
        {selectedModuleId === module.id && onModuleLayoutChange ? (
          <div className="pointer-events-none absolute inset-0 rounded-[28px] border-2 border-dashed border-xhs-red/80 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]" />
        ) : null}
      </div>
    );
  };

  const renderFreeLayoutHandles = (module: TemplateComposeModule | undefined) => {
    if (!module || selectedModuleId !== module.id || !onModuleLayoutChange || !isWhitePanelFreeLayoutModule(document.templateKind, module.type, styleVariant)) {
      return null;
    }

    return (
      <>
        <button
          type="button"
          onPointerDown={(event) => beginResize(event, module, 'e')}
          className="absolute -right-2 top-1/2 h-10 w-4 -translate-y-1/2 rounded-full border border-white/80 bg-xhs-red shadow-lg"
        />
        <button
          type="button"
          onPointerDown={(event) => beginResize(event, module, 's')}
          className="absolute bottom-[-8px] left-1/2 h-4 w-10 -translate-x-1/2 rounded-full border border-white/80 bg-xhs-red shadow-lg"
        />
        <button
          type="button"
          onPointerDown={(event) => beginResize(event, module, 'se')}
          className="absolute -bottom-2 -right-2 h-6 w-6 rounded-full border border-white/80 bg-xhs-red shadow-lg"
        />
      </>
    );
  };

  const renderFeatureHeroFreeLayout = () => {
    const bullets = Array.isArray(contentModule?.content) ? contentModule?.content : [];
    const bulletLayout = normalizeModuleLayout(bulletGroupModule?.layout, document.templateKind, 'bullet_group', { styleVariant });
    const screenshotLayout = normalizeModuleLayout(screenshotModule?.layout, document.templateKind, 'screenshot_frame', { styleVariant });
    const hasBulletContent = bullets.length > 0;
    const hasScreenshot = Boolean(screenshot?.url);

    return (
      <div ref={contentAreaRef} className="relative h-full min-h-0 flex-1">
        {bulletGroupModule ? (
          <div
            className="absolute"
            style={buildFreeLayoutBoxStyle(bulletLayout)}
            onClick={(event) => {
              event.stopPropagation();
              onModuleSelect?.(bulletGroupModule.id);
            }}
            onPointerDown={(event) => beginDrag(event, bulletGroupModule)}
          >
            <div
              className="relative h-full w-full overflow-hidden rounded-[28px]"
              style={{ zIndex: getFreeLayoutZIndex(bulletGroupModule.id, selectedModuleId, 14) }}
            >
              <div className="flex h-full flex-col gap-4 overflow-hidden px-2 py-2">
                {hasBulletContent ? bullets.slice(0, 4).map((item: string, index: number) => (
                  <div key={`${item}-${index}`} className="flex items-start gap-3">
                    <div className="mt-[6px] h-[10px] w-[10px] rounded-full shrink-0" style={{ background: theme.accent }} />
                    <div className="font-semibold leading-[1.56]" style={{ color: theme.text, fontSize: `${contentScale.bullet}px` }}>
                      {truncateTemplateText(item, TEMPLATE_CONTENT_LIMITS.bullet)}
                    </div>
                  </div>
                )) : (
                  <div className="flex h-full min-h-[120px] items-start">
                    <div className="rounded-[24px] border border-dashed border-slate-300/65 bg-white/14 px-4 py-3 font-semibold tracking-[0.08em] text-slate-500 backdrop-blur-[2px]" style={{ fontSize: `${contentScale.bulletPlaceholder}px` }}>
                      点击后添加内容区
                    </div>
                  </div>
                )}
              </div>
              {selectedModuleId === bulletGroupModule.id ? (
                <div className="pointer-events-none absolute inset-0 rounded-[28px] border-2 border-dashed border-xhs-red/80 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]" />
              ) : null}
              {renderFreeLayoutHandles(bulletGroupModule)}
            </div>
          </div>
        ) : null}

        {screenshotModule ? (
          <div
            className="absolute"
            style={{
              ...buildFreeLayoutBoxStyle(screenshotLayout),
              zIndex: getFreeLayoutZIndex(screenshotModule.id, selectedModuleId, hasBulletContent ? 8 : 12),
            }}
            onClick={(event) => {
              event.stopPropagation();
              onModuleSelect?.(screenshotModule.id);
            }}
            onPointerDown={(event) => beginDrag(event, screenshotModule)}
          >
            <div className="relative h-full w-full">
              {imageFrame(
                screenshot,
                `h-full w-full ${hasScreenshot ? '' : 'border border-dashed border-slate-300/65 bg-white/10 backdrop-blur-[2px]'}`.trim(),
                'transparent',
                '',
                hasScreenshot ? '选择截图后显示' : '点击后插入图片区'
              )}
              {selectedModuleId === screenshotModule.id ? (
                <div className="pointer-events-none absolute inset-0 border-2 border-dashed border-xhs-red/80 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]" />
              ) : null}
              {renderFreeLayoutHandles(screenshotModule)}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderTextCoverBold = () => (
    <div
      className="flex h-full flex-col justify-between px-1 py-1"
      style={{
        color: textCoverAppearance.ink,
        fontFamily: '"Arial Black","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
      }}
    >
      <div>
        <div
          className="flex items-start justify-between gap-4 font-black"
          style={{ color: textCoverAppearance.subInk, fontSize: `${textCoverScale.topMeta}px`, letterSpacing: '-0.03em' }}
        >
          <div>{styleSlots.brandText || badgeText}</div>
          <div>{styleSlots.topRightText || ''}</div>
        </div>
        <div
          className="whitespace-pre-line font-black"
          style={{
            color: textCoverAppearance.ink,
            marginTop: `${textCoverSpacing.titleMarginTop}px`,
            lineHeight: textCoverScale.titleLineHeight || TEXT_COVER_PROFILE.titleLineHeight,
            wordBreak: TEXT_COVER_PROFILE.wordBreak,
            overflowWrap: TEXT_COVER_PROFILE.overflowWrap,
            fontSize: `${textCoverScale.title}px`,
            letterSpacing: textCoverScale.titleTracking,
            maxWidth: TEXT_COVER_PROFILE.titleMaxWidth,
          }}
        >
          {displayTextCover.title}
        </div>
        <div className="mt-4" style={{ display: 'flex', flexDirection: 'column', gap: `${textCoverSpacing.dividerGap}px` }}>
          <div className="w-full" style={{ background: textCoverAppearance.accent, height: `${textCoverScale.divider}px` }} />
          <div className="w-full" style={{ background: textCoverAppearance.accent, height: `${textCoverScale.divider}px` }} />
        </div>
        <div className="flex items-start justify-between gap-4" style={{ marginTop: `${textCoverSpacing.subtitleMarginTop}px` }}>
          <div
            className="flex-1 whitespace-pre-line font-black"
            style={{
              color: textCoverAppearance.ink,
              lineHeight: textCoverScale.subtitleLineHeight || 1.08,
              wordBreak: TEXT_COVER_PROFILE.wordBreak,
              overflowWrap: TEXT_COVER_PROFILE.overflowWrap,
              fontSize: `${textCoverScale.subtitle}px`,
              letterSpacing: textCoverScale.subtitleTracking,
              maxWidth: showTextCoverSticker ? TEXT_COVER_PROFILE.subtitleMaxWidth : '100%',
            }}
          >
            {displayTextCover.subtitle || '全流程'}
          </div>
          {showTextCoverSticker ? (
            <div
              className="rounded-full border-[6px] font-black leading-none"
              style={{ borderColor: textCoverAppearance.border, color: textCoverAppearance.border, fontSize: `${textCoverScale.sticker}px`, padding: textCoverSpacing.stickerPadding }}
            >
              {styleSlots.stickerText || ''}
            </div>
          ) : null}
        </div>
        {footerNote ? (
          <div className="mt-6 font-bold" style={{ color: textCoverAppearance.subInk, opacity: 0.82, fontSize: `${textCoverScale.footer}px`, lineHeight: textCoverScale.footerLineHeight }}>
            {footerNote}
          </div>
        ) : null}
      </div>
      <div style={{ paddingTop: `${textCoverSpacing.bottomPaddingTop}px` }}>
        <div className="flex items-end justify-between gap-4">
          <div
            className="whitespace-pre-line font-black leading-[0.92]"
            style={{
              color: textCoverAppearance.accent,
              fontSize: `${textCoverScale.bottomHeadline}px`,
              letterSpacing: '-0.1em',
              maxWidth: TEXT_COVER_PROFILE.bottomHeadlineMaxWidth,
              paddingTop: `${textCoverSpacing.footerTopMargin}px`,
            }}
          >
            {displayTextCover.bottomHeadline || ''}
          </div>
          {ctaText ? (
            <div
              className="inline-flex items-center justify-center rounded-full font-extrabold text-white"
              style={{
                background: textCoverAppearance.ctaBg,
                boxShadow: '0 14px 30px rgba(15,23,42,0.12)',
                fontSize: `${textCoverScale.cta}px`,
                padding: textCoverScale.ctaPadding,
              }}
            >
              {ctaText}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  const renderContent = () => {
    if (document.templateKind === 'feature_hero' && styleVariant === 'text_cover_bold') {
      return renderTextCoverBold();
    }

    switch (document.templateKind) {
      case 'benefit_grid':
      {
        const items = Array.isArray(contentModule?.content) ? contentModule?.content : [];
        const visibleItems = items.slice(0, benefitProfile.maxItems);
        return (
          <div className="space-y-4">
            {screenshot && screenshotModule && renderDraggableFrame(
              screenshotModule,
              <div
                className="overflow-hidden rounded-[28px]"
                style={{
                  border: frameStyle === 'editorial_outline_card' ? '2px solid rgba(31,41,55,0.16)' : '1px solid rgba(15,23,42,0.05)',
                  background: frameAppearance.panelBackground,
                  boxShadow: frameAppearance.panelShadow,
                }}
              >
                <div className="flex items-center justify-between border-b border-black/6 px-5 py-3" style={{ background: theme.panelSoft }}>
                  <div className="font-black tracking-[0.08em]" style={{ color: theme.accent, fontSize: `${contentScale.panelEyebrow}px` }}>
                    {styleVariant === 'annotated_highlight_grid' ? '重点标注' : '亮点截图'}
                  </div>
                  <div className="font-semibold" style={{ color: theme.muted, fontSize: `${contentScale.panelHint}px` }}>
                    {styleVariant === 'annotated_highlight_grid' ? '结合说明看重点区域' : '聚焦核心卖点'}
                  </div>
                </div>
                <div className="p-4">
                  <div
                    className="relative overflow-hidden rounded-[22px] bg-[#E5E7EB]"
                    style={{ aspectRatio: '16 / 10' }}
                  >
                    {imageFrame(screenshot, 'h-full w-full rounded-[22px]')}
                    {styleVariant === 'annotated_highlight_grid' && visibleItems.slice(0, 2).map((item: any, index: number) => (
                      <div
                        key={`${item?.title || 'annotated'}-${index}`}
                        className={`absolute inline-flex items-center gap-2 rounded-full bg-white/95 px-3 py-2 font-extrabold shadow-[0_10px_24px_rgba(15,23,42,0.12)] ${index === 0 ? 'left-5 top-5' : 'bottom-5 right-5'}`}
                        style={{ color: theme.text, fontSize: `${contentScale.panelHint}px` }}
                      >
                        <span
                          className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-black text-white"
                          style={{ background: theme.accent }}
                        >
                          {index + 1}
                        </span>
                        {truncateTemplateText(item?.title || `重点 ${index + 1}`, TEMPLATE_CONTENT_LIMITS.annotation)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>,
              'rounded-[28px]'
            )}
            {benefitProfile.layout === 'stack' ? (
              <div className="flex justify-center">
                <div className="w-[72%] space-y-4">
                {visibleItems.map((item: any, index: number) => (
                  <div key={index} className="rounded-[24px] p-6" style={{ background: theme.panelSoft }}>
                    <div className="font-extrabold leading-[1.24]" style={{ color: theme.text, fontSize: `${contentScale.featureTitle}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.title || '', TEMPLATE_CONTENT_LIMITS.featureTitle)}
                    </div>
                    <div className="mt-3 leading-[1.62]" style={{ color: theme.muted, fontSize: `${contentScale.featureDescription}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.description || '', TEMPLATE_CONTENT_LIMITS.featureDescription)}
                    </div>
                  </div>
                ))}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {visibleItems.map((item: any, index: number) => (
                  <div key={index} className="rounded-[24px] p-5" style={{ background: theme.panelSoft }}>
                    <div className="font-extrabold leading-[1.24]" style={{ color: theme.text, fontSize: `${contentScale.featureTitle}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.title || '', TEMPLATE_CONTENT_LIMITS.featureTitle)}
                    </div>
                    <div className="mt-3 leading-[1.62]" style={{ color: theme.muted, fontSize: `${contentScale.featureDescription}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.description || '', TEMPLATE_CONTENT_LIMITS.featureDescription)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {bodyText ? (
              <div className="rounded-[24px] p-6" style={bodyTextPanelStyle(theme)}>
                <div className="whitespace-pre-line leading-[1.7]" style={{ color: theme.text, fontSize: `${Math.max(22, contentScale.featureDescription)}px` }}>
                  {bodyText}
                </div>
              </div>
            ) : null}
          </div>
        );
      }
      case 'faq_card': {
        const items = Array.isArray(contentModule?.content) ? contentModule?.content : [];
        return (
          faqProfile.layout === 'stack' ? (
            <div className={`space-y-4 ${faqProfile.count === 1 ? 'flex flex-col items-center' : ''}`}>
              {items.slice(0, faqProfile.maxItems).map((item: any, index: number) => (
                <div key={index} className={`rounded-[24px] p-6 ${faqProfile.count === 1 ? 'w-[72%]' : ''}`} style={{ background: theme.panelSoft }}>
                  <div className="inline-flex rounded-full px-3 py-1 font-black" style={{ background: theme.accentSoft, color: theme.accent, fontSize: `${contentScale.faqBadge}px` }}>
                    Q{index + 1}
                  </div>
                  <div className="mt-3 font-extrabold leading-[1.24]" style={{ color: theme.text, fontSize: `${contentScale.faqTitle}px`, ...clampStyle(2) }}>
                    {truncateTemplateText(item?.title || '', TEMPLATE_CONTENT_LIMITS.faqTitle)}
                  </div>
                  <div className="mt-3 leading-[1.62]" style={{ color: theme.muted, fontSize: `${contentScale.faqDescription}px`, ...clampStyle(2) }}>
                    {truncateTemplateText(item?.description || '', TEMPLATE_CONTENT_LIMITS.faqDescription)}
                  </div>
                </div>
              ))}
              {bodyText ? (
                <div className={`rounded-[24px] p-6 ${faqProfile.count === 1 ? 'w-[72%]' : ''}`} style={bodyTextPanelStyle(theme)}>
                  <div className="whitespace-pre-line leading-[1.7]" style={{ color: theme.text, fontSize: `${Math.max(22, contentScale.faqDescription)}px` }}>
                    {bodyText}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                {items.slice(0, faqProfile.maxItems).map((item: any, index: number) => (
                  <div key={index} className="rounded-[24px] p-6" style={{ background: theme.panelSoft }}>
                    <div className="inline-flex rounded-full px-3 py-1 font-black" style={{ background: theme.accentSoft, color: theme.accent, fontSize: `${contentScale.faqBadge}px` }}>
                      Q{index + 1}
                    </div>
                    <div className="mt-3 font-extrabold leading-[1.24]" style={{ color: theme.text, fontSize: `${contentScale.faqTitle}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.title || '', TEMPLATE_CONTENT_LIMITS.faqTitle)}
                    </div>
                    <div className="mt-3 leading-[1.62]" style={{ color: theme.muted, fontSize: `${contentScale.faqDescription}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.description || '', TEMPLATE_CONTENT_LIMITS.faqDescription)}
                    </div>
                  </div>
                ))}
              </div>
              {bodyText ? (
                <div className="rounded-[24px] p-6" style={bodyTextPanelStyle(theme)}>
                  <div className="whitespace-pre-line leading-[1.7]" style={{ color: theme.text, fontSize: `${Math.max(22, contentScale.faqDescription)}px` }}>
                    {bodyText}
                  </div>
                </div>
              ) : null}
            </div>
          )
        );
      }
      case 'step_guide': {
        const items = Array.isArray(contentModule?.content) ? contentModule?.content : [];
        const visibleItems = (styleVariant === 'step_focus_screenshot' ? items.slice(0, 3) : items).slice(0, stepProfile.maxItems);
        return (
          <div className="space-y-4">
            {screenshot && screenshotModule && renderDraggableFrame(
              screenshotModule,
              <div className="rounded-[28px] bg-white p-[14px] shadow-[0_20px_45px_rgba(15,23,42,0.08)]">
                {imageFrame(screenshot, `w-full rounded-[22px] ${styleVariant === 'step_focus_screenshot' ? 'aspect-[16/10]' : 'aspect-[16/10]'}`)}
              </div>,
              'rounded-[28px]'
            )}
            <div className="rounded-[28px] p-6 shadow-[0_20px_45px_rgba(15,23,42,0.08)]" style={{ background: theme.panel }}>
              {visibleItems.map((item: any, index: number) => (
                <div key={index} className={`flex gap-4 py-4 ${index > 0 ? 'border-t border-black/10' : ''}`}>
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-black"
                    style={{ background: theme.accentSoft, color: theme.accent, fontSize: `${contentScale.stepIndex}px` }}
                  >
                    {index + 1}
                  </div>
                  <div>
                    <div className="font-extrabold leading-[1.24]" style={{ color: theme.text, fontSize: `${contentScale.stepTitle}px` }}>步骤 {index + 1}</div>
                    <div className="mt-2 leading-[1.62]" style={{ color: theme.muted, fontSize: `${contentScale.stepDescription}px`, ...clampStyle(2) }}>
                      {truncateTemplateText(item?.description || item?.title || '', TEMPLATE_CONTENT_LIMITS.stepDescription)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {bodyText ? (
              <div className="rounded-[24px] p-6" style={bodyTextPanelStyle(theme)}>
                <div className="whitespace-pre-line leading-[1.7]" style={{ color: theme.text, fontSize: `${Math.max(22, contentScale.stepDescription)}px` }}>
                  {bodyText}
                </div>
              </div>
            ) : null}
          </div>
        );
      }
      case 'before_after':
        return renderDraggableFrame(
          screenshotModule,
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-[28px] p-4 shadow-[0_20px_45px_rgba(15,23,42,0.08)]" style={{ background: theme.panel }}>
              <div className="mb-3 font-extrabold" style={{ color: theme.text, fontSize: `${contentScale.comparisonLabel}px` }}>之前</div>
              {imageFrame(screenshot, 'h-[320px]')}
            </div>
            <div className="rounded-[28px] p-4 shadow-[0_20px_45px_rgba(15,23,42,0.08)]" style={{ background: theme.panel }}>
              <div className="mb-3 font-extrabold" style={{ color: theme.text, fontSize: `${contentScale.comparisonLabel}px` }}>之后</div>
              {imageFrame(secondScreenshot, 'h-[320px]')}
            </div>
          </div>,
          'rounded-[28px]'
        );
      default: {
        if (document.templateKind === 'feature_hero') {
          return renderFeatureHeroFreeLayout();
        }
        const bullets = Array.isArray(contentModule?.content) ? contentModule?.content : [];
        return (
          <div className={`grid gap-5 ${screenshot ? 'grid-cols-[1.1fr_0.9fr]' : 'grid-cols-1'} items-stretch`}>
            {renderDraggableFrame(
              bulletGroupModule,
              <div className="flex flex-col gap-4">
                {bullets.slice(0, 4).map((item: string, index: number) => (
                  <div key={`${item}-${index}`} className="flex items-start gap-3">
                    <div className="mt-[6px] h-[10px] w-[10px] rounded-full shrink-0" style={{ background: theme.accent }} />
                    <div className="font-semibold leading-[1.56]" style={{ color: theme.text, fontSize: `${contentScale.bullet}px` }}>
                      {truncateTemplateText(item, TEMPLATE_CONTENT_LIMITS.bullet)}
                    </div>
                  </div>
                ))}
              </div>,
              'rounded-[24px]'
            )}
            {screenshot && supportsImageRegion(document.templateKind, styleVariant) && (
              renderDraggableFrame(
                screenshotModule,
                <div className="rounded-[32px] p-[14px] shadow-[0_20px_45px_rgba(15,23,42,0.08)]" style={{ background: theme.panel }}>
                  {imageFrame(screenshot, 'h-full min-h-[220px]')}
                </div>,
                'rounded-[32px]'
              )
            )}
          </div>
        );
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={renderMode === 'canvas'
        ? `relative h-full w-full overflow-hidden rounded-[32px] ${presentation === 'embedded' ? '' : 'shadow-2xl shadow-black/40'}`
        : `relative w-full overflow-hidden rounded-[32px] ${presentation === 'embedded' ? '' : 'mx-auto max-w-[720px] shadow-2xl shadow-black/40'}`}
      style={{
        width: renderMode === 'canvas' ? `${document.canvas.width}px` : undefined,
        height: renderMode === 'canvas' ? `${document.canvas.height}px` : undefined,
        aspectRatio: renderMode === 'canvas' ? undefined : `${document.canvas.width} / ${document.canvas.height}`,
        background: styleVariant === 'text_cover_bold' ? textCoverAppearance.background : frameAppearance.canvasBackground,
        padding: `${canvasPadding.y}px ${canvasPadding.x}px`,
      }}
    >
      {usesSunsetShell ? (
        <>
          <div className="pointer-events-none absolute right-[-10%] top-[-4%] h-[34%] w-[34%] rounded-full bg-orange-300/25 blur-3xl" />
          <div className="pointer-events-none absolute bottom-[-8%] left-[-8%] h-[26%] w-[26%] rounded-full bg-rose-300/20 blur-3xl" />
          <div className="pointer-events-none absolute right-[-3%] top-[6%] h-[9%] w-[34%] rotate-[-9deg] rounded-[28px] bg-orange-300/20" />
        </>
      ) : null}
      <div className="flex h-full flex-col">
        {styleVariant === 'text_cover_bold' ? (
          <div className="flex min-h-0 flex-1 flex-col">{renderContent()}</div>
        ) : (
          <>
            {usesEditorialShell ? (
              <>
                <div className="flex items-center justify-between font-black tracking-[0.08em]" style={{ color: theme.text, fontSize: `${standardHeaderScale.badge}px` }}>
                  <div>{styleSlots.brandText || badgeText}</div>
                  <div className="font-semibold tracking-[0.04em]" style={{ color: theme.muted, fontSize: `${standardHeaderScale.minor}px` }}>
                    {styleSlots.topRightText || 'EDITORIAL FRAME'}
                  </div>
                </div>
                <div className="mt-5 flex items-start gap-5">
                  <div className="mt-1 h-28 w-[18px] shrink-0" style={{ background: theme.text, opacity: 0.72 }} />
                  <div className="flex-1">
                    <div className="font-black leading-[1.02] tracking-[-0.06em] whitespace-pre-line" style={{ color: theme.text, fontSize: `${standardHeaderScale.title}px` }}>
                      {displayHeaderTitle}
                    </div>
                    <div className="mt-4 font-semibold leading-[1.5]" style={{ color: theme.muted, fontSize: `${standardHeaderScale.subtitle}px` }}>
                      {displayHeaderSubtitle}
                    </div>
                    <div className="mt-4 h-[7px] w-[86%]" style={{ background: theme.text, opacity: 0.78 }} />
                  </div>
                </div>
              </>
            ) : usesSunsetShell ? (
              <>
                <div className="relative">
                  <div className="absolute -right-8 -top-6 h-28 w-64 rotate-[-9deg] rounded-[28px] bg-orange-300/25" />
                  <div className="relative flex items-start justify-between gap-4">
                    <div className="inline-flex items-center gap-2 rounded-[18px] bg-white/80 px-4 py-3 font-black shadow-[0_18px_34px_rgba(249,115,22,0.18)]" style={{ color: theme.text, fontSize: `${standardHeaderScale.badge}px` }}>
                      {badgeText}
                    </div>
                    <div className="pt-2 font-black tracking-[0.08em]" style={{ color: theme.text, opacity: 0.68, fontSize: `${standardHeaderScale.minor}px` }}>
                      PROMO FRAME
                    </div>
                  </div>
                </div>
                <div className="relative mt-6">
                  <div className="absolute left-[-6px] top-2 h-3.5 w-28 rounded-full bg-white/70" />
                  <div className="relative font-black leading-[1.02] tracking-[-0.05em]" style={{ color: theme.text, fontSize: `${standardHeaderScale.title}px` }}>
                    {displayHeaderTitle}
                  </div>
                  <div className="mt-4 max-w-[78%] font-bold leading-[1.55]" style={{ color: theme.text, opacity: 0.72, fontSize: `${standardHeaderScale.subtitle}px` }}>
                    {displayHeaderSubtitle}
                  </div>
                </div>
              </>
            ) : usesNotebookShell ? (
              <>
                <div className="flex items-center justify-between">
                  <div className="inline-flex items-center gap-2 rounded-[14px] border border-stone-400/25 border-dashed bg-[#fff7ed] px-4 py-2.5 font-extrabold" style={{ color: theme.text, fontSize: `${standardHeaderScale.badge}px` }}>
                    {badgeText}
                  </div>
                  <div className="flex gap-2">
                    <div className="h-4 w-11 rotate-[8deg] rounded-[6px] bg-yellow-300/45" />
                    <div className="h-4 w-11 -rotate-[7deg] rounded-[6px] bg-sky-300/25" />
                  </div>
                </div>
                <div className="mt-6">
                  <div className="font-black leading-[1.06]" style={{ color: theme.text, fontSize: `${standardHeaderScale.title}px` }}>
                    {displayHeaderTitle}
                  </div>
                  <div className="mt-4 font-semibold leading-[1.55]" style={{ color: theme.muted, fontSize: `${standardHeaderScale.subtitle}px` }}>
                    {displayHeaderSubtitle}
                  </div>
                  <div className="mt-4 h-[2px]" style={{ background: 'repeating-linear-gradient(90deg, rgba(120,113,108,0.28) 0 12px, rgba(120,113,108,0) 12px 20px)' }} />
                </div>
              </>
            ) : usesSplitShell ? (
              <>
                <div className="flex items-start gap-4">
                  <div className="h-36 w-[18px] shrink-0 rounded-[10px] bg-gradient-to-b from-blue-600 to-green-500" />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="inline-flex items-center gap-2 bg-blue-50 font-extrabold text-blue-600" style={{ fontSize: `${standardHeaderScale.badge}px`, padding: frameTemplateProfile.badgePadding, borderRadius: frameTemplateProfile.badgeRadius }}>
                        {badgeText}
                      </div>
                      <div className="font-black tracking-[0.08em]" style={{ color: theme.muted, fontSize: `${standardHeaderScale.minor}px` }}>
                        SPLIT FRAME
                      </div>
                    </div>
                    <div className="font-black" style={{ color: theme.text, fontSize: `${standardHeaderScale.title}px`, maxWidth: frameTemplateProfile.titleMaxWidth, lineHeight: frameTemplateProfile.titleLineHeight, letterSpacing: frameTemplateProfile.titleTracking, marginTop: `${frameTemplateProfile.titleMarginTop}px` }}>
                      {displayHeaderTitle}
                    </div>
                    <div className="font-semibold" style={{ color: theme.muted, fontSize: `${standardHeaderScale.subtitle}px`, maxWidth: frameTemplateProfile.subtitleMaxWidth, lineHeight: frameTemplateProfile.subtitleLineHeight, marginTop: `${frameTemplateProfile.subtitleMarginTop}px` }}>
                      {displayHeaderSubtitle}
                    </div>
                  </div>
                </div>
              </>
            ) : usesSoftShell ? (
              <>
                <div className="flex items-center justify-between">
                  <div
                    className="inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 font-extrabold shadow-[0_12px_24px_rgba(15,23,42,0.08)]"
                    style={{ color: theme.accent, fontSize: `${standardHeaderScale.badge}px` }}
                  >
                    {badgeText}
                  </div>
                  <div className="h-[22px] w-[72px] rotate-[8deg] rounded-[6px] bg-[#ffe4b6]/80" />
                </div>

                <div className="font-black" style={{ color: theme.text, fontSize: `${standardHeaderScale.title}px`, lineHeight: frameTemplateProfile.titleLineHeight, letterSpacing: frameTemplateProfile.titleTracking, marginTop: `${frameTemplateProfile.titleMarginTop}px`, maxWidth: frameTemplateProfile.titleMaxWidth }}>
                  {displayHeaderTitle}
                </div>
                <div className="font-semibold" style={{ color: theme.muted, fontSize: `${standardHeaderScale.subtitle}px`, lineHeight: frameTemplateProfile.subtitleLineHeight, marginTop: `${frameTemplateProfile.subtitleMarginTop}px`, maxWidth: frameTemplateProfile.subtitleMaxWidth }}>
                  {displayHeaderSubtitle}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div
                    className="inline-flex items-center gap-2 rounded-full px-4 py-2 font-extrabold"
                    style={{ background: usesSunsetShell ? 'rgba(255,255,255,0.72)' : theme.accentSoft, color: usesSunsetShell ? theme.text : theme.accent, fontSize: `${standardHeaderScale.badge}px` }}
                  >
                    {badgeText}
                  </div>
                  <div />
                </div>

                <div className="font-black" style={{ color: theme.text, fontSize: `${standardHeaderScale.title}px`, lineHeight: frameTemplateProfile.titleLineHeight, letterSpacing: frameTemplateProfile.titleTracking, marginTop: `${frameTemplateProfile.titleMarginTop}px`, maxWidth: frameTemplateProfile.titleMaxWidth }}>
                  {displayHeaderTitle}
                </div>
                <div className="font-semibold" style={{ color: theme.muted, fontSize: `${standardHeaderScale.subtitle}px`, lineHeight: frameTemplateProfile.subtitleLineHeight, marginTop: `${frameTemplateProfile.subtitleMarginTop}px`, maxWidth: frameTemplateProfile.subtitleMaxWidth }}>
                  {displayHeaderSubtitle}
                </div>
              </>
            )}

            <div
              className={`relative mt-6 flex flex-1 flex-col ${usesEditorialShell ? '' : 'rounded-[36px]'} ${document.templateKind === 'feature_hero' ? '' : 'justify-between'}`}
              style={{
                background: usesEditorialShell ? 'transparent' : frameAppearance.panelBackground,
                border: usesEditorialShell ? 'none' : frameAppearance.panelBorder,
                borderRadius: usesEditorialShell ? 0 : frameAppearance.shellBorderRadius,
                boxShadow: usesEditorialShell ? 'none' : frameAppearance.panelShadow,
                transform: usesSunsetShell ? 'rotate(-1.2deg)' : 'none',
                padding: usesEditorialShell ? undefined : `${document.density === 'compact' ? frameTemplateProfile.shellPaddingCompact : frameTemplateProfile.shellPadding}px`,
              }}
            >
              {usesSoftShell ? <div className="pointer-events-none absolute right-10 top-4 h-6 w-20 rotate-[9deg] rounded-[7px] bg-[#ffe4b6]/80" /> : null}
              {usesNotebookShell ? (
                <>
                  <div className="pointer-events-none absolute left-7 top-5 h-[calc(100%-40px)] w-[calc(100%-56px)] rounded-[24px] border border-stone-400/15 border-dashed" />
                  <div className="pointer-events-none absolute bottom-5 right-7 h-[18px] w-[70px] -rotate-[8deg] rounded-[6px] bg-yellow-300/30" />
                </>
              ) : null}
              {usesSplitShell ? (
                <>
                  <div className="pointer-events-none absolute left-0 top-0 h-full w-[18px] bg-gradient-to-b from-blue-600 to-green-500" />
                  <div className="pointer-events-none absolute right-7 top-5 h-[10px] w-[86px] rounded-full bg-blue-600/15" />
                </>
              ) : null}
              <div className={document.templateKind === 'feature_hero' ? 'flex min-h-0 flex-1 flex-col' : ''}>{renderContent()}</div>
              <div className={`${document.templateKind === 'feature_hero' ? 'mt-4' : 'mt-5'} flex items-center justify-between gap-4`}>
                <div className="max-w-[70%] font-semibold leading-[1.6]" style={{ color: theme.muted, fontSize: `${frameTemplateProfile.footerFontSize}px` }}>
                  {footerNote}
                </div>
                {usesEditorialShell ? (
                  <div className="text-[52px] font-black leading-none opacity-[0.08]" style={{ color: theme.text }}>
                    {styleSlots.bottomHeadline || displayHeaderTitle}
                  </div>
                ) : (
                  <div
                    className="inline-flex items-center justify-center font-extrabold text-white"
                    style={{ background: theme.accent, boxShadow: '0 14px 30px rgba(15,23,42,0.15)', fontSize: `${frameTemplateProfile.ctaFontSize}px`, padding: frameTemplateProfile.ctaPadding, borderRadius: frameTemplateProfile.ctaRadius }}
                  >
                    {ctaText}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TemplateComposeCanvasPreview;
