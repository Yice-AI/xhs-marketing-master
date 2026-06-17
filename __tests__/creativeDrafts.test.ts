import { describe, expect, it } from 'vitest';

import {
  buildCreativeDraftPreview,
  buildCreativeDraftSourceContext,
  buildCreativeDraftTitle,
  hasMeaningfulCreativeDraftSnapshot,
} from '../lib/creativeDrafts';
import { CreativeDraftSnapshot } from '../types';

const baseSnapshot: CreativeDraftSnapshot = {
  workspace: 'CREATION',
  session_key: 'session-1',
  creationState: {
    productName: 'uplog',
    targetAudience: '内容创作者',
    productFeatures: '一键排版',
    contentStyle: 'seed',
    visualStyle: '温暖渐变卡片',
    strategyMode: 'research_first',
    isGenerating: false,
    generationStep: 0,
    generationProgress: 0,
    generationMessage: '',
    prompts: [],
    promptCount: 0,
    localGeneratedContent: null,
    generatedTags: [],
    draftSessionKey: 'session-1',
  },
  creationEditorState: {
    rewriteMode: '结构仿写',
    imageMode: '概念表达',
    visualStyle: '温暖渐变卡片',
    templatePageCount: 5,
    templateCopyStyle: '通用种草',
    templateKind: 'feature_hero',
    templateFrameStyle: 'soft_gradient_card',
    salesIntensity: 45,
    colloquialLevel: 75,
    authenticityLevel: 80,
    materialSummary: '',
    referenceSummary: '',
    selectedAssetIds: [],
    primaryReferenceAssetId: '',
    researchContext: null,
    strategyOptions: [],
    selectedStrategyId: '',
  },
  generatedNote: null,
  rewriteSession: null,
  selectedBenchmarkNote: null,
  referenceAssets: [],
  latestProductBrief: {
    product_name: 'uplog',
    target_audience: '内容创作者',
    product_features: '一键排版',
  },
  studioContentState: null,
};

describe('creativeDraft helpers', () => {
  it('builds preview from the richest available body and image data', () => {
    const preview = buildCreativeDraftPreview({
      snapshot: {
        ...baseSnapshot,
        studioContentState: {
          title: '标题',
          body: '这是 Studio 正在编辑的正文内容，用来生成预览摘要。',
          mainImageUrl: 'https://example.com/cover.png',
          activeAssetId: 'asset-1',
          activeAssetIndex: 0,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    expect(preview.has_studio_edit).toBe(true);
    expect(preview.cover_image_url).toBe('https://example.com/cover.png');
    expect(preview.body_preview).toContain('Studio 正在编辑');
  });

  it('builds a source context preferring benchmark notes', () => {
    const source = buildCreativeDraftSourceContext({
      selectedBenchmarkNote: {
        id: 'note-1',
        title: '测试',
        author: '作者',
        authorAvatar: '',
        likes: '1',
        stars: '1',
        views: '0',
        imageUrl: '',
        content_category: '教程类',
        commercial_fit_score: 1,
        rewrite_value_score: 1,
        recommendation_tier: '可参考',
        recommendation_reason: '',
        material_dependency: '纯概念',
      },
      latestProductBrief: baseSnapshot.latestProductBrief,
    });

    expect(source).toBe('benchmark:note-1');
  });

  it('detects meaningful snapshots and derives titles', () => {
    expect(hasMeaningfulCreativeDraftSnapshot(baseSnapshot)).toBe(true);
    expect(buildCreativeDraftTitle({
      explicitTitle: '',
      latestProductBrief: baseSnapshot.latestProductBrief,
    })).toContain('uplog');
  });
});
