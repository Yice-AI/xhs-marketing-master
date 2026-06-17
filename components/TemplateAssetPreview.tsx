import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Asset } from '../types';
import { editablePayloadToDocument } from '../lib/templateComposer';
import { getTemplateViewportScale } from '../lib/templatePreviewLayout';
import ScaledTemplateCanvas from './ScaledTemplateCanvas';

interface TemplateAssetPreviewProps {
  asset: Asset;
  className?: string;
  mode?: 'thumbnail' | 'full';
}

const isSvgDataUrl = (value?: string) => typeof value === 'string' && value.startsWith('data:image/svg+xml');
const TemplateAssetPreview: React.FC<TemplateAssetPreviewProps> = ({ asset, className = '', mode = 'thumbnail' }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const fallbackRenderedUrl = mode === 'full'
    ? (asset.exportReadyUrl || (isSvgDataUrl(asset.url) ? '' : asset.url))
    : '';
  const shouldPreferDocumentPreview = Boolean(
    asset.templateDocument || asset.editablePayload
  );
  const document = useMemo(() => (
    shouldPreferDocumentPreview
      ? asset.templateDocument
      ? asset.templateDocument
      : asset.editablePayload
      ? editablePayloadToDocument(asset.editablePayload, {
          id: String(asset.id || `template-doc-${Date.now()}`),
        })
      : null
      : null
  ), [asset.editablePayload, asset.id, asset.templateDocument, shouldPreferDocumentPreview]);

  useEffect(() => {
    if (!document) {
      return;
    }

    const node = containerRef.current;
    if (!node) {
      return;
    }

    const updateSize = () => {
      const rect = node.getBoundingClientRect();
      setContainerSize({
        width: rect.width,
        height: rect.height,
      });
    };

    updateSize();

    const observer = new ResizeObserver(() => updateSize());
    observer.observe(node);
    return () => observer.disconnect();
  }, [document]);

  const scale = useMemo(() => {
    if (!document) {
      return 1;
    }
    return getTemplateViewportScale(
      containerSize.width,
      containerSize.height,
      document.canvas.width || 720,
      document.canvas.height || 960,
      mode === 'full' ? 'preview' : 'thumbnail'
    );
  }, [containerSize.height, containerSize.width, document, mode]);

  if (document) {
    if (mode === 'full' || mode === 'thumbnail') {
      return (
        <div ref={containerRef} className={`relative h-full w-full overflow-hidden ${mode === 'full' ? 'bg-white' : 'bg-[#111319]'} ${className}`.trim()}>
          <ScaledTemplateCanvas document={document} scale={scale} presentation="embedded" />
        </div>
      );
    }
  }

  if (fallbackRenderedUrl || asset.url) {
    return (
      <img
        alt={`Asset ${asset.id}`}
        className={`h-full w-full ${mode === 'full' ? 'object-contain bg-white' : 'object-cover'} ${className}`.trim()}
        src={fallbackRenderedUrl || asset.url}
      />
    );
  }

  return (
    <div className={`flex h-full w-full items-center justify-center bg-[#111319] px-3 text-center ${className}`.trim()}>
      <div>
        <div className="text-[11px] font-medium text-slate-200">
          {asset.statusText || '模板图片准备中...'}
        </div>
        <div className="mt-1 text-[10px] text-slate-500">
          完整模板图生成后会自动回填
        </div>
      </div>
    </div>
  );
};

export default TemplateAssetPreview;
