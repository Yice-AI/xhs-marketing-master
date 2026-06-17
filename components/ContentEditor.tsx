import React, { useState, useEffect } from 'react';
import { ContentData, Asset } from '../types';
import { polishContent } from '../services/geminiService';
import apiClient from '../services/apiClient';
import { useXhsPublisher } from '../src/hooks/useXhsPublisher';
import { useExtension } from '../src/hooks/useExtension';
import { assetNeedsTemplateHydration, hydrateTemplateAssetIfNeeded } from '../lib/templateAssetRenderer';
import { normalizeXhsTags, prepareXhsBodyForPublish, sanitizeMarkdownForXhs } from '../lib/xhsContent';

interface ContentEditorProps {
  content: ContentData;
  onChange: (updated: Partial<ContentData>) => void;
  assets?: Asset[];
  compact?: boolean;
}

const ContentEditor: React.FC<ContentEditorProps> = ({ content, onChange, assets = [], compact = false }) => {
  const [isPolishing, setIsPolishing] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [publishFeedback, setPublishFeedback] = useState<string>('');
  const [publishQuota, setPublishQuota] = useState<{ remaining: number, total: number, used: number } | null>(null);
  const [tagInput, setTagInput] = useState((content.tags || []).join(' '));
  const { extension } = useExtension();
  const { publish, isPublishing, statusMessage } = useXhsPublisher();

  useEffect(() => {
    const fetchQuota = async () => {
      try {
        const data = await apiClient.getPublishQuota();
        setPublishQuota(data);
      } catch (error) {
        console.error('获取发布配额失败:', error);
      }
    };
    fetchQuota();
  }, []);

  useEffect(() => {
    setTagInput((content.tags || []).join(' '));
  }, [content.tags]);

  const commitTags = (value: string) => {
    const tags = normalizeXhsTags(value.split(/[\s#，,、;；\n\r\t]+/));
    onChange({ tags });
    return tags;
  };

  const blobToPng = async (blob: Blob, preferredSrc?: string): Promise<Blob> => {
    if (typeof window === 'undefined') {
      return blob;
    }

    const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });

    const objectUrl = URL.createObjectURL(blob);
    try {
      let image: HTMLImageElement | null = null;
      const sourceCandidates = [
        preferredSrc && preferredSrc.startsWith('data:image/') ? preferredSrc : '',
        objectUrl,
      ].filter(Boolean);

      let lastError: Error | null = null;
      for (const src of sourceCandidates) {
        try {
          image = await loadImage(src);
          break;
        } catch (error: any) {
          lastError = error instanceof Error ? error : new Error('图片解码失败');
        }
      }

      if (!image) {
        throw lastError || new Error('图片解码失败');
      }

      const width = image.naturalWidth || image.width || 1080;
      const height = image.naturalHeight || image.height || 1440;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('无法创建图片画布');
      }
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);

      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => {
          if (result) {
            resolve(result);
            return;
          }
          reject(new Error('PNG 导出失败'));
        }, 'image/png');
      });

      return pngBlob;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const rasterizeViaBackend = async (dataUrl: string): Promise<Blob> => {
    const response = await fetch('/api/scraper/rasterize-template', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data_url: dataUrl }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `模板图光栅化失败: ${response.status}`);
    }
    return response.blob();
  };

  const assetToPublishFile = async (asset: Asset, index: number): Promise<File> => {
    const preparedAsset = assetNeedsTemplateHydration(asset) ? await hydrateTemplateAssetIfNeeded(asset) : asset;
    const publishUrl = preparedAsset.exportReadyUrl || preparedAsset.url;

    if (publishUrl.startsWith('data:image/svg+xml') || publishUrl.startsWith('data:image/gif')) {
      const pngBlob = await rasterizeViaBackend(publishUrl);
      const fileName = preparedAsset.sourceType === 'template_compose'
        ? `template_${index}.png`
        : `image_${index}.png`;
      return new File([pngBlob], fileName, { type: 'image/png' });
    }

    const response = await fetch(publishUrl);
    if (!response.ok) {
      throw new Error(`图片加载失败: ${response.status}`);
    }
    const blob = await response.blob();

    if (blob.type.includes('png') || blob.type.includes('jpeg') || blob.type.includes('jpg') || blob.type.includes('webp')) {
      const extension = blob.type.includes('jpeg') || blob.type.includes('jpg')
        ? 'jpg'
        : blob.type.includes('webp')
          ? 'webp'
          : 'png';
      const fileName = preparedAsset.sourceType === 'template_compose'
        ? `template_${index}.${extension}`
        : `image_${index}.${extension}`;
      return new File([blob], fileName, { type: blob.type || 'image/png' });
    }

    let pngBlob: Blob;
    try {
      pngBlob = await blobToPng(blob, publishUrl);
    } catch (error) {
      if (publishUrl.startsWith('data:image/')) {
        pngBlob = await rasterizeViaBackend(publishUrl);
      } else {
        throw error;
      }
    }
    const fileName = preparedAsset.sourceType === 'template_compose'
      ? `template_${index}.png`
      : `image_${index}.png`;
    return new File([pngBlob], fileName, { type: 'image/png' });
  };

  const handlePolish = async () => {
    setIsPolishing(true);
    const polished = await polishContent(content.title, content.body);
    if (polished) {
      onChange({ body: polished });
    }
    setIsPolishing(false);
  };

  const handlePublish = async () => {
    if (isPreparing || isPublishing) return;
    if (!confirm('确认发布到小红书？')) return;
    if (!extension) {
      setPublishFeedback('插件未连接，请先安装并连接浏览器扩展。');
      return;
    }

    setIsPreparing(true);
    setPublishFeedback('');
    try {
      const typedTags = commitTags(tagInput);
      const tags = typedTags.length > 0
        ? typedTags
        : (content.body.match(/#[^\s#]+/g)?.map(t => t.slice(1)) || []);

      const files: File[] = [];
      if (assets.length > 0) {
        for (let i = 0; i < assets.length; i++) {
          files.push(await assetToPublishFile(assets[i], i));
        }
      } else if (content.mainImageUrl) {
        const response = await fetch(content.mainImageUrl);
        const blob = await response.blob();
        if (blob.type.includes('png') || blob.type.includes('jpeg') || blob.type.includes('jpg') || blob.type.includes('webp')) {
          files.push(new File([blob], 'image_0.png', { type: blob.type || 'image/png' }));
        } else {
          const pngBlob = await blobToPng(blob, content.mainImageUrl);
          files.push(new File([pngBlob], 'image_0.png', { type: 'image/png' }));
        }
      }

      const publishTitle = sanitizeMarkdownForXhs(content.title);
      const cleanBody = prepareXhsBodyForPublish(content.body);

      setIsPreparing(false);
      const result = await publish(publishTitle, cleanBody, tags, files);
      setPublishFeedback(result.message);
    } catch (error: any) {
      console.error('发布错误:', error);
      const message = error?.message || '未知错误';
      setPublishFeedback(`发布失败：${message}`);
    } finally {
      setIsPreparing(false);
    }
  };

  return (
    <div className={`${compact ? 'min-h-0 flex-1 px-4 pb-4' : 'px-5 pb-5'} flex flex-col`}>
      <div className={`flex justify-between items-center ${compact ? 'mb-3' : 'mb-4'}`}>
        <h2 className="text-white/80 font-medium flex items-center gap-2 text-xs uppercase tracking-wider">
          <span className="material-symbols-outlined text-purple-400 text-[16px]">format_quote</span>
          创意文案
        </h2>
        <button
          onClick={handlePolish}
          disabled={isPolishing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-xhs-red/10 text-xhs-red hover:bg-xhs-red hover:text-white disabled:opacity-50 transition-all text-[10px] font-medium border border-xhs-red/10"
        >
          <span className={`material-symbols-outlined text-[12px] ${isPolishing ? 'animate-spin' : ''}`}>
            {isPolishing ? 'sync' : 'auto_fix_high'}
          </span>
          {isPolishing ? 'AI 润色中...' : 'AI 润色'}
        </button>
      </div>

      <div className={`${compact ? 'min-h-0 flex-1' : ''} flex flex-col relative group`}>
        <input
          className={`w-full bg-transparent border-0 border-b border-transparent focus:border-white/10 px-0 py-2 text-white/90 placeholder-gray-600 focus:ring-0 transition-all font-semibold tracking-tight leading-snug mb-3 ${compact ? 'text-lg' : 'text-xl'}`}
          placeholder="输入标题..."
          type="text"
          value={content.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
        <textarea
          className={`w-full bg-transparent border-0 px-0 py-2 text-gray-300 placeholder-gray-700 focus:ring-0 transition-all text-[15px] leading-relaxed focus:text-white selection:bg-xhs-red/30 font-light custom-scrollbar ${compact ? 'min-h-0 flex-1 resize-none overflow-y-auto' : 'resize-none min-h-[300px]'}`}
          placeholder="输入正文内容..."
          value={content.body}
          onChange={(e) => onChange({ body: e.target.value })}
        />
      </div>

      <div className="mt-3">
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-gray-500">
          发布标签
        </label>
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onBlur={() => {
            const tags = normalizeXhsTags(tagInput.split(/[\s#，,、;；\n\r\t]+/));
            setTagInput(tags.join(' '));
            onChange({ tags });
          }}
          placeholder="输入自定义标签，用空格或逗号分隔"
          className="h-10 w-full rounded-xl border border-white/8 bg-white/[0.03] px-3 text-sm text-gray-200 placeholder:text-gray-700 focus:border-xhs-red/40 focus:ring-0"
        />
        {(content.tags || []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-blue-300">
            {normalizeXhsTags(content.tags).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
      </div>

      <div className="mt-2 flex justify-end">
        <span className="text-[10px] text-gray-600 font-mono">{content.body.length} 字</span>
      </div>

      <div className={`${compact ? 'mt-3 pt-3' : 'mt-6 pt-5'} shrink-0 border-t border-white/5`}>
        {publishQuota && (
          <div className="text-xs text-gray-400 mb-3 text-center">
            今日剩余发布次数：<span className={publishQuota.remaining > 0 ? 'text-green-400' : 'text-red-400'}>{publishQuota.remaining}</span>/{publishQuota.total}
          </div>
        )}
        {publishFeedback && (
          <div className="text-xs text-center text-slate-300 mb-3">{publishFeedback}</div>
        )}
        <button
          onClick={handlePublish}
          disabled={isPreparing || isPublishing || (publishQuota && publishQuota.remaining === 0)}
          className={`w-full h-14 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${isPreparing || isPublishing || (publishQuota && publishQuota.remaining === 0)
            ? 'bg-slate-700 cursor-not-allowed'
            : 'bg-xhs-red hover:bg-xhs-dark shadow-lg shadow-xhs-red/20 active:scale-95'
            }`}
        >
          <span className={`material-symbols-outlined ${(isPreparing || isPublishing) ? 'animate-spin' : ''}`}>
            {(isPreparing || isPublishing) ? 'sync' : 'publish'}
          </span>
          {isPreparing ? '正在处理图片...' : (isPublishing ? (statusMessage || '发布中...') : '发布到小红书')}
        </button>
      </div>
    </div>
  );
};

export default ContentEditor;
