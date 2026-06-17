import { describe, expect, it, vi } from 'vitest';
import {
  applyFetchedCommentsToNote,
  applyFetchedDetailToNote,
  backfillVisibleDomNotesWithRequestCache,
  buildFilterSelectionErrorMessage,
  buildPublishTimeDiagnostics,
  canUseInteractiveFilters,
  classifyFilterRecoveryState,
  decideSearchRequestGate,
  detectSearchItemMediaType,
  buildFinalFilterConfirmations,
  didCommitSearchRequest,
  didSelectExpectedCandidate,
  extractNoteDetailFromState,
  filterItemsByNoteType,
  getFinalFilterConfirmationStates,
  getPostListEnrichmentSkipReason,
  shouldSkipLocalPublishTimeFilter,
  isSelectedFilterCandidate,
  isFinalFilterSelectionConfirmed,
  looksLikeSearchNotesRequest,
  normalizeSearchNoteItem,
  hasExpectedFilterSelection,
  hasConfirmedFilterRequest,
  isLikelyStandaloneFilterTriggerText,
  isStrictFilterRequestConfirmed,
  isUiFilterConfirmed,
  isUiAppliedFilterConfirmed,
  doesUiTypeParamMatchFilters,
  shouldAllowDetailDomFallback,
  shouldRecoverUiConfirmedNotes,
  shouldAcceptUiAppliedSurface,
  shouldFinishStrictRequestCollection,
  shouldFinishStrictVisibleDomCollection,
  shouldStopEnrichmentForMissingTokens,
  shouldRecoverClosedFilterPanel,
  pickBufferedSearchEventsBeforeClick,
  pickBufferedSearchEventsForRelease,
  probeInteractiveFilterSupport,
  resolveFilterCandidateByTexts,
  requestMatchesFilters,
  resolveCommentEnrichment,
  summarizeFilterHitText,
  summarizeFilterProbeState,
  shouldCollectStrictPublishTimeFromVisibleDom,
  shouldUseDomFallback,
} from './useXhsScraper';
import { DEFAULT_SEARCH_FILTERS } from '../../types';
import { filterNotesByPublishTime } from '../../lib/scraperData';

describe('useXhsScraper helpers', () => {
  it('treats 普通笔记 as a valid 图文 filter match', () => {
    const result = requestMatchesFilters(
      {
        note_type: 'normal',
        filter_note_type: ['普通笔记'],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
      }
    );

    expect(result.matches).toBe(true);
    expect(result.reason).toBe('');
  });

  it('rejects 图文 requests that still carry 不限 tags', () => {
    const result = requestMatchesFilters(
      {
        note_type: '0',
        filter_note_type: ['不限'],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
      }
    );

    expect(result.matches).toBe(false);
    expect(result.reason).toContain('目标为图文');
  });

  it('rejects requests whose publishTime does not match the selected window', () => {
    const result = requestMatchesFilters(
      {
        note_type: 'normal',
        filter_note_type: ['普通笔记'],
        filter_note_time: ['一天内'],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      }
    );

    expect(result.matches).toBe(false);
    expect(result.reason).toContain('目标为一周内');
  });

  it('matches the real XHS request shape for 图文 and 一天内 filters', () => {
    const result = requestMatchesFilters(
      {
        keyword: '软件测试',
        note_type: 0,
        filters: [
          { type: 'sort_type', tags: ['general'] },
          { type: 'filter_note_type', tags: ['普通笔记'] },
          { type: 'filter_note_time', tags: ['一天内'] },
          { type: 'filter_note_range', tags: ['不限'] },
          { type: 'filter_pos_distance', tags: ['不限'] },
        ],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一天内',
      }
    );

    expect(result.matches).toBe(true);
    expect(result.reason).toBe('');
  });

  it('rejects real XHS request shapes when filter_note_time does not match the selected window', () => {
    const result = requestMatchesFilters(
      {
        keyword: '软件测试',
        note_type: 0,
        filters: [
          { type: 'sort_type', tags: ['general'] },
          { type: 'filter_note_type', tags: ['普通笔记'] },
          { type: 'filter_note_time', tags: ['一周内'] },
          { type: 'filter_note_range', tags: ['不限'] },
          { type: 'filter_pos_distance', tags: ['不限'] },
        ],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一天内',
      }
    );

    expect(result.matches).toBe(false);
    expect(result.reason).toContain('publishTime=一周内');
  });

  it('rejects strict noteType filters when the request carries no explicit noteType tag', () => {
    const result = requestMatchesFilters(
      {
        note_type: '0',
        filter_note_type: [],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
      }
    );

    expect(result.matches).toBe(false);
    expect(result.reason).toContain('缺少显式 noteType 标签');
  });

  it('rejects strict publishTime filters when the request carries no explicit publishTime tag', () => {
    const result = requestMatchesFilters(
      {
        note_type: 'normal',
        filter_note_type: ['普通笔记'],
      },
      {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      }
    );

    expect(result.matches).toBe(false);
    expect(result.reason).toContain('缺少显式 publishTime 标签');
  });

  it('recognizes search-note requests from known URL patterns', () => {
    expect(looksLikeSearchNotesRequest({
      url: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes',
    })).toBe(true);
  });

  it('recognizes search-note requests from request body hints even when URL differs', () => {
    expect(looksLikeSearchNotesRequest({
      url: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/something-else',
      body: {
        keyword: '软件',
        filters: [
          { type: 'filter_note_type', tags: ['普通笔记'] },
          { type: 'filter_note_time', tags: ['一周内'] },
        ],
      },
    })).toBe(true);
  });

  it('limits filter panel recovery attempts to avoid reopening in a loop', () => {
    expect(shouldRecoverClosedFilterPanel({
      itemRecoveryCount: 0,
      totalRecoveryCount: 0,
    })).toBe(true);

    expect(shouldRecoverClosedFilterPanel({
      itemRecoveryCount: 1,
      totalRecoveryCount: 0,
    })).toBe(true);

    expect(shouldRecoverClosedFilterPanel({
      itemRecoveryCount: 2,
      totalRecoveryCount: 0,
    })).toBe(false);

    expect(shouldRecoverClosedFilterPanel({
      itemRecoveryCount: 0,
      totalRecoveryCount: 6,
    })).toBe(false);
  });

  it('uses per-item confirmed filter state when the panel closes before the final snapshot', () => {
    expect(buildFinalFilterConfirmations({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      },
      itemStates: {
        noteType: {
          selectedTexts: ['图文'],
          matched: true,
        },
        publishTime: {
          selectedTexts: ['一周内'],
          matched: true,
        },
      },
    })).toEqual([
      {
        groupKey: 'noteType',
        expectedValue: '图文',
        selectedTexts: ['图文'],
        matched: true,
      },
      {
        groupKey: 'publishTime',
        expectedValue: '一周内',
        selectedTexts: ['一周内'],
        matched: true,
      },
    ]);
  });

  it('summarizes oversized hit text instead of logging the whole page', () => {
    expect(summarizeFilterHitText('图文')).toBe('图文');
    expect(summarizeFilterHitText('创作中心 '.repeat(20), 20)).toContain('... (len=');
  });

  it('keeps large hit text as diagnostics only and relies on selected state for final confirmation', () => {
    expect(buildFinalFilterConfirmations({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
      },
      itemStates: {
        noteType: {
          selectedTexts: ['图文'],
          matched: true,
        },
      },
    })).toEqual([
      {
        groupKey: 'noteType',
        expectedValue: '图文',
        selectedTexts: ['图文'],
        matched: true,
      },
    ]);
  });

  it('releases only post-click matched buffered requests', () => {
    const released = pickBufferedSearchEventsForRelease(
      [
        {
          requestAt: 100,
          filterCheck: { matches: true, reason: '', snapshot: 'pre-click-match' },
        },
        {
          requestAt: 200,
          filterCheck: { matches: false, reason: 'mismatch', snapshot: 'post-click-mismatch' },
        },
        {
          requestAt: 300,
          filterCheck: { matches: true, reason: '', snapshot: 'post-click-match' },
        },
      ],
      150
    );

    expect(released).toHaveLength(1);
    expect(released[0].filterCheck.snapshot).toBe('post-click-match');
  });

  it('treats queued request data as committed only when the main request chain produced queue items', () => {
    expect(didCommitSearchRequest({
      queueCountBefore: 0,
      queueCountAfter: 24,
      incomingCount: 24,
    })).toBe(true);

    expect(didCommitSearchRequest({
      queueCountBefore: 0,
      queueCountAfter: 0,
      incomingCount: 24,
    })).toBe(false);

    expect(didCommitSearchRequest({
      queueCountBefore: 5,
      queueCountAfter: 5,
      incomingCount: 5,
    })).toBe(true);
  });

  it('releases only pre-click matched buffered requests when click happens after data is already fetched', () => {
    const released = pickBufferedSearchEventsBeforeClick(
      [
        {
          requestAt: 100,
          filterCheck: { matches: true, reason: '', snapshot: 'pre-click-match-1' },
        },
        {
          requestAt: 200,
          filterCheck: { matches: true, reason: '', snapshot: 'pre-click-match-2' },
        },
        {
          requestAt: 300,
          filterCheck: { matches: false, reason: 'mismatch', snapshot: 'pre-click-mismatch' },
        },
        {
          requestAt: 500,
          filterCheck: { matches: true, reason: '', snapshot: 'post-click-match' },
        },
      ],
      400
    );

    expect(released).toHaveLength(2);
    expect(released.map((item) => item.filterCheck.snapshot)).toEqual([
      'pre-click-match-1',
      'pre-click-match-2',
    ]);
  });

  it('blocks pre-click requests when active filters require post-click gating', () => {
    const decision = decideSearchRequestGate({
      requiresPostFilterGuard: true,
      clickedAt: 200,
      requestAt: 150,
      filterMatches: true,
    });

    expect(decision.accepted).toBe(false);
    expect(decision.phase).toBe('pre_click');
  });

  it('accepts post-click matched requests when active filters require post-click gating', () => {
    const decision = decideSearchRequestGate({
      requiresPostFilterGuard: true,
      clickedAt: 200,
      requestAt: 250,
      filterMatches: true,
    });

    expect(decision.accepted).toBe(true);
    expect(decision.phase).toBe('post_click');
  });

  it('recognizes richer selected markers for filter candidates', () => {
    expect(isSelectedFilterCandidate({
      ariaChecked: 'true',
      className: '',
    })).toBe(true);

    expect(isSelectedFilterCandidate({
      dataSelected: 'true',
      className: '',
    })).toBe(true);

    expect(isSelectedFilterCandidate({
      className: 'filter-tag is-selected',
    })).toBe(true);

    expect(isSelectedFilterCandidate({
      className: 'plain-tag',
    })).toBe(false);
  });

  it('only treats noteType click as successful when the expected candidate is actually selected', () => {
    expect(didSelectExpectedCandidate([
      { text: '不限', selected: false },
      { text: '视频', selected: false },
      { text: '图文', selected: true },
    ], ['图文', '普通笔记'])).toBe(true);

    expect(didSelectExpectedCandidate([
      { text: '不限', selected: true },
      { text: '视频', selected: false },
      { text: '图文', selected: false },
    ], ['图文', '普通笔记'])).toBe(false);
  });

  it('allows non-default interactive filters for the main extension profile', () => {
    expect(canUseInteractiveFilters({
      name: 'xhs-marketing-extension',
      invoke: async () => undefined,
    }, {
      ...DEFAULT_SEARCH_FILTERS,
      noteType: '图文',
    })).toBe(true);
  });

  it('rejects non-default interactive filters when the extension profile is unknown', () => {
    expect(canUseInteractiveFilters({
      name: 'unknown-extension',
      invoke: async () => undefined,
    }, {
      ...DEFAULT_SEARCH_FILTERS,
      noteType: '图文',
    })).toBe(false);
  });

  it('treats legacy extension as interactive-filter capable without probing debugger targets', async () => {
    const invoke = vi.fn();
    const result = await probeInteractiveFilterSupport({
      name: 'browser-client-monorepo',
      invoke,
    });

    expect(result.supported).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('reports capability failures when the main extension cannot probe debugger targets', async () => {
    const result = await probeInteractiveFilterSupport({
      name: 'xhs-marketing-extension',
      invoke: vi.fn().mockRejectedValue(new Error('Unsupported invoke: chrome:debugger:getTargets')),
    });

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('Unsupported invoke');
  });

  it('summarizes filter probe state for diagnostics logs', () => {
    const summary = summarizeFilterProbeState({
      panelOpen: true,
      groupCount: 1,
      groups: [
        {
          index: 1,
          title: '类型',
          candidates: [
            { text: '不限', selected: false },
            { text: '图文', selected: true },
          ],
        },
      ],
      trigger: { x: 10, y: 20, selector: 'div.filter', text: '筛选' },
      target: { x: 30, y: 40, selector: '.tags:nth-of-type(2)', text: '图文' },
      targetGroup: {
        index: 1,
        title: '类型',
        candidates: [
          { text: '不限', selected: false },
          { text: '图文', selected: true },
        ],
      },
    });

    expect(summary).toContain('"panelOpen":true');
    expect(summary).toContain('图文(selected)');
    expect(summary).toContain('div.filter');
  });

  it('builds selection errors with click-mode diagnostics', () => {
    const message = buildFilterSelectionErrorMessage({
      targetText: '图文',
      debuggerError: 'attach failed',
      dispatchError: 'dispatch failed',
      domError: 'DOM click failed',
    });

    expect(message).toContain('未成功选中筛选选项 图文');
    expect(message).toContain('debugger=attach failed');
    expect(message).toContain('dispatch=dispatch failed');
    expect(message).toContain('dom=DOM click failed');
  });

  it('resolves 图文 from duplicate candidate lists by text instead of ordinal index', () => {
    const resolved = resolveFilterCandidateByTexts([
      { text: '不限', selected: true, x: 10, y: 10, selector: 'a' },
      { text: '视频', selected: false, x: 20, y: 10, selector: 'b' },
      { text: '视频', selected: false, x: 30, y: 10, selector: 'c' },
      { text: '图文', selected: false, x: 40, y: 10, selector: 'd' },
      { text: '图文', selected: false, x: 50, y: 10, selector: 'e' },
    ], ['图文', '普通笔记']);

    expect(resolved?.text).toBe('图文');
    expect(resolved?.selector).toBe('e');
  });

  it('classifies filter recovery snapshots into list, empty and pending states', () => {
    expect(classifyFilterRecoveryState({
      hasNoteItem: true,
      noteCount: 3,
      emptyStateText: '',
    })).toBe('list');

    expect(classifyFilterRecoveryState({
      hasNoteItem: false,
      noteCount: 0,
      emptyStateText: '没有找到相关内容',
    })).toBe('empty');

    expect(classifyFilterRecoveryState({
      hasNoteItem: false,
      noteCount: 0,
      emptyStateText: '',
    })).toBe('pending');
  });

  it('matches expected selection across multiple aliases', () => {
    expect(hasExpectedFilterSelection([
      { text: '图文', selected: true },
      { text: '视频', selected: false },
    ], ['图文', '普通笔记'])).toBe(true);

    expect(hasExpectedFilterSelection([
      { text: '视频', selected: true },
      { text: '图文', selected: false },
    ], ['图文', '普通笔记'])).toBe(false);
  });

  it('only confirms strict filtering after a new matched request is observed', () => {
    expect(hasConfirmedFilterRequest({
      observedAt: 200,
      matchedAt: 220,
      baselineObservedAt: 100,
      baselineMatchedAt: 120,
    })).toBe(true);

    expect(hasConfirmedFilterRequest({
      observedAt: 200,
      matchedAt: 120,
      baselineObservedAt: 100,
      baselineMatchedAt: 120,
    })).toBe(false);

    expect(hasConfirmedFilterRequest({
      observedAt: 100,
      matchedAt: 120,
      baselineObservedAt: 100,
      baselineMatchedAt: 120,
    })).toBe(false);
  });

  it('treats filter as confirmed only when a post-click matched request is observed', () => {
    expect(isStrictFilterRequestConfirmed({
      requestConfirmed: true,
    })).toBe(true);

    expect(isStrictFilterRequestConfirmed({
      requestConfirmed: false,
    })).toBe(false);
  });

  it('only confirms final filters when every non-default filter matches the last panel snapshot', () => {
    const finalStates = getFinalFilterConfirmationStates({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      },
      groups: [
        {
          index: 2,
          title: '类型',
          candidates: [
            { text: '不限', selected: true },
            { text: '图文', selected: false },
          ],
        },
        {
          index: 3,
          title: '时间',
          candidates: [
            { text: '不限', selected: false },
            { text: '一周内', selected: true },
          ],
        },
      ],
    });

    expect(finalStates).toEqual([
      {
        groupKey: 'noteType',
        expectedValue: '图文',
        selectedTexts: ['不限'],
        matched: false,
      },
      {
        groupKey: 'publishTime',
        expectedValue: '一周内',
        selectedTexts: ['一周内'],
        matched: true,
      },
    ]);
    expect(isFinalFilterSelectionConfirmed({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      },
      groups: [
        {
          index: 2,
          title: '类型',
          candidates: [
            { text: '不限', selected: true },
            { text: '图文', selected: false },
          ],
        },
        {
          index: 3,
          title: '时间',
          candidates: [
            { text: '不限', selected: false },
            { text: '一周内', selected: true },
          ],
        },
      ],
    })).toBe(false);
  });

  it('treats ui-applied filtering as confirmed when DOM state, panel state and result list all match', () => {
    expect(isUiAppliedFilterConfirmed({
      finalFilterSelectionConfirmed: true,
      panelClosed: true,
      recoveryState: 'list',
      noteCount: 24,
      hasNoteItem: true,
    })).toBe(true);

    expect(isUiAppliedFilterConfirmed({
      finalFilterSelectionConfirmed: false,
      panelClosed: true,
      recoveryState: 'list',
      noteCount: 24,
      hasNoteItem: true,
    })).toBe(false);

    expect(isUiAppliedFilterConfirmed({
      finalFilterSelectionConfirmed: true,
      panelClosed: false,
      recoveryState: 'list',
      noteCount: 24,
      hasNoteItem: true,
    })).toBe(true);

    expect(isUiAppliedFilterConfirmed({
      finalFilterSelectionConfirmed: true,
      panelClosed: true,
      recoveryState: 'pending',
      noteCount: 24,
      hasNoteItem: true,
    })).toBe(false);
  });

  it('only accepts ui-applied page state when the page still matches the target search context', () => {
    expect(shouldAcceptUiAppliedSurface({
      looksLikeSearchResult: true,
      keywordMatches: true,
      count: 24,
    })).toBe(true);

    expect(shouldAcceptUiAppliedSurface({
      looksLikeSearchResult: true,
      keywordMatches: false,
      count: 24,
    })).toBe(false);

    expect(shouldAcceptUiAppliedSurface({
      looksLikeSearchResult: true,
      keywordMatches: true,
      count: 0,
    })).toBe(false);
  });

  it('matches known noteType URL params when deciding whether ui fallback can be trusted', () => {
    expect(doesUiTypeParamMatchFilters({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
      },
      typeParam: '51',
    })).toBe(true);

    expect(doesUiTypeParamMatchFilters({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
      },
      typeParam: '52',
    })).toBe(false);

    expect(doesUiTypeParamMatchFilters({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '视频',
      },
      typeParam: '51',
    })).toBe(false);
  });

  it('allows ui-confirmed fallback when the filter snapshot, URL and page context all match', () => {
    expect(isUiFilterConfirmed({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      },
      finalFilterSelectionConfirmed: true,
      looksLikeSearchResult: true,
      keywordMatches: true,
      count: 18,
      typeParam: '51',
    })).toBe(true);

    expect(isUiFilterConfirmed({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      },
      finalFilterSelectionConfirmed: true,
      looksLikeSearchResult: true,
      keywordMatches: false,
      count: 18,
      typeParam: '51',
    })).toBe(false);

    expect(isUiFilterConfirmed({
      filters: {
        ...DEFAULT_SEARCH_FILTERS,
        noteType: '图文',
        publishTime: '一周内',
      },
      finalFilterSelectionConfirmed: true,
      looksLikeSearchResult: true,
      keywordMatches: true,
      count: 18,
      typeParam: '52',
    })).toBe(false);
  });

  it('hydrates the queue from visible notes only when ui fallback confirmed the filter state', () => {
    expect(shouldRecoverUiConfirmedNotes({
      finalConfirmationSource: 'ui',
      requestCommitted: false,
      recoveredCount: 12,
    })).toBe(true);

    expect(shouldRecoverUiConfirmedNotes({
      finalConfirmationSource: 'request',
      requestCommitted: false,
      recoveredCount: 12,
    })).toBe(false);

    expect(shouldRecoverUiConfirmedNotes({
      finalConfirmationSource: 'ui',
      requestCommitted: true,
      recoveredCount: 12,
    })).toBe(false);

    expect(shouldRecoverUiConfirmedNotes({
      finalConfirmationSource: 'ui',
      requestCommitted: false,
      recoveredCount: 0,
    })).toBe(false);
  });

  it('rejects noisy container text as a standalone filter trigger', () => {
    expect(isLikelyStandaloneFilterTriggerText('筛选')).toBe(true);
    expect(isLikelyStandaloneFilterTriggerText('已筛选')).toBe(true);
    expect(isLikelyStandaloneFilterTriggerText('筛选 排序依据 综合 最新 笔记类型 不限 视频 图文 重置 收起')).toBe(false);
  });

  it('only allows a single DOM fallback after filter click and before any data is collected', () => {
    expect(shouldUseDomFallback({
      requiresPostFilterGuard: true,
      clickedAt: 200,
      dataLength: 0,
      alreadyUsed: false,
      hasNoteItems: true,
    })).toBe(true);

    expect(shouldUseDomFallback({
      requiresPostFilterGuard: true,
      clickedAt: 200,
      dataLength: 1,
      alreadyUsed: false,
      hasNoteItems: true,
    })).toBe(false);

    expect(shouldUseDomFallback({
      requiresPostFilterGuard: true,
      clickedAt: 200,
      dataLength: 0,
      alreadyUsed: true,
      hasNoteItems: true,
    })).toBe(false);
  });

  it('stops enrichment when neither finalized nor fallback queues carry xsec_token', () => {
    expect(shouldStopEnrichmentForMissingTokens({
      finalizedTokenCount: 0,
      fallbackTokenCount: 0,
    })).toBe(true);

    expect(shouldStopEnrichmentForMissingTokens({
      finalizedTokenCount: 1,
      fallbackTokenCount: 0,
    })).toBe(false);

    expect(shouldStopEnrichmentForMissingTokens({
      finalizedTokenCount: 0,
      fallbackTokenCount: 2,
    })).toBe(false);
  });

  it('only allows detail DOM fallback when a token exists and html extraction failed', () => {
    expect(shouldAllowDetailDomFallback({
      token: 'abc',
      detail: null,
    })).toBe(true);

    expect(shouldAllowDetailDomFallback({
      token: '',
      detail: null,
    })).toBe(false);

    expect(shouldAllowDetailDomFallback({
      token: 'abc',
      detail: { desc: 'ok' },
    })).toBe(false);
  });

  it('detects video search items from explicit video fields', () => {
    expect(detectSearchItemMediaType({
      id: 'video-note',
      note_card: {
        video_info: {
          duration: 12,
        },
      },
    })).toBe('video');
  });

  it('filters explicit video items out of 图文 results', () => {
    const filtered = filterItemsByNoteType([
      {
        id: 'image-note',
        note_card: {
          image_list: [{ url_default: 'https://example.com/a.jpg' }],
        },
      },
      {
        id: 'video-note',
        note_card: {
          video_info: {
            duration: 12,
          },
        },
      },
    ], {
      ...DEFAULT_SEARCH_FILTERS,
      noteType: '图文',
    });

    expect(filtered.map((item) => item.id)).toEqual(['image-note']);
  });

  it('filters explicit image items out of 视频 results', () => {
    const filtered = filterItemsByNoteType([
      {
        id: 'image-note',
        note_card: {
          image_list: [{ url_default: 'https://example.com/a.jpg' }],
        },
      },
      {
        id: 'video-note',
        note_card: {
          video_info: {
            duration: 12,
          },
        },
      },
    ], {
      ...DEFAULT_SEARCH_FILTERS,
      noteType: '视频',
    });

    expect(filtered.map((item) => item.id)).toEqual(['video-note']);
  });

  it('extracts detail note from multiple initial state shapes and normalizes desc/imageList aliases', () => {
    const detail = extractNoteDetailFromState({
      note: {
        noteDetailMap: {
          'note-1': {
            note: {
              note_card: {
                desc: '详情正文',
                image_list: [{ url_default: 'http://sns-webpic-qc.xhscdn.com/detail-1' }],
              },
            },
          },
        },
      },
    }, 'note-1');

    expect(detail?.desc).toBe('详情正文');
    expect(detail?.imageList).toEqual([{ url_default: 'http://sns-webpic-qc.xhscdn.com/detail-1' }]);
  });

  it('writes fetched detail back onto the note with desc and imageList fallbacks', () => {
    const updated = applyFetchedDetailToNote(
      {
        id: 'note-1',
        imageList: [],
      },
      {
        desc: '补抓正文',
        imageList: ['http://sns-webpic-qc.xhscdn.com/detail-1'],
      }
    );

    expect(updated.detail.desc).toBe('补抓正文');
    expect(updated.desc).toBe('补抓正文');
    expect(updated.imageList).toEqual(['http://sns-webpic-qc.xhscdn.com/detail-1']);
    expect(updated.imageUrl).toBe('http://sns-webpic-qc.xhscdn.com/detail-1');
  });

  it('promotes nested detail.note_card publish time fields onto the note', () => {
    const updated = applyFetchedDetailToNote(
      {
        id: 'note-2',
        note_card: {},
      },
      {
        note_card: {
          time: 1713800000,
          create_time: 1713700000,
          create_date_time: '2024-04-23',
        },
      }
    );

    expect(updated.note_card.time).toBe(1713800000);
    expect(updated.time).toBe(1713800000);
    expect(updated.create_time).toBe(1713700000);
    expect(updated.create_date_time).toBe('2024-04-23');
  });

  it('returns a skip reason when a note does not have xsec_token', () => {
    const result = resolveCommentEnrichment({
      id: 'note-no-token',
      note_card: {},
      detail: {},
    });

    expect(result.token).toBe('');
    expect(result.skipReason).toContain('xsec_token');
  });

  it('writes fetched comments back with a normalized commentCount', () => {
    const updated = applyFetchedCommentsToNote(
      {
        id: 'note-1',
        detail: {
          interactInfo: {
            commentCount: 7,
          },
        },
      },
      [
        {
          id: 'comment-1',
          content: '第一条评论',
        },
      ]
    );

    expect(updated.comments).toHaveLength(1);
    expect(updated.commentCount).toBe('7');
  });

  it('normalizes a search note item with top-level token and generated noteUrl', () => {
    const normalized = normalizeSearchNoteItem({
      id: 'note-100',
      xsec_token: 'token-abc',
      note_card: {
        display_title: '测试标题',
      },
    });

    expect(normalized?.id).toBe('note-100');
    expect(normalized?.xsec_token).toBe('token-abc');
    expect(normalized?.noteUrl).toContain('/explore/note-100');
    expect(normalized?.noteUrl).toContain('xsec_token=token-abc');
  });

  it('falls back to nested note_card user token when top-level token is absent', () => {
    const normalized = normalizeSearchNoteItem({
      id: 'note-200',
      note_card: {
        user: {
          xsec_token: 'nested-token',
        },
      },
    });

    expect(normalized?.xsec_token).toBe('nested-token');
    expect(normalized?.noteUrl).toContain('nested-token');
  });

  it('preserves an existing noteUrl while normalizing token fields', () => {
    const normalized = normalizeSearchNoteItem({
      id: 'note-300',
      noteUrl: 'https://www.xiaohongshu.com/explore/note-300?xsec_token=abc123&xsec_source=pc_search',
      xsec_token: 'abc123',
    });

    expect(normalized?.noteUrl).toBe('https://www.xiaohongshu.com/explore/note-300?xsec_token=abc123&xsec_source=pc_search');
    expect(normalized?.xsec_token).toBe('abc123');
  });

  it('shows that local publish-time parsing can reject a request-filtered note, so strict request results must be preserved', () => {
    const requestFilteredItems = [
      {
        id: 'recent-by-request',
        title: '请求侧已确认',
        author: '作者A',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        time: Date.now() - 20 * 24 * 60 * 60 * 1000,
      },
    ];

    const locallyFiltered = filterNotesByPublishTime(requestFilteredItems as any, '一周内');

    expect(locallyFiltered).toHaveLength(0);
    expect(requestFilteredItems).toHaveLength(1);
  });

  it('switches strict publish-time collection to visible dom ordering', () => {
    const visibleItems = [
      { id: 'visible-extra', xsec_token: 'token-extra', noteUrl: 'https://www.xiaohongshu.com/explore/visible-extra', note_card: {} },
      { id: 'request-2', xsec_token: 'token-2', noteUrl: 'https://www.xiaohongshu.com/explore/request-2', note_card: {} },
      { id: 'request-1', xsec_token: 'token-1', noteUrl: 'https://www.xiaohongshu.com/explore/request-1', note_card: {} },
    ];
    const finalItems: any[] = [];

    visibleItems.forEach((item) => {
      if (!item.id || finalItems.some((candidate) => candidate.id === item.id)) return;
      finalItems.push(item);
    });

    expect(finalItems.map((item) => item.id)).toEqual(['visible-extra', 'request-2', 'request-1']);
  });

  it('still lets local publish-time filtering work when request-side strict confirmation is absent', () => {
    const notes = [
      {
        id: 'recent-note',
        title: '最近发布',
        author: '作者B',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        time: Date.now() - 2 * 24 * 60 * 60 * 1000,
      },
      {
        id: 'old-note',
        title: '很早发布',
        author: '作者C',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        time: Date.now() - 20 * 24 * 60 * 60 * 1000,
      },
    ];

    const filtered = filterNotesByPublishTime(notes as any, '一周内');
    expect(filtered.map((item) => item.id)).toEqual(['recent-note']);
  });

  it('skips post-list enrichment when the current session already completed', () => {
    expect(getPostListEnrichmentSkipReason({
      sessionId: 'session-1',
      lastCompletedSessionId: 'session-1',
      enteredSessionId: '',
      isRunning: false,
      activeEnrichmentSessionId: '',
    })).toBe('completed');
  });

  it('skips post-list enrichment when the current session is still actively enriching', () => {
    expect(getPostListEnrichmentSkipReason({
      sessionId: 'session-2',
      lastCompletedSessionId: '',
      enteredSessionId: 'session-2',
      isRunning: true,
      activeEnrichmentSessionId: 'session-2',
    })).toBe('active');
  });

  it('skips post-list enrichment when the current session already entered enrichment once', () => {
    expect(getPostListEnrichmentSkipReason({
      sessionId: 'session-3',
      lastCompletedSessionId: '',
      enteredSessionId: 'session-3',
      isRunning: false,
      activeEnrichmentSessionId: '',
    })).toBe('entered');
  });

  it('allows post-list enrichment to start for a fresh session', () => {
    expect(getPostListEnrichmentSkipReason({
      sessionId: 'session-4',
      lastCompletedSessionId: 'session-3',
      enteredSessionId: 'session-3',
      isRunning: false,
      activeEnrichmentSessionId: '',
    })).toBeNull();
  });

  it('builds publish-time diagnostics for notes without resolved timestamps', () => {
    const diagnostics = buildPublishTimeDiagnostics(
      [
        {
          id: 'note-without-time',
        },
      ],
      '一周内',
      new Map([['note-without-time', 'request_queue']]),
    );

    expect(diagnostics).toEqual([
      {
        id: 'note-without-time',
        source: 'request_queue',
        time: null,
        publishedAtLabel: '',
        matchesLocalWindow: true,
      },
    ]);
  });

  it('skips local publish-time filtering when request-side strict publish time should be trusted', () => {
    expect(shouldSkipLocalPublishTimeFilter({
      trustStrictRequestPublishTime: true,
      appliedPublishTime: '一周内',
    }, '一周内')).toBe(true);
  });

  it('uses visible dom as the source when publishTime is strict', () => {
    expect(shouldCollectStrictPublishTimeFromVisibleDom({
      ...DEFAULT_SEARCH_FILTERS,
      publishTime: '一周内',
    })).toBe(false);
    expect(shouldCollectStrictPublishTimeFromVisibleDom({
      ...DEFAULT_SEARCH_FILTERS,
      publishTime: '不限',
    })).toBe(false);
  });

  it('backfills token from request cache while preserving visible-dom order', () => {
    const result = backfillVisibleDomNotesWithRequestCache({
      visibleItems: [
        { id: 'visible-2', noteUrl: 'https://www.xiaohongshu.com/explore/visible-2', xsec_token: '' },
        { id: 'visible-1', noteUrl: 'https://www.xiaohongshu.com/explore/visible-1', xsec_token: '' },
      ],
      requestItems: [
        { id: 'visible-1', noteUrl: 'https://www.xiaohongshu.com/explore/visible-1?xsec_token=token-1', xsec_token: 'token-1', note_card: { xsec_token: 'token-1' } },
        { id: 'visible-2', noteUrl: 'https://www.xiaohongshu.com/explore/visible-2?xsec_token=token-2', xsec_token: 'token-2', note_card: { xsec_token: 'token-2' } },
      ],
    });

    expect(result.items.map((item: any) => item.id)).toEqual(['visible-2', 'visible-1']);
    expect(result.items.map((item: any) => item.xsec_token)).toEqual(['token-2', 'token-1']);
    expect(result.tokenBackfilledCount).toBe(2);
    expect(result.tokenMissingCount).toBe(0);
  });

  it('keeps visible-dom items when request cache cannot provide token', () => {
    const result = backfillVisibleDomNotesWithRequestCache({
      visibleItems: [
        { id: 'visible-3', noteUrl: 'https://www.xiaohongshu.com/explore/visible-3', xsec_token: '' },
      ],
      requestItems: [],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('visible-3');
    expect(result.items[0].xsec_token).toBe('');
    expect(result.tokenBackfilledCount).toBe(0);
    expect(result.tokenMissingCount).toBe(1);
  });

  it('finishes strict visible-dom collection as soon as the requested count is reached', () => {
    expect(shouldFinishStrictVisibleDomCollection({
      enabled: true,
      currentCount: 2,
      requestedCount: 2,
    })).toBe(true);
    expect(shouldFinishStrictVisibleDomCollection({
      enabled: true,
      currentCount: 1,
      requestedCount: 2,
    })).toBe(false);
    expect(shouldFinishStrictVisibleDomCollection({
      enabled: false,
      currentCount: 2,
      requestedCount: 2,
    })).toBe(false);
  });

  it('finishes strict request-driven collection once the committed request queue reaches the target', () => {
    expect(shouldFinishStrictRequestCollection({
      enabled: true,
      requestCommitted: true,
      currentCount: 2,
      requestedCount: 2,
    })).toBe(true);
    expect(shouldFinishStrictRequestCollection({
      enabled: true,
      requestCommitted: false,
      currentCount: 2,
      requestedCount: 2,
    })).toBe(false);
    expect(shouldFinishStrictRequestCollection({
      enabled: false,
      requestCommitted: true,
      currentCount: 2,
      requestedCount: 2,
    })).toBe(false);
  });

  it('keeps local publish-time filtering when trust metadata is absent or does not match', () => {
    expect(shouldSkipLocalPublishTimeFilter(null, '一周内')).toBe(false);
    expect(shouldSkipLocalPublishTimeFilter({
      trustStrictRequestPublishTime: false,
      appliedPublishTime: '一周内',
    }, '一周内')).toBe(false);
    expect(shouldSkipLocalPublishTimeFilter({
      trustStrictRequestPublishTime: true,
      appliedPublishTime: '一天内',
    }, '一周内')).toBe(false);
  });
});
