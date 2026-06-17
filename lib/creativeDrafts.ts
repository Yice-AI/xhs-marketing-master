import {
  Asset,
  BenchmarkNote,
  CreativeDraftPreviewPayload,
  CreativeDraftSnapshot,
  GeneratedNoteRecord,
  ProductBrief,
  ReferenceAsset,
  RewriteSession,
  StudioDraftState,
} from '../types';
import { sanitizeMarkdownForXhs } from './xhsContent';

export const CREATIVE_DRAFT_SNAPSHOT_VERSION = 1;
const BODY_PREVIEW_LIMIT = 100;

const normalizeText = (value?: string | null) => sanitizeMarkdownForXhs(value || '').replace(/\s+/g, ' ').trim();
const isTransientDraftImageUrl = (value?: string | null) => String(value || '').trim().startsWith('blob:');

const getAssetStableUrl = (asset?: Asset | null) => {
  if (!asset) return '';
  const exportReady = String(asset.exportReadyUrl || '').trim();
  if (exportReady && !isTransientDraftImageUrl(exportReady)) return exportReady;
  const direct = String(asset.url || '').trim();
  if (direct && !isTransientDraftImageUrl(direct)) return direct;
  return '';
};

export const resolveDraftCoverImageUrl = ({
  generatedNote,
  activeAssetId,
  preferredUrl,
}: {
  generatedNote?: GeneratedNoteRecord | null;
  activeAssetId?: string | null;
  preferredUrl?: string | null;
}) => {
  const normalizedPreferred = String(preferredUrl || '').trim();
  if (normalizedPreferred && !isTransientDraftImageUrl(normalizedPreferred)) {
    return normalizedPreferred;
  }

  const assets = generatedNote?.assets || [];
  const activeAsset = activeAssetId ? assets.find((asset) => asset.id === activeAssetId) : null;
  const activeStable = getAssetStableUrl(activeAsset);
  if (activeStable) return activeStable;

  for (const asset of assets) {
    const stable = getAssetStableUrl(asset);
    if (stable) return stable;
  }

  return normalizedPreferred;
};

export const buildCreativeDraftTitle = ({
  explicitTitle,
  generatedNote,
  latestProductBrief,
}: {
  explicitTitle?: string | null;
  generatedNote?: GeneratedNoteRecord | null;
  latestProductBrief?: ProductBrief | null;
}) => {
  const cleanedExplicit = normalizeText(explicitTitle);
  if (cleanedExplicit) return cleanedExplicit;
  const noteTitle = normalizeText(generatedNote?.title);
  if (noteTitle) return noteTitle;
  const productName = normalizeText(latestProductBrief?.product_name);
  const now = new Date();
  const timeLabel = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return productName ? `${productName} · ${timeLabel}` : `未命名草稿 · ${timeLabel}`;
};

export const buildCreativeDraftSourceContext = ({
  selectedBenchmarkNote,
  latestProductBrief,
}: {
  selectedBenchmarkNote?: BenchmarkNote | null;
  latestProductBrief?: ProductBrief | null;
}) => {
  const benchmarkId = String(selectedBenchmarkNote?.id || '').trim();
  if (benchmarkId) return `benchmark:${benchmarkId}`;
  const productName = normalizeText(latestProductBrief?.product_name);
  return productName ? `product:${productName}` : null;
};

export const buildCreativeDraftPreview = ({
  snapshot,
  generatedNote,
  rewriteSession,
  studioContentState,
}: {
  snapshot: CreativeDraftSnapshot;
  generatedNote?: GeneratedNoteRecord | null;
  rewriteSession?: RewriteSession | null;
  studioContentState?: StudioDraftState | null;
}): CreativeDraftPreviewPayload => {
  const note = generatedNote || snapshot.generatedNote;
  const session = rewriteSession || snapshot.rewriteSession;
  const studio = studioContentState || snapshot.studioContentState;

  const bodySource = normalizeText(
    studio?.body
    || note?.pendingConfirmation?.body
    || session?.final_body
    || session?.deep_polish_body
    || session?.minimal_polish_body
    || session?.polished_body
    || session?.body_draft
    || note?.content
  );

  const bodyPreview = bodySource.length <= BODY_PREVIEW_LIMIT
    ? bodySource
    : `${bodySource.slice(0, BODY_PREVIEW_LIMIT).trimEnd()}...`;

  return {
    content_mode_label: String(note?.imageModeLabel || note?.imageMode || '创作草稿'),
    has_studio_edit: Boolean(studio?.updatedAt),
    body_preview: bodyPreview,
    cover_image_url: resolveDraftCoverImageUrl({
      generatedNote: note,
      activeAssetId: studio?.activeAssetId || note?.studioDraftState?.activeAssetId,
      preferredUrl: studio?.mainImageUrl || note?.studioDraftState?.mainImageUrl || '',
    }),
  };
};

export const serializeReferenceAssetsForDraft = (assets: ReferenceAsset[]) => assets.map((asset) => ({
  id: asset.id,
  user_id: asset.user_id,
  file_name: asset.file_name,
  original_name: asset.original_name,
  url: asset.url,
  mime_type: asset.mime_type,
  size: asset.size,
  width: asset.width,
  height: asset.height,
  created_at: asset.created_at,
}));

export const hasMeaningfulCreativeDraftSnapshot = (snapshot: CreativeDraftSnapshot) => Boolean(
  normalizeText(snapshot.latestProductBrief?.product_name)
  || normalizeText(snapshot.creationState.productName)
  || normalizeText(snapshot.generatedNote?.title)
  || normalizeText(snapshot.generatedNote?.content)
  || normalizeText(snapshot.rewriteSession?.body_draft)
  || normalizeText(snapshot.studioContentState?.body)
);
