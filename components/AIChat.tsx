import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ChatMessage, ContentData, Asset, ReferenceAsset } from '../types';
import { chatWithAI } from '../services/geminiService';
import { apiClient, isAuthRequiredError, normalizeAppErrorMessage } from '../services/apiClient';

interface AIChatProps {
  activeAssetId: string;
  chatSessionKey: string;
  content: ContentData;
  onContentChange: (updated: Partial<ContentData>) => void;
  onAssetUpdate: (id: string, newUrl: string) => void;
  onAssetStatusChange: (id: string, isProcessing: boolean, statusText?: string) => void;
  onClearActiveAsset: () => void;
  isLogoBatchSelectionMode: boolean;
  selectedLogoFixAssetCount: number;
  onToggleLogoBatchSelectionMode: () => void;
  onOpenLogoFixDialog: () => void;
  onClearLogoFixSelection: () => void;
  hasGeneratedContent: boolean;
  logoFixStatus?: string;
  logoFixStatusTone?: 'idle' | 'loading' | 'success' | 'error';
  logoFixProgress?: { submitted: number; completed: number; failed?: number; retrying?: number; total: number };
  logoFixStartedAt?: number | null;
  isApplyingLogoFix?: boolean;
  onCancelLogoFix?: () => void;
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: 'm1',
    role: 'user',
    content: '把整体色调调暖一点，更有落日的感觉 🌅',
    timestamp: '今天 10:23',
  },
  {
    id: 'm2',
    role: 'assistant',
    content: '已调整色温至 4500K，并增强了高光部分的橙色调。',
    timestamp: '今天 10:24',
    actions: 'confirm_discard'
  },
  {
    id: 'm3',
    role: 'user',
    content: '背景有点太抢眼了，稍微虚化一下',
    timestamp: '今天 10:25',
  },
  {
    id: 'm4',
    role: 'assistant',
    content: '正在处理背景虚化...',
    timestamp: '今天 10:25',
    isOptimizing: true,
    progress: 25
  }
];

const AI_CHAT_STORAGE_KEY = 'xhs_studio_ai_chat_state';

const hashChatSessionKey = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
};

const getChatStorageKey = (chatSessionKey: string) => (
  `${AI_CHAT_STORAGE_KEY}:${hashChatSessionKey(chatSessionKey || 'default')}`
);

type ChatAttachmentDraft = {
  id: string;
  file?: File;
  assetId?: string;
  name: string;
  previewUrl: string;
  source?: string;
  tags?: string[];
  note?: string;
  aiHint?: string;
};

const isMockConversation = (messages: ChatMessage[]) => (
  messages.length > 0 && messages[0]?.id === 'm1'
);

const normalizePersistedMessages = (messages: ChatMessage[]) => messages.map((message) => {
  const normalizedMessage = message.isOptimizing
    ? {
        ...message,
        isOptimizing: false,
        progress: undefined,
        content: message.content.includes('正在') ? '上次处理已中断，请重新发送这条修改需求。' : message.content,
        actions: 'none' as const,
      }
    : message;
  return {
    ...normalizedMessage,
    attachments: (normalizedMessage.attachments || []).map((attachment) => ({
      ...attachment,
      url: attachment.url?.startsWith('blob:') ? (attachment.fallbackUrl || attachment.url) : attachment.url,
    })),
  };
});

const loadPersistedChatState = (storageKey: string): { messages: ChatMessage[]; inputValue: string } | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    if (messages.length === 0 || isMockConversation(messages)) return null;
    return {
      messages: normalizePersistedMessages(messages),
      inputValue: typeof parsed?.inputValue === 'string' ? parsed.inputValue : '',
    };
  } catch (error) {
    console.error('Failed to load AI chat state', error);
    return null;
  }
};

const persistChatState = (storageKey: string, messages: ChatMessage[], inputValue: string) => {
  if (typeof window === 'undefined') return;
  try {
    if (messages.length === 0 || isMockConversation(messages)) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify({
      messages,
      inputValue,
      updatedAt: new Date().toISOString(),
    }));
  } catch (error) {
    console.error('Failed to persist AI chat state', error);
  }
};

const clearPersistedChatState = (storageKey: string) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(storageKey);
    window.localStorage.removeItem(AI_CHAT_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear AI chat state', error);
  }
};

const detectIntent = (message: string, hasActiveAsset: boolean, hasAttachments = false): 'image_edit' | 'text_edit' => {
  if (hasAttachments) return 'image_edit';
  if (!hasActiveAsset) return 'text_edit';

  const imageKeywords = ['图片', '颜色', '背景', '虚化', '亮度', '对比度', '调亮', '调暗', '换成', '修改图'];
  const textKeywords = ['文案', '标题', '内容', '改写', '优化', '润色', '活泼', '修改文', '正文'];

  const hasImageKeyword = imageKeywords.some(kw => message.includes(kw));
  const hasTextKeyword = textKeywords.some(kw => message.includes(kw));

  if (hasImageKeyword && !hasTextKeyword) return 'image_edit';
  if (hasTextKeyword && !hasImageKeyword) return 'text_edit';

  return 'image_edit';
};

const getPolishType = (message: string): 'title' | 'body' | 'all' => {
  const titleKeywords = ['标题'];
  const bodyKeywords = ['正文', '内容', '文案'];

  const hasTitle = titleKeywords.some(kw => message.includes(kw));
  const hasBody = bodyKeywords.some(kw => message.includes(kw));

  if (hasTitle && !hasBody) return 'title';
  if (hasBody && !hasTitle) return 'body';
  return 'all'; // 默认或两者都有
};

const readFileAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

const AIChat: React.FC<AIChatProps> = ({
  activeAssetId,
  chatSessionKey,
  content,
  onContentChange,
  onAssetUpdate,
  onAssetStatusChange,
  onClearActiveAsset,
  isLogoBatchSelectionMode,
  selectedLogoFixAssetCount,
  onToggleLogoBatchSelectionMode,
  onOpenLogoFixDialog,
  onClearLogoFixSelection,
  hasGeneratedContent,
  logoFixStatus = '',
  logoFixStatusTone = 'idle',
  logoFixProgress = { submitted: 0, completed: 0, total: 0 },
  logoFixStartedAt = null,
  isApplyingLogoFix = false,
  onCancelLogoFix,
}) => {
  const storageKey = getChatStorageKey(chatSessionKey);
  const skipNextPersistRef = useRef(false);
  const [isLogoFixPanelOpen, setIsLogoFixPanelOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const persisted = loadPersistedChatState(storageKey);
    if (persisted) return persisted.messages;
    return hasGeneratedContent ? [] : INITIAL_MESSAGES;
  });
  const [inputValue, setInputValue] = useState(() => loadPersistedChatState(storageKey)?.inputValue || '');
  const [isTyping, setIsTyping] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [backupContent, setBackupContent] = useState<{ title?: string, body?: string } | null>(null);
  const [backupAssetUrl, setBackupAssetUrl] = useState<{ id: string, url: string } | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);
  const [assetLibrary, setAssetLibrary] = useState<ReferenceAsset[]>([]);
  const [isLoadingAssetLibrary, setIsLoadingAssetLibrary] = useState(false);
  const cancelledMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isApplyingLogoFix) {
      setIsLogoFixPanelOpen(false);
    }
  }, [isApplyingLogoFix]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const persisted = loadPersistedChatState(storageKey);
    skipNextPersistRef.current = true;
    setMessages(persisted?.messages || (hasGeneratedContent ? [] : INITIAL_MESSAGES));
    setInputValue(persisted?.inputValue || '');
    setIsTyping(false);
    setCurrentTaskId(null);
    setBackupContent(null);
    setBackupAssetUrl(null);
    setAttachments([]);
    setIsAssetPickerOpen(false);
    cancelledMessageIdsRef.current.clear();
  }, [storageKey, hasGeneratedContent]);

  // 当 hasGeneratedContent 变为 true 时（即生成了内容），清空 Mock 数据
  useEffect(() => {
    if (hasGeneratedContent) {
      // 仅当当前显示的是 Mock 数据时才清空，避免清空用户真实的对话
      setMessages(prev => {
        return isMockConversation(prev) ? [] : prev;
      });
    }
  }, [hasGeneratedContent]);

  useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    persistChatState(storageKey, messages, inputValue);
  }, [storageKey, messages, inputValue]);

  const scrollToBottom = () => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, logoFixStatus, logoFixStartedAt]);

  const logoFixInsertionIndex = useMemo(() => {
    if (!logoFixStatus || !logoFixStartedAt) {
      return messages.length;
    }
    const nextMessageIndex = messages.findIndex((message) => {
      const messageTime = Number(message.id);
      return Number.isFinite(messageTime) && messageTime > logoFixStartedAt;
    });
    return nextMessageIndex >= 0 ? nextMessageIndex : messages.length;
  }, [logoFixStartedAt, logoFixStatus, messages]);

  const handleConfirm = (messageId: string) => {
    setMessages(prev => prev.map(msg =>
      msg.id === messageId
        ? { ...msg, actions: 'none' as const, content: msg.content + ' ✅' }
        : msg
    ));
    setBackupContent(null);
    setBackupAssetUrl(null);
  };

  const handleClearChat = () => {
    setMessages([]);
    setInputValue('');
    setIsTyping(false);
    setCurrentTaskId(null);
    setBackupContent(null);
    setBackupAssetUrl(null);
    setAttachments([]);
    clearPersistedChatState(storageKey);
  };

  const addAttachmentFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const currentCount = attachments.length;
    const availableSlots = Math.max(0, 4 - currentCount);
    const acceptedFiles = imageFiles.slice(0, availableSlots);
    if (acceptedFiles.length === 0) return;
    const nextItems = await Promise.all(acceptedFiles.map(async (file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      name: file.name || '粘贴截图.png',
      previewUrl: await readFileAsDataUrl(file),
    })));
    setAttachments((prev) => {
      const remainingSlots = Math.max(0, 4 - prev.length);
      return [...prev, ...nextItems.slice(0, remainingSlots)];
    });
  };

  const addLibraryAsset = (asset: ReferenceAsset) => {
    if (attachments.some((item) => item.assetId === asset.id)) return;
    setAttachments((prev) => {
      if (prev.length >= 4) return prev;
      return [
        ...prev,
        {
          id: `asset-${asset.id}`,
          assetId: asset.id,
          name: asset.display_name || asset.original_name,
          previewUrl: asset.url,
          source: asset.source,
          tags: asset.tags || [],
          note: asset.note || '',
          aiHint: asset.ai_hint || '',
        },
      ];
    });
    setIsAssetPickerOpen(false);
  };

  const openAssetPicker = async () => {
    setIsAssetPickerOpen((prev) => !prev);
    if (assetLibrary.length > 0 || isLoadingAssetLibrary) return;
    setIsLoadingAssetLibrary(true);
    try {
      const response = await apiClient.getReferenceAssets();
      setAssetLibrary(Array.isArray(response.data) ? response.data : []);
    } catch (error) {
      console.error('加载素材库失败:', error);
    } finally {
      setIsLoadingAssetLibrary(false);
    }
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    void addAttachmentFiles(Array.from(event.target.files || []));
    event.target.value = '';
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length > 0) {
      void addAttachmentFiles(files);
    }
  };

  const removeAttachment = (attachmentId: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
  };

  const uploadAttachments = async (items: ChatAttachmentDraft[], messageId: string) => {
    const uploaded = await Promise.all(items.map(async (item) => {
      if (item.assetId) {
        return {
          id: item.assetId,
          name: item.name,
          url: item.previewUrl,
          fallbackUrl: item.previewUrl,
        };
      }
      if (!item.file) {
        throw new Error(`素材 ${item.name} 缺少文件`);
      }
      const response = await apiClient.uploadReferenceAsset(item.file, {
        source: 'chat_attachment',
        display_name: item.name,
        ai_hint: inputValue.trim() ? `用户在对话中随修改意见上传的参考图：${inputValue.trim().slice(0, 180)}` : '用户在对话中上传的参考图',
      });
      if (!response.success || !response.data?.id) {
        throw new Error(response.message || `上传 ${item.name} 失败`);
      }
      return {
        id: response.data.id as string,
        name: response.data.original_name || item.name,
        url: response.data.url || item.previewUrl,
        fallbackUrl: item.previewUrl,
      };
    }));
    setMessages((prev) => prev.map((message) => (
      message.id === messageId
        ? {
            ...message,
            attachments: uploaded.map((item) => ({
              id: item.id,
              name: item.name,
              url: item.url,
              fallbackUrl: item.fallbackUrl,
            })),
          }
        : message
    )));
    return uploaded.map((item) => item.id);
  };

  const handleDiscard = (messageId: string) => {
    const message = messages.find(m => m.id === messageId);

    if (message?.type === 'text_edit' && backupContent !== null) {
      const updates: Partial<ContentData> = {};
      if (backupContent.title !== undefined) updates.title = backupContent.title;
      if (backupContent.body !== undefined) updates.body = backupContent.body;
      onContentChange(updates);
      setBackupContent(null);
    } else if (message?.type === 'image_edit' && backupAssetUrl !== null) {
      onAssetUpdate(backupAssetUrl.id, backupAssetUrl.url);
      setBackupAssetUrl(null);
    }

    setMessages(prev => prev.map(msg =>
      msg.id === messageId
        ? { ...msg, actions: 'none' as const, content: '已撤销修改' }
        : msg
    ));
  };

  const handleCancelImageEdit = async (messageId: string, taskId?: string) => {
    cancelledMessageIdsRef.current.add(messageId);
    setMessages(prev => prev.map(msg =>
      msg.id === messageId
        ? {
            ...msg,
            isOptimizing: false,
            progress: 100,
            content: taskId ? '已取消本次图片修改' : '已取消本次图片修改，正在停止提交',
            actions: 'none' as const,
          }
        : msg
    ));
    onAssetStatusChange(activeAssetId, false);
    if (!taskId) {
      return;
    }
    try {
      await apiClient.cancelVisualTask(taskId);
    } catch (error) {
      console.warn('[AIChat] Cancel image edit failed:', error);
    }
  };

  const pollTaskStatus = async (taskId: string, messageId: string) => {
    const maxAttempts = 120;
    const pollInterval = 2000;
    const startTime = Date.now();
    const globalTimeout = 420000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (cancelledMessageIdsRef.current.has(messageId)) {
        return;
      }
      if (Date.now() - startTime > globalTimeout) {
        setMessages(prev => prev.map(msg =>
          msg.id === messageId
            ? { ...msg, isOptimizing: false, content: '任务超时，请稍后重试', actions: 'none' as const }
            : msg
        ));
        onAssetStatusChange(activeAssetId, false);
        return;
      }

      try {
        const taskStatus = await apiClient.getVisualTaskStatus(taskId);
        if (cancelledMessageIdsRef.current.has(messageId)) {
          return;
        }

        console.log(`[AIChat] Polling attempt ${attempt + 1}/${maxAttempts}, status: ${taskStatus.status}, progress: ${taskStatus.progress}`);

        if (taskStatus.status === 'completed') {
          const result = taskStatus.result || taskStatus.data;

          console.log('[AIChat] Task completed, result:', result);

          if (result?.images && result.images.length > 0) {
            const newImageUrl = result.images[0];

            console.log('[AIChat] New image URL:', newImageUrl);

            const currentAsset = { id: activeAssetId, url: content.mainImageUrl };
            setBackupAssetUrl(currentAsset);
            onAssetUpdate(activeAssetId, newImageUrl);

            setMessages(prev => prev.map(msg =>
              msg.id === messageId
                ? {
                  ...msg,
                  isOptimizing: false,
                  content: '图片编辑完成！',
                  actions: 'confirm_discard' as const,
                  type: 'image_edit' as const
                }
                : msg
            ));
            onAssetStatusChange(activeAssetId, false);
          } else {
            console.error('[AIChat] Task completed but no images found');
            setMessages(prev => prev.map(msg =>
              msg.id === messageId
                ? { ...msg, isOptimizing: false, content: '图片编辑完成,但未找到生成的图片', actions: 'none' as const }
                : msg
            ));
            onAssetStatusChange(activeAssetId, false);
          }
          return;
        } else if (taskStatus.status === 'failed' || taskStatus.status === 'cancelled') {
          setMessages(prev => prev.map(msg =>
            msg.id === messageId
              ? {
                  ...msg,
                  isOptimizing: false,
                  content: taskStatus.status === 'cancelled'
                    ? '已取消本次图片修改'
                    : `编辑失败: ${taskStatus.error || '未知错误'}`,
                  actions: 'none' as const,
                }
              : msg
          ));
          onAssetStatusChange(activeAssetId, false);
          return;
        } else {
          setMessages(prev => prev.map(msg =>
            msg.id === messageId
              ? { ...msg, progress: taskStatus.progress || 50 }
              : msg
          ));
        }
      } catch (error) {
        console.error(`[AIChat] Polling error on attempt ${attempt + 1}:`, error);
        if (isAuthRequiredError(error)) {
          setMessages(prev => prev.map(msg =>
            msg.id === messageId
              ? { ...msg, isOptimizing: false, content: error.message, actions: 'none' as const }
              : msg
          ));
          onAssetStatusChange(activeAssetId, false);
          return;
        }
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  };

  const handleSend = async () => {
    const pendingAttachments = attachments;
    const trimmedInput = inputValue.trim();
    if (!trimmedInput && pendingAttachments.length === 0) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: trimmedInput || '请参考附件修改当前图片',
      attachments: pendingAttachments.map((item) => ({
        name: item.name,
        url: item.previewUrl,
        fallbackUrl: item.previewUrl,
      })),
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => [...prev, userMsg]);
    const userInput = userMsg.content;
    setInputValue('');
    setAttachments([]);
    setIsTyping(true);

    try {
      const intent = detectIntent(userInput, !!activeAssetId, pendingAttachments.length > 0);

      if (intent === 'image_edit') {
        if (!activeAssetId) {
          const errorMsg: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: '请先选择一张图片再进行编辑',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          setMessages(prev => [...prev, errorMsg]);
          setIsTyping(false);
          return;
        }

        const referenceAssetIds = pendingAttachments.length > 0
          ? await uploadAttachments(pendingAttachments, userMsg.id)
          : [];
        const processingMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: referenceAssetIds.length > 0 ? 'AI 正在结合附件编辑图片...' : 'AI 正在编辑图片...',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isOptimizing: true,
          progress: 10,
        };
        cancelledMessageIdsRef.current.delete(processingMsg.id);
        setMessages(prev => [...prev, processingMsg]);
        setIsTyping(false);
        onAssetStatusChange(activeAssetId, true, 'AI 优化中...');

        // 从当前选中的资产中获取图片 URL，提取文件名
        const currentAsset = content.mainImageUrl;
        let imageFileName = activeAssetId;

        // 如果 URL 包含文件名，提取出来
        if (currentAsset && currentAsset.includes('/')) {
          const urlParts = currentAsset.split('/');
          imageFileName = urlParts[urlParts.length - 1];
        }

        const response = await apiClient.editImage({
          image_id: imageFileName,
          prompt: userInput,
          reference_asset_ids: referenceAssetIds,
        });

        if (response.success && response.task_id) {
          if (cancelledMessageIdsRef.current.has(processingMsg.id)) {
            void apiClient.cancelVisualTask(response.task_id).catch((error) => {
              console.warn('[AIChat] Cancel late image edit task failed:', error);
            });
            return;
          }
          setCurrentTaskId(response.task_id);
          setMessages(prev => prev.map(msg =>
            msg.id === processingMsg.id
              ? { ...msg, taskId: response.task_id }
              : msg
          ));
          pollTaskStatus(response.task_id, processingMsg.id);
        } else {
          setMessages(prev => prev.map(msg =>
            msg.id === processingMsg.id
              ? { ...msg, isOptimizing: false, content: '图片编辑失败，请重试' }
              : msg
          ));
          onAssetStatusChange(activeAssetId, false);
        }
      } else {
        const polishType = getPolishType(userInput);

        const backup: { title?: string, body?: string } = {};
        if (polishType === 'title') {
          backup.title = content.title;
        } else if (polishType === 'body') {
          backup.body = content.body;
        } else {
          backup.title = content.title;
          backup.body = content.body;
        }
        setBackupContent(backup);

        let textToPolish = content.body;

        if (polishType === 'title') {
          textToPolish = content.title;
        } else if (polishType === 'all') {
          textToPolish = `标题：${content.title}\n\n正文：${content.body}`;
        }

        const response = await apiClient.polishContent({
          text: textToPolish,
          instruction: userInput,
          type: polishType
        });

        if (response.success && response.polished_text) {
          const polished = response.polished_text;

          if (polishType === 'title') {
            onContentChange({ title: polished });
          } else if (polishType === 'body') {
            onContentChange({ body: polished });
          } else {
            // 尝试解析标题和正文
            // 简单 heuristic: 假设第一行是标题
            const lines = polished.split('\n');
            let newTitle = content.title;
            let newBody = polished;

            // 如果返回文本明确包含了"标题："和"正文："前缀，可以解析
            if (polished.includes('标题：') && polished.includes('正文：')) {
              // 简单的解析逻辑，实际可能需要更健壮的 regex
              const titleMatch = polished.match(/标题：(.*?)(?:\n|$)/);
              const bodyMatch = polished.match(/正文：([\s\S]*)/);

              if (titleMatch) newTitle = titleMatch[1].trim();
              if (bodyMatch) newBody = bodyMatch[1].trim();

              onContentChange({ title: newTitle, body: newBody });
            } else {
              // 如果是 all 但没有明确结构，保守起见只更新正文，或者假设第一段是标题（风险较大）
              // 这里我们选择只更新正文，或者让 LLM 返回 JSON 更好。
              // 为了简单，我们只更新正文，用户如果想改标题应该明确说"改标题"
              onContentChange({ body: polished });
            }
          }

          const assistantMsg: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: '已为您优化文案',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            actions: 'confirm_discard' as const,
            type: 'text_edit' as const,
          };
          setMessages(prev => [...prev, assistantMsg]);
        } else {
          const errorMsg: ChatMessage = {
            id: (Date.now() + 1).toString(),
            role: 'assistant',
            content: '文案优化失败，请重试',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          setMessages(prev => [...prev, errorMsg]);
        }
        setIsTyping(false);
      }
    } catch (error) {
      console.error('AI 处理失败:', error);
      const errorMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `处理失败: ${normalizeAppErrorMessage(error, '未知错误')}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages(prev => [...prev, errorMsg]);
      setIsTyping(false);
    }
  };

  return (
    <>
      <div className="h-14 shrink-0 border-b border-white/5 flex justify-between items-center px-5 bg-white/[0.01]">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-xhs-red opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-xhs-red"></span>
          </span>
          <span className="text-xs text-white/90 font-medium tracking-wide uppercase">AI 助手</span>
        </div>
        <button
          onClick={handleClearChat}
          className="text-gray-500 hover:text-white transition-colors p-1.5 rounded-lg hover:bg-white/5"
          title="新建对话"
        >
          <span className="material-symbols-outlined text-[16px]">add_comment</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
        {messages.map((msg, index) => (
          <React.Fragment key={msg.id}>
          {logoFixStatus && logoFixInsertionIndex === index && (
            <div className="flex justify-start">
              <div className={`max-w-[86%] rounded-2xl border px-4 py-3 text-sm shadow-lg ${
                logoFixStatusTone === 'error'
                  ? 'border-red-400/25 bg-red-500/10 text-red-100'
                  : logoFixStatusTone === 'success'
                    ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
                    : 'border-white/10 bg-white/[0.04] text-slate-200'
              }`}>
                <div className="flex items-center gap-2">
                  {isApplyingLogoFix && (
                    <span className="material-symbols-outlined animate-spin text-[17px] text-emerald-200">progress_activity</span>
                  )}
                  <span className="font-semibold">{isApplyingLogoFix ? '正在替换错误 Logo' : '品牌标识修正'}</span>
                </div>
                <div className="mt-2 leading-5">{logoFixStatus}</div>
                {(isApplyingLogoFix || logoFixProgress.total > 0) && (
                  <>
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
                      <span>
                        已提交 {logoFixProgress.submitted}/{logoFixProgress.total} 张，已完成 {logoFixProgress.completed}/{logoFixProgress.total} 张
                        {logoFixProgress.retrying ? `，自动重试 ${logoFixProgress.retrying} 张` : ''}
                        {logoFixProgress.failed ? `，失败 ${logoFixProgress.failed} 张` : ''}
                      </span>
                      {isApplyingLogoFix && onCancelLogoFix && (
                        <button
                          type="button"
                          onClick={onCancelLogoFix}
                          className="shrink-0 rounded-lg border border-red-300/20 px-2 py-1 font-semibold text-red-100 transition hover:bg-red-500/15"
                        >
                          取消
                        </button>
                      )}
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-emerald-300 transition-all"
                        style={{ width: `${logoFixProgress.total > 0 ? Math.max(8, Math.round(((logoFixProgress.completed + (logoFixProgress.failed || 0)) / logoFixProgress.total) * 100)) : 8}%` }}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start items-start gap-3'} animate-fade-in`}>
            {msg.role === 'assistant' && (
              <div className="size-8 rounded-full bg-gradient-to-br from-xhs-red to-rose-600 flex items-center justify-center shrink-0 shadow-lg ring-1 ring-white/10">
                <span className="material-symbols-outlined text-[14px] text-white fill-1">auto_awesome</span>
              </div>
            )}

            <div className={`flex flex-col gap-2 max-w-[85%] ${msg.role === 'user' ? 'items-end' : ''}`}>
              {msg.isOptimizing ? (
                <div className="flex-1 flex flex-col gap-2 p-3 rounded-xl border border-white/5 bg-white/[0.02] w-[300px]">
                  <div className="flex justify-between items-center text-[10px] text-gray-400">
                    <span className="font-medium text-xhs-red flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[12px] animate-spin">sync</span>
                      AI 正在优化...
                    </span>
                    <span className="font-mono">{msg.progress}%</span>
                  </div>
                  <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
                    <div className="bg-gradient-to-r from-xhs-red to-pink-500 h-full rounded-full relative overflow-hidden transition-all duration-500" style={{ width: `${msg.progress}%` }}>
                      <div className="absolute inset-0 bg-white/30 animate-shimmer"></div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => void handleCancelImageEdit(msg.id, msg.taskId)}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-300/20 px-2 py-1 text-[10px] font-semibold text-red-100 transition hover:bg-red-500/15"
                    >
                      <span className="material-symbols-outlined text-[12px]">close</span>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`${msg.role === 'user' ? 'bg-[#27272a] rounded-tr-sm' : 'bg-[#1c1c1f] rounded-tl-sm'} text-[13px] px-4 py-3 rounded-2xl shadow-sm border border-white/5 leading-relaxed`}>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mb-2 grid grid-cols-2 gap-2">
                      {msg.attachments.map((attachment, index) => {
                        const src = attachment.url?.startsWith('blob:') ? attachment.fallbackUrl || attachment.url : attachment.url;
                        return (
                          <img
                            key={`${src}-${index}`}
                            src={src}
                            alt={attachment.name}
                            onError={(event) => {
                              if (attachment.fallbackUrl && event.currentTarget.src !== attachment.fallbackUrl) {
                                event.currentTarget.src = attachment.fallbackUrl;
                              }
                            }}
                            className="h-20 w-24 rounded-lg border border-white/10 object-cover"
                          />
                        );
                      })}
                    </div>
                  )}
                  {msg.content}
                </div>
              )}

              {msg.actions === 'confirm_discard' && (
                <div className="flex gap-2 w-full mt-1">
                  <button
                    onClick={() => handleConfirm(msg.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-xhs-red/10 border border-xhs-red/20 text-xhs-red hover:bg-xhs-red hover:text-white text-[11px] font-medium transition-all"
                  >
                    <span className="material-symbols-outlined text-[14px]">check</span> 确认
                  </button>
                  <button
                    onClick={() => handleDiscard(msg.id)}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-white/5 border border-white/5 hover:bg-white/10 text-gray-400 text-[11px] font-medium transition-all hover:text-white"
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span> 放弃
                  </button>
                </div>
              )}
            </div>
          </div>
          </React.Fragment>
        ))}
        {isTyping && (
          <div className="flex justify-start items-center gap-3">
            <div className="size-8 rounded-full bg-white/5 flex items-center justify-center">
              <span className="animate-pulse w-1 h-1 bg-gray-500 rounded-full mx-0.5"></span>
              <span className="animate-pulse w-1 h-1 bg-gray-500 rounded-full mx-0.5" style={{ animationDelay: '0.2s' }}></span>
              <span className="animate-pulse w-1 h-1 bg-gray-500 rounded-full mx-0.5" style={{ animationDelay: '0.4s' }}></span>
            </div>
          </div>
        )}
        {logoFixStatus && logoFixInsertionIndex === messages.length && (
          <div className="flex justify-start">
            <div className={`max-w-[86%] rounded-2xl border px-4 py-3 text-sm shadow-lg ${
              logoFixStatusTone === 'error'
                ? 'border-red-400/25 bg-red-500/10 text-red-100'
                : logoFixStatusTone === 'success'
                  ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
                  : 'border-white/10 bg-white/[0.04] text-slate-200'
            }`}>
              <div className="flex items-center gap-2">
                {isApplyingLogoFix && (
                  <span className="material-symbols-outlined animate-spin text-[17px] text-emerald-200">progress_activity</span>
                )}
                <span className="font-semibold">{isApplyingLogoFix ? '正在替换错误 Logo' : '品牌标识修正'}</span>
              </div>
              <div className="mt-2 leading-5">{logoFixStatus}</div>
              {(isApplyingLogoFix || logoFixProgress.total > 0) && (
                <>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-slate-400">
                    <span>
                      已提交 {logoFixProgress.submitted}/{logoFixProgress.total} 张，已完成 {logoFixProgress.completed}/{logoFixProgress.total} 张
                      {logoFixProgress.retrying ? `，自动重试 ${logoFixProgress.retrying} 张` : ''}
                      {logoFixProgress.failed ? `，失败 ${logoFixProgress.failed} 张` : ''}
                    </span>
                    {isApplyingLogoFix && onCancelLogoFix && (
                      <button
                        type="button"
                        onClick={onCancelLogoFix}
                        className="shrink-0 rounded-lg border border-red-300/20 px-2 py-1 font-semibold text-red-100 transition hover:bg-red-500/15"
                      >
                        取消
                      </button>
                    )}
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-emerald-300 transition-all"
                      style={{ width: `${logoFixProgress.total > 0 ? Math.max(8, Math.round(((logoFixProgress.completed + (logoFixProgress.failed || 0)) / logoFixProgress.total) * 100)) : 8}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="p-4 bg-[#141418] border-t border-white/5 shrink-0">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] text-gray-500 font-medium">正在编辑:</span>
          {activeAssetId ? (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-xhs-red/10 border border-xhs-red/20">
              <span className="material-symbols-outlined text-[12px] text-xhs-red">image</span>
              <span className="text-[10px] text-xhs-red font-medium">图片 {activeAssetId}</span>
              <button
                onClick={onClearActiveAsset}
                className="ml-1 text-xhs-red/60 hover:text-xhs-red transition-colors"
                title="取消选中"
              >
                <span className="material-symbols-outlined text-[12px]">close</span>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/20">
              <span className="material-symbols-outlined text-[12px] text-blue-400">edit_note</span>
              <span className="text-[10px] text-blue-400 font-medium">笔记内容</span>
            </div>
          )}
          <div className="flex-1 h-px bg-white/5"></div>
        </div>
        {activeAssetId && (
          <div className="flex gap-2 mb-3 overflow-x-auto scrollbar-hide">
            <button className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-white/5 border border-white/5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-white transition-all whitespace-nowrap">
              <span className="material-symbols-outlined text-[12px] text-yellow-500">light_mode</span> 提亮主体
            </button>
            <button className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-white/5 border border-white/5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-white transition-all whitespace-nowrap">
              <span className="material-symbols-outlined text-[12px] text-purple-500">magic_button</span> 智能抠图
            </button>
            <button
              type="button"
              onClick={openAssetPicker}
              className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-white/5 border border-white/5 text-[10px] text-gray-400 hover:bg-white/10 hover:text-white transition-all whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[12px] text-sky-400">photo_library</span> 素材库
            </button>
            <button
              type="button"
              onClick={() => setIsLogoFixPanelOpen((prev) => !prev)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-full border text-[10px] transition-all whitespace-nowrap ${isLogoFixPanelOpen ? 'border-emerald-300/30 bg-emerald-400/10 text-emerald-50' : 'border-white/5 bg-white/[0.04] text-gray-400 hover:bg-white/10 hover:text-white'}`}
            >
              <span className="material-symbols-outlined text-[12px] text-emerald-300">auto_fix_high</span>
              修 Logo
              {selectedLogoFixAssetCount > 0 && (
                <span className="ml-0.5 rounded-full bg-emerald-300/15 px-1.5 py-0.5 text-[9px] text-emerald-100">
                  {selectedLogoFixAssetCount}
                </span>
              )}
            </button>
          </div>
        )}
        {isLogoFixPanelOpen && (
          <div className="relative mb-3">
            <div className="absolute bottom-0 left-0 z-30 w-[260px] rounded-2xl border border-white/10 bg-[#18181f] p-3 shadow-2xl">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-emerald-100">批量修 Logo</span>
                <span className="rounded-full border border-emerald-300/15 bg-black/20 px-2 py-0.5 text-[10px] text-emerald-100">
                  已选 {selectedLogoFixAssetCount}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={onToggleLogoBatchSelectionMode}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition ${isLogoBatchSelectionMode ? 'border-emerald-300/35 bg-emerald-400/12 text-emerald-50' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'}`}
                >
                  <span className="material-symbols-outlined text-[13px] text-emerald-300">select_check_box</span>
                  {isLogoBatchSelectionMode ? '退出多选' : '多选图片'}
                </button>
                <button
                  type="button"
                  onClick={onOpenLogoFixDialog}
                  disabled={selectedLogoFixAssetCount === 0}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-semibold transition ${selectedLogoFixAssetCount === 0 ? 'cursor-not-allowed bg-slate-700 text-slate-400' : 'bg-white text-slate-950 hover:bg-slate-100'}`}
                >
                  <span className="material-symbols-outlined text-[13px]">image_search</span>
                  选 Logo
                </button>
                <button
                  type="button"
                  onClick={onClearLogoFixSelection}
                  disabled={selectedLogoFixAssetCount === 0}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold transition ${selectedLogoFixAssetCount === 0 ? 'cursor-not-allowed border-white/5 bg-white/[0.03] text-slate-600' : 'border-white/10 bg-white/5 text-slate-200 hover:bg-white/10'}`}
                >
                  <span className="material-symbols-outlined text-[13px]">backspace</span>
                  清空选择
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="relative group">
          {isAssetPickerOpen && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-3 max-h-72 overflow-y-auto rounded-2xl border border-white/10 bg-[#18181f] p-3 shadow-2xl custom-scrollbar">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-white/80">选择历史素材</span>
                <button type="button" onClick={() => setIsAssetPickerOpen(false)} className="text-slate-500 hover:text-white">
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
              {isLoadingAssetLibrary ? (
                <div className="py-6 text-center text-xs text-slate-500">正在加载素材...</div>
              ) : assetLibrary.length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-500">还没有历史素材</div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {assetLibrary.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => addLibraryAsset(asset)}
                      className="group/asset overflow-hidden rounded-xl border border-white/10 bg-black/20 text-left hover:border-xhs-red/40"
                    >
                      <img src={asset.url} alt={asset.display_name || asset.original_name} className="h-20 w-full object-cover bg-black/30" />
                      <div className="p-2">
                        <div className="truncate text-[10px] font-medium text-slate-200">{asset.display_name || asset.original_name}</div>
                        <div className="mt-1 truncate text-[9px] text-slate-500">
                          {asset.tags?.length ? asset.tags.map((tag) => `#${tag}`).join(' ') : asset.source === 'chat_attachment' ? '对话附件' : '项目素材'}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="mb-2 flex gap-2 overflow-x-auto scrollbar-hide">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-black/30">
                  <img src={attachment.previewUrl} alt={attachment.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white hover:bg-xhs-red"
                    title="移除图片"
                  >
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="w-full bg-[#0a0a0c] rounded-xl border border-white/10 text-gray-200 placeholder-gray-600 focus:ring-1 focus:ring-xhs-red/50 focus:border-xhs-red/50 transition-all resize-none h-24 py-3 pl-11 pr-12 text-[13px] leading-relaxed scrollbar-hide shadow-inner"
            placeholder={activeAssetId ? "输入修改建议，或粘贴截图/上传参考图..." : "输入文案修改建议(如:标题更活泼一点)..."}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isTyping || attachments.length >= 4}
            className="absolute left-2 bottom-2 p-2 rounded-lg text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent transition-all"
            title="上传参考图"
          >
            <span className="material-symbols-outlined text-[18px]">attach_file</span>
          </button>
          <button
            onClick={handleSend}
            disabled={isTyping || (!inputValue.trim() && attachments.length === 0)}
            className="absolute right-2 bottom-2 p-2 bg-xhs-red hover:bg-red-600 disabled:bg-white/10 disabled:text-gray-500 rounded-lg text-white shadow-lg transition-all transform hover:scale-105 active:scale-95 flex items-center justify-center"
          >
            <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
          </button>
        </div>
      </div>
    </>
  );
};

export default AIChat;
