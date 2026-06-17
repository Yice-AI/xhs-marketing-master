export interface LayoutConfig {
  sidebarWidth: number;
  maxColumns: number;
  fontScale: number;
  spacingScale: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isUltraWide: boolean;
  gridColumns: number;
  showSidebarAsBottom: boolean;
}

export function calculateOptimalLayout(
  viewportWidth: number,
  viewportHeight: number
): LayoutConfig {
  const sidebarWidth = Math.max(60, Math.min(100, viewportWidth * 0.06));

  const availableWidth = viewportWidth - sidebarWidth;
  const minPanelWidth = 280;
  const maxColumns = Math.floor(availableWidth / minPanelWidth);

  const fontScale = Math.max(0.75, Math.min(1.25, viewportWidth / 1440));

  const spacingScale = Math.max(0.6, Math.min(1, viewportWidth / 1440));

  const isMobile = viewportWidth < 768;
  const isTablet = viewportWidth >= 768 && viewportWidth < 1024;
  const isDesktop = viewportWidth >= 1024 && viewportWidth < 1920;
  const isUltraWide = viewportWidth >= 1920;

  let gridColumns = 4;
  if (isMobile) {
    gridColumns = 1;
  } else if (isTablet) {
    gridColumns = 2;
  } else if (isDesktop) {
    gridColumns = 3;
  } else if (isUltraWide) {
    gridColumns = 4;
  }

  const showSidebarAsBottom = isMobile;

  return {
    sidebarWidth,
    maxColumns: Math.min(maxColumns, 4),
    fontScale,
    spacingScale,
    isMobile,
    isTablet,
    isDesktop,
    isUltraWide,
    gridColumns,
    showSidebarAsBottom,
  };
}
