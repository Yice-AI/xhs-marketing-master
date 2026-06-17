import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import HistoryView from '../components/HistoryView';
import { apiClient } from '../services/apiClient';
import React from 'react';

vi.mock('react-window', () => ({
  List: ({ children, itemCount }: any) => (
    <div data-testid="virtual-list">
      {Array.from({ length: Math.min(itemCount, 5) }).map((_, i) => children({ index: i, style: {} }))}
    </div>
  )
}));

vi.mock('../services/apiClient', () => ({
  apiClient: {
    getScrapeHistories: vi.fn(),
    getScrapeHistoryDetail: vi.fn(),
    analyzeLocalNotes: vi.fn(),
    updateScrapeHistoryAnalysis: vi.fn(),
  }
}));

describe('HistoryView Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (apiClient.getScrapeHistories as any).mockResolvedValue({
      success: true,
      data: [
        {
          id: 1,
          task_id: 'task-123',
          keyword: 'test keyword',
          notes_count: 5,
          created_at: new Date().toISOString()
        }
      ]
    });

    (apiClient.getScrapeHistoryDetail as any).mockResolvedValue({
      success: true,
      data: {
        id: 1,
        task_id: 'task-123',
        keyword: 'test keyword',
        notes_count: 5,
        created_at: new Date().toISOString(),
        notes_data: Array(5).fill({
          id: 'note-1',
          detail: { title: 'Test Note', desc: 'test desc' }
        })
      }
    });
  });

  it('renders history list and detail', async () => {
    render(<HistoryView />);
    
    // Check loading history list
    await waitFor(() => {
      expect(screen.getAllByText('test keyword').length).toBeGreaterThan(0);
    });

    // Check loading detail
    await waitFor(() => {
      expect(screen.getByText(/共 5 条数据/i)).toBeDefined();
    });
  });

  it('filters history list by search query', async () => {
    render(<HistoryView />);
    
    await waitFor(() => {
      expect(screen.getAllByText('test keyword').length).toBeGreaterThan(0);
    });

    const searchInput = screen.getByPlaceholderText('搜索关键词...');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    await waitFor(() => {
      expect(screen.queryAllByText('test keyword').length).toBe(1); // Only in the detail header, not in the list
      expect(screen.getByText('暂无历史记录')).toBeDefined();
    });
  });
});
