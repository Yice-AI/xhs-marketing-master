import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Asset, ContentData, CreativeDraftDetail, CreativeDraftSnapshot, CreativeDraftWorkspace, CreationEditorState, ReferenceAsset } from '../types';
import { LayoutContext } from '../App';
import { useNote } from '../contexts/NoteContext';
import { usePersistence } from '../contexts/PersistenceContext';
import { useScraperContext } from '../contexts/ScraperContext';
import AssetGallery from './AssetGallery';
import ContentEditor from './ContentEditor';
import AIChat from './AIChat';
import PreviewFrame from './PreviewFrame';
import CreativeDraftDrawer from './CreativeDraftDrawer';
import { getActiveVisualCard } from '../lib/visualProject';
import { documentToEditablePayload, renderTemplateDocumentDataUrl } from '../lib/templateComposer';
import { sanitizeMarkdownForXhs } from '../lib/xhsContent';
import apiClient, { normalizeAppErrorMessage } from '../services/apiClient';
import { buildCreativeDraftPreview, buildCreativeDraftSourceContext, buildCreativeDraftTitle, CREATIVE_DRAFT_SNAPSHOT_VERSION, hasMeaningfulCreativeDraftSnapshot, resolveDraftCoverImageUrl, serializeReferenceAssetsForDraft } from '../lib/creativeDrafts';
import { getLogoFixTaskImage, isLogoFixTaskCompleted, isLogoFixTaskTerminal, removeLogoFixActiveTaskId, shouldCancelLogoFixTask } from '../lib/logoFixTasks';

interface StudioViewProps {
  onContinueTemplateEdit?: () => void;
  onRestoreWorkspace?: (workspace: CreativeDraftWorkspace) => void;
}

const STUDIO_VIEW_BUILD_MARKER = 'studio-view-fix-2026-04-14-1650';

const fallbackContent: ContentData = {
  title: '先从创作页生成一条对标仿写稿',
  body: '当前工作台会承接你在创作页生成的去 AI 味正文、图片模式和视觉资产。',
  mainImageUrl: 'https://picsum.photos/400/600?random=1',
  authorName: '小红薯用户',
  authorAvatar: 'https://picsum.photos/100/100?random=10',
  likes: '1.2w',
  stars: '3456',
  comments: '892',
  tags: [],
};

const resolvePreferredBody = (generatedNote: NonNullable<ReturnType<typeof useNote>['generatedNote']>) => {
  const finalBody = sanitizeMarkdownForXhs(generatedNote.rewriteSession?.final_body || generatedNote.finalBody || '').trim();
  const minimal = sanitizeMarkdownForXhs(generatedNote.rewriteSession?.minimal_polish_body || '').trim();
  const deep = sanitizeMarkdownForXhs(generatedNote.rewriteSession?.deep_polish_body || '').trim();
  const polished = sanitizeMarkdownForXhs(generatedNote.rewriteSession?.polished_body || '').trim();
  const draft = sanitizeMarkdownForXhs(generatedNote.rewriteSession?.body_draft || '').trim();
  const fallback = sanitizeMarkdownForXhs(generatedNote.content || '').trim();

  if (finalBody) {
    return finalBody;
  }

  if (deep) {
    return deep;
  }

  if (minimal) {
    return minimal;
  }

  if (polished && draft) {
    const polishedIsTooShort = polished.length < Math.max(80, Math.floor(draft.length * 0.45));
    if (!polishedIsTooShort) {
      return polished;
    }
    return draft;
  }

  return polished || draft || fallback;
};

const areAssetsEquivalent = (left: Asset[], right: Asset[]) => (
  left.length === right.length
  && left.every((asset, index) => {
    const next = right[index];
    return next
      && asset.id === next.id
      && asset.url === next.url
      && asset.isProcessing === next.isProcessing
      && asset.statusText === next.statusText;
  })
);

const isLikelyLogoReferenceAsset = (asset: ReferenceAsset) => {
  const text = [
    asset.display_name,
    asset.original_name,
    asset.note,
    asset.ai_hint,
    ...(asset.tags || []),
  ].filter(Boolean).join(' ').toLowerCase();
  const looksLikeLogo = ['logo', 'brand', 'brandmark', 'logotype', '商标', '标识', '品牌'].some((token) => text.includes(token));
  const looksLikePage = ['页面', '截图', 'dashboard', 'screenshot', '界面', '看板', '后台'].some((token) => text.includes(token));
  return looksLikeLogo && !looksLikePage;
};

const getAssetImageId = (asset: Asset) => {
  const rawUrl = String(asset.url || '').split('?')[0].trim();
  if (!rawUrl) {
    return asset.id;
  }
  if (rawUrl.startsWith('data:')) {
    return asset.id;
  }
  const lastSegment = rawUrl.split('/').filter(Boolean).pop();
  if (!lastSegment) {
    return asset.id;
  }
  if (rawUrl.includes('/static/images/') || /\.(png|jpe?g|webp)$/i.test(lastSegment)) {
    return lastSegment;
  }
  if (/^task-[a-z0-9-]+$/i.test(asset.id)) {
    return asset.id;
  }
  return asset.id || lastSegment;
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const LOGO_FIX_POLL_INTERVAL_MS = 2000;
const LOGO_FIX_SINGLE_TASK_TIMEOUT_MS = 8 * 60 * 1000;
const LOGO_FIX_BATCH_TIMEOUT_MS = 18 * 60 * 1000;
const LOGO_FIX_MAX_ATTEMPTS = 2;
const LOGO_FIX_STABLE_CONCURRENCY = 2;
const LOGO_FIX_RETRY_DELAY_MS = 3000;
const LOGO_FIX_SESSION_STORAGE_KEY = 'xhs_studio_logo_fix_session';

type LogoFixBatchItem = {
  asset: Asset;
  index: number;
  attempts: number;
  candidateSeed: string;
  lastError?: string;
};

type LogoFixSuccess = {
  taskId: string;
  sourceAssetId: string;
  fixedAsset: Asset;
  promptMeta: {
    type: string;
    prompt: string;
    source_asset_id: string;
    target_image_id: string;
  };
};

type LogoFixFailure = {
  sourceAssetId: string;
  index: number;
  error: string;
  attempts: number;
};

type LogoFixPersistedItem = {
  sourceAssetId: string;
  index: number;
  taskId?: string;
  promptMeta?: LogoFixSuccess['promptMeta'];
  fixedAsset?: Asset;
  assetMode?: Asset['mode'] | string;
  attempts: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
};

type LogoFixPersistedSession = {
  id: string;
  noteKey: string;
  referenceAssetId: string;
  createdAt: number;
  updatedAt: number;
  total: number;
  items: LogoFixPersistedItem[];
};

const mergeLogoFixSuccessIntoAssets = (
  currentAssets: Asset[],
  sourceAssetId: string,
  fixedAsset: Asset,
) => currentAssets.map((asset) => {
  if (asset.id !== sourceAssetId) {
    return asset;
  }
  return {
    ...asset,
    id: asset.id,
    url: fixedAsset.url,
    promptLabel: fixedAsset.promptLabel,
    promptText: fixedAsset.promptText,
    visualModeResolved: fixedAsset.visualModeResolved,
    editSourceAssetId: asset.id,
    editPreservationMode: fixedAsset.editPreservationMode,
    referenceAssetIds: fixedAsset.referenceAssetIds,
  };
});

const mergeLogoFixSuccessIntoVisualProject = (
  project: VisualProject | null | undefined,
  sourceAssetId: string,
  fixedAsset: Asset,
): VisualProject | null | undefined => {
  if (!project?.cards?.length) {
    return project;
  }
  let changed = false;
  const cards = project.cards.map((card) => {
    if (card.renderedAsset.id !== sourceAssetId) {
      return card;
    }
    changed = true;
    return {
      ...card,
      renderedAsset: mergeLogoFixSuccessIntoAssets([card.renderedAsset], sourceAssetId, fixedAsset)[0],
      composeResult: card.composeResult ? {
        ...card.composeResult,
        rendered_image_url: fixedAsset.url,
      } : card.composeResult,
    };
  });
  return changed ? { ...project, cards } : project;
};

const loadLogoFixSession = (noteKey: string): LogoFixPersistedSession | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(LOGO_FIX_SESSION_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as LogoFixPersistedSession;
    if (!parsed || parsed.noteKey !== noteKey || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (error) {
    console.error('Failed to load logo fix session', error);
    return null;
  }
};

const saveLogoFixSession = (session: LogoFixPersistedSession | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (!session) {
      window.localStorage.removeItem(LOGO_FIX_SESSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(LOGO_FIX_SESSION_STORAGE_KEY, JSON.stringify({
      ...session,
      updatedAt: Date.now(),
    }));
  } catch (error) {
    console.error('Failed to persist logo fix session', error);
  }
};

const buildLogoFixPrompt = (_referenceName: string) => '把图里的 logo 换成参考图里的 logo。其他内容保持不变。';

const isSameContentState = (left: ContentData, right: ContentData) => (
  left.title === right.title
  && left.body === right.body
  && left.mainImageUrl === right.mainImageUrl
  && left.authorName === right.authorName
  && left.authorAvatar === right.authorAvatar
  && left.likes === right.likes
  && left.stars === right.stars
  && left.comments === right.comments
  && JSON.stringify(left.tags || []) === JSON.stringify(right.tags || [])
);

const buildStudioBaseHydrationKey = (note: NonNullable<ReturnType<typeof useNote>['generatedNote']>) => JSON.stringify({
  title: note.title,
  content: note.content,
  finalBody: note.finalBody || '',
  assetIds: (note.assets || []).map((asset) => `${asset.id}:${asset.url}`),
  visualProjectId: note.visualProject?.projectId || '',
  activeCardId: note.visualProject?.activeCardId || '',
  templateDraftStatus: note.templateDraftStatus || '',
});

const buildStudioChatSessionKey = (note: NonNullable<ReturnType<typeof useNote>['generatedNote']>) => JSON.stringify({
  taskIds: note.taskIds || [],
  assetIds: (note.assets || []).map((asset) => asset.id),
  visualProjectId: note.visualProject?.projectId || '',
  templateCardIds: note.visualProject?.cards?.map((card) => card.id) || [],
});

const buildLogoFixSessionNoteKey = (note: NonNullable<ReturnType<typeof useNote>['generatedNote']>) => JSON.stringify({
  title: note.title,
  assetIds: (note.assets || []).map((asset) => asset.id),
  visualProjectId: note.visualProject?.projectId || '',
  templateCardIds: note.visualProject?.cards?.map((card) => card.id) || [],
});

const StudioView: React.FC<StudioViewProps> = ({ onContinueTemplateEdit, onRestoreWorkspace }) => {
  const layout = useContext(LayoutContext);
  const { generatedNote, hasGeneratedContent, setGeneratedNote, updateAssets, exportGeneratedNoteState, restoreGeneratedNoteState } = useNote();
  const { exportCreationState, restoreCreationState, rotateDraftSessionKey } = usePersistence();
  const {
    latestProductBrief,
    setLatestProductBrief,
    referenceAssets,
    setReferenceAssets,
    selectedBenchmarkNote,
    setSelectedBenchmarkNote,
    rewriteSession,
    setRewriteSession,
  } = useScraperContext();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [activeAssetId, setActiveAssetId] = useState<string>('');
  const [activeAssetIndex, setActiveAssetIndex] = useState(0);
  const [content, setContent] = useState<ContentData>(fallbackContent);
  const [isDraftDrawerOpen, setIsDraftDrawerOpen] = useState(false);
  const [isLogoBatchSelectionMode, setIsLogoBatchSelectionMode] = useState(false);
  const [selectedLogoFixAssetIds, setSelectedLogoFixAssetIds] = useState<string[]>([]);
  const [isLogoFixDialogOpen, setIsLogoFixDialogOpen] = useState(false);
  const [selectedLogoFixReferenceAssetId, setSelectedLogoFixReferenceAssetId] = useState('');
  const [isApplyingLogoFix, setIsApplyingLogoFix] = useState(false);
  const [logoFixProgress, setLogoFixProgress] = useState({ submitted: 0, completed: 0, failed: 0, retrying: 0, total: 0 });
  const [isUploadingLogoAsset, setIsUploadingLogoAsset] = useState(false);
  const [isLoadingLogoAssets, setIsLoadingLogoAssets] = useState(false);
  const [logoAssetLoadError, setLogoAssetLoadError] = useState('');
  const [logoAssetFilterMode, setLogoAssetFilterMode] = useState<'logo' | 'all'>('logo');
  const [logoFixStatus, setLogoFixStatus] = useState('');
  const [logoFixStatusTone, setLogoFixStatusTone] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [logoFixStartedAt, setLogoFixStartedAt] = useState<number | null>(null);
  const activeImageTaskIdsRef = useRef<string[]>([]);
  const assetsRef = useRef<Asset[]>([]);
  const logoFixCancelRequestedRef = useRef(false);
  const logoFixSessionRef = useRef<LogoFixPersistedSession | null>(null);
  const appliedLogoFixTaskIdsRef = useRef<Set<string>>(new Set());
  const logoUploadInputRef = useRef<HTMLInputElement>(null);
  const autoDraftFingerprintRef = useRef('');
  const autoDraftTimerRef = useRef<number | null>(null);
  const lastHydratedBaseKeyRef = useRef('');
  const lastHydratedStudioDraftAtRef = useRef('');
  const localEditorDirtyRef = useRef(false);

  useEffect(() => {
    console.info('[StudioView marker]', STUDIO_VIEW_BUILD_MARKER);
  }, []);

  const pushLogoFixStatus = useCallback((message: string, tone: 'idle' | 'loading' | 'success' | 'error') => {
    setLogoFixStatus(message);
    setLogoFixStatusTone(tone);
  }, []);

  const pushLoadingStatus = useCallback((message: string) => pushLogoFixStatus(message, 'loading'), [pushLogoFixStatus]);
  const pushSuccessStatus = useCallback((message: string) => pushLogoFixStatus(message, 'success'), [pushLogoFixStatus]);
  const pushErrorStatus = useCallback((message: string) => pushLogoFixStatus(message, 'error'), [pushLogoFixStatus]);
  const removeActiveLogoFixTask = useCallback((taskId: string) => {
    activeImageTaskIdsRef.current = removeLogoFixActiveTaskId(activeImageTaskIdsRef.current, taskId);
  }, []);

  const logoFixNoteKey = useMemo(() => (
    generatedNote ? buildLogoFixSessionNoteKey(generatedNote) : ''
  ), [generatedNote]);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  const buildAssetsFromGeneratedNote = useCallback((note: NonNullable<ReturnType<typeof useNote>['generatedNote']>) => (
    note.visualProject?.cards?.map((card) => ({
      ...card.renderedAsset,
      templateDocument: card.document,
      editablePayload: documentToEditablePayload(card.document),
      url: renderTemplateDocumentDataUrl(card.document),
    })) || note.assets || []
  ), []);

  const logoReferenceAssets = useMemo(() => {
    const likely = referenceAssets.filter(isLikelyLogoReferenceAsset);
    if (logoAssetFilterMode === 'all') {
      return referenceAssets;
    }
    return likely.length > 0 ? likely : referenceAssets;
  }, [logoAssetFilterMode, referenceAssets]);

  const logoReferenceAssetCount = useMemo(
    () => referenceAssets.filter(isLikelyLogoReferenceAsset).length,
    [referenceAssets]
  );

  const refreshLogoReferenceAssets = useCallback(async (options?: { keepSelection?: boolean }) => {
    setIsLoadingLogoAssets(true);
    setLogoAssetLoadError('');
    try {
      const response = await apiClient.getReferenceAssets();
      const assetsFromLibrary = Array.isArray(response.data) ? response.data : [];
      setReferenceAssets(assetsFromLibrary);
      const firstLogoAsset = assetsFromLibrary.find(isLikelyLogoReferenceAsset) || assetsFromLibrary[0] || null;
      if (firstLogoAsset) {
        setSelectedLogoFixReferenceAssetId((prev) => (
          options?.keepSelection && assetsFromLibrary.some((asset) => asset.id === prev)
            ? prev
            : firstLogoAsset.id
        ));
      } else {
        setSelectedLogoFixReferenceAssetId('');
      }
    } catch (error) {
      console.error('加载 Logo 素材库失败:', error);
      setLogoAssetLoadError(normalizeAppErrorMessage(error, '素材库加载失败'));
    } finally {
      setIsLoadingLogoAssets(false);
    }
  }, [setReferenceAssets]);

  const applyHydratedStudioState = useCallback((payload: {
    note: NonNullable<ReturnType<typeof useNote>['generatedNote']>;
    assets: Asset[];
    studioDraftState?: typeof generatedNote extends null ? never : any;
  }) => {
    const { note, assets: nextAssets, studioDraftState } = payload;
    const activeVisualCard = getActiveVisualCard(note.visualProject);
    const restoredAssetId = studioDraftState?.activeAssetId || activeVisualCard?.renderedAsset.id || nextAssets[0]?.id || '';
    const restoredAssetIndex = typeof studioDraftState?.activeAssetIndex === 'number' ? studioDraftState.activeAssetIndex : 0;
    const restoredMainImageUrl = resolveDraftCoverImageUrl({
      generatedNote: note,
      activeAssetId: restoredAssetId,
      preferredUrl: studioDraftState?.mainImageUrl || activeVisualCard?.renderedAsset.url || nextAssets[0]?.url || fallbackContent.mainImageUrl,
    });
    const nextContent: ContentData = {
      title: studioDraftState?.title || note.title,
      body: studioDraftState?.body || resolvePreferredBody(note),
      mainImageUrl: restoredMainImageUrl,
      authorName: fallbackContent.authorName,
      authorAvatar: fallbackContent.authorAvatar,
      likes: fallbackContent.likes,
      stars: fallbackContent.stars,
      comments: fallbackContent.comments,
      tags: note.tags || [],
    };
    localEditorDirtyRef.current = false;
    setAssets((prev) => (areAssetsEquivalent(prev, nextAssets) ? prev : nextAssets));
    setActiveAssetId((prev) => (prev === restoredAssetId ? prev : restoredAssetId));
    setActiveAssetIndex((prev) => (prev === restoredAssetIndex ? prev : restoredAssetIndex));
    setContent((prev) => (isSameContentState(prev, nextContent) ? prev : nextContent));
  }, [generatedNote]);

  useEffect(() => {
    if (!generatedNote) {
      return;
    }

    const nextAssets = buildAssetsFromGeneratedNote(generatedNote);
    setAssets((prev) => (areAssetsEquivalent(prev, nextAssets) ? prev : nextAssets));

    const importedStudioState = generatedNote.studioDraftState || null;
    if (
      importedStudioState?.updatedAt
      && importedStudioState.updatedAt !== lastHydratedStudioDraftAtRef.current
    ) {
      lastHydratedStudioDraftAtRef.current = importedStudioState.updatedAt;
      lastHydratedBaseKeyRef.current = buildStudioBaseHydrationKey(generatedNote);
      applyHydratedStudioState({
        note: generatedNote,
        assets: nextAssets,
        studioDraftState: importedStudioState,
      });
      return;
    }

    const baseKey = buildStudioBaseHydrationKey(generatedNote);
    if (baseKey === lastHydratedBaseKeyRef.current) {
      return;
    }

    const shouldHydrateBase = !localEditorDirtyRef.current || !content.title || content.title === fallbackContent.title;
    if (!shouldHydrateBase) {
      lastHydratedBaseKeyRef.current = baseKey;
      return;
    }

    lastHydratedBaseKeyRef.current = baseKey;
    applyHydratedStudioState({
      note: generatedNote,
      assets: nextAssets,
      studioDraftState: null,
    });
  }, [applyHydratedStudioState, buildAssetsFromGeneratedNote, content.title, generatedNote]);

  const handleContentChange = useCallback((updated: Partial<ContentData>) => {
    localEditorDirtyRef.current = true;
    setContent((prev) => ({ ...prev, ...updated }));
  }, []);

  const handleAssetSelect = useCallback((id: string) => {
    localEditorDirtyRef.current = true;
    const nextIndex = assets.findIndex((item) => item.id === id);
    setActiveAssetId(id);
    setActiveAssetIndex(nextIndex >= 0 ? nextIndex : 0);
    const asset = assets.find((item) => item.id === id);
    if (asset) {
      setContent((prev) => ({ ...prev, mainImageUrl: asset.url }));
    }
  }, [assets]);

  const handleSelectAssetByIndex = useCallback((nextIndex: number) => {
    localEditorDirtyRef.current = true;
    const asset = assets[nextIndex];
    if (!asset) {
      return;
    }
    setActiveAssetId(asset.id);
    setActiveAssetIndex(nextIndex);
    setContent((prev) => ({ ...prev, mainImageUrl: asset.url }));
  }, [assets]);

  const handlePrevAsset = useCallback(() => {
    if (assets.length <= 1) {
      return;
    }
    const nextIndex = activeAssetIndex === 0 ? assets.length - 1 : activeAssetIndex - 1;
    handleSelectAssetByIndex(nextIndex);
  }, [activeAssetIndex, assets.length, handleSelectAssetByIndex]);

  const handleNextAsset = useCallback(() => {
    if (assets.length <= 1) {
      return;
    }
    const nextIndex = activeAssetIndex === assets.length - 1 ? 0 : activeAssetIndex + 1;
    handleSelectAssetByIndex(nextIndex);
  }, [activeAssetIndex, assets.length, handleSelectAssetByIndex]);

  const handleAssetUpdate = useCallback((id: string, newUrl: string) => {
    localEditorDirtyRef.current = true;
    setAssets((prev) => {
      const nextAssets = prev.map((asset) => asset.id === id ? { ...asset, url: newUrl, isProcessing: false } : asset);
      updateAssets(nextAssets);
      return nextAssets;
    });
    if (id === activeAssetId) {
      setContent((prev) => ({ ...prev, mainImageUrl: newUrl }));
    }
  }, [activeAssetId, updateAssets]);

  const handleAssetStatusChange = useCallback((id: string, isProcessing: boolean, statusText?: string) => {
    setAssets((prev) => {
      const nextAssets = prev.map((asset) => asset.id === id ? { ...asset, isProcessing, statusText } : asset);
      updateAssets(nextAssets);
      return nextAssets;
    });
  }, [updateAssets]);

  useEffect(() => {
    if (assets.length === 0) {
      setSelectedLogoFixAssetIds([]);
      setIsLogoBatchSelectionMode(false);
      setIsLogoFixDialogOpen(false);
      return;
    }

    setSelectedLogoFixAssetIds((prev) => prev.filter((assetId) => assets.some((asset) => asset.id === assetId)));
  }, [assets]);

  useEffect(() => {
    if (!isLogoFixDialogOpen) {
      return;
    }
    const nextReference = logoReferenceAssets.find((asset) => asset.id === selectedLogoFixReferenceAssetId)
      || logoReferenceAssets[0]
      || referenceAssets[0]
      || null;
    if (nextReference && nextReference.id !== selectedLogoFixReferenceAssetId) {
      setSelectedLogoFixReferenceAssetId(nextReference.id);
    }
  }, [isLogoFixDialogOpen, logoReferenceAssets, referenceAssets, selectedLogoFixReferenceAssetId]);

  useEffect(() => {
    if (!isLogoFixDialogOpen) {
      return;
    }
    void refreshLogoReferenceAssets({ keepSelection: true });
  }, [isLogoFixDialogOpen, refreshLogoReferenceAssets]);

  const selectedLogoFixReferenceAsset = useMemo(
    () => logoReferenceAssets.find((asset) => asset.id === selectedLogoFixReferenceAssetId) || null,
    [logoReferenceAssets, selectedLogoFixReferenceAssetId]
  );
  const logoFixTargetAssetIds = useMemo(() => {
    if (selectedLogoFixAssetIds.length > 0) {
      return selectedLogoFixAssetIds;
    }
    return activeAssetId ? [activeAssetId] : [];
  }, [activeAssetId, selectedLogoFixAssetIds]);
  const logoFixReadyTargetCount = useMemo(
    () => assets.filter((asset) => (
      logoFixTargetAssetIds.includes(asset.id)
      && !asset.url.startsWith('data:')
      && !asset.isProcessing
    )).length,
    [assets, logoFixTargetAssetIds]
  );
  const logoFixSubmitBlockedReason = useMemo(() => {
    if (isApplyingLogoFix) return '正在提交修正任务，请稍候。';
    if (isUploadingLogoAsset) return 'Logo 正在上传，请稍候。';
    if (logoFixTargetAssetIds.length === 0) return '请先选择要修正的生成图。';
    if (!selectedLogoFixReferenceAsset) return '请先选择或上传正确的 Logo 素材。';
    if (logoFixReadyTargetCount === 0) return '选中的图片暂时不能直接编辑，请选择已经生成完成的图片。';
    return '';
  }, [
    isApplyingLogoFix,
    isUploadingLogoAsset,
    logoFixReadyTargetCount,
    logoFixTargetAssetIds.length,
    selectedLogoFixReferenceAsset,
  ]);

  const handleToggleLogoFixAsset = useCallback((assetId: string) => {
    setSelectedLogoFixAssetIds((prev) => (
      prev.includes(assetId)
        ? prev.filter((itemId) => itemId !== assetId)
        : [...prev, assetId]
    ));
  }, []);

  const handleUploadLogoAsset = useCallback(async (file: File) => {
    try {
      setIsUploadingLogoAsset(true);
      const response = await apiClient.uploadReferenceAsset(file, {
        source: 'project_library',
        display_name: file.name || '品牌 Logo',
        tags: ['logo', '品牌标识'],
        ai_hint: '品牌 logo reference. Use this as the exact logo when correcting generated images.',
      });
      if (!response.success || !response.data?.id) {
        throw new Error(response.message || '上传 Logo 失败');
      }
      const uploaded = response.data as ReferenceAsset;
      setReferenceAssets((prev) => [uploaded, ...prev.filter((asset) => asset.id !== uploaded.id)]);
      setSelectedLogoFixReferenceAssetId(uploaded.id);
      setLogoAssetFilterMode('logo');
    } catch (error: any) {
      console.error(error);
      alert(`上传 Logo 失败：${normalizeAppErrorMessage(error, '未知错误')}`);
    } finally {
      setIsUploadingLogoAsset(false);
    }
  }, [setReferenceAssets]);

  const waitForLogoFixTask = useCallback(async (
    taskId: string,
    promptMeta: LogoFixSuccess['promptMeta'],
    assetMode: Asset['mode'] | string,
  ): Promise<Asset> => {
    const buildFixedAssetFromTask = (task: any): Asset => {
      const firstImage = getLogoFixTaskImage(task);
      if (!firstImage) {
        throw new Error(task.message || '图片修正完成但没有返回图片');
      }
      return {
        id: task.task_id,
        url: firstImage,
        mode: assetMode || generatedNote?.imageMode || '动态表达',
        promptLabel: promptMeta.type || '品牌标识修正',
        promptText: promptMeta.prompt || '',
        visualModeResolved: task.metadata?.visual_mode_resolved,
        editSourceAssetId: task.metadata?.edit_source_asset_id,
        editPreservationMode: task.metadata?.edit_preservation_mode,
        referenceAssetIds: task.metadata?.reference_asset_ids,
      };
    };
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOGO_FIX_SINGLE_TASK_TIMEOUT_MS) {
      if (logoFixCancelRequestedRef.current) {
        throw new Error('已手动取消品牌标识修正');
      }
      const task = await apiClient.getVisualTaskStatus(taskId);
      if (isLogoFixTaskCompleted(task)) {
        removeActiveLogoFixTask(taskId);
        return buildFixedAssetFromTask(task);
      }
      if (isLogoFixTaskTerminal(task)) {
        removeActiveLogoFixTask(taskId);
        throw new Error(task.error || task.message || '图片修正失败');
      }
      await sleep(LOGO_FIX_POLL_INTERVAL_MS);
    }
    throw new Error('图片修正等待超过 8 分钟，已停止等待，可重试');
  }, [generatedNote?.imageMode, removeActiveLogoFixTask]);

  const applyLogoFixSuccess = useCallback((success: LogoFixSuccess, fallbackAssets?: Asset[]) => {
    if (appliedLogoFixTaskIdsRef.current.has(success.taskId)) {
      return fallbackAssets || assetsRef.current;
    }
    appliedLogoFixTaskIdsRef.current.add(success.taskId);
    const nextAssets = mergeLogoFixSuccessIntoAssets(
      fallbackAssets || assetsRef.current,
      success.sourceAssetId,
      success.fixedAsset,
    );
    setAssets(nextAssets);
    updateAssets(nextAssets);
    setGeneratedNote((prevNote) => {
      if (!prevNote) {
        return prevNote;
      }
      return {
        ...prevNote,
        assets: mergeLogoFixSuccessIntoAssets(prevNote.assets || [], success.sourceAssetId, success.fixedAsset),
        visualProject: mergeLogoFixSuccessIntoVisualProject(prevNote.visualProject, success.sourceAssetId, success.fixedAsset) || null,
        taskIds: (prevNote.taskIds || []).includes(success.taskId)
          ? prevNote.taskIds || []
          : [...(prevNote.taskIds || []), success.taskId],
        prompts: [
          ...(prevNote.prompts || []),
          success.promptMeta,
        ],
      };
    });
    const activeAssetStillMatches = success.sourceAssetId === activeAssetId
      || assetsRef.current[activeAssetIndex]?.id === success.sourceAssetId;
    if (activeAssetStillMatches) {
      setContent((prev) => ({ ...prev, mainImageUrl: success.fixedAsset.url }));
    }
    return nextAssets;
  }, [activeAssetId, activeAssetIndex, setContent, setGeneratedNote, updateAssets]);

  const handleRunLogoFixBatch = useCallback(async () => {
    pushLoadingStatus('已点击开始替换，正在检查图片和 Logo...');
    void apiClient.getImageRunnerStatus().catch((error) => {
      console.warn('Logo fix click diagnostic failed:', error);
    });
    if (logoFixSubmitBlockedReason) {
      pushErrorStatus(logoFixSubmitBlockedReason);
      return;
    }
    if (!generatedNote || logoFixTargetAssetIds.length === 0) {
      pushErrorStatus('请先在视觉资产里选中要修正的图片。');
      return;
    }
    const referenceAsset = selectedLogoFixReferenceAsset;
    if (!referenceAsset) {
      pushErrorStatus('请先选择一个品牌 logo 素材。');
      return;
    }

    const targetAssets = assets.filter((asset) => logoFixTargetAssetIds.includes(asset.id) && !asset.url.startsWith('data:') && !asset.isProcessing);
    if (targetAssets.length === 0) {
      pushErrorStatus('选中的图片里没有可直接编辑的图，请先换成生成图。');
      return;
    }

    const fixedPrompt = buildLogoFixPrompt(referenceAsset.display_name || referenceAsset.original_name);

    setIsLogoFixDialogOpen(false);
    const logoFixStartedAtMs = Date.now();
    setLogoFixStartedAt(logoFixStartedAtMs);
    setIsApplyingLogoFix(true);
    logoFixCancelRequestedRef.current = false;
    appliedLogoFixTaskIdsRef.current.clear();
    try {
      setLogoFixProgress({ submitted: 0, completed: 0, failed: 0, retrying: 0, total: targetAssets.length });
      pushLoadingStatus(`正在并发处理 ${targetAssets.length} 张图片的品牌标识修正，系统会自动分散图片 key，完成一张立即更新到画面...`);

      type LogoFixRunOutcome =
        | { status: 'completed'; success: LogoFixSuccess; item: LogoFixBatchItem }
        | { status: 'failed'; failure: LogoFixFailure; item: LogoFixBatchItem; retryable: boolean };

      const fixedSuccesses: LogoFixSuccess[] = [];
      const finalFailures: LogoFixFailure[] = [];
      let latestLogoFixAssets = assets;
      const logoFixBatchId = `${logoFixStartedAtMs}-${Math.random().toString(36).slice(2, 8)}`;
      const queue: LogoFixBatchItem[] = targetAssets.map((asset, index) => ({
        asset,
        index,
        attempts: 0,
        candidateSeed: `logo-fix:${logoFixNoteKey}:${referenceAsset.id}:${index}:${asset.id}`,
      }));
      const session: LogoFixPersistedSession = {
        id: logoFixBatchId,
        noteKey: logoFixNoteKey,
        referenceAssetId: referenceAsset.id,
        createdAt: logoFixStartedAtMs,
        updatedAt: logoFixStartedAtMs,
        total: targetAssets.length,
        items: targetAssets.map((asset, index) => ({
          sourceAssetId: asset.id,
          index,
          attempts: 0,
          status: 'queued',
        })),
      };
      logoFixSessionRef.current = session;
      saveLogoFixSession(session);
      const batchStartedAt = logoFixStartedAtMs;
      const maxActiveRuns = LOGO_FIX_STABLE_CONCURRENCY;

      const runLogoFixItem = async (item: LogoFixBatchItem): Promise<LogoFixRunOutcome> => {
        if (logoFixCancelRequestedRef.current) {
          return {
            status: 'failed',
            item,
            retryable: false,
            failure: {
              sourceAssetId: item.asset.id,
              index: item.index,
              error: '已手动取消品牌标识修正',
              attempts: item.attempts,
            },
          };
        }
        item.attempts += 1;
        const imageId = getAssetImageId(item.asset);
        const isRetry = item.attempts > 1;
        const prompt = fixedPrompt;
        const promptMeta = {
          type: '品牌标识修正',
          prompt,
          source_asset_id: item.asset.id,
          target_image_id: imageId,
        };

        try {
          const persistedItem = session.items.find((entry) => entry.sourceAssetId === item.asset.id);
          if (persistedItem) {
            persistedItem.attempts = item.attempts;
            persistedItem.status = 'running';
            persistedItem.error = undefined;
            persistedItem.promptMeta = promptMeta;
            persistedItem.assetMode = generatedNote.imageMode || '动态表达';
            saveLogoFixSession(session);
          }
          pushLoadingStatus(`${isRetry ? '正在重试' : '正在提交'}第 ${item.index + 1}/${targetAssets.length} 张品牌标识修正${isRetry ? `（第 ${item.attempts} 次）` : ''}...`);
          const response = await apiClient.editImage({
            image_id: imageId,
            prompt,
            aspect_ratio: '3:4',
            image_size: '1K',
            reference_asset_ids: [referenceAsset.id],
            edit_purpose: 'logo_replacement',
            candidate_seed: `${item.candidateSeed}:attempt-${item.attempts}`,
            candidate_offset: item.index + item.attempts - 1,
            trace_metadata: {
              feature: 'studio_logo_fix_batch',
              batch_id: logoFixBatchId,
              item_index: item.index,
              item_total: targetAssets.length,
              source_asset_id: item.asset.id,
              target_image_id: imageId,
              reference_asset_id: referenceAsset.id,
              attempt: item.attempts,
              candidate_offset: item.index + item.attempts - 1,
              frontend_concurrency: maxActiveRuns,
            },
          });
          const taskId = response.task_id;
          activeImageTaskIdsRef.current = [...new Set([...activeImageTaskIdsRef.current, taskId])];
          if (persistedItem) {
            persistedItem.taskId = taskId;
            saveLogoFixSession(session);
          }
          setLogoFixProgress((prev) => ({
            ...prev,
            submitted: prev.submitted + 1,
          }));
          const fixedAsset = await waitForLogoFixTask(taskId, promptMeta, generatedNote.imageMode || '动态表达');
          return {
            status: 'completed',
            item,
            success: {
              taskId,
              sourceAssetId: item.asset.id,
              fixedAsset,
              promptMeta,
            },
          };
        } catch (reason: any) {
          const error = normalizeAppErrorMessage(reason, '图片修正失败');
          item.lastError = error;
          const persistedItem = session.items.find((entry) => entry.sourceAssetId === item.asset.id);
          if (persistedItem) {
            persistedItem.error = error;
            saveLogoFixSession(session);
          }
          return {
            status: 'failed',
            item,
            retryable: item.attempts < LOGO_FIX_MAX_ATTEMPTS,
            failure: {
              sourceAssetId: item.asset.id,
              index: item.index,
              error,
              attempts: item.attempts,
            },
          };
        }
      };

      let activeRuns: Array<Promise<LogoFixRunOutcome>> = [];
      while (queue.length > 0 || activeRuns.length > 0) {
        if (Date.now() - batchStartedAt >= LOGO_FIX_BATCH_TIMEOUT_MS && queue.length > 0) {
          queue.splice(0).forEach((item) => {
            finalFailures.push({
              sourceAssetId: item.asset.id,
              index: item.index,
              error: '批量修正超过 12 分钟，已停止等待，请稍后单独重试',
              attempts: item.attempts,
            });
          });
          setLogoFixProgress((prev) => ({ ...prev, failed: finalFailures.length, retrying: 0 }));
          pushLoadingStatus(`批量处理已达到 18 分钟上限，未提交的图片已停止提交；正在等待已提交任务返回最终状态。`);
        }
        while (queue.length > 0 && activeRuns.length < maxActiveRuns) {
          const nextItem = queue.shift();
          if (!nextItem) break;
          activeRuns.push(runLogoFixItem(nextItem));
          if (maxActiveRuns === 1) {
            await sleep(800);
          }
        }
        if (activeRuns.length === 0) {
          continue;
        }
        const { promise, outcome } = await Promise.race(
          activeRuns.map((promise) => promise.then((outcome) => ({ promise, outcome })))
        );
        activeRuns = activeRuns.filter((item) => item !== promise);

        if (logoFixCancelRequestedRef.current) {
          finalFailures.push({
            sourceAssetId: outcome.item.asset.id,
            index: outcome.item.index,
            error: '已手动取消品牌标识修正',
            attempts: outcome.item.attempts,
          });
          queue.splice(0).forEach((item) => {
            finalFailures.push({
              sourceAssetId: item.asset.id,
              index: item.index,
              error: '已手动取消品牌标识修正',
              attempts: item.attempts,
            });
          });
          setLogoFixProgress((prev) => ({ ...prev, failed: finalFailures.length, retrying: 0 }));
          break;
        }

        if (outcome.status === 'completed') {
          fixedSuccesses.push(outcome.success);
          latestLogoFixAssets = applyLogoFixSuccess(outcome.success, latestLogoFixAssets);
          const persistedItem = session.items.find((entry) => entry.sourceAssetId === outcome.success.sourceAssetId);
          if (persistedItem) {
            persistedItem.status = 'completed';
            persistedItem.taskId = outcome.success.taskId;
            persistedItem.promptMeta = outcome.success.promptMeta;
            persistedItem.fixedAsset = outcome.success.fixedAsset;
            saveLogoFixSession(session);
          }
          setLogoFixProgress((prev) => ({
            ...prev,
            completed: session.items.filter((entry) => entry.status === 'completed').length,
            retrying: outcome.item.attempts > 1 ? Math.max(0, prev.retrying - 1) : prev.retrying,
          }));
          pushLoadingStatus(`已完成 ${fixedSuccesses.length}/${targetAssets.length} 张，刚更新第 ${outcome.item.index + 1} 张到画面${queue.length > 0 || activeRuns.length > 0 ? '，继续并发处理剩余图片...' : ''}`);
          continue;
        }

        if (outcome.retryable) {
          queue.push(outcome.item);
          setLogoFixProgress((prev) => ({ ...prev, retrying: prev.retrying + 1 }));
          pushLoadingStatus(`第 ${outcome.item.index + 1}/${targetAssets.length} 张本次失败：${outcome.failure.error}。正在自动重试这张图，其它图片不受影响。`);
          await sleep(LOGO_FIX_RETRY_DELAY_MS);
        } else {
          finalFailures.push(outcome.failure);
          const persistedItem = session.items.find((entry) => entry.sourceAssetId === outcome.failure.sourceAssetId);
          if (persistedItem) {
            persistedItem.status = logoFixCancelRequestedRef.current ? 'cancelled' : 'failed';
            persistedItem.error = outcome.failure.error;
            saveLogoFixSession(session);
          }
          setLogoFixProgress((prev) => ({
            ...prev,
            failed: finalFailures.length,
            retrying: outcome.item.attempts > 1 ? Math.max(0, prev.retrying - 1) : prev.retrying,
          }));
          pushLoadingStatus(`第 ${outcome.item.index + 1}/${targetAssets.length} 张重试后仍失败：${outcome.failure.error}。这张已记为失败，等待其它图片完成。`);
        }
      }

      if (fixedSuccesses.length === 0) {
        const firstFailure = finalFailures[0];
        throw new Error(firstFailure?.error || '图片修正失败，请重试');
      }

      setLogoFixProgress((prev) => ({
        ...prev,
        completed: fixedSuccesses.length,
        failed: finalFailures.length,
        retrying: 0,
      }));
      setSelectedLogoFixAssetIds([]);
      if (!fixedSuccesses.some((success) => success.sourceAssetId === activeAssetId)) {
        const firstSourceAssetId = fixedSuccesses[0]?.sourceAssetId;
        const nextActiveIndex = latestLogoFixAssets.findIndex((asset) => asset.id === firstSourceAssetId);
        if (nextActiveIndex >= 0) {
          setActiveAssetId(firstSourceAssetId);
          setActiveAssetIndex(nextActiveIndex);
          setContent((prev) => ({ ...prev, mainImageUrl: fixedSuccesses[0].fixedAsset.url }));
        }
      }
      if (finalFailures.length > 0) {
        const retryText = finalFailures.length === 1 ? finalFailures[0].error : finalFailures.slice(0, 2).map((failure) => `第 ${failure.index + 1} 张：${failure.error}`).join('；');
        pushErrorStatus(`品牌标识修正部分完成：成功 ${fixedSuccesses.length}/${targetAssets.length} 张，失败 ${finalFailures.length} 张。${retryText}。请重试失败图片。`);
      } else {
        pushSuccessStatus(`已完成 ${fixedSuccesses.length} 张品牌标识修正。`);
        saveLogoFixSession(null);
        logoFixSessionRef.current = null;
      }
    } catch (error: any) {
      console.error(error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      pushErrorStatus(`品牌标识修正失败：${errorMessage}`);
    } finally {
      setIsApplyingLogoFix(false);
      activeImageTaskIdsRef.current = [];
    }
  }, [
    assets,
    activeAssetId,
    applyLogoFixSuccess,
    generatedNote,
    logoFixTargetAssetIds,
    logoFixSubmitBlockedReason,
    logoFixNoteKey,
    pushErrorStatus,
    pushLoadingStatus,
    pushSuccessStatus,
    selectedLogoFixReferenceAsset,
    setContent,
    setGeneratedNote,
    updateAssets,
    waitForLogoFixTask,
  ]);

  useEffect(() => {
    if (!generatedNote || !logoFixNoteKey || assets.length === 0 || isApplyingLogoFix) {
      return;
    }
    const session = loadLogoFixSession(logoFixNoteKey);
    if (!session) {
      return;
    }
    const alreadyCompletedItems = session.items.filter((item) =>
      item.status === 'completed'
      && item.taskId
      && item.promptMeta
      && item.fixedAsset
    );
    const recoverableItems = session.items.filter((item) =>
      item.taskId
      && item.promptMeta
      && (item.status === 'running' || item.status === 'queued')
    );
    const finishedCount = session.items.filter((item) => item.status === 'completed').length;
    const failedCount = session.items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length;
    if (recoverableItems.length === 0) {
      for (const item of alreadyCompletedItems) {
        if (!item.taskId || !item.promptMeta || !item.fixedAsset) {
          continue;
        }
        applyLogoFixSuccess({
          taskId: item.taskId,
          sourceAssetId: item.sourceAssetId,
          fixedAsset: item.fixedAsset,
          promptMeta: item.promptMeta,
        });
      }
      if (finishedCount + failedCount >= session.total) {
        if (failedCount > 0) {
          pushErrorStatus(`品牌标识修正完成：成功 ${finishedCount}/${session.total} 张，失败 ${failedCount} 张。请重试失败图片。`);
        } else {
          pushSuccessStatus(`已完成 ${finishedCount} 张品牌标识修正。`);
          saveLogoFixSession(null);
        }
      } else {
        pushErrorStatus(`品牌标识修正未完成：成功 ${finishedCount}/${session.total} 张，失败 ${failedCount} 张，剩余 ${session.total - finishedCount - failedCount} 张未提交。请重新选择未完成图片。`);
      }
      return;
    }
    if (recoverableItems.length === 0 && alreadyCompletedItems.length === 0) {
      if (finishedCount + failedCount >= session.total) {
        saveLogoFixSession(null);
      }
      return;
    }

    let disposed = false;
    logoFixSessionRef.current = session;
    logoFixCancelRequestedRef.current = false;
    activeImageTaskIdsRef.current = recoverableItems.map((item) => item.taskId).filter(Boolean) as string[];
    setLogoFixStartedAt(session.createdAt);
    setIsApplyingLogoFix(true);
    setLogoFixProgress({
      submitted: session.items.filter((item) => item.taskId).length,
      completed: finishedCount,
      failed: failedCount,
      retrying: 0,
      total: session.total,
    });
    pushLoadingStatus(`正在同步品牌标识修正进度：已完成 ${finishedCount}/${session.total} 张，失败 ${failedCount} 张，等待 ${recoverableItems.length} 个云端任务返回。`);

    const recover = async () => {
      let completed = finishedCount;
      let failed = failedCount;
      for (const item of alreadyCompletedItems) {
        if (disposed || !item.taskId || !item.promptMeta || !item.fixedAsset) {
          break;
        }
        applyLogoFixSuccess({
          taskId: item.taskId,
          sourceAssetId: item.sourceAssetId,
          fixedAsset: item.fixedAsset,
          promptMeta: item.promptMeta,
        });
      }
      await Promise.all(recoverableItems.map(async (item) => {
        if (disposed || logoFixCancelRequestedRef.current || !item.taskId || !item.promptMeta) {
          return;
        }
        try {
          const fixedAsset = await waitForLogoFixTask(item.taskId, item.promptMeta, item.assetMode || generatedNote.imageMode || '动态表达');
          if (disposed || logoFixCancelRequestedRef.current) {
            return;
          }
          applyLogoFixSuccess({
            taskId: item.taskId,
            sourceAssetId: item.sourceAssetId,
            fixedAsset,
            promptMeta: item.promptMeta,
          });
          item.status = 'completed';
          item.fixedAsset = fixedAsset;
          completed += 1;
          saveLogoFixSession(session);
          setLogoFixProgress((prev) => ({ ...prev, completed, failed }));
          pushLoadingStatus(`同步到第 ${item.index + 1}/${session.total} 张成功，已更新到画面。当前成功 ${completed} 张，失败 ${failed} 张，剩余 ${Math.max(0, session.total - completed - failed)} 张。`);
        } catch (error) {
          if (disposed) {
            return;
          }
          item.status = logoFixCancelRequestedRef.current ? 'cancelled' : 'failed';
          item.error = normalizeAppErrorMessage(error, '图片修正失败');
          failed += 1;
          saveLogoFixSession(session);
          setLogoFixProgress((prev) => ({ ...prev, completed, failed }));
          pushLoadingStatus(`同步到第 ${item.index + 1}/${session.total} 张失败：${item.error}。当前成功 ${completed} 张，失败 ${failed} 张，剩余 ${Math.max(0, session.total - completed - failed)} 张。`);
        }
      }));
      if (disposed) {
        return;
      }
      if (logoFixCancelRequestedRef.current) {
        setIsApplyingLogoFix(false);
        activeImageTaskIdsRef.current = [];
        saveLogoFixSession(null);
        logoFixSessionRef.current = null;
        return;
      }
      setIsApplyingLogoFix(false);
      activeImageTaskIdsRef.current = [];
      if (completed + failed >= session.total) {
        if (failed > 0) {
          pushErrorStatus(`品牌标识修正完成：成功 ${completed}/${session.total} 张，失败 ${failed} 张。请重试失败图片。`);
        } else {
          pushSuccessStatus(`已完成 ${completed} 张品牌标识修正。`);
          saveLogoFixSession(null);
          logoFixSessionRef.current = null;
        }
      } else {
        pushErrorStatus(`品牌标识修正未完成：成功 ${completed}/${session.total} 张，失败 ${failed} 张，剩余 ${session.total - completed - failed} 张未提交。请重新选择未完成图片。`);
      }
    };

    void recover();
    return () => {
      disposed = true;
    };
  }, [applyLogoFixSuccess, assets.length, generatedNote, logoFixNoteKey, pushErrorStatus, pushLoadingStatus, pushSuccessStatus, waitForLogoFixTask]);

  const handleCancelLogoFix = useCallback(async () => {
    const taskIds = Array.from(new Set(activeImageTaskIdsRef.current));
    const session = logoFixSessionRef.current;
    const completedBeforeCancel = session?.items.filter((item) => item.status === 'completed').length || 0;
    const failedBeforeCancel = session?.items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length || 0;
    const cancelableTaskIds: string[] = [];

    for (const taskId of taskIds) {
      try {
        const task = await apiClient.getVisualTaskStatus(taskId);
        const item = session?.items.find((entry) => entry.taskId === taskId);
        if (isLogoFixTaskCompleted(task)) {
          removeActiveLogoFixTask(taskId);
          if (item?.promptMeta) {
            const fixedAsset: Asset = {
              id: task.task_id,
              url: getLogoFixTaskImage(task),
              mode: item.assetMode || generatedNote?.imageMode || '动态表达',
              promptLabel: item.promptMeta.type || '品牌标识修正',
              promptText: item.promptMeta.prompt || '',
              visualModeResolved: task.metadata?.visual_mode_resolved,
              editSourceAssetId: task.metadata?.edit_source_asset_id,
              editPreservationMode: task.metadata?.edit_preservation_mode,
              referenceAssetIds: task.metadata?.reference_asset_ids,
            };
            if (fixedAsset.url) {
              applyLogoFixSuccess({
                taskId,
                sourceAssetId: item.sourceAssetId,
                fixedAsset,
                promptMeta: item.promptMeta,
              });
              item.status = 'completed';
              item.fixedAsset = fixedAsset;
              item.error = undefined;
            }
          }
          continue;
        }
        if (isLogoFixTaskTerminal(task)) {
          removeActiveLogoFixTask(taskId);
          if (item && item.status !== 'completed') {
            item.status = 'failed';
            item.error = task.error || task.message || '图片修正失败';
          }
          continue;
        }
        cancelableTaskIds.push(taskId);
      } catch (error) {
        console.warn('Logo fix cancel status check failed:', error);
        cancelableTaskIds.push(taskId);
      }
    }

    const completedAfterSync = session?.items.filter((item) => item.status === 'completed').length || completedBeforeCancel;
    const failedAfterSync = session?.items.filter((item) => item.status === 'failed' || item.status === 'cancelled').length || failedBeforeCancel;
    const unsubmittedCount = session?.items.filter((item) => !item.taskId && item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled').length || 0;

    if (session) {
      saveLogoFixSession(session);
    }

    if (cancelableTaskIds.length === 0 && unsubmittedCount === 0) {
      setIsApplyingLogoFix(false);
      activeImageTaskIdsRef.current = [];
      setLogoFixProgress((prev) => ({
        ...prev,
        completed: Math.max(prev.completed, completedAfterSync),
        failed: Math.max(prev.failed, failedAfterSync),
        retrying: 0,
      }));
      if (session && completedAfterSync + failedAfterSync >= session.total) {
        if (failedAfterSync > 0) {
          pushErrorStatus(`品牌标识修正完成：成功 ${completedAfterSync}/${session.total} 张，失败 ${failedAfterSync} 张。请重试失败图片。`);
        } else {
          pushSuccessStatus(`已完成 ${completedAfterSync} 张品牌标识修正。`);
          saveLogoFixSession(null);
          logoFixSessionRef.current = null;
        }
      } else if (completedAfterSync > 0) {
        pushSuccessStatus(`已同步 ${completedAfterSync} 张已完成的品牌标识修正。`);
      }
      return;
    }

    logoFixCancelRequestedRef.current = true;
    setIsApplyingLogoFix(false);
    if (session) {
      session.items.forEach((item) => {
        if (item.status !== 'completed') {
          item.status = 'cancelled';
          item.error = '用户手动取消';
        }
      });
      saveLogoFixSession(null);
      logoFixSessionRef.current = null;
    } else {
      saveLogoFixSession(null);
    }
    setLogoFixProgress((prev) => {
      const completed = Math.max(prev.completed, completedAfterSync);
      return {
        ...prev,
        completed,
        failed: Math.max(prev.failed, prev.total - completed),
        retrying: 0,
      };
    });
    if (cancelableTaskIds.length > 0) {
      void Promise.allSettled(cancelableTaskIds.map(async (taskId) => {
        const task = await apiClient.getVisualTaskStatus(taskId);
        if (!shouldCancelLogoFixTask(task)) {
          return;
        }
        await apiClient.cancelVisualTask(taskId);
      })).then(() => {
        activeImageTaskIdsRef.current = [];
      });
    } else {
      activeImageTaskIdsRef.current = [];
    }
    pushErrorStatus(cancelableTaskIds.length > 0
      ? `已取消本次品牌标识修正，正在通知云端停止 ${cancelableTaskIds.length} 个已提交任务；未提交图片已一并取消。已完成的图片会保留。`
      : '已取消本次品牌标识修正，未提交图片已一并取消。已完成的图片会保留。');
  }, [applyLogoFixSuccess, generatedNote?.imageMode, pushErrorStatus, pushSuccessStatus, removeActiveLogoFixTask]);

  function buildCreativeDraftSnapshot(): CreativeDraftSnapshot {
    const exportedCreationState = exportCreationState();
    const exportedGeneratedNote = exportGeneratedNoteState();
    const stableMainImageUrl = resolveDraftCoverImageUrl({
      generatedNote: exportedGeneratedNote,
      activeAssetId,
      preferredUrl: content.mainImageUrl,
    });
    const studioDraftState = {
      title: content.title,
      body: content.body,
      mainImageUrl: stableMainImageUrl,
      activeAssetId,
      activeAssetIndex,
      updatedAt: new Date().toISOString(),
    };
    const creationEditorState: CreationEditorState = {
      rewriteMode: rewriteSession?.rewrite_mode === '轻仿写' || rewriteSession?.rewrite_mode === '深改原创' ? rewriteSession.rewrite_mode : '结构仿写',
      imageMode: generatedNote?.imageMode === '模板拼装' || generatedNote?.imageMode === '动态表达'
        ? generatedNote.imageMode
        : '动态表达',
      visualStyle: generatedNote?.style || exportedCreationState.visualStyle || '温暖渐变卡片',
      templatePageCount: generatedNote?.visualProject?.cards?.length || 5,
      templateCopyStyle: '通用种草',
      templateKind: generatedNote?.templateComposeResult?.template_kind === 'step_guide'
        || generatedNote?.templateComposeResult?.template_kind === 'benefit_grid'
        || generatedNote?.templateComposeResult?.template_kind === 'before_after'
        || generatedNote?.templateComposeResult?.template_kind === 'faq_card'
        ? generatedNote.templateComposeResult.template_kind
        : 'feature_hero',
      templateFrameStyle: generatedNote?.templateComposeDraft?.frameStyle === 'sunset_glow_card'
        || generatedNote?.templateComposeDraft?.frameStyle === 'editorial_outline_card'
        || generatedNote?.templateComposeDraft?.frameStyle === 'notebook_tape_card'
        || generatedNote?.templateComposeDraft?.frameStyle === 'split_banner_card'
        ? generatedNote.templateComposeDraft.frameStyle
        : 'soft_gradient_card',
      salesIntensity: 45,
      colloquialLevel: 75,
      authenticityLevel: 80,
      materialSummary: '',
      referenceSummary: '',
      selectedAssetIds: generatedNote?.referenceAssetIds || [],
      primaryReferenceAssetId: generatedNote?.primaryReferenceAssetId || '',
      researchContext: generatedNote?.researchContext || null,
      strategyOptions: generatedNote?.strategyOptions || [],
      selectedStrategyId: generatedNote?.strategy?.id || '',
    };
    return {
      workspace: 'STUDIO',
      session_key: exportedCreationState.draftSessionKey,
      creationState: exportedCreationState,
      creationEditorState,
      generatedNote: exportedGeneratedNote ? {
        ...exportedGeneratedNote,
        studioDraftState,
      } : null,
      rewriteSession: rewriteSession || null,
      selectedBenchmarkNote: selectedBenchmarkNote || null,
      referenceAssets: serializeReferenceAssetsForDraft(referenceAssets),
      latestProductBrief: latestProductBrief || null,
      studioContentState: studioDraftState,
    };
  }

  async function saveCreativeDraft(mode: 'autosave' | 'manual', explicitTitle?: string) {
    const snapshot = buildCreativeDraftSnapshot();
    if (!hasMeaningfulCreativeDraftSnapshot(snapshot)) {
      return null;
    }

    const title = buildCreativeDraftTitle({
      explicitTitle,
      generatedNote,
      latestProductBrief: latestProductBrief || undefined,
    });
    const sourceContext = buildCreativeDraftSourceContext({
      selectedBenchmarkNote,
      latestProductBrief: latestProductBrief || undefined,
    });
    const previewPayload = buildCreativeDraftPreview({
      snapshot,
      generatedNote,
      rewriteSession,
      studioContentState: snapshot.studioContentState,
    });

    if (mode === 'autosave') {
      const response = await apiClient.autosaveCreativeDraft({
        title,
        session_key: snapshot.session_key,
        source_context: sourceContext,
        snapshot_version: CREATIVE_DRAFT_SNAPSHOT_VERSION,
        content_payload: snapshot,
        preview_payload: previewPayload,
      });
      return response.data;
    }

    const response = await apiClient.createCreativeDraft({
      title,
      session_key: snapshot.session_key,
      source_context: sourceContext,
      snapshot_version: CREATIVE_DRAFT_SNAPSHOT_VERSION,
      content_payload: snapshot,
      preview_payload: previewPayload,
    });
    rotateDraftSessionKey();
    return response.data;
  }

  async function restoreCreativeDraft(draft: CreativeDraftDetail) {
    const snapshot = draft.content_payload;
    restoreCreationState(snapshot.creationState);
    restoreGeneratedNoteState(snapshot.generatedNote || null);
    setLatestProductBrief(snapshot.latestProductBrief || null);
    setReferenceAssets(Array.isArray(snapshot.referenceAssets) ? snapshot.referenceAssets : []);
    setSelectedBenchmarkNote(snapshot.selectedBenchmarkNote || null);
    setRewriteSession(snapshot.rewriteSession || null);
    if (snapshot.workspace !== 'STUDIO' && onRestoreWorkspace) {
      onRestoreWorkspace(snapshot.workspace);
    }
  }

  async function handleManualSaveCreativeDraft() {
    try {
      const defaultTitle = buildCreativeDraftTitle({
        generatedNote,
        latestProductBrief: latestProductBrief || undefined,
      });
      const nextTitle = window.prompt('请输入草稿标题', defaultTitle);
      if (!nextTitle) return;
      await saveCreativeDraft('manual', nextTitle);
    } catch (error) {
      alert(`保存草稿失败：${normalizeAppErrorMessage(error, '未知错误')}`);
    }
  }

  useEffect(() => {
    const snapshot = buildCreativeDraftSnapshot();
    if (!hasMeaningfulCreativeDraftSnapshot(snapshot)) {
      return;
    }
    const fingerprint = JSON.stringify(snapshot);
    if (fingerprint === autoDraftFingerprintRef.current) {
      return;
    }
    if (autoDraftTimerRef.current !== null) {
      window.clearTimeout(autoDraftTimerRef.current);
    }
    autoDraftTimerRef.current = window.setTimeout(() => {
      void saveCreativeDraft('autosave')
        .then(() => {
          autoDraftFingerprintRef.current = fingerprint;
        })
        .catch((error) => {
          console.error('Studio creative draft autosave failed:', error);
        });
    }, 4000);
    return () => {
      if (autoDraftTimerRef.current !== null) {
        window.clearTimeout(autoDraftTimerRef.current);
        autoDraftTimerRef.current = null;
      }
    };
  }, [activeAssetId, activeAssetIndex, content.body, content.mainImageUrl, content.title, generatedNote, latestProductBrief, referenceAssets, rewriteSession, selectedBenchmarkNote]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        const snapshot = buildCreativeDraftSnapshot();
        if (hasMeaningfulCreativeDraftSnapshot(snapshot)) {
          void saveCreativeDraft('autosave').catch((error) => {
            console.error('Studio creative draft visibility autosave failed:', error);
          });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [buildCreativeDraftSnapshot, saveCreativeDraft]);

  if (!layout) {
    return null;
  }

  const activeAsset = assets[activeAssetIndex] || assets.find((item) => item.id === activeAssetId) || null;
  const projectCardCount = generatedNote?.visualProject?.cards?.length || 0;
  const templateComposeAsset = assets.find((asset) =>
    asset.sourceType === 'template_compose'
    || asset.visualModeResolved === 'template_compose'
    || asset.layoutFamily === 'template_compose'
    || Boolean(asset.templateKind)
    || Boolean(asset.editablePayload)
  ) || null;
  const isTemplateComposeAsset = Boolean(templateComposeAsset);
  const aiChatSessionKey = generatedNote ? buildStudioChatSessionKey(generatedNote) : 'empty-studio-session';
  const showAssets = !layout.isMobile;
  const showAIPanel = layout.maxColumns >= 2;
  const showPreview = layout.maxColumns >= 3 || layout.isDesktop;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#0f1115]">
      {!hasGeneratedContent && (
        <div className="mx-auto mt-4 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-300 backdrop-blur-sm">
          当前显示的是占位工作台，请先在创作页跑完“仿写 + 去 AI 味 + 出图”。
        </div>
      )}

      {generatedNote && (
          <div className="mx-6 mt-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 backdrop-blur-md">
            <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-xhs-red/20 px-2.5 py-1 text-xs text-xhs-red">
              {generatedNote.imageModeLabel || '动态表达'}
            </span>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-200">{generatedNote.style}</span>
            {generatedNote.benchmarkNote?.content_category && (
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-200">
                {generatedNote.benchmarkNote.content_category}
              </span>
            )}
            <span className="ml-auto text-xs text-slate-500">
              {generatedNote.visualProject ? `当前产物：组图项目 · ${projectCardCount} 页` : `当前产物：单图资产 · 已出图 ${assets.length} 张`} · {STUDIO_VIEW_BUILD_MARKER}
            </span>
          </div>
            <p className="mt-2 text-sm text-slate-300">
              {generatedNote.rewriteSession?.de_ai_report?.summary || generatedNote.strategy?.summary || '当前工作台已接入正文和生成图片。'}
            </p>
            {generatedNote.strategy && (
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-200">{generatedNote.strategy.contentAngle}</span>
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs text-slate-200">{generatedNote.strategy.targetAudience}</span>
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                onClick={() => setIsDraftDrawerOpen(true)}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-white/10"
              >
                创作草稿箱
              </button>
              <button
                onClick={() => void handleManualSaveCreativeDraft()}
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100"
              >
                保存当前版本
              </button>
            </div>
            {isTemplateComposeAsset && (
              <div className="mt-3 rounded-2xl border border-emerald-500/20 bg-emerald-500/8 px-3 py-2 text-sm text-emerald-100">
                当前素材来自模板拼装。建议先继续编辑模板，再决定是否发布到小红书。
              </div>
            )}
            {isTemplateComposeAsset && onContinueTemplateEdit && (
              <div className="mt-3">
                <button
                  onClick={onContinueTemplateEdit}
                  className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-400/15"
                >
                  继续编辑模板
                </button>
              </div>
            )}
            {generatedNote.rewriteSession?.final_body_source && (
              <p className="mt-2 text-xs text-slate-400">
              当前正文来源：{generatedNote.rewriteSession.final_body_source === 'deep_polish' ? '深改版' : generatedNote.rewriteSession.final_body_source === 'minimal_polish' ? '轻改版' : '正文主稿'}
            </p>
          )}
            {generatedNote.rewriteSession?.final_body_source === 'draft' && (
              <p className="mt-2 text-xs text-amber-300">
              已启用正文完整性保护：{generatedNote.rewriteSession?.polish_guardrail_reason || '最终采用正文主稿。'}
            </p>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showAssets && (
          <div className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-white/5 bg-[#18181b]/40" style={{ flex: '0 0 30%', minWidth: '360px', maxWidth: '450px' }}>
            <AssetGallery
              assets={assets}
              activeId={activeAssetId}
              onSelect={handleAssetSelect}
              selectionMode={isLogoBatchSelectionMode}
              selectedIds={selectedLogoFixAssetIds}
              onToggleSelect={handleToggleLogoFixAsset}
              compact
            />
            <div className="border-t border-white/5 mx-5" />
            <ContentEditor content={content} onChange={handleContentChange} assets={assets} compact />
          </div>
        )}

        {!showAssets && (
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            <AssetGallery
              assets={assets}
              activeId={activeAssetId}
              onSelect={handleAssetSelect}
              selectionMode={isLogoBatchSelectionMode}
              selectedIds={selectedLogoFixAssetIds}
              onToggleSelect={handleToggleLogoFixAsset}
            />
            <div className="border-t border-white/5 mx-5" />
            <ContentEditor content={content} onChange={handleContentChange} assets={assets} />
          </div>
        )}

        {showAIPanel && (
          <div className="flex min-h-0 flex-col overflow-hidden bg-[#141418]/60 border-x border-white/5" style={{ flex: '1 1 auto', minWidth: '380px', maxWidth: '560px' }}>
            <AIChat
              activeAssetId={activeAssetId}
              chatSessionKey={aiChatSessionKey}
              content={content}
              onContentChange={handleContentChange}
              onAssetUpdate={handleAssetUpdate}
              onAssetStatusChange={handleAssetStatusChange}
              onClearActiveAsset={() => setActiveAssetId('')}
              isLogoBatchSelectionMode={isLogoBatchSelectionMode}
              selectedLogoFixAssetCount={selectedLogoFixAssetIds.length}
              onToggleLogoBatchSelectionMode={() => setIsLogoBatchSelectionMode((prev) => !prev)}
              onOpenLogoFixDialog={() => {
                if (selectedLogoFixAssetIds.length === 0) {
                  alert('请先选中要修正的图片。');
                  return;
                }
                setLogoFixStatus('');
                setLogoFixStatusTone('idle');
                setLogoFixStartedAt(null);
                setIsLogoFixDialogOpen(true);
              }}
              onClearLogoFixSelection={() => setSelectedLogoFixAssetIds([])}
              hasGeneratedContent={hasGeneratedContent}
              logoFixStatus={logoFixStatus}
              logoFixStatusTone={logoFixStatusTone}
              logoFixProgress={logoFixProgress}
              logoFixStartedAt={logoFixStartedAt}
              isApplyingLogoFix={isApplyingLogoFix}
              onCancelLogoFix={handleCancelLogoFix}
            />
          </div>
        )}

        {showPreview && (
          <div className="flex flex-col bg-[#0f1115]/40 border-l border-white/5" style={{ flex: '0 0 32%', minWidth: '360px', maxWidth: '480px' }}>
            <PreviewFrame
              content={content}
              activeAsset={activeAsset}
              imageCount={assets.length}
              activeImageIndex={activeAssetIndex}
              promptLabel={activeAsset?.promptLabel}
              promptText={activeAsset?.promptText}
              variantKey={activeAsset?.variantKey}
              layoutFamily={activeAsset?.layoutFamily}
              visualFocus={activeAsset?.visualFocus}
              sourceType={activeAsset?.sourceType}
              templateKind={activeAsset?.templateKind}
              onPrevImage={assets.length > 1 ? handlePrevAsset : undefined}
              onNextImage={assets.length > 1 ? handleNextAsset : undefined}
            />
          </div>
        )}
      </div>
      {isLogoFixDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
          <div className="flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#13161c] shadow-2xl">
            <div className="shrink-0 flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
              <div>
                <div className="text-base font-semibold text-white">选择正确 Logo</div>
                <div className="mt-1 text-sm text-slate-400">只替换错误标识，不改其它内容。当前目标 {logoFixTargetAssetIds.length} 张。</div>
              </div>
              <button
                type="button"
                onClick={() => !isApplyingLogoFix && setIsLogoFixDialogOpen(false)}
                className="rounded-xl p-2 text-slate-500 hover:bg-white/10 hover:text-white disabled:opacity-40"
                disabled={isApplyingLogoFix}
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5 custom-scrollbar">
              {isApplyingLogoFix ? (
                <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.04] p-5">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined animate-spin text-[22px] text-emerald-200">progress_activity</span>
                    <div>
                      <div className="text-sm font-semibold text-white">正在替换错误 Logo</div>
                      <div className="mt-1 text-xs text-slate-400">
                        已提交 {Math.min(logoFixProgress.total, logoFixProgress.submitted)} 张图，已完成 {logoFixProgress.completed}/{logoFixProgress.total} 张
                        {logoFixProgress.total > 0 && logoFixProgress.completed + logoFixProgress.failed < logoFixProgress.total
                          ? `，处理中 ${Math.max(0, logoFixProgress.total - logoFixProgress.completed - logoFixProgress.failed)} 张`
                          : ''}
                        {logoFixProgress.retrying > 0 ? `，自动重试 ${logoFixProgress.retrying} 张` : ''}
                        {logoFixProgress.submitted > logoFixProgress.total ? `，累计请求 ${logoFixProgress.submitted} 次` : ''}
                        {logoFixProgress.failed > 0 ? `，失败 ${logoFixProgress.failed} 张` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-emerald-300 transition-all"
                      style={{ width: `${logoFixProgress.total > 0 ? Math.max(8, Math.round(((logoFixProgress.completed + logoFixProgress.failed) / logoFixProgress.total) * 100)) : 8}%` }}
                    />
                  </div>
                  {logoFixStatus && (
                    <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs leading-5 text-slate-300">
                      {logoFixStatus}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={handleCancelLogoFix}
                    className="mt-4 h-10 w-full rounded-xl border border-red-300/20 bg-red-500/10 px-4 text-sm font-semibold text-red-100 transition hover:bg-red-500/15"
                  >
                    取消本次替换
                  </button>
                </div>
              ) : (
                <>
                {logoFixStatus && (
                  <div className={`mb-4 rounded-2xl border px-4 py-3 text-sm leading-6 ${
                    logoFixStatusTone === 'error'
                      ? 'border-red-400/25 bg-red-500/10 text-red-100'
                      : logoFixStatusTone === 'success'
                        ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
                        : 'border-white/10 bg-white/[0.04] text-slate-300'
                  }`}>
                    {logoFixStatus}
                  </div>
                )}
	                <div className="rounded-2xl border border-white/10 bg-black/20 p-3.5">
	                  <div className="flex items-center justify-between gap-3">
	                    <div>
	                      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-100/75">Logo 素材</div>
	                      <div className="mt-1 text-xs text-slate-500">
	                        当前显示 {logoReferenceAssets.length} 张，素材库共 {referenceAssets.length} 张。
	                      </div>
	                    </div>
	                    <div className="flex items-center gap-2">
	                      <div className="flex rounded-xl border border-white/10 bg-black/30 p-1">
	                        {[
	                          { value: 'logo' as const, label: `Logo ${logoReferenceAssetCount}` },
	                          { value: 'all' as const, label: `全部 ${referenceAssets.length}` },
	                        ].map((option) => (
	                          <button
	                            key={option.value}
	                            type="button"
	                            onClick={() => setLogoAssetFilterMode(option.value)}
	                            className={`h-7 rounded-lg px-2.5 text-xs font-semibold transition ${logoAssetFilterMode === option.value ? 'bg-white text-slate-950' : 'text-slate-400 hover:text-white'}`}
	                          >
	                            {option.label}
	                          </button>
	                        ))}
	                      </div>
	                      <input
	                        ref={logoUploadInputRef}
	                        type="file"
	                        accept="image/png,image/jpeg,image/webp"
	                        className="hidden"
	                        onChange={(event) => {
	                          const file = event.target.files?.[0];
	                          event.target.value = '';
	                          if (file) {
	                            void handleUploadLogoAsset(file);
	                          }
	                        }}
	                      />
	                      <button
	                        type="button"
	                        onClick={() => logoUploadInputRef.current?.click()}
	                        disabled={isUploadingLogoAsset || isApplyingLogoFix}
	                        className={`h-9 rounded-xl px-3 text-xs font-semibold transition ${isUploadingLogoAsset || isApplyingLogoFix ? 'cursor-not-allowed bg-slate-700 text-slate-400' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
	                      >
	                        {isUploadingLogoAsset ? '上传中...' : '上传 Logo'}
	                      </button>
	                    </div>
	                  </div>
                {isLoadingLogoAssets && (
                  <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-5 text-center text-sm text-slate-400">
                    正在加载素材库...
                  </div>
                )}
                {!isLoadingLogoAssets && logoAssetLoadError && (
                  <div className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.08] px-4 py-4 text-sm text-amber-100">
                    {logoAssetLoadError}
                  </div>
                )}
                {!isLoadingLogoAssets && (
                <div className="mt-3 grid max-h-[42vh] grid-cols-2 gap-2 overflow-y-auto pr-1 custom-scrollbar md:grid-cols-3">
                  {logoReferenceAssets.map((asset) => {
                    const isSelected = selectedLogoFixReferenceAssetId === asset.id;
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        onClick={() => setSelectedLogoFixReferenceAssetId(asset.id)}
                        className={`overflow-hidden rounded-2xl border text-left transition ${isSelected ? 'border-emerald-300 bg-emerald-300/10' : 'border-white/10 bg-black/20 hover:border-white/20 hover:bg-black/30'}`}
                      >
                        <img src={asset.url} alt={asset.display_name || asset.original_name} className="h-20 w-full object-cover bg-black/30" />
                        <div className="p-2.5">
                          <div className="truncate text-xs font-medium text-white">{asset.display_name || asset.original_name}</div>
                          <div className="mt-1 line-clamp-1 text-[11px] leading-4 text-slate-400">{asset.ai_hint || asset.note || '品牌标识参考素材'}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                )}
                {!isLoadingLogoAssets && logoReferenceAssets.length === 0 && (
                  <div className="mt-3 rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
                    还没有可用的 logo 素材，点击上方“上传 Logo”即可加入素材库。
                  </div>
                )}
                </div>
                </>
              )}
            </div>
            <div className="shrink-0 border-t border-white/10 bg-[#13161c] px-5 py-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setIsLogoFixDialogOpen(false)}
                disabled={isApplyingLogoFix}
                className={`h-11 rounded-xl border px-4 text-sm font-semibold transition ${isApplyingLogoFix ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'}`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleRunLogoFixBatch()}
                className={`h-11 rounded-xl px-5 text-sm font-semibold transition ${logoFixSubmitBlockedReason ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
              >
                {isApplyingLogoFix ? '正在提交...' : '开始替换'}
              </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <CreativeDraftDrawer
        isOpen={isDraftDrawerOpen}
        onClose={() => setIsDraftDrawerOpen(false)}
        onImport={restoreCreativeDraft}
      />
    </div>
  );
};

export default StudioView;
