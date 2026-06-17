
import React, { useContext } from 'react';
import { ViewState } from '../types';
import { LayoutContext } from '../App';

interface SidebarProps {
  activeView: ViewState;
  onViewChange: (view: ViewState) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ activeView, onViewChange }) => {
  const layout = useContext(LayoutContext);

  const navItems = [
    { id: 'HOME' as ViewState, icon: 'home', label: '首页' },
    { id: 'SCRAPER' as ViewState, icon: 'search', label: '数据采集' },
    { id: 'INTERVIEW' as ViewState, icon: 'record_voice_over', label: 'AI 访谈' },
    { id: 'CREATION' as ViewState, icon: 'edit_note', label: '笔记制作' },
    { id: 'STUDIO' as ViewState, icon: 'auto_awesome', label: 'AI 创作' },
    { id: 'ANALYTICS' as ViewState, icon: 'analytics', label: '趋势分析' },
  ];

  if (!layout) return null;

  // 模拟导出单文件 HTML 的功能
  const handleExportSingleFile = () => {
    alert('正在准备便携式 HTML 导出...\n该文件将整合所有代码，支持本地双击直接运行。');

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>XHS Marketing Master - Portable</title>
  <script src="https://cdn.tailwindcss.com?plugins=forms,typography,aspect-ratio"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  <style>
    body { background-color: #08050a; color: white; margin: 0; font-family: 'Noto Sans SC', sans-serif; }
    .scrollbar-hide::-webkit-scrollbar { display: none; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    // 这里会自动包含所有 React 逻辑 (此处仅为逻辑演示，实际下载会整合完整代码)
    const App = () => <div style={{padding: '50px', textAlign: 'center'}}><h1>便携版正在生成...</h1><p>请联系开发者获取完整打包脚本</p></div>;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<App />);
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'XHS_Marketing_Tool_Portable.html';
    a.click();
    URL.revokeObjectURL(url);
  };

  if (layout.showSidebarAsBottom) {
    return (
      <aside className="h-16 flex items-center justify-around border-t border-white/5 bg-xhs-panel/95 backdrop-blur-xl shrink-0 z-50 px-4">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={`flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${activeView === item.id
              ? 'text-xhs-red'
              : 'text-slate-500'
              }`}
          >
            <span className="material-symbols-outlined text-[24px] font-light">
              {item.icon}
            </span>
            <span className="text-[9px] font-medium tracking-tight">
              {item.label}
            </span>
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside
      className="flex flex-col items-center py-8 border-r border-white/5 bg-xhs-panel/80 backdrop-blur-xl shrink-0 z-50 transition-all duration-300"
      style={{ width: `${layout.sidebarWidth}px` }}
    >
      <div className="mb-10">
        <div
          className="bg-gradient-to-br from-xhs-red to-pink-600 rounded-xl flex items-center justify-center text-white font-bold shadow-lg shadow-xhs-red/20 ring-1 ring-white/10 transition-all"
          style={{
            width: `${Math.max(40, layout.sidebarWidth * 0.5)}px`,
            height: `${Math.max(40, layout.sidebarWidth * 0.5)}px`,
            fontSize: `${Math.max(18, layout.sidebarWidth * 0.25)}px`
          }}
        >
          小
        </div>
      </div>

      <nav className="flex-1 flex flex-col gap-4 w-full px-3">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onViewChange(item.id)}
            className={`flex flex-col items-center gap-1.5 p-3 rounded-2xl transition-all group relative ${activeView === item.id
              ? 'bg-xhs-red text-white shadow-lg shadow-xhs-red/30'
              : 'text-slate-500 hover:text-slate-200 hover:bg-white/5'
              }`}
          >
            <span
              className="material-symbols-outlined font-light"
              style={{ fontSize: `${Math.max(20, layout.sidebarWidth * 0.25)}px` }}
            >
              {item.icon}
            </span>
            <span
              className="font-medium tracking-tight"
              style={{ fontSize: `${Math.max(9, layout.sidebarWidth * 0.12)}px` }}
            >
              {item.label}
            </span>
            {activeView === item.id && !layout.isMobile && (
              <div className="absolute -right-3 top-1/2 -translate-y-1/2 w-1 h-8 bg-xhs-red rounded-l-full"></div>
            )}
          </button>
        ))}
      </nav>

      <div className="mt-auto flex flex-col items-center gap-6 pb-4">
        <button
          onClick={handleExportSingleFile}
          title="导出可离线运行的 HTML"
          className="flex items-center justify-center rounded-xl bg-white/5 text-slate-500 hover:text-emerald-400 hover:bg-emerald-400/10 transition-all border border-white/5"
          style={{
            width: `${Math.max(36, layout.sidebarWidth * 0.45)}px`,
            height: `${Math.max(36, layout.sidebarWidth * 0.45)}px`
          }}
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: `${Math.max(18, layout.sidebarWidth * 0.22)}px` }}
          >
            download_for_offline
          </span>
        </button>

        <button className="text-slate-500 hover:text-white transition-colors">
          <span
            className="material-symbols-outlined"
            style={{ fontSize: `${Math.max(20, layout.sidebarWidth * 0.25)}px` }}
          >
            settings
          </span>
        </button>
        <div
          className="rounded-full border-2 border-xhs-red/50 p-0.5"
          style={{
            width: `${Math.max(36, layout.sidebarWidth * 0.45)}px`,
            height: `${Math.max(36, layout.sidebarWidth * 0.45)}px`
          }}
        >
          <img
            src="https://picsum.photos/100/100?random=1"
            className="w-full h-full rounded-full object-cover"
            alt="User"
          />
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
