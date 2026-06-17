import { ProductBrief } from '../types';

export const createEmptyProductBrief = (): ProductBrief => ({
  product_name: '',
  target_audience: '',
  product_features: '',
  brand_tone: '真实体验感、口语化、不硬卖',
  must_include: '',
  banned_terms: '',
  reference_urls: [],
});

export const normalizeProductBrief = (brief?: Partial<ProductBrief> | null): ProductBrief => ({
  ...createEmptyProductBrief(),
  ...(brief || {}),
  reference_urls: Array.from(new Set(
    (Array.isArray(brief?.reference_urls) ? brief?.reference_urls : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  )),
});

export const getMissingProductBriefFields = (brief?: Partial<ProductBrief> | null): string[] => {
  const normalized = normalizeProductBrief(brief);
  const missing: string[] = [];

  if (!normalized.product_name.trim()) missing.push('产品名称');
  if (!normalized.target_audience.trim()) missing.push('目标人群');
  if (!normalized.product_features.trim()) missing.push('核心卖点');

  return missing;
};

export const isProductBriefComplete = (brief?: Partial<ProductBrief> | null): boolean => (
  getMissingProductBriefFields(brief).length === 0
);

export const hasMeaningfulProductBrief = (brief?: Partial<ProductBrief> | null): boolean => {
  if (!brief) return false;
  const normalized = normalizeProductBrief(brief);
  return Boolean(
    normalized.product_name.trim()
    || normalized.target_audience.trim()
    || normalized.product_features.trim()
    || (normalized.brand_tone || '').trim()
    || (normalized.must_include || '').trim()
    || (normalized.banned_terms || '').trim()
    || (normalized.reference_urls || []).length > 0
  );
};

export const buildProductBriefSignature = (brief?: Partial<ProductBrief> | null): string => {
  const normalized = normalizeProductBrief(brief);
  return JSON.stringify({
    product_name: normalized.product_name.trim(),
    target_audience: normalized.target_audience.trim(),
    product_features: normalized.product_features.trim(),
    brand_tone: (normalized.brand_tone || '').trim(),
    must_include: (normalized.must_include || '').trim(),
    banned_terms: (normalized.banned_terms || '').trim(),
    reference_urls: normalized.reference_urls || [],
  });
};

export const productBriefUrlsToText = (brief?: Partial<ProductBrief> | null): string => (
  (normalizeProductBrief(brief).reference_urls || []).join('\n')
);

export const parseProductBriefUrlsText = (value: string): string[] => Array.from(new Set(
  (value || '')
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean)
));
