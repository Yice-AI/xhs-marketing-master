
import React, { useContext } from 'react';
import { LayoutContext } from '../App';
import { normalizeXhsTags } from '../lib/xhsContent';

interface PhonePreviewProps {
  title: string;
  content: string;
  imageUrl: string;
  tags?: string[];
}

const PhonePreview: React.FC<PhonePreviewProps> = ({ title, content, imageUrl, tags }) => {
  const extractedTags = content.match(/#[\u4e00-\u9fa5a-zA-Z0-9]+/g)?.map((t: string) => t.slice(1)) || [];
  const displayTags = normalizeXhsTags(tags && tags.length > 0 ? tags : extractedTags);
  
  const layout = useContext(LayoutContext);
  
  if (!layout) return null;

  const baseWidth = 320;
  const baseHeight = 660;
  const scale = layout.isMobile ? 0.7 : layout.isTablet ? 0.85 : 1;
  const scaledWidth = baseWidth * scale;
  const scaledHeight = baseHeight * scale;

  return (
    <div className="flex items-center justify-center h-full">
      <div 
        className="bg-white rounded-[32px] shadow-2xl overflow-hidden relative border-[8px] border-gray-900"
        style={{
          width: `${scaledWidth}px`,
          height: `${scaledHeight}px`,
        }}
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-6 bg-gray-900 rounded-b-2xl z-10"></div>
        
        <div className="h-full overflow-y-auto scrollbar-hide">
          <div className="relative">
            <img 
              src={imageUrl || 'https://images.unsplash.com/photo-1682687220742-aba13b6e50ba?w=400&h=600&fit=crop'} 
              alt="Preview" 
              className="w-full h-[400px] object-cover"
            />
            
            <div className="absolute top-3 left-3 right-3 flex justify-between items-start">
              <div className="flex items-center gap-2 bg-black/20 backdrop-blur-sm px-3 py-1.5 rounded-full">
                <div className="size-6 rounded-full bg-white/90"></div>
                <span className="text-white text-[11px] font-medium">AI创作工坊</span>
              </div>
              <button className="bg-xhs-red text-white text-[11px] font-bold px-4 py-1.5 rounded-full">关注</button>
            </div>
          </div>
          
          <div className="p-4">
            <h3 className="text-[15px] font-bold text-gray-900 mb-2 line-clamp-2">
              {title || '小红书笔记标题'}
            </h3>
            
            <p className="text-[13px] leading-relaxed text-gray-800 line-clamp-3 font-sans">
              {content}
            </p>
            
            {displayTags.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {displayTags.slice(0, 5).map((tag, index) => (
                  <span key={index} className="text-[#3b82f6] text-[13px] font-bold">
                    #{tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PhonePreview;
