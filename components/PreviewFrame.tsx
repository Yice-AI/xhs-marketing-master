import React, { useContext, useEffect, useRef, useState } from 'react';
import { Asset, ContentData } from '../types';
import { LayoutContext } from '../App';
import TemplateAssetPreview from './TemplateAssetPreview';

interface PreviewFrameProps {
  content: ContentData;
  activeAsset?: Asset | null;
  imageCount?: number;
  activeImageIndex?: number;
  promptLabel?: string;
  promptText?: string;
  variantKey?: string;
  layoutFamily?: string;
  visualFocus?: string;
  sourceType?: string;
  templateKind?: string;
  onPrevImage?: () => void;
  onNextImage?: () => void;
}

const PreviewFrame: React.FC<PreviewFrameProps> = ({
  content,
  activeAsset,
  imageCount = 1,
  activeImageIndex = 0,
  promptLabel,
  promptText,
  variantKey,
  layoutFamily,
  visualFocus,
  sourceType,
  templateKind,
  onPrevImage,
  onNextImage,
}) => {
  const layout = useContext(LayoutContext);
  const [isImageViewerOpen, setIsImageViewerOpen] = useState(false);
  const [viewerScale, setViewerScale] = useState(1);
  const [viewerOffset, setViewerOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const viewerOverlayRef = useRef<HTMLDivElement | null>(null);
  const viewerStageRef = useRef<HTMLDivElement | null>(null);
  const viewerScaleRef = useRef(1);
  const viewerOffsetRef = useRef({ x: 0, y: 0 });

  if (!layout) return null;

  const isTemplateComposeAsset = Boolean(
    activeAsset
    && (
      activeAsset.sourceType === 'template_compose'
      || activeAsset.visualModeResolved === 'template_compose'
      || activeAsset.layoutFamily === 'template_compose'
      || activeAsset.templateKind
      || activeAsset.editablePayload
    )
  );
  const openImageViewer = () => {
    setViewerScale(1);
    setViewerOffset({ x: 0, y: 0 });
    setIsImageViewerOpen(true);
  };

  const closeImageViewer = () => {
    setIsImageViewerOpen(false);
    setViewerScale(1);
    setViewerOffset({ x: 0, y: 0 });
    dragStartRef.current = null;
  };

  const resetImageViewer = () => {
    setViewerScale(1);
    setViewerOffset({ x: 0, y: 0 });
    viewerScaleRef.current = 1;
    viewerOffsetRef.current = { x: 0, y: 0 };
    dragStartRef.current = null;
  };

  const updateViewerScale = (nextScale: number, anchor?: { x: number; y: number; bounds: DOMRect }) => {
    const currentScale = viewerScaleRef.current;
    const clampedScale = Math.min(3.5, Math.max(1, Number(nextScale.toFixed(3))));
    if (clampedScale <= 1) {
      viewerScaleRef.current = 1;
      viewerOffsetRef.current = { x: 0, y: 0 };
      setViewerScale(1);
      setViewerOffset({ x: 0, y: 0 });
      return;
    }

    if (anchor) {
      const centerX = anchor.bounds.left + anchor.bounds.width / 2;
      const centerY = anchor.bounds.top + anchor.bounds.height / 2;
      const ratio = clampedScale / currentScale;
      const nextOffset = {
        x: viewerOffsetRef.current.x + (anchor.x - centerX - viewerOffsetRef.current.x) * (1 - ratio),
        y: viewerOffsetRef.current.y + (anchor.y - centerY - viewerOffsetRef.current.y) * (1 - ratio),
      };
      viewerOffsetRef.current = nextOffset;
      setViewerOffset(nextOffset);
    }
    viewerScaleRef.current = clampedScale;
    setViewerScale(clampedScale);
  };

  useEffect(() => {
    viewerScaleRef.current = viewerScale;
  }, [viewerScale]);

  useEffect(() => {
    viewerOffsetRef.current = viewerOffset;
  }, [viewerOffset]);

  useEffect(() => {
    if (!isImageViewerOpen) return;
    const overlay = viewerOverlayRef.current;
    if (!overlay) return;

    const handleWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-viewer-control="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      const stageBounds = viewerStageRef.current?.getBoundingClientRect() || overlay.getBoundingClientRect();
      const wheelFactor = Math.min(1.035, Math.max(0.965, Math.exp(-event.deltaY * 0.00055)));
      updateViewerScale(viewerScaleRef.current * wheelFactor, {
        x: event.clientX,
        y: event.clientY,
        bounds: stageBounds,
      });
    };

    overlay.addEventListener('wheel', handleWheel, { passive: false });
    return () => overlay.removeEventListener('wheel', handleWheel);
  }, [isImageViewerOpen]);

  useEffect(() => {
    if (!isImageViewerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeImageViewer();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isImageViewerOpen]);

  return (
    <>
      <div className="h-14 border-b border-white/5 flex justify-between items-center px-6 bg-white/[0.01]">
        <span className="text-xs font-medium text-gray-400 uppercase tracking-widest">实时预览</span>
        <div className="flex bg-white/5 p-1 rounded-lg border border-white/5 gap-1">
          <button className="px-3 py-1 rounded text-[10px] font-medium transition-colors bg-white/10 text-white shadow-sm flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[12px]">smartphone</span> 笔记
          </button>
          <button className="px-3 py-1 rounded text-[10px] font-medium transition-colors text-gray-500 hover:text-white hover:bg-white/5 flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[12px]">grid_on</span> 封面
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center relative p-2 overflow-hidden w-full">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[140%] h-[90%] bg-radial-gradient from-xhs-red/[0.04] to-transparent blur-3xl"></div>
        </div>

        <div className="relative h-full w-full max-h-[850px] flex items-center justify-center group transition-all duration-700">
          <div className="relative aspect-iphone h-full max-h-full max-w-full">
            <div className="iphone-frame-actual h-full w-full bg-[#1c1c1e] p-[6px] rounded-[56px] iphone-shadow border border-[#2c2c2e] overflow-hidden">
              <div className="h-full w-full rounded-[50px] overflow-hidden bg-white text-gray-900 flex flex-col relative font-sans">

                <div className="h-12 w-full bg-gradient-to-b from-black/40 to-transparent absolute top-0 z-30 pointer-events-none"></div>
                <div className="absolute top-1 left-1/2 -translate-x-1/2 w-[32%] h-7 bg-black rounded-full z-50"></div>
                <div className="absolute top-3 right-8 z-40 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-white text-[16px] drop-shadow-sm">signal_cellular_alt</span>
                  <span className="material-symbols-outlined text-white text-[16px] drop-shadow-sm">wifi</span>
                  <span className="material-symbols-outlined text-white text-[16px] drop-shadow-sm">battery_full</span>
                </div>
                <div className="absolute top-3 left-8 z-40">
                  <span className="text-white text-[13px] font-semibold drop-shadow-sm">9:41</span>
                </div>

                <div className="flex justify-between items-center px-5 pt-12 absolute top-0 left-0 right-0 z-20">
                  <span className="material-symbols-outlined text-white text-[24px] drop-shadow-md cursor-pointer hover:opacity-80">arrow_back_ios_new</span>
                  <div className="flex gap-5">
                    <span className="material-symbols-outlined text-white text-[24px] drop-shadow-md cursor-pointer">ios_share</span>
                    <span className="material-symbols-outlined text-white text-[24px] drop-shadow-md cursor-pointer">more_horiz</span>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto scrollbar-hide pb-24">
                  <button
                    type="button"
                    onClick={openImageViewer}
                    className="relative aspect-[3/4] bg-[#f5f3ef] shrink-0 w-full overflow-hidden text-left"
                    title="点击放大查看图片"
                  >
                    {isTemplateComposeAsset && activeAsset ? (
                      <TemplateAssetPreview asset={activeAsset} className="h-full w-full" mode="full" />
                    ) : (
                      <img alt="Main" className="w-full h-full object-contain bg-[#f5f3ef]" src={content.mainImageUrl} />
                    )}
                    {!isTemplateComposeAsset && (
                      <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-transparent"></div>
                    )}
                    {imageCount > 1 && (
                      <>
                        {onPrevImage && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              onPrevImage();
                            }}
                            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition hover:bg-black/55"
                          >
                            <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                          </button>
                        )}
                        {onNextImage && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              onNextImage();
                            }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm transition hover:bg-black/55"
                          >
                            <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                          </button>
                        )}
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5 z-20">
                          {Array.from({ length: imageCount }).map((_, index) => (
                            <div
                              key={index}
                              className={`h-1.5 rounded-full transition-all ${index === activeImageIndex ? 'w-4 bg-xhs-red' : 'w-1.5 bg-white/60'}`}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    <div className="absolute right-3 top-3 z-30 flex items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 backdrop-blur transition group-hover:opacity-100">
                      <span className="material-symbols-outlined text-[15px]">zoom_in</span>
                      放大
                    </div>
                  </button>

                  <div className="px-5 py-5 bg-white">
                    <h1 className="font-bold text-[18px] leading-snug mb-3 text-gray-900 tracking-tight">{content.title}</h1>

                    <div className="flex items-center gap-2 mb-5">
                      <img className="size-9 rounded-full bg-gray-200 border border-gray-100 shadow-sm object-cover" src={content.authorAvatar} alt="avatar" />
                      <div className="flex flex-col">
                        <span className="text-[13px] font-medium text-gray-800">{content.authorName}</span>
                        <div className="px-1.5 py-0.5 rounded bg-gray-100 text-[8px] text-gray-500 font-medium w-fit">资深博主</div>
                      </div>
                      <button className="ml-auto text-xhs-red border border-xhs-red font-bold text-[11px] px-4 py-1 rounded-full hover:bg-xhs-red hover:text-white transition-colors">关注</button>
                    </div>

                    <p className="text-[15px] leading-relaxed text-gray-800 whitespace-pre-wrap font-sans text-justify">
                    {content.body}
                  </p>

                  {content.tags && content.tags.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-4 pt-2">
                      {content.tags.map((tag, index) => (
                        <span key={index} className="text-[#3b82f6] text-[13px] font-semibold">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {(promptLabel || promptText) && (
                    <div className="mt-5 rounded-2xl border border-gray-100 bg-[#faf7f7] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">Prompt Trace</span>
                        {promptLabel && (
                          <span className="rounded-full bg-xhs-red/10 px-2.5 py-1 text-[10px] font-medium text-xhs-red">{promptLabel}</span>
                        )}
                      </div>
                      {(variantKey || layoutFamily || visualFocus || sourceType || templateKind) && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {sourceType && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] text-slate-600">{sourceType}</span>}
                          {templateKind && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] text-slate-600">{templateKind}</span>}
                          {variantKey && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] text-slate-600">{variantKey}</span>}
                          {layoutFamily && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] text-slate-600">{layoutFamily}</span>}
                          {visualFocus && <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] text-slate-600">{visualFocus}</span>}
                        </div>
                      )}
                      {promptText && (
                        <p className="mt-3 text-[12px] leading-5 text-gray-600 whitespace-pre-wrap break-words line-clamp-6">
                          {promptText}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="mt-5 text-[11px] text-gray-400 flex items-center gap-1 font-medium">
                    <span>06-18</span>
                    <span>•</span>
                    <span>北京</span>
                  </div>
                    <div className="h-10"></div>
                    <div className="pt-4 border-t border-gray-100">
                      <div className="text-[12px] text-gray-400 mb-2">共 {content.comments} 条评论</div>
                      <div className="flex gap-2 items-start opacity-60">
                        <div className="size-6 rounded-full bg-gray-200 shrink-0"></div>
                        <div className="text-[13px] text-gray-800">
                          <span className="font-medium text-gray-500 text-[12px] mr-1">桃子:</span> 这也太好看了吧！裤子有链接吗？
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="border-t border-gray-100 px-5 py-3 flex justify-between items-center bg-white/95 glass-blur absolute bottom-0 w-full z-30 pb-7">
                  <div className="flex items-center gap-2 bg-gray-100 px-4 py-2.5 rounded-full flex-1 mr-4 cursor-text">
                    <span className="material-symbols-outlined text-gray-400 text-[18px]">edit</span>
                    <span className="text-[13px] text-gray-400">说点什么...</span>
                  </div>
                  <div className="flex items-center gap-4 text-gray-600">
                    <div className="flex flex-col items-center gap-0.5 group">
                      <span className="material-symbols-outlined text-[24px] group-hover:text-xhs-red transition-colors">favorite_border</span>
                      <span className="text-[9px] font-medium">{content.likes}</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5 group">
                      <span className="material-symbols-outlined text-[24px] group-hover:text-yellow-500 transition-colors">star_border</span>
                      <span className="text-[9px] font-medium">{content.stars}</span>
                    </div>
                    <div className="flex flex-col items-center gap-0.5 group">
                      <span className="material-symbols-outlined text-[24px] group-hover:text-blue-500 transition-colors">chat_bubble_outline</span>
                      <span className="text-[9px] font-medium">{content.comments}</span>
                    </div>
                  </div>
                </div>
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-[35%] h-1 bg-black/80 rounded-full z-40"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {isImageViewerOpen && (
        <div
          ref={viewerOverlayRef}
          className="fixed inset-0 z-[80] bg-black/88 backdrop-blur-md"
          onClick={closeImageViewer}
        >
          <div className="pointer-events-none absolute left-5 top-5 z-20 rounded-full bg-black/45 px-3 py-1.5 text-xs text-white/75 backdrop-blur">
            第 {activeImageIndex + 1} / {Math.max(imageCount, 1)} 张 · {Math.round(viewerScale * 100)}%
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              closeImageViewer();
            }}
            className="absolute right-5 top-5 z-30 flex h-10 w-10 items-center justify-center rounded-full bg-white/92 text-slate-950 shadow-lg transition hover:bg-white"
            title="关闭"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>

          <div ref={viewerStageRef} className="absolute inset-0 overflow-hidden p-8">
            <div className="relative h-full w-full">
              <div
                className={`absolute left-1/2 top-1/2 origin-center select-none ${viewerScale > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in'}`}
                style={{
                  transform: `translate(-50%, -50%) translate3d(${viewerOffset.x}px, ${viewerOffset.y}px, 0) scale(${viewerScale})`,
                  touchAction: 'none',
                }}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  if (viewerScale <= 1) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragStartRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    originX: viewerOffset.x,
                    originY: viewerOffset.y,
                  };
                }}
                onPointerMove={(event) => {
                  const dragState = dragStartRef.current;
                  if (!dragState || dragState.pointerId !== event.pointerId) return;
                  event.stopPropagation();
                  const nextOffset = {
                    x: dragState.originX + event.clientX - dragState.startX,
                    y: dragState.originY + event.clientY - dragState.startY,
                  };
                  viewerOffsetRef.current = nextOffset;
                  setViewerOffset(nextOffset);
                }}
                onPointerUp={(event) => {
                  if (dragStartRef.current?.pointerId === event.pointerId) {
                    dragStartRef.current = null;
                  }
                }}
                onPointerCancel={() => {
                  dragStartRef.current = null;
                }}
              >
                <div
                  className="overflow-hidden rounded-[18px] bg-[#f5f3ef] shadow-[0_28px_90px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
                  onDragStart={(event) => event.preventDefault()}
                >
                  {isTemplateComposeAsset && activeAsset ? (
                    <div draggable={false}>
                      <TemplateAssetPreview asset={activeAsset} className="h-[min(86vh,980px)] w-[min(78vw,760px)]" mode="full" />
                    </div>
                  ) : (
                    <img
                      alt="大图预览"
                      src={content.mainImageUrl}
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                      className="max-h-[86vh] max-w-[88vw] bg-[#f5f3ef] object-contain"
                    />
                  )}
                </div>
              </div>
            </div>
            {imageCount > 1 && onPrevImage && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  resetImageViewer();
                  onPrevImage();
                }}
                className="fixed left-6 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white backdrop-blur transition hover:bg-white/22"
                title="上一张"
              >
                <span className="material-symbols-outlined text-[24px]">chevron_left</span>
              </button>
            )}
            {imageCount > 1 && onNextImage && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  resetImageViewer();
                  onNextImage();
                }}
                className="fixed right-6 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/12 text-white backdrop-blur transition hover:bg-white/22"
                title="下一张"
              >
                <span className="material-symbols-outlined text-[24px]">chevron_right</span>
              </button>
            )}
          </div>
          <div
            className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/55 p-1.5 shadow-2xl backdrop-blur-xl"
            data-viewer-control="true"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => updateViewerScale(viewerScale / 1.12)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white transition hover:bg-white/12"
              title="缩小"
            >
              <span className="material-symbols-outlined text-[19px]">zoom_out</span>
            </button>
            <button
              type="button"
              onClick={resetImageViewer}
              className="h-9 rounded-full px-3 text-xs font-semibold text-white transition hover:bg-white/12"
            >
              适应
            </button>
            <button
              type="button"
              onClick={() => updateViewerScale(viewerScale * 1.12)}
              className="flex h-9 w-9 items-center justify-center rounded-full text-white transition hover:bg-white/12"
              title="放大"
            >
              <span className="material-symbols-outlined text-[19px]">zoom_in</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default PreviewFrame;
