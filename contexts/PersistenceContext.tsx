import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  InterviewStep,
  ChatMessage,
  CollectedInfo,
  InterviewData,
  GeneratedContent,
  Asset,
  CreationMode,
  CreationState,
} from '../types';
import apiClient, { isAuthRequiredError, normalizeAppErrorMessage } from '../services/apiClient';

interface InterviewState {
  sessionId: string;
  steps: InterviewStep[];
  messages: ChatMessage[];
  collectedInfo: CollectedInfo;
  isTyping: boolean;
  currentMessage: any | null;
  selectedOptions: string[];
  showCustomInput: boolean;
  customInputValue: string;
  showTitleFeedback: boolean;
  titleFeedback: string;
  showContentFeedback: boolean;
  contentFeedback: string;
  finalResult: any;
  titleOptions: any[];
  selectedTitleId: number | null;
}

interface PersistenceContextType {
  interviewState: InterviewState;
  setInterviewState: React.Dispatch<React.SetStateAction<InterviewState>>;
  creationState: CreationState;
  setCreationState: React.Dispatch<React.SetStateAction<CreationState>>;
  exportCreationState: () => CreationState;
  restoreCreationState: (state: CreationState) => void;
  rotateDraftSessionKey: () => string;
  startGeneration: (params: {
    mode: CreationMode;
    interviewData?: InterviewData | null;
    generatedContent?: GeneratedContent | null;
    onComplete?: () => void;
  }) => Promise<void>;
  clearState: () => void;
}

const initialInterviewState: InterviewState = {
  sessionId: '',
  steps: [],
  messages: [],
  collectedInfo: {},
  isTyping: false,
  currentMessage: null,
  selectedOptions: [],
  showCustomInput: false,
  customInputValue: '',
  showTitleFeedback: false,
  titleFeedback: '',
  showContentFeedback: false,
  contentFeedback: '',
  finalResult: null,
  titleOptions: [],
  selectedTitleId: null,
};

const initialCreationState: CreationState = {
  productName: '',
  targetAudience: '',
  productFeatures: '',
  contentStyle: 'seed',
  visualStyle: '温暖渐变卡片',
  strategyMode: 'research_first',
  isGenerating: false,
  generationStep: 0,
  generationProgress: 0,
  generationMessage: '',
  prompts: [],
  promptCount: 0,
  localGeneratedContent: null,
  generatedTags: [],
  draftSessionKey: '',
};

const createDraftSessionKey = () => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
);

const PersistenceContext = createContext<PersistenceContextType | null>(null);

export const usePersistence = () => {
  const context = useContext(PersistenceContext);
  if (!context) {
    throw new Error('usePersistence must be used within a PersistenceProvider');
  }
  return context;
};

const cleanContent = (content: string, title: string) => {
  let cleaned = content.trim();
  const explicitTitlePattern = /^(标题[:：].*?)(\n|$)/i;
  cleaned = cleaned.replace(explicitTitlePattern, '').trim();
  if (title && cleaned.startsWith(title)) {
    cleaned = cleaned.substring(title.length).trim();
  }
  cleaned = cleaned.replace(/^正文[:：]\s*/i, '').trim();
  return cleaned;
};

const safeMerge = (initial: any, saved: any): any => {
  if (saved === undefined || saved === null) return initial;
  if (initial === null) return saved;
  if (Array.isArray(initial)) {
    return Array.isArray(saved) ? saved : initial;
  }
  if (typeof initial === 'object') {
    if (typeof saved !== 'object' || Array.isArray(saved)) return initial;
    const result: any = { ...initial };
    Object.keys(initial).forEach(key => {
      if (Object.prototype.hasOwnProperty.call(saved, key)) {
        result[key] = safeMerge(initial[key], saved[key]);
      }
    });
    return result;
  }
  return saved;
};

export const PersistenceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [interviewState, setInterviewState] = useState<InterviewState>(() => {
    try {
      const stored = localStorage.getItem('xhs_persistence_interview');
      if (!stored) return initialInterviewState;
      const parsed = JSON.parse(stored);
      return safeMerge(initialInterviewState, parsed);
    } catch (e) {
      console.error('Failed to load interview state', e);
      return initialInterviewState;
    }
  });

  const [creationState, setCreationState] = useState<CreationState>(() => {
    try {
      const stored = localStorage.getItem('xhs_persistence_creation');
      if (!stored) return { ...initialCreationState, draftSessionKey: createDraftSessionKey() };
      const parsed = JSON.parse(stored);
      const merged = safeMerge(initialCreationState, parsed);
      return {
        ...merged,
        draftSessionKey: typeof merged.draftSessionKey === 'string' && merged.draftSessionKey.trim()
          ? merged.draftSessionKey
          : createDraftSessionKey(),
      };
    } catch (e) {
      console.error('Failed to load creation state', e);
      return { ...initialCreationState, draftSessionKey: createDraftSessionKey() };
    }
  });

  useEffect(() => {
    localStorage.setItem('xhs_persistence_interview', JSON.stringify(interviewState));
  }, [interviewState]);

  useEffect(() => {
    localStorage.setItem('xhs_persistence_creation', JSON.stringify(creationState));
  }, [creationState]);

  const exportCreationState = useCallback(() => ({
    ...creationState,
  }), [creationState]);

  const restoreCreationState = useCallback((state: CreationState) => {
    setCreationState({
      ...initialCreationState,
      ...state,
      draftSessionKey: state?.draftSessionKey?.trim() ? state.draftSessionKey : createDraftSessionKey(),
    });
  }, []);

  const rotateDraftSessionKey = useCallback(() => {
    const nextKey = createDraftSessionKey();
    setCreationState((prev) => ({
      ...prev,
      draftSessionKey: nextKey,
    }));
    return nextKey;
  }, []);

  const pollTaskStatus = async (taskIds: string[]): Promise<Asset[]> => {
    const maxAttempts = 90;
    const assets: Asset[] = [];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const pollInterval = attempt < 30 ? 2000 : 5000;

      const allCompleted = await Promise.all(
        taskIds.map(async (taskId) => {
          try {
            const taskStatus = await apiClient.getVisualTaskStatus(taskId);
            return taskStatus;
          } catch (error) {
            if (isAuthRequiredError(error)) {
              throw error;
            }
            console.error(`获取任务 ${taskId} 状态失败:`, error);
            return null;
          }
        })
      );

      const completedTasks = allCompleted.filter(
        (task) => task && task.status === 'completed'
      );

      const failedTasks = allCompleted.filter(
        (task) => task && task.status === 'failed'
      );

      if (failedTasks.length > 0) {
        console.error('部分图片生成失败:', failedTasks);
        const errorMessages = failedTasks
          .map((task) => task.error)
          .filter(Boolean)
          .join('; ');
        throw new Error(`图片生成失败: ${errorMessages || '未知错误'}`);
      }

      if (completedTasks.length === taskIds.length) {
        completedTasks.forEach((task, index) => {
          if (task.result?.images && task.result.images.length > 0) {
            assets.push({
              id: String(index + 1),
              url: task.result.images[0],
              isProcessing: false,
            });
          }
        });
        break;
      }

      const progress = 70 + (completedTasks.length / taskIds.length) * 25;
      setCreationState(prev => ({
        ...prev,
        generationProgress: Math.round(progress),
        generationMessage: `正在生成图片... (${completedTasks.length}/${taskIds.length})`
      }));

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return assets;
  };

  const startGeneration = useCallback(async (params: {
    mode: CreationMode;
    interviewData?: InterviewData | null;
    generatedContent?: GeneratedContent | null;
    onComplete?: () => void;
  }) => {
    const { mode, interviewData, generatedContent, onComplete } = params;

    try {
      setCreationState(prev => ({ ...prev, isGenerating: true }));

      let generatedTitle: string;
      let generatedContentText: string;
      let generatedTags: string[] = [];

      const contentToUse = generatedContent || creationState.localGeneratedContent;

      if (mode === 'interview') {
        if (contentToUse) {
          console.log('[Persistence] 访谈模式: 使用访谈内容');
          generatedTitle = contentToUse.title;
          generatedContentText = cleanContent(contentToUse.content, contentToUse.title);
          generatedTags = [];

          setCreationState(prev => ({
            ...prev,
            generationStep: 2,
            generationProgress: 30,
            generationMessage: '正在分析视觉方案...',
            localGeneratedContent: {
              title: generatedTitle,
              content: generatedContentText
            }
          }));
        } else {
          throw new Error("访谈内容丢失，请重新进行访谈");
        }
      } else {
        setCreationState(prev => ({
          ...prev,
          generationStep: 1,
          generationProgress: 10,
          generationMessage: '正在生成创意文案...'
        }));

        const aiInsights = localStorage.getItem('latest_ai_insights') || '';

        const contentResult = await apiClient.generateContent({
          product_name: creationState.productName,
          target_audience: creationState.targetAudience,
          product_features: creationState.productFeatures,
          content_style: creationState.contentStyle,
          ai_insights: aiInsights,
        });

        if (!contentResult.success) {
          throw new Error(contentResult.message || '文案生成失败');
        }

        generatedTitle = contentResult.title || creationState.productName;
        generatedContentText = contentResult.content || `目标人群: ${creationState.targetAudience}\n\n产品特点:\n${creationState.productFeatures}`;
        generatedTags = contentResult.tags || [];

        setCreationState(prev => ({
          ...prev,
          generationProgress: 30,
          generationMessage: `已生成 1 篇笔记，正在分析视觉方案...`,
          generationStep: 2,
          localGeneratedContent: { title: generatedTitle, content: generatedContentText },
          generatedTags: generatedTags
        }));
      }

      const analyzeResult = await apiClient.analyzeContent({
        title: generatedTitle,
        content: generatedContentText,
        style: creationState.visualStyle,
      });

      if (!analyzeResult.success) {
        throw new Error(analyzeResult.message || '分析失败');
      }

      const count = analyzeResult.prompts?.length || 0;
      setCreationState(prev => ({
        ...prev,
        promptCount: count,
        prompts: analyzeResult.prompts || [],
        generationProgress: 50,
        generationMessage: `已生成 ${count} 套视觉方案,正在生成图片`,
        generationStep: 3
      }));

      const workflowResult = await apiClient.runWorkflow({
        title: generatedTitle,
        content: generatedContentText,
        style: creationState.visualStyle,
        image_count: 3,
      });

      if (!workflowResult.success) {
        throw new Error(workflowResult.message || '生成失败');
      }

      setCreationState(prev => ({
        ...prev,
        generationProgress: 70,
        generationMessage: `正在生成图片... (0/${workflowResult.task_ids?.length || 0})`
      }));

      const assets = await pollTaskStatus(workflowResult.task_ids || []);

      if (assets.length === 0) {
        throw new Error('没有成功生成任何图片');
      }

      setCreationState(prev => ({
        ...prev,
        generationProgress: 100,
        generationMessage: `生成完成！共生成 ${assets.length} 张图片`,
        generationStep: 4,
        isGenerating: false,
      }));

      if (onComplete) {
        onComplete();
      }

      setCreationState(prev => ({
        ...prev,
        finalAssets: assets,
        taskIds: workflowResult.task_ids || []
      }));

    } catch (error: any) {
      console.error('生成失败:', error);
      const errorMessage = normalizeAppErrorMessage(error, '未知错误');
      setCreationState(prev => ({
        ...prev,
        isGenerating: false,
        generationMessage: `生成失败: ${errorMessage}`
      }));
      alert(`生成失败: ${errorMessage}`);
    }
  }, [creationState]);

  const clearState = () => {
    setInterviewState(initialInterviewState);
    setCreationState({
      ...initialCreationState,
      draftSessionKey: createDraftSessionKey(),
    });
    localStorage.removeItem('xhs_persistence_interview');
    localStorage.removeItem('xhs_persistence_creation');
  };

  return (
    <PersistenceContext.Provider value={{
      interviewState,
      setInterviewState,
      creationState,
      setCreationState,
      exportCreationState,
      restoreCreationState,
      rotateDraftSessionKey,
      startGeneration,
      clearState
    }}>
      {children}
    </PersistenceContext.Provider>
  );
};
