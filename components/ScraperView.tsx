import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AnalysisResult,
  BenchmarkNote,
  CategorySummary,
  CollectionFollowupTask,
  DEFAULT_SEARCH_FILTERS,
  ProductBrief,
  ScrapeCollectionMode,
  ScrapeHistoryRecord,
  ScrapedNote,
  SearchFilters,
  UrlCollectionErrorCode,
} from '../types';
import { BrowserTab } from '../shared/extension-contract';
import apiClient, { normalizeAppErrorMessage } from '../services/apiClient';
import { shouldSkipLocalPublishTimeFilter, useXhsScraper } from '../src/hooks/useXhsScraper';
import { useExtension } from '../src/hooks/useExtension';
import { useScraperContext } from '../contexts/ScraperContext';
import { usePersistence } from '../contexts/PersistenceContext';
import { buildFallbackAnalysis, buildNoteIdentity, dedupeBenchmarkNotes, filterNotesByPublishTime, formatScrapedNotes, getCanonicalImageSequence, hasResolvedImageEntries, historyToWorkspaceState, mergeResolvedImageLists, normalizeAnalysis, normalizeResolvedImageList, sanitizeSearchFilters } from '../lib/scraperData';
import { buildProductBriefSignature, createEmptyProductBrief, getMissingProductBriefFields, hasMeaningfulProductBrief, isProductBriefComplete, normalizeProductBrief, parseProductBriefUrlsText, productBriefUrlsToText } from '../lib/productBrief';
import NotePreviewOverlay, { PreviewNote } from './NotePreviewOverlay';
import NoteCoverImage from './NoteCoverImage';
import LoginDialog from './LoginDialog';

interface ScraperViewProps {
  onEnterStudio: (prefill?: { productName: string; coreFeatures: string; targetAudience: string; styleDirection: string } | null) => void;
}

interface PendingScrapeRequest {
  query: string;
  maxNotes: number;
  filters: SearchFilters;
  enableComments: boolean;
}

type ScraperWorkbenchTab = 'keyword' | 'url' | 'results';

type HistoryLoadState = 'idle' | 'loading' | 'loaded' | 'failed';
type WorkspaceSourceType = 'idle' | 'live' | 'history';
const SHOW_KEYWORD_COLLECTION = false;

const filterSections: Array<{
  key: keyof SearchFilters;
  label: string;
  options: SearchFilters[keyof SearchFilters][];
}> = [
  { key: 'sortBy', label: '排序依据', options: ['综合', '最新', '最多点赞', '最多评论', '最多收藏'] },
  { key: 'noteType', label: '笔记类型', options: ['不限', '视频', '图文'] },
  { key: 'publishTime', label: '发布时间', options: ['不限', '一天内', '一周内', '半年内'] },
  { key: 'searchScope', label: '搜索范围', options: ['不限', '已看过', '未看过', '已关注'] },
  { key: 'location', label: '位置距离', options: ['不限', '同城', '附近'] },
];

const tierStyles: Record<string, string> = {
  强推荐: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
  可参考: 'bg-amber-500/15 text-amber-300 border-amber-500/20',
  仅做灵感: 'bg-slate-500/15 text-slate-300 border-slate-500/20',
};

const sufficiencyStyles: Record<string, string> = {
  充足: 'text-emerald-300',
  偏弱: 'text-amber-300',
  不足: 'text-rose-300',
};

const historyBadgeStyles = {
  analyzed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
  raw: 'bg-slate-500/10 text-slate-300 border-white/10',
};

const collectionModeLabelMap: Record<ScrapeCollectionMode, string> = {
  keyword: '常规分类采集',
  url: '对标笔记URL采集',
};

const collectionModeBadgeStyles: Record<ScrapeCollectionMode, string> = {
  keyword: 'border-sky-500/20 bg-sky-500/10 text-sky-200',
  url: 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-200',
};

const formatHistorySourceMeta = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return {
      host: 'xiaohongshu.com',
      primary: '单条笔记链接',
      secondary: '',
    };
  }

  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, '');
    const pathParts = path.split('/').filter(Boolean);
    const noteId = pathParts[pathParts.length - 1] || '';
    return {
      host: url.host.replace(/^www\./, ''),
      primary: noteId ? `笔记ID · ${noteId}` : path || '单条笔记链接',
      secondary: path ? `${path}${url.search ? ' · 含参数' : ''}` : raw,
    };
  } catch {
    const compact = raw.length > 42 ? `${raw.slice(0, 42)}...` : raw;
    return {
      host: '外部链接',
      primary: compact,
      secondary: '',
    };
  }
};

const recommendationTierRank: Record<string, number> = {
  强推荐: 3,
  可参考: 2,
  仅做灵感: 1,
};

const getNotePriorityScore = (note: BenchmarkNote) => (
  (recommendationTierRank[note.recommendation_tier] || 0) * 10_000 +
  (Number(note.rewrite_value_score) || 0) * 100 +
  (Number(note.commercial_fit_score) || 0)
);

const sortNotesByPriority = (notes: BenchmarkNote[]) => [...notes].sort((a, b) => getNotePriorityScore(b) - getNotePriorityScore(a));
const ANALYSIS_MIN_DURATION_MS = 1200;
const XHS_IMAGE_HOST_PATTERNS = ['xhscdn.com', 'xiaohongshu.com'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DIAGNOSTICS_TOGGLE_STORAGE_KEY = 'xhs_scraper_show_diagnostics';
const formatHistoryDebugTime = (value: string | null) => (value
  ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
  : '--');

const getCategoryPriority = (category: string) => {
  if (category.includes('测评')) return 1;
  if (category.includes('分享')) return 2;
  return 3;
};

const isBestMatchCandidate = (note: BenchmarkNote) => (
  note.recommendation_tier === '强推荐'
  || (
    Number(note.rewrite_value_score) >= 60
    && Number(note.commercial_fit_score) >= 55
  )
);

const getBestMatchNotes = (analysis: AnalysisResult | null): BenchmarkNote[] => {
  if (!analysis?.benchmarkNotes?.length) return [];
  const sortedNotes = sortNotesByPriority(analysis.benchmarkNotes);
  const matchedNotes = sortedNotes.filter(isBestMatchCandidate).slice(0, 5);
  return matchedNotes.length > 0 ? matchedNotes : sortedNotes.slice(0, 3);
};

const getDefaultBenchmarkNote = (analysis: AnalysisResult | null): BenchmarkNote | null => {
  const bestMatch = getBestMatchNotes(analysis)[0];
  if (bestMatch) return bestMatch;
  if (!analysis?.benchmarkNotes?.length) return null;
  return sortNotesByPriority(analysis.benchmarkNotes)[0] || null;
};

const hasUsableAnalysisPayload = (analysis: any): boolean => {
  if (!analysis || typeof analysis !== 'object') return false;
  const benchmarkNotes = analysis.benchmark_notes || analysis.benchmarkNotes;
  const groupedBenchmarkNotes = analysis.grouped_benchmark_notes || analysis.groupedBenchmarkNotes;
  const hasBenchmarkNotes = Array.isArray(benchmarkNotes) && benchmarkNotes.length > 0;
  const hasGroupedNotes = groupedBenchmarkNotes && typeof groupedBenchmarkNotes === 'object' && Object.keys(groupedBenchmarkNotes).length > 0;
  return hasBenchmarkNotes || hasGroupedNotes;
};

const safeLoadDraftBrief = (): ProductBrief => {
  if (typeof window === 'undefined') return normalizeProductBrief(null);
  try {
    const stored = localStorage.getItem('xhs_scraper_workspace_draft_brief');
    return normalizeProductBrief(stored ? JSON.parse(stored) : null);
  } catch (error) {
    console.error('Failed to load workspace draft brief', error);
    return normalizeProductBrief(null);
  }
};

const persistWorkspaceDraftBrief = (brief: ProductBrief) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem('xhs_scraper_workspace_draft_brief', JSON.stringify(normalizeProductBrief(brief)));
  } catch (error) {
    console.error('Failed to persist workspace draft brief', error);
  }
};

const isRecoverableHistoryImage = (value?: string | null): value is string => {
  if (!value || typeof value !== 'string') return false;
  return XHS_IMAGE_HOST_PATTERNS.some((pattern) => value.includes(pattern));
};

const normalizeRecoverableImageUrl = (value: string) => (
  value.startsWith('//')
    ? `https:${value}`
    : value.replace(/^http:\/\//i, 'https://')
);

const base64ToBlob = (base64: string, contentType: string) => {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: contentType });
};

const ScraperView: React.FC<ScraperViewProps> = ({ onEnterStudio }) => {
  const { extension } = useExtension();
  const {
    showAnalysis,
    setShowAnalysis,
    analysisResult,
    setAnalysisResult,
    topNotes,
    setTopNotes,
    setBenchmarkNotes,
    setGroupedBenchmarkNotes,
    setNextCollectionTasks,
    setRealPhrases,
    selectedBenchmarkNote,
    setSelectedBenchmarkNote,
    latestProductBrief,
    setLatestProductBrief,
    productBriefStatus,
    setProductBriefStatus,
  } = useScraperContext();
  const { setCreationState } = usePersistence();

  const [query, setQuery] = useState('');
  const [scraperTab, setScraperTab] = useState<ScraperWorkbenchTab>(SHOW_KEYWORD_COLLECTION ? 'keyword' : 'url');
  const [urlInput, setUrlInput] = useState('');
  const [maxNotes, setMaxNotes] = useState(20);
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS);
  const [enableComments, setEnableComments] = useState(true);
  const [taskMessage, setTaskMessage] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isUrlCollecting, setIsUrlCollecting] = useState(false);
  const [urlCollectErrorCode, setUrlCollectErrorCode] = useState<UrlCollectionErrorCode | null>(null);
  const [urlLastCollectedNote, setUrlLastCollectedNote] = useState<ScrapedNote | null>(null);
  const [urlLastCollectedSource, setUrlLastCollectedSource] = useState<'direct' | 'browser' | null>(null);
  const [currentResults, setCurrentResults] = useState<any[]>([]);
  const [previewState, setPreviewState] = useState<PreviewNote | null>(null);
  const [detailImageIndex, setDetailImageIndex] = useState(0);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [histories, setHistories] = useState<ScrapeHistoryRecord[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [loadingHistories, setLoadingHistories] = useState(false);
  const [historyLoadState, setHistoryLoadState] = useState<HistoryLoadState>('idle');
  const [historyLoadError, setHistoryLoadError] = useState('');
  const [historyLastSource, setHistoryLastSource] = useState('未请求');
  const [historyLastRequestedAt, setHistoryLastRequestedAt] = useState<string | null>(null);
  const [historyLastResolvedAt, setHistoryLastResolvedAt] = useState<string | null>(null);
  const [historyLastCount, setHistoryLastCount] = useState<number | null>(null);
  const [historyPreviewTaskId, setHistoryPreviewTaskId] = useState<string | null>(null);
  const [historyDetail, setHistoryDetail] = useState<ScrapeHistoryRecord | null>(null);
  const [workspaceRestoredTaskId, setWorkspaceRestoredTaskId] = useState<string | null>(null);
  const [historyReanalyzing, setHistoryReanalyzing] = useState(false);
  const [historyDeletingTaskId, setHistoryDeletingTaskId] = useState<string | null>(null);
  const [isHistoryDetailExpanded, setIsHistoryDetailExpanded] = useState(true);
  const [showRawResults, setShowRawResults] = useState(false);
  const [isProductBriefExpanded, setIsProductBriefExpanded] = useState(false);
  const [historyImageRecoveryNotice, setHistoryImageRecoveryNotice] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DIAGNOSTICS_TOGGLE_STORAGE_KEY) === '1';
  });
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [isLoginDialogOpen, setIsLoginDialogOpen] = useState(false);
  const [pendingScrapeRequest, setPendingScrapeRequest] = useState<PendingScrapeRequest | null>(null);
  const activeKeywordRef = useRef('');
  const latestSaveTaskIdRef = useRef<string | null>(null);
  const historyRequestVersionRef = useRef(0);
  const historyListRequestVersionRef = useRef(0);
  const historyRetryTimerRef = useRef<number | null>(null);
  const resolvedBlobUrlsRef = useRef<Set<string>>(new Set());
  const resolvedImageCacheRef = useRef<Map<string, string>>(new Map());
  const xhsTabIdRef = useRef<number | null>(null);
  const recoveringTaskIdsRef = useRef<Set<string>>(new Set());
  const previewResolvingKeyRef = useRef<string | null>(null);
  const liveWorkspaceSessionRef = useRef(0);
  const historyWorkspaceSessionRef = useRef(0);
  const workspaceSourceRef = useRef<{ type: WorkspaceSourceType; token: number; taskId: string | null }>({
    type: 'idle',
    token: 0,
    taskId: null,
  });
  const [productBrief, setProductBrief] = useState<ProductBrief>(() => (
    hasMeaningfulProductBrief(latestProductBrief)
      ? normalizeProductBrief(latestProductBrief)
      : safeLoadDraftBrief()
  ));

  const {
    startScraping,
    collectNoteByUrlWithBrowser,
    isScraping: isExtensionScraping,
    data: extensionData,
    collectionResultMeta,
    statusMessage,
    filterDebugEntries,
    commentDebugEntries,
  } = useXhsScraper();
  const prevIsScrapingRef = useRef(false);

  useEffect(() => {
    persistWorkspaceDraftBrief(productBrief);
  }, [productBrief]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DIAGNOSTICS_TOGGLE_STORAGE_KEY, showDiagnostics ? '1' : '0');
  }, [showDiagnostics]);

  const hydrateProductBriefDraft = useCallback(() => {
    const currentDraft = normalizeProductBrief(productBrief);
    if (hasMeaningfulProductBrief(currentDraft)) {
      return currentDraft;
    }

    const persistedDraft = safeLoadDraftBrief();
    if (hasMeaningfulProductBrief(persistedDraft)) {
      setProductBrief(persistedDraft);
      setLatestProductBrief(persistedDraft);
      return persistedDraft;
    }

    const contextBrief = normalizeProductBrief(latestProductBrief);
    if (hasMeaningfulProductBrief(contextBrief)) {
      setProductBrief(contextBrief);
      persistWorkspaceDraftBrief(contextBrief);
      return contextBrief;
    }

    return currentDraft;
  }, [latestProductBrief, productBrief, setLatestProductBrief]);

  const updateDraftProductBrief = useCallback(<K extends keyof ProductBrief>(key: K, value: ProductBrief[K]) => {
    const nextBrief = normalizeProductBrief({
      ...productBrief,
      [key]: value,
    });
    setProductBrief(nextBrief);
    persistWorkspaceDraftBrief(nextBrief);
    setLatestProductBrief(nextBrief);
    setProductBriefStatus((prev) => ({
      ...prev,
      updatedAt: new Date().toISOString(),
      isDirty: prev.analysisSignature ? prev.analysisSignature !== buildProductBriefSignature(nextBrief) : false,
    }));
  }, [productBrief, setLatestProductBrief, setProductBriefStatus]);

  useEffect(() => {
    const currentSignature = buildProductBriefSignature(productBrief);
    setProductBriefStatus((prev) => ({
      ...prev,
      isDirty: prev.analysisSignature ? prev.analysisSignature !== currentSignature : false,
    }));
  }, [productBrief, setProductBriefStatus]);

  useEffect(() => {
    setDetailImageIndex(0);
  }, [previewState?.note.id]);

  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    if (previewState) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [previewState]);

  const releaseRecoveredBlobUrls = useCallback(() => {
    resolvedBlobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    resolvedBlobUrlsRef.current.clear();
    resolvedImageCacheRef.current.clear();
  }, []);

  useEffect(() => () => {
    releaseRecoveredBlobUrls();
  }, [releaseRecoveredBlobUrls]);

  const rememberResolvedBlobUrl = useCallback((url: string) => {
    resolvedBlobUrlsRef.current.add(url);
    return url;
  }, []);

  const findAvailableXhsTabId = useCallback(async (): Promise<number | null> => {
    if (!extension) return null;
    if (xhsTabIdRef.current) {
      return xhsTabIdRef.current;
    }

    try {
      const tabs = await extension.invoke('chrome:tabs:query', { queryInfo: {} });
      const availableTab = tabs.find((tab: BrowserTab) => {
        const tabUrl = tab.url || '';
        return tab.id && tabUrl.includes('xiaohongshu.com');
      });
      xhsTabIdRef.current = availableTab?.id ?? null;
      return xhsTabIdRef.current;
    } catch (error) {
      console.error('Failed to query xiaohongshu tabs:', error);
      return null;
    }
  }, [extension]);

  useEffect(() => {
    xhsTabIdRef.current = null;
  }, [extension]);

  useEffect(() => {
    if (!SHOW_KEYWORD_COLLECTION && scraperTab === 'keyword') {
      setScraperTab('url');
    }
  }, [scraperTab]);

  const recoverImageFromXhsTab = useCallback(async (sourceUrl: string): Promise<string | null> => {
    if (!extension || !isRecoverableHistoryImage(sourceUrl)) {
      return null;
    }

    const normalizedUrl = normalizeRecoverableImageUrl(sourceUrl);
    const cached = resolvedImageCacheRef.current.get(normalizedUrl);
    if (cached) {
      return cached;
    }

    const xhsTabId = await findAvailableXhsTabId();
    if (xhsTabId) {
      try {
        const response = await extension.invoke('web:runtime:evaluate', {
          tabId: xhsTabId,
          args: [normalizedUrl],
          code: `async (targetUrl) => {
            const normalize = (value) => value.startsWith('//') ? 'https:' + value : value.replace(/^http:\\/\\//i, 'https://');
            const toBase64 = (blob) => new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(new Error('read blob failed'));
              reader.readAsDataURL(blob);
            });

            const run = async () => {
              const response = await fetch(normalize(targetUrl), {
                credentials: 'include',
                mode: 'cors',
                cache: 'force-cache',
              });
              if (!response.ok) {
                throw new Error('HTTP ' + response.status);
              }
              const blob = await response.blob();
              return {
                dataUrl: await toBase64(blob),
                contentType: blob.type || response.headers.get('content-type') || 'image/jpeg',
              };
            };

            return run();
          }`,
        });
        const result = response?.[0]?.result;
        const payload = result?.success ? result.data as { dataUrl?: string } | null : null;
        if (payload?.dataUrl) {
          resolvedImageCacheRef.current.set(normalizedUrl, payload.dataUrl);
          return payload.dataUrl;
        }
      } catch (error) {
        console.warn('Recover image through xhs tab failed:', normalizedUrl, error);
      }
    }

    try {
      const response = await extension.invoke('service-worker:fetch', {
        url: normalizedUrl,
        method: 'GET',
        init: {
          credentials: 'include',
          headers: {
            Referer: 'https://www.xiaohongshu.com/',
            'User-Agent': 'Mozilla/5.0',
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          } as HeadersInit,
        },
      });
      if (!response?.ok || !response.body) {
        return null;
      }
      const contentType = response.headers?.['content-type'] || 'image/jpeg';
      const blobUrl = rememberResolvedBlobUrl(URL.createObjectURL(base64ToBlob(response.body, contentType)));
      resolvedImageCacheRef.current.set(normalizedUrl, blobUrl);
      return blobUrl;
    } catch (error) {
      console.warn('Recover image through extension fetch failed:', normalizedUrl, error);
      return null;
    }
  }, [extension, findAvailableXhsTabId, rememberResolvedBlobUrl]);

  const recoverNoteImages = useCallback(async (
    note: BenchmarkNote,
    options?: { includeAllImages?: boolean; targetIndex?: number }
  ): Promise<BenchmarkNote> => {
    const sourceList = getCanonicalImageSequence(note)
      .filter(isRecoverableHistoryImage)
      .map(normalizeRecoverableImageUrl);
    const primarySource = isRecoverableHistoryImage(note.imageUrl) ? normalizeRecoverableImageUrl(note.imageUrl) : sourceList[0];
    const resolvedList = normalizeResolvedImageList(note.resolvedImageList, sourceList.length) || Array.from({ length: sourceList.length }, () => '');
    let resolvedPrimary = note.resolvedImageUrl || '';

    if (primarySource) {
      const recoveredPrimary = await recoverImageFromXhsTab(primarySource);
      if (recoveredPrimary) {
        resolvedPrimary = recoveredPrimary;
      }
    }

    const targetIndexes = options?.includeAllImages
      ? sourceList.map((_, index) => index)
      : options?.targetIndex !== undefined
        ? [options.targetIndex]
        : [0];

    for (const index of targetIndexes) {
      const source = sourceList[index];
      if (!source || resolvedList[index]) continue;
      const recovered = await recoverImageFromXhsTab(source);
      if (recovered) {
        resolvedList[index] = recovered;
      }
    }

    return {
      ...note,
      resolvedImageUrl: resolvedPrimary || note.resolvedImageUrl,
      resolvedImageList: normalizeResolvedImageList(resolvedList, sourceList.length),
    };
  }, [getCanonicalImageSequence, recoverImageFromXhsTab]);

  const updatePreviewResolvedNote = useCallback((updater: (note: BenchmarkNote) => BenchmarkNote) => {
    setPreviewState((prev) => (prev ? { ...prev, note: updater(prev.note) } : prev));
  }, []);

  const syncAnalysisIntoContext = useCallback((normalized: AnalysisResult, brief?: ProductBrief | null) => {
    const sortedBenchmarkNotes = sortNotesByPriority(normalized.benchmarkNotes);
    const sortedGroupedBenchmarkNotes = Object.entries(normalized.groupedBenchmarkNotes || {}).reduce<Record<string, BenchmarkNote[]>>((acc, [category, notes]) => {
      acc[category] = sortNotesByPriority(notes);
      return acc;
    }, {});

    setAnalysisResult({
      ...normalized,
      benchmarkNotes: sortedBenchmarkNotes,
      groupedBenchmarkNotes: sortedGroupedBenchmarkNotes,
    });
    setBenchmarkNotes(sortedBenchmarkNotes);
    setGroupedBenchmarkNotes(sortedGroupedBenchmarkNotes);
    setNextCollectionTasks(normalized.nextCollectionTasks);
    setRealPhrases(normalized.realPhrases);
    setProductBriefStatus({
      updatedAt: new Date().toISOString(),
      analysisSignature: buildProductBriefSignature(brief || normalized.productBrief || productBrief || createEmptyProductBrief()),
      isDirty: false,
    });
    setShowAnalysis(true);
  }, [
    productBrief,
    setAnalysisResult,
    setBenchmarkNotes,
    setGroupedBenchmarkNotes,
    setNextCollectionTasks,
    setRealPhrases,
    setProductBriefStatus,
    setShowAnalysis,
  ]);

  const applyResolvedNotesToAnalysis = useCallback((analysis: AnalysisResult | null, resolvedNotes: BenchmarkNote[]) => {
    if (!analysis || resolvedNotes.length === 0) return analysis;
    const byId = new Map(resolvedNotes.map((note) => [note.id, note]));
    const mergeNote = (note: BenchmarkNote) => {
      const resolved = byId.get(note.id);
      return resolved
        ? {
            ...note,
            resolvedImageUrl: resolved.resolvedImageUrl || note.resolvedImageUrl,
            resolvedImageList: mergeResolvedImageLists(note.resolvedImageList, resolved.resolvedImageList, getCanonicalImageSequence(note).length),
          }
        : note;
    };

    return {
      ...analysis,
      benchmarkNotes: analysis.benchmarkNotes.map(mergeNote),
      groupedBenchmarkNotes: Object.entries(analysis.groupedBenchmarkNotes || {}).reduce<Record<string, BenchmarkNote[]>>((acc, [category, notes]) => {
        acc[category] = notes.map(mergeNote);
        return acc;
      }, {}),
    };
  }, []);

  const applyResolvedNotesToWorkspace = useCallback((resolvedNotes: BenchmarkNote[]) => {
    if (resolvedNotes.length === 0) return;
    const byId = new Map(resolvedNotes.map((note) => [note.id, note]));
    setCurrentResults((prev) => prev.map((note) => {
      const resolved = byId.get(note.id);
      return resolved
        ? {
            ...note,
            resolvedImageUrl: resolved.resolvedImageUrl || note.resolvedImageUrl,
            resolvedImageList: mergeResolvedImageLists(note.resolvedImageList, resolved.resolvedImageList, getCanonicalImageSequence(note).length),
          }
        : note;
    }));
    setTopNotes(topNotes.map((note) => {
      const resolved = byId.get(note.id);
      return resolved
        ? {
            ...note,
            resolvedImageUrl: resolved.resolvedImageUrl || note.resolvedImageUrl,
            resolvedImageList: mergeResolvedImageLists(note.resolvedImageList, resolved.resolvedImageList, getCanonicalImageSequence(note).length),
          }
        : note;
    }));
    setAnalysisResult(applyResolvedNotesToAnalysis(analysisResult, resolvedNotes));
    if (selectedBenchmarkNote) {
      const resolved = byId.get(selectedBenchmarkNote.id);
      setSelectedBenchmarkNote(
        resolved
        ? {
            ...selectedBenchmarkNote,
            resolvedImageUrl: resolved.resolvedImageUrl || selectedBenchmarkNote.resolvedImageUrl,
            resolvedImageList: mergeResolvedImageLists(
              selectedBenchmarkNote.resolvedImageList,
              resolved.resolvedImageList,
              getCanonicalImageSequence(selectedBenchmarkNote).length
            ),
          }
        : selectedBenchmarkNote
      );
    }
  }, [analysisResult, applyResolvedNotesToAnalysis, getCanonicalImageSequence, selectedBenchmarkNote, setAnalysisResult, setSelectedBenchmarkNote, setTopNotes, topNotes]);

  const fetchHistories = useCallback(async (source = 'unknown') => {
    const requestVersion = ++historyListRequestVersionRef.current;
    const requestedAt = new Date().toISOString();
    try {
      setLoadingHistories(true);
      setHistoryLoadState('loading');
      setHistoryLastSource(source);
      setHistoryLastRequestedAt(requestedAt);
      const response = await apiClient.getScrapeHistories();
      if (requestVersion !== historyListRequestVersionRef.current) {
        return;
      }
      if (response.success) {
        const nextHistories = response.data || [];
        setHistories(nextHistories);
        setHistoryLoadError('');
        setHistoryLoadState('loaded');
        setHistoryLastResolvedAt(new Date().toISOString());
        setHistoryLastCount(nextHistories.length);
      } else {
        setHistoryLoadError(response.message || '历史记录加载失败，正在等待重试。');
        setHistoryLoadState('failed');
        setHistoryLastResolvedAt(new Date().toISOString());
        setHistoryLastCount(null);
      }
    } catch (error) {
      if (requestVersion !== historyListRequestVersionRef.current) {
        return;
      }
      console.error('Failed to fetch histories:', error);
      setHistoryLoadError('历史记录加载失败，正在等待重试。');
      setHistoryLoadState('failed');
      setHistoryLastResolvedAt(new Date().toISOString());
      setHistoryLastCount(null);
    } finally {
      if (requestVersion === historyListRequestVersionRef.current) {
        setLoadingHistories(false);
      }
    }
  }, []);

  const upsertHistorySummary = useCallback((task: ScrapeHistoryRecord) => {
    setHistories((prev) => {
      const next = [task, ...prev.filter((item) => item.task_id !== task.task_id)];
      return next.sort((left, right) => (
        new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
      ));
    });
  }, []);

  const buildLocalHistoryRecord = useCallback((
    summary: ScrapeHistoryRecord,
    notesData: any[],
    analysisResult?: any,
  ): ScrapeHistoryRecord => ({
    ...summary,
    notes_data: notesData,
    analysis_result: analysisResult ?? summary.analysis_result ?? null,
    filters: summary.filters || filters,
    product_brief: summary.product_brief || normalizeProductBrief(productBrief),
  }), [filters, productBrief]);

  useEffect(() => {
    void fetchHistories('mount');
  }, [fetchHistories]);

  useEffect(() => {
    if (loadingHistories || histories.length > 0) {
      return;
    }

    const retryInterval = window.setInterval(() => {
      void fetchHistories('empty_poll');
    }, 3000);

    return () => {
      window.clearInterval(retryInterval);
    };
  }, [fetchHistories, histories.length, loadingHistories]);

  useEffect(() => {
    if (!historyLoadError) {
      if (historyRetryTimerRef.current !== null) {
        window.clearTimeout(historyRetryTimerRef.current);
        historyRetryTimerRef.current = null;
      }
      return;
    }

    historyRetryTimerRef.current = window.setTimeout(() => {
      void fetchHistories('error_retry');
    }, 2000);

    return () => {
      if (historyRetryTimerRef.current !== null) {
        window.clearTimeout(historyRetryTimerRef.current);
        historyRetryTimerRef.current = null;
      }
    };
  }, [fetchHistories, historyLoadError]);

  useEffect(() => {
    const handleFocus = () => {
      void fetchHistories('window_focus');
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchHistories('visibility_visible');
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchHistories]);

  useEffect(() => {
    if (!extension) return;
    void fetchHistories('extension_ready');
  }, [extension, fetchHistories]);

  useEffect(() => {
    if (hasMeaningfulProductBrief(productBrief) || hasMeaningfulProductBrief(latestProductBrief) || histories.length === 0) {
      return;
    }

    const latestHistoryBrief = histories
      .map((item) => normalizeProductBrief(item.product_brief))
      .find((brief) => hasMeaningfulProductBrief(brief));

    if (!latestHistoryBrief) {
      return;
    }

    setProductBrief(latestHistoryBrief);
    persistWorkspaceDraftBrief(latestHistoryBrief);
    setLatestProductBrief(latestHistoryBrief);
    setTaskMessage(`已从最近历史任务自动恢复产品参数：${latestHistoryBrief.product_name || '未命名产品'}`);
  }, [histories, latestProductBrief, productBrief, setLatestProductBrief]);

  const validateProductBrief = useCallback((purpose: '采集' | '分析' | '仿写') => {
    const missingFields = getMissingProductBriefFields(productBrief);
    if (missingFields.length > 0) {
      alert(`请先补全产品参数后再${purpose}：${missingFields.join('、')}`);
      setIsProductBriefExpanded(true);
      return false;
    }
    return true;
  }, [productBrief]);

  const saveProductBriefToWorkspace = useCallback(() => {
    const normalized = normalizeProductBrief(productBrief);
    setProductBrief(normalized);
    persistWorkspaceDraftBrief(normalized);
    setLatestProductBrief(normalized);
    setProductBriefStatus((prev) => ({
      ...prev,
      updatedAt: new Date().toISOString(),
      isDirty: prev.analysisSignature ? prev.analysisSignature !== buildProductBriefSignature(normalized) : false,
    }));
    setTaskMessage(`产品参数草稿已自动保存到当前工作区：${normalized.product_name || '未命名产品'}`);
  }, [productBrief, setLatestProductBrief, setProductBriefStatus]);

  const getHistoryCollectionMode = useCallback((task: Partial<ScrapeHistoryRecord> | null | undefined): ScrapeCollectionMode => (
    task?.collection_mode === 'url' ? 'url' : 'keyword'
  ), []);

  const extractApiDetail = useCallback((error: unknown): { code: UrlCollectionErrorCode | null; message: string } => {
    const detail = (error as any)?.response?.data?.detail;
    const code = typeof detail?.code === 'string' ? detail.code as UrlCollectionErrorCode : null;
    const message = normalizeAppErrorMessage(error, '请求失败，请稍后重试');
    return { code, message };
  }, []);

  const startLiveWorkspaceSession = useCallback(() => {
    const token = liveWorkspaceSessionRef.current + 1;
    liveWorkspaceSessionRef.current = token;
    workspaceSourceRef.current = {
      type: 'live',
      token,
      taskId: null,
    };
    return token;
  }, []);

  const bindLiveWorkspaceTask = useCallback((token: number, taskId: string | null) => {
    if (workspaceSourceRef.current.type !== 'live' || workspaceSourceRef.current.token !== token) {
      return false;
    }
    workspaceSourceRef.current = {
      type: 'live',
      token,
      taskId,
    };
    return true;
  }, []);

  const isLiveWorkspaceSessionActive = useCallback((token: number) => (
    workspaceSourceRef.current.type === 'live' && workspaceSourceRef.current.token === token
  ), []);

  const activateHistoryWorkspace = useCallback((taskId: string) => {
    const token = historyWorkspaceSessionRef.current + 1;
    historyWorkspaceSessionRef.current = token;
    workspaceSourceRef.current = {
      type: 'history',
      token,
      taskId,
    };
    setWorkspaceRestoredTaskId(taskId);
    return token;
  }, []);

  const restoreHistoryToWorkspace = useCallback((task: ScrapeHistoryRecord) => {
    releaseRecoveredBlobUrls();
    setHistoryImageRecoveryNotice('');
    const workspace = historyToWorkspaceState(task);
    const currentDraftBrief = hydrateProductBriefDraft();
    const fallbackAnalysis = workspace.currentResults.length > 0
      ? buildFallbackAnalysis(workspace.currentResults, currentDraftBrief || undefined)
      : null;
    const effectiveAnalysis = workspace.analysis && hasUsableAnalysisPayload(task.analysis_result)
      ? workspace.analysis
      : fallbackAnalysis;
    const analysisBrief = hasMeaningfulProductBrief(task.product_brief)
      ? normalizeProductBrief(task.product_brief)
      : hasMeaningfulProductBrief(effectiveAnalysis?.productBrief)
        ? normalizeProductBrief(effectiveAnalysis?.productBrief)
        : currentDraftBrief;

    activateHistoryWorkspace(task.task_id);
    setHistoryDetail(task);
    setQuery(task.keyword);
    setFilters(workspace.filters);
    setScraperTab('results');
    setIsHistoryDrawerOpen(false);
    setCurrentResults(workspace.currentResults);
    setTopNotes(workspace.currentResults.slice(0, 8));
    setSelectedBenchmarkNote(null);
    setShowRawResults(false);
    setTaskMessage(`已载入历史任务《${task.keyword}》的数据与结果，当前产品参数保持不变。`);

    if (effectiveAnalysis) {
      syncAnalysisIntoContext(effectiveAnalysis, analysisBrief);
    } else {
      setAnalysisResult(null);
      setBenchmarkNotes([]);
      setGroupedBenchmarkNotes({});
      setNextCollectionTasks([]);
      setRealPhrases([]);
      setProductBriefStatus((prev) => ({
        ...prev,
        updatedAt: prev.updatedAt || null,
        isDirty: prev.analysisSignature ? prev.analysisSignature !== buildProductBriefSignature(currentDraftBrief) : prev.isDirty,
      }));
      setShowAnalysis(false);
    }
  }, [
    releaseRecoveredBlobUrls,
    setAnalysisResult,
    setBenchmarkNotes,
    setGroupedBenchmarkNotes,
    setNextCollectionTasks,
    setProductBriefStatus,
    setRealPhrases,
    setSelectedBenchmarkNote,
    setShowAnalysis,
    setTopNotes,
    hydrateProductBriefDraft,
    syncAnalysisIntoContext,
    activateHistoryWorkspace,
  ]);

  const recoverHistoryWorkspaceImages = useCallback(async (task: ScrapeHistoryRecord) => {
    if (!extension || !task?.task_id || recoveringTaskIdsRef.current.has(task.task_id)) {
      return;
    }

    recoveringTaskIdsRef.current.add(task.task_id);
    try {
      const workspace = historyToWorkspaceState(task);
      const notesToRecover = workspace.currentResults
        .filter((note) => isRecoverableHistoryImage(note.imageUrl) || note.imageList?.some(isRecoverableHistoryImage))
        .slice(0, 20) as BenchmarkNote[];

      if (notesToRecover.length === 0) {
        return;
      }

      const resolvedNotes = await Promise.all(notesToRecover.map((note) => recoverNoteImages(note)));
      const successCount = resolvedNotes.filter((note) => note.resolvedImageUrl || hasResolvedImageEntries(note.resolvedImageList)).length;
      applyResolvedNotesToWorkspace(resolvedNotes);
      if (successCount === 0) {
        setHistoryImageRecoveryNotice('历史图片链接已失效，当前仅显示占位图；如需稳定图片建议重新采集。');
      } else {
        setHistoryImageRecoveryNotice('');
      }
    } catch (error) {
      console.error('Recover history workspace images failed:', error);
      setHistoryImageRecoveryNotice('历史图片临时恢复失败，当前仅显示占位图。');
    } finally {
      recoveringTaskIdsRef.current.delete(task.task_id);
    }
  }, [applyResolvedNotesToWorkspace, extension, recoverNoteImages]);

  const reanalyzeHistoryTask = useCallback(async (task: ScrapeHistoryRecord, options?: { silent?: boolean }) => {
    if (!task?.notes_data?.length) {
      if (!options?.silent) {
        alert('当前历史任务没有可重新分析的采集数据。');
      }
      return null;
    }

    if (!validateProductBrief('分析')) {
      return null;
    }
    saveProductBriefToWorkspace();

    try {
      setHistoryReanalyzing(true);
      const analyzeStartedAt = Date.now();
      setTaskMessage(`正在重新分析历史任务《${task.keyword}》... 正在逐篇梳理内容并结合当前产品参数重排优先级。`);
      const response = await apiClient.analyzeLocalNotes(task.notes_data, productBrief);
      const remaining = ANALYSIS_MIN_DURATION_MS - (Date.now() - analyzeStartedAt);
      if (remaining > 0) {
        await sleep(remaining);
      }
      if (!response.success) {
        throw new Error(response.message || '分析失败');
      }

      await apiClient.updateScrapeHistoryAnalysis(task.task_id, {
        analysis_result: response.data,
        filters: task.filters || filters,
        product_brief: normalizeProductBrief(productBrief),
      });

      const updatedTask: ScrapeHistoryRecord = {
        ...task,
        analysis_result: response.data,
        filters: task.filters || filters,
        product_brief: normalizeProductBrief(productBrief),
      };

      setHistoryDetail(updatedTask);
      await fetchHistories();
      const normalized = normalizeAnalysis(response.data, normalizeProductBrief(productBrief));
      const bestMatches = getBestMatchNotes(normalized);
      const resultMessage =
        bestMatches.length > 0
          ? `历史任务《${task.keyword}》已重新分析完成，筛出 ${bestMatches.length} 条最符合当前产品参数的样本。`
          : `历史任务《${task.keyword}》已重新分析完成，但本次采集任务无最符合需求的样本。`;
      restoreHistoryToWorkspace(updatedTask);
      setTaskMessage(resultMessage);
      return updatedTask;
    } catch (error: any) {
      console.error('History reanalyze failed:', error);
      if (!options?.silent) {
        alert(`重新分析失败：${error.message || '未知错误'}`);
      } else {
        setTaskMessage(`自动重分析失败：${error.message || '未知错误'}`);
      }
      return null;
    } finally {
      setHistoryReanalyzing(false);
    }
  }, [fetchHistories, filters, productBrief, restoreHistoryToWorkspace, saveProductBriefToWorkspace, validateProductBrief, workspaceRestoredTaskId]);

  const fetchHistoryDetail = useCallback(async (taskId: string, restore = true) => {
    const requestVersion = ++historyRequestVersionRef.current;
    try {
      hydrateProductBriefDraft();
      const response = await apiClient.getScrapeHistoryDetail(taskId);
      if (requestVersion !== historyRequestVersionRef.current) {
        return;
      }
      if (response.success) {
        const task = response.data as ScrapeHistoryRecord;
        setHistoryDetail(task);
        setHistoryPreviewTaskId(task.task_id);
        setIsHistoryDetailExpanded(false);
        setIsHistoryDrawerOpen(false);
        setTaskMessage(`已打开历史任务《${task.keyword}》预览。这里只查看这条记录，不会改动当前产品参数。`);
        if (restore) {
          restoreHistoryToWorkspace(task);
          void recoverHistoryWorkspaceImages(task);
          if ((!task.analysis_result || !hasUsableAnalysisPayload(task.analysis_result)) && task.notes_data?.length) {
            void reanalyzeHistoryTask(task, { silent: true });
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch history detail:', error);
    }
  }, [hydrateProductBriefDraft, reanalyzeHistoryTask, recoverHistoryWorkspaceImages, restoreHistoryToWorkspace]);

  useEffect(() => {
    const performAnalysis = async () => {
      if (extensionData.length === 0) {
        return;
      }

      const liveWorkspaceSessionToken = startLiveWorkspaceSession();
      const formattedNotes = formatScrapedNotes(extensionData);
      const skipLocalPublishTimeFilter = shouldSkipLocalPublishTimeFilter(collectionResultMeta, filters.publishTime);
      const publishTimeFilteredNotes = skipLocalPublishTimeFilter
        ? formattedNotes
        : filterNotesByPublishTime(formattedNotes, filters.publishTime);
      const publishTimeFilteredCount = skipLocalPublishTimeFilter
        ? 0
        : (formattedNotes.length - publishTimeFilteredNotes.length);
      const effectiveNotes = publishTimeFilteredNotes.slice(0, maxNotes);
      const topFormattedNotes = effectiveNotes.slice(0, 8);
      const fallbackAnalysis = buildFallbackAnalysis(effectiveNotes, productBrief);
      const commentsEnabledLabel = enableComments ? '已开启评论采集' : '未开启评论采集';
      const normalizedProductBrief = normalizeProductBrief(productBrief);
      const shouldApplyLiveWorkspace = () => isLiveWorkspaceSessionActive(liveWorkspaceSessionToken);

      setIsAnalyzing(true);
      setWorkspaceRestoredTaskId(null);
      const filterNotice = publishTimeFilteredCount > 0
        ? ` 已按发布时间剔除 ${publishTimeFilteredCount} 条不符合条件的笔记。`
        : '';
      setTaskMessage(`采集完成，共 ${effectiveNotes.length} 条，正在保存采集结果...${filterNotice}`);
      setScraperTab('results');
      setCurrentResults(effectiveNotes);
      setTopNotes(topFormattedNotes);
      setShowAnalysis(false);
      setShowRawResults(false);
      syncAnalysisIntoContext(fallbackAnalysis, productBrief);

      if (effectiveNotes.length === 0) {
        setTaskMessage(`当前采集结果未通过发布时间筛选（${filters.publishTime}），请放宽发布时间或重新采集。${filterNotice}`);
        setIsAnalyzing(false);
        return;
      }

      let savedHistoryTask: ScrapeHistoryRecord | null = null;
      let historySaveMessage = '';

      try {
        try {
          const saveResult = await apiClient.saveScrapeHistory({
            keyword: activeKeywordRef.current || query || '未命名采集任务',
            notes_count: effectiveNotes.length,
            notes_data: effectiveNotes,
            filters,
            product_brief: normalizedProductBrief,
          });

          if (!saveResult?.success) {
            throw new Error(saveResult?.message || '采集结果保存失败');
          }

          latestSaveTaskIdRef.current = saveResult?.data?.task_id || null;
          savedHistoryTask = buildLocalHistoryRecord(saveResult.data as ScrapeHistoryRecord, effectiveNotes);
          upsertHistorySummary(savedHistoryTask);
          bindLiveWorkspaceTask(liveWorkspaceSessionToken, savedHistoryTask.task_id);
          if (shouldApplyLiveWorkspace()) {
            setHistoryDetail(savedHistoryTask);
            setHistoryPreviewTaskId(savedHistoryTask.task_id);
          }
          historySaveMessage = '采集结果已保存';
          if (shouldApplyLiveWorkspace()) {
            setTaskMessage('采集结果已保存，正在分析分类与对标充足度...');
          }
        } catch (saveError: any) {
          latestSaveTaskIdRef.current = null;
          historySaveMessage = `当前结果仅保存在本页，未写入历史记录：${normalizeAppErrorMessage(saveError, '未知错误')}`;
          console.error('Failed to save scrape history:', saveError);
          if (shouldApplyLiveWorkspace()) {
            setTaskMessage(`${historySaveMessage}，正在继续分析分类与对标充足度...`);
          }
        }

        const result = await apiClient.analyzeLocalNotes(effectiveNotes, productBrief);
        if (!result.success) {
          throw new Error(result.message || '分析失败');
        }

        const normalized = normalizeAnalysis(result.data, productBrief);
        if (shouldApplyLiveWorkspace()) {
          syncAnalysisIntoContext(normalized, productBrief);
        }
        if (savedHistoryTask?.task_id) {
          await apiClient.updateScrapeHistoryAnalysis(savedHistoryTask.task_id, {
            analysis_result: result.data,
            filters,
            product_brief: normalizedProductBrief,
          });
          savedHistoryTask = buildLocalHistoryRecord(savedHistoryTask, effectiveNotes, result.data);
          upsertHistorySummary(savedHistoryTask);
          if (shouldApplyLiveWorkspace()) {
            setHistoryDetail(savedHistoryTask);
          }
        }

        const finalMessage = savedHistoryTask
          ? `分析完成，已得到 ${normalized.benchmarkNotes.length} 条可用对标样本，${commentsEnabledLabel}。${filterNotice}`
          : `分析完成，已得到 ${normalized.benchmarkNotes.length} 条可用对标样本，${commentsEnabledLabel}。${filterNotice}${historySaveMessage}`;
        if (savedHistoryTask?.task_id) {
          await fetchHistories();
          if (shouldApplyLiveWorkspace()) {
            await fetchHistoryDetail(savedHistoryTask.task_id, false);
          }
        }
        if (shouldApplyLiveWorkspace()) {
          setTaskMessage(finalMessage);
        }
      } catch (error: any) {
        console.error(error);
        if (shouldApplyLiveWorkspace()) {
          setShowAnalysis(true);
          setShowRawResults(false);
          syncAnalysisIntoContext(fallbackAnalysis, productBrief);
        }
        const analysisFailureMessage = savedHistoryTask
          ? `分析失败，已保留当前采集结果并写入历史原始记录：${error.message || '未知错误'}，${commentsEnabledLabel}。${filterNotice}`
          : `分析失败，已保留当前采集结果：${error.message || '未知错误'}，${commentsEnabledLabel}。${filterNotice}${historySaveMessage || '当前结果仅保存在本页，未写入历史记录。'}`;
        if (shouldApplyLiveWorkspace()) {
          setTaskMessage(analysisFailureMessage);
        }
      } finally {
        setIsAnalyzing(false);
      }
    };

    if (prevIsScrapingRef.current && !isExtensionScraping) {
      performAnalysis();
    }
    prevIsScrapingRef.current = isExtensionScraping;
  }, [
    extensionData,
    enableComments,
    isExtensionScraping,
    query,
    filters,
    productBrief,
    buildLocalHistoryRecord,
    setShowAnalysis,
    setTopNotes,
    syncAnalysisIntoContext,
    bindLiveWorkspaceTask,
    fetchHistories,
    fetchHistoryDetail,
    isLiveWorkspaceSessionActive,
    startLiveWorkspaceSession,
    upsertHistorySummary,
  ]);

  const runScrapingTask = useCallback(async (request: PendingScrapeRequest) => {
    const result = await startScraping(request.query, request.maxNotes, request.filters, {
      enableComments: request.enableComments,
      maxCommentsPerNote: 12,
    });

    if (!result.success) {
      if (result.code === 'xhs_login_required') {
        setPendingScrapeRequest(request);
        setIsLoginDialogOpen(true);
        setTaskMessage('浏览器尚未登录小红书。已打开登录引导，检测到登录成功后会自动继续采集。');
        return;
      }
      setTaskMessage(result.message);
      return;
    }

    setPendingScrapeRequest(null);
  }, [startScraping]);

  const handleCollectedNotesPipeline = useCallback(async ({
    notes,
    keyword,
    collectionMode,
    sourceInput,
    appliedFilters,
    commentsEnabled,
    sourceLabel,
  }: {
    notes: ScrapedNote[];
    keyword: string;
    collectionMode: ScrapeCollectionMode;
    sourceInput: string;
    appliedFilters: SearchFilters;
    commentsEnabled: boolean;
    sourceLabel: string;
  }) => {
    const effectiveNotes = notes.slice(0, collectionMode === 'url' ? 1 : maxNotes);
    const topFormattedNotes = effectiveNotes.slice(0, 8);
    const normalizedProductBrief = normalizeProductBrief(productBrief);
    const fallbackAnalysis = buildFallbackAnalysis(effectiveNotes, productBrief);
    const commentsEnabledLabel = commentsEnabled ? '已开启评论采集' : '未开启评论采集';

    setCurrentResults(effectiveNotes);
    setTopNotes(topFormattedNotes);
    setSelectedBenchmarkNote(null);
    setShowAnalysis(false);
    setShowRawResults(false);
    setAnalysisResult(null);
    setHistoryPreviewTaskId(null);
    setWorkspaceRestoredTaskId(null);
    setScraperTab('results');
    setTaskMessage(`${sourceLabel}已完成，正在保存结果并分析...`);
    syncAnalysisIntoContext(fallbackAnalysis, productBrief);

    let savedHistoryTask: ScrapeHistoryRecord | null = null;
    let historySaveMessage = '';

    try {
      try {
        const saveResult = await apiClient.saveScrapeHistory({
          keyword,
          collection_mode: collectionMode,
          source_input: sourceInput,
          notes_count: effectiveNotes.length,
          notes_data: effectiveNotes,
          filters: appliedFilters,
          product_brief: normalizedProductBrief,
        });

        if (!saveResult?.success) {
          throw new Error(saveResult?.message || '采集结果保存失败');
        }

        latestSaveTaskIdRef.current = saveResult?.data?.task_id || null;
        savedHistoryTask = buildLocalHistoryRecord(saveResult.data as ScrapeHistoryRecord, effectiveNotes);
        upsertHistorySummary(savedHistoryTask);
        setHistoryDetail(savedHistoryTask);
        setHistoryPreviewTaskId(savedHistoryTask.task_id);
        historySaveMessage = '采集结果已保存';
      } catch (saveError: any) {
        latestSaveTaskIdRef.current = null;
        historySaveMessage = `当前结果仅保存在本页，未写入历史记录：${normalizeAppErrorMessage(saveError, '未知错误')}`;
        console.error('Failed to save scrape history:', saveError);
        setTaskMessage(`${historySaveMessage}，正在继续分析分类与对标充足度...`);
      }

      const result = await apiClient.analyzeLocalNotes(effectiveNotes, productBrief);
      if (!result.success) {
        throw new Error(result.message || '分析失败');
      }

      const normalized = normalizeAnalysis(result.data, productBrief);
      syncAnalysisIntoContext(normalized, productBrief);
      if (savedHistoryTask?.task_id) {
        await apiClient.updateScrapeHistoryAnalysis(savedHistoryTask.task_id, {
          analysis_result: result.data,
          filters: appliedFilters,
          product_brief: normalizedProductBrief,
        });
        savedHistoryTask = buildLocalHistoryRecord(savedHistoryTask, effectiveNotes, result.data);
        upsertHistorySummary(savedHistoryTask);
        setHistoryDetail(savedHistoryTask);
      }

      if (savedHistoryTask?.task_id) {
        await fetchHistories();
        await fetchHistoryDetail(savedHistoryTask.task_id, false);
      }

      setTaskMessage(
        savedHistoryTask
          ? `${sourceLabel}分析完成，已得到 ${normalized.benchmarkNotes.length} 条可用对标样本，${commentsEnabledLabel}。`
          : `${sourceLabel}分析完成，已得到 ${normalized.benchmarkNotes.length} 条可用对标样本，${commentsEnabledLabel}。${historySaveMessage}`
      );
    } catch (error: any) {
      console.error(error);
      setShowAnalysis(true);
      syncAnalysisIntoContext(fallbackAnalysis, productBrief);
      setTaskMessage(
        savedHistoryTask
          ? `${sourceLabel}分析失败，已保留当前采集结果并写入历史原始记录：${error.message || '未知错误'}，${commentsEnabledLabel}。`
          : `${sourceLabel}分析失败，已保留当前采集结果：${error.message || '未知错误'}，${commentsEnabledLabel}。${historySaveMessage || '当前结果仅保存在本页，未写入历史记录。'}`
      );
    }
  }, [
    buildLocalHistoryRecord,
    fetchHistories,
    fetchHistoryDetail,
    maxNotes,
    productBrief,
    setAnalysisResult,
    setSelectedBenchmarkNote,
    setShowAnalysis,
    setTopNotes,
    syncAnalysisIntoContext,
    upsertHistorySummary,
  ]);

  const handleUrlCollect = useCallback(async () => {
    hydrateProductBriefDraft();
    if (!validateProductBrief('采集')) {
      return;
    }

    const normalizedUrl = urlInput.trim();
    if (!normalizedUrl) {
      alert('请输入要采集的小红书笔记链接');
      return;
    }

    saveProductBriefToWorkspace();
    setIsUrlCollecting(true);
    setUrlCollectErrorCode(null);
    setUrlLastCollectedSource(null);
    setTaskMessage('正在直连解析这条小红书笔记...');

    try {
      const response = await apiClient.collectByUrl({
        url: normalizedUrl,
        enable_comments: enableComments,
      });

      if (!response.success || !response.data?.note) {
        throw new Error(response.message || 'URL 采集失败');
      }

      const collectedNote = response.data.note;
      setUrlLastCollectedNote(collectedNote);
      setUrlLastCollectedSource('direct');
      await handleCollectedNotesPipeline({
        notes: [collectedNote],
        keyword: collectedNote.title || '对标笔记URL采集',
        collectionMode: 'url',
        sourceInput: response.data.source_input || normalizedUrl,
        appliedFilters: DEFAULT_SEARCH_FILTERS,
        commentsEnabled: enableComments,
        sourceLabel: '对标笔记URL直连采集',
      });
    } catch (error) {
      const detail = extractApiDetail(error);
      setUrlCollectErrorCode(detail.code);
      setTaskMessage(detail.message);
    } finally {
      setIsUrlCollecting(false);
    }
  }, [
    enableComments,
    extractApiDetail,
    handleCollectedNotesPipeline,
    hydrateProductBriefDraft,
    saveProductBriefToWorkspace,
    urlInput,
    validateProductBrief,
  ]);

  const handleUrlBrowserFallback = useCallback(async () => {
    const normalizedUrl = urlInput.trim();
    if (!normalizedUrl) {
      return;
    }
    if (!validateProductBrief('采集')) {
      return;
    }

    saveProductBriefToWorkspace();
    setIsUrlCollecting(true);
    setTaskMessage('正在尝试浏览器态补抓这条笔记...');

    try {
      const result = await collectNoteByUrlWithBrowser(normalizedUrl, {
        enableComments,
        maxCommentsPerNote: 12,
      });

      if (!result.success || !result.data) {
        throw new Error(result.message || '浏览器态补抓失败');
      }

      setUrlCollectErrorCode(null);
      setUrlLastCollectedNote(result.data);
      setUrlLastCollectedSource('browser');
      await handleCollectedNotesPipeline({
        notes: [result.data],
        keyword: result.data.title || '对标笔记URL采集',
        collectionMode: 'url',
        sourceInput: normalizedUrl,
        appliedFilters: DEFAULT_SEARCH_FILTERS,
        commentsEnabled: enableComments,
        sourceLabel: '对标笔记URL浏览器态补抓',
      });
    } catch (error) {
      const detail = extractApiDetail(error);
      setTaskMessage(detail.message);
    } finally {
      setIsUrlCollecting(false);
    }
  }, [
    collectNoteByUrlWithBrowser,
    enableComments,
    extractApiDetail,
    handleCollectedNotesPipeline,
    saveProductBriefToWorkspace,
    urlInput,
    validateProductBrief,
  ]);

  const handleStart = async () => {
    hydrateProductBriefDraft();
    if (!query.trim()) {
      alert('请输入采集关键词');
      return;
    }
    if (!validateProductBrief('采集')) {
      return;
    }

    saveProductBriefToWorkspace();
    historyRequestVersionRef.current += 1;

    activeKeywordRef.current = query.trim();
    setScraperTab('keyword');
    setTaskMessage('');
    setCurrentResults([]);
    setUrlCollectErrorCode(null);
    setSelectedBenchmarkNote(null);
    setShowAnalysis(false);
    setAnalysisResult(null);
    setShowRawResults(false);
    setHistoryPreviewTaskId(null);
    setWorkspaceRestoredTaskId(null);
    await runScrapingTask({
      query: query.trim(),
      maxNotes,
      filters,
      enableComments,
    });
  };

  const handleLoginSuccessResume = useCallback(() => {
    if (!pendingScrapeRequest) return;
    setTaskMessage('已检测到登录态，正在继续刚才的采集任务...');
    void runScrapingTask(pendingScrapeRequest);
  }, [pendingScrapeRequest, runScrapingTask]);

  const applyFollowupTask = (task: CollectionFollowupTask) => {
    if (!SHOW_KEYWORD_COLLECTION) {
      setScraperTab('results');
      setTaskMessage(`分类补采入口已关闭：${task.category}。当前云端仅保留对标笔记 URL 采集和分析样本池浏览。`);
      return;
    }
    setQuery(task.keyword_text);
    setFilters(sanitizeSearchFilters(task.filters));
    setMaxNotes(task.max_notes_count);
    setEnableComments(task.enable_comments);
    setTaskMessage(`已载入补采任务：${task.category}，点击“开始采集”继续补样本。`);
  };

  const handleUseBenchmark = (note: BenchmarkNote) => {
    setSelectedBenchmarkNote(note);
    setCreationState((prev) => ({
      ...prev,
      productName: productBrief.product_name,
      targetAudience: productBrief.target_audience,
      productFeatures: productBrief.product_features,
      visualStyle: prev.visualStyle || '温暖渐变卡片',
      strategyMode: 'research_first',
    }));
    setTaskMessage(`已将《${note.title}》加入仿写池。现在可以进入创作页。`);
    setPreviewState(null);
  };

  const handleEnterCreation = (note?: BenchmarkNote | null, options?: { strategyMode?: 'benchmark_first' | 'research_first' }) => {
    if (!validateProductBrief('仿写')) {
      return;
    }
    saveProductBriefToWorkspace();
    const targetNote = note || selectedBenchmarkNote;
    if (!targetNote) {
      alert('先从分类样本池里选一条对标样本');
      return;
    }
    if (!selectedBenchmarkNote || selectedBenchmarkNote.id !== targetNote.id) {
      setSelectedBenchmarkNote(targetNote);
    }
    setCreationState((prev) => ({
      ...prev,
      productName: productBrief.product_name,
      targetAudience: productBrief.target_audience,
      productFeatures: productBrief.product_features,
      visualStyle: prev.visualStyle || '温暖渐变卡片',
      strategyMode: options?.strategyMode || 'research_first',
    }));
    onEnterStudio({
      productName: productBrief.product_name,
      coreFeatures: productBrief.product_features,
      targetAudience: productBrief.target_audience,
      styleDirection: '温暖渐变卡片',
    });
  };

  const handleHistoryReAnalyze = async () => {
    if (!historyDetail) return;
    hydrateProductBriefDraft();
    await reanalyzeHistoryTask(historyDetail);
  };

  const clearWorkspaceAfterHistoryDelete = useCallback((taskId: string) => {
    if (historyPreviewTaskId === taskId) {
      setHistoryPreviewTaskId(null);
      setHistoryDetail(null);
    }

    if (workspaceRestoredTaskId !== taskId) {
      return;
    }

    setWorkspaceRestoredTaskId(null);
    setCurrentResults([]);
    setTopNotes([]);
    setAnalysisResult(null);
    setBenchmarkNotes([]);
    setGroupedBenchmarkNotes({});
    setNextCollectionTasks([]);
    setRealPhrases([]);
    setSelectedBenchmarkNote(null);
    setShowAnalysis(false);
    setShowRawResults(false);
    setTaskMessage('历史记录已删除。当前工作区已清空，可重新采集或选择其他历史任务。');
  }, [
    historyPreviewTaskId,
    workspaceRestoredTaskId,
    setAnalysisResult,
    setBenchmarkNotes,
    setGroupedBenchmarkNotes,
    setNextCollectionTasks,
    setRealPhrases,
    setSelectedBenchmarkNote,
    setShowAnalysis,
    setTopNotes,
  ]);

  const handleDeleteHistory = useCallback(async (task: ScrapeHistoryRecord, event?: React.MouseEvent) => {
    event?.stopPropagation();
    if (historyDeletingTaskId) return;
    if (!window.confirm(`确定永久删除历史任务《${task.keyword}》吗？这会从数据库里真实删除，无法恢复。`)) {
      return;
    }

    try {
      setHistoryDeletingTaskId(task.task_id);
      const response = await apiClient.deleteScrapeHistory(task.task_id);
      if (!response.success) {
        throw new Error(response.message || '删除失败');
      }

      clearWorkspaceAfterHistoryDelete(task.task_id);
      await fetchHistories();
      setTaskMessage(`历史任务《${task.keyword}》已从数据库删除。`);
    } catch (error: any) {
      console.error('Delete history failed:', error);
      alert(`删除历史记录失败：${error.message || '未知错误'}`);
    } finally {
      setHistoryDeletingTaskId(null);
    }
  }, [clearWorkspaceAfterHistoryDelete, fetchHistories, historyDeletingTaskId]);

  const handleContinueRewrite = () => {
    hydrateProductBriefDraft();
    if (!validateProductBrief('仿写')) {
      return;
    }
    saveProductBriefToWorkspace();
    const activeAnalysis = displayAnalysis || (historyDetail?.analysis_result ? normalizeAnalysis(historyDetail.analysis_result, productBrief) : null);

    if (!activeAnalysis) {
      alert('当前历史任务还没有分析结果，请先点击“重新分析”。');
      return;
    }

    const targetNote = selectedBenchmarkNote || getDefaultBenchmarkNote(activeAnalysis);
    if (!targetNote) {
      alert('当前分析结果里还没有可用对标样本，请先重新分析或补采。');
      return;
    }

    setTaskMessage(`已为《${historyDetail?.keyword || query || '当前任务'}》载入最佳对标样本，正在进入仿写创作。`);
    handleEnterCreation(targetNote);
  };

  const handleRewriteNow = (note: BenchmarkNote) => {
    handleUseBenchmark(note);
    handleEnterCreation(note, { strategyMode: 'benchmark_first' });
  };

  const handleRestorePreviewTask = useCallback(() => {
    if (!historyDetail) return;
    hydrateProductBriefDraft();
    restoreHistoryToWorkspace(historyDetail);
    void recoverHistoryWorkspaceImages(historyDetail);
  }, [historyDetail, hydrateProductBriefDraft, recoverHistoryWorkspaceImages, restoreHistoryToWorkspace]);

  const updateFilter = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters(DEFAULT_SEARCH_FILTERS);
  };

  const openDetailFromRaw = (note: any) => {
    setPreviewState({
      source: 'raw',
      note: {
        id: note.id,
        title: note.title,
        desc: note.desc || '',
        author: note.author,
        authorAvatar: note.authorAvatar,
        likes: note.likes,
        stars: note.stars,
        views: note.views,
        shares: note.shares,
        imageUrl: note.imageUrl,
        imageList: note.imageList,
        stableImageUrl: note.stableImageUrl,
        stableImageList: note.stableImageList,
        resolvedImageUrl: note.resolvedImageUrl,
        resolvedImageList: note.resolvedImageList,
        tags: note.tags,
        time: note.time,
        publishedAtLabel: note.publishedAtLabel,
        commentCount: note.commentCount,
        comments: note.comments,
        content_category: '原始采集',
        category_scores: {},
        secondary_categories: [],
        commercial_fit_score: 0,
        rewrite_value_score: 0,
        recommendation_tier: '可参考',
        recommendation_reason: '该卡片来自原始采集结果，可先浏览，再结合 AI 分类结果决定是否入池。',
        material_dependency: '待分析',
      },
    });
  };

  const categoryCards = useMemo<[string, CategorySummary][]>(
    () => Object.entries(
      ((analysisResult?.benchmarkNotes?.length ? analysisResult : buildFallbackAnalysis(currentResults, productBrief))?.categorySummary || {}) as Record<string, CategorySummary>
    ),
    [analysisResult, currentResults, productBrief]
  );

  const displayAnalysis = useMemo(() => {
    if (analysisResult?.benchmarkNotes?.length || Object.keys(analysisResult?.groupedBenchmarkNotes || {}).length > 0) {
      return analysisResult;
    }
    if (currentResults.length > 0) {
      return buildFallbackAnalysis(currentResults, productBrief);
    }
    return null;
  }, [analysisResult, currentResults, productBrief]);

  useEffect(() => {
    if (!displayAnalysis?.benchmarkNotes?.length) {
      return;
    }

    if (!selectedBenchmarkNote || !displayAnalysis.benchmarkNotes.some((note) => note.id === selectedBenchmarkNote.id)) {
      const defaultNote = getDefaultBenchmarkNote(displayAnalysis);
      if (defaultNote) {
        setSelectedBenchmarkNote(defaultNote);
      }
    }
  }, [displayAnalysis, selectedBenchmarkNote, setSelectedBenchmarkNote]);

  useEffect(() => {
    if (!previewState || !workspaceRestoredTaskId || !extension) {
      previewResolvingKeyRef.current = null;
      return;
    }

    const previewKey = `${previewState.note.id}:${detailImageIndex}`;
    if (previewResolvingKeyRef.current === previewKey) {
      return;
    }
    previewResolvingKeyRef.current = previewKey;

    let cancelled = false;
    void (async () => {
      try {
        const resolved = await recoverNoteImages(previewState.note, { targetIndex: detailImageIndex });
        if (cancelled) return;
        updatePreviewResolvedNote(() => resolved);
        applyResolvedNotesToWorkspace([resolved]);
      } catch (error) {
        console.error('Recover preview image failed:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    applyResolvedNotesToWorkspace,
    detailImageIndex,
    extension,
    previewState,
    recoverNoteImages,
    updatePreviewResolvedNote,
    workspaceRestoredTaskId,
  ]);

  const categorizedDisplayGroups = useMemo(() => {
    const bestMatchNotes = dedupeBenchmarkNotes(getBestMatchNotes(displayAnalysis));
    const bestMatchKeys = new Set(bestMatchNotes.map((note) => buildNoteIdentity(note)));
    const sortedGroupedEntries = Object.entries((displayAnalysis?.groupedBenchmarkNotes || {}) as Record<string, BenchmarkNote[]>).map(([category, notes]) => ({
      category,
      notes: sortNotesByPriority(
        dedupeBenchmarkNotes(notes).filter((note) => !bestMatchKeys.has(buildNoteIdentity(note)))
      ),
    })).filter((group) => group.notes.length > 0).sort((a, b) => {
      const priorityDiff = getCategoryPriority(a.category) - getCategoryPriority(b.category);
      if (priorityDiff !== 0) return priorityDiff;
      return getNotePriorityScore(b.notes[0]) - getNotePriorityScore(a.notes[0]);
    });

    const seenKeys = new Set(bestMatchNotes.map((note) => buildNoteIdentity(note)));
    const otherGroups = sortedGroupedEntries
      .map((group) => {
        const dedupedNotes = group.notes.filter((note) => {
          const key = buildNoteIdentity(note);
          if (seenKeys.has(key)) {
            return false;
          }
          seenKeys.add(key);
          return true;
        });
        return {
          ...group,
          notes: dedupedNotes,
        };
      })
      .filter((group) => group.notes.length > 0);

    return [
      ...(bestMatchNotes.length > 0 ? [{ category: '最符合需求', notes: bestMatchNotes }] : []),
      ...otherGroups,
    ];
  }, [displayAnalysis]);

  const filteredHistories = useMemo(() => {
    const keyword = historySearch.trim().toLowerCase();
    return histories.filter((item) => item.keyword.toLowerCase().includes(keyword));
  }, [histories, historySearch]);
  const bestMatchNotes = useMemo(() => getBestMatchNotes(displayAnalysis), [displayAnalysis]);
  const canUseBrowserUrlFallback = urlCollectErrorCode === 'token_expired_or_blocked' && Boolean(urlInput.trim());

  const currentResultCount = currentResults.length;
  const showRawResultsAsPrimary = categorizedDisplayGroups.length === 0;
  const displayBenchmarkNotes = displayAnalysis?.benchmarkNotes || [];
  const displayNextCollectionTasks = displayAnalysis?.nextCollectionTasks || [];
  const displayRealPhrases = displayAnalysis?.realPhrases || [];
  const displayBasicStats = displayAnalysis?.basicStats || {
    avgLikes: 0,
    avgCollects: 0,
    avgTitleLength: 0,
    emojiUsageRate: 0,
    avgComments: 0,
  };
  const analysisNoteCount = displayBenchmarkNotes.length || currentResultCount;
  const hasStrictBestMatch = bestMatchNotes.length > 0;
  const selectedIsStrictBestMatch = Boolean(selectedBenchmarkNote && bestMatchNotes.some((note) => note.id === selectedBenchmarkNote.id));
  const diagnosticsEntryCount = filterDebugEntries.length + (enableComments ? commentDebugEntries.length : 0);
  const currentWorkspaceLabel = workspaceRestoredTaskId && historyDetail?.task_id === workspaceRestoredTaskId
    ? `当前页面已载入：${historyDetail.keyword}`
    : workspaceRestoredTaskId
      ? '当前页面已载入其他历史结果'
      : currentResults.length > 0
        ? '当前页面是本轮采集结果'
        : '当前页面还没有载入结果';
  const activeHistoryMode = getHistoryCollectionMode(historyDetail);

  return (
    <div className="px-6 py-6">
      <div className="max-w-[1600px] mx-auto grid grid-cols-1 xl:grid-cols-[340px_minmax(0,1fr)] gap-6 items-start">
        <aside className="hidden xl:flex flex-col gap-4 xl:sticky xl:top-6 xl:self-start xl:h-[calc(100vh-8rem)] xl:overflow-hidden">
            <div className="shrink-0 rounded-3xl border border-white/5 bg-xhs-card/80 backdrop-blur-xl overflow-hidden">
              <div className="p-5 border-b border-white/5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-white text-lg font-semibold">产品参数</h3>
                    <p className="text-xs text-slate-400 mt-1 leading-5">当前工作区正在使用的产品参数。</p>
                  </div>
                  <button
                    onClick={() => setIsProductBriefExpanded((prev) => !prev)}
                    className="shrink-0 inline-flex h-8 items-center rounded-full border border-white/10 bg-white/5 px-3 text-xs text-slate-300 hover:text-white hover:bg-white/10"
                  >
                    {isProductBriefExpanded ? '收起' : '展开'}
                  </button>
                </div>
              </div>
              <div className="bg-black/10 p-4">
                <div
                  data-testid="product-brief-scroll-region"
                  className={`space-y-3 ${isProductBriefExpanded ? 'xl:max-h-[calc(100vh-30rem)] xl:min-h-[16rem] xl:overflow-y-auto xl:pr-1 custom-scrollbar' : ''}`}
                >
                  <div className="rounded-2xl bg-black/20 border border-white/5 p-4 space-y-2">
                    <div className="text-sm font-medium text-white line-clamp-1">{productBrief.product_name || '未填写产品名称'}</div>
                    <div className="text-xs text-slate-400 line-clamp-2">{productBrief.target_audience || '未填写目标人群'}</div>
                    <div className="text-xs text-slate-500 line-clamp-3">{productBrief.product_features || '未填写核心卖点'}</div>
                    <div className="text-[11px] text-slate-500 line-clamp-2">{productBrief.reference_urls?.length ? `已配置 ${productBrief.reference_urls.length} 个产品资料链接` : '未配置产品资料链接'}</div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <span className={`px-2 py-1 rounded-full text-[11px] border ${isProductBriefComplete(productBrief) ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>
                      {isProductBriefComplete(productBrief) ? '可直接分析' : '待补全核心字段'}
                    </span>
                    {productBriefStatus.isDirty && (
                      <span className="px-2 py-1 rounded-full text-[11px] border border-amber-500/20 bg-amber-500/10 text-amber-300">
                        当前分类结果基于旧参数
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {productBriefStatus.updatedAt ? `草稿已自动保存：${new Date(productBriefStatus.updatedAt).toLocaleString()}` : '尚未写入工作区草稿'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {currentWorkspaceLabel}
                  </div>
                </div>

                {isProductBriefExpanded && (
                  <div className="space-y-3">
                    <input
                      value={productBrief.product_name}
                      onChange={(e) => updateDraftProductBrief('product_name', e.target.value)}
                      placeholder="产品名称"
                      className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
                    />
                    <input
                      value={productBrief.target_audience}
                      onChange={(e) => updateDraftProductBrief('target_audience', e.target.value)}
                      placeholder="目标人群"
                      className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
                    />
                    <textarea
                      value={productBrief.product_features}
                      onChange={(e) => updateDraftProductBrief('product_features', e.target.value)}
                      placeholder="产品卖点、差异点、使用场景"
                      rows={4}
                      className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-2xl text-white placeholder:text-slate-500 resize-none"
                    />
                    <input
                      value={productBrief.brand_tone}
                      onChange={(e) => updateDraftProductBrief('brand_tone', e.target.value)}
                      placeholder="品牌语气"
                      className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
                    />
                    <input
                      value={productBrief.must_include}
                      onChange={(e) => updateDraftProductBrief('must_include', e.target.value)}
                      placeholder="必须提及的卖点/活动"
                      className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
                    />
                    <input
                      value={productBrief.banned_terms}
                      onChange={(e) => updateDraftProductBrief('banned_terms', e.target.value)}
                      placeholder="禁用词/不想出现的话术"
                      className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
                    />
                    <textarea
                      value={productBriefUrlsToText(productBrief)}
                      onChange={(e) => updateDraftProductBrief('reference_urls', parseProductBriefUrlsText(e.target.value))}
                      placeholder="产品资料链接，一行一个。支持官网、帮助中心、落地页"
                      rows={3}
                      className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-2xl text-white placeholder:text-slate-500 resize-none"
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={saveProductBriefToWorkspace}
                        className="h-10 rounded-xl bg-white text-slate-900 text-sm font-medium"
                      >
                        已自动保存
                      </button>
                      <button
                        onClick={() => setIsProductBriefExpanded(false)}
                        className="h-10 rounded-xl text-sm font-medium bg-white/5 text-slate-300 border border-white/10"
                      >
                        收起参数卡
                      </button>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-xs text-slate-300 leading-5">
                      左侧历史任务只会预览或载入结果，不会覆盖这里的参数。
                    </div>
                  </div>
                )}
                </div>
              </div>
            </div>

            <div className="flex min-h-[24rem] flex-1 flex-col overflow-hidden rounded-3xl border border-white/5 bg-xhs-card/80 backdrop-blur-xl xl:min-h-0">
            <div className="shrink-0 space-y-3 border-b border-white/5 p-4 xl:p-5">
              <div className="min-w-0">
                <h3 className="text-white text-lg font-semibold">历史采集任务</h3>
                <p className="text-xs text-slate-400 mt-1 leading-5">点任务先看摘要，需要时再把结果载入当前页面。</p>
              </div>
              {historyLoadError && (
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-xs text-amber-200 leading-5">
                  <div>{historyLoadError}</div>
                  <button
                    onClick={() => void fetchHistories('manual_retry')}
                    className="mt-2 rounded-lg bg-white/10 px-3 py-1.5 text-[11px] text-white hover:bg-white/15"
                  >
                    立即重试
                  </button>
                </div>
              )}
              <input
                value={historySearch}
                onChange={(event) => setHistorySearch(event.target.value)}
                placeholder="搜索历史关键词..."
                className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
              />
            </div>

            <div data-testid="history-list-scroll-region" className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 xl:px-4 space-y-3">
              {loadingHistories && <div className="text-sm text-slate-400 p-3">正在加载历史记录...</div>}
              {!loadingHistories && filteredHistories.length === 0 && (
                <div className="text-sm text-slate-500 p-3">暂无历史记录</div>
              )}
              {filteredHistories.map((history) => {
                const isActive = historyPreviewTaskId === history.task_id;
                const hasAnalysis = Boolean(history.has_analysis || history.analysis_result);
                const filterSummary = sanitizeSearchFilters(history.filters);
                const isDeleting = historyDeletingTaskId === history.task_id;
                const collectionMode = getHistoryCollectionMode(history);
                const sourceMeta = collectionMode === 'url' ? formatHistorySourceMeta(history.source_input) : null;
                return (
                  <div
                    key={history.task_id}
                    className={`w-full text-left rounded-2xl border p-4 transition-all ${
                      isActive
                        ? 'border-white/15 bg-white/[0.06] shadow-[0_0_0_1px_rgba(255,255,255,0.04)]'
                        : 'border-white/5 bg-black/20 hover:bg-white/5'
                    }`}
                  >
                    <button
                      onClick={() => fetchHistoryDetail(history.task_id, false)}
                      className="w-full text-left"
                      disabled={isDeleting}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-white truncate">{history.keyword}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className={`px-2 py-1 rounded-full border text-[11px] ${collectionModeBadgeStyles[collectionMode]}`}>
                              {collectionModeLabelMap[collectionMode]}
                            </span>
                            <span className={`px-2 py-1 rounded-full border text-[11px] ${hasAnalysis ? historyBadgeStyles.analyzed : historyBadgeStyles.raw}`}>
                              {hasAnalysis ? '已分析' : '原始数据'}
                            </span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[11px] text-slate-500">{new Date(history.created_at).toLocaleDateString()}</div>
                          <div className="mt-1 text-xs text-slate-400">{history.notes_count} 条</div>
                        </div>
                      </div>
                      {collectionMode === 'url' && sourceMeta ? (
                        <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-3">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">{sourceMeta.host}</div>
                          <div className="mt-1 text-xs font-medium text-slate-200 line-clamp-1">{sourceMeta.primary}</div>
                          {sourceMeta.secondary ? (
                            <div className="mt-1 text-[11px] text-slate-500 line-clamp-1">{sourceMeta.secondary}</div>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-3 text-[11px] text-slate-500">
                          {`${filterSummary.sortBy} / ${filterSummary.noteType} / ${filterSummary.publishTime}`}
                        </div>
                      )}
                    </button>
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={(event) => handleDeleteHistory(history, event)}
                        disabled={isDeleting}
                        className={`rounded-lg px-3 py-1.5 text-xs transition ${
                          isDeleting
                            ? 'bg-rose-500/10 text-rose-200/60 cursor-not-allowed'
                            : 'bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                        }`}
                      >
                        {isDeleting ? '删除中...' : '删除'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="shrink-0 min-h-0 border-t border-white/5 bg-black/10">
              {historyDetail ? (
                <>
                  <div className="flex items-start justify-between gap-3 px-4 py-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white line-clamp-1">{historyDetail.keyword}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>{new Date(historyDetail.created_at).toLocaleDateString()} · {historyDetail.notes_count} 条</span>
                        <span className={`px-2 py-1 rounded-full border text-[11px] ${collectionModeBadgeStyles[activeHistoryMode]}`}>
                          {collectionModeLabelMap[activeHistoryMode]}
                        </span>
                      </div>
                      {!isHistoryDetailExpanded && (
                        <div className="mt-2 text-xs text-slate-400">
                          已选中这条历史记录，展开后可载入结果、重分析或继续仿写。
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setIsHistoryDetailExpanded((prev) => !prev)}
                      className="shrink-0 inline-flex h-8 items-center rounded-full border border-white/10 bg-white/5 px-3 text-xs text-slate-300 hover:bg-white/10"
                    >
                      {isHistoryDetailExpanded ? '收起详情' : '展开详情'}
                    </button>
                  </div>
                  {!isHistoryDetailExpanded && (
                    <div className="grid grid-cols-2 gap-3 px-4 pb-4">
                      <button
                        onClick={handleRestorePreviewTask}
                        className="h-10 rounded-xl bg-white text-slate-900 text-sm font-medium"
                      >
                        载入结果
                      </button>
                      <button
                        onClick={() => setIsHistoryDetailExpanded(true)}
                        className="h-10 rounded-xl border border-white/10 bg-white/5 text-sm font-medium text-slate-200"
                      >
                        展开详情
                      </button>
                    </div>
                  )}
                  {isHistoryDetailExpanded && (
                    <div className="px-4 pb-4 space-y-3 max-h-[44vh] overflow-y-auto custom-scrollbar">
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
                          <div className="text-slate-500">筛选</div>
                          <div className="mt-1 text-slate-200">
                            {activeHistoryMode === 'url' ? '单条 URL 采集' : sanitizeSearchFilters(historyDetail.filters).sortBy}
                          </div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
                          <div className="text-slate-500">类型</div>
                          <div className="mt-1 text-slate-200">{activeHistoryMode === 'url' ? '特殊 URL' : sanitizeSearchFilters(historyDetail.filters).noteType}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
                          <div className="text-slate-500">时间</div>
                          <div className="mt-1 text-slate-200">{sanitizeSearchFilters(historyDetail.filters).publishTime}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2.5">
                          <div className="text-slate-500">状态</div>
                          <div className="mt-1 text-slate-200">{historyDetail.analysis_result ? '已有分类结果' : '只有原始数据'}</div>
                        </div>
                      </div>
                      {activeHistoryMode === 'url' && historyDetail.source_input && (
                        <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-slate-500">
                            {formatHistorySourceMeta(historyDetail.source_input).host}
                          </div>
                          <div className="mt-2 text-xs font-medium text-slate-200 break-all">
                            {formatHistorySourceMeta(historyDetail.source_input).primary}
                          </div>
                          {formatHistorySourceMeta(historyDetail.source_input).secondary ? (
                            <div className="mt-2 text-[11px] text-slate-500 break-all">
                              {formatHistorySourceMeta(historyDetail.source_input).secondary}
                            </div>
                          ) : null}
                        </div>
                      )}
                      <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-xs text-slate-300 leading-5">
                        这里仅预览历史记录。载入结果不会改产品参数；重新分析会用当前产品参数重排分类。
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          onClick={handleRestorePreviewTask}
                          className="h-10 rounded-xl bg-white text-slate-900 text-sm font-medium"
                        >
                          载入结果
                        </button>
                        <button
                          onClick={handleHistoryReAnalyze}
                          disabled={historyReanalyzing}
                          className={`h-10 rounded-xl text-sm font-medium ${
                            historyReanalyzing ? 'bg-xhs-red/40 text-white/60' : 'bg-xhs-red text-white'
                          }`}
                        >
                          {historyReanalyzing ? '分析中...' : '重新分析'}
                        </button>
                        <button
                          onClick={handleContinueRewrite}
                          disabled={historyReanalyzing || historyDeletingTaskId === historyDetail.task_id}
                          className={`h-10 rounded-xl text-sm font-medium border ${
                            historyReanalyzing || historyDeletingTaskId === historyDetail.task_id
                              ? 'bg-white/5 text-slate-500 border-white/5'
                              : 'bg-white/10 text-white border-white/10'
                          }`}
                        >
                          继续仿写
                        </button>
                        <button
                          onClick={() => void fetchHistories('detail_refresh')}
                          disabled={Boolean(historyDeletingTaskId)}
                          className="h-10 rounded-xl bg-white/5 text-slate-300 text-sm font-medium border border-white/10"
                        >
                          刷新历史
                        </button>
                        <button
                          onClick={(event) => handleDeleteHistory(historyDetail, event)}
                          disabled={historyReanalyzing || historyDeletingTaskId === historyDetail.task_id}
                          className={`col-span-2 h-10 rounded-xl text-sm font-medium ${
                            historyReanalyzing || historyDeletingTaskId === historyDetail.task_id
                              ? 'bg-rose-500/15 text-rose-200/60'
                              : 'bg-rose-500/15 text-rose-200 hover:bg-rose-500/25'
                          }`}
                        >
                          {historyDeletingTaskId === historyDetail.task_id ? '删除中...' : '删除记录'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="px-4 py-4 text-sm text-slate-500">选择左侧任务后，这里会显示恢复与继续仿写入口。</div>
              )}
            </div>
            </div>
        </aside>

        <div className="space-y-8 min-w-0">
          <section className="space-y-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="space-y-2">
                <h2 className="text-3xl font-bold tracking-tight text-white">分类驱动采集台</h2>
                <p className="text-slate-400 text-sm">当前云端仅保留对标笔记 URL 采集和分析样本池，常规分类采集入口已关闭。</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-1 inline-flex gap-1 self-start">
                {[
                  { key: 'url', label: '对标笔记URL采集' },
                  { key: 'results', label: '分析样本池' },
                ].map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => setScraperTab(tab.key as ScraperWorkbenchTab)}
                    className={`rounded-xl px-4 py-2 text-sm transition ${
                      scraperTab === tab.key
                        ? 'bg-white text-slate-900 font-semibold'
                        : 'text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-white/5 bg-xhs-card/70 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Product Brief</div>
                  <div className="mt-2 text-lg font-semibold text-white">
                    {productBrief.product_name || '请先补全产品参数'}
                  </div>
                  <div className="mt-2 text-sm text-slate-400 line-clamp-2">
                    {productBrief.target_audience || '未填写目标人群'} · {productBrief.product_features || '未填写核心卖点'}
                  </div>
                  {taskMessage && (
                    <div className="mt-3 text-sm text-slate-300">{taskMessage}</div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className={`px-2.5 py-1 rounded-full text-[11px] border ${isProductBriefComplete(productBrief) ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/20 bg-amber-500/10 text-amber-300'}`}>
                      {isProductBriefComplete(productBrief) ? '可直接分析' : '待补全核心字段'}
                    </span>
                    {productBriefStatus.isDirty && (
                      <span className="px-2.5 py-1 rounded-full text-[11px] border border-amber-500/20 bg-amber-500/10 text-amber-300">
                        当前分类结果基于旧参数
                      </span>
                    )}
                    <span className="px-2.5 py-1 rounded-full text-[11px] border border-white/10 bg-white/5 text-slate-300">
                      {currentWorkspaceLabel}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => setIsProductBriefExpanded(true)}
                    className="h-11 rounded-xl bg-white/10 px-4 text-sm font-medium text-white hover:bg-white/15 xl:hidden"
                  >
                    编辑产品参数
                  </button>
                  <button
                    onClick={() => setIsHistoryDrawerOpen(true)}
                    className="h-11 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-200 xl:hidden"
                  >
                    查看历史任务
                  </button>
                </div>
              </div>
            </div>
          </section>

          {SHOW_KEYWORD_COLLECTION && scraperTab === 'keyword' && (
            <section className="bg-xhs-card/60 backdrop-blur-md border border-white/5 rounded-3xl p-6 shadow-xl space-y-6 relative">
                <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-2">采集关键词</label>
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="例如：护眼台灯、控油底妆、便携咖啡机"
                      className="w-full h-12 px-4 bg-xhs-panel/80 border border-white/15 rounded-xl text-white placeholder:text-slate-500"
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-2">数量</label>
                      <input
                        type="number"
                        value={maxNotes}
                        onChange={(e) => setMaxNotes(Number(e.target.value) || 20)}
                        className="w-full h-12 px-4 bg-xhs-panel/80 border border-white/15 rounded-xl text-white"
                      />
                    </div>
                    <div className="col-span-2 flex items-end justify-end">
                      <div className="flex min-h-12 w-full flex-wrap items-center justify-end gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 lg:w-auto">
                        <label className="flex min-h-8 items-center gap-3 rounded-xl border border-transparent px-2 text-sm text-slate-200">
                          <input
                            type="checkbox"
                            checked={enableComments}
                            onChange={(e) => setEnableComments(e.target.checked)}
                            className="h-4 w-4 rounded border-white/20 bg-transparent"
                          />
                          <span className="font-medium">采评论</span>
                        </label>
                        <span
                          className={`inline-flex min-h-8 items-center rounded-full border px-3 text-xs ${
                            enableComments
                              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
                              : 'border-white/10 bg-white/5 text-slate-400'
                          }`}
                        >
                          {enableComments ? '评论采集已开启' : '评论采集已关闭'}
                        </span>
                        <button
                          onClick={() => setIsFilterOpen((prev) => !prev)}
                          className={`inline-flex h-10 items-center rounded-xl border px-4 text-sm font-medium transition ${
                            isFilterOpen
                              ? 'border-rose-400/25 bg-rose-500/12 text-rose-100'
                              : 'border-white/15 bg-white/5 text-white hover:bg-white/10'
                          }`}
                        >
                          筛选
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  {filterSections.map((section) => (
                    <span key={section.key} className="px-3 py-1.5 rounded-full bg-white/5 text-slate-300 text-sm">
                      {section.label}：{filters[section.key]}
                    </span>
                  ))}
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/10 px-4 py-4 flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white font-medium line-clamp-1">
                      当前产品：{productBrief.product_name || '请先补全产品参数'}
                    </div>
                    <div className="mt-1 text-xs text-slate-400 line-clamp-2">
                      {productBrief.target_audience || '未填写目标人群'} · {productBrief.product_features || '未填写核心卖点'}
                    </div>
                  </div>
                  {productBriefStatus.isDirty && (
                    <span className="px-3 py-1.5 rounded-full bg-amber-500/10 text-amber-300 text-xs border border-amber-500/20">
                      分类结果待按新参数刷新
                    </span>
                  )}
                  <button
                    onClick={() => setIsProductBriefExpanded(true)}
                    className="h-10 px-4 rounded-xl bg-white/10 text-white text-sm font-medium"
                  >
                    编辑产品参数
                  </button>
                </div>

                <div className="flex flex-wrap gap-3 items-center">
                  <button
                    onClick={handleStart}
                    disabled={isExtensionScraping || isAnalyzing}
                    className={`px-6 h-12 rounded-xl font-semibold transition-all ${(isExtensionScraping || isAnalyzing) ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-xhs-red hover:bg-xhs-dark text-white'}`}
                  >
                    {isExtensionScraping ? (statusMessage || '插件采集中...') : isAnalyzing ? '分析中...' : '开始采集'}
                  </button>
                  <button
                    onClick={() => handleEnterCreation()}
                    disabled={!selectedBenchmarkNote}
                    className={`px-6 h-12 rounded-xl font-semibold transition-all ${selectedBenchmarkNote ? 'bg-white text-slate-900 hover:bg-slate-100' : 'bg-white/10 text-slate-500 cursor-not-allowed'}`}
                  >
                    进入仿写创作
                  </button>
                  <button
                    onClick={() => setShowDiagnostics((prev) => !prev)}
                    className={`h-12 rounded-xl border px-4 text-sm font-medium transition ${
                      showDiagnostics
                        ? 'border-sky-400/30 bg-sky-500/12 text-sky-100'
                        : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {showDiagnostics ? '隐藏排查日志' : '查看排查日志'}
                    {diagnosticsEntryCount > 0 ? ` (${diagnosticsEntryCount})` : ''}
                  </button>
                  <span className="text-sm text-slate-400">{taskMessage}</span>
                </div>

                {showDiagnostics && filterDebugEntries.length > 0 && (
                  <div className="rounded-2xl border border-sky-500/20 bg-sky-500/8 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-sky-200">筛选排查日志</div>
                        <div className="mt-1 text-xs text-sky-100/80">
                          默认隐藏，但会持续保留本轮筛选面板扫描、点击结果和最终请求摘要，方便需要时一键展开查看。
                        </div>
                      </div>
                      <div className="text-xs text-sky-100/70">最近 {filterDebugEntries.length} 条</div>
                    </div>
                    <div className="mt-3 max-h-72 space-y-2 overflow-y-auto custom-scrollbar pr-1">
                      {filterDebugEntries.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-white/8 bg-black/15 px-3 py-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-full bg-white/10 px-2 py-1 text-sky-100">{entry.stage}</span>
                            <span className="text-sky-100/60">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                          </div>
                          <div className="mt-2 text-sm text-sky-50">{entry.message}</div>
                          {entry.detail && (
                            <div className="mt-1 break-all text-xs leading-5 text-sky-100/75">{entry.detail}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {showDiagnostics && enableComments && commentDebugEntries.length > 0 && (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-amber-200">评论排查日志</div>
                        <div className="mt-1 text-xs text-amber-100/80">
                          默认隐藏，但会保留本轮评论抓取轨迹；排查时再展开，不会干扰日常使用。
                        </div>
                      </div>
                      <div className="text-xs text-amber-100/70">最近 {commentDebugEntries.length} 条</div>
                    </div>
                    <div className="mt-3 max-h-72 space-y-2 overflow-y-auto custom-scrollbar pr-1">
                      {commentDebugEntries.map((entry) => (
                        <div key={entry.id} className="rounded-xl border border-white/8 bg-black/15 px-3 py-3">
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded-full bg-white/10 px-2 py-1 text-amber-100">{entry.stage}</span>
                            <span className="text-amber-50">{entry.noteId || 'unknown-note'}</span>
                            <span className="text-amber-100/60">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                          </div>
                          <div className="mt-2 text-sm text-amber-50">{entry.message}</div>
                          {entry.detail && (
                            <div className="mt-1 break-all text-xs leading-5 text-amber-100/75">{entry.detail}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {historyImageRecoveryNotice && workspaceRestoredTaskId && (
                  <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-200">
                    {historyImageRecoveryNotice}
                  </div>
                )}

                {isFilterOpen && (
                  <div className="absolute right-6 top-24 z-20 w-full max-w-[560px] rounded-3xl border border-white/10 bg-[#18181b]/95 backdrop-blur-xl p-6 shadow-2xl">
                    <div className="flex items-center justify-between mb-6">
                      <div>
                        <h3 className="text-xl font-bold text-white">筛选面板</h3>
                        <p className="text-sm text-slate-400 mt-1">按小红书当前搜索筛选结构配置采集条件。</p>
                      </div>
                      <button onClick={() => setIsFilterOpen(false)} className="text-slate-400 hover:text-white">收起</button>
                    </div>
                    <div className="space-y-6">
                      {filterSections.map((section) => (
                        <div key={section.key}>
                          <div className="text-sm text-slate-300 mb-3">{section.label}</div>
                          <div className="flex flex-wrap gap-3">
                            {section.options.map((option) => (
                              <button
                                key={`${section.key}-${option}`}
                                onClick={() => updateFilter(section.key, option as never)}
                                className={`px-4 py-2 rounded-xl text-sm transition-all ${
                                  filters[section.key] === option
                                    ? 'bg-rose-100 text-xhs-red'
                                    : 'bg-white/5 text-slate-300 hover:bg-white/10'
                                }`}
                              >
                                {option}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-6 pt-5 border-t border-white/10 flex items-center justify-between">
                      <button onClick={resetFilters} className="text-sm text-slate-400 hover:text-white">重置</button>
                      <button
                        onClick={() => setIsFilterOpen(false)}
                        className="px-4 py-2 rounded-xl bg-white text-slate-900 text-sm font-medium"
                      >
                        应用并收起
                      </button>
                    </div>
                  </div>
                )}
            </section>
          )}

          {scraperTab === 'url' && (
            <section className="bg-xhs-card/60 backdrop-blur-md border border-white/5 rounded-3xl p-6 shadow-xl space-y-6">
              <div className="space-y-2">
                <h3 className="text-2xl font-bold text-white">对标笔记URL采集</h3>
                <p className="text-sm text-slate-400">首版只支持单条小红书 `explore` 笔记链接。系统会先尝试直连解析，失败时再由你主动触发浏览器态补抓。</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                <label className="block text-xs text-slate-400 mb-2">笔记链接</label>
                <textarea
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  placeholder="粘贴 https://www.xiaohongshu.com/explore/... 这类完整笔记链接"
                  rows={4}
                  className="w-full rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white placeholder:text-slate-500 resize-none"
                />
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <button
                    onClick={() => void handleUrlCollect()}
                    disabled={isUrlCollecting}
                    className={`px-5 h-11 rounded-xl font-semibold transition ${isUrlCollecting ? 'bg-slate-700 text-slate-300 cursor-not-allowed' : 'bg-xhs-red text-white hover:bg-xhs-dark'}`}
                  >
                    {isUrlCollecting ? '采集中...' : '开始对标笔记URL采集'}
                  </button>
                  {canUseBrowserUrlFallback && (
                    <button
                      onClick={() => void handleUrlBrowserFallback()}
                      disabled={isUrlCollecting}
                      className="px-5 h-11 rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-100 font-medium"
                    >
                      尝试浏览器态补抓
                    </button>
                  )}
                  <span className="text-sm text-slate-400">{taskMessage}</span>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4 space-y-3">
                  <div className="text-sm font-semibold text-white">URL 采集说明</div>
                  <div className="text-sm text-slate-300 leading-6">
                    直连成功时会直接拿正文、图片 URL、作者和互动数据，并自动进入历史记录、分析和仿写链路。
                  </div>
                  <div className="text-sm text-slate-300 leading-6">
                    如果返回 token 失效或风控拦截，再使用浏览器态补抓，避免默认依赖插件。
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/10 p-4">
                  <div className="text-sm font-semibold text-white">当前策略</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">直连优先</span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">单条 URL</span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">并入主链路</span>
                  </div>
                </div>
              </div>

              {urlLastCollectedNote && (
                <div className="rounded-3xl border border-white/10 bg-black/10 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] ${collectionModeBadgeStyles.url}`}>URL</span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                      {urlLastCollectedSource === 'browser' ? '浏览器态补抓' : '直连解析'}
                    </span>
                  </div>
                  <div className="mt-4 flex gap-4">
                    <NoteCoverImage
                      imageUrl={urlLastCollectedNote.imageUrl}
                      imageList={urlLastCollectedNote.imageList}
                      stableImageUrl={urlLastCollectedNote.stableImageUrl}
                      stableImageList={urlLastCollectedNote.stableImageList}
                      resolvedImageUrl={urlLastCollectedNote.resolvedImageUrl}
                      resolvedImageList={urlLastCollectedNote.resolvedImageList}
                      alt={urlLastCollectedNote.title}
                      className="h-32 w-24 rounded-2xl object-cover bg-white/5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-lg font-semibold text-white line-clamp-2">{urlLastCollectedNote.title || '无标题'}</div>
                      <div className="mt-2 text-sm text-slate-400">{urlLastCollectedNote.author || '未知作者'}</div>
                      <div className="mt-3 text-sm text-slate-300 line-clamp-4">{urlLastCollectedNote.desc || '暂无正文'}</div>
                      <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
                        <span>点赞 {urlLastCollectedNote.likes}</span>
                        <span>收藏 {urlLastCollectedNote.stars}</span>
                        <span>评论 {urlLastCollectedNote.commentCount || 0}</span>
                        <span>图片 {(urlLastCollectedNote.imageList || []).length}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {scraperTab === 'results' && (showAnalysis || currentResultCount > 0) && (
                <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
                    <p className="text-xs text-slate-500">当前结果</p>
                    <p className="text-3xl font-bold text-white mt-2">{currentResultCount}</p>
                  </div>
                  <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
                    <p className="text-xs text-slate-500">爆款样本</p>
                    <p className="text-3xl font-bold text-white mt-2">{displayAnalysis?.viralNotesCount || 0}</p>
                  </div>
                  <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
                    <p className="text-xs text-slate-500">平均点赞</p>
                    <p className="text-3xl font-bold text-white mt-2">{displayBasicStats.avgLikes || 0}</p>
                  </div>
                  <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
                    <p className="text-xs text-slate-500">可用对标</p>
                    <p className="text-3xl font-bold text-white mt-2">{displayBenchmarkNotes.length}</p>
                  </div>
                </section>
              )}

              {scraperTab === 'results' && displayAnalysis && categorizedDisplayGroups.length > 0 ? (
                <section className="bg-xhs-card border border-white/5 rounded-3xl p-6">
                  <div className="flex items-center justify-between mb-5">
                    <div>
                      <h3 className="text-xl font-bold text-white">AI 分类推荐结果</h3>
                      <p className="text-sm text-slate-400">当前工作区已按产品相关性、仿写值和商业适配排好序，优先候选会放在最前。</p>
                    </div>
                    <div className="text-sm text-slate-500">
                      共 {displayBenchmarkNotes.length} 条进入分类样本池
                    </div>
                  </div>
                  {!hasStrictBestMatch && (
                    <div className="mb-5 rounded-3xl border border-amber-500/20 bg-amber-500/6 p-5">
                      <div className="text-sm font-semibold text-amber-200">本次采集任务无最符合需求的样本</div>
                      <p className="mt-2 text-sm text-slate-300">
                        当前已完成 {analysisNoteCount} 篇内容分析，本轮目标采集 {maxNotes} 篇，实际入池 {currentResultCount} 篇；
                        目前还没有样本同时满足“强推荐 + 仿写值高 + 商业适配高”的门槛。
                        建议调整产品参数后重分析，或继续补采更贴近需求的内容。
                      </p>
                    </div>
                  )}
                  {selectedBenchmarkNote && (
                    <div className={`mb-5 rounded-3xl border p-5 ${selectedIsStrictBestMatch ? 'border-emerald-500/20 bg-emerald-500/6' : 'border-amber-500/20 bg-amber-500/6'}`}>
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <div className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${selectedIsStrictBestMatch ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
                            {selectedIsStrictBestMatch ? '当前优先候选' : '当前最佳可用候选'}
                          </div>
                          <h4 className="mt-3 text-lg font-semibold text-white">{selectedBenchmarkNote.title || '无标题'}</h4>
                          <p className="mt-2 text-sm text-slate-400">
                            {selectedBenchmarkNote.content_category} · 仿写值 {selectedBenchmarkNote.rewrite_value_score} · 商业适配 {selectedBenchmarkNote.commercial_fit_score}
                          </p>
                          <p className="mt-2 text-sm text-slate-300">
                            {selectedIsStrictBestMatch
                              ? '这条样本在当前产品参数下综合匹配度最高，可以直接作为优先仿写对象。'
                              : '这条样本虽然不是最高优先级，但它仍然是当前这批内容里最值得先参考的一条。'}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-3">
                          <button onClick={() => setPreviewState({ source: 'benchmark', note: selectedBenchmarkNote })} className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 text-slate-200 text-sm">
                            查看样本
                          </button>
                          <button onClick={() => handleEnterCreation(selectedBenchmarkNote, { strategyMode: 'benchmark_first' })} className="px-4 py-2 rounded-xl bg-xhs-red text-white text-sm font-medium">
                            一键仿写
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="space-y-5">
                    {categorizedDisplayGroups.map(({ category, notes }) => (
                      <div key={`collected-${category}`} className="rounded-3xl border border-white/5 bg-black/20 p-5">
                        <div className="flex items-center justify-between mb-4">
                          <div>
                            <h4 className="text-lg font-semibold text-white">{category}</h4>
                            <p className="text-sm text-slate-500 mt-1">该分类下共 {notes.length} 条推荐样本</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                          {notes.map((note, index) => (
                            <div
                              key={`categorized-${note.id}`}
                              className={`rounded-2xl border p-4 flex gap-4 cursor-pointer transition-colors ${
                                selectedBenchmarkNote?.id === note.id
                                  ? 'border-emerald-500/35 bg-emerald-500/8'
                                  : 'border-white/5 bg-[#151515] hover:bg-white/5'
                              }`}
                              onClick={() => setPreviewState({ source: 'categorized', note })}
                            >
                              <NoteCoverImage
                                imageUrl={note.imageUrl}
                                imageList={note.imageList}
                                stableImageUrl={note.stableImageUrl}
                                stableImageList={note.stableImageList}
                                resolvedImageUrl={note.resolvedImageUrl}
                                resolvedImageList={note.resolvedImageList}
                                alt={note.title}
                                className="w-24 h-32 rounded-2xl object-cover bg-white/5 shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="inline-flex px-2.5 py-1 rounded-full bg-white/5 text-[11px] text-slate-300">
                                    {note.content_category}
                                  </span>
                                  <span className={`inline-flex px-2.5 py-1 rounded-full border text-[11px] font-semibold ${tierStyles[note.recommendation_tier] || tierStyles['可参考']}`}>
                                    {note.recommendation_tier}
                                  </span>
                                  <span className="text-[11px] text-slate-500">仿写值 {note.rewrite_value_score}</span>
                                  {index === 0 && (
                                    <span className="inline-flex px-2.5 py-1 rounded-full bg-emerald-500/15 text-[11px] text-emerald-300">
                                      当前分类推荐
                                    </span>
                                  )}
                                </div>
                                <h4 className="text-white font-semibold leading-7 line-clamp-2">{note.title || '无标题'}</h4>
                                <p className="text-sm text-slate-400 mt-2">{note.author}</p>
                                <p className="text-sm text-slate-500 mt-3 line-clamp-3">{note.desc || '暂无正文摘要'}</p>
                                <div className="mt-4 flex flex-wrap gap-2">
                                  <button
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleUseBenchmark(note);
                                    }}
                                    className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-slate-200 text-xs"
                                  >
                                    选为对标样本
                                  </button>
                                  <button
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleRewriteNow(note);
                                    }}
                                    className="px-3 py-1.5 rounded-lg bg-xhs-red text-white text-xs font-medium"
                                  >
                                    一键仿写
                                  </button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ) : scraperTab === 'results' && currentResults.length > 0 && (
                <section className="bg-xhs-card border border-white/5 rounded-3xl p-6">
                  <div className="flex items-center justify-between mb-5">
                    <div>
                      <h3 className="text-xl font-bold text-white">采集结果列表</h3>
                      <p className="text-sm text-slate-400">当前工作区已载入 {currentResults.length} 篇笔记，点击卡片可查看原始内容概览。</p>
                    </div>
                    <div className="text-sm text-slate-500">
                      来源：{historyDetail ? `历史任务《${historyDetail.keyword}》` : '本轮实时采集'}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {currentResults.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-2xl border border-white/5 bg-black/20 p-4 flex gap-4 cursor-pointer hover:bg-white/5 transition-colors"
                        onClick={() => openDetailFromRaw(note)}
                      >
                        <NoteCoverImage
                          imageUrl={note.imageUrl}
                          imageList={note.imageList}
                          stableImageUrl={note.stableImageUrl}
                          stableImageList={note.stableImageList}
                          resolvedImageUrl={note.resolvedImageUrl}
                          resolvedImageList={note.resolvedImageList}
                          alt={note.title}
                          className="w-24 h-32 rounded-2xl object-cover bg-white/5 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <h4 className="text-white font-semibold leading-7 line-clamp-2">{note.title || '无标题'}</h4>
                          <p className="text-sm text-slate-400 mt-2">{note.author}</p>
                          <p className="text-sm text-slate-500 mt-3 line-clamp-3">{note.desc || '暂无正文摘要'}</p>
                          <div className="flex flex-wrap gap-3 mt-4 text-xs text-slate-500">
                            <span>点赞 {note.likes}</span>
                            <span>收藏 {note.stars}</span>
                            <span>评论 {note.commentCount || 0}</span>
                            <span>分享 {note.shares || 0}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

          {scraperTab === 'results' && showAnalysis && displayAnalysis && (
                <>
                  <section className="bg-xhs-card border border-white/5 rounded-3xl p-6">
                    <h3 className="text-xl font-bold text-white mb-4">分类概览</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                      {categoryCards.map(([category, summary]) => (
                        <div key={category} className="rounded-2xl border border-white/5 bg-black/20 p-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <h4 className="text-white font-semibold">{category}</h4>
                            <span className={`text-xs font-semibold ${sufficiencyStyles[summary.benchmark_sufficiency] || 'text-slate-300'}`}>
                              {summary.benchmark_sufficiency}
                            </span>
                          </div>
                          <div className="text-sm text-slate-300">样本 {summary.note_count} 条</div>
                          <div className="text-sm text-slate-300">强推荐 {summary.strong_recommend_count} 条</div>
                          <div className="text-xs text-slate-500 leading-6">{summary.sufficiency_reason}</div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {SHOW_KEYWORD_COLLECTION && displayNextCollectionTasks.length > 0 && (
                    <section className="bg-xhs-card border border-white/5 rounded-3xl p-6">
                      <h3 className="text-xl font-bold text-white mb-4">建议继续补采</h3>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {displayNextCollectionTasks.map((task, index) => (
                          <div key={`${task.category}-${index}`} className="rounded-2xl border border-rose-500/10 bg-rose-500/5 p-5 space-y-3">
                            <div className="flex items-center justify-between">
                              <h4 className="text-white font-semibold">{task.category}</h4>
                              <button onClick={() => applyFollowupTask(task)} className="px-3 py-1.5 rounded-lg bg-white text-slate-900 text-sm font-medium">
                                载入补采参数
                              </button>
                            </div>
                            <p className="text-sm text-slate-300">{task.reason}</p>
                            <p className="text-xs text-slate-500">关键词：{task.keywords.join(' / ')}</p>
                            <p className="text-xs text-slate-500">
                              筛选：{task.filters.sortBy} / {task.filters.noteType} / {task.filters.publishTime} / {task.filters.searchScope} / {task.filters.location}
                            </p>
                            <p className="text-xs text-slate-500">采集量：{task.max_notes_count}，评论：{task.enable_comments ? '开启' : '关闭'}</p>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {displayRealPhrases.length > 0 && (
                    <section className="bg-xhs-card border border-white/5 rounded-3xl p-6">
                      <h3 className="text-xl font-bold text-white mb-4">真实用户表达词库</h3>
                      <div className="flex flex-wrap gap-2">
                        {displayRealPhrases.map((phrase) => (
                          <span key={phrase} className="px-3 py-1.5 rounded-full bg-white/5 text-slate-300 text-sm">
                            {phrase}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}

                  {currentResults.length > 0 && !showRawResultsAsPrimary && (
                    <section className="bg-xhs-card border border-white/5 rounded-3xl p-6">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <h3 className="text-xl font-bold text-white">原始采集汇总</h3>
                          <p className="text-sm text-slate-400">AI 分类已经是主视图，原始结果只作为辅助回看入口保留。</p>
                        </div>
                        <button
                          onClick={() => setShowRawResults((prev) => !prev)}
                          className="self-start rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200 transition hover:bg-white/10"
                        >
                          {showRawResults ? '收起原始列表' : `展开原始列表（${currentResults.length}）`}
                        </button>
                      </div>

                      {showRawResults && (
                        <div className="mt-5 grid grid-cols-1 xl:grid-cols-2 gap-4">
                          {currentResults.map((note) => (
                            <div
                              key={`raw-secondary-${note.id}`}
                              className="rounded-2xl border border-white/5 bg-black/20 p-4 flex gap-4 cursor-pointer hover:bg-white/5 transition-colors"
                              onClick={() => openDetailFromRaw(note)}
                            >
                              <NoteCoverImage
                                imageUrl={note.imageUrl}
                                imageList={note.imageList}
                                stableImageUrl={note.stableImageUrl}
                                stableImageList={note.stableImageList}
                                resolvedImageUrl={note.resolvedImageUrl}
                                resolvedImageList={note.resolvedImageList}
                                alt={note.title}
                                className="w-24 h-32 rounded-2xl object-cover bg-white/5 shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <h4 className="text-white font-semibold leading-7 line-clamp-2">{note.title || '无标题'}</h4>
                                <p className="text-sm text-slate-400 mt-2">{note.author}</p>
                                <p className="text-sm text-slate-500 mt-3 line-clamp-3">{note.desc || '暂无正文摘要'}</p>
                                <div className="flex flex-wrap gap-3 mt-4 text-xs text-slate-500">
                                  <span>点赞 {note.likes}</span>
                                  <span>收藏 {note.stars}</span>
                                  <span>评论 {note.commentCount || 0}</span>
                                  <span>分享 {note.shares || 0}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  )}
                </>
              )}

              {scraperTab === 'results' && !showAnalysis && currentResults.length === 0 && (
                <section className="bg-xhs-card border border-white/5 rounded-3xl p-10 text-center text-slate-400">
                  还没有新的分类结果。先采一轮数据，或者从右侧历史任务恢复结果，页面会自动切成分析与样本池视图。
                </section>
              )}
        </div>
      </div>

      {isHistoryDrawerOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 xl:hidden" onClick={() => setIsHistoryDrawerOpen(false)}>
          <div
            className="absolute right-0 top-0 h-full w-[88vw] max-w-[380px] overflow-y-auto border-l border-white/10 bg-[#121214] p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold text-white">历史采集任务</div>
                <div className="text-xs text-slate-400 mt-1">移动端抽屉视图</div>
              </div>
              <button
                onClick={() => setIsHistoryDrawerOpen(false)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300"
              >
                关闭
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {filteredHistories.map((history) => {
                const mode = getHistoryCollectionMode(history);
                return (
                  <button
                    key={`drawer-${history.task_id}`}
                    onClick={() => void fetchHistoryDetail(history.task_id, true)}
                    className="w-full rounded-2xl border border-white/10 bg-white/5 p-4 text-left"
                  >
                    <div className="text-sm font-medium text-white line-clamp-1">{history.keyword}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className={`px-2 py-1 rounded-full border text-[11px] ${collectionModeBadgeStyles[mode]}`}>
                        {collectionModeLabelMap[mode]}
                      </span>
                      <span className={`px-2 py-1 rounded-full border text-[11px] ${(history.has_analysis || history.analysis_result) ? historyBadgeStyles.analyzed : historyBadgeStyles.raw}`}>
                        {(history.has_analysis || history.analysis_result) ? '已分析' : '原始数据'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {isProductBriefExpanded && (
        <div className="fixed inset-0 z-40 bg-black/65 px-4 py-6" onClick={() => setIsProductBriefExpanded(false)}>
          <div
            className="mx-auto max-w-3xl rounded-3xl border border-white/10 bg-[#121214] p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-bold text-white">编辑产品参数</h3>
                <p className="mt-1 text-sm text-slate-400">产品参数独立编辑，不和采集表单混排，减少采集页首屏拥挤。</p>
              </div>
              <button
                onClick={() => setIsProductBriefExpanded(false)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300"
              >
                关闭
              </button>
            </div>
            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <input
                value={productBrief.product_name}
                onChange={(e) => updateDraftProductBrief('product_name', e.target.value)}
                placeholder="产品名称"
                className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
              />
              <input
                value={productBrief.target_audience}
                onChange={(e) => updateDraftProductBrief('target_audience', e.target.value)}
                placeholder="目标人群"
                className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
              />
              <textarea
                value={productBrief.product_features}
                onChange={(e) => updateDraftProductBrief('product_features', e.target.value)}
                placeholder="产品卖点、差异点、使用场景"
                rows={4}
                className="md:col-span-2 w-full px-4 py-3 bg-black/20 border border-white/10 rounded-2xl text-white placeholder:text-slate-500 resize-none"
              />
              <input
                value={productBrief.brand_tone}
                onChange={(e) => updateDraftProductBrief('brand_tone', e.target.value)}
                placeholder="品牌语气"
                className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
              />
              <input
                value={productBrief.must_include}
                onChange={(e) => updateDraftProductBrief('must_include', e.target.value)}
                placeholder="必须提及的卖点/活动"
                className="w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
              />
              <input
                value={productBrief.banned_terms}
                onChange={(e) => updateDraftProductBrief('banned_terms', e.target.value)}
                placeholder="禁用词/不想出现的话术"
                className="md:col-span-2 w-full h-11 px-4 bg-black/20 border border-white/10 rounded-xl text-white placeholder:text-slate-500"
              />
              <textarea
                value={productBriefUrlsToText(productBrief)}
                onChange={(e) => updateDraftProductBrief('reference_urls', parseProductBriefUrlsText(e.target.value))}
                placeholder="产品资料链接，一行一个。支持官网、帮助中心、落地页"
                rows={4}
                className="md:col-span-2 w-full px-4 py-3 bg-black/20 border border-white/10 rounded-2xl text-white placeholder:text-slate-500 resize-none"
              />
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-slate-500">
                {productBriefStatus.updatedAt ? `草稿已自动保存：${new Date(productBriefStatus.updatedAt).toLocaleString()}` : '尚未写入工作区草稿'}
              </div>
              <div className="flex gap-3">
                <button
                  onClick={saveProductBriefToWorkspace}
                  className="h-10 rounded-xl bg-white px-4 text-sm font-medium text-slate-900"
                >
                  已自动保存
                </button>
                <button
                  onClick={() => setIsProductBriefExpanded(false)}
                  className="h-10 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-200"
                >
                  完成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <NotePreviewOverlay
        preview={previewState}
        imageIndex={detailImageIndex}
        onImageChange={setDetailImageIndex}
        onClose={() => setPreviewState(null)}
        onSelectBenchmark={handleUseBenchmark}
        onRewriteNow={handleRewriteNow}
      />
    </div>
  );
};

export default ScraperView;
