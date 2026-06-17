import { describe, expect, it } from 'vitest';
import {
  clampCompactChars,
  countCompactChars,
  getDisplayLineCount,
  getStandardHeaderScale,
  getTemplateContentScale,
  getTemplateModuleInputRules,
  getStructuredContentDisplayProfile,
  getTextCoverDisplayContent,
  getTextCoverScaleProfile,
  shouldShowTextCoverSticker,
} from '../lib/templatePreviewLayout';

describe('templatePreviewLayout', () => {
  it('keeps long Chinese cover titles within four lines', () => {
    const display = getTextCoverDisplayContent(
      '做企业微私域的都懂：线索一多，最怕不是没流量，是承接不到位',
      '如果你们团队也在做企业微信私域，小红书、抖音、展会、视频号都会一起进线索',
      '核心内容在后面'
    );

    expect(getDisplayLineCount(display.title)).toBeLessThanOrEqual(4);
    expect(getDisplayLineCount(display.subtitle)).toBeLessThanOrEqual(4);
  });

  it('hides the sticker when cover copy is too dense', () => {
    const display = getTextCoverDisplayContent(
      '做企业微私域的都懂：线索一多，最怕不是没流量，是承接不到位',
      '如果你们团队也在做企业微信私域，小红书、抖音、展会、视频号都会一起进线索',
      '核心内容在后面'
    );

    expect(shouldShowTextCoverSticker(display.title, display.subtitle, '超详细')).toBe(false);
  });

  it('keeps structured page headers above the new readability floor', () => {
    const scale = getStandardHeaderScale(
      'benefit_grid',
      'highlight_screenshot_grid',
      '亮点拆解',
      '把核心卖点讲清楚',
      'soft_gradient_card'
    );

    expect(scale.title).toBeGreaterThanOrEqual(68);
    expect(scale.subtitle).toBeGreaterThanOrEqual(26);
  });

  it('raises content typography for cards and step bodies', () => {
    const sparseBenefit = getTemplateContentScale('benefit_grid', 1, 'highlight_screenshot_grid');
    const denseBenefit = getTemplateContentScale('benefit_grid', 8, 'highlight_screenshot_grid');
    const sparseStep = getTemplateContentScale('step_guide', 2, 'step_text_image');
    const denseStep = getTemplateContentScale('step_guide', 4, 'step_text_image');
    const coverScale = getTextCoverScaleProfile('标题示例', '副标题示例', '底部提示');

    expect(sparseBenefit.featureTitle).toBeGreaterThan(denseBenefit.featureTitle);
    expect(sparseBenefit.featureDescription).toBeGreaterThan(denseBenefit.featureDescription);
    expect(sparseStep.stepDescription).toBeGreaterThan(denseStep.stepDescription);
    expect(coverScale.title).toBeGreaterThanOrEqual(106);
    expect(coverScale.bottomHeadline).toBeGreaterThanOrEqual(108);
  });

  it('keeps benefit grid on half-width cards when three items are present', () => {
    const profile = getStructuredContentDisplayProfile('benefit_grid', [
      { title: '1', description: 'a' },
      { title: '2', description: 'b' },
      { title: '3', description: 'c' },
    ]);

    expect(profile.layout).toBe('grid');
    expect(profile.tier).toBe('balanced');
    expect(profile.maxItems).toBe(8);
  });

  it('clamps compact chars and exposes module input rules', () => {
    expect(countCompactChars('小 红 书 排 版')).toBe(5);
    expect(clampCompactChars('小红书长文章排版全流程', 6)).toBe('小红书长文章');

    const coverStickerRules = getTemplateModuleInputRules('feature_hero', 'title_block');
    const benefitRules = getTemplateModuleInputRules('benefit_grid', 'feature_grid');
    const benefitBodyRules = getTemplateModuleInputRules('benefit_grid', 'body_text_block');

    expect(coverStickerRules.singleLineLimit).toBe(28);
    expect(benefitRules.titleLimit).toBe(14);
    expect(benefitRules.descriptionLimit).toBe(24);
    expect(benefitRules.maxItems).toBe(8);
    expect(benefitBodyRules.bodyTextLimit).toBe(90);
  });
});
