import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BrowserTab,
  EXTENSION_NAME,
  ExtensionClient,
  LEGACY_EXTENSION_NAME,
  XhsOperationResult,
} from '../../shared/extension-contract';
import { detectXhsLogin } from '../../lib/xhsSession';
import { filterNotesByPublishTime, formatScrapedNotes, matchesPublishTimeFilter } from '../../lib/scraperData';
import { useExtension } from './useExtension';
import { DEFAULT_SEARCH_FILTERS, ScrapedNote, SearchFilters } from '../../types';

const FILTER_OPTIONS_MAP: Record<keyof SearchFilters, Array<{ index: number; text: string }>> = {
  sortBy: [
    { index: 1, text: '综合' },
    { index: 2, text: '最新' },
    { index: 3, text: '最多点赞' },
    { index: 4, text: '最多评论' },
    { index: 5, text: '最多收藏' },
  ],
  noteType: [
    { index: 1, text: '不限' },
    { index: 2, text: '视频' },
    { index: 3, text: '图文' },
  ],
  publishTime: [
    { index: 1, text: '不限' },
    { index: 2, text: '一天内' },
    { index: 3, text: '一周内' },
    { index: 4, text: '半年内' },
  ],
  searchScope: [
    { index: 1, text: '不限' },
    { index: 2, text: '已看过' },
    { index: 3, text: '未看过' },
    { index: 4, text: '已关注' },
  ],
  location: [
    { index: 1, text: '不限' },
    { index: 2, text: '同城' },
    { index: 3, text: '附近' },
  ],
};

const FILTER_GROUP_INDEX: Record<keyof SearchFilters, number> = {
  sortBy: 1,
  noteType: 2,
  publishTime: 3,
  searchScope: 4,
  location: 5,
};

const FILTER_GROUP_LABELS: Record<keyof SearchFilters, string[]> = {
  sortBy: ['排序', '排序依据'],
  noteType: ['类型', '笔记类型'],
  publishTime: ['时间', '发布时间'],
  searchScope: ['范围', '搜索范围'],
  location: ['位置', '位置距离', '距离'],
};

const FILTER_OPTION_ALIASES: Record<keyof SearchFilters, Record<string, string[]>> = {
  sortBy: {
    综合: ['综合'],
    最新: ['最新'],
    最多点赞: ['最多点赞', '点赞最多', '最多赞'],
    最多评论: ['最多评论', '评论最多'],
    最多收藏: ['最多收藏', '收藏最多'],
  },
  noteType: {
    不限: ['不限'],
    视频: ['视频'],
    图文: ['图文', '普通笔记'],
  },
  publishTime: {
    不限: ['不限'],
    一天内: ['一天内', '1天内'],
    一周内: ['一周内', '7天内'],
    半年内: ['半年内', '6个月内'],
  },
  searchScope: {
    不限: ['不限'],
    已看过: ['已看过'],
    未看过: ['未看过'],
    已关注: ['已关注'],
  },
  location: {
    不限: ['不限'],
    同城: ['同城'],
    附近: ['附近'],
  },
};

const hasActiveFilterOverrides = (filters: SearchFilters | null | undefined) => {
  if (!filters) return false;
  return (Object.keys(DEFAULT_SEARCH_FILTERS) as Array<keyof SearchFilters>).some((key) => filters[key] !== DEFAULT_SEARCH_FILTERS[key]);
};

export const getFilterOptionCandidateTexts = <T extends keyof SearchFilters>(
  groupKey: T,
  currentValue: SearchFilters[T],
): string[] => {
  const normalizedValue = String(currentValue || '').trim();
  if (!normalizedValue) return [];
  return Array.from(new Set([
    normalizedValue,
    ...(FILTER_OPTION_ALIASES[groupKey]?.[normalizedValue] || []),
  ].map((item) => String(item || '').trim()).filter(Boolean)));
};

export const canUseInteractiveFilters = (
  extension: Pick<ExtensionClient, 'name' | 'invoke'> | undefined,
  filters: SearchFilters | null | undefined,
) => (
  !hasActiveFilterOverrides(filters) ||
  Boolean(
    extension &&
    typeof extension.invoke === 'function' &&
    [LEGACY_EXTENSION_NAME, EXTENSION_NAME].includes(extension.name),
  )
);

export const probeInteractiveFilterSupport = async (
  extension: Pick<ExtensionClient, 'name' | 'invoke'> | undefined,
) => {
  if (!extension || typeof extension.invoke !== 'function') {
    return {
      supported: false,
      reason: '插件未连接，无法执行筛选点击。',
    };
  }

  if (extension.name === LEGACY_EXTENSION_NAME) {
    return {
      supported: true,
      reason: '',
    };
  }

  try {
    await extension.invoke('chrome:debugger:getTargets', undefined);
    return {
      supported: true,
      reason: '',
    };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error || 'unknown'),
    };
  }
};

export const runOptionalAsyncCleanup = async (cleanup?: (() => Promise<void>) | null) => {
  if (!cleanup) return;
  await cleanup();
};

export const getPostListEnrichmentSkipReason = ({
  sessionId,
  lastCompletedSessionId,
  enteredSessionId,
  isRunning,
  activeEnrichmentSessionId,
}: {
  sessionId: string;
  lastCompletedSessionId: string;
  enteredSessionId: string;
  isRunning: boolean;
  activeEnrichmentSessionId: string;
}): 'completed' | 'active' | 'entered' | null => {
  if (!sessionId) return null;
  if (lastCompletedSessionId === sessionId) {
    return 'completed';
  }
  if (isRunning && activeEnrichmentSessionId === sessionId) {
    return 'active';
  }
  if (enteredSessionId === sessionId) {
    return 'entered';
  }
  return null;
};

export const shouldSkipLocalPublishTimeFilter = (
  meta: Pick<CollectionResultMeta, 'trustStrictRequestPublishTime' | 'appliedPublishTime'> | null | undefined,
  publishTime: string | null | undefined,
) => Boolean(
  meta &&
  meta.trustStrictRequestPublishTime &&
  String(meta.appliedPublishTime || '').trim() !== '' &&
  String(meta.appliedPublishTime || '').trim() !== '不限' &&
  String(meta.appliedPublishTime || '').trim() === String(publishTime || '').trim()
);

export const shouldCollectStrictPublishTimeFromVisibleDom = (
  _filters: SearchFilters | null | undefined,
) => false;

export const shouldFinishStrictVisibleDomCollection = ({
  enabled,
  currentCount,
  requestedCount,
}: {
  enabled: boolean;
  currentCount: number;
  requestedCount: number;
}) => enabled && requestedCount > 0 && currentCount >= requestedCount;

export const shouldFinishStrictRequestCollection = ({
  enabled,
  requestCommitted,
  currentCount,
  requestedCount,
}: {
  enabled: boolean;
  requestCommitted: boolean;
  currentCount: number;
  requestedCount: number;
}) => enabled && requestCommitted && requestedCount > 0 && currentCount >= requestedCount;

export const shouldStopEnrichmentForMissingTokens = ({
  finalizedTokenCount,
  fallbackTokenCount,
}: {
  finalizedTokenCount: number;
  fallbackTokenCount: number;
}) => finalizedTokenCount <= 0 && fallbackTokenCount <= 0;

export const shouldAllowDetailDomFallback = ({
  token,
  detail,
}: {
  token?: string | null;
  detail: unknown;
}) => !detail && Boolean(String(token || '').trim());

const normalizeNoteUrlForCacheKey = (value?: string | null) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://www.xiaohongshu.com');
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '');
  }
};

export const backfillVisibleDomNotesWithRequestCache = ({
  visibleItems,
  requestItems,
}: {
  visibleItems: any[];
  requestItems: any[];
}) => {
  const requestById = new Map<string, any>();
  const requestByUrl = new Map<string, any>();

  requestItems
    .map(normalizeSearchNoteItem)
    .filter(Boolean)
    .forEach((item: any) => {
      const idKey = String(item?.id || '').trim();
      const urlKey = normalizeNoteUrlForCacheKey(item?.noteUrl);
      if (idKey && !requestById.has(idKey)) {
        requestById.set(idKey, item);
      }
      if (urlKey && !requestByUrl.has(urlKey)) {
        requestByUrl.set(urlKey, item);
      }
    });

  let tokenBackfilledCount = 0;
  let tokenMissingCount = 0;

  const items = visibleItems
    .map(normalizeSearchNoteItem)
    .filter(Boolean)
    .map((visibleItem: any) => {
      const idKey = String(visibleItem?.id || '').trim();
      const urlKey = normalizeNoteUrlForCacheKey(visibleItem?.noteUrl);
      const matchedRequestItem = (idKey ? requestById.get(idKey) : null) || (urlKey ? requestByUrl.get(urlKey) : null);
      const merged = matchedRequestItem
        ? {
            ...matchedRequestItem,
            ...visibleItem,
            noteUrl: visibleItem.noteUrl || matchedRequestItem.noteUrl,
            xsec_token: visibleItem.xsec_token || matchedRequestItem.xsec_token,
            note_card: {
              ...(matchedRequestItem.note_card || {}),
              ...(visibleItem.note_card || {}),
            },
          }
        : visibleItem;

      if (!visibleItem.xsec_token && merged.xsec_token) {
        tokenBackfilledCount += 1;
      }
      if (!merged.xsec_token) {
        tokenMissingCount += 1;
      }
      return merged;
    });

  return {
    items,
    tokenBackfilledCount,
    tokenMissingCount,
  };
};

const STAGE_TIMEOUTS = {
  pageReadyMs: 10_000,
  searchInputMs: 10_000,
  searchClickMs: 6_000,
  searchResultMs: 20_000,
  filterPanelMs: 15_000,
  filterApplyMs: 25_000,
  listIdleMs: 8_000,
  loginWaitMs: 5 * 60_000,
} as const;

type InjectionEvalResultLike<T> = {
  success: boolean;
  data: T | null;
  message?: string;
};

type SearchResultSnapshot = {
  url: string;
  hasResultUrl: boolean;
  hasNoteItem: boolean;
  hasFilterEntry: boolean;
  hasFilterPanel: boolean;
  searchInputPresent: boolean;
  searchIconPresent: boolean;
};

type SearchClickSnapshot = {
  status: string;
  inputValue?: string;
  targetTag?: string;
  targetClass?: string;
};

type FilterMatchResult = {
  matches: boolean;
  reason: string;
  snapshot: string;
};

type StartScrapingOptions = {
  enableComments?: boolean;
  maxCommentsPerNote?: number;
};

type PendingScrapeRequest = {
  keyword: string;
  maxNotes: number;
  filters: SearchFilters;
  options?: StartScrapingOptions;
};

export type FilterDebugEntry = {
  id: string;
  stage: 'panel' | 'group_scan' | 'click' | 'inject' | 'request' | 'error' | 'capability' | 'debugger' | 'search';
  message: string;
  detail?: string;
  createdAt: number;
};

type FinalFilterGroupState = {
  index: number;
  title: string;
  candidates: Array<{ text: string; selected: boolean }>;
};

export type FinalFilterConfirmationState = {
  groupKey: keyof SearchFilters;
  expectedValue: string;
  selectedTexts: string[];
  matched: boolean;
};

export type CommentDebugEntry = {
  id: string;
  noteId?: string;
  stage: 'start' | 'skip' | 'request' | 'response' | 'parse' | 'complete' | 'error';
  message: string;
  detail?: string;
  createdAt: number;
};

type InjectionProbeState = {
  url: string;
  readyState: string;
  extensionBridgeReady: boolean;
  networkHookReady: boolean;
  xhrHookReady: boolean;
  fetchRequestHookReady: boolean;
  fetchResponseHookReady: boolean;
  registeredXhrHooks: string[];
  registeredFetchRequestHooks: string[];
  registeredFetchResponseHooks: string[];
  diagnosticsStage?: string;
};

type ProxyInstallResult = {
  ok: boolean;
  reason: string;
  probe: InjectionProbeState;
};

type SearchRequestDetail = {
  url: string;
  method: string;
  body: any;
  resp: any;
  requestTraceId?: string;
  requestCapturedAt?: number;
  requestSource?: 'xhr' | 'fetch_request' | 'fetch_response' | 'unknown';
  bridgeForwarded?: boolean;
  bridgeForwardError?: string;
};

type WorkerCapturedMatchedRequestState = SearchRequestDetail & {
  requestCapturedAt: number;
  earlyCaptured?: boolean;
};

type SearchBridgeDebugDetail = {
  stage:
    | 'worker_bridge_ready'
    | 'worker_raw_fetch_request'
    | 'worker_raw_fetch_response'
    | 'worker_raw_xhr_load'
    | 'worker_request_seen'
    | 'worker_capture'
    | 'worker_suspect_unmatched'
    | 'worker_forward_success'
    | 'worker_forward_error'
    | 'frontend_receive'
    | 'worker_hook_summary';
  requestTraceId?: string;
  requestSource?: string;
  url?: string;
  method?: string;
  requestCapturedAt?: number;
  bridgeForwarded?: boolean;
  bridgeForwardError?: string;
  reason?: string;
  contentType?: string;
  bodySummary?: string;
  targetTabId?: number;
  hookSeenFetchRequestCount?: number;
  hookSeenFetchResponseCount?: number;
  hookSeenXhrCount?: number;
  searchLikeSeenCount?: number;
  strictSearchMatchedCount?: number;
};

type BufferedSearchEventForRelease = {
  requestAt: number;
  filterCheck: FilterMatchResult;
};

type BufferedSearchEvent = {
  detail: SearchRequestDetail;
  requestAt: number;
  requestIndex: number;
  filterCheck: FilterMatchResult;
};

type CommentEnrichmentResolution = {
  token: string;
  skipReason?: string;
};

type SearchRequestGateDecision = {
  accepted: boolean;
  phase: 'pre_click' | 'post_click' | 'ungated';
  reason: string;
};

type FilterCandidateSnapshot = {
  text: string;
  selected: boolean;
};

type CollectionCountDiagnostics = {
  bufferedMatchedCount: number;
  releasedIntoDataCount: number;
  dataCountBeforeEnrichment: number;
  formattedCount: number;
};

export type CollectionResultMeta = {
  sessionId: string;
  appliedPublishTime: string;
  trustStrictRequestPublishTime: boolean;
  finalOrderSource: 'request_queue' | 'visible_dom' | 'existing_queue' | 'unknown';
  publishTimeRejectedCount: number;
  formattedCount: number;
  effectiveCount: number;
};

type SearchItemMediaType = 'video' | 'image' | 'unknown';
type FilterRecoveryState = 'pending' | 'list' | 'empty';

type FilterRecoverySnapshot = {
  url: string;
  readyState: string;
  hasNoteItem: boolean;
  noteCount: number;
  typeParam: string;
  keywordParam: string;
  panelOpen: boolean;
  emptyStateText: string;
};

type FilterProbeStateSnapshot = {
  panelOpen: boolean;
  groupCount: number;
  groups: Array<{
    index: number;
    title: string;
    candidates: Array<{ text: string; selected: boolean }>;
  }>;
  trigger: { x: number; y: number; selector: string; text: string } | null;
  target: { x: number; y: number; selector: string; text: string } | null;
  targetGroup: {
    index: number;
    title: string;
    candidates: Array<{ text: string; selected: boolean }>;
  } | null;
};

type ResolvedFilterCandidate = {
  text: string;
  selected: boolean;
  x: number;
  y: number;
  selector: string;
};

export const summarizeFilterProbeState = (state?: FilterProbeStateSnapshot | null) => {
  if (!state) return 'state=null';
  return JSON.stringify({
    panelOpen: state.panelOpen,
    groupCount: state.groupCount,
    trigger: state.trigger
      ? {
          x: state.trigger.x,
          y: state.trigger.y,
          selector: state.trigger.selector,
          text: state.trigger.text,
        }
      : null,
    target: state.target
      ? {
          x: state.target.x,
          y: state.target.y,
          selector: state.target.selector,
          text: state.target.text,
        }
      : null,
    targetGroup: state.targetGroup
      ? {
          index: state.targetGroup.index,
          title: state.targetGroup.title,
          candidates: state.targetGroup.candidates.map((item) => `${item.text}${item.selected ? '(selected)' : ''}`),
        }
      : null,
    groups: state.groups.map((group) => ({
      index: group.index,
      title: group.title,
      candidates: group.candidates.map((item) => `${item.text}${item.selected ? '(selected)' : ''}`),
    })),
  });
};

export const buildFilterSelectionErrorMessage = ({
  targetText,
  debuggerError,
  dispatchError,
  domError,
}: {
  targetText: string;
  debuggerError?: string | null;
  dispatchError?: string | null;
  domError?: string | null;
}) => {
  const diagnostics = [
    debuggerError ? `debugger=${debuggerError}` : '',
    dispatchError ? `dispatch=${dispatchError}` : '',
    domError ? `dom=${domError}` : '',
  ].filter(Boolean);
  return diagnostics.length > 0
    ? `未成功选中筛选选项 ${targetText} (${diagnostics.join(' | ')})`
    : `未成功选中筛选选项 ${targetText}`;
};

export const resolveFilterCandidateByTexts = (
  candidates: ResolvedFilterCandidate[],
  expectedTexts: string[],
) => {
  const normalizedExpected = expectedTexts
    .map((text) => text.replace(/\s+/g, '').trim())
    .filter(Boolean);
  if (normalizedExpected.length === 0) return null;

  const normalizedCandidates = candidates.map((candidate, index) => ({
    ...candidate,
    index,
    normalizedText: candidate.text.replace(/\s+/g, '').trim(),
  }));

  for (const expected of normalizedExpected) {
    const exactUnselected = normalizedCandidates.filter((candidate) => (
      candidate.normalizedText === expected && !candidate.selected
    ));
    if (exactUnselected.length > 0) {
      return exactUnselected[exactUnselected.length - 1];
    }
  }

  for (const expected of normalizedExpected) {
    const exactAny = normalizedCandidates.filter((candidate) => candidate.normalizedText === expected);
    if (exactAny.length > 0) {
      return exactAny[exactAny.length - 1];
    }
  }

  return null;
};

export const classifyFilterRecoveryState = (snapshot?: Partial<FilterRecoverySnapshot> | null): FilterRecoveryState => {
  if (!snapshot) return 'pending';
  if (snapshot.hasNoteItem || Number(snapshot.noteCount || 0) > 0) {
    return 'list';
  }
  if (String(snapshot.emptyStateText || '').trim()) {
    return 'empty';
  }
  return 'pending';
};

export const hasConfirmedFilterRequest = ({
  observedAt,
  matchedAt,
  baselineObservedAt,
  baselineMatchedAt,
}: {
  observedAt: number;
  matchedAt: number;
  baselineObservedAt: number;
  baselineMatchedAt: number;
}) => observedAt > baselineObservedAt && matchedAt > baselineMatchedAt;

export const hasExpectedFilterSelection = (
  candidates: Array<{ text: string; selected: boolean }> | undefined,
  expectedTexts: string[],
) => {
  const normalizedExpected = expectedTexts.map((text) => text.replace(/\s+/g, '').trim()).filter(Boolean);
  const normalizedSelected = (candidates || [])
    .filter((item) => item.selected)
    .map((item) => item.text.replace(/\s+/g, '').trim());
  return normalizedExpected.some((text) => normalizedSelected.includes(text));
};

export const isStrictFilterRequestConfirmed = ({
  requestConfirmed,
}: {
  requestConfirmed: boolean;
}) => requestConfirmed;

const INTERACTIVE_FILTER_KEYS: Array<keyof SearchFilters> = ['sortBy', 'noteType', 'publishTime', 'searchScope', 'location'];

const isDefaultFilterValue = <T extends keyof SearchFilters>(groupKey: T, value: SearchFilters[T]) => (
  value === DEFAULT_SEARCH_FILTERS[groupKey]
);

const resolveFinalFilterGroup = (
  groups: FinalFilterGroupState[],
  groupKey: keyof SearchFilters,
) => {
  const expectedIndex = FILTER_GROUP_INDEX[groupKey];
  const indexedGroup = groups.find((group) => group.index === expectedIndex);
  if (indexedGroup) return indexedGroup;

  const expectedLabels = FILTER_GROUP_LABELS[groupKey];
  return groups.find((group) => expectedLabels.some((label) => group.title.includes(label))) || null;
};

export const getFinalFilterConfirmationStates = ({
  filters,
  groups,
}: {
  filters: SearchFilters;
  groups: FinalFilterGroupState[];
}): FinalFilterConfirmationState[] => (
  INTERACTIVE_FILTER_KEYS
    .filter((groupKey) => !isDefaultFilterValue(groupKey, filters[groupKey]))
    .map((groupKey) => {
      const expectedValue = String(filters[groupKey] || '').trim();
      const expectedTexts = getFilterOptionCandidateTexts(groupKey, filters[groupKey]);
      const targetGroup = resolveFinalFilterGroup(groups, groupKey);
      const selectedTexts = (targetGroup?.candidates || [])
        .filter((candidate) => candidate.selected)
        .map((candidate) => candidate.text);
      return {
        groupKey,
        expectedValue,
        selectedTexts,
        matched: hasExpectedFilterSelection(targetGroup?.candidates, expectedTexts),
      };
    })
);

export const isFinalFilterSelectionConfirmed = ({
  filters,
  groups,
}: {
  filters: SearchFilters;
  groups: FinalFilterGroupState[];
}) => getFinalFilterConfirmationStates({ filters, groups }).every((item) => item.matched);

export const isUiAppliedFilterConfirmed = ({
  finalFilterSelectionConfirmed,
  panelClosed,
  recoveryState,
  noteCount,
  hasNoteItem,
}: {
  finalFilterSelectionConfirmed: boolean;
  panelClosed: boolean;
  recoveryState?: FilterRecoveryState | string | null;
  noteCount: number;
  hasNoteItem: boolean;
}) => (
  finalFilterSelectionConfirmed &&
  recoveryState === 'list' &&
  (panelClosed || noteCount > 0 || hasNoteItem)
);

export const shouldAcceptUiAppliedSurface = ({
  looksLikeSearchResult,
  keywordMatches,
  count,
}: {
  looksLikeSearchResult: boolean;
  keywordMatches: boolean;
  count: number;
}) => looksLikeSearchResult && keywordMatches && count > 0;

export const doesUiTypeParamMatchFilters = ({
  filters,
  typeParam,
}: {
  filters: SearchFilters | null | undefined;
  typeParam?: string | null;
}) => {
  if (!filters || filters.noteType === '不限') {
    return true;
  }

  const normalizedTypeParam = String(typeParam || '').trim();
  if (!normalizedTypeParam) {
    return filters.noteType !== '视频';
  }

  if (filters.noteType === '图文') {
    return normalizedTypeParam === '51';
  }

  if (filters.noteType === '视频') {
    return normalizedTypeParam !== '51';
  }

  return true;
};

export const isUiFilterConfirmed = ({
  filters,
  finalFilterSelectionConfirmed,
  looksLikeSearchResult,
  keywordMatches,
  count,
  typeParam,
}: {
  filters: SearchFilters | null | undefined;
  finalFilterSelectionConfirmed: boolean;
  looksLikeSearchResult: boolean;
  keywordMatches: boolean;
  count: number;
  typeParam?: string | null;
}) => (
  finalFilterSelectionConfirmed &&
  shouldAcceptUiAppliedSurface({
    looksLikeSearchResult,
    keywordMatches,
    count,
  }) &&
  doesUiTypeParamMatchFilters({
    filters,
    typeParam,
  })
);

export const shouldRecoverUiConfirmedNotes = ({
  finalConfirmationSource,
  requestCommitted,
  recoveredCount,
}: {
  finalConfirmationSource: 'request' | 'ui' | 'none';
  requestCommitted: boolean;
  recoveredCount: number;
}) => (
  finalConfirmationSource === 'ui' &&
  !requestCommitted &&
  recoveredCount > 0
);

const summarizeSearchRequestBody = (body: any) => {
  if (!body || typeof body !== 'object') return 'body=empty';
  const hasKeyword = Boolean(String(body.keyword || '').trim());
  const filters = Array.isArray(body.filters) ? body.filters : [];
  const filterTypes = filters
    .map((item: any) => String(item?.type || '').trim())
    .filter(Boolean);
  const directKeys = ['filter_note_type', 'filter_note_time', 'filters']
    .filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  return [
    `keyword=${hasKeyword ? String(body.keyword).trim() : 'none'}`,
    `filterTypes=${filterTypes.join(',') || 'none'}`,
    `directKeys=${directKeys.join(',') || 'none'}`,
  ].join(' | ');
};

export const looksLikeSearchNotesRequest = ({
  url,
  body,
}: {
  url?: string | null;
  body?: any;
}) => {
  const normalized = String(url || '').trim().toLowerCase();
  const hasSearchPath = (
    normalized.includes('/api/sns/web/v1/search/notes') ||
    normalized.includes('/api/sns/web/v2/search/notes') ||
    normalized.includes('/api/sns/web/search/notes') ||
    normalized.includes('/search/notes')
  );
  if (hasSearchPath) return true;

  if (!body || typeof body !== 'object') return false;
  const filters = Array.isArray(body.filters) ? body.filters : [];
  const filterTypes = filters.map((item: any) => String(item?.type || '').trim());
  const hasKeyword = Boolean(String(body.keyword || '').trim());
  const hasSearchFilters = (
    filterTypes.includes('filter_note_type') ||
    filterTypes.includes('filter_note_time') ||
    Object.prototype.hasOwnProperty.call(body, 'filter_note_type') ||
    Object.prototype.hasOwnProperty.call(body, 'filter_note_time')
  );
  return hasKeyword && hasSearchFilters;
};

export const didCommitSearchRequest = ({
  queueCountBefore,
  queueCountAfter,
  incomingCount,
}: {
  queueCountBefore: number;
  queueCountAfter: number;
  incomingCount: number;
}) => incomingCount > 0 && queueCountAfter > 0 && queueCountAfter >= queueCountBefore;

export const shouldRecoverClosedFilterPanel = ({
  itemRecoveryCount,
  totalRecoveryCount,
  maxItemRecoveries = 2,
  maxTotalRecoveries = 6,
}: {
  itemRecoveryCount: number;
  totalRecoveryCount: number;
  maxItemRecoveries?: number;
  maxTotalRecoveries?: number;
}) => itemRecoveryCount < maxItemRecoveries && totalRecoveryCount < maxTotalRecoveries;

export type FinalFilterGroupConfirmation = {
  groupKey: keyof SearchFilters;
  expectedValue: string;
  selectedTexts: string[];
  matched: boolean;
};

export const buildFinalFilterConfirmations = ({
  filters,
  itemStates,
}: {
  filters: SearchFilters;
  itemStates: Partial<Record<keyof SearchFilters, { selectedTexts: string[]; matched: boolean }>>;
}): FinalFilterGroupConfirmation[] => (
  INTERACTIVE_FILTER_KEYS
    .filter((groupKey) => !isDefaultFilterValue(groupKey, filters[groupKey]))
    .map((groupKey) => ({
      groupKey,
      expectedValue: String(filters[groupKey] || '').trim(),
      selectedTexts: itemStates[groupKey]?.selectedTexts || [],
      matched: Boolean(itemStates[groupKey]?.matched),
    }))
);

export const summarizeFilterHitText = (text?: string | null, maxLength = 80) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'none';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}... (len=${normalized.length})`;
};

const formatCollectionProgressText = ({
  phase,
  currentCount,
  requestedCount,
  candidateTargetCount,
  showCandidateProgress,
}: {
  phase: 'collecting' | 'waiting' | 'stable' | 'end' | 'booting';
  currentCount: number;
  requestedCount: number;
  candidateTargetCount: number;
  showCandidateProgress: boolean;
}) => {
  const targetText = showCandidateProgress && candidateTargetCount > requestedCount
    ? `已抓候选 ${currentCount}/${candidateTargetCount} | 目标成品 ${requestedCount}`
    : `${currentCount}/${requestedCount}`;

  switch (phase) {
    case 'waiting':
      return `正在等待符合筛选的结果... (${targetText})`;
    case 'stable':
      return `列表已稳定，准备补抓正文... (${targetText})`;
    case 'end':
      return `当前结果页已到底，准备补抓正文... (${targetText})`;
    case 'booting':
      return `正在准备采集环境... (${targetText})`;
    default:
      return showCandidateProgress && candidateTargetCount > requestedCount
        ? `正在采集候选列表... (${targetText})`
        : `正在采集列表... (${targetText})`;
  }
};

export const isLikelyStandaloneFilterTriggerText = (text: string) => {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const compact = normalized.replace(/\s+/g, '');
  if (!normalized.includes('筛选') && compact !== '已筛选') return false;
  const noisyKeywords = ['排序依据', '笔记类型', '发布时间', '搜索范围', '位置距离', '重置', '收起'];
  return !noisyKeywords.some((keyword) => normalized.includes(keyword));
};

export const getRequestedNoteType = (body: any) => {
  const getFilterTagsFromBody = (payload: any, filterType: string): string[] => {
    if (!payload || typeof payload !== 'object') return [];
    const directValue = payload[filterType];
    if (Array.isArray(directValue)) {
      return directValue.map((item) => String(item || '').trim()).filter(Boolean);
    }
    if (directValue && typeof directValue === 'object' && Array.isArray(directValue.tags)) {
      return directValue.tags.map((item: unknown) => String(item || '').trim()).filter(Boolean);
    }
    if (Array.isArray(payload.filters)) {
      const matched = payload.filters.find((item: any) => item?.type === filterType);
      if (matched && Array.isArray(matched.tags)) {
        return matched.tags.map((item: unknown) => String(item || '').trim()).filter(Boolean);
      }
    }
    return [];
  };

  const rawNoteType = body?.note_type;
  const noteTypeValue = rawNoteType === undefined || rawNoteType === null ? '' : String(rawNoteType).trim();
  const noteTypeTags = getFilterTagsFromBody(body, 'filter_note_type');
  return { noteTypeValue, noteTypeTags };
};

const getFilterTextsFromBody = (payload: any, candidateKeys: string[]): string[] => {
  if (!payload || typeof payload !== 'object') return [];

  const values: string[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value && typeof value === 'object') {
      const maybeTags = (value as any).tags;
      if (Array.isArray(maybeTags)) {
        maybeTags.forEach(collect);
        return;
      }
    }
    if (value !== undefined && value !== null) {
      const text = String(value).trim();
      if (text) values.push(text);
    }
  };

  candidateKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      collect((payload as any)[key]);
    }
  });

  if (Array.isArray(payload.filters)) {
    payload.filters.forEach((item: any) => {
      const type = String(item?.type || '').trim();
      if (candidateKeys.includes(type)) {
        collect(item?.tags);
        collect(item?.value);
      }
    });
  }

  return values;
};

const getRequestFilterSnapshot = (body: any) => {
  const { noteTypeValue, noteTypeTags } = getRequestedNoteType(body);
  const publishTimeTags = getFilterTextsFromBody(body, [
    'filter_note_time',
    'filter_publish_time',
    'publish_time',
    'publishTime',
  ]);
  const noteRangeTags = getFilterTextsFromBody(body, [
    'filter_note_range',
    'search_scope',
    'searchScope',
  ]);
  const posDistanceTags = getFilterTextsFromBody(body, [
    'filter_pos_distance',
    'location',
  ]);
  return {
    noteTypeValue,
    noteTypeTags,
    publishTimeTags,
    noteRangeTags,
    posDistanceTags,
  };
};

export const requestMatchesFilters = (body: any, filters: SearchFilters | null): FilterMatchResult => {
  if (!filters) {
    return { matches: true, reason: '', snapshot: '' };
  }

  const hasStrictNoteType = filters.noteType !== '不限';
  const hasStrictPublishTime = filters.publishTime !== '不限';

  const {
    noteTypeValue,
    noteTypeTags,
    publishTimeTags,
    noteRangeTags,
    posDistanceTags,
  } = getRequestFilterSnapshot(body);
  const normalizedNoteTypeTags = noteTypeTags.map((tag) => String(tag || '').trim());
  const isGraphNoteTag = (tag: string) => ['图文', '普通笔记', '普通'].includes(tag);
  const isVideoNoteTag = (tag: string) => ['视频'].includes(tag);
  const normalizedNoteTypeValue = noteTypeValue.toLowerCase();
  const serialized = JSON.stringify(body || {});
  const snapshot = JSON.stringify({
    note_type: noteTypeValue || '',
    filter_note_type: normalizedNoteTypeTags,
    filter_note_time: publishTimeTags,
    filter_note_range: noteRangeTags,
    filter_pos_distance: posDistanceTags,
  });

  const looksLikeGraphNoteValue = ['normal', 'image', 'text', 'note'].some((token) => normalizedNoteTypeValue.includes(token));
  const looksLikeVideoNoteValue = ['video'].some((token) => normalizedNoteTypeValue.includes(token));

  if (filters.noteType === '图文') {
    if (normalizedNoteTypeTags.length === 0) {
      return {
        matches: false,
        reason: `目标为图文，但请求缺少显式 noteType 标签`,
        snapshot,
      };
    }
    const hasGraphTag = normalizedNoteTypeTags.some(isGraphNoteTag);
    const hasUnlimitedTag = normalizedNoteTypeTags.includes('不限');
    const hasConflictingVideoTag = normalizedNoteTypeTags.some(isVideoNoteTag);
    if (looksLikeVideoNoteValue || hasUnlimitedTag || hasConflictingVideoTag || (!hasGraphTag && normalizedNoteTypeTags.length > 0)) {
      return {
        matches: false,
        reason: `目标为图文，但请求实际为 note_type=${noteTypeValue || 'unknown'} / tags=${normalizedNoteTypeTags.join(',') || 'empty'}`,
        snapshot,
      };
    }
  }

  if (filters.noteType === '视频') {
    if (normalizedNoteTypeTags.length === 0) {
      return {
        matches: false,
        reason: `目标为视频，但请求缺少显式 noteType 标签`,
        snapshot,
      };
    }
    const hasVideoTag = normalizedNoteTypeTags.some(isVideoNoteTag);
    const hasGraphTag = normalizedNoteTypeTags.some(isGraphNoteTag);
    const hasUnlimitedTag = normalizedNoteTypeTags.includes('不限');
    if (looksLikeGraphNoteValue || hasUnlimitedTag || hasGraphTag || (normalizedNoteTypeTags.length > 0 && !hasVideoTag)) {
      return {
        matches: false,
        reason: `目标为视频，但请求实际为 note_type=${noteTypeValue || 'unknown'} / tags=${normalizedNoteTypeTags.join(',') || 'empty'}`,
        snapshot,
      };
    }
  }

  if (hasStrictPublishTime && publishTimeTags.length === 0) {
    return {
      matches: false,
      reason: `目标为${filters.publishTime}，但请求缺少显式 publishTime 标签 | filter_note_time=${publishTimeTags.join(',') || 'empty'}`,
      snapshot,
    };
  }
  if (hasStrictPublishTime && !publishTimeTags.includes(filters.publishTime)) {
    return {
      matches: false,
      reason: `目标为${filters.publishTime}，但请求实际为 publishTime=${publishTimeTags.join(',')}`,
      snapshot,
    };
  }

  if (filters.noteType === '不限') {
    return { matches: true, reason: '', snapshot };
  }

  const expectedTexts = [
    filters.sortBy,
    filters.noteType,
    filters.publishTime === '不限' ? '' : filters.publishTime,
    filters.searchScope === '不限' ? '' : filters.searchScope,
    filters.location === '不限' ? '' : filters.location,
  ].filter(Boolean);
  const matches = expectedTexts.filter((text) => serialized.includes(text));
  if (!hasStrictNoteType && !hasStrictPublishTime && matches.length === 0 && normalizedNoteTypeTags.length === 0) {
    return {
      matches: true,
      reason: '请求体未带明确筛选文案，先保守放行',
      snapshot,
    };
  }
  return { matches: true, reason: '', snapshot };
};

export const pickBufferedSearchEventsForRelease = <T extends BufferedSearchEventForRelease>(
  events: T[],
  releaseAfter: number
) => events.filter((event) => event.requestAt >= releaseAfter && event.filterCheck.matches);

export const pickBufferedSearchEventsBeforeClick = <T extends BufferedSearchEventForRelease>(
  events: T[],
  clickedAt: number
) => events.filter((event) => event.requestAt < clickedAt && event.filterCheck.matches);

export const decideSearchRequestGate = ({
  requiresPostFilterGuard,
  clickedAt,
  requestAt,
  filterMatches,
}: {
  requiresPostFilterGuard: boolean;
  clickedAt: number | null;
  requestAt: number;
  filterMatches: boolean;
}): SearchRequestGateDecision => {
  if (!requiresPostFilterGuard) {
    return {
      accepted: filterMatches,
      phase: 'ungated',
      reason: filterMatches ? '请求已通过校验' : '请求未通过筛选校验',
    };
  }

  if (!clickedAt || requestAt < clickedAt) {
    return {
      accepted: false,
      phase: 'pre_click',
      reason: '筛选点击前的请求仅记录日志，不进入列表',
    };
  }

  return {
    accepted: filterMatches,
    phase: 'post_click',
    reason: filterMatches ? '请求已通过校验' : '请求未通过筛选校验',
  };
};

export const shouldUseDomFallback = ({
  requiresPostFilterGuard,
  clickedAt,
  dataLength,
  alreadyUsed,
  hasNoteItems,
}: {
  requiresPostFilterGuard: boolean;
  clickedAt: number | null;
  dataLength: number;
  alreadyUsed: boolean;
  hasNoteItems: boolean;
}) => (
  requiresPostFilterGuard &&
  Boolean(clickedAt) &&
  dataLength === 0 &&
  !alreadyUsed &&
  hasNoteItems
);

export const detectSearchItemMediaType = (item: any): SearchItemMediaType => {
  if (!item || typeof item !== 'object') return 'unknown';

  const stringHints = [
    item.note_type,
    item.type,
    item.xsec_source,
    item.note_card?.type,
    item.note_card?.note_type,
    item.noteCard?.type,
    item.noteCard?.note_type,
    item.note_card?.media_type,
    item.noteCard?.media_type,
  ]
    .map((value) => String(value || '').toLowerCase())
    .filter(Boolean);

  if (stringHints.some((value) => value.includes('video') || value.includes('视频'))) {
    return 'video';
  }
  if (stringHints.some((value) => value.includes('normal') || value.includes('image') || value.includes('图文') || value.includes('普通笔记'))) {
    return 'image';
  }

  const hasVideoPayload = Boolean(
    item.video_info ||
    item.video_id ||
    item.play_url ||
    item.video ||
    item.note_card?.video_info ||
    item.note_card?.video_id ||
    item.note_card?.play_url ||
    item.noteCard?.video_info ||
    item.noteCard?.video_id ||
    item.noteCard?.play_url
  );
  if (hasVideoPayload) {
    return 'video';
  }

  const imageList = [
    ...(Array.isArray(item.imageList) ? item.imageList : []),
    ...(Array.isArray(item.image_list) ? item.image_list : []),
    ...(Array.isArray(item.note_card?.image_list) ? item.note_card.image_list : []),
    ...(Array.isArray(item.noteCard?.image_list) ? item.noteCard.image_list : []),
  ];
  if (imageList.length > 0) {
    return 'image';
  }

  return 'unknown';
};

export const filterItemsByNoteType = (items: any[], filters: SearchFilters | null) => {
  if (!filters || filters.noteType === '不限') {
    return items;
  }

  return items.filter((item) => {
    const mediaType = detectSearchItemMediaType(item);
    if (filters.noteType === '图文') {
      return mediaType !== 'video';
    }
    if (filters.noteType === '视频') {
      return mediaType !== 'image';
    }
    return true;
  });
};

export const normalizeSearchNoteItem = (item: any) => {
  if (!item || typeof item !== 'object') return null;

  const normalizedId = String(
    item.id ||
    item.note_id ||
    item.noteId ||
    item.note_card?.note_id ||
    ''
  ).trim();
  if (!normalizedId) {
    return null;
  }

  const normalizedToken = String(
    item.xsec_token ||
    item.xsecToken ||
    item.note_card?.xsec_token ||
    item.note_card?.xsecToken ||
    item.note_card?.token ||
    item.note_card?.user?.xsec_token ||
    item.note_card?.user?.xsecToken ||
    ''
  ).trim();

  const rawNoteUrl = String(
    item.noteUrl ||
    item.note_url ||
    item.note_card?.note_url ||
    item.note_card?.noteUrl ||
    ''
  ).trim();

  const noteUrl = rawNoteUrl
    || (
      normalizedToken
        ? `https://www.xiaohongshu.com/explore/${normalizedId}?xsec_token=${encodeURIComponent(normalizedToken)}&xsec_source=pc_search`
        : `https://www.xiaohongshu.com/explore/${normalizedId}`
    );

  return {
    ...item,
    id: normalizedId,
    xsec_token: normalizedToken,
    noteUrl,
    note_card: item.note_card || item.noteCard || {},
    time: item.time ?? item.note_card?.time ?? item.noteCard?.time,
    create_time: item.create_time ?? item.note_card?.create_time ?? item.noteCard?.create_time,
    create_date_time: item.create_date_time ?? item.note_card?.create_date_time ?? item.noteCard?.create_date_time,
  };
};

const hasStrictPublishTimeFilter = (filters: SearchFilters | null | undefined) => Boolean(
  filters && filters.publishTime && filters.publishTime !== '不限'
);

export const buildPublishTimeDiagnostics = (
  notes: Array<Pick<Partial<ScrapedNote>, 'id' | 'time' | 'publishedAtLabel'>>,
  publishTime: string | null | undefined,
  sourceById?: Map<string, string>,
) => notes.map((note) => ({
  id: String(note?.id || '').trim() || 'unknown',
  source: sourceById?.get(String(note?.id || '').trim()) || 'unknown',
  time: note?.time ?? null,
  publishedAtLabel: note?.publishedAtLabel || '',
  matchesLocalWindow: matchesPublishTimeFilter(note, publishTime),
}));

export const isSelectedFilterCandidate = ({
  ariaPressed,
  ariaSelected,
  ariaChecked,
  dataActive,
  dataSelected,
  className,
}: {
  ariaPressed?: string | null;
  ariaSelected?: string | null;
  ariaChecked?: string | null;
  dataActive?: string | null;
  dataSelected?: string | null;
  className?: string | null;
}) => {
  const normalizedClassName = String(className || '').toLowerCase();
  return (
    ariaPressed === 'true' ||
    ariaSelected === 'true' ||
    ariaChecked === 'true' ||
    dataActive === 'true' ||
    dataSelected === 'true' ||
    normalizedClassName.includes('active') ||
    normalizedClassName.includes('selected') ||
    normalizedClassName.includes('current') ||
    normalizedClassName.includes('checked') ||
    normalizedClassName.includes('is-active') ||
    normalizedClassName.includes('is-selected') ||
    normalizedClassName.includes('tag--active') ||
    normalizedClassName.includes('tag--selected') ||
    normalizedClassName.includes('on')
  );
};

export const didSelectExpectedCandidate = (
  candidatesAfter: FilterCandidateSnapshot[],
  expectedTexts: string[]
) => {
  const normalizedExpected = expectedTexts.map((text) => text.replace(/\s+/g, '').trim()).filter(Boolean);
  const selectedTexts = candidatesAfter
    .filter((item) => item.selected)
    .map((item) => item.text.replace(/\s+/g, '').trim());
  return normalizedExpected.some((expected) => selectedTexts.includes(expected));
};

export const extractNoteDetailFromState = (state: any, noteId: string) => {
  const candidates = [
    state?.note?.noteDetailMap?.[noteId]?.note,
    state?.note?.noteDetailMap?.[noteId],
    state?.note?.noteMap?.[noteId]?.note,
    state?.note?.noteMap?.[noteId],
    state?.note?.currentNote,
    state?.note?.note,
    state?.noteDetailMap?.[noteId]?.note,
    state?.noteDetailMap?.[noteId],
  ].filter(Boolean);

  const detail = candidates.find((item: any) => item && typeof item === 'object');
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  const nextDetail = { ...detail };
  const normalizedDesc = [
    detail?.desc,
    detail?.note_card?.desc,
    detail?.noteCard?.desc,
    detail?.content,
  ].find((value) => typeof value === 'string' && value.trim());
  const normalizedImageList = [
    detail?.imageList,
    detail?.images_list,
    detail?.note_card?.image_list,
    detail?.noteCard?.imageList,
  ].find((value) => Array.isArray(value) && value.length > 0);

  if (normalizedDesc && !nextDetail.desc) {
    nextDetail.desc = normalizedDesc;
  }
  if (normalizedImageList && !Array.isArray(nextDetail.imageList)) {
    nextDetail.imageList = normalizedImageList;
  }
  if (normalizedImageList && !Array.isArray(nextDetail.images_list)) {
    nextDetail.images_list = normalizedImageList;
  }
  if (!nextDetail.id && noteId) {
    nextDetail.id = noteId;
  }

  return nextDetail;
};

export const applyFetchedDetailToNote = (note: any, detail: any) => {
  if (!detail || typeof detail !== 'object') {
    return note;
  }

  const mergedNoteCard = detail.note_card && typeof detail.note_card === 'object'
    ? { ...(note.note_card || {}), ...detail.note_card }
    : note.note_card;
  const nextNote = {
    ...note,
    detail,
    ...(mergedNoteCard ? { note_card: mergedNoteCard } : {}),
  };
  if (!nextNote.desc && typeof detail.desc === 'string' && detail.desc.trim()) {
    nextNote.desc = detail.desc;
  }
  if ((!Array.isArray(nextNote.imageList) || nextNote.imageList.length === 0) && Array.isArray(detail.imageList) && detail.imageList.length > 0) {
    nextNote.imageList = detail.imageList;
    nextNote.imageUrl = nextNote.imageUrl || detail.imageList[0] || '';
  }
  if ((!Array.isArray(nextNote.imageList) || nextNote.imageList.length === 0) && Array.isArray(detail.images_list) && detail.images_list.length > 0) {
    nextNote.imageList = detail.images_list;
    nextNote.imageUrl = nextNote.imageUrl || detail.images_list[0] || '';
  }
  if (nextNote.time === undefined && detail.time !== undefined) {
    nextNote.time = detail.time;
  }
  if (nextNote.time === undefined && detail.note_card?.time !== undefined) {
    nextNote.time = detail.note_card.time;
  }
  if (nextNote.create_time === undefined && detail.create_time !== undefined) {
    nextNote.create_time = detail.create_time;
  }
  if (nextNote.create_time === undefined && detail.note_card?.create_time !== undefined) {
    nextNote.create_time = detail.note_card.create_time;
  }
  if (nextNote.create_date_time === undefined && typeof detail.create_date_time === 'string' && detail.create_date_time.trim()) {
    nextNote.create_date_time = detail.create_date_time;
  }
  if (
    nextNote.create_date_time === undefined &&
    typeof detail.note_card?.create_date_time === 'string' &&
    detail.note_card.create_date_time.trim()
  ) {
    nextNote.create_date_time = detail.note_card.create_date_time;
  }
  if (nextNote.publishedAtLabel === undefined && typeof detail.publishedAtLabel === 'string' && detail.publishedAtLabel.trim()) {
    nextNote.publishedAtLabel = detail.publishedAtLabel;
  }

  return nextNote;
};

export const resolveCommentEnrichment = (note: any): CommentEnrichmentResolution => {
  const baseToken = note?.xsec_token || note?.note_card?.xsec_token || note?.note_card?.xsecToken || note?.note_card?.token || '';
  const detailToken = note?.detail?.xsec_token || note?.detail?.note_card?.xsec_token || note?.detail?.note_card?.xsecToken || '';
  const token = String(baseToken || detailToken || '').trim();

  if (!token) {
    return {
      token: '',
      skipReason: 'skip comment enrichment because note has no xsec_token',
    };
  }

  return { token };
};

export const applyFetchedCommentsToNote = (note: any, comments: Array<Record<string, any>>) => {
  if (!Array.isArray(comments) || comments.length === 0) {
    return note;
  }

  const nextNote = { ...note };
  nextNote.comments = comments;
  nextNote.commentCount = String(
    nextNote.note_card?.interact_info?.comment_count
      || nextNote.detail?.interactInfo?.commentCount
      || nextNote.detail?.interact_info?.comment_count
      || nextNote.commentCount
      || nextNote.comment_count
      || comments.length
  );
  return nextNote;
};

export const useXhsScraper = () => {
  const { extension, tab } = useExtension();
  const [isScraping, setIsScraping] = useState(false);
  const [data, setData] = useState<any[]>([]);
  const [workerTab, setWorkerTab] = useState<BrowserTab>();
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [filterDebugEntries, setFilterDebugEntries] = useState<FilterDebugEntry[]>([]);
  const [commentDebugEntries, setCommentDebugEntries] = useState<CommentDebugEntry[]>([]);
  const [collectionResultMeta, setCollectionResultMeta] = useState<CollectionResultMeta | null>(null);
  const abortRef = useRef(false);
  const scrollTimerRef = useRef<number | null>(null);
  const maxNotesRef = useRef<number>(20);
  const requestedNotesRef = useRef<number>(20);
  const collectionTargetRef = useRef<number>(20);
  const strictPublishTimeVisibleSourceRef = useRef(false);
  const enableCommentsRef = useRef(false);
  const maxCommentsPerNoteRef = useRef(12);
  const dataRef = useRef<any[]>([]);
  const activeSessionRef = useRef<string>('');
  const activeFiltersRef = useRef<SearchFilters | null>(null);
  const activeKeywordRef = useRef('');
  const phaseRef = useRef<'idle' | 'booting' | 'waiting_login' | 'searching' | 'filtering' | 'collecting' | 'enriching' | 'done'>('idle');
  const lastObservedSearchRequestAtRef = useRef(0);
  const lastMatchedSearchRequestAtRef = useRef(0);
  const lastFilterMismatchReasonRef = useRef('');
  const lastSearchRequestSnapshotRef = useRef('');
  const filterRequestIndexRef = useRef(0);
  const filterPostClickActivatedAtRef = useRef<number | null>(null);
  const filterRequestCaptureStartedAtRef = useRef<number | null>(null);
  const filterRequestCaptureActiveRef = useRef(false);
  const filterRequestObservedBaselineRef = useRef(0);
  const filterRequestMatchedBaselineRef = useRef(0);
  const requiresPostFilterGuardRef = useRef(false);
  const requestObservedRef = useRef(false);
  const requestMatchedRef = useRef(false);
  const requestCommittedRef = useRef(false);
  const strictVisibleRequestItemsRef = useRef<any[]>([]);
  const domFallbackUsedRef = useRef(false);
  const requestDrivenCollectionStartedRef = useRef(false);
  const requestBridgeFailureLoggedRef = useRef(false);
  const explicitEmptyResultRef = useRef(false);
  const collectionTopUpUsedRef = useRef(false);
  const bufferedSearchEventsRef = useRef<BufferedSearchEvent[]>([]);
  const releasedBufferedRequestCountRef = useRef(0);
  const latestCountDiagnosticsRef = useRef<CollectionCountDiagnostics>({
    bufferedMatchedCount: 0,
    releasedIntoDataCount: 0,
    dataCountBeforeEnrichment: 0,
    formattedCount: 0,
  });
  const lastLoggedExtensionBuildRef = useRef('');
  const lastAcceptedListActivityAtRef = useRef(0);
  const listCollectionStartedAtRef = useRef(0);
  const pendingScrapeRequestRef = useRef<PendingScrapeRequest | null>(null);
  const loginWaitStartedAtRef = useRef(0);
  const loginPollTimerRef = useRef<number | null>(null);
  const loginPollInFlightRef = useRef(false);
  const activeEnrichmentSessionRef = useRef('');
  const isEnrichmentRunningRef = useRef(false);
  const enrichmentPhaseRef = useRef<'idle' | 'details' | 'comments'>('idle');
  const enteredEnrichmentSessionRef = useRef('');
  const lastQueueSummarySignatureRef = useRef('');
  const lastDuplicateEnrichmentPhaseRef = useRef<'idle' | 'details' | 'comments'>('idle');
  const lastCompletedEnrichmentSessionRef = useRef('');
  const lastEnrichmentSkipSignatureRef = useRef('');

  const shouldShowCandidateProgress = useCallback(() => (
    requiresPostFilterGuardRef.current && !strictPublishTimeVisibleSourceRef.current
  ), []);

  const updateStatus = useCallback((phase: typeof phaseRef.current, message: string) => {
    phaseRef.current = phase;
    setStatusMessage(message);
  }, []);

  const appendFilterDebugEntry = useCallback((entry: Omit<FilterDebugEntry, 'id' | 'createdAt'>) => {
    const nextEntry: FilterDebugEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
      ...entry,
    };
    setFilterDebugEntries((prev) => [...prev, nextEntry].slice(-120));
  }, []);

  const appendCommentDebugEntry = useCallback((entry: Omit<CommentDebugEntry, 'id' | 'createdAt'>) => {
    const nextEntry: CommentDebugEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      createdAt: Date.now(),
      ...entry,
    };
    setCommentDebugEntries((prev) => [...prev, nextEntry].slice(-120));
  }, []);

  useEffect(() => {
    if (!extension) return;
    const buildSignature = [
      extension.name || 'unknown',
      extension.version || 'unknown',
      extension.manifestVersion || 'unknown',
      extension.buildMarker || 'none',
      extension.releaseId || 'none',
    ].join(':');
    if (lastLoggedExtensionBuildRef.current === buildSignature) return;
    lastLoggedExtensionBuildRef.current = buildSignature;
    appendFilterDebugEntry({
      stage: 'inject',
      message: '扩展构建信息',
      detail: `extension=${extension.name || 'unknown'} | version=${extension.version || 'unknown'} | manifestVersion=${extension.manifestVersion || extension.version || 'unknown'} | buildMarker=${extension.buildMarker || 'none'} | releaseId=${extension.releaseId || 'none'} | source=runtime_bridge`,
    });
  }, [appendFilterDebugEntry, extension]);

  const logCurrentExtensionBuild = useCallback((scene: string) => {
    if (!extension) return;
    appendFilterDebugEntry({
      stage: 'inject',
      message: '扩展构建信息',
      detail: `scene=${scene} | extension=${extension.name || 'unknown'} | version=${extension.version || 'unknown'} | manifestVersion=${extension.manifestVersion || extension.version || 'unknown'} | buildMarker=${extension.buildMarker || 'none'} | releaseId=${extension.releaseId || 'none'} | source=runtime_bridge`,
    });
  }, [appendFilterDebugEntry, extension]);

  const updateCountDiagnostics = useCallback((partial: Partial<CollectionCountDiagnostics>) => {
    latestCountDiagnosticsRef.current = {
      ...latestCountDiagnosticsRef.current,
      ...partial,
    };
  }, []);

  const summarizeQueueMetrics = useCallback((items: any[]) => {
    const uniqueIdCount = new Set(items.map((item) => String(item?.id || '').trim()).filter(Boolean)).size;
    const notesWithNoteUrl = items.filter((item) => typeof item?.noteUrl === 'string' && item.noteUrl.trim()).length;
    const notesWithToken = items.filter((item) => typeof item?.xsec_token === 'string' && item.xsec_token.trim()).length;
    const notesMissingEither = items.filter((item) => {
      const hasUrl = typeof item?.noteUrl === 'string' && item.noteUrl.trim();
      const hasToken = typeof item?.xsec_token === 'string' && item.xsec_token.trim();
      return !hasUrl || !hasToken;
    }).length;

    return {
      uniqueIdCount,
      notesWithNoteUrl,
      notesWithToken,
      notesMissingEither,
      signature: `${items.length}:${uniqueIdCount}:${notesWithNoteUrl}:${notesWithToken}:${notesMissingEither}`,
    };
  }, []);

  const appendIncomingNotes = useCallback((detail: SearchRequestDetail, requestAt: number) => {
    lastMatchedSearchRequestAtRef.current = requestAt;
    lastFilterMismatchReasonRef.current = '';
    lastAcceptedListActivityAtRef.current = requestAt;
    requestDrivenCollectionStartedRef.current = true;
    const rawIncoming = (detail?.resp?.data?.items || detail?.resp?.items || []).filter((item: any) => item.model_type === "note");
    const incoming = filterItemsByNoteType(rawIncoming, activeFiltersRef.current)
      .map(normalizeSearchNoteItem)
      .filter(Boolean);
    if (incoming.length > 0) {
      const mergedRequestItems = [...strictVisibleRequestItemsRef.current, ...incoming];
      strictVisibleRequestItemsRef.current = mergedRequestItems.filter((item, index, list) => {
        const idKey = String(item?.id || '').trim();
        if (!idKey) return false;
        return list.findIndex((candidate) => String(candidate?.id || '').trim() === idKey) === index;
      });
    }
    console.log(`[Scraper] 拦截到搜索结果，请求URL=${detail.url}，新增 ${incoming.length} 条 (raw=${rawIncoming.length})`, {
      requestTraceId: detail.requestTraceId || 'none',
    });
    if (strictPublishTimeVisibleSourceRef.current) {
      requestCommittedRef.current = true;
      appendFilterDebugEntry({
        stage: 'request',
        message: incoming.length > 0 ? '严格发布时间请求确认成功' : '严格发布时间请求确认成功（空结果）',
        detail: `requestTraceId=${detail.requestTraceId || 'none'} | incomingCount=${incoming.length} | strictPublishTimeSource=visible_dom | requestCommitted=${requestCommittedRef.current ? 'true' : 'false'}`,
      });
      return {
        committedCount: incoming.length,
        queueAccepted: true,
      };
    }
    const queueCountBefore = dataRef.current.length;
    const nextItems = [...dataRef.current, ...incoming];
    const nextUnique = nextItems.filter((v, i, a) => a.findIndex(t => (t.id === v.id)) === i).slice(0, collectionTargetRef.current);
    dataRef.current = nextUnique;
    const queueMetrics = summarizeQueueMetrics(nextUnique);
    const queueAccepted = didCommitSearchRequest({
      queueCountBefore,
      queueCountAfter: nextUnique.length,
      incomingCount: incoming.length,
    });
    if (queueAccepted) {
      requestCommittedRef.current = true;
    }
    if (queueMetrics.signature !== lastQueueSummarySignatureRef.current) {
      lastQueueSummarySignatureRef.current = queueMetrics.signature;
      appendFilterDebugEntry({
        stage: 'request',
        message: '正式队列摘要',
        detail: `requestTraceId=${detail.requestTraceId || 'none'} | notes=${nextUnique.length} | uniqueIdCount=${queueMetrics.uniqueIdCount} | notesWithNoteUrl=${queueMetrics.notesWithNoteUrl} | notesWithToken=${queueMetrics.notesWithToken} | notesMissingEither=${queueMetrics.notesMissingEither}`,
      });
    }
    updateCountDiagnostics({
      dataCountBeforeEnrichment: nextUnique.length,
    });
    setData(nextUnique);
    appendFilterDebugEntry({
      stage: 'request',
      message: queueAccepted ? '请求主链正式入队成功' : '请求主链未写入新队列数据',
      detail: `requestTraceId=${detail.requestTraceId || 'none'} | incomingCount=${incoming.length} | queueCountBefore=${queueCountBefore} | queueCountAfter=${nextUnique.length} | requestCommitted=${requestCommittedRef.current ? 'true' : 'false'}`,
    });
    return {
      committedCount: Math.max(0, nextUnique.length - queueCountBefore),
      queueAccepted,
    };
  }, [appendFilterDebugEntry, summarizeQueueMetrics, updateCountDiagnostics]);

  const commitVisibleDomNotes = useCallback((incoming: any[], source: string) => {
    const normalizedIncoming = filterItemsByNoteType(incoming, activeFiltersRef.current)
      .map(normalizeSearchNoteItem)
      .filter(Boolean);
    const nextUnique = normalizedIncoming
      .filter((item, index, list) => list.findIndex((candidate) => candidate?.id && item?.id && candidate.id === item.id) === index)
      .slice(0, collectionTargetRef.current);
    const queueMetrics = summarizeQueueMetrics(nextUnique);
    const changed = queueMetrics.signature !== lastQueueSummarySignatureRef.current;
    if (nextUnique.length > 0) {
      lastAcceptedListActivityAtRef.current = Date.now();
      requestDrivenCollectionStartedRef.current = true;
    }
    dataRef.current = nextUnique;
    updateCountDiagnostics({
      dataCountBeforeEnrichment: nextUnique.length,
    });
    setData(nextUnique);
    if (changed) {
      lastQueueSummarySignatureRef.current = queueMetrics.signature;
      appendFilterDebugEntry({
        stage: 'request',
        message: '严格发布时间场景已切换为页面结果直采',
        detail: `source=${source} | strictPublishTimeSource=visible_dom | notes=${nextUnique.length} | uniqueIdCount=${queueMetrics.uniqueIdCount} | notesWithNoteUrl=${queueMetrics.notesWithNoteUrl} | notesWithToken=${queueMetrics.notesWithToken} | notesMissingEither=${queueMetrics.notesMissingEither}`,
      });
    }
    return {
      committedCount: nextUnique.length,
      changed,
    };
  }, [appendFilterDebugEntry, summarizeQueueMetrics, updateCountDiagnostics]);

  const commitRecoveredUiNotes = useCallback((incoming: any[], source: string) => {
    const normalizedIncoming = filterItemsByNoteType(incoming, activeFiltersRef.current)
      .map(normalizeSearchNoteItem)
      .filter(Boolean);
    if (!normalizedIncoming.length) {
      appendFilterDebugEntry({
        stage: 'error',
        message: 'ui_applied 正式入队失败',
        detail: `source=${source} | normalizedCount=0`,
      });
      return 0;
    }

    lastAcceptedListActivityAtRef.current = Date.now();
    requestDrivenCollectionStartedRef.current = true;

    const nextItems = [...dataRef.current, ...normalizedIncoming];
    const nextUnique = nextItems
      .filter((item, index, list) => list.findIndex((candidate) => candidate?.id && item?.id && candidate.id === item.id) === index)
      .slice(0, collectionTargetRef.current);

    const committedCount = Math.max(0, nextUnique.length - dataRef.current.length);
    const queueMetrics = summarizeQueueMetrics(nextUnique);
    lastQueueSummarySignatureRef.current = queueMetrics.signature;
    updateCountDiagnostics({
      dataCountBeforeEnrichment: nextUnique.length,
    });
    dataRef.current = nextUnique;
    setData(nextUnique);
    appendFilterDebugEntry({
      stage: 'request',
      message: 'ui_applied 正式入队成功',
      detail: `source=${source} | committedCount=${committedCount} | notes=${nextUnique.length} | notesWithNoteUrl=${queueMetrics.notesWithNoteUrl} | notesWithToken=${queueMetrics.notesWithToken} | notesMissingEither=${queueMetrics.notesMissingEither}`,
    });
    return committedCount;
  }, [appendFilterDebugEntry, summarizeQueueMetrics, updateCountDiagnostics]);

  const collectVisibleSearchNotes = useCallback(async (tabId: number, expectedKeyword?: string) => {
    if (!extension || !tabId) {
      return {
        notes: [] as any[],
        count: 0,
        url: '',
        looksLikeSearchResult: false,
        keywordMatches: false,
        pageKeyword: '',
      };
    }

    const resp = await extension.invoke("web:runtime:evaluate", {
      tabId,
      args: [expectedKeyword || ''],
      code: ((keyword: string) => {
        const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
        const normalizeUrl = (value: string) => {
          const trimmed = String(value || '').trim();
          if (!trimmed) return '';
          if (trimmed.startsWith('//')) return `https:${trimmed}`;
          return trimmed;
        };
        const parseMetricText = (value: string) => {
          const text = normalizeText(value);
          if (!text) return '0';
          const matched = text.match(/\d+(?:\.\d+)?(?:万|w|W)?/);
          return matched?.[0] || '0';
        };
        const parseHrefToken = (href: string) => {
          try {
            const url = new URL(href, window.location.origin);
            return url.searchParams.get('xsec_token') || '';
          } catch {
            const matched = href.match(/[?&]xsec_token=([^&#]+)/);
            return matched?.[1] ? decodeURIComponent(matched[1]) : '';
          }
        };
        const pickTextBySelectors = (root: HTMLElement, selectors: string[]) => {
          for (const selector of selectors) {
            const node = root.querySelector(selector) as HTMLElement | null;
            const text = normalizeText(node?.innerText || node?.textContent || '');
            if (text) return text;
          }
          return '';
        };

        const nodes = Array.from(document.querySelectorAll('.note-item')) as HTMLElement[];
        const currentUrl = window.location.href;
        let urlKeyword = '';
        try {
          urlKeyword = new URL(currentUrl).searchParams.get('keyword') || '';
        } catch {
          urlKeyword = '';
        }
        const normalizedExpectedKeyword = normalizeText(keyword || '');
        const normalizedUrlKeyword = normalizeText(decodeURIComponent(urlKeyword || ''));
        const looksLikeSearchResult = currentUrl.includes('/search_result');
        const keywordMatches = !normalizedExpectedKeyword || normalizedExpectedKeyword === normalizedUrlKeyword;
        const notes = nodes.map((node, index) => {
          const anchor = node.querySelector('a[href*="/explore/"]') as HTMLAnchorElement | null;
          const href = anchor?.href || '';
          const idMatch = href.match(/\/explore\/([^?/#]+)/);
          const id = idMatch?.[1] || node.getAttribute('data-id') || `${index}`;
          const xsecToken = parseHrefToken(href);

          const titleElem =
            (node.querySelector('.title') as HTMLElement | null) ||
            (node.querySelector('[class*="title"]') as HTMLElement | null) ||
            (node.querySelector('img') as HTMLImageElement | null);

          const userElem =
            (node.querySelector('.author') as HTMLElement | null) ||
            (node.querySelector('[class*="author"]') as HTMLElement | null) ||
            (node.querySelector('[class*="user"]') as HTMLElement | null);

          const desc = pickTextBySelectors(node, [
            '.desc',
            '[class*="desc"]',
            '.content',
            '[class*="content"]',
            '.note-text',
            '[class*="text"]',
          ]);

          const imgNodes = Array.from(node.querySelectorAll('img')) as HTMLImageElement[];
          const imageList = imgNodes
            .map((img) => normalizeUrl(img.src || img.getAttribute('src') || ''))
            .filter(Boolean);

          const metrics = Array.from(node.querySelectorAll('span, div'))
            .map((elem) => normalizeText((elem as HTMLElement).innerText || elem.textContent || ''))
            .filter(Boolean);

          const metricCandidates = metrics.filter((text) => /\d/.test(text));
          const likeMetric = parseMetricText(metricCandidates[0] || '0');
          const commentMetric = parseMetricText(metricCandidates[1] || '0');

          return {
            id,
            title: normalizeText((titleElem as HTMLElement | null)?.innerText || titleElem?.getAttribute?.('alt') || ''),
            desc,
            author: normalizeText(userElem?.innerText || userElem?.textContent || ''),
            imageUrl: imageList[0] || '',
            imageList,
            noteUrl: href || (id ? `https://www.xiaohongshu.com/explore/${id}` : ''),
            xsec_token: xsecToken,
            likes: likeMetric,
            stars: '0',
            shares: '0',
            commentCount: commentMetric,
            model_type: 'note',
          };
        }).filter((item) => item.id && (item.title || item.imageUrl || item.noteUrl));

        return {
          notes,
          count: notes.length,
          url: currentUrl,
          looksLikeSearchResult,
          keywordMatches,
          pageKeyword: normalizedUrlKeyword,
        };
      }).toString(),
    });
    const result = unwrapEvalResult<{ notes: any[]; count: number; url: string; looksLikeSearchResult: boolean; keywordMatches: boolean; pageKeyword: string }>(resp);
    return result.success && result.data
      ? result.data
      : {
          notes: [] as any[],
          count: 0,
          url: '',
          looksLikeSearchResult: false,
          keywordMatches: false,
          pageKeyword: '',
        };
  }, [extension]);

  const syncStrictPublishTimeVisibleNotes = useCallback(async (tabId: number, source: string, expectedKeyword?: string) => {
    if (!strictPublishTimeVisibleSourceRef.current || !tabId) {
      return { committedCount: 0, count: 0, accepted: false };
    }
    const result = await collectVisibleSearchNotes(tabId, expectedKeyword);
    if (!result.looksLikeSearchResult || !result.keywordMatches) {
      appendFilterDebugEntry({
        stage: 'request',
        message: '严格发布时间页面结果直采被跳过',
        detail: `source=${source} | url=${result.url} | pageKeyword=${result.pageKeyword || 'none'} | expectedKeyword=${expectedKeyword || 'none'} | looksLikeSearchResult=${result.looksLikeSearchResult ? 'true' : 'false'} | keywordMatches=${result.keywordMatches ? 'true' : 'false'}`,
      });
      return { committedCount: 0, count: Number(result.count || 0), accepted: false };
    }
    const committed = commitVisibleDomNotes(result.notes || [], source);
    return {
      committedCount: committed.committedCount,
      count: Number(result.count || 0),
      accepted: true,
    };
  }, [appendFilterDebugEntry, collectVisibleSearchNotes, commitVisibleDomNotes]);

  const appendDomFallbackNotes = useCallback((incoming: any[], source: string, maxAppend = 4, allowStrictCommit = false) => {
    if (!allowStrictCommit && hasActiveFilterOverrides(activeFiltersRef.current || DEFAULT_SEARCH_FILTERS)) {
      appendFilterDebugEntry({
        stage: 'request',
        message: '严格筛选下跳过正式 DOM 兜底入队',
        detail: `source=${source} | rawCount=${incoming.length}`,
      });
      return 0;
    }
    const filteredIncoming = filterItemsByNoteType(incoming, activeFiltersRef.current)
      .map(normalizeSearchNoteItem)
      .filter(Boolean);
    if (!filteredIncoming.length) return 0;
    let appendedCount = 0;
    setData((prev) => {
      if (prev.length >= collectionTargetRef.current) return prev;
      const maxFallbackAppend = Math.min(maxAppend, Math.max(0, collectionTargetRef.current - prev.length));
      if (maxFallbackAppend <= 0) return prev;
      const next = [...prev];
      for (const item of filteredIncoming) {
        const alreadyExists = next.some((existing) => existing?.id && item?.id && existing.id === item.id);
        if (alreadyExists) continue;
        next.push(item);
        appendedCount += 1;
        if (appendedCount >= maxFallbackAppend || next.length >= collectionTargetRef.current) break;
      }
      return next.slice(0, collectionTargetRef.current);
    });
    if (appendedCount > 0) {
      lastAcceptedListActivityAtRef.current = Date.now();
      console.log(`[Scraper] DOM 兜底提取到 ${appendedCount} 条笔记，source=${source}, raw=${incoming.length}, filtered=${filteredIncoming.length}`);
    }
    return appendedCount;
  }, [appendFilterDebugEntry]);

  const releaseBufferedSearchEvents = useCallback((clickedAt: number) => {
    const matchedEvents = pickBufferedSearchEventsBeforeClick(bufferedSearchEventsRef.current, clickedAt);
    updateCountDiagnostics({
      bufferedMatchedCount: matchedEvents.length,
    });
    if (matchedEvents.length === 0) {
      return 0;
    }

    let releasedCount = 0;
    const releasedTraceIds: string[] = [];
    matchedEvents.forEach((event, index) => {
      if (index >= collectionTargetRef.current) return;
      const committed = appendIncomingNotes(event.detail, event.requestAt);
      if (committed.queueAccepted) {
        releasedCount += 1;
      }
      if (event.detail.requestTraceId) {
        releasedTraceIds.push(event.detail.requestTraceId);
      }
    });

    releasedBufferedRequestCountRef.current += releasedCount;
    updateCountDiagnostics({
      releasedIntoDataCount: releasedBufferedRequestCountRef.current,
    });
    appendFilterDebugEntry({
      stage: 'request',
      message: '释放点击前匹配请求',
      detail: `bufferedMatchedCount=${matchedEvents.length} | releasedIntoDataCount=${releasedCount} | clickedAt=${clickedAt} | requestTraceIds=${releasedTraceIds.join(',') || 'none'}`,
    });
    bufferedSearchEventsRef.current = [];
    return releasedCount;
  }, [appendFilterDebugEntry, appendIncomingNotes, updateCountDiagnostics]);

  const tryCollectListDomFallback = useCallback(async (tabId: number, source: string, expectedKeyword?: string, allowStrictCommit = false) => {
    if (!extension || !tabId) return 0;
    let detachDebuggerIfNeeded: (() => Promise<void>) | null = null;

    try {
      const result = await collectVisibleSearchNotes(tabId, expectedKeyword);
      if (!result.notes?.length) {
        return 0;
      }
      if (!result.looksLikeSearchResult || !result.keywordMatches) {
        appendFilterDebugEntry({
          stage: 'request',
          message: '放弃列表 DOM 兜底：当前页面不是目标搜索结果',
          detail: `source=${source} | url=${result.url} | pageKeyword=${result.pageKeyword || 'none'} | expectedKeyword=${expectedKeyword || 'none'}`,
        });
        return 0;
      }
      const uniqueIdCount = new Set(result.notes.map((item) => String(item?.id || '').trim()).filter(Boolean)).size;
      const notesWithNoteUrl = result.notes.filter((item) => typeof item?.noteUrl === 'string' && item.noteUrl.trim()).length;
      const notesWithToken = result.notes.filter((item) => typeof item?.xsec_token === 'string' && item.xsec_token.trim()).length;
      appendFilterDebugEntry({
        stage: 'request',
        message: '触发一次列表 DOM 首批兜底',
        detail: `source=${source} | count=${result.count} | uniqueIdCount=${uniqueIdCount} | notesWithNoteUrl=${notesWithNoteUrl} | notesWithToken=${notesWithToken} | url=${result.url}`,
      });
      domFallbackUsedRef.current = true;
      if (!requestDrivenCollectionStartedRef.current && !requestBridgeFailureLoggedRef.current) {
        requestBridgeFailureLoggedRef.current = true;
        appendFilterDebugEntry({
          stage: 'request',
          message: '搜索请求监听疑似失效，当前仅能先使用 DOM 可见结果补空',
          detail: `source=${source} | domCount=${result.count} | url=${result.url}`,
        });
      }
      const domAppendLimit = requestDrivenCollectionStartedRef.current ? 4 : requestedNotesRef.current;
      const appended = appendDomFallbackNotes(result.notes, source, domAppendLimit, allowStrictCommit);
      updateCountDiagnostics({
        dataCountBeforeEnrichment: Math.max(dataRef.current.length, appended),
      });
      return appended;
    } catch (error) {
      appendFilterDebugEntry({
        stage: 'error',
        message: '列表 DOM 兜底采集失败',
        detail: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }, [appendDomFallbackNotes, appendFilterDebugEntry, collectVisibleSearchNotes, extension]);

  useEffect(() => {
    dataRef.current = data;
    if (isScraping) {
      if (phaseRef.current === 'collecting') {
        setStatusMessage(formatCollectionProgressText({
          phase: 'collecting',
          currentCount: data.length,
          requestedCount: requestedNotesRef.current,
          candidateTargetCount: collectionTargetRef.current,
          showCandidateProgress: shouldShowCandidateProgress(),
        }));
      }
    }
  }, [data, isScraping, shouldShowCandidateProgress]);

  const createFilterSignature = (filters: SearchFilters | null) => JSON.stringify(filters || {});

  const clearLoginWait = useCallback(() => {
    pendingScrapeRequestRef.current = null;
    loginWaitStartedAtRef.current = 0;
    loginPollInFlightRef.current = false;
    if (loginPollTimerRef.current !== null) {
      window.clearInterval(loginPollTimerRef.current);
      loginPollTimerRef.current = null;
    }
  }, []);

  const closeWorkerTab = useCallback(async (targetTabId?: number) => {
    if (!extension) return;
    const tabIdToClose = targetTabId ?? workerTab?.id;
    if (tabIdToClose === undefined) return;
    try {
      await extension.invoke("chrome:tabs:remove", { tabIds: [tabIdToClose] });
    } catch (error) {
      console.warn('[Scraper] 关闭采集标签页失败:', error);
    } finally {
      setWorkerTab((prev) => (prev?.id === tabIdToClose ? undefined : prev));
    }
  }, [extension, workerTab?.id]);

  const unwrapEvalResult = <T,>(response: any): InjectionEvalResultLike<T> => {
    const result = response?.[0]?.result;
    if (!result) {
      return { success: false, data: null, message: '注入返回为空' };
    }
    return {
      success: Boolean(result.success),
      data: (result.data ?? null) as T | null,
      message: result.message,
    };
  };

  const formatSearchSnapshot = (snapshot: SearchResultSnapshot | null | undefined) => {
    if (!snapshot) return '无页面状态快照';
    return [
      `url=${snapshot.url || 'unknown'}`,
      `resultUrl=${snapshot.hasResultUrl}`,
      `noteItem=${snapshot.hasNoteItem}`,
      `filterEntry=${snapshot.hasFilterEntry}`,
      `filterPanel=${snapshot.hasFilterPanel}`,
      `searchInput=${snapshot.searchInputPresent}`,
      `searchIcon=${snapshot.searchIconPresent}`,
    ].join(', ');
  };

  const formatInjectionProbe = (probe: InjectionProbeState | null | undefined) => {
    if (!probe) return 'probe=none';
    return [
      `url=${probe.url || 'unknown'}`,
      `readyState=${probe.readyState || 'unknown'}`,
      `bridge=${probe.extensionBridgeReady}`,
      `network=${probe.networkHookReady}`,
      `xhr=${probe.xhrHookReady}`,
      `fetchReq=${probe.fetchRequestHookReady}`,
      `fetchResp=${probe.fetchResponseHookReady}`,
      `xhrHooks=${(probe.registeredXhrHooks || []).join(',') || 'none'}`,
      `fetchRespHooks=${(probe.registeredFetchResponseHooks || []).join(',') || 'none'}`,
      `stage=${probe.diagnosticsStage || 'unknown'}`,
    ].join(' | ');
  };

  const probeWorkerInjection = useCallback(async (tabId: number) => {
    if (!extension || !tabId) return null;
    try {
      const resp = await extension.invoke("web:runtime:evaluate", {
        tabId,
        args: [extension.name],
        code: ((extensionName: string) => {
          const extension = (window as any)[extensionName];
          const hook = (window as any).__NETWORK_HOOK__;
          const diagnostics = (window as any).__XHS_MARKETING_EXTENSION_DIAGNOSTICS__ || {};
          return {
            url: window.location.href,
            readyState: document.readyState,
            extensionBridgeReady: Boolean(extension),
            networkHookReady: Boolean(hook),
            xhrHookReady: Boolean(hook?.xhr?.send?.on),
            fetchRequestHookReady: Boolean(hook?.fetch?.request?.on),
            fetchResponseHookReady: Boolean(hook?.fetch?.response?.on),
            registeredXhrHooks: Object.keys(hook?.xhr?.send?.hook || {}),
            registeredFetchRequestHooks: Object.keys(hook?.fetch?.request?.hook || {}),
            registeredFetchResponseHooks: Object.keys(hook?.fetch?.response?.hook || {}),
            diagnosticsStage: String(diagnostics.stage || ''),
          };
        }).toString(),
      });
      const result = unwrapEvalResult<InjectionProbeState>(resp);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }, [extension]);

  const readWorkerHookSeenSummary = useCallback(async (tabId: number) => {
    if (!extension || !tabId) return null;
    try {
      const resp = await extension.invoke("web:runtime:evaluate", {
        tabId,
        args: [],
        code: (() => {
          const state = (window as any).__XHS_SCRAPER_HOOK_SEEN_STATE__ || null;
          return state
            ? {
                fetchRequestCount: Number(state.fetchRequestCount || 0),
                fetchResponseCount: Number(state.fetchResponseCount || 0),
                xhrCount: Number(state.xhrCount || 0),
                searchLikeSeenCount: Number(state.searchLikeSeenCount || 0),
                strictSearchMatchedCount: Number(state.strictSearchMatchedCount || 0),
              }
            : null;
        }).toString(),
      });
      const result = unwrapEvalResult<{
        fetchRequestCount: number;
        fetchResponseCount: number;
        xhrCount: number;
        searchLikeSeenCount: number;
        strictSearchMatchedCount: number;
      } | null>(resp);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }, [extension]);

  const readWorkerCapturedMatchedRequests = useCallback(async (tabId: number, capturedAfter: number) => {
    if (!extension || !tabId) return [] as WorkerCapturedMatchedRequestState[];
    try {
      const resp = await extension.invoke("web:runtime:evaluate", {
        tabId,
        args: [capturedAfter],
        code: ((minCapturedAt: number) => {
          const matchedItems = (window as any).__XHS_CAPTURED_MATCHED_REQUESTS__ || [];
          const earlyItems = (window as any).__XHS_EARLY_CAPTURED_SEARCH_REQUESTS__ || [];
          const combinedItems = [
            ...(Array.isArray(matchedItems) ? matchedItems : []),
            ...(Array.isArray(earlyItems) ? earlyItems : []),
          ];
          const seenTraceIds = new Set<string>();
          return combinedItems
            .filter((item) => Number(item?.requestCapturedAt || 0) >= minCapturedAt)
            .filter((item) => {
              const traceId = String(item?.requestTraceId || '');
              if (!traceId) return true;
              if (seenTraceIds.has(traceId)) return false;
              seenTraceIds.add(traceId);
              return true;
            })
            .slice(-20);
        }).toString(),
      });
      const result = unwrapEvalResult<WorkerCapturedMatchedRequestState[]>(resp);
      return result.success && Array.isArray(result.data) ? result.data : [];
    } catch {
      return [];
    }
  }, [extension]);

  const ensureProxyReady = useCallback(async (targetTabId: number, currentFrontendTabId: number, scene: string) => {
    if (!extension || !targetTabId) return null;
    let lastProbe: InjectionProbeState | null = null;
    let lastReason = '';
    const maxTries = 8;

    for (let index = 0; index < maxTries; index += 1) {
      const probeBefore = await probeWorkerInjection(targetTabId);
      lastProbe = probeBefore;
      appendFilterDebugEntry({
        stage: 'inject',
        message: index === 0 ? `检查结果页注入状态：${scene}` : `重试结果页注入状态：${scene}`,
        detail: formatInjectionProbe(probeBefore),
      });

      const readyBefore =
        Boolean(probeBefore?.extensionBridgeReady) &&
        Boolean(probeBefore?.networkHookReady) &&
        Boolean(probeBefore?.xhrHookReady) &&
        Boolean(probeBefore?.fetchRequestHookReady) &&
        Boolean(probeBefore?.fetchResponseHookReady) &&
        Boolean(probeBefore?.registeredXhrHooks?.includes('xhs-api')) &&
        Boolean(probeBefore?.registeredFetchRequestHooks?.includes('xhs-api-fetch-request')) &&
        Boolean(probeBefore?.registeredFetchResponseHooks?.includes('xhs-api-fetch'));
      if (readyBefore) {
        appendFilterDebugEntry({
          stage: 'request',
          message: 'worker 桥接调试链已就绪',
          detail: `scene=${scene} | source=frontend_confirmed | url=${probeBefore?.url || 'unknown'} | readyState=${probeBefore?.readyState || 'unknown'} | xhrHooks=${(probeBefore?.registeredXhrHooks || []).join(',') || 'none'} | fetchReqHooks=${(probeBefore?.registeredFetchRequestHooks || []).join(',') || 'none'} | fetchRespHooks=${(probeBefore?.registeredFetchResponseHooks || []).join(',') || 'none'}`,
        });
        return probeBefore;
      }

      const installResult = await injectProxy(targetTabId, currentFrontendTabId);
      lastReason = installResult?.reason || 'proxy_install_unknown';
      const probeAfter = installResult?.probe || await probeWorkerInjection(targetTabId);
      lastProbe = probeAfter;
      appendFilterDebugEntry({
        stage: 'inject',
        message: installResult?.ok ? `结果页注入注册成功：${scene}` : `结果页注入注册待重试：${scene}`,
        detail: `reason=${lastReason} | ${formatInjectionProbe(probeAfter)}`,
      });

      const readyAfter =
        Boolean(probeAfter?.extensionBridgeReady) &&
        Boolean(probeAfter?.networkHookReady) &&
        Boolean(probeAfter?.xhrHookReady) &&
        Boolean(probeAfter?.fetchRequestHookReady) &&
        Boolean(probeAfter?.fetchResponseHookReady) &&
        Boolean(probeAfter?.registeredXhrHooks?.includes('xhs-api')) &&
        Boolean(probeAfter?.registeredFetchRequestHooks?.includes('xhs-api-fetch-request')) &&
        Boolean(probeAfter?.registeredFetchResponseHooks?.includes('xhs-api-fetch'));
      if (readyAfter) {
        appendFilterDebugEntry({
          stage: 'request',
          message: 'worker 桥接调试链已就绪',
          detail: `scene=${scene} | source=frontend_confirmed | url=${probeAfter?.url || 'unknown'} | readyState=${probeAfter?.readyState || 'unknown'} | xhrHooks=${(probeAfter?.registeredXhrHooks || []).join(',') || 'none'} | fetchReqHooks=${(probeAfter?.registeredFetchRequestHooks || []).join(',') || 'none'} | fetchRespHooks=${(probeAfter?.registeredFetchResponseHooks || []).join(',') || 'none'}`,
        });
        return probeAfter;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`结果页注入未就绪: ${lastReason || 'unknown'} | ${formatInjectionProbe(lastProbe)}`);
  }, [appendFilterDebugEntry, extension, probeWorkerInjection]);

  const isSearchNotesRequest = (url?: string | null) => {
    return looksLikeSearchNotesRequest({ url });
  };

  // create worker tab
  const createWorkerTab = useCallback(async () => {
    if (!extension || !tab) return null;
    try {
      const createProperties = {
        url: "https://www.xiaohongshu.com/explore",
        openerTabId: tab.id,
        active: false,
      };
      const createdTab = await extension.invoke("chrome:tabs:create", { createProperties });
      setWorkerTab(createdTab);
      return createdTab;
    } catch (err) {
      console.error(err);
      return null;
    }
  }, [extension, tab]);

  useEffect(() => {
    if (!extension) return;
    const update = (params: { payload: { tabId: number; tab: BrowserTab } }) => {
      if (params.payload.tabId === workerTab?.id) {
        setWorkerTab(params.payload.tab);
      }
    };
    const remove = (params: { payload: { tabId: number } }) => {
      if (params.payload.tabId === workerTab?.id) {
        setWorkerTab(undefined);
      }
    };
    extension.event.on("chrome:tabs:onUpdated", update);
    extension.event.on("chrome:tabs:onRemoved", remove);
    return () => {
      extension.event.off("chrome:tabs:onUpdated", update);
      extension.event.off("chrome:tabs:onRemoved", remove);
    };
  }, [extension, workerTab?.id]);

  useEffect(() => {
    if (!extension || workerTab?.id === undefined) return;
    const tabId = workerTab.id;
    const deal = () => {
      extension.invoke("chrome:tabs:remove", { tabIds: [tabId] }).catch(console.error);
    };
    window.addEventListener("beforeunload", deal);
    return () => window.removeEventListener("beforeunload", deal);
  }, [extension, workerTab?.id]);

  const decodeBase64Text = useCallback((payload?: string | null) => {
    if (!payload) return '';
    const binaryString = window.atob(payload);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }, []);

  const extractInitialStateFromHtml = useCallback((htmlStr: string) => {
    let match = htmlStr.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!match) {
      match = htmlStr.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    }

    if (!match) {
      return null;
    }

    try {
      try {
        return JSON.parse(match[1]);
      } catch {
        return JSON.parse(match[1].replace(/undefined/g, 'null'));
      }
    } catch {
      return null;
    }
  }, []);

  // 获取笔记详情的方法
  const buildNoteDetailUrl = (id: string, xsecToken?: string, noteUrl?: string) => {
    const normalizedNoteUrl = String(noteUrl || '').trim();
    if (normalizedNoteUrl) {
      return normalizedNoteUrl;
    }
    const normalizedId = String(id || '').trim();
    const normalizedToken = String(xsecToken || '').trim();
    if (!normalizedId) return '';
    return normalizedToken
      ? `https://www.xiaohongshu.com/explore/${normalizedId}?xsec_token=${normalizedToken}&xsec_source=pc_search`
      : `https://www.xiaohongshu.com/explore/${normalizedId}`;
  };

  const fetchNoteDetail = async (id: string, xsec_token?: string, noteUrl?: string) => {
    if (!extension) return null;
    try {
      const candidateUrls = Array.from(new Set([
        buildNoteDetailUrl(id, xsec_token, noteUrl),
        buildNoteDetailUrl(id),
      ].filter(Boolean)));

      for (const detailUrl of candidateUrls) {
        const fetchRes = await extension.invoke("service-worker:fetch", {
          url: detailUrl,
          method: "GET",
          init: { credentials: "include" }
        });

        if (!fetchRes || !fetchRes.body) continue;

        const html = decodeBase64Text(fetchRes.body);
        const state = extractInitialStateFromHtml(html);
        if (state) {
          const note = extractNoteDetailFromState(state, id);
          if (note) {
            return note;
          }
        }
      }
      console.warn("[Scraper] 无法从详情页提取 __INITIAL_STATE__。可能的原因：1.需要验证码 2.登录态已过期 3.正则不匹配");
    } catch (e) {
      console.error("[Scraper] 获取笔记详情失败:", id, e);
    }
    return null;
  };

  const fetchNoteDetailFromDetailDom = async (noteId: string, xsecToken: string | undefined, noteUrl: string | undefined) => {
    if (!extension || !noteId) return null;
    const targetNoteUrl = buildNoteDetailUrl(noteId, xsecToken, noteUrl);
    let tempTabId: number | undefined;
    try {
      const createdTab = await extension.invoke("chrome:tabs:create", {
        createProperties: {
          url: targetNoteUrl,
          active: false,
        },
      });
      tempTabId = createdTab?.id;
      if (tempTabId === undefined) {
        throw new Error('detail_dom_tab_create_failed');
      }

      const waitForDetailPage = async () => {
        const maxTries = 24;
        for (let i = 0; i < maxTries; i += 1) {
          const currentTab = await extension.invoke("chrome:tabs:get", { tabId: tempTabId! }).catch(() => null);
          if (currentTab?.status === 'complete') {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };

      await waitForDetailPage();

      const detailResp = await extension.invoke("web:runtime:evaluate", {
        tabId: tempTabId,
        args: [],
        code: (() => {
          const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();
          const normalizeUrl = (value: string) => {
            const trimmed = String(value || '').trim();
            if (!trimmed) return '';
            if (trimmed.startsWith('//')) return `https:${trimmed}`;
            return trimmed;
          };
          const normalizeImageIdentity = (value: string) => {
            const normalized = normalizeUrl(value).replace(/^http:\/\//i, 'https://');
            if (!normalized) return '';
            const withoutVariant = normalized.replace(/![^/?#]+(?=($|[?#]))/, '');
            const withoutQuery = withoutVariant.split('?')[0].split('#')[0];
            const lastSegment = withoutQuery.split('/').filter(Boolean).pop() || '';
            return lastSegment || withoutVariant;
          };
          const state = (window as any).__INITIAL_STATE__ || null;
          const descNode = (
            document.querySelector('.note-content') ||
            document.querySelector('[class*="content"]') ||
            document.querySelector('[class*="desc"]')
          ) as HTMLElement | null;
          const galleryRoot = (
            document.querySelector('[class*="swiper"]') ||
            document.querySelector('[class*="carousel"]') ||
            document.querySelector('[class*="media"]') ||
            document.querySelector('[class*="image"]')
          ) as HTMLElement | null;
          const timeNode = (
            document.querySelector('time') ||
            document.querySelector('[class*="time"]') ||
            document.querySelector('[class*="date"]')
          ) as HTMLElement | null;
          const imgRoot = galleryRoot || document;
          const imgs = Array.from(imgRoot.querySelectorAll('img')) as HTMLImageElement[];
          const imageMap = new Map<string, string>();
          imgs.forEach((img) => {
            const rawUrl = normalizeUrl(img.currentSrc || img.src || img.getAttribute('src') || '');
            if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.endsWith('.svg') || rawUrl.includes('/avatar/')) {
              return;
            }
            const width = Number(img.naturalWidth || img.width || 0);
            const height = Number(img.naturalHeight || img.height || 0);
            if (width > 0 && height > 0 && Math.max(width, height) < 160) {
              return;
            }
            const identity = normalizeImageIdentity(rawUrl);
            if (!identity || imageMap.has(identity)) {
              return;
            }
            imageMap.set(identity, rawUrl);
          });
          const imageList = Array.from(imageMap.values());
          return {
            initialState: state,
            domDetail: {
              desc: normalizeText(descNode?.innerText || descNode?.textContent || ''),
              imageList,
              create_date_time: normalizeText(timeNode?.innerText || timeNode?.textContent || ''),
            },
          };
        }).toString(),
      });

      const detailResult = unwrapEvalResult<{ initialState: any; domDetail: { desc: string; imageList: string[]; create_date_time: string } }>(detailResp);
      if (!detailResult.success || !detailResult.data) {
        return null;
      }

      const noteFromState = extractNoteDetailFromState(detailResult.data.initialState, noteId);
      if (noteFromState) {
        return noteFromState;
      }

      const domDetail = detailResult.data.domDetail;
      if (domDetail.desc || domDetail.imageList.length > 0 || domDetail.create_date_time) {
        return domDetail;
      }
    } catch (error) {
      console.warn('[Scraper] 详情页 DOM 兜底失败:', noteId, error);
    } finally {
      if (tempTabId !== undefined) {
        try {
          await extension.invoke("chrome:tabs:remove", { tabIds: [tempTabId] });
        } catch {}
      }
    }
    return null;
  };

  const fetchNoteCommentsFromDetailDom = async (noteId: string, xsecToken: string | undefined, noteUrl: string | undefined, maxCount: number, _tabId: number) => {
    if (!extension || !noteId || maxCount <= 0) return [];
    const targetNoteUrl = buildNoteDetailUrl(noteId, xsecToken, noteUrl);
    let tempTabId: number | undefined;
    try {
      appendCommentDebugEntry({
        noteId,
        stage: 'request',
        message: '开始尝试详情页快速 DOM 扫描',
        detail: targetNoteUrl,
      });

      const createdTab = await extension.invoke("chrome:tabs:create", {
        createProperties: {
          url: targetNoteUrl,
          active: false,
        },
      });
      tempTabId = createdTab?.id;
      if (tempTabId === undefined) {
        throw new Error('comment_detail_tab_create_failed');
      }

      const waitForDetailPage = async () => {
        const maxTries = 24;
        for (let i = 0; i < maxTries; i += 1) {
          const currentTab = await extension.invoke("chrome:tabs:get", { tabId: tempTabId! }).catch(() => null);
          if (currentTab?.status === 'complete') {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };

      await waitForDetailPage();

      const waitForDetailReady = async () => {
        const maxTries = 14;
        for (let i = 0; i < maxTries; i++) {
          try {
            const inspectResp = await extension.invoke("web:runtime:evaluate", {
              tabId: tempTabId!,
              args: [],
              code: (() => {
                const commentSelectors = [
                  '.comment-item',
                  '[class*="comment-item"]',
                  '[class*="comment-list"] > div',
                  '[class*="commentList"] > div',
                  '[class*="comments-container"] > div',
                ];
                const heading = Array.from(document.querySelectorAll('h2, h3, div, span')).find((node) => {
                  const text = (node.textContent || '').replace(/\s+/g, '').trim();
                  return text === '评论' || text.startsWith('评论(') || text.startsWith('评论区');
                }) as HTMLElement | undefined;
                if (heading) {
                  heading.scrollIntoView({ block: 'start' });
                } else {
                  window.scrollBy({ top: Math.max(window.innerHeight * 0.72, 560), behavior: 'auto' });
                }
                const foundRoots = commentSelectors.reduce((count, selector) => {
                  try {
                    return count + document.querySelectorAll(selector).length;
                  } catch {
                    return count;
                  }
                }, 0);
                return {
                  url: window.location.href,
                  readyState: document.readyState,
                  foundCount: foundRoots,
                  title: document.title,
                };
              }).toString(),
            });
            const inspectResult = unwrapEvalResult<{ url: string; readyState: string; foundCount: number; title: string }>(inspectResp);
            if (inspectResult.success && inspectResult.data && inspectResult.data.url.includes(noteId)) {
              if (inspectResult.data.foundCount > 0 || (inspectResult.data.readyState === 'complete' && i >= 3)) {
                return inspectResult.data;
              }
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 320));
        }
        return null;
      };

      const isShellPagePreview = (preview: string) => {
        const normalized = String(preview || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return false;
        return (
          normalized.includes('沪ICP备13030189号') ||
          normalized.includes('增值电信业务经营许可证') ||
          normalized.includes('个性化推荐算法') ||
          normalized.includes('上海市黄浦区马当路388号')
        );
      };

      const readCommentSnapshot = async () => {
        const scrapeResp = await extension.invoke("web:runtime:evaluate", {
          tabId: tempTabId!,
          args: [maxCount],
          code: ((limit: number) => {
            const normalizeText = (value: string) => value
              .replace(/\u00a0/g, ' ')
              .replace(/\r/g, '')
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            const parseCount = (value: string) => {
              const text = normalizeText(value).toLowerCase();
              if (!text) return '0';
              if (text.includes('万')) {
                const num = Number(text.replace(/[^\d.]/g, ''));
                return String(Number.isFinite(num) ? Math.round(num * 10000) : 0);
              }
              return String(Number(text.replace(/[^\d]/g, '')) || 0);
            };

            const selectorGroups = [
              '.comment-item',
              '[class*="comment-item"]',
              '[class*="comment-list"] > div',
              '[class*="commentList"] > div',
              '[class*="comments-container"] > div',
            ];
            const rawRoots = selectorGroups.flatMap((selector) => {
              try {
                return Array.from(document.querySelectorAll(selector));
              } catch {
                return [];
              }
            });
            const seen = new Set<Element>();
            const commentItems = rawRoots.filter((node) => {
              if (seen.has(node)) return false;
              seen.add(node);
              return true;
            });
            const pickedItems = commentItems.slice(0, Math.max(1, Math.min(limit, 20)));

            const comments = pickedItems.map((elem, index) => {
              const root = elem as HTMLElement;
              const userElem = root.querySelector('.user-name, [class*="user-name"], [class*="author"], [class*="nickname"]') as HTMLElement | null;
              const contentElem = root.querySelector('.content, [class*="content"], [class*="comment-text"], [class*="desc"], [class*="text"]') as HTMLElement | null;
              const likeElem = root.querySelector('.like-count, [class*="like-count"], [class*="like"]') as HTMLElement | null;
              const replyElem = root.querySelector('[class*="reply"], [class*="sub-comment"], [class*="children"]') as HTMLElement | null;
              const timeElem = root.querySelector('time, [class*="time"], [class*="date"]') as HTMLElement | null;
              const avatarElem = root.querySelector('img') as HTMLImageElement | null;
              const content = normalizeText(contentElem?.innerText || contentElem?.textContent || root.innerText || '');
              return {
                id: root.getAttribute('data-id') || `${index}`,
                userName: normalizeText(userElem?.innerText || userElem?.textContent || ''),
                avatar: avatarElem?.src || '',
                content,
                likeCount: parseCount(likeElem?.innerText || likeElem?.textContent || ''),
                replyCount: parseCount(replyElem?.innerText || replyElem?.textContent || ''),
                time: normalizeText(timeElem?.innerText || timeElem?.textContent || ''),
              };
            }).filter((item) => item.content);

            return {
              comments,
              totalFound: commentItems.length,
              bodyTextPreview: normalizeText(document.body.innerText || '').slice(0, 500),
            };
          }).toString(),
        });

        return unwrapEvalResult<{ comments: Array<Record<string, unknown>>; totalFound: number; bodyTextPreview: string }>(scrapeResp);
      };

      const readySnapshot = await waitForDetailReady();
      appendCommentDebugEntry({
        noteId,
        stage: 'response',
        message: '详情页 DOM 兜底页面状态',
        detail: readySnapshot ? JSON.stringify(readySnapshot) : 'detail page not ready',
      });

      let scrapeResult = await readCommentSnapshot();
      const firstPreview = scrapeResult.data?.bodyTextPreview || '';
      const shouldRetryShellPage = (
        (readySnapshot?.foundCount || 0) === 0 &&
        Array.isArray(scrapeResult.data?.comments) &&
        scrapeResult.data!.comments.length === 0 &&
        isShellPagePreview(firstPreview)
      );

      if (shouldRetryShellPage) {
        appendCommentDebugEntry({
          noteId,
          stage: 'request',
          message: '详情页疑似空壳页，准备执行一次轻量重试',
          detail: firstPreview.slice(0, 180),
        });
        await extension.invoke("chrome:tabs:update", {
          tabId: tempTabId!,
          updateProperties: { url: targetNoteUrl, active: false },
        });
        await new Promise((resolve) => setTimeout(resolve, 900));
        await waitForDetailReady();
        scrapeResult = await readCommentSnapshot();
      }

      const comments = Array.isArray(scrapeResult.data?.comments) ? scrapeResult.data?.comments || [] : [];
      appendCommentDebugEntry({
        noteId,
        stage: 'parse',
        message: `详情页 DOM 兜底解析 ${comments.length} 条评论`,
        detail: comments.length > 0
          ? JSON.stringify(comments[0]).slice(0, 200)
          : (scrapeResult.data?.bodyTextPreview || 'no comment content'),
      });
      return comments.map((comment) => ({
        id: comment.id,
        userName: comment.userName,
        avatar: comment.avatar,
        content: String(comment.content || ''),
        likeCount: String(comment.likeCount || '0'),
        replyCount: String(comment.replyCount || '0'),
        time: String(comment.time || ''),
      })).filter((comment) => comment.content.trim());
    } catch (error) {
      appendCommentDebugEntry({
        noteId,
        stage: 'error',
        message: '详情页 DOM 兜底也失败',
        detail: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      if (tempTabId !== undefined) {
        try {
          await extension.invoke("chrome:tabs:remove", { tabIds: [tempTabId] });
        } catch {}
      }
    }
  };

  const enrichCollectedNotes = useCallback(async (items: any[], workerTabId: number) => {
    const enrichedItems = items.map((item) => ({ ...item }));

    for (let i = 0; i < enrichedItems.length; i += 1) {
      if (abortRef.current) break;

      updateStatus('enriching', `正在补抓正文详情... (${i + 1}/${enrichedItems.length})`);
        const item = enrichedItems[i];
        if (item.id) {
          const token = item.xsec_token || item.note_card?.xsec_token || item.note_card?.xsecToken || item.note_card?.token || '';
          const detail = await fetchNoteDetail(item.id, token, item.noteUrl);
          if (detail) {
          enrichedItems[i] = applyFetchedDetailToNote(item, detail);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 220 + 120));
    }

    if (!abortRef.current && enableCommentsRef.current) {
      for (let i = 0; i < enrichedItems.length; i += 1) {
        if (abortRef.current) break;

        const item = enrichedItems[i];
        if (!item.id) continue;

        const commentTarget = resolveCommentEnrichment(item);
        const commentToken = commentTarget.token;
        if (!commentToken) {
          appendCommentDebugEntry({
            noteId: item.id,
            stage: 'skip',
            message: '未拿到 xsec_token，跳过评论补抓',
            detail: commentTarget.skipReason || 'skip comment enrichment because note has no xsec_token',
          });
          continue;
        }

        updateStatus('enriching', `正在补抓评论... (${i + 1}/${enrichedItems.length})`);
        const comments = await fetchNoteCommentsFromDetailDom(item.id, commentToken, item.noteUrl, maxCommentsPerNoteRef.current, workerTabId);
        if (comments.length > 0) {
          enrichedItems[i] = applyFetchedCommentsToNote(item, comments);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 900 + 500));
      }
    }

    return enrichedItems;
  }, [appendCommentDebugEntry, updateStatus]);

  // proxy network requests
  useEffect(() => {
    if (!extension || tab?.id === undefined || workerTab?.id === undefined) return;
    injectProxy(workerTab.id, tab.id);
  }, [extension, tab, workerTab]);

  // api hook listener
  useEffect(() => {
    const apihook = (event: Event & { detail?: SearchRequestDetail }) => {
      if (!event.detail) return;
      appendFilterDebugEntry({
        stage: 'request',
        message: '前端收到桥接请求',
        detail: `requestTraceId=${event.detail.requestTraceId || 'none'} | source=${event.detail.requestSource || 'unknown'} | url=${event.detail.url || 'none'} | method=${event.detail.method || 'unknown'}`,
      });
      if (!isSearchNotesRequest(event.detail.url)) {
        return;
      }
      const requestAt = Date.now();
      const requestIndex = ++filterRequestIndexRef.current;
      const filterCheck = requestMatchesFilters(event.detail.body, activeFiltersRef.current);
      lastObservedSearchRequestAtRef.current = requestAt;
      lastSearchRequestSnapshotRef.current = filterCheck.snapshot || '';
      const bufferedEvent: BufferedSearchEvent = {
        detail: event.detail,
        requestAt,
        requestIndex,
        filterCheck,
      };
      const gateDecision = decideSearchRequestGate({
        requiresPostFilterGuard: requiresPostFilterGuardRef.current,
        clickedAt: filterPostClickActivatedAtRef.current,
        requestAt,
        filterMatches: filterCheck.matches,
      });
      const isFilterWindowRequest = Boolean(
        requiresPostFilterGuardRef.current &&
        filterRequestCaptureStartedAtRef.current &&
        requestAt >= filterRequestCaptureStartedAtRef.current
      );
      if (isFilterWindowRequest) {
        requestObservedRef.current = true;
        if (filterCheck.matches) {
          requestMatchedRef.current = true;
        }
      }

      if (
        requiresPostFilterGuardRef.current &&
        filterRequestCaptureActiveRef.current &&
        filterRequestCaptureStartedAtRef.current &&
        requestAt >= filterRequestCaptureStartedAtRef.current
      ) {
        if (filterCheck.matches) {
          bufferedSearchEventsRef.current.push(bufferedEvent);
          updateCountDiagnostics({
            bufferedMatchedCount: bufferedSearchEventsRef.current.filter((item) => item.filterCheck.matches).length,
          });
          appendFilterDebugEntry({
            stage: 'request',
            message: '筛选窗口内捕获匹配请求，待最终确认后入队',
            detail: `requestTraceId=${event.detail.requestTraceId || 'none'} | requestIndex=${requestIndex} | requestAt=${requestAt} | ${filterCheck.snapshot || 'snapshot=none'}`,
          });
          return;
        }

        lastFilterMismatchReasonRef.current = filterCheck.reason || '请求未通过筛选校验';
        appendFilterDebugEntry({
          stage: 'request',
          message: '筛选窗口内捕获到不匹配请求',
          detail: `requestTraceId=${event.detail.requestTraceId || 'none'} | requestIndex=${requestIndex} | reason=${lastFilterMismatchReasonRef.current || 'unknown'} | ${filterCheck.snapshot || 'snapshot=none'}`,
        });
        return;
      }

      if (!gateDecision.accepted) {
        if (gateDecision.phase === 'pre_click' && filterCheck.matches) {
          bufferedSearchEventsRef.current.push(bufferedEvent);
          updateCountDiagnostics({
            bufferedMatchedCount: bufferedSearchEventsRef.current.filter((item) => item.filterCheck.matches).length,
          });
          appendFilterDebugEntry({
            stage: 'request',
            message: '点击前请求已缓冲',
            detail: `${gateDecision.reason} | ${filterCheck.snapshot || 'snapshot=none'} | requestIndex=${requestIndex}`,
          });
          return;
        }

        if (gateDecision.phase !== 'pre_click') {
          lastFilterMismatchReasonRef.current = filterCheck.reason || gateDecision.reason;
        }
        appendFilterDebugEntry({
          stage: 'request',
          message: gateDecision.phase === 'pre_click' ? '拦截到筛选点击前的搜索请求' : '拦截到筛选不匹配的搜索请求',
          detail: `${gateDecision.phase === 'pre_click' ? gateDecision.reason : (lastFilterMismatchReasonRef.current || gateDecision.reason)} | ${filterCheck.snapshot || 'snapshot=none'} | requestIndex=${requestIndex}`,
        });
        return;
      }

      lastMatchedSearchRequestAtRef.current = requestAt;
      lastFilterMismatchReasonRef.current = '';
      if (domFallbackUsedRef.current && requestBridgeFailureLoggedRef.current) {
        appendFilterDebugEntry({
          stage: 'request',
          message: '真实搜索请求已恢复，后续列表继续由请求主链接管',
          detail: `${filterCheck.snapshot || 'snapshot=none'} | requestIndex=${requestIndex}`,
        });
      }
      requestBridgeFailureLoggedRef.current = false;
      bufferedSearchEventsRef.current = [];
      appendFilterDebugEntry({
        stage: 'request',
        message: '拦截到符合条件的搜索请求',
        detail: `requestTraceId=${event.detail.requestTraceId || 'none'} | ${gateDecision.reason} | ${filterCheck.snapshot || 'snapshot=none'} | requestIndex=${requestIndex}`,
      });
      appendIncomingNotes(event.detail, requestAt);
    };
    document.addEventListener("xhs-api", apihook);
    return () => document.removeEventListener("xhs-api", apihook);
  }, [appendFilterDebugEntry, appendIncomingNotes, updateCountDiagnostics]);

  useEffect(() => {
    if (!extension) return;
    const onBridgeDebug = (params: { payload: Record<string, unknown> }) => {
      const payload = params?.payload as SearchBridgeDebugDetail | undefined;
      if (!payload) return;
      const detailText = [
        `requestTraceId=${payload.requestTraceId || 'none'}`,
        `source=${payload.requestSource || 'unknown'}`,
        `url=${payload.url || 'none'}`,
        `method=${payload.method || 'unknown'}`,
        payload.targetTabId !== undefined ? `targetTabId=${payload.targetTabId}` : '',
        payload.requestCapturedAt ? `capturedAt=${payload.requestCapturedAt}` : '',
        typeof payload.bridgeForwarded === 'boolean' ? `bridgeForwarded=${payload.bridgeForwarded ? 'true' : 'false'}` : '',
        payload.bridgeForwardError ? `bridgeForwardError=${payload.bridgeForwardError}` : '',
        payload.contentType ? `contentType=${payload.contentType}` : '',
        payload.reason ? `reason=${payload.reason}` : '',
        payload.bodySummary ? `bodySummary=${payload.bodySummary}` : '',
      ].filter(Boolean).join(' | ');
      const messageMap: Record<SearchBridgeDebugDetail['stage'], string> = {
        worker_bridge_ready: 'worker 桥接调试链已就绪',
        worker_raw_fetch_request: 'worker 原始 fetch.request',
        worker_raw_fetch_response: 'worker 原始 fetch.response',
        worker_raw_xhr_load: 'worker 原始 xhr.load',
        worker_request_seen: 'worker 看到疑似搜索请求',
        worker_capture: 'worker 捕获请求',
        worker_suspect_unmatched: 'worker 捕获到疑似搜索请求但未命中规则',
        worker_forward_success: 'worker 转发请求到前端成功',
        worker_forward_error: 'worker 转发请求到前端失败',
        frontend_receive: '前端桥接事件已分发',
        worker_hook_summary: 'worker hook 自检摘要',
      };
      appendFilterDebugEntry({
        stage: payload.stage === 'worker_forward_error' ? 'error' : 'request',
        message: messageMap[payload.stage],
        detail: detailText,
      });
    };
    extension.event.on('scraper:bridge-debug', onBridgeDebug);
    return () => extension.event.off('scraper:bridge-debug', onBridgeDebug);
  }, [appendFilterDebugEntry, extension]);

  // 提取注入代理的逻辑为复用函数
  const injectProxy = async (targetTabId: number, currentFrontendTabId: number): Promise<ProxyInstallResult | null> => {
    if (!extension) return null;
    const proxyCode = (name: string, tId: number) => {
      const ext = (window as any)[name];
      const hook = (window as any).__NETWORK_HOOK__;
      const pendingFetchRequests = (window as any).__XHS_PENDING_FETCH_REQUESTS__ || new Map();
      (window as any).__XHS_PENDING_FETCH_REQUESTS__ = pendingFetchRequests;
      const capturedMatchedRequests = (window as any).__XHS_CAPTURED_MATCHED_REQUESTS__ || [];
      (window as any).__XHS_CAPTURED_MATCHED_REQUESTS__ = capturedMatchedRequests;
      const earlyCapturedRequests = (window as any).__XHS_EARLY_CAPTURED_SEARCH_REQUESTS__ || [];
      if (Array.isArray(earlyCapturedRequests) && earlyCapturedRequests.length > 0) {
        const existingTraceIds = new Set(capturedMatchedRequests.map((item: any) => String(item?.requestTraceId || '')));
        earlyCapturedRequests.forEach((item: any) => {
          const traceId = String(item?.requestTraceId || '');
          if (traceId && existingTraceIds.has(traceId)) return;
          capturedMatchedRequests.push(item);
          if (traceId) existingTraceIds.add(traceId);
        });
        while (capturedMatchedRequests.length > 30) {
          capturedMatchedRequests.shift();
        }
      }
      const requestTraceState = (window as any).__XHS_SEARCH_REQUEST_TRACE_STATE__ || { current: 0 };
      (window as any).__XHS_SEARCH_REQUEST_TRACE_STATE__ = requestTraceState;
      const hookSeenState = (window as any).__XHS_SCRAPER_HOOK_SEEN_STATE__ || {
        fetchRequestCount: 0,
        fetchResponseCount: 0,
        xhrCount: 0,
        searchLikeSeenCount: 0,
        strictSearchMatchedCount: 0,
      };
      (window as any).__XHS_SCRAPER_HOOK_SEEN_STATE__ = hookSeenState;
      const buildProbe = () => {
        const diagnostics = (window as any).__XHS_MARKETING_EXTENSION_DIAGNOSTICS__ || {};
        return {
          url: window.location.href,
          readyState: document.readyState,
          extensionBridgeReady: Boolean(ext),
          networkHookReady: Boolean(hook),
          xhrHookReady: Boolean(hook?.xhr?.send?.on),
          fetchRequestHookReady: Boolean(hook?.fetch?.request?.on),
          fetchResponseHookReady: Boolean(hook?.fetch?.response?.on),
          registeredXhrHooks: Object.keys(hook?.xhr?.send?.hook || {}),
          registeredFetchRequestHooks: Object.keys(hook?.fetch?.request?.hook || {}),
          registeredFetchResponseHooks: Object.keys(hook?.fetch?.response?.hook || {}),
          diagnosticsStage: String(diagnostics.stage || ''),
        };
      };
      if (!ext) {
        return { ok: false, reason: 'extension_bridge_missing', probe: buildProbe() };
      }
      if (!hook?.xhr?.send?.on || !hook?.fetch?.response?.on) {
        return { ok: false, reason: 'network_hook_missing', probe: buildProbe() };
      }
      if (hook.xhr.send.hook["xhs-api"] && hook.fetch.request.hook["xhs-api-fetch-request"] && hook.fetch.response.hook["xhs-api-fetch"]) {
        return { ok: true, reason: 'already_registered', probe: buildProbe() };
      }
      const isSearchNotesRequest = (url: string, body?: any) => {
        const normalized = String(url || '').trim().toLowerCase();
        const hasSearchPath = (
          normalized.includes('/api/sns/web/v1/search/notes') ||
          normalized.includes('/api/sns/web/v2/search/notes') ||
          normalized.includes('/api/sns/web/search/notes') ||
          normalized.includes('/search/notes')
        );
        if (hasSearchPath) return true;
        if (!body || typeof body !== 'object') return false;
        const filters = Array.isArray(body.filters) ? body.filters : [];
        const filterTypes = filters.map((item: any) => String(item?.type || '').trim());
        const hasKeyword = Boolean(String(body.keyword || '').trim());
        const hasSearchFilters = (
          filterTypes.includes('filter_note_type') ||
          filterTypes.includes('filter_note_time') ||
          Object.prototype.hasOwnProperty.call(body, 'filter_note_type') ||
          Object.prototype.hasOwnProperty.call(body, 'filter_note_time')
        );
        return hasKeyword && hasSearchFilters;
      };
      const summarizeBody = (body: any) => {
        if (!body || typeof body !== 'object') return 'body=empty';
        const filters = Array.isArray(body.filters) ? body.filters : [];
        const filterTypes = filters
          .map((item: any) => String(item?.type || '').trim())
          .filter(Boolean);
        return [
          `keyword=${String(body.keyword || '').trim() || 'none'}`,
          `filterTypes=${filterTypes.join(',') || 'none'}`,
          `hasFilterNoteType=${Object.prototype.hasOwnProperty.call(body, 'filter_note_type') ? 'true' : 'false'}`,
          `hasFilterNoteTime=${Object.prototype.hasOwnProperty.call(body, 'filter_note_time') ? 'true' : 'false'}`,
        ].join(' | ');
      };
      const parseJsonSafe = (value: any, fallback: any) => {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'object') return value;
        try {
          return JSON.parse(String(value));
        } catch {
          return fallback;
        }
      };
      const normalizeRequestUrl = (input: any) => {
        if (typeof input === 'string') return input;
        if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
        if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
        return String(input || '');
      };
      const getRequestMethod = (input: any, init: any) => (
        String(
          init?.method
          || (typeof Request !== 'undefined' && input instanceof Request ? input.method : '')
          || 'GET'
        ).toUpperCase()
      );
      const buildFetchRequestKey = (url: string, method: string) => `${method}::${url}`;
      const extractRequestBody = async (input: any, init: any) => {
        if (init?.body !== undefined) {
          if (typeof init.body === 'string') {
            return parseJsonSafe(init.body, {});
          }
          if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
            return Object.fromEntries(init.body.entries());
          }
        }
        if (typeof Request !== 'undefined' && input instanceof Request) {
          try {
            const rawBody = await input.clone().text();
            return parseJsonSafe(rawBody, {});
          } catch {
            return {};
          }
        }
        return {};
      };

      const emitBridgeDebug = (detail: SearchBridgeDebugDetail) => {
        try {
          ext.event.emit('scraper:bridge-debug', detail as any);
        } catch (error: any) {
          console.warn('[Scraper] 桥接调试事件转发失败', {
            detail,
            reason: error instanceof Error ? error.message : String(error || 'unknown'),
          });
        }
      };

      const recordMatchedRequest = (detail: WorkerCapturedMatchedRequestState) => {
        capturedMatchedRequests.push(detail);
        while (capturedMatchedRequests.length > 30) {
          capturedMatchedRequests.shift();
        }
      };

      const emitToFrontend = (eventUrl: string, method: string, nextBody: any, resp: any, requestTraceId: string, requestCapturedAt: number) => {
        const event = (
          forwardUrl: string,
          forwardMethod: string,
          forwardBody: any,
          forwardResp: any,
          forwardTraceId: string,
          forwardCapturedAt: number,
        ) => {
          const ev = new CustomEvent("xhs-api", {
            detail: {
              url: forwardUrl,
              method: forwardMethod,
              body: forwardBody,
              resp: forwardResp,
              requestTraceId: forwardTraceId,
              requestCapturedAt: forwardCapturedAt,
              requestSource: forwardTraceId.startsWith('xhr-') ? 'xhr' : 'fetch_response',
              bridgeForwarded: true,
            },
          });
          document.dispatchEvent(ev);
        };
        ext.invoke("web:runtime:evaluate", {
          tabId: tId,
          args: [eventUrl, method, nextBody, resp, requestTraceId, requestCapturedAt],
          code: event.toString(),
        }).then(() => {
          emitBridgeDebug({
            stage: 'frontend_receive',
            requestTraceId,
            requestSource: requestTraceId.startsWith('xhr-') ? 'xhr' : 'fetch_response',
            url: eventUrl,
            method,
            targetTabId: tId,
            requestCapturedAt,
            bridgeForwarded: true,
          });
          emitBridgeDebug({
            stage: 'worker_forward_success',
            requestTraceId,
            requestSource: requestTraceId.startsWith('xhr-') ? 'xhr' : 'fetch_response',
            url: eventUrl,
            method,
            targetTabId: tId,
            requestCapturedAt,
            bridgeForwarded: true,
            bodySummary: summarizeBody(nextBody),
          });
        }).catch((error: any) => {
          emitBridgeDebug({
            stage: 'worker_forward_error',
            requestTraceId,
            requestSource: requestTraceId.startsWith('xhr-') ? 'xhr' : 'fetch_response',
            url: eventUrl,
            method,
            targetTabId: tId,
            requestCapturedAt,
            bridgeForwarded: false,
            bridgeForwardError: error instanceof Error ? error.message : String(error || 'unknown'),
            bodySummary: summarizeBody(nextBody),
          });
          console.error(error);
        });
      };

      ext.network.hook.fetch.request.on("xhs-api-fetch-request", async (input: RequestInfo | URL, init: RequestInit | undefined) => {
        const requestUrl = normalizeRequestUrl(input);
        const method = getRequestMethod(input, init);
        const body = await extractRequestBody(input, init);
        const requestCapturedAt = Date.now();
        hookSeenState.fetchRequestCount += 1;
        const looksSuspicious = requestUrl.toLowerCase().includes('/search') || (body && typeof body === 'object' && (body.keyword || body.filters || body.filter_note_type || body.filter_note_time));
        emitBridgeDebug({
          stage: 'worker_raw_fetch_request',
          requestTraceId: `fetch-request-raw-${hookSeenState.fetchRequestCount}`,
          requestSource: 'fetch_request',
          url: requestUrl,
          method,
          targetTabId: tId,
          requestCapturedAt,
          bodySummary: summarizeBody(body),
          hookSeenFetchRequestCount: hookSeenState.fetchRequestCount,
          hookSeenFetchResponseCount: hookSeenState.fetchResponseCount,
          hookSeenXhrCount: hookSeenState.xhrCount,
          searchLikeSeenCount: hookSeenState.searchLikeSeenCount,
          strictSearchMatchedCount: hookSeenState.strictSearchMatchedCount,
        });
        if (looksSuspicious) {
          hookSeenState.searchLikeSeenCount += 1;
          requestTraceState.current += 1;
          emitBridgeDebug({
            stage: 'worker_request_seen',
            requestTraceId: `fetch-req-${requestTraceState.current}`,
            requestSource: 'fetch_request',
            url: requestUrl,
            method,
            targetTabId: tId,
            requestCapturedAt,
            bodySummary: summarizeBody(body),
          });
        }
        if (!isSearchNotesRequest(requestUrl, body)) {
          if (looksSuspicious) {
            emitBridgeDebug({
              stage: 'worker_suspect_unmatched',
              requestTraceId: `fetch-unmatched-${requestCapturedAt}`,
              requestSource: 'fetch_request',
              url: requestUrl,
              method,
              targetTabId: tId,
              requestCapturedAt,
              reason: 'fetch.request 命中了疑似搜索请求，但未通过 notes 识别规则',
              bodySummary: summarizeBody(body),
            });
          }
          return;
        }
        hookSeenState.strictSearchMatchedCount += 1;
        pendingFetchRequests.set(buildFetchRequestKey(requestUrl, method), {
          body,
          method,
          updatedAt: Date.now(),
        });
      });

      ext.network.hook.xhr.send.on("xhs-api", (meta: any, xhr: XMLHttpRequest) => {
        xhr.addEventListener("load", () => {
          const url = meta.url.toString();
          const ctype = xhr.getResponseHeader("content-type") || "";
          const body = parseJsonSafe(meta.body?.toString?.() || meta.body, {});
          const requestCapturedAt = Date.now();
          hookSeenState.xhrCount += 1;
          const normalizedUrl = String(url || '').toLowerCase();
          const looksSuspicious = normalizedUrl.includes('/search') || (body && typeof body === 'object' && (body.keyword || body.filters || body.filter_note_type || body.filter_note_time));
          emitBridgeDebug({
            stage: 'worker_raw_xhr_load',
            requestTraceId: `xhr-raw-${hookSeenState.xhrCount}`,
            requestSource: 'xhr',
            url,
            method: meta.method,
            targetTabId: tId,
            requestCapturedAt,
            contentType: ctype || 'none',
            bodySummary: summarizeBody(body),
            hookSeenFetchRequestCount: hookSeenState.fetchRequestCount,
            hookSeenFetchResponseCount: hookSeenState.fetchResponseCount,
            hookSeenXhrCount: hookSeenState.xhrCount,
            searchLikeSeenCount: hookSeenState.searchLikeSeenCount,
            strictSearchMatchedCount: hookSeenState.strictSearchMatchedCount,
          });
          if (looksSuspicious) {
            hookSeenState.searchLikeSeenCount += 1;
            requestTraceState.current += 1;
            emitBridgeDebug({
              stage: 'worker_request_seen',
              requestTraceId: `xhr-seen-${requestTraceState.current}`,
              requestSource: 'xhr',
              url,
              method: meta.method,
              targetTabId: tId,
              requestCapturedAt,
              contentType: ctype || 'none',
              bodySummary: summarizeBody(body),
            });
          }
          if (!isSearchNotesRequest(url, body)) {
            if (looksSuspicious) {
              emitBridgeDebug({
                stage: 'worker_suspect_unmatched',
                requestSource: 'xhr',
                url,
                method: meta.method,
                targetTabId: tId,
                requestCapturedAt,
                contentType: ctype || 'none',
                reason: 'xhr 命中了疑似搜索请求，但未通过 notes 识别规则',
                bodySummary: summarizeBody(body),
              });
            }
            return;
          }
          hookSeenState.strictSearchMatchedCount += 1;
          if (!ctype.includes("application/json")) return;
          const responseData = parseJsonSafe(xhr.responseText, null);
          if (responseData === null) return;
          requestTraceState.current += 1;
          const requestTraceId = `xhr-${requestTraceState.current}`;
          console.log('[Scraper] worker 侧捕获搜索请求', url, meta.body?.toString?.() || meta.body, { requestTraceId, requestCapturedAt });
          recordMatchedRequest({
            url,
            method: meta.method,
            body,
            resp: responseData,
            requestTraceId,
            requestCapturedAt,
            requestSource: 'xhr',
            bridgeForwarded: false,
          });
          emitBridgeDebug({
            stage: 'worker_capture',
            requestTraceId,
            requestSource: 'xhr',
            url,
            method: meta.method,
            targetTabId: tId,
            requestCapturedAt,
            contentType: ctype || 'none',
            bodySummary: summarizeBody(body),
          });
          emitToFrontend(url, meta.method, body, responseData, requestTraceId, requestCapturedAt);
        });
      });

      ext.network.hook.fetch.response.on("xhs-api-fetch", async (input: RequestInfo | URL, init: RequestInit | undefined, response: Response) => {
        const requestUrl = normalizeRequestUrl(input);
        const ctype = response.headers.get("content-type") || "";
        const method = getRequestMethod(input, init);
        const requestKey = buildFetchRequestKey(requestUrl, method);
        const cachedRequest = pendingFetchRequests.get(requestKey);
        const body = cachedRequest?.body ?? await extractRequestBody(input, init);
        const requestCapturedAt = Date.now();
        hookSeenState.fetchResponseCount += 1;
        const normalizedUrl = String(requestUrl || '').toLowerCase();
        const looksSuspicious = normalizedUrl.includes('/search') || (body && typeof body === 'object' && (body.keyword || body.filters || body.filter_note_type || body.filter_note_time));
        emitBridgeDebug({
          stage: 'worker_raw_fetch_response',
          requestTraceId: `fetch-response-raw-${hookSeenState.fetchResponseCount}`,
          requestSource: 'fetch_response',
          url: requestUrl,
          method,
          targetTabId: tId,
          requestCapturedAt,
          contentType: ctype || 'none',
          bodySummary: summarizeBody(body),
          hookSeenFetchRequestCount: hookSeenState.fetchRequestCount,
          hookSeenFetchResponseCount: hookSeenState.fetchResponseCount,
          hookSeenXhrCount: hookSeenState.xhrCount,
          searchLikeSeenCount: hookSeenState.searchLikeSeenCount,
          strictSearchMatchedCount: hookSeenState.strictSearchMatchedCount,
        });
        if (looksSuspicious) {
          hookSeenState.searchLikeSeenCount += 1;
          requestTraceState.current += 1;
          emitBridgeDebug({
            stage: 'worker_request_seen',
            requestTraceId: `fetch-seen-${requestTraceState.current}`,
            requestSource: 'fetch_response',
            url: requestUrl,
            method,
            targetTabId: tId,
            requestCapturedAt,
            contentType: ctype || 'none',
            bodySummary: summarizeBody(body),
          });
        }
        if (!isSearchNotesRequest(requestUrl, body)) {
          if (looksSuspicious) {
            emitBridgeDebug({
              stage: 'worker_suspect_unmatched',
              requestSource: 'fetch_response',
              url: requestUrl,
              method,
              targetTabId: tId,
              requestCapturedAt,
              contentType: ctype || 'none',
              reason: 'fetch.response 命中了疑似搜索请求，但未通过 notes 识别规则',
              bodySummary: summarizeBody(body),
            });
          }
          pendingFetchRequests.delete(requestKey);
          return;
        }
        hookSeenState.strictSearchMatchedCount += 1;
        if (!ctype.includes("application/json")) {
          pendingFetchRequests.delete(requestKey);
          return;
        }

        try {
          const responseData = await response.clone().json();
          requestTraceState.current += 1;
          const requestTraceId = `fetch-${requestTraceState.current}`;
          console.log('[Scraper] worker 侧捕获 fetch 搜索请求', requestUrl, body, { requestTraceId, requestCapturedAt });
          recordMatchedRequest({
            url: requestUrl,
            method,
            body,
            resp: responseData,
            requestTraceId,
            requestCapturedAt,
            requestSource: 'fetch_response',
            bridgeForwarded: false,
          });
          emitBridgeDebug({
            stage: 'worker_capture',
            requestTraceId,
            requestSource: 'fetch_response',
            url: requestUrl,
            method,
            targetTabId: tId,
            requestCapturedAt,
            contentType: ctype || 'none',
            bodySummary: summarizeBody(body),
          });
          emitToFrontend(
            requestUrl,
            method,
            body,
            responseData,
            requestTraceId,
            requestCapturedAt,
          );
        } catch (error) {
          console.warn('[Scraper] fetch 搜索请求解析失败', error);
        } finally {
          pendingFetchRequests.delete(requestKey);
        }
      });

      emitBridgeDebug({
        stage: 'worker_bridge_ready',
        requestTraceId: 'bridge-ready',
        requestSource: 'unknown',
        targetTabId: tId,
        requestCapturedAt: Date.now(),
        reason: 'worker 已完成请求桥和调试桥注册',
      });

      return { ok: true, reason: 'registered', probe: buildProbe() };
    };
    const response = await extension.invoke("web:runtime:evaluate", {
      tabId: targetTabId,
      args: [extension.name, currentFrontendTabId],
      code: proxyCode.toString(),
    }).catch(console.error);
    const result = unwrapEvalResult<ProxyInstallResult>(response);
    return result.success ? result.data : null;
  };

  // Set search value and click (完全还原原版插件逻辑)
  const executeSearch = async (keyword: string, filters: SearchFilters, tabId: number, currentFrontendTabId: number) => {
    if (!extension || !tabId) return;

    console.log(`[Scraper] 开始执行搜索流程: keyword=${keyword}, filters=${createFilterSignature(filters)}`);
    updateStatus('searching', '正在打开采集页并准备搜索...');

    // 1. 确保页面初步加载 (最多等 5 秒，不要死等 complete，因为有些页面会有长连接导致永远 loading)
    const pageReadyTries = Math.ceil(STAGE_TIMEOUTS.pageReadyMs / 500);
    for (let i = 0; i < pageReadyTries; i++) {
      try {
        const currentTab = await extension.invoke("chrome:tabs:get", { tabId: tabId });
        if (currentTab.status === 'complete') break;
      } catch (e) { }
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 1500));

    const navigateToSearchResult = (kw: string) => {
      const target = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}&source=web_search_result_notes`;
      window.location.href = target;
      return { target };
    };

    const inspectSearchResult = (): SearchResultSnapshot => {
      const visibleFilterEntry = Boolean(
        document.querySelector('div.filter') ||
        Array.from(document.querySelectorAll('button,div')).some((node) => {
          const element = node as HTMLElement;
          const text = (element.textContent || '').trim();
          return text.includes('筛选') && element.offsetHeight > 0;
        })
      );

      return {
        url: window.location.href,
        hasResultUrl: window.location.href.includes('search_result'),
        hasNoteItem: Boolean(document.querySelector('.note-item')),
        hasFilterEntry: visibleFilterEntry,
        hasFilterPanel: Boolean(document.querySelector('div.filter-panel')),
        searchInputPresent: Boolean(document.querySelector('#search-input')),
        searchIconPresent: Boolean(document.querySelector('.search-icon')),
      };
    };

    const waitForSearchResultPage = async (
      startedAt: number,
      baselineRequestAt: number
    ) => {
      let isReady = false;
      let lastSnapshot: SearchResultSnapshot | null = null;
      let baselineSnapshot: SearchResultSnapshot | null = null;
      let evalError = '';

      try {
        const baselineResp = await extension.invoke("web:runtime:evaluate", { tabId: tabId, args: [], code: inspectSearchResult.toString() });
        const baselineResult = unwrapEvalResult<SearchResultSnapshot>(baselineResp);
        if (baselineResult.success && baselineResult.data) {
          baselineSnapshot = baselineResult.data;
        }
      } catch (e: any) {
        evalError = e?.message || String(e);
      }

      const resultPageTries = Math.ceil(STAGE_TIMEOUTS.searchResultMs / 500);
      for (let i = 0; i < resultPageTries; i++) {
        try {
          const resp = await extension.invoke("web:runtime:evaluate", { tabId: tabId, args: [], code: inspectSearchResult.toString() });
          const result = unwrapEvalResult<SearchResultSnapshot>(resp);
          if (!result.success || !result.data) {
            evalError = result.message || '页面状态检测失败';
          } else {
            lastSnapshot = result.data;
            evalError = '';
          }
          const sawNewSearchRequest =
            lastObservedSearchRequestAtRef.current > baselineRequestAt &&
            lastObservedSearchRequestAtRef.current >= startedAt;
          const switchedIntoSearchSurface = Boolean(
            result.data?.hasResultUrl ||
            sawNewSearchRequest ||
            (result.data?.hasFilterEntry && !baselineSnapshot?.hasFilterEntry) ||
            (result.data?.hasFilterPanel && !baselineSnapshot?.hasFilterPanel)
          );
          if (switchedIntoSearchSurface) {
            isReady = true;
            break;
          }
        } catch (e: any) {
          evalError = e?.message || String(e);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      return {
        isReady,
        lastSnapshot,
        baselineSnapshot,
        evalError,
        searchRequestObserved:
          lastObservedSearchRequestAtRef.current > baselineRequestAt &&
          lastObservedSearchRequestAtRef.current >= startedAt,
      };
    };

    const requiresPostFilterGuard = hasActiveFilterOverrides(filters);
    requiresPostFilterGuardRef.current = requiresPostFilterGuard;
    filterPostClickActivatedAtRef.current = null;

    let searchSurface: Awaited<ReturnType<typeof waitForSearchResultPage>> | null = null;
    let detachDebuggerIfNeeded: (() => Promise<void>) | null = null;
    let searchCaptureStartedAt = Date.now();

    // 2. 原版插件的输入逻辑
    const setsearchvalue = (kw: string) => {
      const searchInput = document.querySelector("#search-input") as HTMLInputElement | null;
      if (!searchInput) return { status: "NOT_FOUND" };

      searchInput.focus();
      const prototype = Object.getPrototypeOf(searchInput);
      const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(searchInput, kw);
      } else {
        searchInput.value = kw;
      }

      searchInput.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: kw,
        inputType: "insertText",
      }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      return { status: "SUCCESS", value: searchInput.value };
    };

    // 3. 原版插件的点击逻辑
    const clicksearch = () => {
      const icon = document.querySelector(".search-icon") as HTMLElement | null;
      const searchInput = document.querySelector("#search-input") as HTMLInputElement | null;
      if (!searchInput && !icon) return { status: "NOT_FOUND", inputValue: "" };

      const clickElement = (target: HTMLElement | null) => {
        if (!target) return false;
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        target.click();
        return true;
      };

      const isClickable = (element: HTMLElement | null) => {
        if (!element) return false;
        const computed = window.getComputedStyle(element);
        return (
          element.tagName === 'BUTTON' ||
          element.getAttribute('role') === 'button' ||
          computed.cursor === 'pointer' ||
          Boolean(element.onclick)
        );
      };

      const resolveClickTarget = () => {
        const candidates: Array<HTMLElement | null> = [];
        if (icon) {
          candidates.push(
            icon.closest('button') as HTMLElement | null,
            icon.closest('[role="button"]') as HTMLElement | null,
            icon.parentElement,
            icon.parentElement?.parentElement || null
          );
        }
        if (searchInput) {
          candidates.push(
            searchInput.nextElementSibling as HTMLElement | null,
            searchInput.parentElement?.nextElementSibling as HTMLElement | null,
            searchInput.parentElement,
            searchInput.parentElement?.parentElement || null
          );
        }

        for (const candidate of candidates) {
          if (isClickable(candidate)) {
            return candidate;
          }
        }

        return candidates.find(Boolean) || null;
      };

      const clickByGeometry = () => {
        if (!searchInput) return null;
        const rect = searchInput.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 4, Math.round(rect.right + 28));
        const y = Math.round(rect.top + rect.height / 2);
        const hit = document.elementFromPoint(x, y) as HTMLElement | null;
        if (!hit) return null;
        const target =
          (hit.closest('button') as HTMLElement | null) ||
          (hit.closest('[role="button"]') as HTMLElement | null) ||
          hit;
        clickElement(target);
        return {
          tag: target.tagName,
          className: target.className || '',
          hitTag: hit.tagName,
          hitClassName: hit.className || '',
          x,
          y,
        };
      };

      let triggeredByEnter = false;
      if (searchInput) {
        searchInput.focus();
        const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        const enterPress = new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
        triggeredByEnter =
          searchInput.dispatchEvent(enterDown) ||
          searchInput.dispatchEvent(enterPress) ||
          searchInput.dispatchEvent(enterUp);

        const form = searchInput.closest('form') as HTMLFormElement | null;
        if (form) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        }
      }

      const clickTarget = resolveClickTarget();
      const clicked = clickElement(clickTarget);
      const geometryHit = !clicked ? clickByGeometry() : null;

      if (!icon) {
        return {
          status: "SUCCESS",
          inputValue: searchInput?.value || "",
          targetTag: clickTarget?.tagName || searchInput?.tagName || "",
          targetClass: clickTarget?.className || searchInput?.className || "",
          triggeredByEnter,
          geometryHit,
        };
      }

      return {
        status: "SUCCESS",
        inputValue: searchInput?.value || "",
        targetTag: clickTarget?.tagName || "",
        targetClass: clickTarget?.className || "",
        triggeredByEnter,
        geometryHit,
      };
    };

    let lastClickSnapshot: SearchClickSnapshot | null = null;
    if (!searchSurface?.isReady) {
      appendFilterDebugEntry({
        stage: 'search',
        message: '准备直达搜索结果页',
        detail: `strategy=direct_navigate_primary | keyword=${keyword} | currentUrl=unknown`,
      });
      updateStatus('searching', '正在直接打开搜索结果页...');
      const directNavigateStartedAt = Date.now();
      searchCaptureStartedAt = directNavigateStartedAt;
      const searchRequestBaseline = lastObservedSearchRequestAtRef.current;
      await extension.invoke("web:runtime:evaluate", {
        tabId: tabId,
        args: [keyword],
        code: navigateToSearchResult.toString(),
      });
      await new Promise(r => setTimeout(r, 1200));
      searchSurface = await waitForSearchResultPage(directNavigateStartedAt, searchRequestBaseline);
      if (searchSurface.isReady) {
        appendFilterDebugEntry({
          stage: 'search',
          message: '直达搜索结果页成功',
          detail: `strategy=direct_navigate_primary | url=${searchSurface.lastSnapshot?.url || 'unknown'} | searchRequestObserved=${searchSurface.searchRequestObserved ? 'true' : 'false'}`,
        });
      } else {
        appendFilterDebugEntry({
          stage: 'search',
          message: '直达搜索结果页未稳定命中，准备按钮兜底',
          detail: `strategy=direct_navigate_primary | baseline=${formatSearchSnapshot(searchSurface.baselineSnapshot)} | last=${formatSearchSnapshot(searchSurface.lastSnapshot)} | searchRequestObserved=${searchSurface.searchRequestObserved ? 'true' : 'false'} | evalError=${searchSurface.evalError || 'none'}`,
        });
      }
    }

    if (!searchSurface?.isReady) {
      // 按照原版的顺序依次执行（增加重试确保输入框存在，最多重试 15 次 = 7.5秒）
      let searchInputSuccess = false;
      const searchInputTries = Math.ceil(STAGE_TIMEOUTS.searchInputMs / 500);
      for (let i = 0; i < searchInputTries; i++) {
        try {
          const resp = await extension.invoke("web:runtime:evaluate", { tabId: tabId, args: [keyword], code: setsearchvalue.toString() });
          const result = unwrapEvalResult<{ status: string; value?: string }>(resp);
          if (result.success && result.data?.status === "SUCCESS") {
            searchInputSuccess = true;
            console.log("[Scraper] 成功输入关键词");
            break;
          }
        } catch (e) { }
        await new Promise(r => setTimeout(r, 500));
      }

      if (!searchInputSuccess) {
        console.error("[Scraper] 无法找到搜索输入框，可能页面未加载完成或被封控");
        throw new Error('搜索输入框准备超时');
      }

      await new Promise(r => setTimeout(r, 600));

      let clickSuccess = false;
      const searchClickTries = Math.ceil(STAGE_TIMEOUTS.searchClickMs / 500);
      for (let i = 0; i < searchClickTries; i++) {
        try {
          const resp = await extension.invoke("web:runtime:evaluate", { tabId: tabId, args: [], code: clicksearch.toString() });
          const result = unwrapEvalResult<SearchClickSnapshot & { triggeredByEnter?: boolean }>(resp);
          if (result.data) {
            lastClickSnapshot = result.data;
          }
          if (result.success && result.data?.status === "SUCCESS") {
            clickSuccess = true;
            console.log("[Scraper] 成功点击搜索按钮");
            break;
          }
        } catch (e) { }
        await new Promise(r => setTimeout(r, 500));
      }

      if (!clickSuccess) {
        console.error("[Scraper] 无法找到搜索按钮");
        throw new Error('搜索按钮点击超时');
      }

      appendFilterDebugEntry({
        stage: 'search',
        message: '搜索按钮兜底已触发',
        detail: `strategy=button_fallback | inputValue=${lastClickSnapshot?.inputValue || keyword} | targetTag=${lastClickSnapshot?.targetTag || 'none'} | targetClass=${lastClickSnapshot?.targetClass || 'none'}`,
      });
      updateStatus('searching', '正在等待搜索结果页...');
      const searchClickStartedAt = Date.now();
      searchCaptureStartedAt = searchClickStartedAt;
      const searchRequestBaseline = lastObservedSearchRequestAtRef.current;
      searchSurface = await waitForSearchResultPage(searchClickStartedAt, searchRequestBaseline);

      if (!searchSurface.isReady) {
        appendFilterDebugEntry({
          stage: 'search',
          message: '搜索按钮兜底未稳定命中结果页',
          detail: `strategy=button_fallback | baseline=${formatSearchSnapshot(searchSurface.baselineSnapshot)} | last=${formatSearchSnapshot(searchSurface.lastSnapshot)} | searchRequestObserved=${searchSurface.searchRequestObserved ? 'true' : 'false'} | evalError=${searchSurface.evalError || 'none'}`,
        });
      }
    }

    if (!searchSurface?.isReady) {
      const diagnostics = [
        `baseline=${formatSearchSnapshot(searchSurface?.baselineSnapshot)}`,
        `last=${formatSearchSnapshot(searchSurface?.lastSnapshot)}`,
        `searchRequestObserved=${searchSurface?.searchRequestObserved}`,
      ];
      if (lastClickSnapshot) {
        diagnostics.push(
          `click=inputValue=${lastClickSnapshot.inputValue || ''}, targetTag=${lastClickSnapshot.targetTag || ''}, targetClass=${lastClickSnapshot.targetClass || ''}`
        );
      }
      if (searchSurface?.evalError) {
        diagnostics.push(`evalError=${searchSurface.evalError}`);
      }
      throw new Error(`搜索结果页跳转超时 (${diagnostics.join('; ')})`);
    }

    // 搜索结果页发生过导航后，主世界注入会丢失，这里需要在结果页重新注入一次请求代理。
    await ensureProxyReady(tabId, currentFrontendTabId, '搜索结果页导航后');
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (!requiresPostFilterGuard && !requestCommittedRef.current) {
      const earlyCapturedRequests = await readWorkerCapturedMatchedRequests(tabId, searchCaptureStartedAt);
      let recoveredCommittedCount = 0;
      const recoveredTraceIds: string[] = [];
      earlyCapturedRequests.forEach((detail, index) => {
        if (index >= collectionTargetRef.current) return;
        requestObservedRef.current = true;
        requestMatchedRef.current = true;
        lastObservedSearchRequestAtRef.current = Math.max(lastObservedSearchRequestAtRef.current, detail.requestCapturedAt || 0);
        const committed = appendIncomingNotes(detail, detail.requestCapturedAt || Date.now());
        if (committed.queueAccepted) {
          recoveredCommittedCount += 1;
        }
        if (detail.requestTraceId) {
          recoveredTraceIds.push(detail.requestTraceId);
        }
      });
      if (earlyCapturedRequests.length > 0) {
        releasedBufferedRequestCountRef.current += recoveredCommittedCount;
        updateCountDiagnostics({
          releasedIntoDataCount: releasedBufferedRequestCountRef.current,
        });
        appendFilterDebugEntry({
          stage: 'request',
          message: '恢复导航早期搜索请求',
          detail: `capturedAfter=${searchCaptureStartedAt} | pulledCount=${earlyCapturedRequests.length} | committedCount=${recoveredCommittedCount} | requestTraceIds=${recoveredTraceIds.join(',') || 'none'}`,
        });
      }
    }

    const waitForFilterEntryReady = async () => {
      const inspectFilterEntry = () => {
        const isStandaloneTriggerText = (value: string) => {
          const text = String(value || '').replace(/\s+/g, ' ').trim();
          if (!text) return false;
          const compact = text.replace(/\s+/g, '');
          if (!text.includes('筛选') && compact !== '已筛选') return false;
          const noisyKeywords = ['排序依据', '笔记类型', '发布时间', '搜索范围', '位置距离', '重置', '收起'];
          return !noisyKeywords.some((keyword) => text.includes(keyword));
        };
        const trigger = document.querySelector('div.filter') || Array.from(document.querySelectorAll('button,div,span')).find((node) => {
          const element = node as HTMLElement;
          const text = (element.textContent || '').trim();
          return isStandaloneTriggerText(text) && element.offsetHeight > 0;
        });
        return {
          url: window.location.href,
          readyState: document.readyState,
          hasFilterEntry: Boolean(trigger),
          triggerText: (trigger as HTMLElement | null)?.innerText || (trigger as HTMLElement | null)?.textContent || '',
          title: document.title,
        };
      };

      const tries = Math.ceil(STAGE_TIMEOUTS.filterPanelMs / 200);
      let lastMessage = '';
      let lastState: { url: string; readyState: string; hasFilterEntry: boolean; triggerText: string; title: string } | null = null;
      for (let i = 0; i < tries; i++) {
        try {
          const resp = await extension.invoke("web:runtime:evaluate", { tabId: tabId, args: [], code: inspectFilterEntry.toString() });
          const result = unwrapEvalResult<{ url: string; readyState: string; hasFilterEntry: boolean; triggerText: string; title: string }>(resp);
          if (result.success && result.data) {
            lastState = result.data;
            if (result.data.hasFilterEntry) {
              return result.data;
            }
          } else {
            lastMessage = result.message || '筛选入口状态检测失败';
          }
        } catch (error: any) {
          lastMessage = error?.message || String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`筛选入口未就绪: ${lastMessage || JSON.stringify(lastState || {})}`);
    };

    if (!requiresPostFilterGuard) {
      console.log("[Scraper] 当前筛选为默认值，跳过筛选面板交互");
      updateStatus('collecting', `正在采集列表... (${dataRef.current.length}/${requestedNotesRef.current})`);
      return;
    }

    const filterCapability = await probeInteractiveFilterSupport(extension);
    appendFilterDebugEntry({
      stage: 'capability',
      message: '筛选能力探测结果',
      detail: `extension=${extension.name || 'unknown'} | supported=${filterCapability.supported} | reason=${filterCapability.reason || 'ok'}`,
    });

    updateStatus('searching', '正在等待筛选入口加载...');
    const filterEntryState = await waitForFilterEntryReady();

    const waitForPostFilterResultSurface = async (
      baselineUrl: string,
      baselineObservedRequestAt: number,
      baselineMatchedRequestAt: number,
    ) => {
      const inspectPostFilterSurface = () => {
        const currentUrl = window.location.href;
        let typeParam = '';
        let keywordParam = '';
        try {
          const url = new URL(currentUrl);
          typeParam = url.searchParams.get('type') || '';
          keywordParam = url.searchParams.get('keyword') || '';
        } catch {
          typeParam = '';
          keywordParam = '';
        }
        const bodyText = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        const emptyTextMatch = bodyText.match(/没有找到相关内容|暂无相关内容|未找到相关内容|没有更多相关内容|换个关键词试试|未找到笔记|暂无结果/);
        return {
          url: currentUrl,
          readyState: document.readyState,
          hasNoteItem: Boolean(document.querySelector('.note-item')),
          noteCount: document.querySelectorAll('.note-item').length,
          typeParam,
          keywordParam,
          panelOpen: Boolean(document.querySelector('div.filter-panel')),
          emptyStateText: emptyTextMatch?.[0] || '',
        };
      };

      let lastState: FilterRecoverySnapshot | null = null;
      let sawNavigationLikeTransition = false;
      const tries = Math.ceil(STAGE_TIMEOUTS.filterApplyMs / 250);
      for (let i = 0; i < tries; i++) {
        try {
          const resp = await extension.invoke("web:runtime:evaluate", {
            tabId: tabId,
            args: [],
            code: inspectPostFilterSurface.toString(),
          });
          const result = unwrapEvalResult<FilterRecoverySnapshot>(resp);
          if (result.success && result.data) {
            lastState = result.data;
            if (result.data.url !== baselineUrl || result.data.readyState !== 'complete') {
              sawNavigationLikeTransition = true;
            }
            const recoveryState = classifyFilterRecoveryState(result.data);
            const observedAdvanced = lastObservedSearchRequestAtRef.current > baselineObservedRequestAt;
            const matchedAdvanced = lastMatchedSearchRequestAtRef.current > baselineMatchedRequestAt;
            if (recoveryState !== 'pending') {
              return {
                ...result.data,
                navigated: sawNavigationLikeTransition || result.data.url !== baselineUrl,
                recoveryState,
                observedAdvanced,
                matchedAdvanced,
              };
            }
            if ((observedAdvanced || matchedAdvanced) && result.data.readyState !== 'complete') {
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      return lastState
        ? {
            ...lastState,
            navigated: sawNavigationLikeTransition || lastState.url !== baselineUrl,
            recoveryState: classifyFilterRecoveryState(lastState),
            observedAdvanced: lastObservedSearchRequestAtRef.current > baselineObservedRequestAt,
            matchedAdvanced: lastMatchedSearchRequestAtRef.current > baselineMatchedRequestAt,
          }
        : {
            url: baselineUrl,
            readyState: 'unknown',
            hasNoteItem: false,
            noteCount: 0,
            typeParam: '',
            keywordParam: '',
            panelOpen: false,
            emptyStateText: '',
            navigated: false,
            recoveryState: 'pending' as const,
            observedAdvanced: lastObservedSearchRequestAtRef.current > baselineObservedRequestAt,
            matchedAdvanced: lastMatchedSearchRequestAtRef.current > baselineMatchedRequestAt,
          };
    };

    console.log("[Scraper] 开始应用完整筛选");
    updateStatus('filtering', '正在应用筛选条件...');
    try {
      type FilterGeometry = {
        x: number;
        y: number;
        width: number;
        height: number;
        selector: string;
        text: string;
      };
      type FilterCandidateState = { text: string; selected: boolean };
      type FilterGroupState = {
        index: number;
        title: string;
        candidates: FilterCandidateState[];
      };
      type FilterProbeState = {
        panelOpen: boolean;
        groupCount: number;
        groups: FilterGroupState[];
        trigger: FilterGeometry | null;
        target: FilterGeometry | null;
        targetGroup: FilterGroupState | null;
        resolvedCandidates?: ResolvedFilterCandidate[];
      };
      type FilterNodeClickResult = {
        ok: boolean;
        reason?: string;
        targetText?: string;
        targetSelector?: string;
        hitTag?: string;
        hitText?: string;
        hitMatchesTarget: boolean;
      };

      const debuggerTarget = { tabId };
      let debuggerAttachedByFlow = false;
      let clickMode: 'debugger' | 'dispatch' | 'dom' = 'debugger';
      let lastDebuggerError = '';
      let lastDispatchError = '';
      let lastDomError = '';

      const logClickModeFallback = (from: string, to: typeof clickMode, error?: unknown) => {
        const detail = [
          `from=${from}`,
          `to=${to}`,
          `reason=${error instanceof Error ? error.message : String(error || 'unknown')}`,
        ].join(' | ');
        appendFilterDebugEntry({
          stage: 'click',
          message: '筛选点击链路已降级',
          detail,
        });
      };

      const logDebuggerLifecycle = (
        message: string,
        detail: string,
        stage: FilterDebugEntry['stage'] = 'debugger',
      ) => {
        appendFilterDebugEntry({
          stage,
          message,
          detail,
        });
      };

      const ensureDebuggerAttached = async () => {
        if (debuggerAttachedByFlow) return;
        logDebuggerLifecycle('debugger attach start', `tabId=${tabId} | clickMode=${clickMode}`);
        try {
          await extension.invoke("chrome:debugger:attach", {
            target: debuggerTarget,
            requiredVersion: "1.3",
          });
          debuggerAttachedByFlow = true;
          logDebuggerLifecycle('debugger attach success', `tabId=${tabId} | clickMode=${clickMode}`);
        } catch (error) {
          lastDebuggerError = error instanceof Error ? error.message : String(error || 'unknown');
          logDebuggerLifecycle('debugger attach fail', `tabId=${tabId} | clickMode=${clickMode} | reason=${lastDebuggerError}`);
          throw error;
        }
      };

      detachDebuggerIfNeeded = async () => {
        if (!debuggerAttachedByFlow) return;
        logDebuggerLifecycle('debugger detach start', `tabId=${tabId} | clickMode=${clickMode}`);
        debuggerAttachedByFlow = false;
        try {
          await extension.invoke("chrome:debugger:detach", debuggerTarget);
          logDebuggerLifecycle('debugger detach success', `tabId=${tabId} | clickMode=${clickMode}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error || 'unknown');
          logDebuggerLifecycle('debugger detach fail', `tabId=${tabId} | clickMode=${clickMode} | reason=${reason}`);
          throw error;
        }
      };

      const sendMouseEvent = async (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number) => {
        await ensureDebuggerAttached();
        await extension.invoke("chrome:debugger:sendCommand", {
          target: debuggerTarget,
          method: "Input.dispatchMouseEvent",
          commandParams: {
            type,
            x,
            y,
            button: "left",
            buttons: type === "mouseReleased" ? 0 : 1,
            clickCount: type === "mouseMoved" ? 0 : 1,
          },
        });
      };

      const runDomPointerAction = async (action: 'hover' | 'click', x: number, y: number) => {
        const resp = await extension.invoke("web:runtime:evaluate", {
          tabId,
          args: [action, x, y],
          code: ((mode: 'hover' | 'click', pointX: number, pointY: number) => {
            const hit = document.elementFromPoint(pointX, pointY) as HTMLElement | null;
            const target = (
              (hit?.closest('button') as HTMLElement | null) ||
              (hit?.closest('[role="button"]') as HTMLElement | null) ||
              hit
            );
            if (!target) {
              return {
                ok: false,
                reason: 'no-target',
              };
            }

            if (mode === 'hover') {
              target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
              target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
              target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
            } else {
              target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
              target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
              target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
              target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
              target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
              target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              target.click?.();
            }

            return {
              ok: true,
              tagName: target.tagName,
              className: String(target.className || ''),
              text: String(target.innerText || target.textContent || '').trim(),
            };
          }).toString(),
        });
        return unwrapEvalResult<{ ok: boolean; reason?: string; tagName?: string; className?: string; text?: string }>(resp);
      };

      const inspectPointTarget = async (x: number, y: number) => {
        const resp = await extension.invoke("web:runtime:evaluate", {
          tabId,
          args: [x, y],
          code: ((pointX: number, pointY: number) => {
            const hit = document.elementFromPoint(pointX, pointY) as HTMLElement | null;
            const target = (
              (hit?.closest('button') as HTMLElement | null) ||
              (hit?.closest('[role="button"]') as HTMLElement | null) ||
              hit
            );
            if (!target) {
              return {
                ok: false,
                reason: 'no-target',
              };
            }
            return {
              ok: true,
              tagName: target.tagName,
              className: String(target.className || ''),
              text: String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim(),
            };
          }).toString(),
        });
        return unwrapEvalResult<{ ok: boolean; reason?: string; tagName?: string; className?: string; text?: string }>(resp);
      };

      const readFilterStateWithSnapshot = async (params?: {
        groupKey?: keyof SearchFilters;
        expectedTexts?: string[];
      }) => {
        try {
          return await readFilterState(params);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error || 'unknown');
          appendFilterDebugEntry({
            stage: 'error',
            message: '读取筛选状态失败',
            detail: `groupKey=${params?.groupKey || 'none'} | expectedTexts=${(params?.expectedTexts || []).join(',') || 'none'} | reason=${reason}`,
          });
          if (reason.includes('is not defined')) {
            appendFilterDebugEntry({
              stage: 'error',
              message: '浏览器注入代码引用了未注入的本地 helper',
              detail: `groupKey=${params?.groupKey || 'none'} | reason=${reason}`,
            });
          }
        throw error;
      }
    };

      const clickFilterOptionNode = async (
        groupKey: keyof SearchFilters,
        expectedTexts: string[],
      ) => {
        const response = await extension.invoke("web:runtime:evaluate", {
          tabId,
          args: [
            groupKey,
            expectedTexts,
            FILTER_GROUP_LABELS,
            FILTER_GROUP_INDEX,
          ],
          code: ((
            targetGroupKey: keyof SearchFilters,
            texts: string[],
            filterGroupLabels: typeof FILTER_GROUP_LABELS,
            filterGroupIndex: typeof FILTER_GROUP_INDEX,
          ) => {
            const normalizeText = (input: string) => input.replace(/\s+/g, ' ').trim();
            const normalizeCompactText = (input: string) => input.replace(/\s+/g, '').trim();
            const isVisible = (element: Element | null) => !!(element && (element as HTMLElement).offsetHeight > 0);
            const getPanel = () => {
              const exact = document.querySelector('div.filter-panel') as HTMLElement | null;
              if (exact && isVisible(exact)) return exact;

              const candidates = Array.from(document.querySelectorAll('div, section, aside')) as HTMLElement[];
              const expectedGroupTexts = ['排序依据', '笔记类型', '发布时间', '搜索范围', '位置距离'];
              return candidates
                .filter((element) => isVisible(element))
                .map((element) => {
                  const text = normalizeText(element.innerText || element.textContent || '');
                  const score = expectedGroupTexts.filter((label) => text.includes(label)).length;
                  return score >= 3 ? { element, score } : null;
                })
                .filter((item): item is { element: HTMLElement; score: number } => Boolean(item))
                .sort((left, right) => right.score - left.score)[0]?.element || null;
            };
            const getOrderedGroupBlocks = (panel: HTMLElement | null) => {
              if (!panel) return [] as HTMLElement[];
              const exactBlocks = Array.from(panel.querySelectorAll('div.filter-container > div.filters-wrapper > div.filters'))
                .map((node) => node as HTMLElement)
                .filter((node) => isVisible(node));
              if (exactBlocks.length > 0) return exactBlocks;
              return Array.from(panel.querySelectorAll('div.filters'))
                .map((node) => node as HTMLElement)
                .filter((node) => isVisible(node));
            };
            const getCandidateNodes = (groupBlock: HTMLElement | null | undefined) => (
              Array.from(groupBlock?.querySelectorAll('.tag-container > .tags') || [])
                .map((node) => node as HTMLElement)
                .filter((node) => {
                  const text = normalizeCompactText(node.textContent || '');
                  return Boolean(text) && text.length <= 12 && isVisible(node);
                })
            );
            const resolveCandidateNode = (nodes: HTMLElement[], expectedNodeTexts: string[]) => {
              const normalizedExpected = expectedNodeTexts.map((text) => normalizeCompactText(text)).filter(Boolean);
              if (normalizedExpected.length === 0) return null;

              const normalizedNodes = nodes.map((node, index) => ({
                node,
                index,
                text: normalizeText(node.innerText || node.textContent || ''),
                normalizedText: normalizeCompactText(node.innerText || node.textContent || ''),
                selected: (
                  node.getAttribute('aria-selected') === 'true' ||
                  node.getAttribute('aria-checked') === 'true' ||
                  node.getAttribute('data-selected') === 'true' ||
                  String(node.className || '').toLowerCase().includes('selected') ||
                  String(node.className || '').toLowerCase().includes('active')
                ),
              }));

              for (const expected of normalizedExpected) {
                const exactUnselected = normalizedNodes.filter((candidate) => candidate.normalizedText === expected && !candidate.selected);
                if (exactUnselected.length > 0) return exactUnselected[exactUnselected.length - 1];
              }
              for (const expected of normalizedExpected) {
                const exactAny = normalizedNodes.filter((candidate) => candidate.normalizedText === expected);
                if (exactAny.length > 0) return exactAny[exactAny.length - 1];
              }
              return null;
            };
            const clickNode = (node: HTMLElement | null) => {
              if (!node) return false;
              node.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
              node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              node.click?.();
              return true;
            };

            const panel = getPanel();
            const groupBlocks = getOrderedGroupBlocks(panel);
            const indexedBlock = groupBlocks[filterGroupIndex[targetGroupKey] - 1] as HTMLElement | undefined;
            const matchedBlock = indexedBlock || groupBlocks.find((block) => {
              const text = normalizeText(block.innerText || block.textContent || '');
              return (filterGroupLabels?.[targetGroupKey] || []).some((label) => text.includes(label));
            });
            if (!matchedBlock) {
              return {
                ok: false,
                reason: 'group-not-found',
                hitMatchesTarget: false,
              };
            }

            const candidateNodes = getCandidateNodes(matchedBlock);
            const resolvedCandidate = resolveCandidateNode(candidateNodes, texts);
            if (!resolvedCandidate?.node) {
              return {
                ok: false,
                reason: 'target-not-found',
                hitMatchesTarget: false,
              };
            }

            const rect = resolvedCandidate.node.getBoundingClientRect();
            const probeX = Math.round(Math.min(window.innerWidth - 4, Math.max(4, rect.left + rect.width / 2)));
            const probeY = Math.round(Math.min(window.innerHeight - 4, Math.max(4, rect.top + rect.height / 2)));
            const hitBefore = document.elementFromPoint(probeX, probeY) as HTMLElement | null;
            clickNode(resolvedCandidate.node);
            const hitAfter = document.elementFromPoint(probeX, probeY) as HTMLElement | null;
            return {
              ok: true,
              targetText: resolvedCandidate.text,
              targetSelector: `.tag-container > .tags[data-index="${resolvedCandidate.index}"]`,
              hitTag: String((hitAfter || hitBefore)?.tagName || ''),
              hitText: normalizeText((hitAfter || hitBefore)?.innerText || (hitAfter || hitBefore)?.textContent || ''),
              hitMatchesTarget: Boolean(
                (hitAfter || hitBefore) &&
                ((hitAfter || hitBefore) === resolvedCandidate.node ||
                  (hitAfter || hitBefore)?.closest('.tags') === resolvedCandidate.node)
              ),
            };
          }).toString(),
        });
        return unwrapEvalResult<FilterNodeClickResult>(response);
      };

      const hoverAt = async (x: number, y: number) => {
        if (clickMode === 'debugger') {
          try {
            await sendMouseEvent("mouseMoved", x, y);
            return;
          } catch (error) {
            clickMode = 'dom';
            logClickModeFallback('debugger-hover', clickMode, error);
          }
        }

        await runDomPointerAction('hover', x, y);
      };

      const clickAt = async (x: number, y: number) => {
        const beforeHit = await inspectPointTarget(x, y).catch(() => null);
        if (clickMode === 'debugger') {
          try {
            await sendMouseEvent("mouseMoved", x, y);
            await sendMouseEvent("mousePressed", x, y);
            await sendMouseEvent("mouseReleased", x, y);
            const afterHit = await inspectPointTarget(x, y).catch(() => null);
            appendFilterDebugEntry({
              stage: 'click',
              message: '筛选点击事件已发送',
              detail: `clickMode=debugger | x=${x} | y=${y} | hitBefore=${beforeHit?.data?.tagName || 'unknown'}:${beforeHit?.data?.className || 'none'}:${beforeHit?.data?.text || 'none'} | hitAfter=${afterHit?.data?.tagName || 'unknown'}:${afterHit?.data?.className || 'none'}:${afterHit?.data?.text || 'none'}`,
            });
            return;
          } catch (error) {
            lastDebuggerError = error instanceof Error ? error.message : String(error || 'unknown');
            try {
              clickMode = 'dispatch';
              logClickModeFallback('debugger-click', clickMode, error);
              await extension.invoke("chrome:debugger:dispatchMouseClick", {
                tabId,
                x,
                y,
              });
              const afterHit = await inspectPointTarget(x, y).catch(() => null);
              appendFilterDebugEntry({
                stage: 'click',
                message: '筛选点击事件已发送',
                detail: `clickMode=dispatch | x=${x} | y=${y} | hitBefore=${beforeHit?.data?.tagName || 'unknown'}:${beforeHit?.data?.className || 'none'}:${beforeHit?.data?.text || 'none'} | hitAfter=${afterHit?.data?.tagName || 'unknown'}:${afterHit?.data?.className || 'none'}:${afterHit?.data?.text || 'none'}`,
              });
              return;
            } catch (dispatchError) {
              lastDispatchError = dispatchError instanceof Error ? dispatchError.message : String(dispatchError || 'unknown');
              clickMode = 'dom';
              logClickModeFallback('dispatch-click', clickMode, dispatchError);
            }
          }
        }

        if (clickMode === 'dispatch') {
          try {
            await extension.invoke("chrome:debugger:dispatchMouseClick", {
              tabId,
              x,
              y,
            });
            const afterHit = await inspectPointTarget(x, y).catch(() => null);
            appendFilterDebugEntry({
              stage: 'click',
              message: '筛选点击事件已发送',
              detail: `clickMode=dispatch | x=${x} | y=${y} | hitBefore=${beforeHit?.data?.tagName || 'unknown'}:${beforeHit?.data?.className || 'none'}:${beforeHit?.data?.text || 'none'} | hitAfter=${afterHit?.data?.tagName || 'unknown'}:${afterHit?.data?.className || 'none'}:${afterHit?.data?.text || 'none'}`,
            });
            return;
          } catch (error) {
            lastDispatchError = error instanceof Error ? error.message : String(error || 'unknown');
            clickMode = 'dom';
            logClickModeFallback('dispatch-click', clickMode, error);
          }
        }

        const result = await runDomPointerAction('click', x, y);
        if (!result.success || !result.data?.ok) {
          lastDomError = result.message || result.data?.reason || 'DOM click failed';
          throw new Error(lastDomError);
        }
        appendFilterDebugEntry({
          stage: 'click',
          message: '筛选点击事件已发送',
          detail: `clickMode=dom | x=${x} | y=${y} | hitBefore=${beforeHit?.data?.tagName || 'unknown'}:${beforeHit?.data?.className || 'none'}:${beforeHit?.data?.text || 'none'} | hitAfter=${result.data.tagName || 'unknown'}:${result.data.className || 'none'}:${result.data.text || 'none'}`,
        });
      };

      const readFilterStateCode = (
        groupKey?: keyof SearchFilters | null,
        expectedTexts?: string[] | null,
        filterGroupLabels?: typeof FILTER_GROUP_LABELS,
        filterGroupIndex?: typeof FILTER_GROUP_INDEX,
      ) => {
        const normalizeText = (input: string) => input.replace(/\s+/g, ' ').trim();
        const normalizeCompactText = (input: string) => input.replace(/\s+/g, '').trim();
        const resolveCandidateByTexts = (
          candidates: Array<{ text: string; selected: boolean; x: number; y: number; selector: string }>,
          texts: string[],
        ) => {
          const normalizedExpected = texts
            .map((text) => normalizeCompactText(text))
            .filter(Boolean);
          if (normalizedExpected.length === 0) return null;

          const normalizedCandidates = candidates.map((candidate, index) => ({
            ...candidate,
            index,
            normalizedText: normalizeCompactText(candidate.text),
          }));

          for (const expected of normalizedExpected) {
            const exactUnselected = normalizedCandidates.filter((candidate) => (
              candidate.normalizedText === expected && !candidate.selected
            ));
            if (exactUnselected.length > 0) {
              return exactUnselected[exactUnselected.length - 1];
            }
          }

          for (const expected of normalizedExpected) {
            const exactAny = normalizedCandidates.filter((candidate) => candidate.normalizedText === expected);
            if (exactAny.length > 0) {
              return exactAny[exactAny.length - 1];
            }
          }

          return null;
        };
        const isVisible = (element: Element | null) => !!(element && (element as HTMLElement).offsetHeight > 0);
        const isSelectedNode = (element: HTMLElement | null) => {
          if (!element) return false;
          const className = String(element.className || '').toLowerCase();
          const style = window.getComputedStyle(element);
          if (
            element.getAttribute('aria-pressed') === 'true' ||
            element.getAttribute('aria-selected') === 'true' ||
            element.getAttribute('aria-checked') === 'true' ||
            element.getAttribute('data-active') === 'true' ||
            element.getAttribute('data-selected') === 'true' ||
            className.includes('active') ||
            className.includes('selected') ||
            className.includes('current') ||
            className.includes('checked') ||
            className.includes('on')
          ) {
            return true;
          }

          const color = String(style.color || '').toLowerCase();
          const backgroundColor = String(style.backgroundColor || '').toLowerCase();
          const borderColor = String(style.borderColor || '').toLowerCase();
          return (
            color.includes('255, 36') ||
            color.includes('255,51') ||
            backgroundColor.includes('255, 36') ||
            backgroundColor.includes('255,51') ||
            borderColor.includes('255, 36') ||
            borderColor.includes('255,51')
          );
        };
        const toGeometry = (element: HTMLElement | null, selector: string) => {
          if (!element || !isVisible(element)) return null;
          const rect = element.getBoundingClientRect();
          return {
            x: Math.round(Math.min(window.innerWidth - 4, Math.max(4, rect.left + rect.width / 2))),
            y: Math.round(Math.min(window.innerHeight - 4, Math.max(4, rect.top + rect.height / 2))),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            selector,
            text: normalizeText(element.innerText || element.textContent || ''),
          };
        };
        const getPanel = () => {
          const exact = document.querySelector('div.filter-panel') as HTMLElement | null;
          if (exact && isVisible(exact)) return exact;

          const candidates = Array.from(document.querySelectorAll('div, section, aside')) as HTMLElement[];
          const expectedGroupTexts = ['排序依据', '笔记类型', '发布时间', '搜索范围', '位置距离'];
          return candidates
            .filter((element) => isVisible(element))
            .map((element) => {
              const text = normalizeText(element.innerText || element.textContent || '');
              const score = expectedGroupTexts.filter((label) => text.includes(label)).length;
              return score >= 3 ? { element, score } : null;
            })
            .filter((item): item is { element: HTMLElement; score: number } => Boolean(item))
            .sort((left, right) => right.score - left.score)[0]?.element || null;
        };
        const getTrigger = (panelElement: HTMLElement | null) => {
          const isStandaloneTriggerText = (value: string) => {
            const text = normalizeText(value);
            const compact = text.replace(/\s+/g, '');
            if (!text || (!text.includes('筛选') && compact !== '已筛选')) return false;
            const noisyKeywords = ['排序依据', '笔记类型', '发布时间', '搜索范围', '位置距离', '重置', '收起'];
            return !noisyKeywords.some((keyword) => text.includes(keyword));
          };
          const triggerCandidates = Array.from(document.querySelectorAll('button, div, span'))
            .map((node) => node as HTMLElement)
            .filter((node) => {
              if (!isVisible(node)) return false;
              if (panelElement && (node === panelElement || node.contains(panelElement) || panelElement.contains(node))) {
                return false;
              }
              const text = normalizeText(node.innerText || node.textContent || '');
              return isStandaloneTriggerText(text);
            })
            .sort((left, right) => {
              const leftText = normalizeText(left.innerText || left.textContent || '');
              const rightText = normalizeText(right.innerText || right.textContent || '');
              const leftCompact = leftText.replace(/\s+/g, '');
              const rightCompact = rightText.replace(/\s+/g, '');
              const leftScore = leftCompact === '已筛选' ? 0 : (leftCompact === '筛选' ? 1 : 2);
              const rightScore = rightCompact === '已筛选' ? 0 : (rightCompact === '筛选' ? 1 : 2);
              if (leftScore !== rightScore) return leftScore - rightScore;
              return leftText.length - rightText.length;
            });
          const exact = triggerCandidates[0] || null;
          return exact ? {
            element: exact,
            selector: `text:${normalizeCompactText(exact.innerText || exact.textContent || '') || '筛选'}`,
          } : null;
        };
        const getOrderedGroupBlocks = (panel: HTMLElement | null) => {
          if (!panel) return [] as HTMLElement[];
          const exactBlocks = Array.from(panel.querySelectorAll('div.filter-container > div.filters-wrapper > div.filters'))
            .map((node) => node as HTMLElement)
            .filter((node) => isVisible(node));
          if (exactBlocks.length > 0) return exactBlocks;
          return Array.from(panel.querySelectorAll('div.filters'))
            .map((node) => node as HTMLElement)
            .filter((node) => isVisible(node));
        };
        const getCandidateNodes = (groupBlock: HTMLElement | null | undefined) => (
          Array.from(groupBlock?.querySelectorAll('.tag-container > .tags') || [])
            .map((node) => node as HTMLElement)
            .filter((node) => {
              const text = normalizeCompactText(node.textContent || '');
              return Boolean(text) && text.length <= 12 && isVisible(node);
            })
        );
        const buildCandidateList = (groupBlock: HTMLElement | null | undefined) => {
          const nodes = getCandidateNodes(groupBlock);
          const deduped = new Map<string, { text: string; selected: boolean }>();
          nodes.forEach((node) => {
            const text = normalizeText(node.innerText || node.textContent || '');
            const key = normalizeCompactText(text);
            const selected = isSelectedNode(node);
            const prev = deduped.get(key);
            if (!prev || selected || !prev.selected) {
              deduped.set(key, { text, selected: selected || prev?.selected || false });
            }
          });
          return Array.from(deduped.values());
        };
        const buildResolvedCandidates = (groupBlock: HTMLElement | null | undefined): ResolvedFilterCandidate[] => {
          const nodes = getCandidateNodes(groupBlock);
          return nodes.map((node, index) => {
            const geometry = toGeometry(node, `.tag-container > .tags[data-index="${index}"]`);
            return {
              text: normalizeText(node.innerText || node.textContent || ''),
              selected: isSelectedNode(node),
              x: geometry?.x || 0,
              y: geometry?.y || 0,
              selector: geometry?.selector || '',
            };
          });
        };
        const getGroupTitle = (groupBlock: HTMLElement | null | undefined, index: number) => {
          const text = normalizeText(groupBlock?.innerText || groupBlock?.textContent || '');
          const labels = ['排序', '类型', '时间', '范围', '位置'];
          return labels.find((label) => text.includes(label)) || `第${index + 1}组`;
        };

        const panel = getPanel();
        const trigger = getTrigger(panel);
        const groupBlocks = getOrderedGroupBlocks(panel);
        const groups = groupBlocks.map((block, index) => ({
          index: index + 1,
          title: getGroupTitle(block, index),
          candidates: buildCandidateList(block),
        }));

        let targetGroup: { index: number; title: string; candidates: { text: string; selected: boolean }[] } | null = null;
        let target = null;
        let resolvedCandidates: ResolvedFilterCandidate[] = [];
        if (groupKey && filterGroupIndex) {
          const indexedBlock = groupBlocks[filterGroupIndex[groupKey] - 1] as HTMLElement | undefined;
          const matchedBlock = indexedBlock || groupBlocks.find((block) => {
            const text = normalizeText(block.innerText || block.textContent || '');
            return (filterGroupLabels?.[groupKey] || []).some((label) => text.includes(label));
          });
          if (matchedBlock) {
            resolvedCandidates = buildResolvedCandidates(matchedBlock);
            const resolvedCandidate = resolveCandidateByTexts(resolvedCandidates, expectedTexts || []);
            target = resolvedCandidate ? {
              x: resolvedCandidate.x,
              y: resolvedCandidate.y,
              width: 0,
              height: 0,
              selector: resolvedCandidate.selector,
              text: resolvedCandidate.text,
            } : null;
            targetGroup = {
              index: groupBlocks.indexOf(matchedBlock) + 1,
              title: getGroupTitle(matchedBlock, Math.max(0, groupBlocks.indexOf(matchedBlock))),
              candidates: buildCandidateList(matchedBlock),
            };
          }
        }

        return {
          panelOpen: Boolean(panel),
          groupCount: groupBlocks.length,
          groups,
          trigger: toGeometry(trigger?.element || null, trigger?.selector || ''),
          target,
          targetGroup,
          resolvedCandidates,
        };
      };

      const readFilterState = async (params?: {
        groupKey?: keyof SearchFilters;
        expectedTexts?: string[];
      }): Promise<FilterProbeState> => {
        const resp = await extension.invoke("web:runtime:evaluate", {
          tabId,
          args: [
            params?.groupKey || null,
            params?.expectedTexts || null,
            FILTER_GROUP_LABELS,
            FILTER_GROUP_INDEX,
          ],
          code: readFilterStateCode.toString(),
        });
        const result = unwrapEvalResult<FilterProbeState>(resp);
        if (!result.success || !result.data) {
          throw new Error(result.message || '筛选状态读取失败');
        }
        return result.data;
      };

      const waitForPanelOpen = async () => {
        const tries = Math.ceil(STAGE_TIMEOUTS.filterPanelMs / 200);
        let lastState: FilterProbeState | null = null;
        for (let i = 0; i < tries; i++) {
          const nextState = await readFilterStateWithSnapshot();
          lastState = nextState;
          if (nextState.panelOpen) return nextState;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        appendFilterDebugEntry({
          stage: 'error',
          message: '等待筛选面板打开超时',
          detail: summarizeFilterProbeState(lastState),
        });
        return lastState;
      };

      const openFilterPanel = async (trigger?: FilterGeometry | null, reopenReason = 'initial_open') => {
        const clickAttempts = 2;
        let lastState: FilterProbeState | null = null;
        for (let attempt = 0; attempt < clickAttempts; attempt += 1) {
          const latestStateBeforeClick = await readFilterStateWithSnapshot();
          const latestTrigger = latestStateBeforeClick.trigger || trigger || null;
          if (!latestTrigger) {
            appendFilterDebugEntry({
              stage: 'error',
              message: '开筛选面板失败',
              detail: `phase=open_panel | reason=trigger_missing | reopenReason=${reopenReason} | snapshot=${summarizeFilterProbeState(latestStateBeforeClick)}`,
            });
            return waitForPanelOpen();
          }
          appendFilterDebugEntry({
            stage: 'panel',
            message: '准备打开筛选面板',
            detail: `phase=open_panel | strategy=click_first | attempt=${attempt + 1} | reopenReason=${reopenReason} | triggerTextBefore=${latestTrigger.text || 'none'} | triggerSelectorSource=${latestTrigger.selector || 'none'} | x=${latestTrigger.x} | y=${latestTrigger.y}`,
          });
          await clickAt(latestTrigger.x, latestTrigger.y);
          await new Promise((resolve) => setTimeout(resolve, 350));
          lastState = await readFilterStateWithSnapshot();
          if (lastState.panelOpen) {
            appendFilterDebugEntry({
              stage: 'panel',
              message: 'click 打开筛选面板成功',
              detail: `phase=open_panel | strategy=click_first | attempt=${attempt + 1} | reopenReason=${reopenReason} | triggerTextAfter=${lastState.trigger?.text || latestTrigger.text || 'none'} | readyState=${document.readyState}`,
            });
            return lastState;
          }
          appendFilterDebugEntry({
            stage: 'panel',
            message: 'click 后面板未出现',
            detail: `phase=open_panel | strategy=click_first | attempt=${attempt + 1} | reopenReason=${reopenReason} | triggerTextAfter=${lastState?.trigger?.text || latestTrigger.text || 'none'} | snapshot=${summarizeFilterProbeState(lastState)}`,
          });
        }

        const latestStateBeforeHover = await readFilterStateWithSnapshot();
        const latestTrigger = latestStateBeforeHover.trigger || trigger || null;
        if (!latestTrigger) {
          appendFilterDebugEntry({
            stage: 'error',
            message: '开筛选面板失败',
            detail: `phase=open_panel | reason=trigger_missing_before_hover | reopenReason=${reopenReason} | snapshot=${summarizeFilterProbeState(latestStateBeforeHover)}`,
          });
          return waitForPanelOpen();
        }
        appendFilterDebugEntry({
          stage: 'panel',
          message: 'click 打开失败，尝试 hover 打开',
          detail: `phase=open_panel | strategy=hover_retry | reopenReason=${reopenReason} | triggerTextBefore=${latestTrigger.text || 'none'} | triggerSelectorSource=${latestTrigger.selector || 'none'} | x=${latestTrigger.x} | y=${latestTrigger.y}`,
        });
        await hoverAt(latestTrigger.x, latestTrigger.y);
        await new Promise((resolve) => setTimeout(resolve, 400));
        lastState = await readFilterStateWithSnapshot();
        if (lastState.panelOpen) {
          appendFilterDebugEntry({
            stage: 'panel',
            message: 'hover 打开筛选面板成功',
            detail: `phase=open_panel | strategy=hover_retry | reopenReason=${reopenReason} | triggerTextAfter=${lastState.trigger?.text || latestTrigger.text || 'none'} | snapshot=${summarizeFilterProbeState(lastState)}`,
          });
          return lastState;
        }

        appendFilterDebugEntry({
          stage: 'error',
          message: '开筛选面板失败',
          detail: `phase=open_panel | reopenReason=${reopenReason} | snapshot=${summarizeFilterProbeState(lastState)}`,
        });
        return waitForPanelOpen();
      };

      const waitForExpectedSelection = async (
        groupKey: keyof SearchFilters,
        expectedTexts: string[],
      ) => {
        const tries = 10;
        let lastState: FilterProbeState | null = null;
        for (let i = 0; i < tries; i++) {
          const nextState = await readFilterStateWithSnapshot({ groupKey, expectedTexts });
          lastState = nextState;
          const selectedTexts = (nextState.targetGroup?.candidates || [])
            .filter((item) => item.selected)
            .map((item) => item.text.replace(/\s+/g, '').trim());
          const matched = expectedTexts
            .map((text) => text.replace(/\s+/g, '').trim())
            .some((text) => selectedTexts.includes(text));
          if (matched) {
            return nextState;
          }
          await new Promise((resolve) => setTimeout(resolve, 180));
        }
        appendFilterDebugEntry({
          stage: 'error',
          message: '等待筛选选中态超时',
          detail: `groupKey=${groupKey} | expected=${expectedTexts.join(',')} | snapshot=${summarizeFilterProbeState(lastState)}`,
        });
        return lastState;
      };

      const ensurePanelOpenForRetry = async (reopenReason = 'panel_retry') => {
        const currentState = await readFilterStateWithSnapshot();
        if (currentState.panelOpen) return currentState;
        if (!currentState.trigger) {
          throw new Error(`筛选面板已收起，且未找到筛选入口 | snapshot=${summarizeFilterProbeState(currentState)}`);
        }
        appendFilterDebugEntry({
          stage: 'panel',
          message: '面板已关闭，准备重新打开',
          detail: `phase=open_panel | strategy=click_first | reopenReason=${reopenReason} | selector=${currentState.trigger.selector} | x=${currentState.trigger.x} | y=${currentState.trigger.y} | text=${currentState.trigger.text || 'none'}`,
        });
        return openFilterPanel(currentState.trigger, reopenReason);
      };

      const closeFilterPanel = async () => {
        const response = await extension.invoke("web:runtime:evaluate", {
          tabId,
          args: [],
          code: (() => {
            const normalizeText = (input: string) => input.replace(/\s+/g, ' ').trim();
            const isVisible = (element: Element | null) => !!(element && (element as HTMLElement).offsetHeight > 0);
            const clickNode = (node: HTMLElement | null) => {
              if (!node) return false;
              node.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
              node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
              node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              node.click?.();
              return true;
            };
            const panel = document.querySelector('div.filter-panel') as HTMLElement | null;
            const panelOpenBefore = Boolean(panel && isVisible(panel));
            const candidates = Array.from(document.querySelectorAll('button, div, span'))
              .map((node) => node as HTMLElement)
              .filter((node) => isVisible(node));
            const collapseNode = candidates.find((node) => ['收起', '应用并收起', '完成'].includes(normalizeText(node.innerText || node.textContent || '')));
            if (clickNode(collapseNode)) {
              return {
                action: 'collapse_button',
                panelOpenBefore,
              };
            }
            const trigger = document.querySelector('div.filter') as HTMLElement | null;
            if (clickNode(trigger)) {
              return {
                action: 'filter_trigger',
                panelOpenBefore,
              };
            }
            const outsideTarget = document.body as HTMLElement | null;
            if (clickNode(outsideTarget)) {
              return {
                action: 'body_click',
                panelOpenBefore,
              };
            }
            return {
              action: 'none',
              panelOpenBefore,
            };
          }).toString(),
        });
        return unwrapEvalResult<{ action: string; panelOpenBefore: boolean }>(response);
      };

      setData([]);
      appendFilterDebugEntry({
        stage: 'panel',
        message: '开始扫描筛选面板',
        detail: `目标筛选=${createFilterSignature(filters)}`,
      });

      const initialState = await readFilterStateWithSnapshot();
      if (!initialState.trigger) {
        throw new Error('未找到筛选按钮');
      }

      appendFilterDebugEntry({
        stage: 'panel',
        message: '筛选入口几何定位成功',
        detail: `selector=${initialState.trigger.selector} | x=${initialState.trigger.x} | y=${initialState.trigger.y} | text=${initialState.trigger.text || 'none'}`,
      });

      let panelBefore = await openFilterPanel(initialState.trigger, 'initial_open');
      if (!panelBefore?.panelOpen) {
        throw new Error('筛选面板未能打开');
      }

      appendFilterDebugEntry({
        stage: 'panel',
        message: '筛选面板已打开',
        detail: `groups=${panelBefore.groupCount || 0} | ${JSON.stringify((panelBefore.groups || []).map((group) => ({
          title: group.title,
          candidates: group.candidates.map((item) => `${item.text}${item.selected ? '(selected)' : ''}`),
        })))}`,
      });

      const clickResults: Array<Record<string, unknown>> = [];
      const filterProgress: Partial<Record<keyof SearchFilters, 'pending' | 'selected' | 'failed'>> = {};
      const finalConfirmedItemStates: Partial<Record<keyof SearchFilters, { selectedTexts: string[]; matched: boolean }>> = {};
      let totalPanelRecoveryCount = 0;
      for (const groupKey of INTERACTIVE_FILTER_KEYS) {
        const currentValue = filters[groupKey];
        const isDefault = isDefaultFilterValue(groupKey, currentValue);
        if (isDefault) continue;
        if (!filterRequestCaptureStartedAtRef.current) {
          filterRequestCaptureStartedAtRef.current = Date.now();
          filterRequestCaptureActiveRef.current = true;
          filterRequestObservedBaselineRef.current = lastObservedSearchRequestAtRef.current;
          filterRequestMatchedBaselineRef.current = lastMatchedSearchRequestAtRef.current;
          appendFilterDebugEntry({
            stage: 'request',
            message: '已进入筛选请求捕获窗口',
            detail: `captureStartedAt=${filterRequestCaptureStartedAtRef.current} | observedBaseline=${filterRequestObservedBaselineRef.current} | matchedBaseline=${filterRequestMatchedBaselineRef.current}`,
          });
        }

        const aliases = getFilterOptionCandidateTexts(groupKey, currentValue);
        const expectedTexts = [String(currentValue), ...aliases];
        filterProgress[groupKey] = 'pending';
        appendFilterDebugEntry({
          stage: 'click',
          message: `准备执行筛选项 ${groupKey}=${currentValue}`,
          detail: `progress=${['sortBy', 'noteType', 'publishTime', 'searchScope', 'location']
            .map((key) => `${key}=${filterProgress[key as keyof SearchFilters] || 'skip'}`)
            .join(' | ')}`,
        });
        let afterState: FilterProbeState | null = null;
        let domSelectionConfirmed = false;
        let itemPanelRecoveryCount = 0;
        let lastSelectionFailureReason = '';
        let selectedAfter = 'none';
        let selectedAfterTexts: string[] = [];
        let targetSnapshotForDebug: FilterProbeState | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await (attempt === 0
            ? ensurePanelOpenForRetry(`before_${groupKey}`)
            : ensurePanelOpenForRetry(`${groupKey}_retry_${attempt}`));
          const latestState = await readFilterStateWithSnapshot({ groupKey, expectedTexts });
          targetSnapshotForDebug = latestState;
          if (!latestState.target) {
            lastSelectionFailureReason = `未重新解析到筛选选项 ${currentValue}`;
            break;
          }
          appendFilterDebugEntry({
            stage: 'click',
            message: `筛选目标几何定位成功：${groupKey} -> ${currentValue}`,
            detail: `desiredText=${currentValue} | attempt=${attempt + 1} | selector=${latestState.target.selector} | x=${latestState.target.x} | y=${latestState.target.y} | resolvedTargetText=${latestState.target.text || 'none'} | resolvedCandidates=${(latestState.resolvedCandidates || []).map((item) => `${item.text}${item.selected ? '(selected)' : ''}`).join(' | ') || 'none'}`,
          });
          const clickResult = await clickFilterOptionNode(groupKey, expectedTexts);
          const summarizedHitText = summarizeFilterHitText(clickResult.data?.hitText);
          appendFilterDebugEntry({
            stage: 'click',
            message: '筛选点击事件已发送',
            detail: `clickMode=dom_target | groupKey=${groupKey} | expectedText=${currentValue} | targetText=${clickResult.data?.targetText || 'none'} | targetSelector=${clickResult.data?.targetSelector || 'none'} | hitTag=${clickResult.data?.hitTag || 'unknown'} | hitText=${summarizedHitText} | hitMatchesTarget=${clickResult.data?.hitMatchesTarget ? 'true' : 'false'}`,
          });
          if (!clickResult.success || !clickResult.data?.ok) {
            filterProgress[groupKey] = 'failed';
            throw new Error(`筛选点击失败 ${groupKey}=${currentValue} | reason=${clickResult.message || clickResult.data?.reason || 'unknown'}`);
          }
          filterPostClickActivatedAtRef.current = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 260));
          afterState = await readFilterStateWithSnapshot({ groupKey, expectedTexts });
          let matched = hasExpectedFilterSelection(afterState?.targetGroup?.candidates, expectedTexts);
          if (!afterState?.panelOpen) {
            appendFilterDebugEntry({
              stage: 'panel',
              message: '筛选项点击后面板自动收起',
              detail: `groupKey=${groupKey} | currentValue=${currentValue} | attempt=${attempt + 1} | reopenReason=panel_auto_closed_after_selection | matchedImmediately=${matched ? 'true' : 'false'}`,
            });
            if (matched) {
              domSelectionConfirmed = true;
            } else if (shouldRecoverClosedFilterPanel({
              itemRecoveryCount: itemPanelRecoveryCount,
              totalRecoveryCount: totalPanelRecoveryCount,
            })) {
              await ensurePanelOpenForRetry(`panel_auto_closed_after_selection:${groupKey}:${attempt + 1}`);
              afterState = await readFilterStateWithSnapshot({ groupKey, expectedTexts });
              matched = hasExpectedFilterSelection(afterState?.targetGroup?.candidates, expectedTexts);
              domSelectionConfirmed = matched;
              if (!matched) {
                lastSelectionFailureReason = `筛选项自动收起后重开，但仍未确认 ${groupKey}=${currentValue}`;
              }
            } else {
              lastSelectionFailureReason = `筛选项点击后面板自动收起，且 ${groupKey} 已用尽重开次数`;
            }
          } else {
            afterState = await waitForExpectedSelection(groupKey, expectedTexts);
            matched = hasExpectedFilterSelection(afterState?.targetGroup?.candidates, expectedTexts);
            domSelectionConfirmed = matched;
            if (!matched) {
              lastSelectionFailureReason = `筛选项 DOM 状态未确认 ${groupKey}=${currentValue}`;
            }
          }

          selectedAfter = (afterState?.targetGroup?.candidates || [])
            .filter((item) => item.selected)
            .map((item) => item.text)
            .join(',') || 'none';
          selectedAfterTexts = (afterState?.targetGroup?.candidates || [])
            .filter((item) => item.selected)
            .map((item) => item.text);

          if (domSelectionConfirmed) {
            break;
          }

          appendFilterDebugEntry({
            stage: 'panel',
            message: '筛选项未确认，准备重新打开面板继续下一次尝试',
            detail: `groupKey=${groupKey} | currentValue=${currentValue} | attempt=${attempt + 1} | reopenReason=${lastSelectionFailureReason || 'selection_not_confirmed'} | selectedAfter=${selectedAfter}`,
          });

          if (!shouldRecoverClosedFilterPanel({
            itemRecoveryCount: itemPanelRecoveryCount,
            totalRecoveryCount: totalPanelRecoveryCount,
          })) {
            break;
          }
          itemPanelRecoveryCount += 1;
          totalPanelRecoveryCount += 1;
        }

        appendFilterDebugEntry({
          stage: 'click',
          message: domSelectionConfirmed
            ? `筛选项 DOM 状态已确认 ${groupKey}=${currentValue}`
            : `筛选项 DOM 状态未确认 ${groupKey}=${currentValue}`,
          detail: `selectedAfter=${selectedAfter} | progress=${['sortBy', 'noteType', 'publishTime', 'searchScope', 'location']
            .map((key) => `${key}=${filterProgress[key as keyof SearchFilters] || 'skip'}`)
            .join(' | ')}`,
        });
        filterProgress[groupKey] = domSelectionConfirmed ? 'selected' : 'failed';
        if (domSelectionConfirmed) {
          finalConfirmedItemStates[groupKey] = {
            selectedTexts: selectedAfterTexts,
            matched: true,
          };
        } else {
          finalConfirmedItemStates[groupKey] = {
            selectedTexts: selectedAfterTexts,
            matched: false,
          };
          throw new Error(
            buildFilterSelectionErrorMessage({
              targetText: `${groupKey}=${currentValue}`,
              debuggerError: lastDebuggerError,
              dispatchError: lastDispatchError,
              domError: `${lastSelectionFailureReason || '选中态未确认'} | selectedAfter=${selectedAfter} | snapshot=${summarizeFilterProbeState(afterState || targetSnapshotForDebug)}`,
            })
          );
        }

        clickResults.push({
          groupKey,
          clickedText: currentValue,
          selectedAfter,
          domSelectionConfirmed,
          clickedAt: filterPostClickActivatedAtRef.current || Date.now(),
          x: (targetSnapshotForDebug?.target?.x || 0),
          y: (targetSnapshotForDebug?.target?.y || 0),
          selector: targetSnapshotForDebug?.target?.selector || 'none',
          candidatesBefore: (targetSnapshotForDebug?.targetGroup?.candidates || []).map((item) => `${item.text}${item.selected ? '(selected)' : ''}`),
          candidatesAfter: (afterState?.targetGroup?.candidates || []).map((item) => `${item.text}${item.selected ? '(selected)' : ''}`),
        });
      }

      const panelAfter = await readFilterState();
      const panelAfterStates = (panelAfter?.groups || []).length > 0
        ? getFinalFilterConfirmationStates({
            filters,
            groups: panelAfter?.groups || [],
          })
        : [];
      const finalFilterStates = panelAfterStates.length > 0
        ? panelAfterStates
        : buildFinalFilterConfirmations({
            filters,
            itemStates: finalConfirmedItemStates,
          });
      const finalFilterSelectionConfirmed = finalFilterStates.every((item) => item.matched);
      appendFilterDebugEntry({
        stage: 'group_scan',
        message: '筛选点击后面板快照',
        detail: JSON.stringify((panelAfter?.groups || []).map((group) => ({
          title: group.title,
          candidates: group.candidates.map((item) => `${item.text}${item.selected ? '(selected)' : ''}`),
        }))),
      });
      clickResults.forEach((item: any) => {
        appendFilterDebugEntry({
          stage: 'click',
          message: item?.domSelectionConfirmed
            ? `筛选选项点击后已命中：${item?.groupKey || 'unknown'} -> ${item?.clickedText || 'none'}`
            : `筛选选项点击后未命中：${item?.groupKey || 'unknown'} -> ${item?.clickedText || 'none'}`,
          detail: `selectedAfter=${item?.selectedAfter || 'none'} | x=${item?.x || 0} | y=${item?.y || 0} | selector=${item?.selector || 'none'}`,
        });
      });
      appendFilterDebugEntry({
        stage: 'group_scan',
        message: finalFilterSelectionConfirmed ? '最终筛选快照校验通过' : '最终筛选快照校验失败',
        detail: finalFilterStates
          .map((item) => `${item.groupKey}=${item.expectedValue} | matched=${item.matched ? 'true' : 'false'} | selected=${item.selectedTexts.join(',') || 'none'}`)
          .join(' | '),
      });

      appendFilterDebugEntry({
        stage: 'panel',
        message: '全部筛选项已完成，准备关闭面板',
        detail: `selected=${clickResults.map((item: any) => `${item.groupKey}:${item.clickedText}`).join(' | ') || 'none'} | progress=${['sortBy', 'noteType', 'publishTime', 'searchScope', 'location']
          .map((key) => `${key}=${filterProgress[key as keyof SearchFilters] || 'skip'}`)
          .join(' | ')}`,
      });
      const closePanelResult = panelAfter?.panelOpen
        ? await closeFilterPanel()
        : {
            success: true,
            data: {
              action: 'already_closed',
              panelOpenBefore: false,
            },
          };
      filterRequestCaptureActiveRef.current = false;
      appendFilterDebugEntry({
        stage: 'panel',
        message: panelAfter?.panelOpen ? '已触发收起面板' : '面板已自然关闭，无需主动收起',
        detail: `action=${closePanelResult.data?.action || 'unknown'} | panelOpenBefore=${closePanelResult.data?.panelOpenBefore ? 'true' : 'false'} | success=${closePanelResult.success ? 'true' : 'false'}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 350));

      const lastClickResult = clickResults[clickResults.length - 1] as { clickedAt?: number } | undefined;
      const baselineObservedRequestAt = filterRequestObservedBaselineRef.current;
      const baselineMatchedRequestAt = filterRequestMatchedBaselineRef.current;
      const captureStartedAt = filterRequestCaptureStartedAtRef.current || filterPostClickActivatedAtRef.current || Date.now();
      const capturedMatchedEvents = pickBufferedSearchEventsForRelease(bufferedSearchEventsRef.current, captureStartedAt);
      let capturedCommittedCount = 0;
      if (capturedMatchedEvents.length > 0) {
        const capturedTraceIds: string[] = [];
        capturedMatchedEvents.forEach((event, index) => {
          if (index >= collectionTargetRef.current) return;
          const committed = appendIncomingNotes(event.detail, event.requestAt);
          if (committed.queueAccepted) {
            capturedCommittedCount += 1;
          }
          if (event.detail.requestTraceId) {
            capturedTraceIds.push(event.detail.requestTraceId);
          }
        });
        releasedBufferedRequestCountRef.current += capturedCommittedCount;
        updateCountDiagnostics({
          releasedIntoDataCount: releasedBufferedRequestCountRef.current,
        });
        appendFilterDebugEntry({
          stage: 'request',
          message: '释放筛选窗口内匹配请求',
          detail: `captureStartedAt=${captureStartedAt} | matchedCount=${capturedMatchedEvents.length} | committedCount=${capturedCommittedCount} | requestTraceIds=${capturedTraceIds.join(',') || 'none'}`,
        });
      }
      bufferedSearchEventsRef.current = [];
      appendFilterDebugEntry({
        stage: 'request',
        message: '等待筛选请求确认',
        detail: `baselineObservedSearchRequestAt=${baselineObservedRequestAt} | baselineMatchedSearchRequestAt=${baselineMatchedRequestAt} | captureStartedAt=${captureStartedAt} | capturedCommittedCount=${capturedCommittedCount}`,
      });
      const hookSeenSummary = await readWorkerHookSeenSummary(tabId);
      appendFilterDebugEntry({
        stage: 'request',
        message: 'worker hook 自检摘要',
        detail: hookSeenSummary
          ? `fetchRequestCount=${hookSeenSummary.fetchRequestCount} | fetchResponseCount=${hookSeenSummary.fetchResponseCount} | xhrCount=${hookSeenSummary.xhrCount} | searchLikeSeenCount=${hookSeenSummary.searchLikeSeenCount} | strictSearchMatchedCount=${hookSeenSummary.strictSearchMatchedCount}`
          : 'hookSeenSummary=null',
      });
      const pulledMatchedRequests = finalFilterSelectionConfirmed
        ? await readWorkerCapturedMatchedRequests(tabId, captureStartedAt)
        : [];
      let pulledCommittedCount = 0;
      if (!requestObservedRef.current && pulledMatchedRequests.length > 0) {
        const pulledTraceIds: string[] = [];
        pulledMatchedRequests.forEach((detail, index) => {
          if (index >= collectionTargetRef.current) return;
          requestObservedRef.current = true;
          requestMatchedRef.current = true;
          lastObservedSearchRequestAtRef.current = Math.max(lastObservedSearchRequestAtRef.current, detail.requestCapturedAt || 0);
          const committed = appendIncomingNotes(detail, detail.requestCapturedAt || Date.now());
          if (committed.queueAccepted) {
            pulledCommittedCount += 1;
          }
          if (detail.requestTraceId) {
            pulledTraceIds.push(detail.requestTraceId);
          }
        });
        releasedBufferedRequestCountRef.current += pulledCommittedCount;
        updateCountDiagnostics({
          releasedIntoDataCount: releasedBufferedRequestCountRef.current,
        });
        appendFilterDebugEntry({
          stage: 'request',
          message: '从 worker 缓存恢复匹配请求',
          detail: `pulledCount=${pulledMatchedRequests.length} | committedCount=${pulledCommittedCount} | requestTraceIds=${pulledTraceIds.join(',') || 'none'}`,
        });
      }
      const postFilterSurface = lastClickResult
        ? await waitForPostFilterResultSurface(filterEntryState.url, baselineObservedRequestAt, baselineMatchedRequestAt)
        : null;
      const requestObserved = requestObservedRef.current;
      const requestMatched = requestMatchedRef.current;
      const requestCommitted = requestCommittedRef.current;
      const requestConfirmed = requestCommitted;
      appendFilterDebugEntry({
        stage: 'request',
        message: '筛选点击后结果面状态',
        detail: postFilterSurface
          ? `url=${postFilterSurface.url} | navigated=${postFilterSurface.navigated} | readyState=${postFilterSurface.readyState} | noteCount=${postFilterSurface.noteCount} | hasNoteItem=${postFilterSurface.hasNoteItem} | typeParam=${postFilterSurface.typeParam || 'none'} | keywordParam=${postFilterSurface.keywordParam || 'none'} | panelOpen=${postFilterSurface.panelOpen ? 'true' : 'false'} | emptyStateText=${postFilterSurface.emptyStateText || 'none'} | recoveryState=${postFilterSurface.recoveryState || 'pending'} | observedAdvanced=${postFilterSurface.observedAdvanced ? 'true' : 'false'} | matchedAdvanced=${postFilterSurface.matchedAdvanced ? 'true' : 'false'} | requestObserved=${requestObserved ? 'true' : 'false'} | requestMatched=${requestMatched ? 'true' : 'false'} | requestCommitted=${requestCommitted ? 'true' : 'false'}`
          : 'surface=null',
      });
      const uiConfirmed = isUiAppliedFilterConfirmed({
        finalFilterSelectionConfirmed,
        panelClosed: postFilterSurface?.panelOpen === false,
        recoveryState: postFilterSurface?.recoveryState,
        noteCount: postFilterSurface?.noteCount || 0,
        hasNoteItem: Boolean(postFilterSurface?.hasNoteItem),
      });
      let uiSurfaceAccepted = false;
      let uiTypeParamAccepted = false;
      let recoveredSnapshot: Awaited<ReturnType<typeof collectVisibleSearchNotes>> | null = null;
      if (uiConfirmed) {
        recoveredSnapshot = await collectVisibleSearchNotes(tabId, keyword);
        uiSurfaceAccepted = shouldAcceptUiAppliedSurface({
          looksLikeSearchResult: Boolean(recoveredSnapshot.looksLikeSearchResult),
          keywordMatches: Boolean(recoveredSnapshot.keywordMatches),
          count: Number(recoveredSnapshot.count || 0),
        });
        uiTypeParamAccepted = doesUiTypeParamMatchFilters({
          filters,
          typeParam: postFilterSurface?.typeParam,
        });
        appendFilterDebugEntry({
          stage: 'request',
          message: '页面状态辅助校验结果',
          detail: `url=${recoveredSnapshot.url || 'none'} | snapshotCount=${recoveredSnapshot.count || 0} | looksLikeSearchResult=${recoveredSnapshot.looksLikeSearchResult ? 'true' : 'false'} | keywordMatches=${recoveredSnapshot.keywordMatches ? 'true' : 'false'} | pageKeyword=${recoveredSnapshot.pageKeyword || 'none'} | expectedKeyword=${keyword || 'none'} | typeParam=${postFilterSurface?.typeParam || 'none'} | uiTypeParamAccepted=${uiTypeParamAccepted ? 'true' : 'false'}`,
        });
      }
      const requestFilterConfirmed = finalFilterSelectionConfirmed && isStrictFilterRequestConfirmed({
        requestConfirmed,
      });
      const uiFilterConfirmed = uiConfirmed && isUiFilterConfirmed({
        filters,
        finalFilterSelectionConfirmed,
        looksLikeSearchResult: uiSurfaceAccepted,
        keywordMatches: true,
        count: postFilterSurface?.noteCount || 0,
        typeParam: postFilterSurface?.typeParam,
      });
      const finalFilterConfirmed = requestFilterConfirmed || uiFilterConfirmed;
      const finalConfirmationSource: 'request' | 'ui' | 'none' = requestFilterConfirmed
        ? 'request'
        : (uiFilterConfirmed ? 'ui' : 'none');
      const shouldRecoverUiNotes = shouldRecoverUiConfirmedNotes({
        finalConfirmationSource,
        requestCommitted,
        recoveredCount: Number(recoveredSnapshot?.count || 0),
      });
      let uiRecoveredCommittedCount = 0;
      if (shouldRecoverUiNotes) {
        uiRecoveredCommittedCount = commitRecoveredUiNotes(
          recoveredSnapshot?.notes || [],
          'ui_filter_confirmed',
        );
      }
      if (finalFilterConfirmed) {
        appendFilterDebugEntry({
          stage: 'request',
          message: finalConfirmationSource === 'request' ? '筛选状态确认成功（request）' : '筛选状态确认成功（ui）',
          detail: `lastObservedSearchRequestAt=${lastObservedSearchRequestAtRef.current || 0} | lastMatchedSearchRequestAt=${lastMatchedSearchRequestAtRef.current || 0} | finalFilterSelectionConfirmed=${finalFilterSelectionConfirmed ? 'true' : 'false'} | requestObserved=${requestObserved ? 'true' : 'false'} | requestMatched=${requestMatched ? 'true' : 'false'} | requestCommitted=${requestCommitted ? 'true' : 'false'} | panelClosed=${postFilterSurface?.panelOpen === false ? 'true' : 'false'} | uiConfirmed=${uiConfirmed ? 'true' : 'false'} | uiSurfaceAccepted=${uiSurfaceAccepted ? 'true' : 'false'} | uiTypeParamAccepted=${uiTypeParamAccepted ? 'true' : 'false'} | finalConfirmationSource=${finalConfirmationSource} | uiRecoveredCommittedCount=${uiRecoveredCommittedCount}`,
        });
        if (strictPublishTimeVisibleSourceRef.current) {
          await syncStrictPublishTimeVisibleNotes(tabId, 'filter_confirmed', keyword);
        }
        if (postFilterSurface?.recoveryState === 'empty') {
          explicitEmptyResultRef.current = true;
          appendFilterDebugEntry({
            stage: 'request',
            message: '识别到无结果页',
            detail: `emptyStateText=${postFilterSurface.emptyStateText || 'none'} | url=${postFilterSurface.url}`,
          });
          resultFeedEndedRef.current = true;
        }
      } else {
        const requestFailureReason = !requestObserved
          ? '筛选已生效，但请求主链未接上'
          : !requestMatched
            ? `筛选已生效，但请求未通过筛选校验：${lastFilterMismatchReasonRef.current || 'unknown'}`
            : '筛选已生效，但匹配请求未成功进入正式队列';
        appendFilterDebugEntry({
          stage: 'error',
          message: finalFilterSelectionConfirmed ? '筛选失败：请求与页面结果面均未确认' : '筛选失败：最终筛选状态不匹配',
          detail: `noteCount=${postFilterSurface?.noteCount || 0} | hasNoteItem=${postFilterSurface?.hasNoteItem ? 'true' : 'false'} | emptyStateText=${postFilterSurface?.emptyStateText || 'none'} | observedAdvanced=${postFilterSurface?.observedAdvanced ? 'true' : 'false'} | matchedAdvanced=${postFilterSurface?.matchedAdvanced ? 'true' : 'false'} | requestObserved=${requestObserved ? 'true' : 'false'} | requestMatched=${requestMatched ? 'true' : 'false'} | requestCommitted=${requestCommitted ? 'true' : 'false'} | requestFilterConfirmed=${requestFilterConfirmed ? 'true' : 'false'} | uiConfirmed=${uiConfirmed ? 'true' : 'false'} | uiSurfaceAccepted=${uiSurfaceAccepted ? 'true' : 'false'} | uiTypeParamAccepted=${uiTypeParamAccepted ? 'true' : 'false'} | uiFilterConfirmed=${uiFilterConfirmed ? 'true' : 'false'} | typeParam=${postFilterSurface?.typeParam || 'none'} | keywordParam=${postFilterSurface?.keywordParam || 'none'} | finalFilterConfirmed=${finalFilterConfirmed ? 'true' : 'false'} | finalConfirmationSource=${finalConfirmationSource} | finalFilterSelectionConfirmed=${finalFilterSelectionConfirmed ? 'true' : 'false'} | finalFilterStates=${finalFilterStates.map((item) => `${item.groupKey}:${item.expectedValue}:${item.selectedTexts.join(',') || 'none'}:${item.matched ? 'true' : 'false'}`).join(';') || 'none'} | lastFilterMismatchReason=${lastFilterMismatchReasonRef.current || 'none'}`,
        });
        throw new Error(finalFilterSelectionConfirmed
          ? `筛选失败：${requestFailureReason}，且页面结果面兜底也未通过，本轮已停止。`
          : `筛选失败：最终筛选状态不匹配，本轮已停止。${finalFilterStates.map((item) => `${item.groupKey}=${item.expectedValue}, selected=${item.selectedTexts.join(',') || 'none'}, matched=${item.matched ? 'true' : 'false'}`).join(' | ')}`);
      }
      if (postFilterSurface?.navigated) {
        await ensureProxyReady(tabId, currentFrontendTabId, '筛选点击后结果页恢复');
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (requiresPostFilterGuard && finalFilterConfirmed) {
        const droppedBufferedCount = bufferedSearchEventsRef.current.length;
        bufferedSearchEventsRef.current = [];
        updateCountDiagnostics({
          bufferedMatchedCount: 0,
        });
        appendFilterDebugEntry({
          stage: 'request',
          message: '已清空筛选点击前缓存请求',
          detail: `droppedBufferedCount=${droppedBufferedCount} | clickedAt=${filterPostClickActivatedAtRef.current || 0}`,
        });
      }
      updateStatus(
        'collecting',
        requiresPostFilterGuard
          ? finalFilterConfirmed
            ? formatCollectionProgressText({
              phase: 'collecting',
              currentCount: dataRef.current.length,
              requestedCount: requestedNotesRef.current,
              candidateTargetCount: collectionTargetRef.current,
              showCandidateProgress: shouldShowCandidateProgress(),
            })
            : formatCollectionProgressText({
                phase: 'waiting',
                currentCount: dataRef.current.length,
                requestedCount: requestedNotesRef.current,
                candidateTargetCount: collectionTargetRef.current,
                showCandidateProgress: shouldShowCandidateProgress(),
              })
          : formatCollectionProgressText({
              phase: 'collecting',
              currentCount: dataRef.current.length,
              requestedCount: requestedNotesRef.current,
              candidateTargetCount: collectionTargetRef.current,
              showCandidateProgress: false,
            })
      );
      appendFilterDebugEntry({
        stage: 'request',
        message: '筛选结束摘要',
        detail: [
          `clickMode=${clickMode}`,
          `requestObserved=${requestObserved ? 'true' : 'false'}`,
          `requestMatched=${requestMatched ? 'true' : 'false'}`,
          `requestCommitted=${requestCommitted ? 'true' : 'false'}`,
          `requestConfirmed=${requestConfirmed ? 'true' : 'false'}`,
          `requestFilterConfirmed=${requestFilterConfirmed ? 'true' : 'false'}`,
          `uiConfirmed=${uiConfirmed ? 'true' : 'false'}`,
          `uiFilterConfirmed=${uiFilterConfirmed ? 'true' : 'false'}`,
          `finalFilterConfirmed=${finalFilterConfirmed ? 'true' : 'false'}`,
          `finalConfirmationSource=${finalConfirmationSource}`,
          `finalFilterSelectionConfirmed=${finalFilterSelectionConfirmed ? 'true' : 'false'}`,
          `resultSource=${strictPublishTimeVisibleSourceRef.current ? 'visible_dom' : (requestFilterConfirmed ? 'request' : (uiFilterConfirmed ? 'ui_confirmed' : (explicitEmptyResultRef.current ? 'empty' : 'none')))}`,
          `strictPublishTimeSource=${strictPublishTimeVisibleSourceRef.current ? 'visible_dom' : 'request_candidate_pool'}`,
          `uiSurfaceAccepted=${uiSurfaceAccepted ? 'true' : 'false'}`,
          `uiTypeParamAccepted=${uiTypeParamAccepted ? 'true' : 'false'}`,
          `clickedAt=${filterPostClickActivatedAtRef.current || 0}`,
          `bufferedMatchedCount=${latestCountDiagnosticsRef.current.bufferedMatchedCount}`,
          `releasedIntoDataCount=${releasedBufferedRequestCountRef.current}`,
          `lastObservedSearchRequestAt=${lastObservedSearchRequestAtRef.current || 0}`,
          `lastMatchedSearchRequestAt=${lastMatchedSearchRequestAtRef.current || 0}`,
          `lastFilterMismatchReason=${lastFilterMismatchReasonRef.current || 'none'}`,
        ].join(' | '),
      });
    } catch (e: any) {
      console.error("[Scraper] 筛选切换失败", e);
      appendFilterDebugEntry({
        stage: 'error',
        message: '筛选应用失败',
        detail: e?.message || '未知错误',
      });
      throw new Error(`筛选应用失败: ${e.message || '未知错误'}`);
    } finally {
      filterRequestCaptureActiveRef.current = false;
      await runOptionalAsyncCleanup(detachDebuggerIfNeeded).catch((error) => {
        appendFilterDebugEntry({
          stage: 'debugger',
          message: '筛选流程 detach debugger 失败',
          detail: error instanceof Error ? error.message : String(error || 'unknown'),
        });
        console.warn('[Scraper] 筛选流程 detach debugger 失败', error);
      });
    }

    console.log("[Scraper] 搜索及排序流程执行完毕");
  };

  const searchReadyRef = useRef(false);
  const resultFeedEndedRef = useRef(false);

  const resetScrapeRuntime = useCallback((maxNotes: number, filters: SearchFilters, options?: StartScrapingOptions) => {
    maxNotesRef.current = maxNotes;
    requestedNotesRef.current = maxNotes;
    strictPublishTimeVisibleSourceRef.current = shouldCollectStrictPublishTimeFromVisibleDom(filters);
    collectionTargetRef.current = maxNotes;
    enableCommentsRef.current = Boolean(options?.enableComments);
    maxCommentsPerNoteRef.current = Math.max(1, Math.min(options?.maxCommentsPerNote || 12, 20));
    setFilterDebugEntries([]);
    setCommentDebugEntries([]);
    searchReadyRef.current = false;
    resultFeedEndedRef.current = false;
    lastObservedSearchRequestAtRef.current = 0;
    lastMatchedSearchRequestAtRef.current = 0;
    lastAcceptedListActivityAtRef.current = 0;
    listCollectionStartedAtRef.current = 0;
    lastFilterMismatchReasonRef.current = '';
    lastSearchRequestSnapshotRef.current = '';
    filterRequestIndexRef.current = 0;
    filterPostClickActivatedAtRef.current = null;
    filterRequestCaptureStartedAtRef.current = null;
    filterRequestCaptureActiveRef.current = false;
    filterRequestObservedBaselineRef.current = 0;
    filterRequestMatchedBaselineRef.current = 0;
    requiresPostFilterGuardRef.current = false;
    requestObservedRef.current = false;
    requestMatchedRef.current = false;
    requestCommittedRef.current = false;
    domFallbackUsedRef.current = false;
    requestDrivenCollectionStartedRef.current = false;
    requestBridgeFailureLoggedRef.current = false;
    explicitEmptyResultRef.current = false;
    collectionTopUpUsedRef.current = false;
    strictVisibleRequestItemsRef.current = [];
    bufferedSearchEventsRef.current = [];
    releasedBufferedRequestCountRef.current = 0;
    latestCountDiagnosticsRef.current = {
      bufferedMatchedCount: 0,
      releasedIntoDataCount: 0,
      dataCountBeforeEnrichment: 0,
      formattedCount: 0,
    };
    setCollectionResultMeta(null);
    setData([]);
    activeSessionRef.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeFiltersRef.current = filters;
    activeKeywordRef.current = '';
    activeEnrichmentSessionRef.current = '';
    isEnrichmentRunningRef.current = false;
    enrichmentPhaseRef.current = 'idle';
    enteredEnrichmentSessionRef.current = '';
    lastCompletedEnrichmentSessionRef.current = '';
    lastEnrichmentSkipSignatureRef.current = '';
  }, []);

  const beginCollectionFlow = useCallback(async (keyword: string, filters: SearchFilters, currentTabId: number): Promise<XhsOperationResult> => {
    try {
      if (tab?.id) {
        await ensureProxyReady(currentTabId, tab.id, '采集页初始化');
      }
      await executeSearch(keyword, filters, currentTabId, tab?.id || 0);
    } catch (e: any) {
      console.error("[Scraper] 执行搜索流程异常:", e);
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: `采集流程异常: ${e.message}`,
      };
      updateStatus('idle', result.message);
      setIsScraping(false);
      clearLoginWait();
      await closeWorkerTab(currentTabId);
      return result;
    }

    console.log("[Scraper] 搜索和筛选动作完成，开始进入滚动采集阶段");
    searchReadyRef.current = true;
    listCollectionStartedAtRef.current = Date.now();
    clearLoginWait();
    updateStatus(
      'collecting',
      requiresPostFilterGuardRef.current
        ? formatCollectionProgressText({
            phase: 'waiting',
            currentCount: dataRef.current.length,
            requestedCount: requestedNotesRef.current,
            candidateTargetCount: collectionTargetRef.current,
            showCandidateProgress: shouldShowCandidateProgress(),
          })
        : `正在采集列表... (${dataRef.current.length}/${requestedNotesRef.current})`
    );
    return {
      success: true,
      message: "采集任务已启动，正在等待插件返回结果。",
    };
  }, [clearLoginWait, closeWorkerTab, ensureProxyReady, executeSearch, tab?.id, updateStatus]);

  const waitForLoginAndResume = useCallback((workerTabId: number, request: PendingScrapeRequest) => {
    clearLoginWait();
    pendingScrapeRequestRef.current = request;
    loginWaitStartedAtRef.current = Date.now();
    updateStatus('waiting_login', '已打开小红书页面，请完成登录，登录成功后将自动继续采集。');

    loginPollTimerRef.current = window.setInterval(async () => {
      if (abortRef.current) {
        clearLoginWait();
        return;
      }
      if (loginPollInFlightRef.current) {
        return;
      }
      if (!extension) {
        clearLoginWait();
        setIsScraping(false);
        updateStatus('idle', '插件连接已断开，采集已取消。');
        return;
      }
      if (workerTab?.id !== workerTabId || !pendingScrapeRequestRef.current) {
        clearLoginWait();
        setIsScraping(false);
        updateStatus('idle', '采集标签页已关闭，无法继续等待登录。');
        return;
      }
      if (Date.now() - loginWaitStartedAtRef.current >= STAGE_TIMEOUTS.loginWaitMs) {
        clearLoginWait();
        setIsScraping(false);
        updateStatus('idle', '等待小红书登录超时，请重新开始采集。');
        void closeWorkerTab(workerTabId);
        return;
      }

      loginPollInFlightRef.current = true;
      try {
        const loginStatus = await detectXhsLogin(extension, workerTabId);
        if (!loginStatus.loggedIn) {
          updateStatus('waiting_login', '已打开小红书页面，请完成登录，登录成功后将自动继续采集。');
          return;
        }

        const pendingRequest = pendingScrapeRequestRef.current;
        clearLoginWait();
        updateStatus('booting', '已检测到登录态，正在继续采集...');
        if (!pendingRequest) {
          setIsScraping(false);
          updateStatus('idle', '登录已完成，但未找到待恢复的采集任务。');
          return;
        }
        await beginCollectionFlow(pendingRequest.keyword, pendingRequest.filters, workerTabId);
      } catch (error) {
        console.warn('[Scraper] 登录等待轮询失败:', error);
      } finally {
        loginPollInFlightRef.current = false;
      }
    }, 2000);
  }, [beginCollectionFlow, clearLoginWait, closeWorkerTab, extension, updateStatus, workerTab?.id]);

  const finalizeNotesForEnrichment = useCallback(async (workerTabId: number) => {
    const candidateItems = [...dataRef.current];
    const limit = requestedNotesRef.current;
    const useVisibleDomSource = strictPublishTimeVisibleSourceRef.current;
    const trustRequestQueue = !useVisibleDomSource && hasStrictPublishTimeFilter(activeFiltersRef.current) && requestCommittedRef.current;
    const visibleResult = await collectVisibleSearchNotes(workerTabId).catch(() => null);
    const visibleNotes = Array.isArray(visibleResult?.notes) ? visibleResult!.notes : [];
    const normalizedVisibleItems = visibleNotes
      .map(normalizeSearchNoteItem)
      .filter(Boolean);
    const strictVisibleBackfilled = backfillVisibleDomNotesWithRequestCache({
      visibleItems: normalizedVisibleItems,
      requestItems: strictVisibleRequestItemsRef.current,
    });

    if (useVisibleDomSource && normalizedVisibleItems.length > 0) {
      commitVisibleDomNotes(visibleNotes, 'enrichment_finalize');
    }

    const existingById = new Map(
      candidateItems
        .filter((item) => item?.id)
        .map((item) => [String(item.id), item] as const),
    );
    const visibleById = new Map(
      normalizedVisibleItems
        .map((item: any) => [String(item.id), item] as const),
    );

    const finalItems: any[] = [];
    let tokenRefreshedCount = 0;
    let visibleMissingCandidateCount = 0;

    const mergeVisibleFields = (item: any, visibleItem: any) => {
      if (!visibleItem) return item;
      if (
        (!item.noteUrl && visibleItem.noteUrl) ||
        (!item.xsec_token && visibleItem.xsec_token)
      ) {
        tokenRefreshedCount += 1;
      }
      return {
        ...item,
        noteUrl: item.noteUrl || visibleItem.noteUrl,
        xsec_token: item.xsec_token || visibleItem.xsec_token,
        note_card: {
          ...(item.note_card || {}),
          ...(visibleItem.note_card || {}),
        },
      };
    };

    if (useVisibleDomSource) {
      strictVisibleBackfilled.items.forEach((visibleItem: any) => {
        const id = String(visibleItem?.id || '');
        if (!id || finalItems.some((candidate) => String(candidate?.id || '') === id)) return;
        finalItems.push(mergeVisibleFields(visibleItem, visibleById.get(id)));
      });
      appendFilterDebugEntry({
        stage: 'request',
        message: strictVisibleBackfilled.tokenMissingCount > 0
          ? 'strict visible_dom token backfill missed'
          : 'strict visible_dom candidate merged with request token',
        detail: `requestCacheCount=${strictVisibleRequestItemsRef.current.length} | tokenBackfilledCount=${strictVisibleBackfilled.tokenBackfilledCount} | tokenMissingCount=${strictVisibleBackfilled.tokenMissingCount} | strictPublishTimeSource=visible_dom`,
      });
      return {
        items: finalItems.slice(0, limit),
        fallbackItems: finalItems.slice(0, limit),
        candidateCount: normalizedVisibleItems.length,
        finalOutputCount: finalItems.slice(0, limit).length,
        finalOrderSource: finalItems.length > 0 ? 'visible_dom' : (candidateItems.length > 0 ? 'existing_queue' : 'unknown'),
        tokenRefreshedCount,
        visibleMissingCandidateCount,
        trustRequestQueue: false,
      };
    }

    candidateItems.forEach((item) => {
      if (finalItems.length >= limit) return;
      const id = String(item?.id || '');
      if (!id || finalItems.some((candidate) => String(candidate?.id || '') === id)) return;
      finalItems.push(mergeVisibleFields(item, visibleById.get(id)));
    });

    normalizedVisibleItems.forEach((visibleItem: any) => {
        const id = String(visibleItem.id || '');
        if (!id || existingById.has(id)) return;
        visibleMissingCandidateCount += 1;
        if (trustRequestQueue || finalItems.length >= limit) return;
        finalItems.push(visibleItem);
      });

    const finalOrderSource = trustRequestQueue
      ? 'request_queue'
      : (finalItems.length > 0 && visibleById.size > 0 ? 'visible_dom' : 'existing_queue');
    const fallbackItems = candidateItems.slice(0, limit);
    return {
      items: finalItems.slice(0, limit),
      fallbackItems,
      candidateCount: candidateItems.length,
      finalOutputCount: finalItems.slice(0, limit).length,
      finalOrderSource,
      tokenRefreshedCount,
      visibleMissingCandidateCount,
      trustRequestQueue,
    };
  }, [appendFilterDebugEntry, collectVisibleSearchNotes, commitVisibleDomNotes]);

  const runPostListEnrichment = useCallback(async (workerTabId: number) => {
    const sessionId = activeSessionRef.current;
    const skipReason = getPostListEnrichmentSkipReason({
      sessionId,
      lastCompletedSessionId: lastCompletedEnrichmentSessionRef.current,
      enteredSessionId: enteredEnrichmentSessionRef.current,
      isRunning: isEnrichmentRunningRef.current,
      activeEnrichmentSessionId: activeEnrichmentSessionRef.current,
    });
    if (skipReason === 'completed') {
      const skipSignature = `${sessionId}:completed`;
      if (lastEnrichmentSkipSignatureRef.current !== skipSignature) {
        lastEnrichmentSkipSignatureRef.current = skipSignature;
        appendFilterDebugEntry({
          stage: 'request',
          message: '当前 session 已完成，跳过重复 enrichment',
          detail: `session=${sessionId || 'unknown'}`,
        });
      }
      return;
    }
    if (skipReason === 'active') {
      if (lastDuplicateEnrichmentPhaseRef.current !== enrichmentPhaseRef.current) {
        lastDuplicateEnrichmentPhaseRef.current = enrichmentPhaseRef.current;
        appendFilterDebugEntry({
          stage: 'request',
          message: '忽略重复 enrichment 触发',
          detail: `session=${sessionId || 'unknown'} | phase=${enrichmentPhaseRef.current}`,
        });
      }
      return;
    }
    if (skipReason === 'entered') {
      const skipSignature = `${sessionId}:entered`;
      if (lastEnrichmentSkipSignatureRef.current !== skipSignature) {
        lastEnrichmentSkipSignatureRef.current = skipSignature;
        appendFilterDebugEntry({
          stage: 'request',
          message: '当前 session 已进入 enrichment，跳过重复启动',
          detail: `session=${sessionId || 'unknown'} | phase=${enrichmentPhaseRef.current}`,
        });
      }
      return;
    }

    lastDuplicateEnrichmentPhaseRef.current = 'idle';
    lastEnrichmentSkipSignatureRef.current = '';
    enteredEnrichmentSessionRef.current = sessionId;
    activeEnrichmentSessionRef.current = sessionId;
    isEnrichmentRunningRef.current = true;
    enrichmentPhaseRef.current = 'details';
    console.log("[Scraper] 列表采集完成，开始获取正文详情...");
    const finalized = await finalizeNotesForEnrichment(workerTabId);
    const finalizedTokenCount = finalized.items.filter((item) => typeof item?.xsec_token === 'string' && item.xsec_token.trim()).length;
    const fallbackTokenCount = finalized.fallbackItems.filter((item) => typeof item?.xsec_token === 'string' && item.xsec_token.trim()).length;
    const shouldFallbackToCandidateQueue = finalized.items.length > 0 && finalizedTokenCount === 0 && fallbackTokenCount > 0;
    const shouldStopForMissingTokens = shouldStopEnrichmentForMissingTokens({
      finalizedTokenCount,
      fallbackTokenCount,
    });
    const items = shouldFallbackToCandidateQueue ? finalized.fallbackItems : finalized.items;
    const shouldTrustStrictRequestPublishTime = (
      (finalized.trustRequestQueue || finalized.finalOrderSource === 'visible_dom') &&
      !shouldFallbackToCandidateQueue
    );
    if (items.length === 0 || shouldStopForMissingTokens) {
      const failureReason = shouldStopForMissingTokens
        ? '搜索请求主链未捕获到可用结果，页面列表缺少 xsec_token，已阻止详情页正文兜底。'
        : (
          strictPublishTimeVisibleSourceRef.current
            ? '严格发布时间页面稳定后未采到可见笔记，已停止后续补抓。'
            : '严格筛选已生效，但请求主链未向正式队列写入数据，已停止后续补抓。'
        );
      appendFilterDebugEntry({
        stage: 'error',
        message: '正文阶段启动失败',
        detail: failureReason,
      });
      if (shouldStopForMissingTokens) {
        appendFilterDebugEntry({
          stage: 'error',
          message: '采集失败摘要',
          detail: `requestChainCaptured=false | uiVisibleListOnly=${finalized.finalOrderSource === 'visible_dom' ? 'true' : 'false'} | finalizedTokenCount=${finalizedTokenCount} | fallbackTokenCount=${fallbackTokenCount} | detailDomFallbackBlocked=true`,
        });
      }
      setIsScraping(false);
      updateStatus(
        'idle',
        shouldStopForMissingTokens
          ? '搜索请求主链未接入，页面列表缺少 xsec_token，本轮已停止正文补抓。'
          : (
            strictPublishTimeVisibleSourceRef.current
              ? '严格发布时间页面稳定后没有可见结果，本轮已停止。'
              : '筛选已生效，但请求主链未接上正式队列，本轮已停止。'
          )
      );
      void closeWorkerTab(workerTabId);
      activeEnrichmentSessionRef.current = '';
      isEnrichmentRunningRef.current = false;
      enrichmentPhaseRef.current = 'idle';
      return;
    }
    const formattedPreviewCount = formatScrapedNotes(items).length;
    updateCountDiagnostics({
      dataCountBeforeEnrichment: items.length,
      formattedCount: formattedPreviewCount,
    });
    appendFilterDebugEntry({
      stage: 'request',
      message: '列表数量诊断',
      detail: `bufferedMatchedCount=${latestCountDiagnosticsRef.current.bufferedMatchedCount} | releasedIntoDataCount=${latestCountDiagnosticsRef.current.releasedIntoDataCount} | candidateCount=${finalized.candidateCount} | finalOutputCount=${finalized.finalOutputCount} | finalOrderSource=${finalized.finalOrderSource} | tokenRefreshedCount=${finalized.tokenRefreshedCount} | visibleMissingCandidateCount=${finalized.visibleMissingCandidateCount} | finalizedTokenCount=${finalizedTokenCount} | fallbackTokenCount=${fallbackTokenCount} | detailQueueSource=${shouldFallbackToCandidateQueue ? 'candidate_fallback' : 'finalized'} | dataCountBeforeEnrichment=${items.length} | formattedCount=${formattedPreviewCount}`,
    });
    if (shouldFallbackToCandidateQueue) {
      appendFilterDebugEntry({
        stage: 'request',
        message: '最终正文队列缺少 token，已回退到候选队列',
        detail: `finalizedTokenCount=${finalizedTokenCount} | fallbackTokenCount=${fallbackTokenCount} | requestedCount=${requestedNotesRef.current}`,
      });
    }
    appendFilterDebugEntry({
      stage: 'request',
      message: '已满足正文启动条件',
      detail: `candidateCount=${finalized.candidateCount} | finalOutputCount=${finalized.finalOutputCount} | requestedCount=${requestedNotesRef.current} | reason=target_ready`,
    });
    appendFilterDebugEntry({
      stage: 'request',
      message: '正文阶段开始',
      detail: `session=${sessionId || 'unknown'} | notes=${items.length}`,
    });
    const queueMetrics = summarizeQueueMetrics(items);
    appendFilterDebugEntry({
      stage: 'request',
      message: '正文阶段输入摘要',
      detail: `notes=${items.length} | notesWithNoteUrl=${queueMetrics.notesWithNoteUrl} | notesWithToken=${queueMetrics.notesWithToken} | notesMissingEither=${queueMetrics.notesMissingEither}`,
    });
    const enrichedItems = items.map((item) => ({ ...item }));

    try {
      const preflightCount = Math.min(2, enrichedItems.length);
      let preflightSuccessCount = 0;
      for (let i = 0; i < preflightCount; i += 1) {
        const item = enrichedItems[i];
        if (!item?.id) continue;
        const token = item.xsec_token || item.note_card?.xsec_token || item.note_card?.xsecToken || item.note_card?.token || '';
        const detail = await fetchNoteDetail(item.id, token, item.noteUrl);
        if (detail) {
          preflightSuccessCount += 1;
          enrichedItems[i] = applyFetchedDetailToNote(item, detail);
        }
      }
      appendFilterDebugEntry({
        stage: 'request',
        message: '正文预检结果',
        detail: `preflightCount=${preflightCount} | preflightSuccessCount=${preflightSuccessCount} | detailFetchMode=${preflightSuccessCount > 0 ? 'html_initial_state' : 'detail_dom_fallback'}`,
      });

      for (let i = 0; i < enrichedItems.length; i++) {
        if (abortRef.current || activeSessionRef.current !== sessionId) break;

        updateStatus('enriching', `正在补抓正文详情... (${i + 1}/${enrichedItems.length})`);
        const item = enrichedItems[i];

        if (item?.detail && typeof item.detail === 'object') {
          setData([...enrichedItems]);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 220 + 120));
          continue;
        }

        if (item.id) {
          const token = item.xsec_token || item.note_card?.xsec_token || item.note_card?.xsecToken || item.note_card?.token || '';
          let detail = await fetchNoteDetail(item.id, token, item.noteUrl);
          let detailFetchMode = 'html_initial_state';
          if (shouldAllowDetailDomFallback({ token, detail })) {
            detail = await fetchNoteDetailFromDetailDom(item.id, token, item.noteUrl);
            detailFetchMode = 'detail_dom_fallback';
          } else if (!detail && !String(token || '').trim()) {
            appendFilterDebugEntry({
              stage: 'request',
              message: '已阻止详情页正文兜底',
              detail: `noteId=${item.id} | reason=missing_xsec_token | detailFetchMode=blocked_before_detail_dom_fallback`,
            });
          }
          console.log(`[Scraper] 笔记 ${item.id} 的详情获取结果:`, detail ? "成功" : "失败", detail);
          if (detail) {
            enrichedItems[i] = applyFetchedDetailToNote(item, detail);
          } else {
            appendFilterDebugEntry({
              stage: 'request',
              message: '正文兜底已启用',
              detail: `noteId=${item.id} | fallbackReason=detail_fetch_failed | detailFetchMode=${detailFetchMode}`,
            });
          }
        }

        setData([...enrichedItems]);
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 220 + 120));
      }

      appendFilterDebugEntry({
        stage: 'request',
        message: '正文阶段完成',
        detail: `session=${sessionId || 'unknown'} | notes=${enrichedItems.length} | aborted=${abortRef.current}`,
      });
      const enrichedFormattedNotes = formatScrapedNotes(enrichedItems);
      const localPublishTimeFilteredNotes = filterNotesByPublishTime(enrichedFormattedNotes, activeFiltersRef.current?.publishTime);
      const effectiveNotes = shouldTrustStrictRequestPublishTime ? enrichedFormattedNotes : localPublishTimeFilteredNotes;
      const detailSuccessCount = enrichedItems.filter((item) => item?.detail && typeof item.detail === 'object').length;
      const timeResolvedCount = enrichedFormattedNotes.filter((item) => item.time !== undefined || Boolean(item.publishedAtLabel)).length;
      const publishTimeRejectedCount = enrichedFormattedNotes.length - localPublishTimeFilteredNotes.length;
      const publishTimeUnresolvedCount = enrichedFormattedNotes.filter((item) => item.time === undefined && !item.publishedAtLabel).length;
      const recentTimeMatchCount = localPublishTimeFilteredNotes.filter((item) => item.time !== undefined || Boolean(item.publishedAtLabel)).length;
      const sourceById = new Map<string, CollectionResultMeta['finalOrderSource']>(
        items.map((item) => [String(item?.id || '').trim(), finalized.finalOrderSource as CollectionResultMeta['finalOrderSource']])
      );
      const publishTimeDiagnostics = buildPublishTimeDiagnostics(
        enrichedFormattedNotes,
        activeFiltersRef.current?.publishTime,
        sourceById,
      );
      appendFilterDebugEntry({
        stage: 'request',
        message: '正文阶段结果摘要',
        detail: `detailSuccessCount=${detailSuccessCount} | timeResolvedCount=${timeResolvedCount} | publishTimeRejectedCount=${publishTimeRejectedCount} | publishTimeUnresolvedCount=${publishTimeUnresolvedCount} | recentTimeMatchCount=${recentTimeMatchCount} | effectiveNotesCount=${effectiveNotes.length} | trustStrictRequestPublishTime=${shouldTrustStrictRequestPublishTime ? 'true' : 'false'} | strictPublishTimeSource=${finalized.finalOrderSource}`,
      });
      setCollectionResultMeta({
        sessionId,
        appliedPublishTime: String(activeFiltersRef.current?.publishTime || ''),
        trustStrictRequestPublishTime: shouldTrustStrictRequestPublishTime,
        finalOrderSource: (finalized.finalOrderSource || 'unknown') as CollectionResultMeta['finalOrderSource'],
        publishTimeRejectedCount,
        formattedCount: enrichedFormattedNotes.length,
        effectiveCount: effectiveNotes.length,
      });
      appendFilterDebugEntry({
        stage: 'request',
        message: '发布时间逐条诊断',
        detail: publishTimeDiagnostics.map((item) => (
          `id=${item.id} | source=${item.source} | time=${item.time ?? 'none'} | publishedAtLabel=${item.publishedAtLabel || 'none'} | matchesLocalWindow=${item.matchesLocalWindow ? 'true' : 'false'}`
        )).join(' || ') || 'none',
      });

      if (!abortRef.current && activeSessionRef.current === sessionId && enableCommentsRef.current) {
        enrichmentPhaseRef.current = 'comments';
        appendCommentDebugEntry({
          stage: 'start',
          message: '评论阶段开始',
          detail: `session=${sessionId || 'unknown'} | notes=${enrichedItems.length} | maxCommentsPerNote=${maxCommentsPerNoteRef.current}`,
        });

        for (let i = 0; i < enrichedItems.length; i++) {
          if (abortRef.current || activeSessionRef.current !== sessionId) break;

          const item = enrichedItems[i];
          if (!item.id) continue;

          const commentTarget = resolveCommentEnrichment(item);
          const commentToken = commentTarget.token;

          if (!commentToken) {
            appendCommentDebugEntry({
              noteId: item.id,
              stage: 'skip',
              message: '未拿到 xsec_token，跳过评论补抓',
              detail: commentTarget.skipReason || 'skip comment enrichment because note has no xsec_token',
            });
            continue;
          }

          updateStatus('enriching', `正在补抓评论... (${i + 1}/${enrichedItems.length})`);
          const comments = await fetchNoteCommentsFromDetailDom(item.id, commentToken, item.noteUrl, maxCommentsPerNoteRef.current, workerTabId);
          console.log(`[Scraper][Comments] 笔记评论补抓结果`, {
            noteId: item.id,
            fetchedCount: comments.length,
            commentTokenPreview: commentToken.slice(0, 12) || 'none',
          });
          if (comments.length > 0) {
            enrichedItems[i] = applyFetchedCommentsToNote(item, comments);
          }

          setData([...enrichedItems]);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 900 + 500));
        }

        appendCommentDebugEntry({
          stage: 'complete',
          message: '评论阶段完成',
          detail: `session=${sessionId || 'unknown'} | notes=${enrichedItems.length} | aborted=${abortRef.current}`,
        });
      }

      if (!abortRef.current && activeSessionRef.current === sessionId) {
        setData(enrichedItems);
        lastCompletedEnrichmentSessionRef.current = sessionId;
        setIsScraping(false);
        updateStatus('done', `采集完成，共 ${enrichedItems.length} 条`);
        void closeWorkerTab(workerTabId);
      }
    } catch (error) {
      appendFilterDebugEntry({
        stage: 'error',
        message: '正文阶段收口失败',
        detail: `session=${sessionId || 'unknown'} | phase=${enrichmentPhaseRef.current} | error=${error instanceof Error ? error.message : String(error || 'unknown')}`,
      });
      if (activeSessionRef.current === sessionId) {
        setIsScraping(false);
        updateStatus('idle', '正文补抓收口失败，请展开筛选排查日志查看错误后重试。');
        void closeWorkerTab(workerTabId);
      }
    } finally {
      if (activeEnrichmentSessionRef.current === sessionId) {
        activeEnrichmentSessionRef.current = '';
        isEnrichmentRunningRef.current = false;
        enrichmentPhaseRef.current = 'idle';
      }
    }
  }, [appendCommentDebugEntry, appendFilterDebugEntry, closeWorkerTab, fetchNoteCommentsFromDetailDom, fetchNoteDetail, summarizeQueueMetrics, updateCountDiagnostics, updateStatus]);

  // Auto scroll
  useEffect(() => {
    if (!extension || workerTab?.id === undefined || !isScraping) return;
    const workerTabId = workerTab.id;
    let running = false;
    const scroll = () => {
      const lastNote = document.querySelector(".note-item:last-of-type") as HTMLElement | null;
      const endContainer = document.querySelector(".end-container") as HTMLElement | null;
      const endText = (endContainer?.textContent || '').trim();
      const hasEndContainer = Boolean(endContainer && endContainer.offsetHeight > 0);
      if (hasEndContainer) {
        endContainer?.scrollIntoView({ behavior: "auto", block: "center" });
      } else {
        lastNote?.scrollIntoView({ behavior: "auto", block: "center" });
      }

      return {
        endVisible: hasEndContainer,
        endText,
        lastNoteFound: Boolean(lastNote),
      };
    };

    let lastCount = 0;
    let lastGrowthAt = 0;

    const timer = window.setInterval(() => {
      const strictRequestTargetReached = shouldFinishStrictRequestCollection({
        enabled: hasStrictPublishTimeFilter(activeFiltersRef.current) && !strictPublishTimeVisibleSourceRef.current,
        requestCommitted: requestCommittedRef.current,
        currentCount: dataRef.current.length,
        requestedCount: requestedNotesRef.current,
      });
      if (strictRequestTargetReached && !resultFeedEndedRef.current) {
        appendFilterDebugEntry({
          stage: 'request',
          message: '严格发布时间请求结果已满足目标，停止继续滚动',
          detail: `strictPublishTimeSource=request_queue | currentCount=${dataRef.current.length} | requestedCount=${requestedNotesRef.current} | reason=target_reached`,
        });
        resultFeedEndedRef.current = true;
      }

      const strictVisibleTargetReached = shouldFinishStrictVisibleDomCollection({
        enabled: strictPublishTimeVisibleSourceRef.current,
        currentCount: dataRef.current.length,
        requestedCount: requestedNotesRef.current,
      });
      if (strictVisibleTargetReached && !resultFeedEndedRef.current) {
        appendFilterDebugEntry({
          stage: 'request',
          message: '严格发布时间页面结果已满足目标，停止继续滚动',
          detail: `strictPublishTimeSource=visible_dom | currentCount=${dataRef.current.length} | requestedCount=${requestedNotesRef.current} | reason=target_reached`,
        });
        resultFeedEndedRef.current = true;
      }

      if (!searchReadyRef.current) {
        updateStatus('searching', `正在等待搜索结果页与筛选完成... (${dataRef.current.length}/${requestedNotesRef.current})`);
        return;
      }

      if (
        abortRef.current ||
        (!requiresPostFilterGuardRef.current && dataRef.current.length >= requestedNotesRef.current) ||
        strictRequestTargetReached ||
        strictVisibleTargetReached ||
        resultFeedEndedRef.current
      ) {
        window.clearInterval(timer);
        scrollTimerRef.current = null;

        if (abortRef.current) {
          setIsScraping(false);
          updateStatus('idle', "采集已中断");
          void closeWorkerTab(workerTabId);
          return;
        }

        if (resultFeedEndedRef.current && explicitEmptyResultRef.current && dataRef.current.length === 0) {
          setIsScraping(false);
          updateStatus('done', '采集完成，当前筛选条件下没有结果。');
          void closeWorkerTab(workerTabId);
          return;
        }

        const skipReason = getPostListEnrichmentSkipReason({
          sessionId: activeSessionRef.current,
          lastCompletedSessionId: lastCompletedEnrichmentSessionRef.current,
          enteredSessionId: enteredEnrichmentSessionRef.current,
          isRunning: isEnrichmentRunningRef.current,
          activeEnrichmentSessionId: activeEnrichmentSessionRef.current,
        });
        if (!skipReason) {
          void runPostListEnrichment(workerTabId);
        }

        return;
      }

      if (dataRef.current.length === 0) {
        const waitingForMatchedResults = Boolean(
          lastObservedSearchRequestAtRef.current > 0 &&
          lastMatchedSearchRequestAtRef.current < lastObservedSearchRequestAtRef.current &&
          lastFilterMismatchReasonRef.current
        );
      if (strictPublishTimeVisibleSourceRef.current && !running) {
        running = true;
        void syncStrictPublishTimeVisibleNotes(workerTabId, 'scroll_waiting', activeKeywordRef.current || undefined)
          .catch(console.error)
          .finally(() => { running = false; });
      }
      updateStatus(
        'collecting',
        waitingForMatchedResults
            ? formatCollectionProgressText({
                phase: 'waiting',
                currentCount: dataRef.current.length,
                requestedCount: requestedNotesRef.current,
                candidateTargetCount: collectionTargetRef.current,
                showCandidateProgress: shouldShowCandidateProgress(),
              })
            : formatCollectionProgressText({
                phase: 'collecting',
                currentCount: dataRef.current.length,
                requestedCount: requestedNotesRef.current,
                candidateTargetCount: collectionTargetRef.current,
                showCandidateProgress: shouldShowCandidateProgress(),
              })
        );
        const noResultTimeoutMs = requiresPostFilterGuardRef.current ? STAGE_TIMEOUTS.filterApplyMs : STAGE_TIMEOUTS.searchResultMs;
        if (
          listCollectionStartedAtRef.current > 0 &&
          Date.now() - listCollectionStartedAtRef.current >= noResultTimeoutMs
        ) {
          updateStatus('collecting', `等待结果超时，结束列表采集... (${formatCollectionProgressText({
            phase: 'collecting',
            currentCount: dataRef.current.length,
            requestedCount: requestedNotesRef.current,
            candidateTargetCount: collectionTargetRef.current,
            showCandidateProgress: shouldShowCandidateProgress(),
          }).replace(/^正在采集候选列表\.\.\. \(|^正在采集列表\.\.\. \(|\)$/g, '')})`);
          resultFeedEndedRef.current = true;
        }
        return;
      }

      updateStatus('collecting', formatCollectionProgressText({
        phase: 'collecting',
        currentCount: dataRef.current.length,
        requestedCount: requestedNotesRef.current,
        candidateTargetCount: collectionTargetRef.current,
        showCandidateProgress: shouldShowCandidateProgress(),
      }));
      if (dataRef.current.length !== lastCount) {
        lastCount = dataRef.current.length;
        lastGrowthAt = Date.now();
        lastAcceptedListActivityAtRef.current = lastGrowthAt;
      }

      const lastActivityAt = Math.max(lastGrowthAt, lastAcceptedListActivityAtRef.current);
      if (
        dataRef.current.length > 0 &&
        lastActivityAt > 0 &&
        Date.now() - lastActivityAt >= STAGE_TIMEOUTS.listIdleMs
      ) {
        if (
          requiresPostFilterGuardRef.current &&
          !strictPublishTimeVisibleSourceRef.current &&
          dataRef.current.length < requestedNotesRef.current &&
          !collectionTopUpUsedRef.current
        ) {
          collectionTopUpUsedRef.current = true;
          collectionTargetRef.current = Math.min(
            Math.max(collectionTargetRef.current + Math.max(5, Math.ceil(requestedNotesRef.current * 0.5)), requestedNotesRef.current + 5),
            60,
          );
          lastAcceptedListActivityAtRef.current = Date.now();
          updateStatus(
            'collecting',
            `当前成品不足，补抓一小轮候选... (${formatCollectionProgressText({
              phase: 'collecting',
              currentCount: dataRef.current.length,
              requestedCount: requestedNotesRef.current,
              candidateTargetCount: collectionTargetRef.current,
              showCandidateProgress: true,
            }).replace(/^正在采集候选列表\.\.\. \(|^正在采集列表\.\.\. \(|\)$/g, '')})`
          );
          return;
        }
        updateStatus(
          'collecting',
          requestDrivenCollectionStartedRef.current
            ? formatCollectionProgressText({
                phase: 'stable',
                currentCount: dataRef.current.length,
                requestedCount: requestedNotesRef.current,
                candidateTargetCount: collectionTargetRef.current,
                showCandidateProgress: shouldShowCandidateProgress(),
              })
            : `当前仅拿到 DOM 可见结果，准备先补抓正文... (${formatCollectionProgressText({
                phase: 'collecting',
                currentCount: dataRef.current.length,
                requestedCount: requestedNotesRef.current,
                candidateTargetCount: collectionTargetRef.current,
                showCandidateProgress: shouldShowCandidateProgress(),
              }).replace(/^正在采集候选列表\.\.\. \(|^正在采集列表\.\.\. \(|\)$/g, '')})`
        );
        resultFeedEndedRef.current = true;
        return;
      }

      if (running) return;
      running = true;
      extension.invoke("web:runtime:evaluate", { tabId: workerTabId, args: [], code: scroll.toString() })
        .then(async (resp: any) => {
          const scrollResult = resp?.[0]?.result?.data || {};
          const endVisible = Boolean(scrollResult.endVisible);
          const endText = String(scrollResult.endText || '');
          const indicatesNoMore = /没有更多|到底了|THE END|end/i.test(endText || '');

          if (strictPublishTimeVisibleSourceRef.current) {
            await syncStrictPublishTimeVisibleNotes(workerTabId, 'scroll_tick', activeKeywordRef.current || undefined);
          }

          if (endVisible && indicatesNoMore) {
            if (
              requiresPostFilterGuardRef.current &&
              !strictPublishTimeVisibleSourceRef.current &&
              dataRef.current.length < requestedNotesRef.current &&
              !collectionTopUpUsedRef.current
            ) {
              collectionTopUpUsedRef.current = true;
              collectionTargetRef.current = Math.min(
                Math.max(collectionTargetRef.current + Math.max(5, Math.ceil(requestedNotesRef.current * 0.5)), requestedNotesRef.current + 5),
                60,
              );
              lastAcceptedListActivityAtRef.current = Date.now();
              updateStatus(
                'collecting',
                `当前成品不足，补抓一小轮候选... (${formatCollectionProgressText({
                  phase: 'collecting',
                  currentCount: dataRef.current.length,
                  requestedCount: requestedNotesRef.current,
                  candidateTargetCount: collectionTargetRef.current,
                  showCandidateProgress: true,
                }).replace(/^正在采集候选列表\.\.\. \(|^正在采集列表\.\.\. \(|\)$/g, '')})`
              );
              return;
            }
            updateStatus('collecting', formatCollectionProgressText({
              phase: 'end',
              currentCount: dataRef.current.length,
              requestedCount: requestedNotesRef.current,
              candidateTargetCount: collectionTargetRef.current,
              showCandidateProgress: shouldShowCandidateProgress(),
            }));
            resultFeedEndedRef.current = true;
          }
        })
        .catch(console.error)
        .finally(() => { running = false; });
    }, 1000);
    scrollTimerRef.current = timer;

    return () => window.clearInterval(timer);
  }, [closeWorkerTab, extension, isScraping, runPostListEnrichment, shouldShowCandidateProgress, syncStrictPublishTimeVisibleNotes, updateStatus, workerTab?.id]);

  useEffect(() => () => {
    clearLoginWait();
  }, [clearLoginWait]);

  const collectNoteByUrlWithBrowser = useCallback(async (
    url: string,
    options?: { enableComments?: boolean; maxCommentsPerNote?: number }
  ): Promise<XhsOperationResult<ScrapedNote>> => {
    if (!extension) {
      return {
        success: false,
        code: 'extension_unavailable',
        message: '插件未连接，无法执行浏览器态补抓。',
      };
    }

    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
      return {
        success: false,
        code: 'page_interaction_failed',
        message: '请先输入要补抓的小红书笔记链接。',
      };
    }

    let noteId = '';
    let xsecToken = '';
    try {
      const parsed = new URL(normalizedUrl);
      const matched = parsed.pathname.match(/\/explore\/([^/?#]+)/);
      noteId = String(matched?.[1] || '').trim();
      xsecToken = String(parsed.searchParams.get('xsec_token') || '').trim();
    } catch {
      return {
        success: false,
        code: 'page_interaction_failed',
        message: '链接格式不正确，无法从中识别笔记 ID。',
      };
    }

    if (!noteId) {
      return {
        success: false,
        code: 'page_interaction_failed',
        message: '当前链接不是可补抓的小红书 explore 笔记链接。',
      };
    }

    setIsScraping(true);
    updateStatus('booting', '正在尝试浏览器态补抓这条笔记...');
    try {
      let detail = await fetchNoteDetail(noteId, xsecToken, normalizedUrl);
      if (!detail) {
        updateStatus('collecting', '状态树未命中，正在尝试详情页 DOM 兜底...');
        detail = await fetchNoteDetailFromDetailDom(noteId, xsecToken, normalizedUrl);
      }

      if (!detail) {
        return {
          success: false,
          code: 'page_interaction_failed',
          message: '浏览器态补抓失败，未能从详情页提取正文和图片信息。',
        };
      }

      let comments: any[] = [];
      if (options?.enableComments && xsecToken) {
        updateStatus('collecting', '正文已拿到，正在补抓评论...');
        comments = await fetchNoteCommentsFromDetailDom(
          noteId,
          xsecToken,
          normalizedUrl,
          options?.maxCommentsPerNote || 12,
          0,
        );
      }

      const formatted = formatScrapedNotes([{
        id: noteId,
        noteUrl: normalizedUrl,
        xsec_token: xsecToken,
        detail,
        comments,
      }])[0];

      if (!formatted) {
        return {
          success: false,
          code: 'page_interaction_failed',
          message: '浏览器态补抓完成，但结果格式化失败。',
        };
      }

      updateStatus('done', '浏览器态补抓成功。');
      return {
        success: true,
        message: '浏览器态补抓成功。',
        data: formatted,
      };
    } catch (error) {
      console.error('[Scraper] 浏览器态 URL 补抓失败:', error);
      updateStatus('idle', '浏览器态补抓失败，请稍后重试。');
      return {
        success: false,
        code: 'page_interaction_failed',
        message: error instanceof Error ? error.message : '浏览器态补抓失败，请稍后重试。',
      };
    } finally {
      setIsScraping(false);
    }
  }, [extension, fetchNoteCommentsFromDetailDom, fetchNoteDetail, fetchNoteDetailFromDetailDom, updateStatus]);

  const startScraping = async (keyword: string, maxNotes: number, filters: SearchFilters, options?: StartScrapingOptions): Promise<XhsOperationResult> => {
    if (!extension) {
      const result = {
        success: false,
        code: "extension_unavailable" as const,
        message: "插件未连接，请先安装并连接浏览器扩展。",
      };
      updateStatus('idle', result.message);
      return result;
    }

    clearLoginWait();
    resetScrapeRuntime(maxNotes, filters, options);
    activeKeywordRef.current = keyword;
    logCurrentExtensionBuild('scrape_start_after_reset');

    if (!canUseInteractiveFilters(extension, filters)) {
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: "当前插件未提供筛选点击能力，请安装支持筛选操作的浏览器插件版本后重试。",
      };
      appendFilterDebugEntry({
        stage: 'error',
        message: '当前插件不支持交互式筛选点击',
        detail: `extension=${extension.name || 'unknown'} | filters=${JSON.stringify(filters)}`,
      });
      updateStatus('idle', result.message);
      return result;
    }

    if (hasActiveFilterOverrides(filters)) {
      const capability = await probeInteractiveFilterSupport(extension);
      if (!capability.supported) {
        const result = {
          success: false,
          code: "page_interaction_failed" as const,
          message: `当前插件未提供筛选点击能力：${capability.reason}`,
        };
        appendFilterDebugEntry({
          stage: 'error',
          message: '筛选能力探测失败',
          detail: `extension=${extension.name || 'unknown'} | reason=${capability.reason}`,
        });
        updateStatus('idle', result.message);
        return result;
      }
    }

    setIsScraping(true);
    abortRef.current = false;
    updateStatus('booting', `正在准备采集环境... (0/${requestedNotesRef.current})`);

    if (workerTab?.id !== undefined) {
      await closeWorkerTab(workerTab.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    const newTab = await createWorkerTab();
    if (!newTab) {
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: "创建采集标签页失败，请检查插件权限或页面状态。",
      };
      setIsScraping(false);
      updateStatus('idle', result.message);
      return result;
    }
    const currentTabId = newTab.id;

    if (currentTabId === undefined) {
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: "无法定位采集标签页，请重试。",
      };
      setIsScraping(false);
      updateStatus('idle', result.message);
      return result;
    }

    updateStatus('booting', '正在检查小红书登录状态...');
    const loginStatus = await detectXhsLogin(extension, currentTabId);
    if (!loginStatus.loggedIn) {
      waitForLoginAndResume(currentTabId, {
        keyword,
        maxNotes,
        filters,
        options,
      });
      return {
        success: true,
        message: '已打开小红书页面，请完成登录，登录成功后将自动继续采集。',
      };
    }

    return beginCollectionFlow(keyword, filters, currentTabId);
  };

  const stopScraping = () => {
    abortRef.current = true;
    clearLoginWait();
    setIsScraping(false);
    updateStatus('idle', "采集已中断");
    void closeWorkerTab();
  };

  return {
    startScraping,
    collectNoteByUrlWithBrowser,
    stopScraping,
    isScraping,
    data,
    collectionResultMeta,
    statusMessage,
    filterDebugEntries,
    commentDebugEntries,
    workerTab,
    createWorkerTab
  };
};
