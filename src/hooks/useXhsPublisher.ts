import { useState, useEffect, useCallback } from 'react';
import { BrowserTab, XhsOperationResult } from '../../shared/extension-contract';
import { arrayBufferToBase64 } from '../../shared/extension-utils';
import { detectXhsLogin, ensureXhsCreatorTab, waitForTabReady } from '../../lib/xhsSession';
import { useExtension } from './useExtension';
import { normalizeXhsTags } from '../../lib/xhsContent';

export type RuntimeEvaluateResult = {
  success?: boolean;
  message?: string;
  data?: {
    x?: number;
    y?: number;
    text?: string;
    kind?: 'host' | 'button';
    action?: 'event' | 'coordinate';
  };
};

type XhsUploadFilePayload = { name: string; type: string; base64: string };

export const fillXhsPublishTextInPage = async (
  titleArg: string,
  contentArg: string,
  tagsArg: string[],
): Promise<RuntimeEvaluateResult> => {
  const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const normalizeText = (value: string) => String(value || '').replace(/\s+/g, '').trim();
  const getTitleInput = () => document.querySelector("div.d-input input") as HTMLInputElement | null;
  const getContentEditor = () => document.querySelector('.editor-container [role="textbox"]') as HTMLElement | null;
  const waitForEditor = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      const titleEl = getTitleInput();
      const contentEl = getContentEditor();
      if (titleEl && contentEl) {
        return { titleEl, contentEl };
      }
      await delay(300);
    }
    return null;
  };
  const moveCaretToEnd = (el: HTMLElement) => {
    el.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const ready = await waitForEditor();
  if (!ready) {
    return {
      success: false,
      message: "等待发布编辑区超时，标题/正文输入框未出现",
    };
  }
  const { titleEl, contentEl } = ready;

  titleEl.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, titleArg);
  titleEl.dispatchEvent(new Event('input', { bubbles: true }));
  titleEl.dispatchEvent(new Event('change', { bubbles: true }));
  await delay(300);

  contentEl.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, contentArg + '\n\n');
  contentEl.dispatchEvent(new Event('input', { bubbles: true }));
  await delay(200);
  moveCaretToEnd(contentEl);

  for (const tag of tagsArg) {
    moveCaretToEnd(contentEl);

    const normalizedTag = String(tag || '').trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!normalizedTag) continue;

    document.execCommand("insertText", false, "#");
    contentEl.dispatchEvent(new Event('input', { bubbles: true }));
    contentEl.dispatchEvent(new KeyboardEvent('keyup', { key: '#', code: 'Digit3', keyCode: 51, which: 51, bubbles: true }));
    await delay(600);

    document.execCommand("insertText", false, normalizedTag);
    contentEl.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(1000);

    const enterDown = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    const enterUp = new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    contentEl.dispatchEvent(enterDown);
    contentEl.dispatchEvent(enterUp);
    await delay(400);

    const possibleTopicItem = document.querySelector('.publish-topic-list li, .topic-container li, [class*="topic"] li') as HTMLElement | null;
    if (possibleTopicItem) {
      possibleTopicItem.click();
      await delay(200);
    }

    moveCaretToEnd(contentEl);
    document.execCommand("insertText", false, " ");
    contentEl.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(300);
  }

  const titleOk = normalizeText(titleEl.value).includes(normalizeText(titleArg).slice(0, 20));
  const contentText = contentEl.innerText || contentEl.textContent || '';
  const contentOk = normalizeText(contentText).includes(normalizeText(contentArg).slice(0, 20));

  return {
    success: titleOk && contentOk,
    message: titleOk && contentOk ? "标题/内容已填充" : "标题/内容写入校验失败",
  };
};

export const uploadXhsImageFilesInPage = async (filesArg: XhsUploadFilePayload[]): Promise<RuntimeEvaluateResult> => {
  const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const isFileInput = (node: Element | null): node is HTMLInputElement => (
    node instanceof HTMLInputElement && node.type === 'file'
  );
  const findFileInputDeep = (root: ParentNode): HTMLInputElement | null => {
    const direct = root.querySelector?.("input[type='file']");
    if (isFileInput(direct)) return direct;

    const elements = Array.from(root.querySelectorAll?.('*') || []);
    for (const element of elements) {
      const shadowRoot = (element as HTMLElement).shadowRoot;
      if (!shadowRoot) continue;
      const nested = findFileInputDeep(shadowRoot);
      if (nested) return nested;
    }
    return null;
  };
  const summarizeUploadActions = () => Array.from(document.querySelectorAll('button, [role="button"], input, label'))
    .map((node) => {
      const element = node as HTMLElement;
      return [
        element.textContent || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('value') || '',
      ].join(' ').replace(/\s+/g, ' ').trim();
    })
    .filter((text) => text.includes('上传') || text.includes('选择文件') || text.includes('图片'))
    .slice(0, 8);
  const waitForFileInput = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20000) {
      const input = findFileInputDeep(document);
      if (input) return input;
      await delay(300);
    }
    return null;
  };
  const input = await waitForFileInput();
  if (!input) {
    const visibleActions = summarizeUploadActions();
    return {
      success: false,
      message: visibleActions.length > 0
        ? `未找到文件输入框，可见上传入口：${visibleActions.join(' / ')}`
        : '未找到文件输入框',
    };
  }
  const toArrayBuffer = (base64: string) => {
    const comma = base64.indexOf(",");
    const cleaned = (comma >= 0 ? base64.slice(comma + 1) : base64).trim().replace(/-/g, "+").replace(/_/g, "/");
    const pad = cleaned.length % 4;
    const padded = pad ? cleaned + "=".repeat(4 - pad) : cleaned;
    const binary = atob(padded);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  };
  const dt = new DataTransfer();
  filesArg.forEach((file) => {
    const buffer = toArrayBuffer(file.base64);
    const blob = new Blob([buffer], { type: file.type || "image/*" });
    const f = new File([blob], file.name, { type: file.type || "image/*" });
    dt.items.add(f);
  });
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

  const waitForUpload = () =>
    new Promise<boolean>((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        const uploading = document.querySelectorAll(".img-preview-area .pr .uploading").length;
        if (uploading === 0) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > 60000) {
          resolve(false);
          return;
        }
        window.setTimeout(tick, 500);
      };
      tick();
    });
  await delay(1500);
  const done = await waitForUpload();
  return done
    ? { success: true, message: `已注入 ${filesArg.length} 张图片，上传完成` }
    : { success: false, message: "等待上传超时" };
};

export const clickXhsPublishButtonInPage = async (): Promise<RuntimeEvaluateResult> => {
  const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const normalizeText = (value: string) => value.replace(/\s+/g, '').trim();
  const getElementText = (element: Element) => {
    const textParts = [
      element.textContent || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('value') || '',
    ];
    return normalizeText(textParts.find((item) => item.trim()) || '');
  };
  const getVisibleText = (selector: string) => Array.from(document.querySelectorAll(selector))
    .filter((node): node is HTMLElement => node instanceof HTMLElement && isElementVisible(node))
    .map((node) => (node.textContent || '').trim())
    .filter(Boolean);
  const collectValidationMessages = () => {
    const candidates = [
      ...getVisibleText('.d-text-red'),
      ...getVisibleText('.error-text'),
      ...getVisibleText('.toast'),
      ...getVisibleText('[class*="error"]'),
      ...getVisibleText('[class*="toast"]'),
      ...getVisibleText('[class*="message"]'),
    ];
    return Array.from(new Set(candidates)).filter((text) => (
      text.includes('标题')
      || text.includes('正文')
      || text.includes('内容')
      || text.includes('图片')
      || text.includes('上传')
      || text.includes('话题')
      || text.includes('超过')
      || text.includes('请输入')
      || text.includes('不能为空')
      || text.includes('字')
      || text.includes('失败')
    ));
  };
  const isElementVisible = (element: HTMLElement) => {
    let current: HTMLElement | null = element;
    while (current) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      current = current.parentElement;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || Boolean(element.offsetParent);
  };
  const isDisabled = (element: HTMLElement) => (
    element.matches(':disabled')
    || element.getAttribute('disabled') !== null
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('submit-disabled') === 'true'
    || element.className.toString().toLowerCase().includes('disabled')
  );
  const collectClassChain = (element: HTMLElement) => {
    const parts: string[] = [];
    let current: HTMLElement | null = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      parts.push(current.className.toString().toLowerCase());
      current = current.parentElement;
    }
    return parts.join(' ');
  };
  const isLikelyPublishLabel = (text: string) => (
    text === '发布'
    || text === '立即发布'
    || text === '确认发布'
    || text === '发布笔记'
    || text === '发表'
    || text === '提交发布'
  );
  const isRejectedAction = (text: string) => [
    '定时发布',
    '发布设置',
    '发布任务',
    '保存草稿',
    '存草稿',
    '草稿',
    '取消',
    '返回',
    '上一步',
    '下一步',
    '预览',
  ].some((keyword) => text.includes(keyword));
  const isLikelyNavigation = (element: HTMLElement, text: string, classChain: string) => (
    Boolean(text)
    && !classChain.includes('publish-page-publish-btn')
    && Boolean(element.closest('nav, aside, [class*="menu"], [class*="side"], [class*="sidebar"], [class*="nav"]'))
  );
  const findPublishHost = () => {
    const hosts = Array.from(document.querySelectorAll('xhs-publish-btn'))
      .filter((node): node is HTMLElement => node instanceof HTMLElement && isElementVisible(node));
    if (hosts.length === 0) {
      return null;
    }
    const publishHost = hosts.find((element) => {
      const attrs = [
        element.getAttribute('submit-text') || '',
        element.getAttribute('save-draft') || '',
        getElementText(element),
      ].join(' ');
      return attrs.includes('发布') || attrs.includes('暂存离开');
    });
    return publishHost || hosts[0] || null;
  };
  const scoreCandidate = (element: HTMLElement) => {
    const text = getElementText(element);
    const classChain = collectClassChain(element);
    if (!isLikelyPublishLabel(text) || isRejectedAction(text) || isLikelyNavigation(element, text, classChain)) {
      return null;
    }

    let score = 0;
    if (text === '发布') score += 120;
    else if (text === '立即发布' || text === '确认发布') score += 105;
    else score += 80;
    if (classChain.includes('publish-page-publish-btn')) score += 80;
    if (classChain.includes('publish') || classChain.includes('submit')) score += 25;
    if (classChain.includes('primary') || classChain.includes('red') || classChain.includes('danger')) score += 12;
    if (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button') score += 12;
    const rect = element.getBoundingClientRect();
    if (window.innerHeight > 0 && rect.top > window.innerHeight * 0.45) score += 8;
    if (window.innerWidth > 0 && rect.left > window.innerWidth * 0.35) score += 6;
    if (text.length > 8) score -= 12;
    return score;
  };
  const findPublishButton = () => {
    const publishHost = findPublishHost();
    if (publishHost) {
      return publishHost;
    }
    const candidates = Array.from(new Set([
      ...Array.from(document.querySelectorAll('.publish-page-publish-btn button')),
      ...Array.from(document.querySelectorAll('.publish-page-publish-btn [role="button"]')),
      ...Array.from(document.querySelectorAll('[class*="publish-page-publish-btn"] button')),
      ...Array.from(document.querySelectorAll('[class*="publish-page-publish-btn"] [role="button"]')),
      ...Array.from(document.querySelectorAll('[class*="publish"] button')),
      ...Array.from(document.querySelectorAll('[class*="submit"] button')),
      ...Array.from(document.querySelectorAll('button')),
      ...Array.from(document.querySelectorAll('[role="button"]')),
      ...Array.from(document.querySelectorAll('input[type="button"], input[type="submit"]')),
      ...Array.from(document.querySelectorAll('a')),
    ]))
      .filter((node): node is HTMLElement => node instanceof HTMLElement && isElementVisible(node))
      .map((element) => ({ element, score: scoreCandidate(element) }))
      .filter((item): item is { element: HTMLElement; score: number } => item.score !== null)
      .sort((left, right) => right.score - left.score);

    return candidates[0]?.element || null;
  };
  const summarizeVisibleActions = () => {
    const texts = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a'))
      .filter((node): node is HTMLElement => node instanceof HTMLElement && isElementVisible(node))
      .map((node) => getElementText(node))
      .filter(Boolean)
      .slice(0, 8);
    return Array.from(new Set(texts)).join(' / ');
  };

  const btn = findPublishButton();
  if (!btn) {
    const visibleActions = summarizeVisibleActions();
    return {
      success: false,
      message: visibleActions ? `未找到发布按钮，可见操作：${visibleActions}` : '未找到发布按钮',
    };
  }
  if (isDisabled(btn)) {
    const validationMessages = collectValidationMessages();
    return {
      success: false,
      message: validationMessages[0] || '发布按钮当前不可点击，请检查标题、正文或图片是否符合要求',
    };
  }
  btn.scrollIntoView?.({ block: 'center', inline: 'center' });
  const rect = btn.getBoundingClientRect();
  const isPublishHost = btn.tagName === 'XHS-PUBLISH-BTN';
  if (isPublishHost) {
    const publishHost = btn as HTMLElement & { _onPublish?: () => unknown };
    if (typeof publishHost._onPublish === 'function') {
      publishHost._onPublish();
      await delay(300);
      return {
        success: true,
        message: '已通过发布宿主组件触发发布事件',
        data: {
          text: getElementText(btn) || undefined,
          kind: 'host',
          action: 'event',
        },
      };
    }
    publishHost.dispatchEvent(new CustomEvent('publish', { bubbles: true, composed: true }));
    await delay(300);
    return {
      success: true,
      message: '已向发布宿主组件派发发布事件',
      data: {
        text: getElementText(btn) || undefined,
        kind: 'host',
        action: 'event',
      },
    };
  }
  const x = rect.left + Math.max(10, rect.width / 2);
  const y = rect.top + Math.max(10, rect.height / 2);
  const shadowLabel = getElementText(btn);
  return {
    success: true,
    message: `已定位发布按钮(${Math.round(x)}, ${Math.round(y)})`,
    data: {
      x,
      y,
      text: shadowLabel || undefined,
      kind: 'button',
      action: 'coordinate',
    },
  };
};

export const useXhsPublisher = () => {
  const { extension, tab } = useExtension();
  const [publishTab, setPublishTab] = useState<BrowserTab>();
  const [isPublishing, setIsPublishing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const TITLE_MAX_LENGTH = 20;

  const createPublishTab = useCallback(async () => {
    if (!extension) return null;
    if (publishTab?.id !== undefined) return publishTab;
    try {
      const currentTab = tab?.id !== undefined
        ? tab
        : await extension.invoke("chrome:tabs:current").catch((error) => {
            console.warn("[发布] 获取当前标签失败，准备无 opener 创建发布页", error);
            return undefined;
          });

      const createdTab = await ensureXhsCreatorTab(extension, currentTab, undefined, false);
      const resolvedTab = createdTab?.id !== undefined
        ? await waitForTabReady(extension, createdTab.id, 15000).catch(() => createdTab)
        : createdTab;
      setPublishTab(resolvedTab);
      return resolvedTab;
    } catch (err) {
      console.error('[发布] 创建发布标签页失败', err);
      return null;
    }
  }, [extension, tab, publishTab]);

  useEffect(() => {
    if (!extension) return;
    const update = (params: { payload: { tabId: number; tab: BrowserTab } }) => {
      if (params.payload.tabId === publishTab?.id) {
        setPublishTab(params.payload.tab);
      }
    };
    const remove = (params: { payload: { tabId: number } }) => {
      if (params.payload.tabId === publishTab?.id) {
        setPublishTab(undefined);
      }
    };
    extension.event.on("chrome:tabs:onUpdated", update);
    extension.event.on("chrome:tabs:onRemoved", remove);
    return () => {
      extension.event.off("chrome:tabs:onUpdated", update);
      extension.event.off("chrome:tabs:onRemoved", remove);
    };
  }, [extension, publishTab?.id]);

  useEffect(() => {
    if (!extension || publishTab?.id === undefined) return;
    const tabId = publishTab.id;
    const deal = () => {
      extension.invoke("chrome:tabs:remove", { tabIds: [tabId] }).catch(console.error);
    };
    window.addEventListener("beforeunload", deal);
    return () => window.removeEventListener("beforeunload", deal);
  }, [extension, publishTab?.id]);

  const publish = async (title: string, content: string, tags: string[], files: File[]): Promise<XhsOperationResult> => {
    console.log('[发布] 开始发布流程');
    console.log('[发布] extension:', extension ? '已连接' : '未连接');
    console.log('[发布] publishTab:', publishTab);
    console.log('[发布] tab.id:', publishTab?.id);

    if (!extension) {
      const result = {
        success: false,
        code: "extension_unavailable" as const,
        message: "插件未连接，请先安装并连接浏览器扩展。",
      };
      setStatusMessage(result.message);
      console.log('[发布] 失败：插件未连接');
      return result;
    }

    const normalizedTitle = String(title || '').trim();
    if (normalizedTitle.length > TITLE_MAX_LENGTH) {
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: `发布已阻止: 标题超过 ${TITLE_MAX_LENGTH} 个字，请先精简标题。`,
      };
      setStatusMessage(result.message);
      return result;
    }

    setIsPublishing(true);
    setStatusMessage("准备发布环境...");
    const publishTags = normalizeXhsTags(tags);

    let currentPublishTab = publishTab;
    if (!currentPublishTab) {
      setStatusMessage("正在创建发布标签页...");
      console.log('[发布] 创建新发布标签页');
      currentPublishTab = await createPublishTab();
      console.log('[发布] createPublishTab 完成，currentPublishTab:', currentPublishTab);
      if (currentPublishTab?.id !== undefined) {
        console.log('[发布] 等待页面加载...');
        currentPublishTab = await waitForTabReady(extension, currentPublishTab.id, 15000).catch(() => currentPublishTab);
        console.log('[发布] 等待完成');
      }
    }

    if (!currentPublishTab?.id) {
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: "发布出错: 无法获取发布页面。",
      };
      setStatusMessage(result.message);
      setIsPublishing(false);
      return result;
    }

    const loginStatus = await detectXhsLogin(extension, currentPublishTab.id);
    if (!loginStatus.loggedIn) {
      const result = {
        success: false,
        code: "xhs_login_required" as const,
        message: `发布已阻止: ${loginStatus.message}`,
      };
      setStatusMessage(result.message);
      setIsPublishing(false);
      return result;
    }

    setStatusMessage("正在注入图片...");
    console.log('[发布] 开始注入图片');

    try {
      const payload: Array<{ name: string; type: string; base64: string }> = [];

      for (const file of files) {
        const buffer = await file.arrayBuffer();
        payload.push({
          name: file.name,
          type: file.type || "image/*",
          base64: arrayBufferToBase64(buffer),
        });
      }

      console.log('[发布] 调用 web:runtime:evaluate 注入图片, tabId:', currentPublishTab.id);

      const resp = await extension.invoke("web:runtime:evaluate", {
        tabId: currentPublishTab.id,
        args: [payload],
        code: uploadXhsImageFilesInPage.toString(),
      });

      console.log('[发布] 图片注入响应:', resp);

      const result = resp?.[0]?.result?.data as RuntimeEvaluateResult | undefined;
      console.log('[发布] 图片注入结果:', result);
      if (!result?.success) {
        throw new Error(result?.message || "图片注入失败");
      }

      setStatusMessage("正在填充标题和内容...");

      console.log('[发布] 填充标题和内容, tabId:', currentPublishTab.id);

      const setResp = await extension.invoke("web:runtime:evaluate", {
        tabId: currentPublishTab.id,
        args: [title, content, publishTags],
        code: fillXhsPublishTextInPage.toString(),
      });

      console.log('[发布] 填充响应:', setResp);

      const setResult = setResp?.[0]?.result?.data as RuntimeEvaluateResult | undefined;
      console.log('[发布] 填充结果:', setResult);
      if (!setResult?.success) {
        throw new Error(setResult?.message || "标题和内容填充失败");
      }

      setStatusMessage("正在发布...");

      console.log('[发布] 点击发布按钮, tabId:', currentPublishTab.id);

      const clickResp = await extension.invoke("web:runtime:evaluate", {
        tabId: currentPublishTab.id,
        args: [],
        code: clickXhsPublishButtonInPage.toString(),
      });

      console.log('[发布] 发布按钮点击响应:', clickResp);

      const clickResult = clickResp?.[0]?.result?.data as RuntimeEvaluateResult | undefined;
      console.log('[发布] 发布按钮点击结果:', clickResult);
      if (!clickResult?.success) {
        throw new Error(clickResult?.message || "发布失败");
      }

      const clickPoint = clickResult.data;
      if (!clickPoint) {
        throw new Error(clickResult?.message || "无法定位发布按钮坐标");
      }

      if (clickPoint.action !== 'event') {
        if (clickPoint.x === undefined || clickPoint.y === undefined) {
          throw new Error(clickResult?.message || "无法定位发布按钮坐标");
        }
        console.log('[发布] 调用 chrome:debugger:dispatchMouseClick, tabId:', currentPublishTab.id, 'point:', clickPoint);
        const mouseResp = await extension.invoke("chrome:debugger:dispatchMouseClick", {
          tabId: currentPublishTab.id,
          x: Math.round(clickPoint.x),
          y: Math.round(clickPoint.y),
        });
        console.log('[发布] 鼠标点击响应:', mouseResp);
      } else {
        console.log('[发布] 已通过页面发布事件触发，无需坐标点击:', clickPoint);
      }

      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      const verifyResp = await extension.invoke("web:runtime:evaluate", {
        tabId: currentPublishTab.id,
        args: [],
        code: (() => {
          const getVisibleText = (selector: string) => Array.from(document.querySelectorAll(selector))
            .filter((node): node is HTMLElement => node instanceof HTMLElement && (() => {
              let current: HTMLElement | null = node;
              while (current) {
                const style = window.getComputedStyle(current);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                  return false;
                }
                current = current.parentElement;
              }
              const rect = node.getBoundingClientRect();
              return rect.width > 0 || rect.height > 0 || Boolean(node.offsetParent);
            })())
            .map((node) => (node.textContent || '').trim())
            .filter(Boolean);
          const candidates = [
            ...getVisibleText('.d-text-red'),
            ...getVisibleText('.error-text'),
            ...getVisibleText('.toast'),
            ...getVisibleText('[class*="error"]'),
            ...getVisibleText('[class*="toast"]'),
            ...getVisibleText('[class*="message"]'),
          ];
          const validationMessages = Array.from(new Set(candidates)).filter((text) => (
            text.includes('标题')
            || text.includes('正文')
            || text.includes('内容')
            || text.includes('图片')
            || text.includes('上传')
            || text.includes('话题')
            || text.includes('超过')
            || text.includes('请输入')
            || text.includes('不能为空')
            || text.includes('字')
            || text.includes('失败')
          ));
          return { success: validationMessages.length === 0, message: validationMessages[0] || 'ok' };
        }).toString(),
      });

      const verifyResult = verifyResp?.[0]?.result?.data as RuntimeEvaluateResult | undefined;
      console.log('[发布] 点击后校验结果:', verifyResult);
      if (!verifyResult?.success) {
        throw new Error(verifyResult?.message || "发布后校验失败");
      }

      setStatusMessage("发布指令已发送");
      return {
        success: true,
        message: "发布指令已发送，请回到小红书页面确认结果。",
      };
    } catch (err: any) {
      console.error('[发布] 捕获到错误:', err);
      console.error('[发布] 错误详情:', err.message);
      console.error('[发布] 错误堆栈:', err.stack);
      const result = {
        success: false,
        code: "page_interaction_failed" as const,
        message: `发布出错: ${err.message}`,
      };
      setStatusMessage(result.message);
      return result;
    } finally {
      setIsPublishing(false);
    }
  };

  return { publish, isPublishing, statusMessage, createPublishTab };
};
