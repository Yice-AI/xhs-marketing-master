import React, { Suspense, createContext, lazy, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import LoginDialog from './components/LoginDialog';
import AuthGate from './components/AuthGate';
import { ViewState, CreationMode, InterviewData, GeneratedContent, ExtensionReleaseManifest } from './types';
import { useResponsiveLayout } from './hooks/useResponsiveLayout';
import { LayoutConfig } from './utils/layoutCalculator';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ScraperProvider, useScraperContext } from './contexts/ScraperContext';
import { NoteProvider, useNote } from './contexts/NoteContext';
import { PersistenceProvider } from './contexts/PersistenceContext';
import { useExtension } from './src/hooks/useExtension';
import { editablePayloadToDocument, withDocumentFromComposeResult } from './lib/templateComposer';
import { getVisualProjectPrimaryDocument, getVisualProjectPrimaryResult, isTemplateComposeAsset } from './lib/visualProject';
import './styles/animations.css';

export const LayoutContext = createContext<LayoutConfig | null>(null);

const HomeView = lazy(() => import('./components/HomeView'));
const InterviewView = lazy(() => import('./components/InterviewView'));
const ScraperView = lazy(() => import('./components/ScraperView'));
const CreationView = lazy(() => import('./components/CreationView'));
const StudioView = lazy(() => import('./components/StudioView'));
const TemplateComposeEditorOverlay = lazy(() => import('./components/TemplateComposeEditorOverlay'));
const TemplateComposeSeriesEditorOverlay = lazy(() => import('./components/TemplateComposeSeriesEditorOverlay'));

const ViewLoadingFallback: React.FC = () => (
  <div className="flex h-full min-h-[320px] w-full items-center justify-center text-sm text-slate-400">
    正在加载页面...
  </div>
);

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; recoveryAttempted: boolean; isReloading: boolean; errorMessage: string; componentStack: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, recoveryAttempted: false, isReloading: false, errorMessage: '', componentStack: '' };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App render crashed:', error, errorInfo);
    const errorMessage = error?.message || String(error || 'Unknown render error');
    const isChunkLoadError = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(errorMessage);
    const reloadKey = 'xhs_chunk_reload_attempted';
    if (isChunkLoadError && typeof window !== 'undefined' && window.sessionStorage.getItem(reloadKey) !== '1') {
      window.sessionStorage.setItem(reloadKey, '1');
      this.setState({
        hasError: true,
        recoveryAttempted: true,
        isReloading: true,
        errorMessage,
        componentStack: errorInfo?.componentStack || '',
      });
      window.setTimeout(() => window.location.reload(), 400);
      return;
    }

    const nextErrorState = {
      errorMessage,
      componentStack: errorInfo?.componentStack || '',
    };

    this.setState({ recoveryAttempted: true, ...nextErrorState });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-full items-center justify-center bg-xhs-surface px-6 text-slate-200">
          <div className="max-w-lg rounded-3xl border border-rose-500/20 bg-xhs-card p-6 text-center">
            <h2 className="text-xl font-semibold text-white">页面渲染异常</h2>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              {this.state.isReloading
                ? '检测到前端版本刚更新，正在自动刷新到最新页面。'
                : '页面发生渲染异常。系统已停止自动清理本地创作数据，避免初稿、素材配置和出图任务被误删。'}
            </p>
            {this.state.errorMessage ? (
              <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4 text-left">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">Error</div>
                <div className="mt-2 break-all text-sm text-rose-200">{this.state.errorMessage}</div>
                {this.state.componentStack ? (
                  <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-400">{this.state.componentStack.trim()}</pre>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const compareVersions = (left: string, right: string) => {
  const leftParts = left.split('.').map((item) => Number(item) || 0);
  const rightParts = right.split('.').map((item) => Number(item) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const l = leftParts[index] || 0;
    const r = rightParts[index] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
};

const safeResolveTemplateComposeResult = (params: {
  generatedNote: GeneratedContent | null;
  templateComposeAsset: ReturnType<typeof isTemplateComposeAsset> extends boolean ? any : never;
}) => {
  const { generatedNote, templateComposeAsset } = params;
  try {
    if ((generatedNote as any)?.templateComposeResult) {
      return withDocumentFromComposeResult((generatedNote as any).templateComposeResult, (generatedNote as any).style);
    }
    if (!templateComposeAsset?.editablePayload) {
      return null;
    }
    const document = editablePayloadToDocument(templateComposeAsset.editablePayload, {
      id: String(templateComposeAsset.id || `template-doc-${Date.now()}`),
      brandStyle: (generatedNote as any)?.style,
    });
    return {
      canvas: templateComposeAsset.editablePayload.canvas,
      template_kind: templateComposeAsset.templateKind || templateComposeAsset.editablePayload.templateKind,
      slots: [],
      rendered_image_url: templateComposeAsset.url,
      editable_payload: templateComposeAsset.editablePayload,
      document,
      note_visual_plan: templateComposeAsset.editablePayload.noteVisualPlan || (generatedNote as any)?.noteVisualPlan || undefined,
    };
  } catch (error) {
    console.error('Failed to resolve template compose result from cached note:', error);
    return null;
  }
};

const safeResolveTemplateComposeDocument = (params: {
  generatedNote: GeneratedContent | null;
  templateComposeAsset: any;
  resolvedTemplateComposeResult: any;
  visualProject: any;
}) => {
  const { generatedNote, templateComposeAsset, resolvedTemplateComposeResult, visualProject } = params;
  try {
    if (visualProject) {
      return getVisualProjectPrimaryDocument(visualProject);
    }
    if ((generatedNote as any)?.templateComposeDraft) {
      return (generatedNote as any).templateComposeDraft;
    }
    if (resolvedTemplateComposeResult?.document) {
      return resolvedTemplateComposeResult.document;
    }
    if (templateComposeAsset?.editablePayload) {
      return editablePayloadToDocument(templateComposeAsset.editablePayload, {
        id: String(templateComposeAsset.id || `template-doc-${Date.now()}`),
        brandStyle: (generatedNote as any)?.style,
      });
    }
    return null;
  } catch (error) {
    console.error('Failed to resolve template compose document from cached note:', error);
    return null;
  }
};

const safeResolveVisualProjectResult = (visualProject: any) => {
  try {
    return visualProject ? getVisualProjectPrimaryResult(visualProject) : null;
  } catch (error) {
    console.error('Failed to resolve visual project result from cached note:', error);
    return null;
  }
};

const AnalyticsView: React.FC = () => {
  const { analysisResult, rewriteSession, selectedBenchmarkNote } = useScraperContext();
  const categorySummary = Object.entries(analysisResult?.categorySummary || {});
  const benchmarkNotesCount = analysisResult?.benchmarkNotes?.length || 0;
  const nextCollectionTaskCount = analysisResult?.nextCollectionTasks?.length || 0;
  const highRiskSentenceCount = rewriteSession?.high_risk_ai_sentences?.length || 0;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">内容产出概览</h2>
        <p className="text-slate-400 text-sm">分类、补采、仿写、去 AI 味结果都会先汇总到这里。</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-slate-500">已分析分类</p>
          <p className="text-3xl text-white font-bold mt-2">{categorySummary.length}</p>
        </div>
        <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-slate-500">可用对标</p>
          <p className="text-3xl text-white font-bold mt-2">{benchmarkNotesCount}</p>
        </div>
        <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-slate-500">补采任务</p>
          <p className="text-3xl text-white font-bold mt-2">{nextCollectionTaskCount}</p>
        </div>
        <div className="bg-xhs-card border border-white/5 rounded-2xl p-5">
          <p className="text-xs text-slate-500">仿写会话</p>
          <p className="text-3xl text-white font-bold mt-2">{rewriteSession ? 1 : 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-xhs-card border border-white/5 rounded-3xl p-6">
          <h3 className="text-xl font-bold text-white mb-4">分类健康度</h3>
          <div className="space-y-3">
            {categorySummary.length > 0 ? categorySummary.map(([category, summary]) => (
              <div key={category} className="rounded-2xl bg-black/20 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-white font-medium">{category}</span>
                  <span className="text-sm text-slate-400">{summary.benchmark_sufficiency}</span>
                </div>
                <p className="text-sm text-slate-300 mt-2">样本 {summary.note_count} / 强推荐 {summary.strong_recommend_count}</p>
                <p className="text-xs text-slate-500 mt-2">{summary.sufficiency_reason}</p>
              </div>
            )) : <div className="text-slate-400 text-sm">还没有完成新一轮采集分析。</div>}
          </div>
        </div>

        <div className="bg-xhs-card border border-white/5 rounded-3xl p-6">
          <h3 className="text-xl font-bold text-white mb-4">当前创作状态</h3>
          <div className="space-y-4">
            <div className="rounded-2xl bg-black/20 p-4">
              <p className="text-xs text-slate-500">选中对标</p>
              <p className="text-white mt-2">{selectedBenchmarkNote?.title || '未选中'}</p>
            </div>
            <div className="rounded-2xl bg-black/20 p-4">
              <p className="text-xs text-slate-500">去 AI 味总结</p>
              <p className="text-slate-300 mt-2">{rewriteSession?.de_ai_report?.summary || '尚未生成仿写会话'}</p>
            </div>
            <div className="rounded-2xl bg-black/20 p-4">
              <p className="text-xs text-slate-500">高风险 AI 句</p>
              <p className="text-slate-300 mt-2">{highRiskSentenceCount} 条</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const AppShell: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewState>('HOME');
  const [isLoginDialogOpen, setIsLoginDialogOpen] = useState(false);
  const [creationMode, setCreationMode] = useState<CreationMode>('scraper');
  const [interviewData, setInterviewData] = useState<InterviewData | null>(null);
  const [generatedContent, setGeneratedContent] = useState<GeneratedContent | null>(null);
  const [scraperPrefill, setScraperPrefill] = useState<InterviewData | null>(null);
  const [isTemplateEditorOpen, setIsTemplateEditorOpen] = useState(false);
  const [release, setRelease] = useState<ExtensionReleaseManifest | null>(null);
  const downloadUrl = release?.downloadUrl || '/downloads/crx-extension-0.0.0.zip';

  useEffect(() => {
    window.sessionStorage.removeItem('xhs_chunk_reload_attempted');
  }, []);

  const layout = useResponsiveLayout();
  const { extension } = useExtension();
  const { user, isLoading, logout } = useAuth();
  const { referenceAssets } = useScraperContext();
  const { generatedNote, updateTemplateComposeDraft, saveTemplateComposeDraft, applyTemplateComposeDraft, saveVisualProjectDraft, applyVisualProjectDraft } = useNote();
  const visualProject = generatedNote?.visualProject || null;
  const templateComposeAsset = useMemo(
    () => (generatedNote?.assets || []).find((asset) => isTemplateComposeAsset(asset)) || null,
    [generatedNote?.assets]
  );
  const resolvedTemplateComposeResult = useMemo(() => (
    safeResolveTemplateComposeResult({ generatedNote, templateComposeAsset })
  ), [generatedNote, templateComposeAsset]);
  const resolvedTemplateComposeDocument = useMemo(() => (
    safeResolveTemplateComposeDocument({
      generatedNote,
      templateComposeAsset,
      resolvedTemplateComposeResult,
      visualProject,
    })
  ), [generatedNote, resolvedTemplateComposeResult, templateComposeAsset, visualProject]);
  const resolvedVisualProjectResult = useMemo(() => (
    safeResolveVisualProjectResult(visualProject)
  ), [visualProject]);

  React.useEffect(() => {
    fetch('/api/release-manifest')
      .then((response) => response.json())
      .then((data) => setRelease(data))
      .catch(() => undefined);
  }, []);

  const handleDownloadExtension = React.useCallback(() => {
    const fileName = downloadUrl.split('/').pop() || 'extension.zip';
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [downloadUrl]);

  React.useEffect(() => {
    if (generatedNote?.visualModeResolved === 'template_compose' && (visualProject || resolvedTemplateComposeDocument) && generatedNote.templateDraftStatus === 'draft') {
      setIsTemplateEditorOpen(true);
      setActiveView('STUDIO');
    }
  }, [generatedNote?.templateDraftStatus, generatedNote?.visualModeResolved, resolvedTemplateComposeDocument, visualProject]);

  const extensionVersionMismatch = React.useMemo(() => {
    if (!extension?.version || !release?.minSupportedVersion) return false;
    if (extension.name === 'browser-client-monorepo') return false;
    return compareVersions(extension.version, release.minSupportedVersion) < 0;
  }, [extension?.version, release?.minSupportedVersion]);

  if (!layout) {
    return (
      <div className="flex h-screen w-full bg-xhs-surface items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-screen w-full bg-xhs-surface items-center justify-center">
        <div className="text-slate-300">正在恢复登录态...</div>
      </div>
    );
  }

  if (!user) {
    return <AuthGate />;
  }

  return (
    <LayoutContext.Provider value={layout}>
      <div className="flex h-screen w-full bg-xhs-surface text-slate-200" style={{ flexDirection: layout.showSidebarAsBottom ? 'column-reverse' : 'row' }}>
        <Sidebar activeView={activeView} onViewChange={setActiveView} />

        <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
          <div style={{ position: 'absolute', top: '20px', left: '20px', zIndex: 100, backgroundColor: extension ? '#10b981' : '#f59e0b', color: 'white', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold' }}>
            {extension ? '🔌 插件已连接' : '⚠️ 插件未连接'}
          </div>
          {extensionVersionMismatch ? (
            <div style={{ position: 'absolute', top: '54px', left: '20px', zIndex: 100, backgroundColor: '#ef4444', color: 'white', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 'bold' }}>
              插件版本过低，请下载 {release?.latestVersion || '最新版本'}
            </div>
          ) : null}

          <button
            onClick={() => setIsLoginDialogOpen(true)}
            style={{ position: 'absolute', top: '20px', right: '20px', zIndex: 100, backgroundColor: '#ff2442', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 20px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px rgba(255, 36, 66, 0.3)' }}
          >
            🔐 检测登录状态
          </button>

          <button
            onClick={handleDownloadExtension}
            style={{ position: 'absolute', top: '20px', right: '180px', zIndex: 100, backgroundColor: '#ffffff', color: '#111827', border: '1px solid rgba(15,23,42,0.08)', borderRadius: '8px', padding: '10px 18px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', boxShadow: '0 2px 8px rgba(15, 23, 42, 0.12)' }}
            title={release?.latestVersion ? `下载插件 ${release.latestVersion}` : '下载浏览器插件'}
          >
            下载插件
          </button>

          <div style={{ position: 'absolute', top: '68px', right: '20px', zIndex: 100, display: 'flex', gap: '8px', alignItems: 'center' }}>
            <div style={{ backgroundColor: 'rgba(15,23,42,0.9)', color: 'white', padding: '8px 12px', borderRadius: '8px', fontSize: '12px' }}>
              当前账号：{user.username}
            </div>
            <button
              onClick={logout}
              style={{ backgroundColor: 'rgba(255,255,255,0.12)', color: 'white', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px', cursor: 'pointer' }}
            >
              退出
            </button>
          </div>

          <div
            style={activeView === 'STUDIO'
              ? {
                  height: '100%',
                  minHeight: 0,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }
              : {
                  padding: '80px 24px 24px 24px',
                  overflowY: 'auto',
                  height: '100%',
                }}
          >
            <Suspense fallback={<ViewLoadingFallback />}>
              {activeView === 'HOME' && <HomeView onSelectMode={(nextMode) => setActiveView(nextMode === 'interview' ? 'INTERVIEW' : 'SCRAPER')} />}
              {activeView === 'INTERVIEW' && (
                <InterviewView
                  onComplete={(data, content) => {
                    setInterviewData(data);
                    setGeneratedContent(content);
                    setCreationMode('interview');
                    setActiveView('CREATION');
                  }}
                  onCancel={() => setActiveView('HOME')}
                />
              )}
              {activeView === 'SCRAPER' && (
                <ScraperView
                  onEnterStudio={(prefill) => {
                    setCreationMode('scraper');
                    setInterviewData(null);
                    setGeneratedContent(null);
                    setScraperPrefill(prefill || null);
                    setActiveView('CREATION');
                  }}
                />
              )}
              {activeView === 'CREATION' && (
                <CreationView
                  mode={creationMode}
                  interviewData={(creationMode === 'scraper' ? scraperPrefill : interviewData) || undefined}
                  generatedContent={generatedContent || undefined}
                  onEnterStudio={() => setActiveView('STUDIO')}
                />
              )}
              {activeView === 'STUDIO' && (
                <StudioView
                  onRestoreWorkspace={(workspace) => setActiveView(workspace)}
                  onContinueTemplateEdit={() => {
                    if (visualProject) {
                      saveVisualProjectDraft({ project: visualProject });
                    } else if (resolvedTemplateComposeDocument && resolvedTemplateComposeResult) {
                      updateTemplateComposeDraft(
                        resolvedTemplateComposeDocument,
                        generatedNote?.templateDraftStatus || 'applied',
                        resolvedTemplateComposeResult
                      );
                    }
                    setIsTemplateEditorOpen(true);
                  }}
                />
              )}
              {activeView === 'ANALYTICS' && <AnalyticsView />}
            </Suspense>
          </div>
        </main>
      </div>

      <LoginDialog isOpen={isLoginDialogOpen} onClose={() => setIsLoginDialogOpen(false)} onLoginSuccess={() => undefined} />
      <Suspense fallback={null}>
        {visualProject ? (
          <TemplateComposeSeriesEditorOverlay
            isOpen={isTemplateEditorOpen}
            project={visualProject}
            referenceAssets={referenceAssets}
            onClose={() => setIsTemplateEditorOpen(false)}
            onDraftChange={({ project }) => {
              saveVisualProjectDraft({ project });
            }}
            onApply={({ project }) => {
              applyVisualProjectDraft({ project });
              setIsTemplateEditorOpen(false);
              setActiveView('STUDIO');
            }}
          />
        ) : (
          <TemplateComposeEditorOverlay
            isOpen={isTemplateEditorOpen}
            document={resolvedTemplateComposeDocument}
            referenceAssets={referenceAssets}
            composeResult={resolvedVisualProjectResult || resolvedTemplateComposeResult}
            onClose={() => setIsTemplateEditorOpen(false)}
            onSaveDraftClose={({ document, result, asset }) => {
              saveTemplateComposeDraft({ draft: document, result, asset });
              setIsTemplateEditorOpen(false);
              setActiveView('STUDIO');
            }}
            onDraftChange={({ document, result }) => {
              updateTemplateComposeDraft(document, 'draft', result);
            }}
            onApply={({ document, result, asset }) => {
              applyTemplateComposeDraft({ draft: document, result, asset });
              setIsTemplateEditorOpen(false);
              setActiveView('STUDIO');
            }}
          />
        )}
      </Suspense>
    </LayoutContext.Provider>
  );
};

const App: React.FC = () => (
  <AppErrorBoundary>
    <AuthProvider>
      <ScraperProvider>
        <NoteProvider>
          <PersistenceProvider>
            <AppShell />
          </PersistenceProvider>
        </NoteProvider>
      </ScraperProvider>
    </AuthProvider>
  </AppErrorBoundary>
);

export default App;
