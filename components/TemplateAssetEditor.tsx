import React from 'react';
import { TemplateComposeEditablePayload, TemplateKind } from '../types';

interface TemplateAssetEditorProps {
  payload: TemplateComposeEditablePayload;
  onChange: (nextPayload: TemplateComposeEditablePayload) => void;
}

const templateOptions: Array<{ value: TemplateKind; label: string }> = [
  { value: 'feature_hero', label: '功能主视觉' },
  { value: 'step_guide', label: '步骤说明' },
  { value: 'benefit_grid', label: '卖点网格' },
  { value: 'before_after', label: '前后对比' },
  { value: 'faq_card', label: 'FAQ 卡片' },
];

const themeOptions = [
  { value: 'warm', label: '暖调' },
  { value: 'cool', label: '蓝调' },
  { value: 'forest', label: '清新绿' },
  { value: 'graphite', label: '极简灰' },
];

const densityOptions = [
  { value: 'comfortable', label: '宽松' },
  { value: 'balanced', label: '均衡' },
  { value: 'compact', label: '紧凑' },
];

const TemplateAssetEditor: React.FC<TemplateAssetEditorProps> = ({ payload, onChange }) => {
  const updateField = <K extends keyof TemplateComposeEditablePayload>(key: K, value: TemplateComposeEditablePayload[K]) => {
    onChange({
      ...payload,
      [key]: value,
    });
  };

  const updateScreenshotLabel = (index: number, label: string) => {
    const screenshots = [...(payload.screenshots || [])];
    screenshots[index] = {
      ...screenshots[index],
      label,
    };
    updateField('screenshots', screenshots);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
        <div className="text-xs uppercase tracking-[0.18em] text-slate-500">模板轻编辑</div>
        <div className="mt-2 text-sm text-slate-300">这里优先控制产品介绍图的结构和文案，不开放自由拖拽。</div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="mb-2 block text-xs text-slate-500">模板</label>
          <select
            value={payload.templateKind}
            onChange={(event) => updateField('templateKind', event.target.value as TemplateKind)}
            className="h-11 w-full rounded-xl border border-white/10 bg-[#13151b] px-3 text-sm text-white"
          >
            {templateOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-2 block text-xs text-slate-500">主题色</label>
            <select
              value={payload.themeKey}
              onChange={(event) => updateField('themeKey', event.target.value)}
              className="h-11 w-full rounded-xl border border-white/10 bg-[#13151b] px-3 text-sm text-white"
            >
              {themeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-xs text-slate-500">密度</label>
            <select
              value={payload.density}
              onChange={(event) => updateField('density', event.target.value)}
              className="h-11 w-full rounded-xl border border-white/10 bg-[#13151b] px-3 text-sm text-white"
            >
              {densityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="mb-2 block text-xs text-slate-500">主标题</label>
          <input
            value={payload.title}
            onChange={(event) => updateField('title', event.target.value)}
            className="h-11 w-full rounded-xl border border-white/10 bg-[#13151b] px-3 text-sm text-white"
          />
        </div>

        <div>
          <label className="mb-2 block text-xs text-slate-500">副标题</label>
          <textarea
            value={payload.subtitle}
            onChange={(event) => updateField('subtitle', event.target.value)}
            rows={3}
            className="w-full rounded-xl border border-white/10 bg-[#13151b] px-3 py-3 text-sm text-white resize-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-2 block text-xs text-slate-500">CTA</label>
            <input
              value={payload.ctaText}
              onChange={(event) => updateField('ctaText', event.target.value)}
              className="h-11 w-full rounded-xl border border-white/10 bg-[#13151b] px-3 text-sm text-white"
            />
          </div>
          <div>
            <label className="mb-2 block text-xs text-slate-500">页脚说明</label>
            <input
              value={payload.footerNote || ''}
              onChange={(event) => updateField('footerNote', event.target.value)}
              className="h-11 w-full rounded-xl border border-white/10 bg-[#13151b] px-3 text-sm text-white"
            />
          </div>
        </div>
      </div>

      {(payload.screenshots || []).length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm font-semibold text-white">截图槽位</div>
          <div className="mt-3 space-y-3">
            {payload.screenshots.slice(0, 3).map((shot, index) => (
              <div key={`${shot.assetId || shot.url}-${index}`} className="rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="mb-2 text-xs text-slate-500">截图 {index + 1}</div>
                <div className="flex items-center gap-3">
                  <img src={shot.url} alt={shot.label || `截图 ${index + 1}`} className="h-16 w-16 rounded-lg object-cover" />
                  <div className="min-w-0 flex-1">
                    <input
                      value={shot.label || ''}
                      onChange={(event) => updateScreenshotLabel(index, event.target.value)}
                      className="h-10 w-full rounded-lg border border-white/10 bg-[#13151b] px-3 text-sm text-white"
                    />
                    <div className="mt-2 text-xs text-slate-500 truncate">{shot.url}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TemplateAssetEditor;
