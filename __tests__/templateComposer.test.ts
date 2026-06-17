import { describe, expect, it } from 'vitest';
import { applyDocumentStyleVariant, editablePayloadToDocument, documentToEditablePayload, renderTemplateAssetDataUrl, resolveTemplateStyleVariant } from '../lib/templateComposer';

describe('renderTemplateAssetDataUrl', () => {
  it('renders a data url for template assets', () => {
    const result = renderTemplateAssetDataUrl({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'feature_hero',
      themeKey: 'warm',
      density: 'balanced',
      title: '产品功能介绍',
      subtitle: '用结构化卡片讲清楚核心卖点',
      ctaText: '立即查看',
      footerNote: '适合产品教程场景',
      bullets: ['卖点一', '卖点二'],
      features: [{ title: '功能一', description: '功能一说明' }],
      steps: [{ title: '步骤 1', description: '打开产品并开始操作' }],
      faqItems: [{ title: 'Q1', description: '常见问题说明' }],
      screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
    });

    expect(result.startsWith('data:image/svg+xml')).toBe(true);
    expect(result.includes('svg')).toBe(true);
  });

  it('keeps old feature hero payloads compatible with freeform default', () => {
    const document = editablePayloadToDocument({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'feature_hero',
      themeKey: 'warm',
      density: 'balanced',
      title: '产品功能介绍',
      subtitle: '用结构化卡片讲清楚核心卖点',
      ctaText: '立即查看',
      footerNote: '适合产品教程场景',
      bullets: ['卖点一', '卖点二'],
      features: [],
      steps: [],
      faqItems: [],
      screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
    });

    expect(resolveTemplateStyleVariant(document.templateKind, document.styleVariant)).toBe('freeform_stage');
    expect(document.modules.find((item) => item.type === 'screenshot_frame')?.visible).toBe(true);
  });

  it('preserves body text block through document roundtrip', () => {
    const document = editablePayloadToDocument({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'benefit_grid',
      themeKey: 'warm',
      density: 'balanced',
      title: '产品功能介绍',
      subtitle: '用结构化卡片讲清楚核心卖点',
      ctaText: '立即查看',
      footerNote: '适合产品教程场景',
      bodyText: '这里是一段额外说明，用来填补下方留白。',
      bullets: [],
      features: [{ title: '功能一', description: '功能一说明' }],
      steps: [],
      faqItems: [],
      screenshots: [],
    });

    expect(document.modules.find((item) => item.type === 'body_text_block')?.content).toContain('额外说明');
    expect(documentToEditablePayload(document).bodyText).toContain('额外说明');
  });

  it('preserves screenshots when switching to text cover and back', () => {
    const source = editablePayloadToDocument({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'feature_hero',
      themeKey: 'warm',
      density: 'balanced',
      title: '产品功能介绍',
      subtitle: '用结构化卡片讲清楚核心卖点',
      ctaText: '立即查看',
      footerNote: '适合产品教程场景',
      bullets: ['卖点一', '卖点二'],
      features: [],
      steps: [],
      faqItems: [],
      screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
    });
    const cover = applyDocumentStyleVariant(source, 'text_cover_bold', { cardType: '封面卡' });
    const restored = applyDocumentStyleVariant(cover, 'freeform_stage', { cardType: '封面卡' });

    expect(cover.styleVariant).toBe('text_cover_bold');
    expect(cover.modules.find((item) => item.type === 'screenshot_frame')?.visible).toBe(false);
    expect(documentToEditablePayload(restored).screenshots).toHaveLength(1);
    expect(restored.modules.find((item) => item.type === 'screenshot_frame')?.visible).toBe(true);
  });

  it('renders text cover with restored oversized bottom headline and no english slogan block', () => {
    const result = decodeURIComponent(renderTemplateAssetDataUrl({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'feature_hero',
      styleVariant: 'text_cover_bold',
      themeKey: 'warm',
      density: 'balanced',
      title: '做企业微私域的都懂：线索一多，最怕不是没流量，是承接不到位',
      subtitle: '如果你们团队也在做企业微信私域，小红书、抖音、展会、视频号都会一起进线索',
      ctaText: '立即查看',
      footerNote: '核心内容在后面',
      bullets: [],
      features: [],
      steps: [],
      faqItems: [],
      screenshots: [],
    }));

    expect(result).toContain('核心内容在后面');
    expect(result).toContain('运营人都在看');
    expect(result).not.toContain('YUN YING PEOPLE ARE ALL WATCHING');
    expect(result).not.toContain('XIAO HONG SHU PAI BAN');
  });

  it('renders annotated and focus variants into svg output', () => {
    const annotated = renderTemplateAssetDataUrl({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'benefit_grid',
      styleVariant: 'annotated_highlight_grid',
      themeKey: 'warm',
      density: 'balanced',
      title: '亮点拆解',
      subtitle: '核心卖点说明',
      ctaText: '立即查看',
      footerNote: '适合宣传场景',
      bullets: [],
      features: [
        { title: '一键同步', description: '更高效' },
        { title: '自动排版', description: '更省心' },
      ],
      steps: [],
      faqItems: [],
      screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
    });
    const focus = renderTemplateAssetDataUrl({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'step_guide',
      styleVariant: 'step_focus_screenshot',
      themeKey: 'warm',
      density: 'balanced',
      title: '教程步骤',
      subtitle: '看图照做即可',
      ctaText: '立即查看',
      footerNote: '适合教程场景',
      bullets: [],
      features: [],
      steps: [
        { title: '步骤 1', description: '打开产品' },
        { title: '步骤 2', description: '选择功能' },
      ],
      faqItems: [],
      screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
    });

    expect(decodeURIComponent(annotated)).toContain('重点标注');
    expect(decodeURIComponent(focus)).toContain('打开产品');
  });

  it('keeps three benefit items in half-width grid without a featured first card', () => {
    const benefit = decodeURIComponent(renderTemplateAssetDataUrl({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'benefit_grid',
      styleVariant: 'highlight_screenshot_grid',
      themeKey: 'warm',
      density: 'balanced',
      title: '亮点拆解',
      subtitle: '核心卖点说明',
      ctaText: '立即查看',
      footerNote: '适合宣传场景',
      bullets: [],
      features: [
        { title: '新增文案1', description: '补充这一项说明' },
        { title: '新增文案2', description: '补充这一项说明' },
        { title: '新增文案3', description: '补充这一项说明' },
      ],
      steps: [],
      faqItems: [],
      screenshots: [{ url: 'https://example.com/demo.png', label: 'demo' }],
    }));

    expect(benefit).not.toContain('grid-column:1 / -1');
  });

  it('renders extra body text for component pages when provided', () => {
    const benefit = decodeURIComponent(renderTemplateAssetDataUrl({
      version: 1,
      canvas: { width: 1080, height: 1440 },
      templateKind: 'benefit_grid',
      styleVariant: 'highlight_screenshot_grid',
      themeKey: 'warm',
      density: 'balanced',
      title: '亮点拆解',
      subtitle: '核心卖点说明',
      ctaText: '立即查看',
      footerNote: '适合宣传场景',
      bodyText: '这里是一段自由文案，用来补充卖点页下方的总结说明。',
      bullets: [],
      features: [{ title: '新增文案1', description: '补充这一项说明' }],
      steps: [],
      faqItems: [],
      screenshots: [],
    }));

    expect(benefit).toContain('自由文案');
    expect(benefit).toContain('总结说明');
  });
});
