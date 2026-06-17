import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Asset, ReferenceAsset, TemplateComposeDocument, TemplateComposeResult, TemplateKind, TemplateScreenshot } from '../types';
import TemplateComposeCanvasPreview from './TemplateComposeCanvasPreview';
import {
  documentToEditablePayload,
  getDefaultScreenshotFitMode,
  isWhitePanelFreeLayoutModule,
  normalizeTemplateComposeDocument,
  patchDocumentAssets,
  patchDocumentModuleLayout,
  patchDocumentModule,
  renderTemplateDocumentDataUrl,
} from '../lib/templateComposer';

interface TemplateComposeEditorOverlayProps {
  isOpen: boolean;
  document: TemplateComposeDocument | null;
  referenceAssets: ReferenceAsset[];
  composeResult: TemplateComposeResult | null;
  onClose: () => void;
  onSaveDraftClose: (payload: { document: TemplateComposeDocument; result: TemplateComposeResult; asset: Asset }) => void;
  onDraftChange: (payload: { document: TemplateComposeDocument; result: TemplateComposeResult }) => void;
  onApply: (payload: { document: TemplateComposeDocument; result: TemplateComposeResult; asset: Asset }) => void;
}

const templateKindLabels: Record<string, string> = {
  feature_hero: '功能主视觉',
  step_guide: '步骤说明',
  benefit_grid: '卖点网格',
  before_after: '前后对比',
  faq_card: 'FAQ 卡片',
};

const moduleLabels: Record<string, string> = {
  badge_block: '顶部角标',
  canvas_meta: '尺寸标签',
  title_block: '标题',
  subtitle_block: '副标题',
  screenshot_frame: '产品截图',
  bullet_group: '卖点文案',
  feature_grid: '功能卡片',
  step_group: '步骤说明',
  comparison_group: '对比内容',
  cta_badge: '按钮文案',
  footer_note: '页脚说明',
};

const toLineText = (content: unknown): string => {
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item && typeof item === 'object') {
          const title = 'title' in item ? String(item.title || '') : '';
          const description = 'description' in item ? String(item.description || '') : '';
          return [title, description].filter(Boolean).join(' | ');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
};

const fromLineText = (moduleType: string, value: string): unknown => {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (moduleType === 'bullet_group') {
    return lines;
  }

  if (moduleType === 'feature_grid' || moduleType === 'step_group' || moduleType === 'comparison_group') {
    return lines.map((line) => {
      const [title, ...rest] = line.split('|');
      return {
        title: title?.trim() || '',
        description: rest.join('|').trim() || '',
      };
    });
  }

  return value;
};

const normalizeCrop = (asset: TemplateScreenshot | undefined, templateKind: TemplateComposeDocument['templateKind']) => ({
  x: typeof asset?.crop?.x === 'number' ? asset.crop.x : 50,
  y: typeof asset?.crop?.y === 'number' ? asset.crop.y : 50,
  zoom: typeof asset?.crop?.zoom === 'number' ? asset.crop.zoom : 1,
  fitMode: asset?.crop?.fitMode === 'contain' ? 'contain' as const : getDefaultScreenshotFitMode(templateKind),
});

const normalizeModuleOffset = (value?: number) => (typeof value === 'number' ? value : 0);
const normalizeModuleMetric = (value?: number) => (typeof value === 'number' ? value : 0);

const TemplateComposeEditorOverlay: React.FC<TemplateComposeEditorOverlayProps> = ({
  isOpen,
  document,
  referenceAssets,
  composeResult,
  onClose,
  onSaveDraftClose,
  onDraftChange,
  onApply,
}) => {
  const [selectedModuleId, setSelectedModuleId] = useState<string>('title');
  const [workingDocument, setWorkingDocument] = useState<TemplateComposeDocument | null>(
    document ? normalizeTemplateComposeDocument(document) : document
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lastHydratedDocumentIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const isDirtyRef = useRef(false);

  const orderedModules = useMemo(
    () => [...(workingDocument?.modules || [])].sort((a, b) => a.order - b.order),
    [workingDocument]
  );
  const selectedModule = orderedModules.find((module) => module.id === selectedModuleId) || orderedModules[0];
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;

    if (!isOpen) {
      isDirtyRef.current = false;
      return;
    }

    if (!document) {
      return;
    }

    const openedThisTurn = !wasOpen && isOpen;
    const documentChanged = lastHydratedDocumentIdRef.current !== document.id;
    const normalizedDocument = normalizeTemplateComposeDocument(document);

    if (openedThisTurn || documentChanged || !isDirtyRef.current) {
      setWorkingDocument(normalizedDocument);
      setSelectedModuleId((prev) => {
        if (prev && normalizedDocument.modules.some((module) => module.id === prev)) {
          return prev;
        }
        return normalizedDocument.modules[0]?.id || 'title';
      });
      lastHydratedDocumentIdRef.current = document.id;
      isDirtyRef.current = false;
    }
  }, [document, isOpen]);

  const buildDraftPayload = (nextDocument: TemplateComposeDocument) => ({
    document: nextDocument,
    result: {
      ...composeResult,
      document: nextDocument,
      editable_payload: documentToEditablePayload(nextDocument),
      rendered_image_url: composeResult?.rendered_image_url || '',
    },
  });

  useEffect(() => {
    if (!isOpen || !workingDocument || !composeResult) {
      return;
    }
    const timer = window.setTimeout(() => {
      onDraftChange(buildDraftPayload(workingDocument));
    }, 240);
    return () => window.clearTimeout(timer);
  }, [composeResult, isOpen, onDraftChange, workingDocument]);

  if (!isOpen || !workingDocument || !composeResult) {
    return null;
  }

  const emitDraft = (nextDocument: TemplateComposeDocument) => {
    isDirtyRef.current = true;
    setWorkingDocument(nextDocument);
  };

  const updateModuleContent = (moduleId: string, content: unknown) => {
    const nextDocument = patchDocumentModule(workingDocument, moduleId, { content });
    emitDraft(nextDocument);
  };

  const updateModuleLayout = (moduleId: string, layoutUpdates: Partial<TemplateComposeDocument['modules'][number]['layout']>) => {
    const nextDocument = patchDocumentModuleLayout(workingDocument, moduleId, layoutUpdates);
    emitDraft(nextDocument);
  };

  const resetModuleLayout = (moduleId: string) => {
    updateModuleLayout(moduleId, { offsetX: 0, offsetY: 0, x: undefined, y: undefined, width: undefined, height: undefined });
  };

  const updateAssets = (assetId: string) => {
    const asset = referenceAssets.find((item) => item.id === assetId);
    if (!asset) {
      return;
    }
    const nextAssets = [
      {
        assetId: asset.id,
        url: asset.url,
        label: asset.original_name,
        width: asset.width,
        height: asset.height,
        crop: { x: 50, y: 50, zoom: 1, fitMode: getDefaultScreenshotFitMode(workingDocument.templateKind) },
      },
      ...workingDocument.assets.filter((item) => item.assetId !== asset.id),
    ].slice(0, 3);
    const nextDocument = patchDocumentAssets(workingDocument, nextAssets);
    setSelectedModuleId('screenshots');
    emitDraft(nextDocument);
  };

  const toggleModuleVisible = (moduleId: string, visible: boolean) => {
    const nextDocument = patchDocumentModule(workingDocument, moduleId, { visible });
    emitDraft(nextDocument);
  };

  const removeScreenshot = (target: TemplateScreenshot) => {
    const nextAssets = workingDocument.assets.filter((item) => {
      if (target.assetId) {
        return item.assetId !== target.assetId;
      }
      return item.url !== target.url;
    });
    const nextDocument = patchDocumentAssets(workingDocument, nextAssets);
    emitDraft(nextDocument);
  };

  const updateScreenshotCrop = (
    target: TemplateScreenshot,
    updates: Partial<ReturnType<typeof normalizeCrop>>
  ) => {
    const nextAssets = workingDocument.assets.map((asset) => {
      const isTarget =
        (target.assetId && asset.assetId === target.assetId) ||
        (!target.assetId && asset.url === target.url);
      if (!isTarget) {
        return asset;
      }
      return {
          ...asset,
          crop: {
          ...normalizeCrop(asset, workingDocument.templateKind),
          ...updates,
        },
      };
    });
    const nextDocument = patchDocumentAssets(workingDocument, nextAssets);
    emitDraft(nextDocument);
  };

  const resetScreenshotCrop = (target: TemplateScreenshot) => {
    updateScreenshotCrop(target, { x: 50, y: 50, zoom: 1, fitMode: getDefaultScreenshotFitMode(workingDocument.templateKind) });
  };

  const applyAndClose = () => {
    if (isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      const editablePayload = documentToEditablePayload(workingDocument);
      const displayUrl = renderTemplateDocumentDataUrl(workingDocument);
      const result = {
        ...buildDraftPayload(workingDocument).result,
        editable_payload: editablePayload,
        rendered_image_url: displayUrl,
        document: workingDocument,
      };
      const asset: Asset = {
        id: `template-${workingDocument.id}`,
        url: displayUrl,
        sourceType: 'template_compose',
        mode: '模板拼装',
        promptLabel: templateKindLabels[workingDocument.templateKind] || '模板拼装',
        promptText: `模板方案：${workingDocument.templateKind}`,
        variantKey: workingDocument.templateKind,
        layoutFamily: 'template_compose',
        visualFocus: '截图保真 + 模板拼装',
        visualModeResolved: 'template_compose',
        templateKind: workingDocument.templateKind as TemplateKind,
        editablePayload,
        templateDocument: workingDocument,
        referenceAssetIds: (workingDocument.assets || []).map((item) => item.assetId).filter(Boolean) as string[],
        isProcessing: false,
      };
      onDraftChange({ document: workingDocument, result });
      isDirtyRef.current = false;
      onApply({
        document: workingDocument,
        result,
        asset,
      });
      onClose();
    } catch (error) {
      console.error('应用到工作台失败', error);
      window.alert('应用到工作台失败，请重试。');
    } finally {
      setIsSubmitting(false);
    }
  };

  const saveDraftAndClose = () => {
    if (isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      const editablePayload = documentToEditablePayload(workingDocument);
      const displayUrl = renderTemplateDocumentDataUrl(workingDocument);
      const result = {
        ...buildDraftPayload(workingDocument).result,
        editable_payload: editablePayload,
        rendered_image_url: displayUrl,
        document: workingDocument,
      };
      const asset: Asset = {
        id: `template-${workingDocument.id}`,
        url: displayUrl,
        sourceType: 'template_compose',
        mode: '模板拼装',
        promptLabel: templateKindLabels[workingDocument.templateKind] || '模板拼装',
        promptText: `模板方案：${workingDocument.templateKind}`,
        variantKey: workingDocument.templateKind,
        layoutFamily: 'template_compose',
        visualFocus: '截图保真 + 模板拼装',
        visualModeResolved: 'template_compose',
        templateKind: workingDocument.templateKind as TemplateKind,
        editablePayload,
        templateDocument: workingDocument,
        referenceAssetIds: (workingDocument.assets || []).map((item) => item.assetId).filter(Boolean) as string[],
        isProcessing: false,
      };
      onDraftChange({ document: workingDocument, result });
      onSaveDraftClose({
        document: workingDocument,
        result,
        asset,
      });
      onClose();
    } catch (error) {
      console.error('保存草稿失败', error);
      window.alert('保存草稿失败，请重试。');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-[#090b10]/90 backdrop-blur-md">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Template Compose Editor</div>
            <div className="mt-1 text-lg font-semibold text-white">先排版，再决定是否进入发布工作台</div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={saveDraftAndClose} disabled={isSubmitting} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60">
              {isSubmitting ? '正在保存...' : '保存草稿并关闭'}
            </button>
            <button onClick={applyAndClose} disabled={isSubmitting} className="rounded-xl bg-xhs-red px-4 py-2 text-sm font-semibold text-white hover:bg-xhs-dark disabled:cursor-not-allowed disabled:opacity-60">
              {isSubmitting ? '正在应用...' : '应用到工作台'}
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr_360px] gap-0">
          <div className="overflow-y-auto border-r border-white/10 bg-[#111319] p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-slate-500">模块</div>
            <div className="mt-4 space-y-2">
              {orderedModules.map((module) => (
                <button
                  key={module.id}
                  onClick={() => setSelectedModuleId(module.id)}
                  className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                    selectedModule?.id === module.id ? 'border-xhs-red bg-xhs-red/10 text-white' : 'border-white/10 bg-white/5 text-slate-300'
                  }`}
                >
                  <div className="text-sm font-medium">{moduleLabels[module.type] || module.type}</div>
                  <div className="mt-1 text-xs text-slate-500">排序 {module.order}</div>
                </button>
              ))}
            </div>

            <div className="mt-6 text-xs uppercase tracking-[0.18em] text-slate-500">素材库</div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {referenceAssets.map((asset) => (
                <button
                  key={asset.id}
                  onClick={() => updateAssets(asset.id)}
                  className={`overflow-hidden rounded-xl border text-left transition ${
                    workingDocument.assets.some((item) => item.assetId === asset.id)
                      ? 'border-emerald-400/60 bg-emerald-400/10'
                      : 'border-white/10 bg-white/5 hover:border-white/20'
                  }`}
                >
                  <img src={asset.url} alt={asset.original_name} className="h-24 w-full object-cover" />
                  <div className="p-2 text-xs text-slate-300 truncate">{asset.original_name}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-auto bg-[#0d1016] p-6">
            <div className="mx-auto w-full max-w-[720px]">
              <TemplateComposeCanvasPreview
                document={workingDocument}
                selectedModuleId={selectedModule?.id}
                onModuleSelect={setSelectedModuleId}
                onModuleLayoutChange={updateModuleLayout}
              />
              {workingDocument.assets.length > 0 && (
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-500">当前已放入的截图</div>
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    {workingDocument.assets.map((asset) => (
                      <div key={asset.assetId || asset.url} className="overflow-hidden rounded-xl border border-emerald-400/30 bg-emerald-400/5">
                        <img src={asset.url} alt={asset.label || '截图'} className="h-24 w-full object-cover" />
                        <div className="truncate px-2 py-1 text-[11px] text-emerald-100">{asset.label || '已选截图'}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-y-auto border-l border-white/10 bg-[#111319] p-5">
            <div className="text-xs uppercase tracking-[0.18em] text-slate-500">属性</div>
            {selectedModule ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">当前模块</div>
                  <div className="text-sm font-semibold text-white">{moduleLabels[selectedModule.type] || selectedModule.type}</div>
                  <div className="mt-1 text-xs text-slate-500">这里支持顶部文案、正文内容、截图构图和模块显隐。</div>
                </div>

                {(selectedModule.type === 'badge_block' || selectedModule.type === 'canvas_meta' || selectedModule.type === 'title_block' || selectedModule.type === 'subtitle_block' || selectedModule.type === 'cta_badge' || selectedModule.type === 'footer_note') && (
                  <textarea
                    value={String(selectedModule.content || '')}
                    onChange={(event) => updateModuleContent(selectedModule.id, event.target.value)}
                    rows={selectedModule.type === 'subtitle_block' ? 5 : selectedModule.type === 'title_block' ? 4 : 2}
                    className="w-full rounded-2xl border border-white/10 bg-[#13151b] px-4 py-3 text-sm text-white resize-none"
                  />
                )}

                {selectedModule.type === 'badge_block' && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs leading-6 text-slate-400">
                    顶部左上角角标文案。这里只改展示文本，不会影响模板类型和保存链路。
                  </div>
                )}

                {selectedModule.type === 'canvas_meta' && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-xs leading-6 text-slate-400">
                    这里只改右上角展示标签，不会修改真实画布尺寸，当前模板导出尺寸仍保持原来的画布宽高。
                  </div>
                )}

                {(selectedModule.type === 'bullet_group' || selectedModule.type === 'feature_grid' || selectedModule.type === 'step_group' || selectedModule.type === 'comparison_group') && (
                  <div className="space-y-2">
                    <div className="text-xs text-slate-500">
                      {selectedModule.type === 'bullet_group' ? '每行一条卖点，直接删减或改写。' : '每行一项，格式为：标题 | 补充说明'}
                    </div>
                    <textarea
                      value={toLineText(selectedModule.content || [])}
                      onChange={(event) => updateModuleContent(selectedModule.id, fromLineText(selectedModule.type, event.target.value))}
                      rows={16}
                      className="w-full rounded-2xl border border-white/10 bg-[#13151b] px-4 py-3 text-sm text-white resize-none"
                    />
                  </div>
                )}

                {(selectedModule.type === 'bullet_group' || selectedModule.type === 'screenshot_frame') && (
                  <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">模块位置</div>
                    <div className="text-xs leading-6 text-slate-400">
                      {isWhitePanelFreeLayoutModule(workingDocument.templateKind, selectedModule.type)
                        ? '在中间白色内容区里直接拖拽模块，或拉右侧/底部/右下角手柄调整框大小。'
                        : '在中间画布里直接拖拽当前模块即可微调位置。这里提供当前位置和一键重置，避免把已稳定的模板布局拖乱。'}
                    </div>
                    {isWhitePanelFreeLayoutModule(workingDocument.templateKind, selectedModule.type) ? (
                      <div className="grid grid-cols-2 gap-3 text-sm text-slate-200">
                        <div className="rounded-xl border border-white/10 bg-[#13151b] px-3 py-2">
                          左侧位置: {(normalizeModuleMetric(selectedModule.layout?.x) * 100).toFixed(1)}%
                        </div>
                        <div className="rounded-xl border border-white/10 bg-[#13151b] px-3 py-2">
                          顶部位置: {(normalizeModuleMetric(selectedModule.layout?.y) * 100).toFixed(1)}%
                        </div>
                        <div className="rounded-xl border border-white/10 bg-[#13151b] px-3 py-2">
                          框宽度: {(normalizeModuleMetric(selectedModule.layout?.width) * 100).toFixed(1)}%
                        </div>
                        <div className="rounded-xl border border-white/10 bg-[#13151b] px-3 py-2">
                          框高度: {(normalizeModuleMetric(selectedModule.layout?.height) * 100).toFixed(1)}%
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 text-sm text-slate-200">
                        <div className="rounded-xl border border-white/10 bg-[#13151b] px-3 py-2">
                          水平偏移: {(normalizeModuleOffset(selectedModule.layout?.offsetX) * 100).toFixed(1)}%
                        </div>
                        <div className="rounded-xl border border-white/10 bg-[#13151b] px-3 py-2">
                          垂直偏移: {(normalizeModuleOffset(selectedModule.layout?.offsetY) * 100).toFixed(1)}%
                        </div>
                      </div>
                    )}
                    <button
                      onClick={() => resetModuleLayout(selectedModule.id)}
                      className="w-full rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5"
                    >
                      {isWhitePanelFreeLayoutModule(workingDocument.templateKind, selectedModule.type) ? '重置模块布局' : '重置模块位置'}
                    </button>
                  </div>
                )}

                {selectedModule.type === 'screenshot_frame' && (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                      点击左侧素材库图片即可加入当前模板。加入后可以单独调整每张图的适配方式、缩放和位置。
                    </div>
                    {workingDocument.assets.length > 0 ? (
                      <div className="space-y-3">
                        {workingDocument.assets.map((asset) => (
                          <div key={asset.assetId || asset.url} className="rounded-2xl border border-white/10 bg-[#13151b] p-3">
                            <div className="flex items-center gap-3">
                              <img src={asset.url} alt={asset.label || '截图'} className="h-16 w-16 rounded-xl object-cover" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm text-white">{asset.label || '已选截图'}</div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {asset.width || '-'} x {asset.height || '-'}
                                </div>
                              </div>
                              <button
                                onClick={() => removeScreenshot(asset)}
                                className="rounded-lg border border-white/10 px-3 py-1 text-xs text-slate-300 hover:bg-white/5"
                              >
                                移除
                              </button>
                            </div>

                            <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
                              <div>
                                <div className="mb-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">适配方式</div>
                                <div className="grid grid-cols-2 gap-2">
                                  {(['cover', 'contain'] as const).map((fitMode) => {
                                    const crop = normalizeCrop(asset, workingDocument.templateKind);
                                    const active = crop.fitMode === fitMode;
                                    return (
                                      <button
                                        key={fitMode}
                                        onClick={() => updateScreenshotCrop(asset, { fitMode })}
                                        className={`rounded-xl border px-3 py-2 text-sm transition ${
                                          active
                                            ? 'border-xhs-red bg-xhs-red/10 text-white'
                                            : 'border-white/10 bg-white/5 text-slate-300'
                                        }`}
                                      >
                                        {fitMode === 'cover' ? '铺满裁切' : '完整显示'}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>

                              <label className="block">
                                <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                                  <span>缩放</span>
                                  <span>{normalizeCrop(asset, workingDocument.templateKind).zoom.toFixed(2)}x</span>
                                </div>
                                <input
                                  type="range"
                                  min="0.8"
                                  max="2.5"
                                  step="0.01"
                                  value={normalizeCrop(asset, workingDocument.templateKind).zoom}
                                  onChange={(event) => updateScreenshotCrop(asset, { zoom: Number(event.target.value) })}
                                  className="w-full"
                                />
                              </label>

                              <label className="block">
                                <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                                  <span>水平位置</span>
                                  <span>{Math.round(normalizeCrop(asset, workingDocument.templateKind).x)}%</span>
                                </div>
                                <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={normalizeCrop(asset, workingDocument.templateKind).x}
                                  onChange={(event) => updateScreenshotCrop(asset, { x: Number(event.target.value) })}
                                  className="w-full"
                                />
                              </label>

                              <label className="block">
                                <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-slate-500">
                                  <span>垂直位置</span>
                                  <span>{Math.round(normalizeCrop(asset, workingDocument.templateKind).y)}%</span>
                                </div>
                                <input
                                  type="range"
                                  min="0"
                                  max="100"
                                  step="1"
                                  value={normalizeCrop(asset, workingDocument.templateKind).y}
                                  onChange={(event) => updateScreenshotCrop(asset, { y: Number(event.target.value) })}
                                  className="w-full"
                                />
                              </label>

                              <button
                                onClick={() => resetScreenshotCrop(asset)}
                                className="w-full rounded-xl border border-white/10 px-3 py-2 text-sm text-slate-300 hover:bg-white/5"
                              >
                                重置图片调整
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-500">
                        还没有添加截图，先从左侧素材库选择一张。
                      </div>
                    )}
                  </div>
                )}

                {!['badge_block', 'canvas_meta', 'title_block', 'subtitle_block', 'cta_badge', 'footer_note', 'bullet_group', 'feature_grid', 'step_group', 'comparison_group', 'screenshot_frame'].includes(selectedModule.type) && (
                  <textarea
                    value={String(selectedModule.content || '')}
                    onChange={(event) => updateModuleContent(selectedModule.id, event.target.value)}
                    rows={8}
                    className="w-full rounded-2xl border border-white/10 bg-[#13151b] px-4 py-3 text-sm text-white resize-none"
                  />
                )}

                <label className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-200">
                  显示模块
                  <input
                    type="checkbox"
                    checked={selectedModule.visible}
                    onChange={(event) => toggleModuleVisible(selectedModule.id, event.target.checked)}
                  />
                </label>
              </div>
            ) : (
              <div className="mt-4 text-sm text-slate-500">请选择左侧模块开始编辑。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TemplateComposeEditorOverlay;
