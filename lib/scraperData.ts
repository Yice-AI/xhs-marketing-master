import {
  AnalysisResult,
  BenchmarkNote,
  DEFAULT_SEARCH_FILTERS,
  ProductBrief,
  ScrapedComment,
  ScrapeHistoryRecord,
  ScrapedNote,
  SearchFilters,
} from '../types';

const DEFAULT_NOTE_COVER = 'https://picsum.photos/400/533?grayscale&blur=1';
const SCRAPER_IMAGE_PROXY_PREFIX = '/api/scraper/image-proxy?url=';
const XHS_IMAGE_HOST_PATTERNS = ['xhscdn.com', 'xiaohongshu.com'];
const CONTENT_CATEGORIES: Record<string, string[]> = {
  测评类: ['测评', '评测', '实测', '对比', '开箱', '试用', '体验', '实拍'],
  主推产品类: ['必入', '推荐', '种草', '安利', '回购', '闭眼入', '宝藏', '神器', '好物'],
  场景种草类: ['通勤', '租房', '卧室', '桌面', '办公室', '约会', '出差', '旅行', '日常'],
  分享经验类: ['分享', '经验', '总结', '合集', '清单', '干货', '攻略', '方法'],
  对比避坑类: ['避坑', '别买', '千万别', '平替', '踩雷', '对比', '选购', '区别'],
  情绪共鸣类: ['治愈', '崩溃', '焦虑', '后悔', '感动', '救命', '谁懂', '被拿捏', '破防'],
  教程类: ['教程', '步骤', '怎么', '如何', '手把手', '新手', '指南', '入门'],
};

const normalizeMediaUrl = (value?: string | null): string => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('//')
    ? `https:${trimmed}`
    : trimmed;
};

const splitImageString = (value?: string | null): string[] => {
  const normalized = normalizeMediaUrl(value);
  if (!normalized) return [];
  if (!normalized.includes(',')) {
    return [normalized];
  }
  return normalized
    .split(',')
    .map((item) => normalizeMediaUrl(item))
    .filter(Boolean);
};

const pickPreferredImageUrl = (value: any): string => {
  if (!value) return '';
  if (typeof value === 'string') {
    return splitImageString(value)[0] || '';
  }
  if (typeof value !== 'object') {
    return '';
  }

  const candidates = [
    value.urlDefault,
    value.url_default,
    value.url,
    value.url_pre,
    Array.isArray(value.info_list) ? value.info_list[0]?.url : '',
  ];

  for (const candidate of candidates) {
    const normalized = normalizeMediaUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
};

const extractImageUrlsFromMixedField = (value: any): string[] => {
  if (!value) return [];
  if (typeof value === 'string') {
    return splitImageString(value);
  }
  if (!Array.isArray(value)) {
    const preferred = pickPreferredImageUrl(value);
    return preferred ? [preferred] : [];
  }
  return value
    .flatMap((item) => {
      if (typeof item === 'string') {
        return splitImageString(item);
      }
      const preferred = pickPreferredImageUrl(item);
      return preferred ? [preferred] : [];
    })
    .filter(Boolean);
};

const choosePrimaryImageSequence = (...sources: any[]): string[] => {
  for (const source of sources) {
    const images = dedupeImageUrls(extractImageUrlsFromMixedField(source));
    if (images.length > 0) {
      return images;
    }
  }
  return [];
};

const normalizeImageIdentity = (value?: string | null): string => {
  const normalized = normalizeMediaUrl(value);
  if (!normalized) return '';
  let candidate = normalized;
  if (candidate.startsWith(SCRAPER_IMAGE_PROXY_PREFIX)) {
    const encoded = candidate.slice(SCRAPER_IMAGE_PROXY_PREFIX.length);
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = encoded;
    }
  }
  if (candidate.startsWith('http://')) {
    candidate = candidate.replace(/^http:\/\//i, 'https://');
  }
  if (XHS_IMAGE_HOST_PATTERNS.some((pattern) => candidate.includes(pattern))) {
    const withoutVariant = candidate.replace(/![^/?#]+(?=($|[?#]))/, '');
    const withoutQuery = withoutVariant.split('?')[0].split('#')[0];
    const lastSegment = withoutQuery.split('/').filter(Boolean).pop() || '';
    if (lastSegment) {
      return lastSegment;
    }
  }
  return candidate;
};

export const dedupeImageUrls = (values: Array<string | null | undefined>): string[] => {
  const unique = new Map<string, string>();
  values.forEach((value) => {
    const normalized = normalizeMediaUrl(value);
    const identity = normalizeImageIdentity(normalized);
    if (!normalized || !identity || unique.has(identity)) {
      return;
    }
    unique.set(identity, normalized);
  });
  return Array.from(unique.values());
};

const parsePublishedAtLabelTimestamp = (value?: string | null): number | undefined => {
  if (!value || typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const relativeDayMatch = trimmed.match(/^(\d+)\s*天前$/);
  if (trimmed === '今天') {
    return now.getTime();
  }
  if (trimmed === '昨天') {
    return todayStart - 24 * 60 * 60 * 1000;
  }
  if (trimmed === '前天') {
    return todayStart - 2 * 24 * 60 * 60 * 1000;
  }
  if (relativeDayMatch) {
    return now.getTime() - Number(relativeDayMatch[1]) * 24 * 60 * 60 * 1000;
  }
  const relativeHourMatch = trimmed.match(/^(\d+)\s*小时前$/);
  if (relativeHourMatch) {
    return now.getTime() - Number(relativeHourMatch[1]) * 60 * 60 * 1000;
  }
  const relativeMinuteMatch = trimmed.match(/^(\d+)\s*分钟前$/);
  if (relativeMinuteMatch) {
    return now.getTime() - Number(relativeMinuteMatch[1]) * 60 * 1000;
  }

  const monthDayMatch = trimmed.match(/^(\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (monthDayMatch) {
    const month = Number(monthDayMatch[1]);
    const day = Number(monthDayMatch[2]);
    const hour = Number(monthDayMatch[3] || 0);
    const minute = Number(monthDayMatch[4] || 0);
    let candidate = new Date(now.getFullYear(), month - 1, day, hour, minute, 0, 0).getTime();
    if (candidate > now.getTime() + 5 * 60 * 1000) {
      candidate = new Date(now.getFullYear() - 1, month - 1, day, hour, minute, 0, 0).getTime();
    }
    return Number.isFinite(candidate) ? candidate : undefined;
  }

  const normalized = trimmed
    .replace(/[.]/g, '-')
    .replace(/[年]/g, '-')
    .replace(/[月]/g, '-')
    .replace(/[日]/g, '')
    .replace(/\//g, '-');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getPublishTimeCutoffMs = (publishTime?: string | null): number | null => {
  const now = Date.now();
  switch (publishTime) {
    case '一天内':
      return now - 24 * 60 * 60 * 1000;
    case '一周内':
      return now - 7 * 24 * 60 * 60 * 1000;
    case '两周内':
      return now - 14 * 24 * 60 * 60 * 1000;
    case '半年内':
      return now - 183 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
};

export const matchesPublishTimeFilter = (
  note: Pick<ScrapedNote, 'time' | 'publishedAtLabel'>,
  publishTime?: string | null,
): boolean => {
  const cutoffMs = getPublishTimeCutoffMs(publishTime);
  if (cutoffMs === null) {
    return true;
  }

  const timestamp = note.time ?? parsePublishedAtLabelTimestamp(note.publishedAtLabel);
  if (timestamp === undefined) {
    return true;
  }

  return timestamp >= cutoffMs && timestamp <= Date.now() + 5 * 60 * 1000;
};

export const filterNotesByPublishTime = (
  notes: ScrapedNote[],
  publishTime?: string | null,
): ScrapedNote[] => notes.filter((note) => matchesPublishTimeFilter(note, publishTime));

export const getCanonicalImageSequence = (note: Partial<ScrapedNote>): string[] => {
  const primary = dedupeImageUrls(note.imageList || []);
  if (primary.length > 0) {
    return primary;
  }
  const stable = dedupeImageUrls(note.stableImageList || []);
  if (stable.length > 0) {
    return stable;
  }
  const resolved = dedupeImageUrls(note.resolvedImageList || []);
  if (resolved.length > 0) {
    return resolved;
  }
  const fallback = dedupeImageUrls([note.imageUrl]);
  if (fallback.length > 0) {
    return fallback;
  }
  const stableFallback = dedupeImageUrls([note.stableImageUrl]);
  if (stableFallback.length > 0) {
    return stableFallback;
  }
  const resolvedFallback = dedupeImageUrls([note.resolvedImageUrl]);
  if (resolvedFallback.length > 0) {
    return resolvedFallback;
  }
  return [];
};

export const hasResolvedImageEntries = (values?: Array<string | null | undefined>): boolean =>
  Array.isArray(values) && values.some((value) => typeof value === 'string' && value.trim().length > 0);

export const normalizeResolvedImageList = (
  values: Array<string | null | undefined> | undefined,
  imageCount: number
): string[] | undefined => {
  if (!values && imageCount <= 0) {
    return undefined;
  }

  const normalizedLength = imageCount > 0 ? imageCount : (values?.length || 0);
  if (normalizedLength <= 0) {
    return undefined;
  }

  const normalized = Array.from({ length: normalizedLength }, (_, index) => {
    const value = values?.[index];
    return typeof value === 'string' ? value.trim() : '';
  });

  return hasResolvedImageEntries(normalized) ? normalized : undefined;
};

export const mergeResolvedImageLists = (
  existing: Array<string | null | undefined> | undefined,
  incoming: Array<string | null | undefined> | undefined,
  imageCount: number
): string[] | undefined => {
  const normalizedLength = imageCount > 0 ? imageCount : Math.max(existing?.length || 0, incoming?.length || 0);
  if (normalizedLength <= 0) {
    return undefined;
  }

  const merged = Array.from({ length: normalizedLength }, (_, index) => {
    const next = typeof incoming?.[index] === 'string' ? incoming[index]!.trim() : '';
    if (next) {
      return next;
    }
    const prev = typeof existing?.[index] === 'string' ? existing[index]!.trim() : '';
    return prev;
  });

  return hasResolvedImageEntries(merged) ? merged : undefined;
};

const isStableImageCandidate = (value: string) => {
  if (!value) return false;
  if (value.startsWith('data:image/')) return true;
  if (value.startsWith('/')) return true;
  return XHS_IMAGE_HOST_PATTERNS.some((pattern) => value.includes(pattern));
};

export const buildStableImageUrl = (value?: string | null): string => {
  const normalized = normalizeMediaUrl(value);
  if (!normalized) return '';
  if (normalized.startsWith('data:image/') || normalized.startsWith('/')) {
    return normalized;
  }
  if (!isStableImageCandidate(normalized)) {
    return normalized;
  }
  if (normalized.startsWith(SCRAPER_IMAGE_PROXY_PREFIX)) {
    return normalized;
  }
  const httpsNormalized = normalized.startsWith('http://')
    ? normalized.replace(/^http:\/\//i, 'https://')
    : normalized;
  return `${SCRAPER_IMAGE_PROXY_PREFIX}${encodeURIComponent(httpsNormalized)}`;
};

const normalizeStableImageList = (values: Array<string | null | undefined>): string[] => (
  dedupeImageUrls(values.map((value) => buildStableImageUrl(value)))
);

const normalizeCommentItem = (comment: any): ScrapedComment | null => {
  if (typeof comment === 'string') {
    const content = comment.trim();
    return content ? { content } : null;
  }
  if (!comment || typeof comment !== 'object') {
    return null;
  }
  const content = String(
    comment.content
      || comment.text
      || comment.comment_text
      || ''
  ).trim();
  if (!content) {
    return null;
  }
  return {
    id: comment.id || comment.comment_id || undefined,
    userName: comment.userName || comment.nickname || comment.user_name || comment.user?.nickname || undefined,
    avatar: normalizeMediaUrl(comment.avatar || comment.user?.avatar || comment.user_info?.image || comment.user_info?.avatar || ''),
    content,
    likeCount: comment.likeCount !== undefined ? String(comment.likeCount) : comment.like_count !== undefined ? String(comment.like_count) : undefined,
    replyCount: comment.replyCount !== undefined ? String(comment.replyCount) : comment.sub_comment_count !== undefined ? String(comment.sub_comment_count) : undefined,
    time: typeof comment.time === 'number'
      ? comment.time
      : typeof comment.create_time === 'number'
        ? comment.create_time
        : undefined,
  };
};

const normalizeTimestampValue = (value: any): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) {
        return undefined;
      }
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }

    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const extractPublishedTimestamp = (note: any): number | undefined => {
  const candidates = [
    note?.time,
    note?.note_card?.time,
    note?.note_card?.create_time,
    note?.detail?.time,
    note?.detail?.create_time,
    note?.detail?.note_card?.time,
    note?.detail?.note_card?.create_time,
    note?.create_time,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeTimestampValue(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  return undefined;
};

const normalizePublishedAtLabel = (value: any): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return undefined;
  }

  return trimmed;
};

const extractPublishedAtLabel = (note: any): string | undefined => {
  const candidates = [
    note?.publishedAtLabel,
    note?.published_at_label,
    note?.create_date_time,
    note?.published_at,
    note?.publishedAt,
    note?.publish_time_text,
    note?.publishTimeText,
    note?.note_card?.create_date_time,
    note?.note_card?.published_at,
    note?.note_card?.publishedAt,
    note?.note_card?.create_time_text,
    note?.detail?.note_card?.create_date_time,
    note?.detail?.note_card?.published_at,
    note?.detail?.note_card?.publishedAt,
    note?.detail?.note_card?.create_time_text,
    note?.detail?.create_date_time,
    note?.detail?.published_at,
    note?.detail?.publishedAt,
  ];

  for (const candidate of candidates) {
    const normalized = normalizePublishedAtLabel(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
};

const extractComments = (note: any): ScrapedComment[] => {
  const rawComments = Array.isArray(note?.comments)
    ? note.comments
    : Array.isArray(note?.comment_list)
      ? note.comment_list
      : [];
  return rawComments.map(normalizeCommentItem).filter((item): item is ScrapedComment => Boolean(item));
};

const extractCommentCount = (note: any, comments: ScrapedComment[]): string => {
  const candidate = (
    note?.note_card?.interact_info?.comment_count
    || note?.detail?.interactInfo?.commentCount
    || note?.detail?.interact_info?.comment_count
    || note?.commentCount
    || note?.comment_count
  );
  if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
    return String(candidate);
  }
  return comments.length > 0 ? String(comments.length) : '0';
};

const extractHistoryImageCandidates = (note: any): string[] => {
  const primaryImages = choosePrimaryImageSequence(
    note?.detail?.imageList,
    note?.imageList,
    note?.image_list,
    note?.detail?.images_list,
    note?.note_card?.image_list
  );
  if (primaryImages.length > 0) {
    return primaryImages;
  }

  return dedupeImageUrls([
    pickPreferredImageUrl(note?.note_card?.cover),
    pickPreferredImageUrl(note?.detail?.cover),
  ]);
};

const extractImageCandidates = (note: any): string[] => {
  const primaryImages = choosePrimaryImageSequence(
    note?.imageList,
    note?.image_list,
    note?.detail?.imageList,
    note?.detail?.images_list,
    note?.note_card?.image_list
  );
  if (primaryImages.length > 0) {
    return primaryImages;
  }

  return dedupeImageUrls(
    [
      pickPreferredImageUrl(note?.note_card?.cover),
      pickPreferredImageUrl(note?.detail?.cover),
      note?.imageUrl,
      note?.image_url,
      note?.cover,
    ]
      .map((value) => typeof value === 'string' ? normalizeMediaUrl(value) : '')
      .filter((value): value is string => Boolean(value))
  );
};

const extractImageList = (note: any, fallbackSeed?: number): string[] => {
  const images = dedupeImageUrls(extractImageCandidates(note));
  if (images.length > 0) {
    return images;
  }
  return [`${DEFAULT_NOTE_COVER}&random=${fallbackSeed ?? 0}`];
};

const extractPrimaryImage = (note: any, fallbackSeed?: number): string => extractImageList(note, fallbackSeed)[0];
const isGeneratedPlaceholder = (value?: string | null) => Boolean(value && value.startsWith(DEFAULT_NOTE_COVER));

export const sanitizeSearchFilters = (filters?: Partial<SearchFilters> | null): SearchFilters => ({
  sortBy: filters?.sortBy || DEFAULT_SEARCH_FILTERS.sortBy,
  noteType: filters?.noteType || DEFAULT_SEARCH_FILTERS.noteType,
  publishTime: filters?.publishTime || DEFAULT_SEARCH_FILTERS.publishTime,
  searchScope: filters?.searchScope || DEFAULT_SEARCH_FILTERS.searchScope,
  location: filters?.location || DEFAULT_SEARCH_FILTERS.location,
});

export const buildNoteIdentity = (note: Partial<ScrapedNote>) => {
  const byId = String(note.id || '').trim();
  if (byId) return `id:${byId}`;
  const byUrl = String(note.noteUrl || '').trim();
  if (byUrl) return `url:${byUrl}`;
  const byTitle = `${String(note.title || '').trim()}|${String(note.author || '').trim()}`;
  return `title:${byTitle}`;
};

const dedupeScrapedNotes = (notes: ScrapedNote[]): ScrapedNote[] => {
  const unique = new Map<string, ScrapedNote>();
  notes.forEach((note) => {
    const identity = buildNoteIdentity(note);
    if (!identity) return;
    if (!unique.has(identity)) {
      unique.set(identity, note);
      return;
    }
    const existing = unique.get(identity)!;
    const nextImageList = dedupeImageUrls([...(existing.imageList || []), ...(note.imageList || [])]);
    const nextStableImageList = dedupeImageUrls([...(existing.stableImageList || []), ...(note.stableImageList || [])]);
    const nextResolvedImageList = mergeResolvedImageLists(existing.resolvedImageList, note.resolvedImageList, nextImageList.length);
    const nextComments = [...(existing.comments || [])];
    (note.comments || []).forEach((comment) => {
      if (!nextComments.some((item) => item.content === comment.content && item.userName === comment.userName)) {
        nextComments.push(comment);
      }
    });
    unique.set(identity, {
      ...existing,
      ...note,
      imageUrl: existing.imageUrl || note.imageUrl,
      imageList: nextImageList,
      stableImageUrl: existing.stableImageUrl || note.stableImageUrl || nextStableImageList[0],
      stableImageList: nextStableImageList,
      resolvedImageUrl: existing.resolvedImageUrl || note.resolvedImageUrl,
      resolvedImageList: nextResolvedImageList,
      comments: nextComments,
      commentCount: String(Math.max(Number(existing.commentCount || 0), Number(note.commentCount || 0), nextComments.length)),
    });
  });
  return Array.from(unique.values());
};

export const dedupeBenchmarkNotes = (notes: BenchmarkNote[]): BenchmarkNote[] => {
  const unique = new Map<string, BenchmarkNote>();
  notes.forEach((note) => {
    const identity = buildNoteIdentity(note);
    if (!unique.has(identity)) {
      unique.set(identity, note);
      return;
    }
    const existing = unique.get(identity)!;
    const nextImageList = dedupeImageUrls([...(existing.imageList || []), ...(note.imageList || [])]);
    const nextStableImageList = dedupeImageUrls([...(existing.stableImageList || []), ...(note.stableImageList || [])]);
    const nextResolvedImageList = mergeResolvedImageLists(existing.resolvedImageList, note.resolvedImageList, nextImageList.length);
    const nextComments = [...(existing.comments || [])];
    (note.comments || []).forEach((comment) => {
      if (!nextComments.some((item) => item.content === comment.content && item.userName === comment.userName)) {
        nextComments.push(comment);
      }
    });
    unique.set(identity, {
      ...existing,
      ...note,
      imageUrl: existing.imageUrl || note.imageUrl,
      imageList: nextImageList,
      stableImageUrl: existing.stableImageUrl || note.stableImageUrl || nextStableImageList[0],
      stableImageList: nextStableImageList,
      resolvedImageUrl: existing.resolvedImageUrl || note.resolvedImageUrl,
      resolvedImageList: nextResolvedImageList,
      comments: nextComments,
      commentCount: String(Math.max(Number(existing.commentCount || 0), Number(note.commentCount || 0), nextComments.length)),
      commercial_fit_score: Math.max(Number(existing.commercial_fit_score || 0), Number(note.commercial_fit_score || 0)),
      rewrite_value_score: Math.max(Number(existing.rewrite_value_score || 0), Number(note.rewrite_value_score || 0)),
    });
  });
  return Array.from(unique.values());
};

export const formatScrapedNotes = (notes: any[]): ScrapedNote[] =>
  dedupeScrapedNotes(notes.map((note: any, index: number) => {
    const historyImages = Array.from(new Set(extractHistoryImageCandidates(note)));
    const comments = extractComments(note);
    const imageList = historyImages.length > 0 ? historyImages : extractImageList(note, index);
    const publishedTimestamp = extractPublishedTimestamp(note);
    const publishedAtLabel = extractPublishedAtLabel(note);
    const stableImageList = normalizeStableImageList(
      Array.isArray(note?.stableImageList) && note.stableImageList.length > 0
        ? note.stableImageList
        : imageList
    );

    return {
      imageUrl: historyImages[0] || extractPrimaryImage(note, index),
      imageList,
      stableImageUrl: typeof note.stableImageUrl === 'string' && note.stableImageUrl.trim()
        ? buildStableImageUrl(note.stableImageUrl)
        : stableImageList[0],
      stableImageList,
      resolvedImageUrl: typeof note.resolvedImageUrl === 'string' ? note.resolvedImageUrl : undefined,
      resolvedImageList: normalizeResolvedImageList(
        Array.isArray(note.resolvedImageList)
          ? note.resolvedImageList.filter((value: unknown): value is string => typeof value === 'string')
          : undefined,
        imageList.length
      ),
      id: note.id || `${index}`,
      title: note.note_card?.display_title || note.detail?.title || note.title || '',
      desc: note.detail?.desc || note.detail?.note_card?.desc || note.note_card?.desc || note.desc || '',
      author: note.note_card?.user?.nickname || note.note_card?.user?.nick_name || note.detail?.user?.nickname || note.author || '未知作者',
      authorAvatar: normalizeMediaUrl(note.note_card?.user?.avatar || note.note_card?.user?.avatar_url || note.authorAvatar) || 'https://picsum.photos/40/40?random=100',
      likes: String(note.note_card?.interact_info?.liked_count || note.detail?.interactInfo?.likedCount || note.likes || '0'),
      stars: String(note.note_card?.interact_info?.collected_count || note.detail?.interactInfo?.collectedCount || note.stars || '0'),
      views: String(note.note_card?.interact_info?.share_count || note.views || '0'),
      shares: String(note.note_card?.interact_info?.share_count || note.shares || '0'),
      tags: note.detail?.tags || note.tags || [],
      time: publishedTimestamp,
      publishedAtLabel,
      noteUrl: normalizeMediaUrl(note.noteUrl) || (note.id ? `https://www.xiaohongshu.com/explore/${note.id}` : undefined),
      commentCount: extractCommentCount(note, comments),
      comments,
    };
  }));

export const normalizeBenchmarkNote = (note: any, index: number): BenchmarkNote => {
  const imageList = extractImageList(note, index);

  return {
    id: note.id || `${index}`,
    title: note.title || note.note_card?.display_title || note.detail?.title || '',
    desc: note.desc || note.detail?.desc || '',
    author: note.author || note.note_card?.user?.nickname || note.detail?.user?.nickname || '对标样本',
    authorAvatar: normalizeMediaUrl(note.authorAvatar || note.note_card?.user?.avatar) || 'https://picsum.photos/40/40?random=88',
    likes: String(note.liked_count || note.likes || note.note_card?.interact_info?.liked_count || '0'),
    stars: String(note.collected_count || note.stars || note.note_card?.interact_info?.collected_count || '0'),
    views: String(note.views || '0'),
    shares: String(note.shares || '0'),
    imageUrl: extractPrimaryImage(note, index),
    imageList,
    stableImageUrl: typeof note.stableImageUrl === 'string' && note.stableImageUrl.trim()
      ? buildStableImageUrl(note.stableImageUrl)
      : normalizeStableImageList(
          Array.isArray(note.stableImageList) && note.stableImageList.length > 0
            ? note.stableImageList
            : imageList
        )[0],
    stableImageList: normalizeStableImageList(
      Array.isArray(note.stableImageList) && note.stableImageList.length > 0
        ? note.stableImageList
        : imageList
    ),
    resolvedImageUrl: typeof note.resolvedImageUrl === 'string' ? note.resolvedImageUrl : undefined,
    resolvedImageList: normalizeResolvedImageList(
      Array.isArray(note.resolvedImageList)
        ? note.resolvedImageList.filter((value: unknown): value is string => typeof value === 'string')
        : undefined,
      imageList.length
    ),
    tags: note.tag_list || note.tags || [],
    time: extractPublishedTimestamp(note),
    publishedAtLabel: extractPublishedAtLabel(note),
    commentCount: extractCommentCount(note, extractComments(note)),
    comments: extractComments(note),
    content_category: note.content_category || '分享经验类',
    category_scores: note.category_scores || {},
    secondary_categories: note.secondary_categories || [],
    commercial_fit_score: Number(note.commercial_fit_score || 0),
    rewrite_value_score: Number(note.rewrite_value_score || 0),
    recommendation_tier: note.recommendation_tier || '可参考',
    recommendation_reason: note.recommendation_reason || '',
    material_dependency: note.material_dependency || '纯概念',
  };
};

export const normalizeAnalysis = (data: any, fallbackProductBrief?: ProductBrief | null): AnalysisResult => {
  const benchmarkNotes: BenchmarkNote[] = dedupeBenchmarkNotes((data?.benchmark_notes || data?.benchmarkNotes || []).map(normalizeBenchmarkNote));
  const groupedSource = data?.grouped_benchmark_notes || data?.groupedBenchmarkNotes || {};
  let groupedEntries = Object.entries(groupedSource).reduce<Record<string, BenchmarkNote[]>>((acc, [category, notes]) => {
    acc[category] = dedupeBenchmarkNotes((notes as any[]).map(normalizeBenchmarkNote));
    return acc;
  }, {});

  if (Object.keys(groupedEntries).length === 0 && benchmarkNotes.length > 0) {
    groupedEntries = benchmarkNotes.reduce<Record<string, BenchmarkNote[]>>((acc, note) => {
      const category = note.content_category || '未分类待确认';
      acc[category] = acc[category] || [];
      acc[category].push(note);
      return acc;
    }, {});
  }

  return {
    viralNotesCount: data?.viral_notes_count ?? data?.viralNotesCount ?? 0,
    basicStats: {
      avgLikes: data?.basic_stats?.avg_likes ?? data?.basicStats?.avgLikes ?? 0,
      avgCollects: data?.basic_stats?.avg_collects ?? data?.basicStats?.avgCollects ?? 0,
      avgTitleLength: data?.basic_stats?.avg_title_length ?? data?.basicStats?.avgTitleLength ?? 0,
      emojiUsageRate: data?.basic_stats?.emoji_usage_rate ?? data?.basicStats?.emojiUsageRate ?? 0,
      avgComments: data?.basic_stats?.avg_comments ?? data?.basicStats?.avgComments ?? 0,
    },
    aiInsights: data?.ai_insights || data?.aiInsights || '',
    benchmarkNotes,
    groupedBenchmarkNotes: groupedEntries,
    categorySummary: data?.category_summary || data?.categorySummary || {},
    realPhrases: data?.real_phrases || data?.realPhrases || [],
    nextCollectionTasks: (data?.next_collection_tasks || data?.nextCollectionTasks || []).map((task: any) => ({
      ...task,
      filters: sanitizeSearchFilters(task.filters),
    })),
    productBrief: data?.product_brief || data?.productBrief || fallbackProductBrief || undefined,
  };
};

const classifyNote = (note: ScrapedNote): string => {
  const text = `${note.title || ''} ${note.desc || ''} ${(note.tags || []).join(' ')}`.toLowerCase();
  let bestCategory = '分享经验类';
  let bestScore = 0;

  Object.entries(CONTENT_CATEGORIES).forEach(([category, keywords]) => {
    const score = keywords.reduce((sum, keyword) => sum + (text.includes(keyword.toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  });

  return bestCategory;
};

const parseMetric = (value?: string) => {
  if (!value) return 0;
  const normalized = value.toLowerCase().replace(/,/g, '').trim();
  if (normalized.endsWith('w')) return Number(normalized.replace('w', '')) * 10000 || 0;
  if (normalized.endsWith('k')) return Number(normalized.replace('k', '')) * 1000 || 0;
  return Number(normalized) || 0;
};

export const buildFallbackAnalysis = (notes: ScrapedNote[], fallbackProductBrief?: ProductBrief | null): AnalysisResult => {
  const benchmarkNotes: BenchmarkNote[] = notes.map((note) => {
    const likes = parseMetric(note.likes);
    const stars = parseMetric(note.stars);
    const rewriteValue = Math.min(100, Math.round(35 + likes / 80 + stars / 60));
    const commercialFit = Math.min(100, Math.round(30 + stars / 70 + likes / 120));
    const recommendationTier = rewriteValue >= 82 ? '强推荐' : rewriteValue >= 64 ? '可参考' : '仅做灵感';
    const category = classifyNote(note);
    return {
      ...note,
      content_category: category,
      category_scores: {},
      secondary_categories: [],
      commercial_fit_score: commercialFit,
      rewrite_value_score: rewriteValue,
      recommendation_tier: recommendationTier,
      recommendation_reason: recommendationTier === '强推荐' ? '本地兜底分析判断该样本最适合优先仿写。' : '本地兜底分析已完成，可作为分类浏览和样本筛选参考。',
      material_dependency: category === '测评类' || category === '主推产品类' ? '需物料图' : category === '场景种草类' ? '需场景图' : '纯概念',
    };
  });

  const groupedBenchmarkNotes = benchmarkNotes.reduce<Record<string, BenchmarkNote[]>>((acc, note) => {
    acc[note.content_category] = acc[note.content_category] || [];
    acc[note.content_category].push(note);
    return acc;
  }, {});

  Object.values(groupedBenchmarkNotes).forEach((group) => {
    group.sort((a, b) => (
      (b.recommendation_tier === '强推荐' ? 1 : 0) - (a.recommendation_tier === '强推荐' ? 1 : 0) ||
      b.rewrite_value_score - a.rewrite_value_score ||
      b.commercial_fit_score - a.commercial_fit_score
    ));
  });

  const categorySummary = Object.entries(groupedBenchmarkNotes).reduce<Record<string, any>>((acc, [category, group]) => {
    const strongCount = group.filter((note) => note.recommendation_tier === '强推荐').length;
    acc[category] = {
      note_count: group.length,
      strong_recommend_count: strongCount,
      avg_rewrite_value_score: Math.round(group.reduce((sum, note) => sum + note.rewrite_value_score, 0) / group.length),
      benchmark_sufficiency: strongCount >= 3 ? '充足' : strongCount >= 1 ? '偏弱' : '不足',
      sufficiency_reason: strongCount >= 3 ? '本分类已有足够可参考样本。' : '本分类样本还不够强，建议补采更优内容。',
    };
    return acc;
  }, {});

  return {
    viralNotesCount: benchmarkNotes.filter((note) => note.recommendation_tier === '强推荐').length,
    basicStats: {
      avgLikes: benchmarkNotes.length ? Math.round(benchmarkNotes.reduce((sum, note) => sum + parseMetric(note.likes), 0) / benchmarkNotes.length) : 0,
      avgCollects: benchmarkNotes.length ? Math.round(benchmarkNotes.reduce((sum, note) => sum + parseMetric(note.stars), 0) / benchmarkNotes.length) : 0,
      avgTitleLength: benchmarkNotes.length ? Math.round(benchmarkNotes.reduce((sum, note) => sum + (note.title?.length || 0), 0) / benchmarkNotes.length) : 0,
      emojiUsageRate: 0,
      avgComments: 0,
    },
    aiInsights: '当前结果使用本地兜底分类展示，后端完整分析结果返回后会自动覆盖。',
    benchmarkNotes,
    groupedBenchmarkNotes,
    categorySummary,
    realPhrases: notes.flatMap((note) => {
      const commentPhrases = (note.comments || []).map((comment) => comment.content);
      if (commentPhrases.length > 0) {
        return commentPhrases;
      }
      return (note.desc || '').split(/[。！!？?\n]/);
    }).map((item) => item.trim()).filter((item) => item.length >= 6).slice(0, 12),
    nextCollectionTasks: [],
    productBrief: fallbackProductBrief || undefined,
  };
};

const buildRawNoteLookup = (notes: ScrapedNote[]) => {
  const byId = new Map<string, ScrapedNote>();
  const byTitle = new Map<string, ScrapedNote>();
  notes.forEach((note) => {
    if (note.id) byId.set(note.id, note);
    if (note.title) byTitle.set(note.title, note);
  });
  return { byId, byTitle };
};

const mergeAnalysisWithRawNotes = (analysis: AnalysisResult, rawNotes: ScrapedNote[]): AnalysisResult => {
  const lookup = buildRawNoteLookup(rawNotes);

  const mergeNote = (note: BenchmarkNote): BenchmarkNote => {
    const rawNote = lookup.byId.get(note.id) || lookup.byTitle.get(note.title);
    if (!rawNote) {
      return note;
    }
    return {
      ...rawNote,
      ...note,
      title: rawNote.title || note.title,
      desc: rawNote.desc || note.desc,
      author: rawNote.author || note.author,
      authorAvatar: rawNote.authorAvatar || note.authorAvatar,
      imageUrl: rawNote.imageUrl || (!isGeneratedPlaceholder(note.imageUrl) ? note.imageUrl : ''),
      imageList: rawNote.imageList?.length
        ? rawNote.imageList
        : (note.imageList?.some((item) => !isGeneratedPlaceholder(item)) ? note.imageList : rawNote.imageList),
      stableImageUrl: rawNote.stableImageUrl || note.stableImageUrl,
      stableImageList: rawNote.stableImageList?.length ? rawNote.stableImageList : note.stableImageList,
      tags: rawNote.tags?.length ? rawNote.tags : note.tags,
      likes: rawNote.likes || note.likes,
      stars: rawNote.stars || note.stars,
      commentCount: rawNote.commentCount || note.commentCount,
      comments: rawNote.comments?.length ? rawNote.comments : note.comments,
      views: rawNote.views || note.views,
      shares: note.shares || rawNote.shares,
      noteUrl: note.noteUrl || rawNote.noteUrl,
      time: rawNote.time ?? note.time,
      publishedAtLabel: rawNote.publishedAtLabel || note.publishedAtLabel,
    };
  };

  const benchmarkNotes = analysis.benchmarkNotes.map(mergeNote);
  const groupedBenchmarkNotes = Object.entries(analysis.groupedBenchmarkNotes).reduce<Record<string, BenchmarkNote[]>>((acc, [category, notes]) => {
    acc[category] = notes.map(mergeNote);
    return acc;
  }, {});

  return {
    ...analysis,
    benchmarkNotes,
    groupedBenchmarkNotes,
  };
};

export const historyToWorkspaceState = (task: ScrapeHistoryRecord) => {
  const currentResults = formatScrapedNotes(task.notes_data || []);
  const normalizedAnalysis = task.analysis_result ? normalizeAnalysis(task.analysis_result) : null;

  return {
    filters: sanitizeSearchFilters(task.filters),
    currentResults,
    analysis: normalizedAnalysis ? mergeAnalysisWithRawNotes(normalizedAnalysis, currentResults) : null,
  };
};
