import { Asset, TemplateComposeDocument, TemplateComposeEditablePayload, TemplateComposeResult, TemplateKind } from '../types';
import { documentToEditablePayload, renderTemplateAssetDataUrl, renderTemplateDocumentDataUrl } from './templateComposer';

const TEMPLATE_PROXY_PREFIX = '/api/scraper/image-proxy?url=';

const isTemplateComposeAsset = (asset: Asset | null | undefined) =>
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

const isDataImageUrl = (value: string | undefined | null) => typeof value === 'string' && value.startsWith('data:image/');

const normalizeSourceImageUrl = (value: string | undefined | null): string => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (raw.startsWith('//')) {
    return `https:${raw}`;
  }
  if (raw.startsWith('http://')) {
    return `https://${raw.slice('http://'.length)}`;
  }
  return raw;
};

const buildProxyImageUrl = (value: string): string => {
  const normalized = normalizeSourceImageUrl(value);
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith(TEMPLATE_PROXY_PREFIX)) {
    return normalized;
  }
  return `${TEMPLATE_PROXY_PREFIX}${encodeURIComponent(normalized)}`;
};

const shouldFetchDirectly = (value: string): boolean => {
  if (!value) {
    return false;
  }
  if (value.startsWith('data:image/')) {
    return true;
  }
  if (value.startsWith('/')) {
    return true;
  }
  if (typeof window !== 'undefined') {
    try {
      const parsed = new URL(value, window.location.origin);
      return parsed.origin === window.location.origin;
    } catch {
      return false;
    }
  }
  return false;
};

const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('无法读取图片数据'));
    };
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });

const toRenderableScreenshot = async (shot: TemplateComposeEditablePayload['screenshots'][number]) => {
  const rawUrl = normalizeSourceImageUrl(shot.url);
  if (!rawUrl) {
    return { screenshot: shot, usedFallback: true };
  }
  if (isDataImageUrl(rawUrl)) {
    return { screenshot: { ...shot, url: rawUrl }, usedFallback: false };
  }

  const fetchUrl = shouldFetchDirectly(rawUrl) ? rawUrl : buildProxyImageUrl(rawUrl);

  try {
    const response = await fetch(fetchUrl);
    if (!response.ok) {
      throw new Error(`图片代理失败: ${response.status}`);
    }
    const blob = await response.blob();
    const dataUrl = await blobToDataUrl(blob);
    return {
      screenshot: {
        ...shot,
        url: dataUrl,
      },
      usedFallback: false,
    };
  } catch (error) {
    console.warn('模板截图内嵌失败，回退代理地址渲染', error);
    const proxyUrl = shouldFetchDirectly(rawUrl) ? rawUrl : buildProxyImageUrl(rawUrl);
    return {
      screenshot: {
        ...shot,
        url: proxyUrl || rawUrl,
      },
      usedFallback: true,
    };
  }
};

export const prepareTemplatePayloadForRender = async (payload: TemplateComposeEditablePayload): Promise<{
  payload: TemplateComposeEditablePayload;
  usedFallback: boolean;
}> => {
  const screenshots = payload.screenshots || [];
  if (screenshots.length === 0) {
    return {
      payload,
      usedFallback: false,
    };
  }

  const prepared = await Promise.all(screenshots.map((shot) => toRenderableScreenshot(shot)));

  return {
    payload: {
      ...payload,
      screenshots: prepared.map((item) => item.screenshot),
    },
    usedFallback: prepared.some((item) => item.usedFallback),
  };
};

export const prepareTemplateDocumentRender = async (document: TemplateComposeDocument) => {
  const sourcePayload = documentToEditablePayload(document);
  const prepared = await prepareTemplatePayloadForRender(sourcePayload);
  const preparedDocument: TemplateComposeDocument = {
    ...document,
    assets: prepared.payload.screenshots,
    modules: document.modules.map((module) =>
      module.type === 'screenshot_frame'
        ? {
            ...module,
            content: prepared.payload.screenshots,
          }
        : module
    ),
  };
  return {
    payload: prepared.payload,
    renderedImageUrl: renderTemplateDocumentDataUrl(preparedDocument),
    usedFallback: prepared.usedFallback,
  };
};

export const prepareTemplateResultForRender = async (result: TemplateComposeResult): Promise<TemplateComposeResult> => {
  if (result.document) {
    const prepared = await prepareTemplateDocumentRender(result.document);
    return {
      ...result,
      rendered_image_url: prepared.renderedImageUrl,
    };
  }
  const prepared = await prepareTemplatePayloadForRender(result.editable_payload);
  return {
    ...result,
    rendered_image_url: renderTemplateAssetDataUrl(prepared.payload),
  };
};

export const buildTemplateDisplayUrl = (
  payloadOrDocument: TemplateComposeEditablePayload | TemplateComposeDocument
): string => {
  const payload = 'screenshots' in payloadOrDocument ? payloadOrDocument : documentToEditablePayload(payloadOrDocument);
  return renderTemplateAssetDataUrl(payload);
};

export const buildTemplateAssetForStudio = async ({
  document,
  sourceAsset,
  mode = '模板拼装',
  promptLabel,
  promptText,
}: {
  document: TemplateComposeDocument;
  sourceAsset?: Partial<Asset>;
  mode?: string;
  promptLabel?: string;
  promptText?: string;
}): Promise<Asset> => {
  const editablePayload = documentToEditablePayload(document);
  const prepared = await prepareTemplatePayloadForRender(editablePayload);
  const preparedDocument: TemplateComposeDocument = {
    ...document,
    assets: prepared.payload.screenshots,
    modules: document.modules.map((module) =>
      module.type === 'screenshot_frame'
        ? {
            ...module,
            content: prepared.payload.screenshots,
          }
        : module
    ),
  };

  return {
    id: sourceAsset?.id || `template-${document.id}`,
    url: renderTemplateDocumentDataUrl(document),
    exportReadyUrl: renderTemplateDocumentDataUrl(preparedDocument),
    sourceType: 'template_compose',
    mode,
    promptLabel: promptLabel || sourceAsset?.promptLabel || '模板拼装',
    promptText: promptText || sourceAsset?.promptText || `模板方案：${document.templateKind}${document.styleVariant ? ` / ${document.styleVariant}` : ''}`,
    variantKey: sourceAsset?.variantKey || `${document.templateKind}${document.styleVariant ? `:${document.styleVariant}` : ''}`,
    layoutFamily: 'template_compose',
    visualFocus: sourceAsset?.visualFocus || '截图保真 + 模板拼装',
    visualModeResolved: 'template_compose',
    templateKind: (sourceAsset?.templateKind || document.templateKind) as TemplateKind,
    editablePayload,
    templateDocument: document,
    referenceAssetIds: sourceAsset?.referenceAssetIds || (document.assets || []).map((item) => item.assetId).filter(Boolean) as string[],
    isProcessing: false,
    statusText: prepared.usedFallback ? '部分素材使用代理降级渲染' : sourceAsset?.statusText,
    editSourceAssetId: sourceAsset?.editSourceAssetId,
    editPreservationMode: sourceAsset?.editPreservationMode,
  };
};

export const hydrateTemplateAssetIfNeeded = async (asset: Asset): Promise<Asset> => {
  if (!isTemplateComposeAsset(asset) || !asset.editablePayload) {
    return asset;
  }
  if (asset.templateDocument) {
    const prepared = await prepareTemplateDocumentRender(asset.templateDocument);
    return {
      ...asset,
      url: asset.url || renderTemplateDocumentDataUrl(asset.templateDocument),
      exportReadyUrl: prepared.renderedImageUrl,
      isProcessing: false,
      statusText: prepared.usedFallback ? '部分素材使用代理降级渲染' : asset.statusText,
    };
  }
  const prepared = await prepareTemplatePayloadForRender(asset.editablePayload);
  return {
    ...asset,
    url: asset.url || buildTemplateDisplayUrl(asset.editablePayload),
    exportReadyUrl: renderTemplateAssetDataUrl(prepared.payload),
    isProcessing: false,
    statusText: prepared.usedFallback ? '部分素材使用代理降级渲染' : asset.statusText,
  };
};

export const assetNeedsTemplateHydration = (asset: Asset | null | undefined): boolean => {
  if (!isTemplateComposeAsset(asset) || !asset?.editablePayload) {
    return false;
  }
  return !isDataImageUrl(asset.exportReadyUrl);
};
