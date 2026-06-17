import { Asset, TemplateComposeCard, TemplateComposeDocument, TemplateComposeResult, TemplateComposeSeriesResult, VisualProject } from '../types';
import { buildTemplateAssetForStudio } from './templateAssetRenderer';
import { documentToEditablePayload, withDocumentFromComposeResult } from './templateComposer';

export const isTemplateComposeAsset = (asset: Asset | null | undefined) =>
  Boolean(
    asset
    && (
      asset.sourceType === 'template_compose'
      || asset.visualModeResolved === 'template_compose'
      || asset.layoutFamily === 'template_compose'
      || asset.templateKind
      || asset.editablePayload
    )
  );

export const buildVisualProjectAssets = (project: VisualProject | null | undefined): Asset[] =>
  (project?.cards || []).map((card) => card.renderedAsset);

export const getActiveVisualCard = (project: VisualProject | null | undefined): TemplateComposeCard | null => {
  if (!project?.cards?.length) {
    return null;
  }
  return project.cards.find((card) => card.cardId === project.activeCardId) || project.cards[0];
};

export const buildVisualProjectFromSeriesResult = async (
  result: TemplateComposeSeriesResult,
  options?: {
    projectId?: string;
    status?: VisualProject['status'];
  }
): Promise<VisualProject> => {
  const cards = await Promise.all((result.cards || []).map(async (card, index) => {
    const composeResult = card.composeResult
      ? withDocumentFromComposeResult(card.composeResult)
      : null;
    const directDocument = card.document && Array.isArray(card.document.modules) && card.document.modules.length > 0
      ? card.document
      : null;
    const document = directDocument
      || composeResult?.document
      || (card.renderedAsset?.editablePayload
        ? withDocumentFromComposeResult({
            canvas: card.renderedAsset.editablePayload.canvas,
            template_kind: card.renderedAsset.editablePayload.templateKind,
            slots: [],
            rendered_image_url: card.renderedAsset.url,
            editable_payload: card.renderedAsset.editablePayload,
            note_visual_plan: result.note_visual_plan || undefined,
          }).document
        : null)
      || null;
    const renderedAsset = await buildTemplateAssetForStudio({
      document: document!,
      sourceAsset: card.renderedAsset,
      promptLabel: card.cardType || card.title || `第 ${index + 1} 页`,
      promptText: card.summary || card.renderedAsset?.promptText || '',
    });
    return {
      ...card,
      document: document!,
      composeResult: composeResult || card.composeResult,
      renderedAsset,
      status: card.status || 'draft',
    };
  }));

  return {
    ...result.project,
    projectId: options?.projectId || result.project.projectId,
    cards,
    coverCardId: result.project.coverCardId || cards[0]?.cardId || '',
    activeCardId: result.project.activeCardId || cards[0]?.cardId || '',
    status: options?.status || result.project.status || 'draft',
    noteVisualPlan: result.note_visual_plan || result.project.noteVisualPlan || null,
  };
};

export const createSeriesResultFromProject = (project: VisualProject): TemplateComposeSeriesResult => ({
  project,
  cards: project.cards,
  note_visual_plan: project.noteVisualPlan || undefined,
  template_pack_key: project.templatePackKey,
});

export const getVisualProjectPrimaryDocument = (
  project: VisualProject | null | undefined
): TemplateComposeDocument | null => getActiveVisualCard(project)?.document || null;

export const getVisualProjectPrimaryResult = (
  project: VisualProject | null | undefined
): TemplateComposeResult | null => {
  const activeCard = getActiveVisualCard(project);
  if (!activeCard) {
    return null;
  }
  return withDocumentFromComposeResult({
    canvas: activeCard.document.canvas,
    template_kind: activeCard.templateKind,
    slots: [],
    rendered_image_url: activeCard.renderedAsset.url,
    editable_payload: activeCard.renderedAsset.editablePayload || {
      ...documentToEditablePayload(activeCard.document),
    },
    document: activeCard.document,
    note_visual_plan: project.noteVisualPlan || undefined,
  });
};
