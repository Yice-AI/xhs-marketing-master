export type TemplateFrameProfile = {
  badgePadding: string;
  badgeRadius: string;
  badgeShadow?: string;
  badgeBackground?: string;
  badgeTextColor?: string;
  titleLineHeight: number;
  titleTracking: string;
  titleMaxWidth: string;
  subtitleLineHeight: number;
  subtitleMaxWidth: string;
  titleMarginTop: number;
  subtitleMarginTop: number;
  shellPadding: number;
  shellPaddingCompact: number;
  footerFontSize: number;
  ctaFontSize: number;
  ctaPadding: string;
  ctaRadius: string;
};

export type TextCoverProfile = {
  titleLineHeight: number;
  titleMaxWidth: string;
  titleMarginTop: number;
  dividerGap: number;
  subtitleMarginTop: number;
  subtitleMaxWidth: string;
  stickerPadding: string;
  centerBlockMarginTop: number;
  footerTopMargin: number;
  footerMaxWidth: string;
  bottomPaddingTop: number;
  bottomHeadlineMaxWidth: string;
  ctaPadding: string;
  ctaFontSize: number;
  wordBreak: 'keep-all' | 'normal';
  overflowWrap: 'anywhere' | 'break-word';
};

export const TEXT_COVER_PROFILE: TextCoverProfile = {
  titleLineHeight: 0.84,
  titleMaxWidth: '86%',
  titleMarginTop: 28,
  dividerGap: 6,
  subtitleMarginTop: 20,
  subtitleMaxWidth: '62%',
  stickerPadding: '18px 30px',
  centerBlockMarginTop: 0,
  footerTopMargin: 8,
  footerMaxWidth: '72%',
  bottomPaddingTop: 16,
  bottomHeadlineMaxWidth: '76%',
  ctaPadding: '18px 32px',
  ctaFontSize: 26,
  wordBreak: 'keep-all',
  overflowWrap: 'anywhere',
};

export const FRAME_TEMPLATE_PROFILES: Record<string, TemplateFrameProfile> = {
  split_banner_card: {
    badgePadding: '10px 16px',
    badgeRadius: '999px',
    titleLineHeight: 0.92,
    titleTracking: '-0.05em',
    titleMaxWidth: '92%',
    subtitleLineHeight: 1.42,
    subtitleMaxWidth: '78%',
    titleMarginTop: 18,
    subtitleMarginTop: 20,
    shellPadding: 40,
    shellPaddingCompact: 32,
    footerFontSize: 20,
    ctaFontSize: 26,
    ctaPadding: '18px 30px',
    ctaRadius: '999px',
  },
  editorial_outline_card: {
    badgePadding: '0',
    badgeRadius: '0',
    titleLineHeight: 0.98,
    titleTracking: '-0.06em',
    titleMaxWidth: '100%',
    subtitleLineHeight: 1.42,
    subtitleMaxWidth: '100%',
    titleMarginTop: 0,
    subtitleMarginTop: 16,
    shellPadding: 0,
    shellPaddingCompact: 0,
    footerFontSize: 20,
    ctaFontSize: 24,
    ctaPadding: '14px 24px',
    ctaRadius: '999px',
  },
  sunset_glow_card: {
    badgePadding: '12px 18px',
    badgeRadius: '18px',
    badgeShadow: '0 18px 34px rgba(249,115,22,0.18)',
    titleLineHeight: 0.98,
    titleTracking: '-0.05em',
    titleMaxWidth: '100%',
    subtitleLineHeight: 1.45,
    subtitleMaxWidth: '78%',
    titleMarginTop: 26,
    subtitleMarginTop: 16,
    shellPadding: 36,
    shellPaddingCompact: 28,
    footerFontSize: 20,
    ctaFontSize: 26,
    ctaPadding: '16px 28px',
    ctaRadius: '999px',
  },
  notebook_tape_card: {
    badgePadding: '10px 16px',
    badgeRadius: '14px',
    titleLineHeight: 1,
    titleTracking: '-0.04em',
    titleMaxWidth: '100%',
    subtitleLineHeight: 1.46,
    subtitleMaxWidth: '100%',
    titleMarginTop: 26,
    subtitleMarginTop: 16,
    shellPadding: 36,
    shellPaddingCompact: 28,
    footerFontSize: 20,
    ctaFontSize: 26,
    ctaPadding: '16px 28px',
    ctaRadius: '999px',
  },
  soft_gradient_card: {
    badgePadding: '10px 18px',
    badgeRadius: '999px',
    badgeShadow: '0 12px 24px rgba(15,23,42,0.08)',
    titleLineHeight: 1,
    titleTracking: '-0.04em',
    titleMaxWidth: '100%',
    subtitleLineHeight: 1.46,
    subtitleMaxWidth: '100%',
    titleMarginTop: 28,
    subtitleMarginTop: 16,
    shellPadding: 36,
    shellPaddingCompact: 28,
    footerFontSize: 20,
    ctaFontSize: 26,
    ctaPadding: '16px 28px',
    ctaRadius: '999px',
  },
  default: {
    badgePadding: '10px 18px',
    badgeRadius: '999px',
    titleLineHeight: 1,
    titleTracking: '-0.04em',
    titleMaxWidth: '100%',
    subtitleLineHeight: 1.46,
    subtitleMaxWidth: '100%',
    titleMarginTop: 28,
    subtitleMarginTop: 16,
    shellPadding: 36,
    shellPaddingCompact: 28,
    footerFontSize: 20,
    ctaFontSize: 26,
    ctaPadding: '16px 28px',
    ctaRadius: '999px',
  },
};

export const getFrameTemplateProfile = (frameStyle?: string | null): TemplateFrameProfile => (
  FRAME_TEMPLATE_PROFILES[frameStyle || ''] || FRAME_TEMPLATE_PROFILES.default
);
