import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScraperView from '../components/ScraperView';

const { apiClientMock } = vi.hoisted(() => ({
  apiClientMock: {
    getScrapeHistories: vi.fn(),
    getScrapeHistoryDetail: vi.fn(),
    saveScrapeHistory: vi.fn(),
    analyzeLocalNotes: vi.fn(),
    updateScrapeHistoryAnalysis: vi.fn(),
    collectByUrl: vi.fn(),
    deleteScrapeHistory: vi.fn(),
  },
}));

let scraperHookState: any;

vi.mock('../services/apiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/apiClient')>();
  return {
    __esModule: true,
    ...actual,
    default: apiClientMock,
    apiClient: apiClientMock,
  };
});

vi.mock('../src/hooks/useXhsScraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/useXhsScraper')>();
  return {
    ...actual,
    useXhsScraper: () => scraperHookState,
  };
});

vi.mock('../src/hooks/useExtension', () => ({
  useExtension: () => ({ extension: undefined }),
}));

vi.mock('../contexts/ScraperContext', () => ({
  useScraperContext: () => ({
    showAnalysis: false,
    setShowAnalysis: vi.fn(),
    analysisResult: null,
    setAnalysisResult: vi.fn(),
    topNotes: [],
    setTopNotes: vi.fn(),
    benchmarkNotes: [],
    setBenchmarkNotes: vi.fn(),
    groupedBenchmarkNotes: {},
    setGroupedBenchmarkNotes: vi.fn(),
    nextCollectionTasks: [],
    setNextCollectionTasks: vi.fn(),
    realPhrases: [],
    setRealPhrases: vi.fn(),
    selectedBenchmarkNote: null,
    setSelectedBenchmarkNote: vi.fn(),
    latestProductBrief: null,
    setLatestProductBrief: vi.fn(),
    productBriefStatus: {
      updatedAt: null,
      analysisSignature: null,
      isDirty: false,
    },
    setProductBriefStatus: vi.fn(),
    referenceAssets: [],
    setReferenceAssets: vi.fn(),
    rewriteSession: null,
    setRewriteSession: vi.fn(),
  }),
}));

vi.mock('../contexts/PersistenceContext', () => ({
  usePersistence: () => ({
    setCreationState: vi.fn(),
  }),
}));

vi.mock('../components/NotePreviewOverlay', () => ({
  default: () => null,
}));

vi.mock('../components/LoginDialog', () => ({
  default: () => null,
}));

const sampleNotes = [
  {
    id: 'note-1',
    title: '测试笔记',
    author: '作者A',
    note_card: {
      display_title: '测试笔记',
      user: { nickname: '作者A', avatar: 'http://sns-avatar.xhscdn.com/avatar-a' },
      interact_info: { liked_count: '10', collected_count: '5', share_count: '2' },
      cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/default-image' },
    },
    create_time: 1713500000,
  },
];

const createHistorySummary = (overrides: Record<string, any> = {}) => ({
  id: 1,
  user_id: 'user-test',
  task_id: 'task-1',
  keyword: '测试关键词',
  notes_count: 1,
  created_at: '2026-04-22T10:00:00.000Z',
  filters: {
    sortBy: '综合',
    noteType: '不限',
    publishTime: '不限',
    searchScope: '不限',
    location: '不限',
  },
  product_brief: {
    product_name: '排版工具',
    target_audience: '内容创作者',
    product_features: '一键排版',
  },
  analysis_result: null,
  ...overrides,
});

const createHistoryDetail = (overrides: Record<string, any> = {}) => ({
  ...createHistorySummary(overrides),
  notes_data: sampleNotes,
});

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('ScraperView history persistence flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scraperHookState = {
      startScraping: vi.fn(),
      collectNoteByUrlWithBrowser: vi.fn(),
      isScraping: true,
      data: [],
      collectionResultMeta: null,
      statusMessage: '',
      filterDebugEntries: [],
      commentDebugEntries: [],
    };

    window.localStorage.clear();
    window.localStorage.setItem('xhs_scraper_workspace_draft_brief', JSON.stringify({
      product_name: '排版工具',
      target_audience: '内容创作者',
      product_features: '一键排版',
    }));

    apiClientMock.getScrapeHistories.mockResolvedValue({ success: true, data: [] });
    apiClientMock.analyzeLocalNotes.mockResolvedValue({
      success: true,
      data: {
        benchmark_notes: [],
        grouped_benchmark_notes: {},
        category_summary: {},
        real_phrases: [],
        next_collection_tasks: [],
      },
    });
    apiClientMock.updateScrapeHistoryAnalysis.mockResolvedValue({ success: true });
    apiClientMock.deleteScrapeHistory.mockResolvedValue({ success: true });
  });

  it('shows a newly saved history task immediately after save succeeds', async () => {
    const savedSummary = createHistorySummary();

    apiClientMock.getScrapeHistories
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [savedSummary] });
    apiClientMock.getScrapeHistoryDetail.mockResolvedValue({
      success: true,
      data: {
        ...savedSummary,
        notes_data: sampleNotes,
      },
    });
    apiClientMock.saveScrapeHistory.mockResolvedValue({
      success: true,
      data: savedSummary,
    });

    const { rerender } = render(<ScraperView onEnterStudio={() => undefined} />);

    scraperHookState = {
      ...scraperHookState,
      isScraping: false,
      data: sampleNotes,
    };

    rerender(<ScraperView onEnterStudio={() => undefined} />);

    await waitFor(() => {
      expect(apiClientMock.saveScrapeHistory).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getAllByText('测试关键词').length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(apiClientMock.getScrapeHistoryDetail).toHaveBeenCalledWith(savedSummary.task_id);
    });
  });

  it('trusts request-side publish time results for live scrape analysis', async () => {
    const deferredSave = createDeferred<any>();
    apiClientMock.saveScrapeHistory.mockReturnValue(deferredSave.promise);

    const recentByRequestOnly = [
      {
        id: 'request-trusted-note',
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

    const { rerender } = render(<ScraperView onEnterStudio={() => undefined} />);

    scraperHookState = {
      ...scraperHookState,
      isScraping: false,
      data: recentByRequestOnly,
      collectionResultMeta: {
        sessionId: 'session-live',
        appliedPublishTime: '一周内',
        trustStrictRequestPublishTime: true,
        finalOrderSource: 'request_queue',
        publishTimeRejectedCount: 1,
        formattedCount: 1,
        effectiveCount: 1,
      },
    };

    rerender(<ScraperView onEnterStudio={() => undefined} />);

    await waitFor(() => {
      expect(apiClientMock.saveScrapeHistory).toHaveBeenCalledTimes(1);
    });

    expect(screen.queryByText(/当前采集结果未通过发布时间筛选/)).toBeNull();
    expect(screen.queryByText(/已按发布时间剔除/)).toBeNull();

    deferredSave.resolve({
      success: true,
      data: createHistorySummary({ task_id: 'task-trust-live' }),
    });
  });

  it('keeps the restored history workspace when live analysis finishes later', async () => {
    const savedSummary = createHistorySummary({
      task_id: 'task-live',
      keyword: '刚采集完成的任务',
      created_at: '2026-04-22T10:00:00.000Z',
    });
    const historySummary = createHistorySummary({
      id: 2,
      task_id: 'task-history',
      keyword: '更早的历史任务',
      created_at: '2026-04-21T10:00:00.000Z',
    });
    const historyDetail = createHistoryDetail({
      id: 2,
      task_id: 'task-history',
      keyword: '更早的历史任务',
      created_at: '2026-04-21T10:00:00.000Z',
    });
    const analyzeDeferred = createDeferred<any>();

    apiClientMock.getScrapeHistories
      .mockResolvedValueOnce({ success: true, data: [historySummary] })
      .mockResolvedValueOnce({ success: true, data: [savedSummary, historySummary] });
    apiClientMock.getScrapeHistoryDetail.mockImplementation(async (taskId: string) => {
      if (taskId === historySummary.task_id) {
        return {
          success: true,
          data: historyDetail,
        };
      }
      if (taskId === savedSummary.task_id) {
        return {
          success: true,
          data: createHistoryDetail({
            ...savedSummary,
            notes_data: sampleNotes,
          }),
        };
      }
      throw new Error(`unexpected task id ${taskId}`);
    });
    apiClientMock.saveScrapeHistory.mockResolvedValue({
      success: true,
      data: savedSummary,
    });
    apiClientMock.analyzeLocalNotes.mockReturnValue(analyzeDeferred.promise);

    const { rerender } = render(<ScraperView onEnterStudio={() => undefined} />);

    scraperHookState = {
      ...scraperHookState,
      isScraping: false,
      data: sampleNotes,
    };

    rerender(<ScraperView onEnterStudio={() => undefined} />);

    await waitFor(() => {
      expect(apiClientMock.saveScrapeHistory).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: /更早的历史任务/ }));

    await waitFor(() => {
      expect(apiClientMock.getScrapeHistoryDetail).toHaveBeenCalledWith(historySummary.task_id);
    });

    fireEvent.click(screen.getByRole('button', { name: '载入结果' }));

    await waitFor(() => {
      expect(screen.getAllByText('当前页面已载入：更早的历史任务').length).toBeGreaterThan(0);
    });

    analyzeDeferred.resolve({
      success: true,
      data: {
        benchmark_notes: [],
        grouped_benchmark_notes: {},
        category_summary: {},
        real_phrases: [],
        next_collection_tasks: [],
      },
    });

    await waitFor(() => {
      expect(apiClientMock.updateScrapeHistoryAnalysis).toHaveBeenCalledWith(savedSummary.task_id, expect.any(Object));
    });

    await waitFor(() => {
      expect(screen.getAllByText('当前页面已载入：更早的历史任务').length).toBeGreaterThan(0);
    });

    expect(apiClientMock.getScrapeHistoryDetail.mock.calls.map((args: any[]) => args[0])).not.toContain(savedSummary.task_id);
  });

  it('surfaces a clear message when history save fails and keeps results only in-page', async () => {
    apiClientMock.saveScrapeHistory.mockRejectedValue(new Error('数据库字段容量不足'));

    const { rerender } = render(<ScraperView onEnterStudio={() => undefined} />);

    scraperHookState = {
      ...scraperHookState,
      isScraping: false,
      data: sampleNotes,
    };

    rerender(<ScraperView onEnterStudio={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText(/当前结果仅保存在本页，未写入历史记录/)).toBeTruthy();
    });
  });

  it('formats validation-array save errors into readable history messages', async () => {
    apiClientMock.saveScrapeHistory.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 422',
      response: {
        data: {
          detail: [
            {
              type: 'string_too_short',
              loc: ['body', 'password'],
              msg: 'String should have at least 8 characters',
              ctx: { min_length: 8 },
            },
          ],
        },
        status: 422,
      },
    });

    const { rerender } = render(<ScraperView onEnterStudio={() => undefined} />);

    scraperHookState = {
      ...scraperHookState,
      isScraping: false,
      data: sampleNotes,
    };

    rerender(<ScraperView onEnterStudio={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByText(/密码不能少于 8 位/)).toBeTruthy();
    });
  });

  it('restores a history task into an empty workspace', async () => {
    const historySummary = createHistorySummary({
      id: 2,
      task_id: 'task-history',
      keyword: '历史恢复任务',
      created_at: '2026-04-21T10:00:00.000Z',
    });
    const historyDetail = createHistoryDetail({
      id: 2,
      task_id: 'task-history',
      keyword: '历史恢复任务',
      created_at: '2026-04-21T10:00:00.000Z',
    });

    apiClientMock.getScrapeHistories.mockResolvedValueOnce({ success: true, data: [historySummary] });
    apiClientMock.getScrapeHistoryDetail.mockResolvedValue({
      success: true,
      data: historyDetail,
    });

    render(<ScraperView onEnterStudio={() => undefined} />);

    fireEvent.click(await screen.findByRole('button', { name: /历史恢复任务/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '载入结果' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '载入结果' }));

    await waitFor(() => {
      expect(screen.getAllByText('当前页面已载入：历史恢复任务').length).toBeGreaterThan(0);
    });
  });

  it('keeps product brief and history sections independently scrollable on desktop layout', async () => {
    render(<ScraperView onEnterStudio={() => undefined} />);

    fireEvent.click(screen.getAllByRole('button', { name: '编辑产品参数' })[0]);

    const historyScrollRegion = screen.getByTestId('history-list-scroll-region');

    expect(historyScrollRegion.className).toContain('overflow-y-auto');
    expect(historyScrollRegion.className).toContain('custom-scrollbar');
    expect(screen.getByRole('heading', { name: '编辑产品参数' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '完成' })).toBeTruthy();
  });

  it('hides history diagnostics while preserving the history list scroll region', () => {
    render(<ScraperView onEnterStudio={() => undefined} />);

    expect(screen.queryByText(/历史列表诊断/)).toBeNull();

    const historyScrollRegion = screen.getByTestId('history-list-scroll-region');
    expect(historyScrollRegion.className).toContain('flex-1');
    expect(historyScrollRegion.className).toContain('min-h-0');
    expect(historyScrollRegion.className).toContain('overflow-y-auto');
    expect(historyScrollRegion.className).toContain('custom-scrollbar');
  });

  it('renders collection mode badges for URL history tasks', async () => {
    apiClientMock.getScrapeHistories.mockResolvedValueOnce({
      success: true,
      data: [
        createHistorySummary({
          task_id: 'task-url-1',
          keyword: 'URL采集',
          collection_mode: 'url',
          source_input: 'https://www.xiaohongshu.com/explore/url-note',
        }),
      ],
    });

    render(<ScraperView onEnterStudio={() => undefined} />);

    await waitFor(() => {
      expect(screen.getAllByText('对标笔记URL采集').length).toBeGreaterThan(0);
      expect(screen.getByText('xiaohongshu.com')).toBeTruthy();
      expect(screen.getByText('笔记ID · url-note')).toBeTruthy();
    });
  });

  it('switches to URL collection tab and submits collect request', async () => {
    apiClientMock.collectByUrl.mockResolvedValue({
      success: true,
      data: {
        collection_mode: 'url',
        source_input: 'https://www.xiaohongshu.com/explore/url-note',
        note: {
          id: 'url-note',
          title: 'URL笔记',
          desc: '正文',
          author: '作者B',
          authorAvatar: '',
          likes: '12',
          stars: '9',
          views: '0',
          shares: '1',
          imageUrl: 'https://sns-webpic-qc.xhscdn.com/url-image',
          imageList: ['https://sns-webpic-qc.xhscdn.com/url-image'],
          stableImageUrl: 'https://sns-webpic-qc.xhscdn.com/url-image',
          stableImageList: ['https://sns-webpic-qc.xhscdn.com/url-image'],
          noteUrl: 'https://www.xiaohongshu.com/explore/url-note',
          commentCount: '0',
          comments: [],
        },
      },
    });
    apiClientMock.saveScrapeHistory.mockResolvedValue({
      success: true,
      data: createHistorySummary({
        task_id: 'task-url-persisted',
        keyword: 'URL笔记',
        collection_mode: 'url',
        source_input: 'https://www.xiaohongshu.com/explore/url-note',
      }),
    });
    apiClientMock.getScrapeHistoryDetail.mockResolvedValue({
      success: true,
      data: createHistoryDetail({
        task_id: 'task-url-persisted',
        keyword: 'URL笔记',
        collection_mode: 'url',
        source_input: 'https://www.xiaohongshu.com/explore/url-note',
      }),
    });

    render(<ScraperView onEnterStudio={() => undefined} />);

    fireEvent.change(screen.getByPlaceholderText('粘贴 https://www.xiaohongshu.com/explore/... 这类完整笔记链接'), {
      target: { value: 'https://www.xiaohongshu.com/explore/url-note' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始对标笔记URL采集' }));

    await waitFor(() => {
      expect(apiClientMock.collectByUrl).toHaveBeenCalledWith({
        url: 'https://www.xiaohongshu.com/explore/url-note',
        enable_comments: true,
      });
    });
  });

});
