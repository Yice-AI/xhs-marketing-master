import React, { useContext } from 'react';
import { Asset } from '../types';
import { LayoutContext } from '../App';
import TemplateAssetPreview from './TemplateAssetPreview';

interface AssetGalleryProps {
  assets: Asset[];
  activeId: string;
  onSelect: (id: string) => void;
  selectionMode?: boolean;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
  compact?: boolean;
}

const isTemplateComposeAsset = (asset: Asset) => Boolean(
  asset.sourceType === 'template_compose'
  || asset.visualModeResolved === 'template_compose'
  || asset.layoutFamily === 'template_compose'
  || asset.templateKind
  || asset.editablePayload
);

const AssetGallery: React.FC<AssetGalleryProps> = ({ assets, activeId, onSelect, selectionMode = false, selectedIds = [], onToggleSelect, compact = false }) => {
  const layout = useContext(LayoutContext);

  if (!layout) return null;

  const gridCols = compact ? 4 : layout.isMobile ? 2 : 3;

  return (
    <div className={compact ? 'p-4 pb-3' : 'p-5'}>
      <div className={`flex justify-between items-center ${compact ? 'mb-3' : 'mb-4'}`}>
        <h2 className="text-white/80 font-medium flex items-center gap-2 text-xs uppercase tracking-wider">
          <span className="material-symbols-outlined text-xhs-red text-[16px]">grid_view</span>
          视觉资产
        </h2>
        <div className="flex gap-2">
          <button className="p-1.5 rounded-md hover:bg-white/5 text-gray-500 hover:text-white transition-colors">
            <span className="material-symbols-outlined text-[16px]">tune</span>
          </button>
          <button className="p-1.5 rounded-md bg-white/5 text-white hover:bg-white/10 transition-colors border border-white/5">
            <span className="material-symbols-outlined text-[16px]">add</span>
          </button>
        </div>
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
      >
        {assets.map((asset) => (
          <div
            key={asset.id}
            onClick={() => {
              onSelect(asset.id);
              if (selectionMode && onToggleSelect) {
                onToggleSelect(asset.id);
              }
            }}
            className={`group relative ${compact ? 'aspect-square' : isTemplateComposeAsset(asset) ? 'aspect-[3/4]' : 'aspect-square'} rounded-xl cursor-pointer overflow-hidden transition-all duration-300 ${
              activeId === asset.id
                ? 'ring-2 ring-xhs-red/50 shadow-[0_0_20px_rgba(255,36,66,0.15)] bg-[#18181b]'
                : selectedIds.includes(asset.id)
                  ? 'ring-2 ring-emerald-400/40 shadow-[0_0_20px_rgba(52,211,153,0.12)] bg-[#18181b]'
                  : 'border border-white/5 hover:border-white/20 bg-[#18181b]'
            }`}
          >
            {selectionMode && (
              <div className="absolute left-2 top-2 z-20 rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold text-white backdrop-blur">
                {selectedIds.includes(asset.id) ? '已选' : '多选'}
              </div>
            )}
            {selectionMode && (
              <div className={`absolute right-2 top-2 z-20 flex size-6 items-center justify-center rounded-full border ${selectedIds.includes(asset.id) ? 'border-emerald-300 bg-emerald-400 text-slate-950' : 'border-white/20 bg-black/60 text-white'} backdrop-blur`}>
                <span className="material-symbols-outlined text-[14px]">
                  {selectedIds.includes(asset.id) ? 'check' : 'add'}
                </span>
              </div>
            )}
            <div className={`h-full w-full transition-transform duration-700 group-hover:scale-105 ${asset.isProcessing ? 'opacity-70' : ''}`}>
              <TemplateAssetPreview asset={asset} mode="thumbnail" />
            </div>
            {asset.isProcessing && (
              <>
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-80"></div>
                <div className="absolute top-2 right-2 z-10">
                  <div className="size-5 rounded-full bg-xhs-red text-white flex items-center justify-center shadow-lg">
                    <span className="material-symbols-outlined text-[12px] animate-spin">sync</span>
                  </div>
                </div>
                <div className="absolute inset-x-0 bottom-0 p-2 z-20">
                  <div className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-xhs-red animate-pulse"></span>
                    <span className="text-[9px] font-medium text-white/90 tracking-wide">{asset.statusText}</span>
                  </div>
                </div>
              </>
            )}
            {!asset.isProcessing && activeId !== asset.id && (
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <span className="material-symbols-outlined text-white text-[20px]">edit</span>
              </div>
            )}
            {!asset.isProcessing && !isTemplateComposeAsset(asset) && (asset.variantKey || asset.visualFocus) && (
              <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
                <div className="text-[9px] font-medium text-white/90">{asset.promptLabel || asset.variantKey}</div>
                <div className="text-[9px] text-white/65 truncate">{asset.visualFocus || asset.layoutFamily}</div>
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          className={`${compact ? 'aspect-square' : 'aspect-[3/4]'} rounded-xl border border-dashed border-white/10 bg-[#14161c] hover:bg-[#181b22] hover:border-white/20 cursor-pointer flex flex-col items-center justify-center transition-all gap-2 group`}
        >
          <div className={`${compact ? 'h-8 w-8' : 'h-11 w-11'} flex items-center justify-center rounded-full border border-white/10 bg-white/[0.04] group-hover:border-xhs-red/30 group-hover:bg-xhs-red/10 transition-colors`}>
            <span className={`${compact ? 'text-[16px]' : 'text-[20px]'} material-symbols-outlined text-gray-500 group-hover:text-xhs-red transition-colors`}>add_photo_alternate</span>
          </div>
          <div className={`${compact ? 'text-[10px]' : 'text-[11px]'} font-medium text-slate-400 group-hover:text-slate-200 transition-colors`}>
            添加素材
          </div>
        </button>
      </div>
    </div>
  );
};

export default AssetGallery;
