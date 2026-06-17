import React, { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { Asset, GeneratedNoteRecord, PendingNoteConfirmation, RewriteSession, StudioDraftState, TemplateComposeDocument, TemplateComposeResult, TemplateDraftStatus, VisualProject } from '../types';
import { assetNeedsTemplateHydration, hydrateTemplateAssetIfNeeded, prepareTemplateResultForRender } from '../lib/templateAssetRenderer';
import { buildVisualProjectAssets, getVisualProjectPrimaryDocument, getVisualProjectPrimaryResult } from '../lib/visualProject';
import { sanitizeMarkdownForXhs } from '../lib/xhsContent';

interface NoteContextType {
  generatedNote: GeneratedNoteRecord | null;
  setGeneratedNote: React.Dispatch<React.SetStateAction<GeneratedNoteRecord | null>>;
  updateAssets: (assets: Asset[]) => void;
  updateTemplateComposeDraft: (draft: TemplateComposeDocument | null, status?: TemplateDraftStatus, result?: TemplateComposeResult | null) => void;
  saveTemplateComposeDraft: (payload: {
    draft: TemplateComposeDocument;
    result: TemplateComposeResult;
    asset: Asset;
  }) => void;
  applyTemplateComposeDraft: (payload: {
    draft: TemplateComposeDocument;
    result: TemplateComposeResult;
    asset: Asset;
    title?: string;
  }) => void;
  updateVisualProject: (project: VisualProject | null) => void;
  saveVisualProjectDraft: (payload: { project: VisualProject }) => void;
  applyVisualProjectDraft: (payload: { project: VisualProject; title?: string }) => void;
  updateStudioDraftState: (state: StudioDraftState | null) => void;
  exportGeneratedNoteState: () => GeneratedNoteRecord | null;
  restoreGeneratedNoteState: (note: GeneratedNoteRecord | null) => void;
  hasGeneratedContent: boolean;
}

const NoteContext = createContext<NoteContextType | undefined>(undefined);
const GENERATED_NOTE_STORAGE_KEY = 'xhs_generated_note';
const isTemplateComposeAsset = (asset: Asset) => Boolean(
  asset.sourceType === 'template_compose'
  || asset.visualModeResolved === 'template_compose'
  || asset.layoutFamily === 'template_compose'
  || asset.templateKind
  || asset.editablePayload
);

const sanitizeAssetForStorage = (asset: Asset): Asset => {
  if (asset.sourceType !== 'template_compose' || !asset.editablePayload) {
    return asset;
  }
  return {
    ...asset,
    exportReadyUrl: '',
  };
};

const sanitizeStudioDraftState = (state: StudioDraftState | null | undefined): StudioDraftState | null => {
  if (!state) return null;
  return {
    ...state,
    title: sanitizeMarkdownForXhs(state.title || '').trim(),
    body: sanitizeMarkdownForXhs(state.body || ''),
    mainImageUrl: String(state.mainImageUrl || ''),
    activeAssetId: String(state.activeAssetId || ''),
    activeAssetIndex: Number.isFinite(Number(state.activeAssetIndex)) ? Number(state.activeAssetIndex) : 0,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
};

const sanitizePendingConfirmation = (state: PendingNoteConfirmation | null | undefined): PendingNoteConfirmation | null => {
  if (!state) return null;
  const normalizedOutline = Array.isArray(state.outline)
    ? state.outline.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [];
  const normalizedTitleCandidates = Array.isArray(state.titleCandidates)
    ? state.titleCandidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [];
  const normalizedOpeningCandidates = Array.isArray(state.openingCandidates)
    ? state.openingCandidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
    : [];
  return {
    ...state,
    title: sanitizeMarkdownForXhs(state.title || '').trim(),
    opening: sanitizeMarkdownForXhs(state.opening || ''),
    outline: normalizedOutline,
    body: sanitizeMarkdownForXhs(state.body || ''),
    closing: sanitizeMarkdownForXhs(state.closing || ''),
    titleCandidates: normalizedTitleCandidates,
    openingCandidates: normalizedOpeningCandidates,
    lastCustomInstruction: sanitizeMarkdownForXhs(state.lastCustomInstruction || ''),
    lastReasoningSummary: sanitizeMarkdownForXhs(state.lastReasoningSummary || ''),
    previousSnapshot: state.previousSnapshot ? {
      title: sanitizeMarkdownForXhs(state.previousSnapshot.title || '').trim(),
      opening: sanitizeMarkdownForXhs(state.previousSnapshot.opening || ''),
      outline: Array.isArray(state.previousSnapshot.outline)
        ? state.previousSnapshot.outline.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
        : [],
      body: sanitizeMarkdownForXhs(state.previousSnapshot.body || ''),
      closing: sanitizeMarkdownForXhs(state.previousSnapshot.closing || ''),
    } : null,
    lastRevisionResult: state.lastRevisionResult ? {
      ...state.lastRevisionResult,
      reasoning_summary: sanitizeMarkdownForXhs(state.lastRevisionResult.reasoning_summary || ''),
      updated_fields: {
        ...state.lastRevisionResult.updated_fields,
        title: sanitizeMarkdownForXhs(state.lastRevisionResult.updated_fields?.title || '').trim(),
        opening: sanitizeMarkdownForXhs(state.lastRevisionResult.updated_fields?.opening || ''),
        outline: Array.isArray(state.lastRevisionResult.updated_fields?.outline)
          ? state.lastRevisionResult.updated_fields.outline.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
          : [],
        body: sanitizeMarkdownForXhs(state.lastRevisionResult.updated_fields?.body || ''),
        closing: sanitizeMarkdownForXhs(state.lastRevisionResult.updated_fields?.closing || ''),
      },
      updated_rewrite_session: sanitizeRewriteSession(state.lastRevisionResult.updated_rewrite_session) || state.lastRevisionResult.updated_rewrite_session,
    } : null,
    updatedAt: state.updatedAt || new Date().toISOString(),
  };
};

const isSameStudioDraftState = (left: StudioDraftState | null | undefined, right: StudioDraftState | null | undefined) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.title === right.title
    && left.body === right.body
    && left.mainImageUrl === right.mainImageUrl
    && left.activeAssetId === right.activeAssetId
    && left.activeAssetIndex === right.activeAssetIndex;
};

const sanitizeGeneratedNoteForStorage = (note: GeneratedNoteRecord): GeneratedNoteRecord => ({
  ...note,
  assets: note.assets.map(sanitizeAssetForStorage),
  templateComposeResult: note.templateComposeResult
    ? {
        ...note.templateComposeResult,
        rendered_image_url: '',
      }
    : note.templateComposeResult,
});

const sanitizeRewriteSession = (session: RewriteSession | null | undefined): RewriteSession | null => {
  if (!session) {
    return null;
  }
  return {
    ...session,
    title_candidates: Array.isArray(session.title_candidates)
      ? session.title_candidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
      : [],
    opening_candidates: Array.isArray(session.opening_candidates)
      ? session.opening_candidates.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
      : [],
    content_outline: Array.isArray(session.content_outline)
      ? session.content_outline.map((item) => sanitizeMarkdownForXhs(item || '').trim()).filter(Boolean)
      : [],
    body_draft: sanitizeMarkdownForXhs(session.body_draft || ''),
    minimal_polish_body: sanitizeMarkdownForXhs(session.minimal_polish_body || ''),
    polished_body: sanitizeMarkdownForXhs(session.polished_body || ''),
    deep_polish_body: sanitizeMarkdownForXhs(session.deep_polish_body || ''),
    final_body: sanitizeMarkdownForXhs(session.final_body || ''),
  };
};

const sanitizeGeneratedNoteContent = (note: GeneratedNoteRecord): GeneratedNoteRecord => ({
  ...note,
  title: sanitizeMarkdownForXhs(note.title || '').trim(),
  content: sanitizeMarkdownForXhs(note.content || ''),
  finalBody: sanitizeMarkdownForXhs(note.finalBody || ''),
  rewriteSession: sanitizeRewriteSession(note.rewriteSession),
  studioDraftState: sanitizeStudioDraftState(note.studioDraftState),
  pendingConfirmation: sanitizePendingConfirmation(note.pendingConfirmation),
});

const loadStoredGeneratedNote = (): GeneratedNoteRecord | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const stored = window.localStorage.getItem(GENERATED_NOTE_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored) as GeneratedNoteRecord | null;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return sanitizeGeneratedNoteContent({
      ...parsed,
      assets: Array.isArray(parsed.assets)
        ? parsed.assets
        : [],
      taskIds: Array.isArray(parsed.taskIds) ? parsed.taskIds : [],
      prompts: Array.isArray(parsed.prompts) ? parsed.prompts : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      referenceAssetIds: Array.isArray(parsed.referenceAssetIds) ? parsed.referenceAssetIds : [],
      researchContext: parsed.researchContext || null,
      strategy: parsed.strategy || null,
      strategyOptions: Array.isArray(parsed.strategyOptions) ? parsed.strategyOptions : [],
      noteVisualPlan: parsed.noteVisualPlan || null,
      templateComposeResult: parsed.templateComposeResult || null,
      templateComposeDraft: parsed.templateComposeDraft || null,
      templateDraftStatus: parsed.templateDraftStatus || null,
      visualProject: parsed.visualProject || null,
      pendingConfirmation: parsed.pendingConfirmation || null,
    });
  } catch (error) {
    console.error('Failed to load generated note from storage', error);
    return null;
  }
};

export const NoteProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [generatedNote, setGeneratedNote] = useState<GeneratedNoteRecord | null>(() => loadStoredGeneratedNote());
  const hydrationTokenRef = useRef<string>('');

  useEffect(() => {
    if (!generatedNote) {
      return;
    }
    const sanitized = sanitizeGeneratedNoteContent(generatedNote);
    if (JSON.stringify(sanitized) !== JSON.stringify(generatedNote)) {
      setGeneratedNote(sanitized);
    }
  }, [generatedNote]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      if (generatedNote) {
        window.localStorage.setItem(
          GENERATED_NOTE_STORAGE_KEY,
          JSON.stringify(sanitizeGeneratedNoteForStorage(generatedNote))
        );
      } else {
        window.localStorage.removeItem(GENERATED_NOTE_STORAGE_KEY);
      }
    } catch (error) {
      console.error('Failed to persist generated note', error);
    }
  }, [generatedNote]);

  useEffect(() => {
    if (!generatedNote) {
      hydrationTokenRef.current = '';
      return;
    }

      const needsAssetHydration = (generatedNote.assets || []).some((asset) => assetNeedsTemplateHydration(asset));
    const needsResultHydration = Boolean(
      generatedNote.templateComposeResult
      && !generatedNote.templateComposeResult.rendered_image_url
      && generatedNote.templateComposeResult.editable_payload
    );

    if (!needsAssetHydration && !needsResultHydration) {
      hydrationTokenRef.current = '';
      return;
    }

    const token = JSON.stringify({
      assetIds: (generatedNote.assets || []).filter((asset) => assetNeedsTemplateHydration(asset)).map((asset) => asset.id),
      resultTemplate: generatedNote.templateComposeResult?.template_kind || '',
      draftId: generatedNote.templateComposeDraft?.id || '',
    });

    if (hydrationTokenRef.current === token) {
      return;
    }
    hydrationTokenRef.current = token;

    let cancelled = false;

    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        assets: prev.assets.map((asset) =>
          assetNeedsTemplateHydration(asset)
            ? { ...asset, isProcessing: false, statusText: asset.statusText }
            : asset
        ),
      };
    });

    (async () => {
      const hydratedAssets = await Promise.all(
        (generatedNote.assets || []).map((asset) => (
          assetNeedsTemplateHydration(asset) ? hydrateTemplateAssetIfNeeded(asset) : Promise.resolve(asset)
        ))
      );
      const hydratedResult = needsResultHydration && generatedNote.templateComposeResult
        ? await prepareTemplateResultForRender(generatedNote.templateComposeResult)
        : generatedNote.templateComposeResult;

      if (cancelled) {
        return;
      }

      setGeneratedNote((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          assets: hydratedAssets,
          templateComposeResult: hydratedResult ?? prev.templateComposeResult ?? null,
        };
      });
      hydrationTokenRef.current = '';
    })().catch((error) => {
      console.error('Failed to hydrate template assets', error);
      hydrationTokenRef.current = '';
      if (cancelled) {
        return;
      }
      setGeneratedNote((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          assets: prev.assets.map((asset) =>
            assetNeedsTemplateHydration(asset)
              ? { ...asset, isProcessing: false, statusText: asset.statusText || '导出增强失败，显示不受影响' }
              : asset
          ),
        };
      });
    });

    return () => {
      cancelled = true;
    };
  }, [generatedNote]);

  const updateAssets = (assets: Asset[]) => {
    if (generatedNote) {
      setGeneratedNote({
        ...generatedNote,
        assets,
      });
    }
  };

  const syncVisualProjectAssets = (project: VisualProject | null | undefined) => buildVisualProjectAssets(project);

  const updateTemplateComposeDraft = (
    draft: TemplateComposeDocument | null,
    status: TemplateDraftStatus = 'draft',
    result: TemplateComposeResult | null = null
  ) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        templateComposeDraft: draft,
        templateDraftStatus: draft ? status : null,
        templateComposeResult: result ?? prev.templateComposeResult ?? null,
        assets: prev.visualProject ? syncVisualProjectAssets(prev.visualProject) : prev.assets,
      };
    });
  };

  const applyTemplateComposeDraft = ({ draft, result, asset, title }: { draft: TemplateComposeDocument; result: TemplateComposeResult; asset: Asset; title?: string }) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      const preservedAssets = prev.assets.filter((item) => !isTemplateComposeAsset(item));
      return {
        ...prev,
        title: title || prev.title,
        assets: [asset, ...preservedAssets],
        templateComposeDraft: draft,
        templateDraftStatus: 'applied',
        templateComposeResult: {
          ...result,
          document: draft,
        },
      };
    });
  };

  const saveTemplateComposeDraft = ({ draft, result, asset }: { draft: TemplateComposeDocument; result: TemplateComposeResult; asset: Asset }) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      const preservedAssets = prev.assets.filter((item) => !isTemplateComposeAsset(item));
      return {
        ...prev,
        assets: [asset, ...preservedAssets],
        templateComposeDraft: draft,
        templateDraftStatus: 'draft',
        templateComposeResult: {
          ...result,
          document: draft,
        },
      };
    });
  };

  const updateVisualProject = (project: VisualProject | null) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        visualProject: project,
        assets: project ? syncVisualProjectAssets(project) : prev.assets,
        visualModeResolved: project ? 'template_compose' : prev.visualModeResolved,
      };
    });
  };

  const saveVisualProjectDraft = ({ project }: { project: VisualProject }) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      const syncedProject = {
        ...project,
        status: 'draft' as const,
      };
      return {
        ...prev,
        title: syncedProject.title || prev.title,
        visualProject: syncedProject,
        assets: syncVisualProjectAssets(syncedProject),
        visualModeResolved: 'template_compose',
        templateComposeDraft: getVisualProjectPrimaryDocument(syncedProject),
        templateComposeResult: getVisualProjectPrimaryResult(syncedProject),
        templateDraftStatus: 'draft',
      };
    });
  };

  const applyVisualProjectDraft = ({ project, title }: { project: VisualProject; title?: string }) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      const syncedProject = {
        ...project,
        status: 'applied' as const,
      };
      return {
        ...prev,
        title: title || syncedProject.title || prev.title,
        visualProject: syncedProject,
        assets: syncVisualProjectAssets(syncedProject),
        visualModeResolved: 'template_compose',
        templateComposeDraft: getVisualProjectPrimaryDocument(syncedProject),
        templateComposeResult: getVisualProjectPrimaryResult(syncedProject),
        templateDraftStatus: 'applied',
      };
    });
  };

  const updateStudioDraftState = (state: StudioDraftState | null) => {
    setGeneratedNote((prev) => {
      if (!prev) {
        return prev;
      }
      const nextState = sanitizeStudioDraftState(state);
      if (isSameStudioDraftState(prev.studioDraftState, nextState)) {
        return prev;
      }
      return {
        ...prev,
        studioDraftState: nextState,
      };
    });
  };

  const exportGeneratedNoteState = () => (generatedNote ? sanitizeGeneratedNoteContent(generatedNote) : null);

  const restoreGeneratedNoteState = (note: GeneratedNoteRecord | null) => {
    setGeneratedNote(note ? sanitizeGeneratedNoteContent(note) : null);
  };

  return (
    <NoteContext.Provider
      value={{
        generatedNote,
        setGeneratedNote,
        updateAssets,
        updateTemplateComposeDraft,
        saveTemplateComposeDraft,
        applyTemplateComposeDraft,
        updateVisualProject,
        saveVisualProjectDraft,
        applyVisualProjectDraft,
        updateStudioDraftState,
        exportGeneratedNoteState,
        restoreGeneratedNoteState,
        hasGeneratedContent: generatedNote !== null,
      }}
    >
      {children}
    </NoteContext.Provider>
  );
};

export const useNote = () => {
  const context = useContext(NoteContext);
  if (context === undefined) {
    throw new Error('useNote must be used within a NoteProvider');
  }
  return context;
};
