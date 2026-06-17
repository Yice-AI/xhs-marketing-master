import React from 'react';
import { BenchmarkNote } from '../types';
import { getCanonicalImageSequence } from '../lib/scraperData';
import NoteCoverImage from './NoteCoverImage';

export type PreviewSource = 'raw' | 'categorized' | 'benchmark';

export interface PreviewNote {
  note: BenchmarkNote;
  source: PreviewSource;
}

interface NotePreviewOverlayProps {
  preview: PreviewNote | null;
  imageIndex: number;
  onImageChange: (index: number) => void;
  onClose: () => void;
  onSelectBenchmark: (note: BenchmarkNote) => void;
  onRewriteNow: (note: BenchmarkNote) => void;
}

const tierStyles: Record<string, string> = {
  强推荐: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
  可参考: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
  仅做灵感: 'bg-slate-500/15 text-slate-300 border-slate-500/20',
};

const sourceLabelStyles: Record<PreviewSource, string> = {
  raw: 'bg-slate-100 text-slate-600 border-slate-200',
  categorized: 'bg-sky-50 text-sky-600 border-sky-100',
  benchmark: 'bg-emerald-50 text-emerald-600 border-emerald-100',
};

const sourceLabels: Record<PreviewSource, string> = {
  raw: '原始采集',
  categorized: 'AI 分类',
  benchmark: '仿写样本',
};

const categoryBadgeStyle = 'rounded-full bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600';
const contentFontFamily = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","SF Pro Display","Segoe UI","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

const formatDetailTimestamp = (timestamp?: number, publishedAtLabel?: string) => {
  if (publishedAtLabel?.trim()) {
    return publishedAtLabel.trim();
  }
  if (!timestamp) return '发布时间未知';
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '发布时间未知';
  const normalized = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(normalized).toLocaleDateString();
};

const compactMetric = (value?: string | number) => {
  if (value === undefined || value === null || value === '') {
    return '0';
  }
  return String(value);
};

const formatCommentTimestamp = (timestamp?: number) => {
  if (!timestamp) return '';
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '';
  const normalized = value < 1_000_000_000_000 ? value * 1000 : value;
  return new Date(normalized).toLocaleDateString();
};

const NotePreviewOverlay: React.FC<NotePreviewOverlayProps> = ({
  preview,
  imageIndex,
  onImageChange,
  onClose,
  onSelectBenchmark,
  onRewriteNow,
}) => {
  if (!preview) {
    return null;
  }

  const { note, source } = preview;
  const detailImages = getCanonicalImageSequence(note);
  const currentDetailImage = detailImages[imageIndex] || note.imageUrl;
  const detailContent = String(note.desc || '').replace(/\r\n/g, '\n').trim();
  const commentItems = (note.comments || []).filter((comment) => Boolean(comment?.content?.trim())).slice(0, 8);
  const isRawPreview = source === 'raw';
  const isCategorizedPreview = source === 'categorized';
  const isBenchmarkPreview = source === 'benchmark';
  const metrics = [
    { label: '点赞', value: compactMetric(note.likes), icon: 'favorite_border' },
    { label: '收藏', value: compactMetric(note.stars), icon: 'star_border' },
    { label: '评论', value: compactMetric(note.commentCount), icon: 'chat_bubble_outline' },
    { label: isRawPreview ? '分享' : '仿写值', value: isRawPreview ? compactMetric(note.shares) : compactMetric(note.rewrite_value_score), icon: 'share' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 backdrop-blur-md px-4 py-6"
      onClick={onClose}
    >
      <div
        className="relative flex h-[min(84vh,820px)] w-full max-w-[1240px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#111214] shadow-[0_40px_120px_rgba(0,0,0,0.45)]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-5 top-5 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/30 text-white transition hover:bg-black/55"
          aria-label="关闭预览"
        >
          <span className="material-symbols-outlined text-[18px]">close</span>
        </button>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,0.85fr)]">
          <section className="bg-[#161719] px-5 py-5">
            <div className="flex h-full flex-col">
              <div className="relative mx-auto h-full max-h-[680px] w-full overflow-hidden rounded-[24px] bg-[#1a1a1d] shadow-[0_18px_50px_rgba(0,0,0,0.25)]">
                {currentDetailImage ? (
                  <NoteCoverImage
                    key={`${note.id}-${imageIndex}`}
                    imageUrl={currentDetailImage}
                    stableImageUrl={note.stableImageList?.[imageIndex] || (imageIndex === 0 ? note.stableImageUrl : undefined)}
                    resolvedImageUrl={note.resolvedImageList?.[imageIndex] || (imageIndex === 0 ? note.resolvedImageUrl : undefined)}
                    alt={note.title}
                    className="h-full w-full object-contain bg-[#f3f4f6]"
                    preferImageUrl
                    loading="eager"
                    fetchPriority="high"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-sm text-slate-500">暂无图片</div>
                )}

                <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/35 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/55 to-transparent" />

                {detailImages.length > 1 && (
                  <>
                    <button
                      onClick={() => onImageChange(imageIndex === 0 ? detailImages.length - 1 : imageIndex - 1)}
                      className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
                      aria-label="上一张"
                    >
                      <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                    </button>
                    <button
                      onClick={() => onImageChange(imageIndex === detailImages.length - 1 ? 0 : imageIndex + 1)}
                      className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/70"
                      aria-label="下一张"
                    >
                      <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                    </button>
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs text-white">
                      {imageIndex + 1} / {detailImages.length}
                    </div>
                  </>
                )}
              </div>

              {detailImages.length > 1 && (
                <div className="mt-4 flex justify-center gap-2 overflow-x-auto custom-scrollbar pb-1">
                  {detailImages.map((image, index) => (
                    <button
                      key={`${note.id}-${index}`}
                      onClick={() => onImageChange(index)}
                      className={`h-16 w-12 shrink-0 overflow-hidden rounded-[18px] border transition ${
                        imageIndex === index ? 'border-white/90 shadow-[0_10px_20px_rgba(255,255,255,0.14)]' : 'border-white/15 opacity-70'
                      }`}
                      aria-label={`查看第 ${index + 1} 张`}
                    >
                      <NoteCoverImage
                        imageUrl={image}
                        stableImageUrl={note.stableImageList?.[index] || (index === 0 ? note.stableImageUrl : undefined)}
                        resolvedImageUrl={note.resolvedImageList?.[index] || (index === 0 ? note.resolvedImageUrl : undefined)}
                        alt={`${note.title}-${index + 1}`}
                        className="h-full w-full object-cover"
                        preferImageUrl
                        loading="lazy"
                        fetchPriority="low"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="min-h-0 bg-[#f4f5f7]">
            <div className="flex h-full min-h-0 flex-col px-4 py-4 lg:px-5 lg:py-5">
              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[30px] border border-black/5 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.08)]">
              <div className="shrink-0 px-6 pb-4 pt-6">
                <div className="flex items-start gap-3">
                  <NoteCoverImage
                    imageUrl={note.authorAvatar || 'https://picsum.photos/64/64?random=66'}
                    alt={note.author}
                    className="h-11 w-11 rounded-full border border-black/5 object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate text-[15px] font-semibold text-[#222]">{note.author || '未知作者'}</div>
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${sourceLabelStyles[source]}`}>
                        {sourceLabels[source]}
                      </span>
                      {!isRawPreview && (
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium ${tierStyles[note.recommendation_tier] || tierStyles['可参考']}`}>
                          {note.recommendation_tier}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#8c8c93]">
                      <span>{formatDetailTimestamp(note.time, note.publishedAtLabel)}</span>
                      {note.ipLocation && (
                        <>
                          <span>·</span>
                          <span>{note.ipLocation}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <button className="hidden sm:inline-flex items-center justify-center rounded-full bg-xhs-red px-8 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(255,36,66,0.2)]">
                    关注
                  </button>
                </div>

                <div className="mt-4 space-y-3">
                  <h3 className="max-w-[95%] text-[18px] font-semibold leading-8 text-[#191919]" style={{ fontFamily: contentFontFamily }}>{note.title || '无标题'}</h3>
                  <div className="flex flex-wrap gap-2">
                    {!!note.content_category && (
                      <span className="rounded-full bg-rose-500/14 px-2.5 py-1 text-[11px] text-rose-300">
                        预设分类 · {note.content_category}
                      </span>
                    )}
                    {isCategorizedPreview && (
                      <span className={categoryBadgeStyle}>已进入 AI 分类浏览池</span>
                    )}
                    {isBenchmarkPreview && note.material_dependency && (
                      <span className={categoryBadgeStyle}>{note.material_dependency}</span>
                    )}
                    {isBenchmarkPreview && (
                      <span className="rounded-full bg-rose-500/12 px-2.5 py-1 text-[11px] text-rose-300">仿写值 {note.rewrite_value_score}</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-6 py-5">
                <div className="space-y-5">
                  {!!note.tags?.length && (
                    <div className="flex flex-wrap gap-x-2 gap-y-2">
                      {note.tags.map((tag) => (
                        <span key={`${note.id}-${tag}`} className="text-[13px] font-medium text-[#5d77d9]">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="rounded-[24px] bg-[#fbfbfc] px-4 py-4">
                    <div
                      className="max-h-[420px] overflow-y-auto custom-scrollbar pr-2 text-[15px] leading-8 text-[#2c2c2c] whitespace-pre-wrap break-words"
                      style={{ fontFamily: contentFontFamily }}
                    >
                      {detailContent || '暂无正文'}
                    </div>
                  </div>

                  <div className="border-t border-[#f0f0f2] pt-5">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <div className="text-[15px] font-semibold text-[#202020]">评论区</div>
                      <div className="text-sm text-[#8b8b94]">共 {compactMetric(note.commentCount)} 条评论</div>
                    </div>

                    {commentItems.length > 0 ? (
                      <div className="max-h-[320px] space-y-0 overflow-y-auto custom-scrollbar rounded-[20px] bg-[#fcfcfd] px-3">
                        {commentItems.map((comment, index) => {
                          const commentTime = formatCommentTimestamp(comment.time);
                          return (
                            <div
                              key={comment.id || `${note.id}-comment-${index}`}
                              className="flex gap-3 border-b border-[#f0f0f2] py-4 last:border-b-0"
                            >
                              <NoteCoverImage
                                imageUrl={comment.avatar || 'https://picsum.photos/48/48?random=91'}
                                alt={comment.userName || `评论用户${index + 1}`}
                                className="h-9 w-9 shrink-0 rounded-full object-cover"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-[#333]">
                                      {comment.userName || `匿名用户 ${index + 1}`}
                                    </div>
                                    {(commentTime || comment.replyCount) && (
                                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#9b9ba1]">
                                        {commentTime && <span>{commentTime}</span>}
                                        {comment.replyCount && <span>回复 {compactMetric(comment.replyCount)}</span>}
                                      </div>
                                    )}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-1 text-[#a0a0a7]">
                                    <span className="material-symbols-outlined text-[16px]">favorite</span>
                                    <span className="text-xs">{compactMetric(comment.likeCount)}</span>
                                  </div>
                                </div>
                                <p
                                  className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-6 text-[#2b2b2b]"
                                  style={{ fontFamily: contentFontFamily }}
                                >
                                  {comment.content}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-2xl bg-[#fafafc] px-4 py-4 text-sm leading-6 text-[#9999a1]">
                        这篇笔记当前没有采到评论正文。
                      </div>
                    )}
                  </div>

                  {!isRawPreview && note.recommendation_reason && (
                    <div className="rounded-[18px] bg-[#fafafc] p-4">
                      <div className="mb-2 text-xs font-semibold tracking-[0.16em] text-[#8f8f97]">参考说明</div>
                      <p className="text-sm leading-6 text-[#5c5c62]">{note.recommendation_reason}</p>
                    </div>
                  )}

                  {!isRawPreview && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-[18px] bg-[#fafafc] p-4">
                        <div className="text-xs text-[#8e8e96]">商业适配</div>
                        <div className="mt-2 text-base font-semibold text-[#242424]">{compactMetric(note.commercial_fit_score)}</div>
                      </div>
                      <div className="rounded-[18px] bg-[#fafafc] p-4">
                        <div className="text-xs text-[#8e8e96]">素材依赖</div>
                        <div className="mt-2 text-sm font-semibold text-[#242424]">{note.material_dependency || '待分析'}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="shrink-0 border-t border-[#f0f0f2] bg-white px-6 py-4">
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-3 overflow-x-auto">
                    <div className="flex items-center gap-5">
                      <div className="flex items-center gap-1.5 text-[#64646d]">
                        <span className="rounded-full bg-[#f5f5f7] p-2">
                          <span className="material-symbols-outlined text-[19px]">chat_bubble_outline</span>
                        </span>
                        <span className="text-[13px] text-[#9a9aa2]">说点什么...</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-5 shrink-0">
                      {metrics.map((metric) => (
                        <button key={metric.label} className="flex items-center gap-1.5 text-[#52525b]">
                          <span className="material-symbols-outlined text-[22px]">{metric.icon}</span>
                          <span className="text-[14px]">{metric.value}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs leading-5 text-[#9999a2]">
                      {isRawPreview ? '原始采集内容也可以直接加入当前仿写池。' : '预览只负责浏览和选样本，不会打断当前采集工作流。'}
                    </div>
                    <div className="flex items-center justify-end gap-3">
                      <button
                        onClick={onClose}
                        className="rounded-xl border border-[#e7e7ec] bg-[#fafafc] px-4 py-2.5 text-sm text-[#44444d] transition hover:bg-[#f1f1f5]"
                      >
                        返回
                      </button>
                      <button
                        onClick={() => onSelectBenchmark(note)}
                        className="rounded-xl border border-[#e7e7ec] bg-[#fafafc] px-4 py-2.5 text-sm text-[#44444d] transition hover:bg-[#f1f1f5]"
                      >
                        选为对标样本
                      </button>
                      <button
                        onClick={() => onRewriteNow(note)}
                        className="rounded-xl bg-xhs-red px-4 py-2.5 text-sm font-medium text-white shadow-[0_10px_24px_rgba(255,36,66,0.26)] transition hover:bg-xhs-dark"
                      >
                        一键仿写
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default NotePreviewOverlay;
