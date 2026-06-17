import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_FILTERS } from '../types';
import { historyToWorkspaceState, normalizeAnalysis, sanitizeSearchFilters } from '../lib/scraperData';

describe('scraperData helpers', () => {
  it('fills missing filter fields with defaults', () => {
    expect(sanitizeSearchFilters({ sortBy: '最新' })).toEqual({
      ...DEFAULT_SEARCH_FILTERS,
      sortBy: '最新',
    });
  });

  it('normalizes backend analysis payloads with followup filter defaults', () => {
    const result = normalizeAnalysis({
      viral_notes_count: 2,
      basic_stats: {
        avg_likes: 88,
        avg_collects: 22,
        avg_title_length: 10,
        emoji_usage_rate: 12,
      },
      benchmark_notes: [],
      grouped_benchmark_notes: {},
      next_collection_tasks: [
        {
          category: '教程类',
          reason: '样本不足',
          keywords: ['教程'],
          keyword_text: '教程',
          max_notes_count: 12,
          enable_comments: true,
        },
      ],
    });

    expect(result.nextCollectionTasks[0].filters).toEqual(DEFAULT_SEARCH_FILTERS);
    expect(result.basicStats.avgLikes).toBe(88);
  });

  it('restores history tasks into workspace state', () => {
    const workspace = historyToWorkspaceState({
      id: 1,
      user_id: 'demo',
      task_id: 'task-1',
      keyword: '护眼台灯',
      notes_count: 1,
      created_at: new Date().toISOString(),
      filters: { ...DEFAULT_SEARCH_FILTERS, noteType: '图文' },
      notes_data: [
        {
          id: 'note-1',
          note_card: {
            display_title: '标题',
            user: { nickname: '作者' },
            interact_info: { liked_count: 1, collected_count: 2 },
          },
        },
      ],
      analysis_result: null,
    });

    expect(workspace.filters.noteType).toBe('图文');
    expect(workspace.currentResults[0].title).toBe('标题');
    expect(workspace.analysis).toBeNull();
  });
});
