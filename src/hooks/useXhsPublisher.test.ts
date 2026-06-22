import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clickXhsPublishButtonInPage, fillXhsPublishTextInPage, uploadXhsImageFilesInPage } from './useXhsPublisher';

const setVisibleRect = (element: HTMLElement, rect: Partial<DOMRect> = {}) => {
  element.getBoundingClientRect = vi.fn(() => ({
    x: 700,
    y: 640,
    top: 640,
    left: 700,
    right: 780,
    bottom: 680,
    width: 80,
    height: 40,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect));
};

const installExecCommandMock = () => {
  document.execCommand = vi.fn((command: string, _showUI?: boolean, value?: string) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return false;
    if (command === 'selectAll') {
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.value = '';
      } else {
        active.textContent = '';
      }
      return true;
    }
    if (command === 'insertText') {
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.value += value || '';
      } else {
        active.textContent = `${active.textContent || ''}${value || ''}`;
      }
      return true;
    }
    return false;
  });
};

describe('clickXhsPublishButtonInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('finds the publish button even when XHS changes color classes', async () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'publish-page-publish-btn';
    const button = document.createElement('button');
    button.className = 'css-2026-primary';
    button.textContent = '发布';
    setVisibleRect(button);
    const clickSpy = vi.spyOn(button, 'click');
    wrapper.appendChild(button);
    document.body.appendChild(wrapper);

    const result = await clickXhsPublishButtonInPage();

    expect(result.success).toBe(true);
    expect(result.message).toContain('已定位发布按钮');
    expect(result.data?.kind).toBe('button');
    expect(result.data?.action).toBe('coordinate');
    expect(result.data?.x).toBeGreaterThan(0);
    expect(result.data?.y).toBeGreaterThan(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('falls back to button text when the legacy publish container is absent', async () => {
    const draftButton = document.createElement('button');
    draftButton.textContent = '保存草稿';
    setVisibleRect(draftButton, { left: 520, top: 640 });
    const publishButton = document.createElement('button');
    publishButton.className = 'reds-button primary';
    publishButton.textContent = '立即发布';
    setVisibleRect(publishButton, { left: 720, top: 640 });
    const publishSpy = vi.spyOn(publishButton, 'click');
    document.body.append(draftButton, publishButton);

    const result = await clickXhsPublishButtonInPage();

    expect(result.success).toBe(true);
    expect(result.message).toContain('已定位发布按钮');
    expect(result.data?.kind).toBe('button');
    expect(result.data?.action).toBe('coordinate');
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('surfaces validation copy when the publish button is disabled', async () => {
    const button = document.createElement('button');
    button.textContent = '发布';
    button.setAttribute('aria-disabled', 'true');
    setVisibleRect(button);
    const validation = document.createElement('div');
    validation.className = 'd-text-red';
    validation.textContent = '请输入正文内容';
    setVisibleRect(validation);
    document.body.append(button, validation);

    const result = await clickXhsPublishButtonInPage();

    expect(result).toEqual({ success: false, message: '请输入正文内容' });
  });

  it('uses the xhs publish host event when the real button lives in closed shadow dom', async () => {
    const host = document.createElement('xhs-publish-btn');
    host.setAttribute('submit-text', '发布');
    host.setAttribute('save-draft', '暂存离开');
    setVisibleRect(host, { left: 960, top: 80, width: 120, height: 40 });
    const publishSpy = vi.fn();
    Object.defineProperty(host, '_onPublish', {
      value: publishSpy,
      configurable: true,
    });
    document.body.appendChild(host);

    const result = await clickXhsPublishButtonInPage();

    expect(result.success).toBe(true);
    expect(result.message).toContain('已通过发布宿主组件触发发布事件');
    expect(result.data?.kind).toBe('host');
    expect(result.data?.action).toBe('event');
    expect(result.data?.x).toBeUndefined();
    expect(publishSpy).toHaveBeenCalledOnce();
  });

  it('dispatches the host publish event when the host method is not exposed', async () => {
    const host = document.createElement('xhs-publish-btn');
    host.setAttribute('submit-text', '发布');
    setVisibleRect(host, { left: 960, top: 80, width: 120, height: 40 });
    const publishListener = vi.fn();
    host.addEventListener('publish', publishListener);
    document.body.appendChild(host);

    const result = await clickXhsPublishButtonInPage();

    expect(result.success).toBe(true);
    expect(result.message).toContain('已向发布宿主组件派发发布事件');
    expect(result.data?.kind).toBe('host');
    expect(result.data?.action).toBe('event');
    expect(publishListener).toHaveBeenCalledOnce();
  });
});

describe('fillXhsPublishTextInPage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    installExecCommandMock();
  });

  it('waits for the XHS editor to appear before filling title and content', async () => {
    vi.useFakeTimers();
    const fill = fillXhsPublishTextInPage('验证标题', '验证正文内容', []);

    await vi.advanceTimersByTimeAsync(900);
    const titleWrapper = document.createElement('div');
    titleWrapper.className = 'd-input';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleWrapper.appendChild(titleInput);

    const editorWrapper = document.createElement('div');
    editorWrapper.className = 'editor-container';
    const editor = document.createElement('div');
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('contenteditable', 'true');
    editorWrapper.appendChild(editor);
    document.body.append(titleWrapper, editorWrapper);

    await vi.advanceTimersByTimeAsync(1000);
    const result = await fill;

    expect(result.success).toBe(true);
    expect(result.message).toBe('标题/内容已填充');
    expect(titleInput.value).toBe('验证标题');
    expect(editor.textContent).toContain('验证正文内容');
  });

  it('returns a clear timeout message when the publish editor never appears', async () => {
    vi.useFakeTimers();
    const fill = fillXhsPublishTextInPage('验证标题', '验证正文内容', []);

    await vi.advanceTimersByTimeAsync(31000);
    const result = await fill;

    expect(result).toEqual({
      success: false,
      message: '等待发布编辑区超时，标题/正文输入框未出现',
    });
  });
});

describe('uploadXhsImageFilesInPage', () => {
  const payload = [{ name: 'image_0.png', type: 'image/png', base64: 'AA==' }];

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();

    Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
      configurable: true,
      get() {
        return (this as HTMLInputElement & { __xhsFiles?: File[] }).__xhsFiles || null;
      },
      set(value) {
        (this as HTMLInputElement & { __xhsFiles?: File[] }).__xhsFiles = value as File[];
      },
    });

    class DataTransferMock {
      private filesList: File[] = [];

      items = {
        add: (file: File) => {
          this.filesList.push(file);
        },
      };

      get files() {
        return this.filesList;
      }
    }

    Object.defineProperty(globalThis, 'DataTransfer', {
      configurable: true,
      value: DataTransferMock,
    });
  });

  it('waits for the XHS upload input to render before injecting files', async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const upload = uploadXhsImageFilesInPage(payload);

    await vi.advanceTimersByTimeAsync(350);
    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'upload-input';
    input.addEventListener('change', changed);
    document.body.appendChild(input);

    await vi.advanceTimersByTimeAsync(2000);
    const result = await upload;

    expect(result.success).toBe(true);
    expect(result.message).toContain('已注入 1 张图片');
    expect(input.files?.[0]?.name).toBe('image_0.png');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('finds file inputs inside open shadow DOM upload components', async () => {
    vi.useFakeTimers();
    const host = document.createElement('xhs-upload');
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    input.type = 'file';
    shadow.appendChild(input);
    document.body.appendChild(host);

    const upload = uploadXhsImageFilesInPage(payload);
    await vi.advanceTimersByTimeAsync(1600);
    const result = await upload;

    expect(result.success).toBe(true);
    expect(input.files?.[0]?.name).toBe('image_0.png');
  });
});
