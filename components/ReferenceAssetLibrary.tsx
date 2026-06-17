import React, { useEffect, useState } from 'react';
import { ReferenceAsset } from '../types';

interface ReferenceAssetLibraryProps {
  assets: ReferenceAsset[];
  selectedAssetIds: string[];
  primaryAssetId?: string | null;
  onToggleAsset: (assetId: string) => void;
  onSetPrimaryAsset: (assetId: string) => void;
  onUpload: (file: File) => void;
  onDelete: (assetId: string) => void;
  onUpdate?: (assetId: string, updates: { display_name?: string; tags?: string[]; ai_hint?: string }) => void;
  isUploading?: boolean;
  deletingAssetId?: string | null;
}

const ReferenceAssetLibrary: React.FC<ReferenceAssetLibraryProps> = ({
  assets,
  selectedAssetIds,
  primaryAssetId = null,
  onToggleAsset,
  onSetPrimaryAsset,
  onUpload,
  onDelete,
  onUpdate,
  isUploading = false,
  deletingAssetId = null,
}) => {
  const [editingAsset, setEditingAsset] = useState<ReferenceAsset | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftTags, setDraftTags] = useState('');
  const [draftAiHint, setDraftAiHint] = useState('');

  useEffect(() => {
    if (!editingAsset) return;
    setDraftName(editingAsset.display_name || editingAsset.original_name);
    setDraftTags((editingAsset.tags || []).join(', '));
    setDraftAiHint(editingAsset.ai_hint || '');
  }, [editingAsset]);

  const closeEditor = () => setEditingAsset(null);

  const saveEditingAsset = () => {
    if (!editingAsset || !onUpdate) return;
    onUpdate(editingAsset.id, {
      display_name: draftName,
      tags: draftTags.split(/[,，#\n]+/).map((item) => item.trim()).filter(Boolean),
      ai_hint: draftAiHint,
    });
    closeEditor();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-slate-500">项目素材库</p>
          <p className="text-sm text-slate-300 mt-1">上传产品图、场景图或风格图后，系统会把它们作为素材辅助，用来校准提示词、构图和产品细节。</p>
        </div>
        <label className={`inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium transition ${isUploading ? 'bg-white/10 text-slate-400 cursor-not-allowed' : 'bg-white text-slate-900 cursor-pointer hover:bg-slate-100'}`}>
          {isUploading ? '上传中...' : '上传素材'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={isUploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onUpload(file);
                event.target.value = '';
              }
            }}
          />
        </label>
      </div>

      {assets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-black/10 px-4 py-8 text-center text-sm text-slate-500">
          还没有上传素材，先放几张产品图、场景图或风格图会更稳。
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {assets.map((asset) => {
            const isSelected = selectedAssetIds.includes(asset.id);
            const isPrimary = primaryAssetId === asset.id;
            const isDeleting = deletingAssetId === asset.id;
            return (
              <div
                key={asset.id}
                className={`rounded-2xl border overflow-hidden transition ${isPrimary ? 'border-sky-400 bg-sky-500/10' : isSelected ? 'border-xhs-red bg-xhs-red/10' : 'border-white/10 bg-white/5'}`}
              >
                <button type="button" onClick={() => onToggleAsset(asset.id)} className="w-full text-left">
                  <img src={asset.url} alt={asset.original_name} className="h-40 w-full object-cover bg-black/20" />
                  <div className="p-3 space-y-1">
                    <div className="text-sm text-white truncate">{asset.original_name}</div>
                    {asset.display_name && asset.display_name !== asset.original_name && (
                      <div className="text-[11px] text-slate-300 truncate">{asset.display_name}</div>
                    )}
                    <div className="text-[11px] text-slate-500">
                      {new Date(asset.created_at).toLocaleDateString()}
                    </div>
                    {asset.tags && asset.tags.length > 0 && (
                      <div className="line-clamp-1 text-[11px] text-sky-200/80">
                        {asset.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ')}
                      </div>
                    )}
                    <div className={`text-xs font-medium ${isPrimary ? 'text-sky-200' : isSelected ? 'text-rose-200' : 'text-slate-400'}`}>
                      {isPrimary ? '当前主素材' : isSelected ? '已加入素材' : '点击加入素材'}
                    </div>
                  </div>
                </button>
                <div className="px-3 pb-3 space-y-2">
                  {isSelected && (
                    <button
                      type="button"
                      onClick={() => onSetPrimaryAsset(asset.id)}
                      className={`w-full rounded-xl px-3 py-2 text-xs transition ${isPrimary ? 'bg-sky-500/20 text-sky-100' : 'bg-white/10 text-slate-200 hover:bg-white/15'}`}
                    >
                      {isPrimary ? '主素材编辑中' : '设为主素材'}
                    </button>
                  )}
                  {onUpdate && (
                    <button
                      type="button"
                      onClick={() => setEditingAsset(asset)}
                      className="w-full rounded-xl bg-white/10 px-3 py-2 text-xs text-slate-200 transition hover:bg-white/15"
                    >
                      备注标签
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onDelete(asset.id)}
                    disabled={isDeleting}
                    className={`w-full rounded-xl px-3 py-2 text-xs transition ${isDeleting ? 'bg-rose-500/10 text-rose-200/60 cursor-not-allowed' : 'bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'}`}
                  >
                    {isDeleting ? '删除中...' : '删除素材'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editingAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-[#141821] shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <div className="text-sm font-semibold text-white">素材备注与标签</div>
                <div className="mt-1 text-xs text-slate-500">这些信息会随参考图一起交给 AI，用来减少误判。</div>
              </div>
              <button type="button" onClick={closeEditor} className="rounded-xl p-2 text-slate-500 hover:bg-white/10 hover:text-white">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="grid gap-5 p-5 md:grid-cols-[220px_1fr]">
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/20">
                <img src={editingAsset.url} alt={editingAsset.original_name} className="h-48 w-full object-contain bg-black/30" />
                <div className="space-y-1 p-3">
                  <div className="truncate text-xs font-medium text-slate-200">{editingAsset.original_name}</div>
                  <div className="text-[11px] text-slate-500">{new Date(editingAsset.created_at).toLocaleDateString()}</div>
                </div>
              </div>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-xs font-medium text-slate-400">素材名称</span>
                  <input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/60"
                    placeholder="例如：微伴助手 logo"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-slate-400">标签</span>
                  <input
                    value={draftTags}
                    onChange={(event) => setDraftTags(event.target.value)}
                    className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white outline-none focus:border-sky-400/60"
                    placeholder="logo, 品牌色, 左上角替换"
                  />
                  <span className="mt-1 block text-[11px] text-slate-600">用逗号分隔，后续可在素材库里筛选。</span>
                </label>

                <label className="block">
                  <span className="text-xs font-medium text-slate-400">给 AI 的说明</span>
                  <textarea
                    value={draftAiHint}
                    onChange={(event) => setDraftAiHint(event.target.value)}
                    className="mt-2 h-28 w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm leading-6 text-white outline-none focus:border-sky-400/60"
                    placeholder="例如：这是品牌 logo，改图时请保持图标和文字比例，不要重绘成其他品牌。"
                  />
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-white/10 px-5 py-4">
              <button type="button" onClick={closeEditor} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/10">
                取消
              </button>
              <button type="button" onClick={saveEditingAsset} className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-slate-100">
                保存备注
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReferenceAssetLibrary;
