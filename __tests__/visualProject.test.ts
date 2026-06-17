import { describe, expect, it } from 'vitest';
import { buildVisualProjectFromSeriesResult, buildVisualProjectAssets, getActiveVisualCard } from '../lib/visualProject';

describe('visualProject helpers', () => {
  it('builds a multi-card visual project from a series result', async () => {
    const project = await buildVisualProjectFromSeriesResult({
      project: {
        projectId: 'project-1',
        title: '产品功能介绍',
        body: '这一组图会介绍产品的 3 个亮点和适合人群',
        noteVisualPlan: {
          cover_claim: '产品功能介绍',
          intro_hook: '用组图讲清楚核心价值',
          card_plan: [
            { card_type: '封面卡', template_kind: 'feature_hero', title: '封面', summary: '总览' },
            { card_type: '功能卡', template_kind: 'benefit_grid', title: '功能 1', summary: '卖点拆解' },
            { card_type: '收口卡', template_kind: 'feature_hero', title: '收口', summary: '适合谁用' },
          ],
        },
        cards: [],
        coverCardId: 'card-1',
        activeCardId: 'card-1',
        status: 'draft',
      },
      cards: [
        {
          cardId: 'card-1',
          cardType: '封面卡',
          templateKind: 'feature_hero',
          title: '封面',
          summary: '总览',
          document: {
            id: 'doc-1',
            canvas: { width: 1080, height: 1440 },
            templateKind: 'feature_hero',
            theme: 'warm',
            density: 'balanced',
            modules: [
              { id: 'title', type: 'title_block', visible: true, order: 1, content: '封面' },
              { id: 'subtitle', type: 'subtitle_block', visible: true, order: 2, content: '总览' },
              { id: 'screenshots', type: 'screenshot_frame', visible: false, order: 3, content: [] },
              { id: 'content', type: 'bullet_group', visible: true, order: 4, content: ['卖点一', '卖点二'] },
              { id: 'cta', type: 'cta_badge', visible: true, order: 5, content: '立即查看' },
              { id: 'footer', type: 'footer_note', visible: true, order: 6, content: '适合产品介绍' },
            ],
            assets: [],
            renderVersion: 1,
          },
          renderedAsset: {
            id: 'asset-1',
            url: 'data:image/svg+xml;charset=UTF-8,<svg></svg>',
            sourceType: 'template_compose',
            editablePayload: {
              version: 1,
              canvas: { width: 1080, height: 1440 },
              templateKind: 'feature_hero',
              themeKey: 'warm',
              density: 'balanced',
              title: '封面',
              subtitle: '总览',
              ctaText: '立即查看',
              footerNote: '适合产品介绍',
              bullets: ['卖点一', '卖点二'],
              features: [],
              steps: [],
              faqItems: [],
              screenshots: [],
            },
          },
          status: 'draft',
        },
        {
          cardId: 'card-2',
          cardType: '功能卡',
          templateKind: 'benefit_grid',
          title: '功能 1',
          summary: '卖点拆解',
          document: {
            id: 'doc-2',
            canvas: { width: 1080, height: 1440 },
            templateKind: 'benefit_grid',
            theme: 'warm',
            density: 'balanced',
            modules: [
              { id: 'title', type: 'title_block', visible: true, order: 1, content: '功能 1' },
              { id: 'subtitle', type: 'subtitle_block', visible: true, order: 2, content: '卖点拆解' },
              { id: 'screenshots', type: 'screenshot_frame', visible: false, order: 3, content: [] },
              { id: 'content', type: 'feature_grid', visible: true, order: 4, content: [{ title: 'A', description: 'B' }] },
              { id: 'cta', type: 'cta_badge', visible: true, order: 5, content: '立即查看' },
              { id: 'footer', type: 'footer_note', visible: true, order: 6, content: '适合产品介绍' },
            ],
            assets: [],
            renderVersion: 1,
          },
          renderedAsset: {
            id: 'asset-2',
            url: 'data:image/svg+xml;charset=UTF-8,<svg></svg>',
            sourceType: 'template_compose',
            editablePayload: {
              version: 1,
              canvas: { width: 1080, height: 1440 },
              templateKind: 'benefit_grid',
              themeKey: 'warm',
              density: 'balanced',
              title: '功能 1',
              subtitle: '卖点拆解',
              ctaText: '立即查看',
              footerNote: '适合产品介绍',
              bullets: [],
              features: [{ title: 'A', description: 'B' }],
              steps: [],
              faqItems: [],
              screenshots: [],
            },
          },
          status: 'draft',
        },
        {
          cardId: 'card-3',
          cardType: '收口卡',
          templateKind: 'feature_hero',
          title: '收口',
          summary: '适合谁用',
          document: {
            id: 'doc-3',
            canvas: { width: 1080, height: 1440 },
            templateKind: 'feature_hero',
            theme: 'warm',
            density: 'balanced',
            modules: [
              { id: 'title', type: 'title_block', visible: true, order: 1, content: '收口' },
              { id: 'subtitle', type: 'subtitle_block', visible: true, order: 2, content: '适合谁用' },
              { id: 'screenshots', type: 'screenshot_frame', visible: false, order: 3, content: [] },
              { id: 'content', type: 'bullet_group', visible: true, order: 4, content: ['人群一'] },
              { id: 'cta', type: 'cta_badge', visible: true, order: 5, content: '立即查看' },
              { id: 'footer', type: 'footer_note', visible: true, order: 6, content: '适合产品介绍' },
            ],
            assets: [],
            renderVersion: 1,
          },
          renderedAsset: {
            id: 'asset-3',
            url: 'data:image/svg+xml;charset=UTF-8,<svg></svg>',
            sourceType: 'template_compose',
            editablePayload: {
              version: 1,
              canvas: { width: 1080, height: 1440 },
              templateKind: 'feature_hero',
              themeKey: 'warm',
              density: 'balanced',
              title: '收口',
              subtitle: '适合谁用',
              ctaText: '立即查看',
              footerNote: '适合产品介绍',
              bullets: ['人群一'],
              features: [],
              steps: [],
              faqItems: [],
              screenshots: [],
            },
          },
          status: 'draft',
        },
      ],
      note_visual_plan: {
        cover_claim: '产品功能介绍',
        intro_hook: '用组图讲清楚核心价值',
        card_plan: [],
      },
      template_pack_key: 'product_feature_story',
    });

    expect(project.cards).toHaveLength(3);
    expect(project.coverCardId).toBe('card-1');
    expect(getActiveVisualCard(project)?.cardId).toBe('card-1');
    expect(buildVisualProjectAssets(project)).toHaveLength(3);
    expect(project.cards[1].renderedAsset.templateDocument?.templateKind).toBe('benefit_grid');
  });

  it('prefers editable payload when backend card document is only a placeholder', async () => {
    const project = await buildVisualProjectFromSeriesResult({
      project: {
        projectId: 'project-2',
        title: '教程组图',
        body: '看图讲步骤',
        cards: [],
        coverCardId: 'card-1',
        activeCardId: 'card-1',
      },
      cards: [
        {
          cardId: 'card-1',
          cardType: '封面卡',
          templateKind: 'feature_hero',
          title: '封面',
          summary: '总览',
          document: {
            id: 'placeholder-doc',
            canvas: { width: 1080, height: 1440 },
            templateKind: 'feature_hero',
            theme: 'warm',
            density: 'balanced',
            modules: [],
            assets: [],
            renderVersion: 1,
          },
          renderedAsset: {
            id: 'asset-placeholder',
            url: 'data:image/svg+xml;charset=UTF-8,<svg></svg>',
            sourceType: 'template_compose',
            editablePayload: {
              version: 1,
              canvas: { width: 1080, height: 1440 },
              templateKind: 'feature_hero',
              styleVariant: 'text_cover_bold',
              themeKey: 'warm',
              density: 'balanced',
              title: '封面',
              subtitle: '总览',
              ctaText: '立即查看',
              footerNote: '适合教程场景',
              bullets: ['步骤概览'],
              features: [],
              steps: [],
              faqItems: [],
              screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
            },
          },
          status: 'draft',
        },
      ],
    });

    expect(project.cards[0].document.modules.length).toBeGreaterThan(0);
    expect(project.cards[0].document.styleVariant).toBe('text_cover_bold');
  });
});
