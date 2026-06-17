import React from 'react';
import { TemplateComposeDocument, TemplateModuleLayout } from '../types';
import TemplateComposeCanvasPreview from './TemplateComposeCanvasPreview';

interface ScaledTemplateCanvasProps {
  document: TemplateComposeDocument;
  scale: number;
  presentation?: 'default' | 'embedded';
  selectedModuleId?: string | null;
  onModuleSelect?: (moduleId: string) => void;
  onModuleLayoutChange?: (moduleId: string, nextLayout: Partial<TemplateModuleLayout>) => void;
}

const ScaledTemplateCanvas: React.FC<ScaledTemplateCanvasProps> = ({
  document,
  scale,
  presentation = 'embedded',
  selectedModuleId,
  onModuleSelect,
  onModuleLayoutChange,
}) => (
  <div className="absolute left-1/2 top-1/2" style={{ transform: 'translate(-50%, -50%)' }}>
    <div
      style={{
        width: document.canvas.width || 720,
        height: document.canvas.height || 960,
        transform: `scale(${scale})`,
        transformOrigin: 'center center',
      }}
    >
      <TemplateComposeCanvasPreview
        document={document}
        renderMode="canvas"
        presentation={presentation}
        selectedModuleId={selectedModuleId}
        onModuleSelect={onModuleSelect}
        onModuleLayoutChange={onModuleLayoutChange}
      />
    </div>
  </div>
);

export default ScaledTemplateCanvas;
