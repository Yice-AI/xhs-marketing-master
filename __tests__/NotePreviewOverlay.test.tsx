import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import NotePreviewOverlay from '../components/NotePreviewOverlay';

vi.mock('../components/NoteCoverImage', () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const baseNote = {
  id: 'note-1',
  title: '测试笔记',
  desc: '正文',
  author: '作者A',
  authorAvatar: '',
  likes: '1',
  stars: '1',
  views: '1',
  shares: '0',
  imageUrl: 'http://example.com/cover.jpg',
  imageList: ['http://example.com/cover.jpg'],
  content_category: '测评类',
  commercial_fit_score: 80,
  rewrite_value_score: 85,
  recommendation_tier: '强推荐' as const,
  recommendation_reason: '适合仿写',
  material_dependency: '纯概念',
};

describe('NotePreviewOverlay', () => {
  it('shows the textual publish label before numeric timestamps', () => {
    render(
      <NotePreviewOverlay
        preview={{
          source: 'benchmark',
          note: {
            ...baseNote,
            time: 1713500000 * 1000,
            publishedAtLabel: '2024-04-19',
          },
        }}
        imageIndex={0}
        onImageChange={() => undefined}
        onClose={() => undefined}
        onSelectBenchmark={() => undefined}
        onRewriteNow={() => undefined}
      />
    );

    expect(screen.getByText('2024-04-19')).toBeTruthy();
  });

  it('shows a formatted real publish date when only a timestamp is available', () => {
    render(
      <NotePreviewOverlay
        preview={{
          source: 'benchmark',
          note: {
            ...baseNote,
            time: 1713500000 * 1000,
          },
        }}
        imageIndex={0}
        onImageChange={() => undefined}
        onClose={() => undefined}
        onSelectBenchmark={() => undefined}
        onRewriteNow={() => undefined}
      />
    );

    expect(screen.getByText(new Date(1713500000 * 1000).toLocaleDateString())).toBeTruthy();
  });

  it('shows unknown publish time instead of fabricating today', () => {
    render(
      <NotePreviewOverlay
        preview={{
          source: 'benchmark',
          note: {
            ...baseNote,
          },
        }}
        imageIndex={0}
        onImageChange={() => undefined}
        onClose={() => undefined}
        onSelectBenchmark={() => undefined}
        onRewriteNow={() => undefined}
      />
    );

    expect(screen.getByText('发布时间未知')).toBeTruthy();
  });
});
