import React, { useState, useEffect, useRef } from 'react';
import { GeneratedContent, InterviewData, ProductProfile } from '../types';
import { usePersistence } from '../contexts/PersistenceContext';
import { useOptionalScraperContext } from '../contexts/ScraperContext';
import apiClient, { isAuthRequiredError, normalizeAppErrorMessage } from '../services/apiClient';

interface InterviewViewProps {
  onComplete: (data: InterviewData, content: GeneratedContent) => void;
  onCancel: () => void;
}

const InterviewView: React.FC<InterviewViewProps> = ({ onComplete, onCancel }) => {
  const { interviewState, setInterviewState, clearState } = usePersistence();
  const scraperContext = useOptionalScraperContext();
  const latestProductBrief = scraperContext?.latestProductBrief || null;
  const [productProfile, setProductProfile] = useState<ProductProfile | null>(null);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const titleSelectionInFlightRef = useRef(false);
  const hasLoadedRemoteSessionRef = useRef(false);
  const lastSavedUISnapshotRef = useRef('');

  const {
    sessionId,
    steps,
    messages,
    isTyping,
    collectedInfo,
    currentMessage,
    titleOptions,
    selectedTitleId,
    finalResult,
    selectedOptions,
    showCustomInput,
    customInputValue,
    showTitleFeedback,
    titleFeedback,
    showContentFeedback,
    contentFeedback
  } = interviewState;

  const [isInfoExpanded, setIsInfoExpanded] = useState(true);
  const [isContentExpanded, setIsContentExpanded] = useState(false);
  const [isTitleSubmitting, setIsTitleSubmitting] = useState(false);

  const resolvedProductBrief = productProfile?.product_brief || latestProductBrief || null;
  const hasProductContext = Boolean(
    resolvedProductBrief?.product_name?.trim()
    || resolvedProductBrief?.target_audience?.trim()
    || resolvedProductBrief?.product_features?.trim()
  );
  const researchContext = productProfile?.research_context || null;
  const sourceDocuments = Array.isArray(researchContext?.source_documents) ? researchContext.source_documents : [];
  const fetchedSourceCount = sourceDocuments.filter((item: any) => (
    item?.status === 'fetched' || item?.status === 'search_result'
  )).length;
  const hasParsedWebContext = Boolean(researchContext?.summary || fetchedSourceCount > 0);

  useEffect(() => {
    void initializeInterview();
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  useEffect(() => {
    if (!sessionId || !hasLoadedRemoteSessionRef.current) {
      return;
    }
    const snapshot = JSON.stringify(interviewState);
    if (snapshot === lastSavedUISnapshotRef.current) {
      return;
    }
    lastSavedUISnapshotRef.current = snapshot;
    const timer = window.setTimeout(() => {
      apiClient.saveInterviewUISnapshot(sessionId, interviewState).catch((error) => {
        if (getHttpStatus(error) !== 404) {
          console.error('保存访谈界面快照失败:', error);
        }
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [interviewState, sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (showCustomInput && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [showCustomInput]);

  useEffect(() => {
    let cancelled = false;

    const loadProductProfile = async () => {
      if (typeof apiClient.getCurrentProductProfile !== 'function') {
        return;
      }
      try {
        const response = await apiClient.getCurrentProductProfile();
        if (!cancelled && response?.success) {
          setProductProfile(response.data || null);
        }
      } catch (error) {
        console.error('加载访谈产品上下文失败:', error);
      }
    };

    void loadProductProfile();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateState = (updates: Partial<typeof interviewState>) => {
    setInterviewState((prev: any) => ({ ...prev, ...updates }));
  };

  const getHttpStatus = (error: unknown) => {
    if (!error || typeof error !== 'object' || !('response' in error)) {
      return null;
    }
    const response = (error as any).response;
    return typeof response?.status === 'number' ? response.status : null;
  };

  const isTimeoutError = (error: unknown) => (
    Boolean(error && typeof error === 'object' && 'code' in error && (error as any).code === 'ECONNABORTED')
  );

  const getStartErrorMessage = (error: unknown) => {
    if (isAuthRequiredError(error)) {
      return error.message || '登录态已失效，请重新登录后继续访谈。';
    }
    return normalizeAppErrorMessage(error, '启动访谈失败，请重试。', {
      timeoutMessage: '访谈模型响应超时，请稍后重试。',
      networkErrorMessage: '访谈服务暂时不可用，请检查网络后重试。',
    });
  };

  const getSendErrorMessage = (error: unknown) => {
    if (isAuthRequiredError(error)) {
      return error.message || '登录态已失效，请重新登录后继续访谈。';
    }
    if (getHttpStatus(error) === 502) {
      return '正文生成暂时失败了，请稍后重试。';
    }
    return normalizeAppErrorMessage(error, '这一轮消息发送失败了，请重试。', {
      timeoutMessage: '这一轮访谈响应超时了，请再发一次，我会继续从当前上下文接着聊。',
      networkErrorMessage: '访谈服务暂时不可用，请检查网络后重试。',
    });
  };

  const resetTitleSubmitting = () => {
    titleSelectionInFlightRef.current = false;
    setIsTitleSubmitting(false);
  };

  const initializeInterview = async () => {
    if (messages.length > 0) {
      hasLoadedRemoteSessionRef.current = true;
      return;
    }

    try {
      const response = await apiClient.getCurrentInterviewSession();
      const remoteState = response?.data?.ui_snapshot;
      if (remoteState && Array.isArray(remoteState.messages) && remoteState.messages.length > 0) {
        setInterviewState((prev: any) => ({ ...prev, ...remoteState, isTyping: false }));
        lastSavedUISnapshotRef.current = JSON.stringify({ ...remoteState, isTyping: false });
        hasLoadedRemoteSessionRef.current = true;
        return;
      }
    } catch (error) {
      if (!isAuthRequiredError(error)) {
        console.error('恢复访谈会话失败:', error);
      }
    }

    hasLoadedRemoteSessionRef.current = true;
    void startInterview();
  };

  const startInterview = async () => {
    resetTitleSubmitting();
    updateState({ isTyping: true });
    try {
      const data = await apiClient.startInterview(latestProductBrief);

      const updates: any = {
        sessionId: data.session_id,
        isTyping: false
      };

      if (data.message) {
        const aiMessage: any = {
          id: Date.now().toString(),
          role: 'assistant',
          content: data.message.content,
          timestamp: new Date().toISOString(),
        };
        updates.messages = [aiMessage];
        updates.currentMessage = data.message;
      }

      if (data.steps) {
        updates.steps = data.steps;
      }

      if (data.collected_info) {
        updates.collectedInfo = data.collected_info;
      }

      updateState(updates);
    } catch (error) {
      console.error('启动访谈失败:', error);
      updateState({
        isTyping: false,
        messages: [{
          id: Date.now().toString(),
          role: 'assistant',
          content: getStartErrorMessage(error),
          timestamp: new Date().toISOString(),
        }],
      });
    }
  };

  const handleSendMessage = async (message: string) => {
    const userMessage: any = {
      id: Date.now().toString(),
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };

    updateState({
      messages: [...messages, userMessage],
      isTyping: true,
      currentMessage: null,
      selectedOptions: [],
      showCustomInput: false,
      customInputValue: '',
      showTitleFeedback: false,
      titleFeedback: '',
      showContentFeedback: false,
      contentFeedback: ''
    });

    setInputValue('');

    try {
      const data = await apiClient.sendInterviewMessage(sessionId, message);

      const updates: any = { isTyping: false };

      if (data.message) {
        const aiMessage: any = {
          id: Date.now().toString(),
          role: 'assistant',
          content: data.message.content,
          timestamp: new Date().toISOString(),
        };
        updates.messages = [...messages, userMessage, aiMessage];
        updates.currentMessage = data.message;
      }

      if (data.steps) updates.steps = data.steps;
      if (data.collected_info) updates.collectedInfo = data.collected_info;
      if (data.action === 'show_titles' && data.title_options) {
        updates.titleOptions = data.title_options;
      }
      if (data.action === 'complete' && data.result) {
        updates.finalResult = data.result;
      }

      updateState(updates);
    } catch (error) {
      console.error('发送消息失败:', error);
      if (getHttpStatus(error) === 404) {
        const failedMessage: any = {
          id: `${Date.now()}-expired`,
          role: 'assistant',
          content: '服务器刚重启或会话已过期，我保留了当前访谈记录。你可以重新开始访谈，或先复制这里已经生成/收集的内容。',
          timestamp: new Date().toISOString(),
        };
        updateState({
          isTyping: false,
          messages: [...messages, userMessage, failedMessage],
        });
        return;
      }

      const failedMessage: any = {
        id: `${Date.now()}-error`,
        role: 'assistant',
        content: isTimeoutError(error) ? '这一轮访谈响应超时了，请再发一次，我会继续从当前上下文接着聊。' : getSendErrorMessage(error),
        timestamp: new Date().toISOString(),
      };
      updateState({
        isTyping: false,
        messages: [...messages, userMessage, failedMessage],
      });
    }
  };

  const handleSend = async () => {
    if (!inputValue.trim()) return;
    await handleSendMessage(inputValue);
  };

  const handleOptionClick = (option: string) => {
    const otherKeywords = ['其他', '其它', '自定义', '以上都不是'];
    const isOther = otherKeywords.some(keyword => option.includes(keyword));
    
    if (isOther) {
      updateState({ showCustomInput: true });
      return;
    }

    if (currentMessage?.type === 'multiple_choice') {
      const newSelected = selectedOptions.includes(option)
        ? selectedOptions.filter(o => o !== option)
        : [...selectedOptions, option];
      updateState({ selectedOptions: newSelected });
    } else {
      handleSendMessage(option);
    }
  };

  const handleConfirmMultipleChoice = () => {
    if (selectedOptions.length > 0) {
      handleSendMessage(selectedOptions.join(', '));
    }
  };

  const handleCustomInputSubmit = () => {
    if (customInputValue.trim()) {
      handleSendMessage(customInputValue);
    }
  };

  const handleTitleSelect = async (titleId: number) => {
    if (titleId === -1) {
      updateState({ showTitleFeedback: true });
      return;
    }

    if (titleSelectionInFlightRef.current || isTyping) {
      return;
    }

    titleSelectionInFlightRef.current = true;
    setIsTitleSubmitting(true);
    updateState({ selectedTitleId: titleId });
    const selectedTitle = titleOptions.find((t: any) => t.id === titleId);
    if (selectedTitle) {
      try {
        await handleSendMessage(`[选择标题] ${selectedTitle.title}`);
      } finally {
        resetTitleSubmitting();
      }
      return;
    }
    resetTitleSubmitting();
  };

  const handleTitleFeedbackSubmit = () => {
    if (titleFeedback.trim()) {
      handleSendMessage(`[重新生成标题] ${titleFeedback}`);
      updateState({
        titleFeedback: '',
        showTitleFeedback: false,
        titleOptions: [],
        selectedTitleId: null
      });
    }
  };

  const handleContentFeedbackSubmit = () => {
    if (contentFeedback.trim()) {
      handleSendMessage(`[重新生成正文] ${contentFeedback}`);
      updateState({
        contentFeedback: '',
        showContentFeedback: false
      });
    }
  };

  const handleConfirmResult = () => {
    if (finalResult) {
      onComplete(
        {
          productName: finalResult.collected_info?.product_name || '',
          coreFeatures: finalResult.collected_info?.core_features || '',
          targetAudience: finalResult.collected_info?.target_audience || '',
          styleDirection: finalResult.collected_info?.style_preference || ''
        },
        {
          title: finalResult.title,
          content: finalResult.content,
          rewriteSession: finalResult.rewrite_session || null,
          noteStrategy: finalResult.note_strategy || null,
          tags: finalResult.tags || []
        }
      );
    }
  };

  const handleRestart = () => {
    if (confirm('确定要重新开始访谈吗？当前进度将丢失。')) {
      clearState();
      setInputValue('');
      startInterview();
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-80 bg-gradient-to-b from-xhs-panel/95 via-xhs-panel to-xhs-panel/95 border-r border-white/10 p-8 relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(to_bottom,#ffffff02_1px,transparent_1px)] bg-[size:100%_2rem] pointer-events-none"></div>

        <div className="relative z-10">
          <div className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-white">AI 创作访谈</h2>
              <span className="px-2 py-0.5 bg-gradient-to-r from-red-500/20 to-pink-500/20 text-red-400 text-xs rounded font-bold border border-red-500/30 backdrop-blur-sm">AI-NATIVE</span>
            </div>
            <button onClick={handleRestart} className="text-xs text-slate-400 hover:text-white transition-colors" title="重新开始">🔄</button>
          </div>

          <div className="relative">
            <div className="absolute left-6 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-white/20 to-transparent"></div>

            {steps.map((step: any, index: number) => (
              <div key={step.id} className="relative pl-16 pb-10 last:pb-0">
                <div className={`absolute left-0 w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-500 ${
                  step.status === 'active'
                    ? 'bg-gradient-to-br from-red-500 to-pink-500 shadow-2xl shadow-red-500/50 scale-110'
                    : step.status === 'completed'
                      ? 'bg-gradient-to-br from-green-500 to-emerald-500 shadow-2xl shadow-green-500/50'
                      : 'bg-white/10 backdrop-blur-xl border border-white/20'
                }`}>
                  {step.status === 'active' && (
                    <div className="absolute inset-0 rounded-2xl bg-red-500/50 animate-ping"></div>
                  )}
                  <span className="relative z-10 font-bold text-sm">
                    {step.status === 'completed' ? '✓' : index + 1}
                  </span>
                </div>

                <div className={`bg-gradient-to-br backdrop-blur-xl rounded-2xl p-4 border transition-all duration-500 ${
                  step.status === 'active'
                    ? 'from-red-500/20 to-pink-500/20 border-red-500/50 shadow-2xl shadow-red-500/20'
                    : step.status === 'completed'
                      ? 'from-green-500/10 to-emerald-500/10 border-green-500/30'
                      : 'from-white/5 to-white/10 border-white/10 hover:border-white/30'
                }`}>
                  <div className="font-bold text-white text-sm">{step.label}</div>
                  <div className="text-xs text-slate-400 mt-1">
                    {step.status === 'active' ? '进行中...' : step.status === 'completed' ? '已完成' : '待填写'}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 p-4 bg-gradient-to-br from-blue-500/10 to-purple-500/10 border border-blue-500/30 rounded-2xl backdrop-blur-sm shadow-lg relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-400/5 via-transparent to-purple-400/5"></div>
            <div className="relative flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500/30 to-purple-500/30 backdrop-blur-sm flex items-center justify-center flex-shrink-0 border border-blue-400/30">
                <span className="text-blue-400 text-lg">🤖</span>
              </div>
              <div className="text-xs text-slate-300">
                <div className="font-bold mb-1">AI 智能访谈</div>
                <div>优先点击选项，减少打字。多选题可选多个后确认。</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff02_1px,transparent_1px),linear-gradient(to_bottom,#ffffff02_1px,transparent_1px)] bg-[size:2rem_2rem] pointer-events-none"></div>

        <div className="relative border-b border-white/10 px-8 py-4 backdrop-blur-sm">
          <div className="text-slate-400 text-sm mb-2">
            AI自主提问，智能挖掘产品亮点，量身定制品牌调性。
          </div>

          <div className={`mt-3 rounded-xl border p-3 backdrop-blur-sm ${
            hasProductContext
              ? 'border-emerald-500/30 bg-emerald-500/10'
              : 'border-amber-500/30 bg-amber-500/10'
          }`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-white">
                  <span>{hasProductContext ? 'AI 已加载产品信息' : 'AI 暂未读取到产品信息'}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    hasParsedWebContext
                      ? 'border-sky-400/30 bg-sky-400/10 text-sky-200'
                      : 'border-white/10 bg-white/5 text-slate-300'
                  }`}>
                    {hasParsedWebContext ? `网页资料已解析${fetchedSourceCount ? ` · ${fetchedSourceCount} 个来源` : ''}` : '网页资料未解析'}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-300">
                  {hasProductContext
                    ? [
                        resolvedProductBrief?.product_name || '',
                        resolvedProductBrief?.target_audience ? `面向：${resolvedProductBrief.target_audience}` : '',
                        resolvedProductBrief?.product_features ? `卖点：${resolvedProductBrief.product_features}` : '',
                      ].filter(Boolean).join(' · ')
                    : '进入访谈前可先在采集/创作页填写产品信息；已填写后 AI 会直接带着产品上下文提问。'}
                </div>
              </div>
              <div className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-bold ${
                hasProductContext ? 'bg-emerald-400/15 text-emerald-200' : 'bg-amber-400/15 text-amber-200'
              }`}>
                {hasProductContext ? '访谈会跳过产品介绍' : '可能需要补充产品'}
              </div>
            </div>
          </div>

          {Object.keys(collectedInfo).length > 0 && (
            <div className="mt-2 p-3 bg-gradient-to-br from-green-500/10 to-emerald-500/10 border border-green-500/30 rounded-xl backdrop-blur-sm">
              <div className="flex items-center justify-between mb-2 cursor-pointer" onClick={() => setIsInfoExpanded(!isInfoExpanded)}>
                <div className="font-bold text-white text-xs flex items-center gap-2">
                  <span>📊 已收集信息</span>
                  <span className="text-green-400">({Object.keys(collectedInfo).filter((k: string) => collectedInfo[k]).length})</span>
                </div>
                <button className="text-xs text-slate-400 hover:text-white transition-colors">
                  {isInfoExpanded ? '▼' : '▶'}
                </button>
              </div>
              {isInfoExpanded && (
                <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
                  {Object.entries(collectedInfo).map(([key, value]) => (
                    value && (
                      <div key={key} className="flex gap-2">
                        <span className="text-slate-500">•</span>
                        <span className="truncate" title={value as string}>{value as string}</span>
                      </div>
                    )
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="relative flex-1 overflow-y-auto p-8 space-y-6" style={{ minHeight: 0 }}>
          {messages.map((msg: any) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role === 'assistant' ? (
                <div className="group/msg relative max-w-2xl">
                  <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-3xl blur-xl transform translate-y-1"></div>
                  <div className="relative bg-gradient-to-br from-white/15 to-white/5 backdrop-blur-2xl rounded-3xl p-5 border border-white/20 shadow-2xl">
                    <p className="relative z-10 text-slate-200 leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ) : (
                <div className="group/msg relative max-w-2xl">
                  <div className="absolute inset-0 bg-gradient-to-br from-red-500/50 to-pink-500/50 rounded-3xl blur-xl transform translate-y-1"></div>
                  <div className="relative bg-gradient-to-br from-red-500 via-pink-500 to-red-600 rounded-3xl p-5 shadow-2xl">
                    <p className="relative z-10 text-white font-medium leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              )}
            </div>
          ))}

          {currentMessage && (currentMessage.type === 'single_choice' || currentMessage.type === 'multiple_choice') && currentMessage.options && !showCustomInput && (
            <div className="flex justify-start">
              <div className="max-w-2xl space-y-3">
                {currentMessage.reason && (
                  <div className="text-xs text-slate-400 mb-2">💡 {currentMessage.reason}</div>
                )}
                {currentMessage.type === 'multiple_choice' && (
                  <div className="text-xs text-purple-400 mb-2">✨ 多选题：可选择多个选项后点击"确认选择"</div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  {currentMessage.options.map((option: string, index: number) => {
                    const isSelected = selectedOptions.includes(option);
                    const otherKeywords = ['其他', '其它', '自定义', '以上都不是'];
                    const isOther = otherKeywords.some(keyword => option.includes(keyword));

                    return (
                      <button
                        key={index}
                        onClick={() => handleOptionClick(option)}
                        disabled={isTyping}
                        className={`group relative overflow-hidden rounded-2xl transition-all hover:scale-105 active:scale-95 ${isSelected ? 'ring-2 ring-purple-500' : ''}`}
                      >
                        <div className={`absolute inset-0 transition-all ${
                          isSelected
                            ? 'bg-gradient-to-r from-purple-500/40 via-pink-500/40 to-red-500/40'
                            : 'bg-gradient-to-r from-purple-500/20 via-pink-500/20 to-red-500/20 group-hover:from-purple-500/30 group-hover:via-pink-500/30 group-hover:to-red-500/30'
                        }`}></div>
                        <div className="relative px-6 py-4 bg-white/5 backdrop-blur-xl border border-white/20 group-hover:border-white/40 rounded-2xl flex items-center gap-2">
                          {currentMessage.type === 'multiple_choice' && (
                            <span className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${isSelected ? 'border-purple-400 bg-purple-500' : 'border-white/40'}`}>
                              {isSelected && <span className="text-white text-xs">✓</span>}
                            </span>
                          )}
                          <span className="text-white font-medium flex-1">{option}</span>
                          {isOther && <span className="text-xs text-slate-400">✏️</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {currentMessage.type === 'multiple_choice' && selectedOptions.length > 0 && (
                  <button
                    onClick={handleConfirmMultipleChoice}
                    disabled={isTyping}
                    className="w-full group relative overflow-hidden rounded-2xl transition-all hover:scale-105 active:scale-95 mt-4"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 bg-[length:200%_100%] group-hover:bg-[position:100%_0] transition-all duration-500"></div>
                    <div className="relative px-6 py-3 text-white font-bold text-center">
                      确认选择 (已选 {selectedOptions.length} 项) ✨
                    </div>
                  </button>
                )}
              </div>
            </div>
          )}

          {showCustomInput && (
            <div className="flex justify-start">
              <div className="max-w-2xl w-full space-y-3">
                <div className="text-sm text-purple-400 mb-2">✏️ 请输入您的自定义内容：</div>
                <div className="relative">
                  <input
                    ref={customInputRef}
                    type="text"
                    value={customInputValue}
                    onChange={(e) => updateState({ customInputValue: e.target.value })}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCustomInputSubmit();
                      } else if (e.key === 'Escape') {
                        updateState({ showCustomInput: false, customInputValue: '' });
                      }
                    }}
                    placeholder="请输入..."
                    className="w-full px-6 py-4 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl text-white placeholder:text-slate-500 outline-none focus:border-purple-500 transition-all"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleCustomInputSubmit}
                    disabled={!customInputValue.trim()}
                    className={`flex-1 group relative overflow-hidden rounded-2xl transition-all ${customInputValue.trim() ? 'opacity-100' : 'opacity-50 cursor-not-allowed'}`}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 bg-[length:200%_100%] group-hover:bg-[position:100%_0] transition-all duration-500"></div>
                    <div className="relative px-6 py-3 text-white font-bold text-center">确认 ✓</div>
                  </button>
                  <button
                    onClick={() => updateState({ showCustomInput: false, customInputValue: '' })}
                    className="px-6 py-3 bg-white/5 hover:bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 hover:border-white/40 text-white font-medium transition-all"
                  >
                    取消
                  </button>
                </div>
                <div className="text-xs text-slate-500 text-center">Enter 确认 · Esc 取消</div>
              </div>
            </div>
          )}

          {titleOptions.length > 0 && !finalResult && !showTitleFeedback && (
            <div className="flex justify-start">
              <div className="max-w-3xl space-y-4">
                <div className="text-lg font-bold text-white mb-4">📝 请选择您最喜欢的标题：</div>
                {titleOptions.map((option: any) => (
                    <button
                      key={option.id}
                      onClick={() => handleTitleSelect(option.id)}
                      disabled={isTyping || isTitleSubmitting}
                      className={`group relative overflow-hidden rounded-2xl transition-all hover:scale-102 active:scale-98 w-full text-left ${(selectedTitleId === option.id) ? 'ring-2 ring-red-500' : ''} ${(isTyping || isTitleSubmitting) ? 'opacity-80 cursor-not-allowed' : ''}`}
                    >
                    <div className="absolute inset-0 bg-gradient-to-r from-purple-500/20 via-pink-500/20 to-red-500/20 group-hover:from-purple-500/30 group-hover:via-pink-500/30 group-hover:to-red-500/30 transition-all"></div>
                    <div className="relative px-6 py-4 bg-white/5 backdrop-blur-xl border border-white/20 group-hover:border-white/40 rounded-2xl">
                      <div className="flex items-start gap-3">
                        <span className="text-2xl">{option.id === 1 ? '⭐' : option.id}</span>
                        <div className="flex-1">
                          <div className="text-white font-bold mb-1">{option.title}</div>
                          <div className="text-xs text-slate-400">
                            <span className="text-purple-400">{option.style}</span> · {option.rationale}
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
                <button
                  onClick={() => handleTitleSelect(-1)}
                  disabled={isTyping || isTitleSubmitting}
                  className={`group relative overflow-hidden rounded-2xl transition-all hover:scale-102 active:scale-98 w-full text-left ${(isTyping || isTitleSubmitting) ? 'opacity-80 cursor-not-allowed' : ''}`}
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-orange-500/20 via-yellow-500/20 to-orange-500/20 group-hover:from-orange-500/30 group-hover:via-yellow-500/30 group-hover:to-orange-500/30 transition-all"></div>
                  <div className="relative px-6 py-4 bg-white/5 backdrop-blur-xl border border-white/20 group-hover:border-orange-400/40 rounded-2xl">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">💭</span>
                      <div className="flex-1">
                        <div className="text-white font-bold mb-1">以上都不喜欢，我想重新生成</div>
                        <div className="text-xs text-slate-400">告诉我您的想法，我会为您重新生成更合适的标题</div>
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {showTitleFeedback && (
            <div className="flex justify-start">
              <div className="max-w-2xl w-full space-y-3">
                <div className="text-sm text-orange-400 mb-2">💭 请告诉我您的想法：</div>
                <textarea
                  value={titleFeedback}
                  onChange={(e) => updateState({ titleFeedback: e.target.value })}
                  placeholder="为什么不喜欢？想要什么样的标题？"
                  className="w-full px-6 py-4 bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl text-white placeholder:text-slate-500 outline-none focus:border-orange-500 transition-all resize-none"
                  rows={4}
                />
                <div className="flex gap-3">
                  <button
                    onClick={handleTitleFeedbackSubmit}
                    disabled={!titleFeedback.trim() || isTyping}
                    className={`flex-1 group relative overflow-hidden rounded-2xl transition-all ${titleFeedback.trim() && !isTyping ? 'opacity-100' : 'opacity-50 cursor-not-allowed'}`}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-orange-500 via-yellow-500 to-orange-500 bg-[length:200%_100%] group-hover:bg-[position:100%_0] transition-all duration-500"></div>
                    <div className="relative px-6 py-3 text-white font-bold text-center">重新生成标题 ✨</div>
                  </button>
                  <button
                    onClick={() => updateState({ showTitleFeedback: false, titleFeedback: '' })}
                    disabled={isTyping}
                    className="px-6 py-3 bg-white/5 hover:bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 hover:border-white/40 text-white font-medium transition-all"
                  >
                    返回
                  </button>
                </div>
              </div>
            </div>
          )}

          {finalResult && (
            <div className="flex justify-start">
              <div className="max-w-3xl space-y-6">
                <div className="text-2xl font-bold text-white mb-4">✨ 访谈完成！以下是为您生成的内容：</div>

                <div className="bg-gradient-to-br from-purple-500/20 to-pink-500/20 backdrop-blur-xl rounded-2xl p-6 border border-purple-500/30">
                  <div className="text-sm text-purple-400 mb-2">📝 标题</div>
                  <div className="text-xl font-bold text-white">{finalResult.title}</div>
                </div>

                <div className="bg-gradient-to-br from-blue-500/20 to-cyan-500/20 backdrop-blur-xl rounded-2xl p-6 border border-blue-500/30">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-sm text-blue-400">📄 正文预览</div>
                    <button
                      onClick={() => setIsContentExpanded(!isContentExpanded)}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      {isContentExpanded ? '收起' : '展开全文'}
                    </button>
                  </div>
                  <div className={`text-slate-200 leading-relaxed whitespace-pre-wrap ${isContentExpanded ? 'max-h-96' : 'max-h-60'} overflow-y-auto mb-3`}>
                    {isContentExpanded ? finalResult.content : `${finalResult.content.substring(0, 600)}...`}
                  </div>

                  {!showContentFeedback && (
                    <button
                      onClick={() => updateState({ showContentFeedback: true })}
                      className="w-full py-2 text-xs text-blue-300 hover:text-blue-200 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg border border-blue-500/20 transition-all flex items-center justify-center gap-1"
                    >
                      <span>✨</span> 对内容不满意？重新生成
                    </button>
                  )}

                  {showContentFeedback && (
                    <div className="mt-3 space-y-3 p-3 bg-black/20 rounded-xl border border-white/5">
                      <div className="text-xs text-blue-300">💭 请输入修改意见：</div>
                      <textarea
                        value={contentFeedback}
                        onChange={(e) => updateState({ contentFeedback: e.target.value })}
                        placeholder="例如：语气更活泼一点，多加点emoji..."
                        className="w-full px-3 py-2 bg-white/10 rounded-lg text-sm text-white placeholder:text-slate-500 outline-none focus:ring-1 focus:ring-blue-500 resize-none"
                        rows={3}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={handleContentFeedbackSubmit}
                          disabled={!contentFeedback.trim() || isTyping}
                          className="flex-1 py-1.5 bg-blue-500 hover:bg-blue-600 rounded-lg text-xs text-white font-bold transition-all disabled:opacity-50"
                        >
                          确认修改
                        </button>
                        <button
                          onClick={() => updateState({ showContentFeedback: false, contentFeedback: '' })}
                          className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs text-white transition-all"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex gap-4">
                  <button
                    onClick={handleConfirmResult}
                    className="flex-1 group relative overflow-hidden rounded-2xl transition-all hover:scale-105 active:scale-95"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-red-500 via-pink-500 to-red-500 bg-[length:200%_100%] group-hover:bg-[position:100%_0] transition-all duration-500"></div>
                    <div className="relative px-8 py-4 text-white font-bold text-center">
                      确认并进入创作 ✨
                    </div>
                  </button>

                  <button
                    onClick={handleRestart}
                    className="px-8 py-4 bg-white/5 hover:bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 hover:border-white/40 text-white font-medium transition-all"
                  >
                    重新访谈
                  </button>
                </div>
              </div>
            </div>
          )}

          {isTyping && (
            <div className="flex justify-start">
              <div className="group/msg relative max-w-2xl">
                <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-3xl blur-xl transform translate-y-1"></div>
                <div className="relative bg-gradient-to-br from-white/15 to-white/5 backdrop-blur-2xl rounded-3xl p-5 border border-white/20 shadow-2xl">
                  <div className="flex items-center gap-3">
                    <div className="flex gap-2">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="relative w-3 h-3" style={{ animationDelay: `${i * 0.15}s` }}>
                          <div className="absolute inset-0 bg-gradient-to-br from-blue-400 via-purple-400 to-pink-400 rounded-full animate-bounce"></div>
                          <div className="absolute inset-0 bg-gradient-to-br from-blue-400 via-purple-400 to-pink-400 rounded-full blur-md opacity-50 animate-pulse"></div>
                        </div>
                      ))}
                    </div>
                    <span className="text-slate-300 text-sm">AI正在思考...</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {!finalResult && (
          <div className="relative border-t border-white/10 p-6 bg-gradient-to-t from-xhs-panel/80 to-transparent backdrop-blur-sm">
            <div className="flex gap-4">
              <div className="relative flex-1 group/input">
                <div className="absolute -inset-0.5 bg-gradient-to-r from-purple-500 via-pink-500 to-red-500 rounded-2xl opacity-0 group-focus-within/input:opacity-100 blur transition-opacity duration-500"></div>
                <div className="relative bg-gradient-to-r from-white/10 to-white/5 backdrop-blur-2xl rounded-2xl border border-white/20 overflow-hidden">
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder={currentMessage?.type === 'text' ? "请输入您的回答..." : "或者输入自定义回答..."}
                    className="relative z-10 w-full px-6 py-4 bg-transparent text-white placeholder:text-slate-500 outline-none"
                    disabled={isTyping}
                  />
                </div>
              </div>

              <button
                onClick={handleSend}
                disabled={!inputValue.trim() || isTyping}
                className={`group/send relative overflow-hidden rounded-2xl transition-all ${inputValue.trim() && !isTyping ? 'opacity-100' : 'opacity-50 cursor-not-allowed'}`}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-red-500 via-pink-500 to-red-500 bg-[length:200%_100%] group-hover/send:bg-[position:100%_0] transition-all duration-500"></div>
                <div className="relative z-10 px-8 py-4 flex items-center gap-2 text-white font-bold">
                  发送 <span>✈️</span>
                </div>
              </button>

              {currentMessage?.type === 'text' && (
                <button
                  onClick={() => handleSendMessage('[跳过此问题]')}
                  disabled={isTyping}
                  className="px-6 py-4 bg-white/5 hover:bg-white/10 backdrop-blur-xl rounded-2xl border border-white/20 hover:border-white/40 text-white font-medium transition-all"
                >
                  跳过
                </button>
              )}
            </div>
            <div className="mt-2 text-xs text-slate-500 text-center">
              {currentMessage?.type === 'text' ? 'Shift + Enter 换行 · Enter 发送' : '点击选项快速回答，或输入自定义内容'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InterviewView;
