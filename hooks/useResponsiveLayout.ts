import { useEffect, useState } from 'react';
import { useViewportSize } from './useViewportSize';
import { calculateOptimalLayout, LayoutConfig } from '../utils/layoutCalculator';

export function useResponsiveLayout(): LayoutConfig | null {
  const { width, height } = useViewportSize();
  const [layout, setLayout] = useState<LayoutConfig | null>(null);

  useEffect(() => {
    const config = calculateOptimalLayout(width, height);
    setLayout(config);

    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--font-scale', config.fontScale.toString());
      document.documentElement.style.setProperty('--spacing-scale', config.spacingScale.toString());
      document.documentElement.style.setProperty('--sidebar-width', `${config.sidebarWidth}px`);
      document.documentElement.style.setProperty('--grid-columns', config.gridColumns.toString());
    }
  }, [width, height]);

  return layout;
}
