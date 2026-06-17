import { describe, expect, it } from 'vitest';
import { dedupeBenchmarkNotes, filterNotesByPublishTime, formatScrapedNotes, getCanonicalImageSequence, historyToWorkspaceState, mergeResolvedImageLists, normalizeResolvedImageList } from './scraperData';

describe('scraperData image normalization', () => {
  it('preserves raw cover urls and falls back to multiple candidates', () => {
    const formatted = formatScrapedNotes([
      {
        id: 'note-1',
        note_card: {
          display_title: '封面测试',
          cover: {
            url_default: 'http://sns-webpic-qc.xhscdn.com/default-image',
            url_pre: 'http://sns-webpic-qc.xhscdn.com/preview-image',
          },
          user: { nickname: '作者A', avatar: 'http://sns-avatar.xhscdn.com/avatar-a' },
          interact_info: { liked_count: '10', collected_count: '5', share_count: '2' },
        },
      },
    ]);

    expect(formatted[0].imageUrl).toBe('http://sns-webpic-qc.xhscdn.com/default-image');
    expect(formatted[0].imageList).toEqual(['http://sns-webpic-qc.xhscdn.com/default-image']);
    expect(formatted[0].stableImageUrl).toBe('/api/scraper/image-proxy?url=https%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fdefault-image');
  });

  it('prefers history raw image paths in the same order as the legacy history view', () => {
    const formatted = formatScrapedNotes([
      {
        id: 'note-history-1',
        note_card: {
          display_title: '历史图片优先级',
          image_list: [
            {
              info_list: [
                { url: 'http://sns-webpic-qc.xhscdn.com/card-info-image' },
                { url: 'http://sns-webpic-qc.xhscdn.com/card-info-preview' },
              ],
            },
          ],
          cover: {
            url_default: 'http://sns-webpic-qc.xhscdn.com/cover-default',
            url_pre: 'http://sns-webpic-qc.xhscdn.com/cover-preview',
          },
          user: { nickname: '作者B', avatar: 'http://sns-avatar.xhscdn.com/avatar-b' },
          interact_info: { liked_count: '22', collected_count: '9', share_count: '3' },
        },
        detail: {
          imageList: [{ urlDefault: 'http://sns-webpic-qc.xhscdn.com/detail-image' }],
        },
      },
    ]);

    expect(formatted[0].imageUrl).toBe('http://sns-webpic-qc.xhscdn.com/detail-image');
    expect(formatted[0].imageList).toEqual([
      'http://sns-webpic-qc.xhscdn.com/detail-image',
    ]);
    expect(formatted[0].stableImageList?.[0]).toBe('/api/scraper/image-proxy?url=https%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fdetail-image');
  });

  it('uses only the highest-priority image source instead of merging multiple sets', () => {
    const formatted = formatScrapedNotes([
      {
        id: 'priority-note-1',
        title: '优先级图片测试',
        author: '作者E',
        authorAvatar: 'http://sns-avatar.xhscdn.com/avatar-e',
        likes: '1',
        stars: '1',
        views: '1',
        imageList: [
          'http://sns-webpic-qc.xhscdn.com/runtime-1',
          'http://sns-webpic-qc.xhscdn.com/runtime-2',
        ],
        image_list: 'http://sns-webpic-qc.xhscdn.com/history-1,http://sns-webpic-qc.xhscdn.com/history-2',
        note_card: {
          image_list: [
            { url_default: 'http://sns-webpic-qc.xhscdn.com/card-1' },
            { url_default: 'http://sns-webpic-qc.xhscdn.com/card-2' },
          ],
          cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/cover-1' },
        },
      },
    ]);

    expect(formatted[0].imageList).toEqual([
      'http://sns-webpic-qc.xhscdn.com/runtime-1',
      'http://sns-webpic-qc.xhscdn.com/runtime-2',
    ]);
  });

  it('prefers detail desc and detail imageList over lightweight list fields', () => {
    const formatted = formatScrapedNotes([
      {
        id: 'detail-priority-1',
        title: '轻量标题',
        desc: '',
        imageList: ['http://sns-webpic-qc.xhscdn.com/list-cover'],
        detail: {
          desc: '详情正文优先',
          imageList: [
            { url_default: 'http://sns-webpic-qc.xhscdn.com/detail-image-1' },
            { url_default: 'http://sns-webpic-qc.xhscdn.com/detail-image-2' },
          ],
        },
        note_card: {
          display_title: '详情优先标题',
          user: { nickname: '作者F', avatar: 'http://sns-avatar.xhscdn.com/avatar-f' },
          interact_info: { liked_count: '3', collected_count: '2', share_count: '1' },
        },
      },
    ]);

    expect(formatted[0].desc).toBe('详情正文优先');
    expect(formatted[0].imageList).toEqual([
      'http://sns-webpic-qc.xhscdn.com/detail-image-1',
      'http://sns-webpic-qc.xhscdn.com/detail-image-2',
    ]);
  });

  it('merges history analysis notes with raw note images when legacy analysis lacks covers', () => {
    const workspace = historyToWorkspaceState({
      id: 1,
      user_id: 'u1',
      task_id: 'task-1',
      keyword: '测试关键词',
      notes_count: 1,
      created_at: '2026-04-03T10:00:00Z',
      filters: undefined,
      notes_data: [
        {
          id: 'note-1',
          note_card: {
            display_title: '封面测试',
            cover: {
              url_default: 'http://sns-webpic-qc.xhscdn.com/default-image',
              url_pre: 'http://sns-webpic-qc.xhscdn.com/preview-image',
            },
            user: { nickname: '作者A', avatar: 'http://sns-avatar.xhscdn.com/avatar-a' },
            interact_info: { liked_count: '10', collected_count: '5', share_count: '2' },
          },
        },
      ],
      analysis_result: {
        benchmark_notes: [
          {
            id: 'note-1',
            title: '封面测试',
            content_category: '测评类',
            recommendation_tier: '强推荐',
            rewrite_value_score: 88,
            commercial_fit_score: 76,
            recommendation_reason: '适合作为仿写样本',
            material_dependency: '纯概念',
          },
        ],
      },
    });

    expect(workspace.analysis?.benchmarkNotes[0].imageUrl).toBe('http://sns-webpic-qc.xhscdn.com/default-image');
    expect(workspace.analysis?.benchmarkNotes[0].imageList).toEqual(['http://sns-webpic-qc.xhscdn.com/default-image']);
    expect(workspace.analysis?.benchmarkNotes[0].stableImageUrl).toBe('/api/scraper/image-proxy?url=https%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fdefault-image');
  });

  it('always prefers raw history display fields over analysis note display fields', () => {
    const workspace = historyToWorkspaceState({
      id: 2,
      user_id: 'u2',
      task_id: 'task-2',
      keyword: '测试关键词2',
      notes_count: 1,
      created_at: '2026-04-03T10:00:00Z',
      filters: undefined,
      notes_data: [
        {
          id: 'note-2',
          note_card: {
            display_title: '原始标题',
            cover: {
              url_default: 'http://sns-webpic-qc.xhscdn.com/raw-default-image',
              url_pre: 'http://sns-webpic-qc.xhscdn.com/raw-preview-image',
            },
            user: { nickname: '原始作者', avatar: 'http://sns-avatar.xhscdn.com/raw-avatar' },
            interact_info: { liked_count: '66', collected_count: '21', share_count: '8' },
          },
          detail: {
            desc: '原始正文',
            tags: ['原始标签'],
          },
        },
      ],
      analysis_result: {
        benchmark_notes: [
          {
            id: 'note-2',
            title: '分析标题',
            desc: '分析正文',
            author: '分析作者',
            authorAvatar: 'http://sns-avatar.xhscdn.com/analysis-avatar',
            imageUrl: 'http://sns-webpic-qc.xhscdn.com/analysis-image',
            imageList: ['http://sns-webpic-qc.xhscdn.com/analysis-image'],
            tags: ['分析标签'],
            content_category: '测评类',
            recommendation_tier: '强推荐',
            rewrite_value_score: 92,
            commercial_fit_score: 88,
            recommendation_reason: '适合作为仿写样本',
            material_dependency: '纯概念',
          },
        ],
      },
    });

    expect(workspace.analysis?.benchmarkNotes[0].title).toBe('原始标题');
    expect(workspace.analysis?.benchmarkNotes[0].desc).toBe('原始正文');
    expect(workspace.analysis?.benchmarkNotes[0].author).toBe('原始作者');
    expect(workspace.analysis?.benchmarkNotes[0].imageUrl).toBe('http://sns-webpic-qc.xhscdn.com/raw-default-image');
    expect(workspace.analysis?.benchmarkNotes[0].imageList).toEqual(['http://sns-webpic-qc.xhscdn.com/raw-default-image']);
    expect(workspace.analysis?.benchmarkNotes[0].tags).toEqual(['原始标签']);
    expect(workspace.analysis?.benchmarkNotes[0].stableImageList?.[0]).toBe('/api/scraper/image-proxy?url=https%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fraw-default-image');
  });

  it('parses csv image_list fields and keeps one url per actual image', () => {
    const formatted = formatScrapedNotes([
      {
        id: 'csv-note-1',
        title: 'CSV 图片测试',
        author: '作者C',
        authorAvatar: 'http://sns-avatar.xhscdn.com/avatar-c',
        likes: '1',
        stars: '1',
        views: '1',
        image_list: [
          'http://sns-webpic-qc.xhscdn.com/image-1,http://sns-webpic-qc.xhscdn.com/image-2',
        ].join(','),
      },
      {
        id: 'variant-note-1',
        note_card: {
          display_title: '多规格图片测试',
          user: { nickname: '作者D', avatar: 'http://sns-avatar.xhscdn.com/avatar-d' },
          interact_info: { liked_count: '2', collected_count: '2', share_count: '1' },
          image_list: [
            {
              info_list: [
                { url: 'http://sns-webpic-qc.xhscdn.com/image-a-small' },
                { url: 'http://sns-webpic-qc.xhscdn.com/image-a-large' },
              ],
              url_default: 'http://sns-webpic-qc.xhscdn.com/image-a-default',
              url_pre: 'http://sns-webpic-qc.xhscdn.com/image-a-preview',
            },
            {
              info_list: [
                { url: 'http://sns-webpic-qc.xhscdn.com/image-b-small' },
                { url: 'http://sns-webpic-qc.xhscdn.com/image-b-large' },
              ],
              url_default: 'http://sns-webpic-qc.xhscdn.com/image-b-default',
              url_pre: 'http://sns-webpic-qc.xhscdn.com/image-b-preview',
            },
          ],
        },
      },
    ]);

    expect(formatted[0].imageList).toEqual([
      'http://sns-webpic-qc.xhscdn.com/image-1',
      'http://sns-webpic-qc.xhscdn.com/image-2',
    ]);
    expect(formatted[1].imageList).toEqual([
      'http://sns-webpic-qc.xhscdn.com/image-a-default',
      'http://sns-webpic-qc.xhscdn.com/image-b-default',
    ]);
  });

  it('keeps a single canonical display sequence for mixed-source notes', () => {
    const note = formatScrapedNotes([
      {
        id: 'mixed-note-1',
        title: '重复图集样例',
        author: '作者F',
        authorAvatar: 'http://sns-avatar.xhscdn.com/avatar-f',
        likes: '1',
        stars: '1',
        views: '1',
        imageList: [
          'http://sns-webpic-qc.xhscdn.com/runtime-1',
          'http://sns-webpic-qc.xhscdn.com/runtime-2',
        ],
        stableImageList: [
          '/api/scraper/image-proxy?url=https%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fruntime-1',
          '/api/scraper/image-proxy?url=https%3A%2F%2Fsns-webpic-qc.xhscdn.com%2Fruntime-2',
        ],
        resolvedImageList: ['blob:runtime-1', '', 'blob:should-not-expand'],
      },
    ])[0];

    expect(getCanonicalImageSequence(note)).toEqual([
      'http://sns-webpic-qc.xhscdn.com/runtime-1',
      'http://sns-webpic-qc.xhscdn.com/runtime-2',
    ]);
    expect(note.resolvedImageList).toEqual(['blob:runtime-1', '']);
  });

  it('preserves resolved image indexes when merging recovery results', () => {
    expect(normalizeResolvedImageList(['blob:a', '', 'blob:c'], 3)).toEqual(['blob:a', '', 'blob:c']);
    expect(mergeResolvedImageLists(['blob:a', '', ''], ['', 'blob:b'], 3)).toEqual(['blob:a', 'blob:b', '']);
  });

  it('dedupes duplicated notes before showing results', () => {
    const formatted = formatScrapedNotes([
      {
        id: 'dup-note-1',
        note_card: {
          display_title: '重复笔记',
          cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/a' },
          user: { nickname: '作者A', avatar: 'http://sns-avatar.xhscdn.com/avatar-a' },
          interact_info: { liked_count: '10', collected_count: '5', share_count: '2' },
        },
      },
      {
        id: 'dup-note-1',
        note_card: {
          display_title: '重复笔记',
          cover: { url_default: 'http://sns-webpic-qc.xhscdn.com/a' },
          user: { nickname: '作者A', avatar: 'http://sns-avatar.xhscdn.com/avatar-a' },
          interact_info: { liked_count: '10', collected_count: '5', share_count: '2' },
        },
        comments: [{ content: '这条评论只该保留一份', userName: '用户1' }],
      },
    ]);

    expect(formatted).toHaveLength(1);
    expect(formatted[0].comments).toHaveLength(1);
  });

  it('dedupes duplicated benchmark notes for existing analysis payloads', () => {
    const deduped = dedupeBenchmarkNotes([
      {
        id: 'bench-1',
        title: '重复样本',
        author: '作者A',
        authorAvatar: '',
        likes: '10',
        stars: '5',
        views: '1',
        shares: '0',
        imageUrl: 'http://sns-webpic-qc.xhscdn.com/a',
        imageList: ['http://sns-webpic-qc.xhscdn.com/a'],
        content_category: '测评类',
        commercial_fit_score: 70,
        rewrite_value_score: 80,
        recommendation_tier: '强推荐',
        recommendation_reason: 'reason',
        material_dependency: '纯概念',
      },
      {
        id: 'bench-1',
        title: '重复样本',
        author: '作者A',
        authorAvatar: '',
        likes: '12',
        stars: '6',
        views: '1',
        shares: '0',
        imageUrl: 'http://sns-webpic-qc.xhscdn.com/a',
        imageList: ['http://sns-webpic-qc.xhscdn.com/a'],
        content_category: '测评类',
        commercial_fit_score: 75,
        rewrite_value_score: 83,
        recommendation_tier: '强推荐',
        recommendation_reason: 'reason',
        material_dependency: '纯概念',
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].rewrite_value_score).toBe(83);
  });

  it('prefers note publish timestamps in the expected priority order', () => {
    const [formatted] = formatScrapedNotes([
      {
        id: 'time-priority-1',
        title: '发布时间优先级',
        author: '作者G',
        note_card: {
          display_title: '发布时间优先级',
          user: { nickname: '作者G', avatar: 'http://sns-avatar.xhscdn.com/avatar-g' },
          interact_info: { liked_count: '1', collected_count: '1', share_count: '0' },
          time: 1713700000,
        },
        detail: {
          time: 1713600000,
        },
        time: 1713800000,
      },
    ]);

    expect(formatted.time).toBe(1713800000 * 1000);
  });

  it('falls back to create_time and keeps textual publish labels when available', () => {
    const [formatted] = formatScrapedNotes([
      {
        id: 'time-fallback-1',
        title: '文本发布时间',
        author: '作者H',
        create_time: 1713500000,
        create_date_time: '2024-04-19',
        note_card: {
          user: { nickname: '作者H', avatar: 'http://sns-avatar.xhscdn.com/avatar-h' },
          interact_info: { liked_count: '1', collected_count: '1', share_count: '0' },
        },
      },
    ]);

    expect(formatted.time).toBe(1713500000 * 1000);
    expect(formatted.publishedAtLabel).toBe('2024-04-19');
  });

  it('extracts publish time from nested detail.note_card fields', () => {
    const [formatted] = formatScrapedNotes([
      {
        id: 'time-fallback-2',
        title: '嵌套发布时间',
        author: '作者H2',
        detail: {
          note_card: {
            time: 1713800000,
            create_time: 1713700000,
            create_date_time: '2024-04-23',
          },
        },
        note_card: {
          user: { nickname: '作者H2', avatar: 'http://sns-avatar.xhscdn.com/avatar-h2' },
          interact_info: { liked_count: '1', collected_count: '1', share_count: '0' },
        },
      },
    ]);

    expect(formatted.time).toBe(1713800000 * 1000);
    expect(formatted.publishedAtLabel).toBe('2024-04-23');
  });

  it('does not fabricate the current date when a note has no publish time', () => {
    const [formatted] = formatScrapedNotes([
      {
        id: 'time-missing-1',
        title: '无发布时间',
        author: '作者I',
        note_card: {
          user: { nickname: '作者I', avatar: 'http://sns-avatar.xhscdn.com/avatar-i' },
          interact_info: { liked_count: '1', collected_count: '1', share_count: '0' },
        },
      },
    ]);

    expect(formatted.time).toBeUndefined();
    expect(formatted.publishedAtLabel).toBeUndefined();
  });

  it('filters out notes that do not satisfy the publishTime window', () => {
    const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const old = Date.now() - 300 * 24 * 60 * 60 * 1000;

    const filtered = filterNotesByPublishTime([
      {
        id: 'recent-note',
        title: '最近发布',
        author: '作者J',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        time: recent,
      },
      {
        id: 'old-note',
        title: '很早发布',
        author: '作者K',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        time: old,
      },
    ], '一周内');

    expect(filtered.map((item) => item.id)).toEqual(['recent-note']);
  });

  it('parses relative publish labels used by xiaohongshu', () => {
    const filtered = filterNotesByPublishTime([
      {
        id: 'day-ago-note',
        title: '昨天发布',
        author: '作者L',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        publishedAtLabel: '昨天',
      },
      {
        id: 'three-days-note',
        title: '三天前发布',
        author: '作者M',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        publishedAtLabel: '3天前',
      },
    ], '一周内');

    expect(filtered.map((item) => item.id)).toEqual(['day-ago-note', 'three-days-note']);
  });

  it('parses month-day labels without fabricating an old year', () => {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(Math.max(1, now.getDate() - 2)).padStart(2, '0');
    const filtered = filterNotesByPublishTime([
      {
        id: 'month-day-note',
        title: '月日发布时间',
        author: '作者N',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
        publishedAtLabel: `${month}-${day}`,
      },
    ], '一周内');

    expect(filtered.map((item) => item.id)).toEqual(['month-day-note']);
  });

  it('keeps notes whose publish time cannot be resolved when request-side filtering was already strict', () => {
    const filtered = filterNotesByPublishTime([
      {
        id: 'unknown-time-note',
        title: '未知时间',
        author: '作者O',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '1',
        imageUrl: '',
      },
    ], '一周内');

    expect(filtered.map((item) => item.id)).toEqual(['unknown-time-note']);
  });
});
