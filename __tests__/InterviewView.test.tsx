import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InterviewView from '../components/InterviewView';
import { AuthRequiredError } from '../services/apiClient';

const { startInterviewMock, sendInterviewMessageMock, clearStateMock, initialInterviewStateFactoryMock } = vi.hoisted(() => ({
  startInterviewMock: vi.fn(),
  sendInterviewMessageMock: vi.fn(),
  clearStateMock: vi.fn(),
  initialInterviewStateFactoryMock: vi.fn(),
}));

const buildInitialInterviewState = () => ({
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
});

vi.mock('../services/apiClient', async () => {
  const actual = await vi.importActual<typeof import('../services/apiClient')>('../services/apiClient');
  return {
    ...actual,
    apiClient: {
      startInterview: startInterviewMock,
      sendInterviewMessage: sendInterviewMessageMock,
    },
    default: {
      startInterview: startInterviewMock,
      sendInterviewMessage: sendInterviewMessageMock,
    },
  };
});

vi.mock('../contexts/PersistenceContext', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  return {
    usePersistence: () => {
      const [interviewState, setInterviewState] = ReactModule.useState(initialInterviewStateFactoryMock());
      return {
        interviewState,
        setInterviewState,
        clearState: () => {
          clearStateMock();
          setInterviewState(buildInitialInterviewState());
        },
      };
    },
  };
});

describe('InterviewView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initialInterviewStateFactoryMock.mockImplementation(buildInitialInterviewState);
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('starts the interview through apiClient and renders the first prompt', async () => {
    startInterviewMock.mockResolvedValue({
      session_id: 'session-1',
      action: 'ask',
      message: {
        type: 'single_choice',
        content: '你这次最想让笔记帮你达成什么？',
        options: ['带来成交', '先聊现状'],
      },
      steps: [{ id: '1', label: '目标对齐', status: 'active' }],
      collected_info: {},
    });

    render(<InterviewView onComplete={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(startInterviewMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('你这次最想让笔记帮你达成什么？')).toBeTruthy();
      expect(screen.getByText('带来成交')).toBeTruthy();
    });
  });

  it('sends option replies through apiClient.sendInterviewMessage', async () => {
    startInterviewMock.mockResolvedValue({
      session_id: 'session-2',
      action: 'ask',
      message: {
        type: 'single_choice',
        content: '你更接近哪一种目标？',
        options: ['直接带来咨询', '先聊现状'],
      },
      steps: [{ id: '1', label: '目标对齐', status: 'active' }],
    });
    sendInterviewMessageMock.mockResolvedValue({
      action: 'ask',
      message: {
        type: 'text',
        content: '为什么你现在特别想发这篇？',
      },
      steps: [
        { id: '1', label: '目标对齐', status: 'completed' },
        { id: '2', label: '动机挖掘', status: 'active' },
      ],
      collected_info: {
        marketing_goal: '直接带来咨询',
      },
    });

    render(<InterviewView onComplete={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('直接带来咨询')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '直接带来咨询' }));

    await waitFor(() => {
      expect(sendInterviewMessageMock).toHaveBeenCalledWith('session-2', '直接带来咨询');
      expect(screen.getByText('为什么你现在特别想发这篇？')).toBeTruthy();
    });
  });

  it('shows auth-required messaging instead of a generic failure', async () => {
    startInterviewMock.mockRejectedValue(new AuthRequiredError('请先登录工作台后再开始访谈。'));

    render(<InterviewView onComplete={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('请先登录工作台后再开始访谈。')).toBeTruthy();
    });
  });

  it('restarts the interview when the session expires with 404', async () => {
    startInterviewMock
      .mockResolvedValueOnce({
        session_id: 'session-3',
        action: 'ask',
        message: {
          type: 'single_choice',
          content: '你更想做成交还是涨粉？',
          options: ['成交', '涨粉'],
        },
        steps: [{ id: '1', label: '目标对齐', status: 'active' }],
      })
      .mockResolvedValueOnce({
        session_id: 'session-4',
        action: 'ask',
        message: {
          type: 'single_choice',
          content: '会话已重连，我们继续。你更想做成交还是涨粉？',
          options: ['成交', '涨粉'],
        },
        steps: [{ id: '1', label: '目标对齐', status: 'active' }],
      });
    sendInterviewMessageMock.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 404,
        data: {
          detail: '会话不存在或已过期，请刷新页面重新开始',
        },
      },
    });

    render(<InterviewView onComplete={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('成交')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: '成交' }));

    await waitFor(() => {
      expect(clearStateMock).toHaveBeenCalledTimes(1);
      expect(alert).toHaveBeenCalledWith('会话已过期，将为您重新连接。');
      expect(startInterviewMock).toHaveBeenCalledTimes(2);
      expect(screen.getByText('会话已重连，我们继续。你更想做成交还是涨粉？')).toBeTruthy();
    });
  });

  it('shows timeout and backend detail messages when sending fails', async () => {
    startInterviewMock.mockResolvedValue({
      session_id: 'session-5',
      action: 'ask',
      message: {
        type: 'text',
        content: '最近发生了什么，让你特别想发这篇？',
      },
      steps: [{ id: '1', label: '目标对齐', status: 'active' }],
    });

    sendInterviewMessageMock
      .mockRejectedValueOnce({
        isAxiosError: true,
        code: 'ECONNABORTED',
        response: {
          status: 504,
          data: {
            detail: '访谈模型响应超时，请稍后重试。',
          },
        },
      })
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 502,
          data: {
            detail: '',
          },
        },
      });

    render(<InterviewView onComplete={vi.fn()} onCancel={vi.fn()} />);

    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '最近线索质量掉得很明显' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(screen.getByText('这一轮访谈响应超时了，请再发一次，我会继续从当前上下文接着聊。')).toBeTruthy();
    });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '我想确认是不是内容方向错了' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));

    await waitFor(() => {
      expect(screen.getByText('正文生成暂时失败了，请稍后重试。')).toBeTruthy();
    });
  });

  it('locks title submission locally to avoid duplicate requests', async () => {
    initialInterviewStateFactoryMock.mockReturnValue({
      ...buildInitialInterviewState(),
      sessionId: 'session-6',
      messages: [{
        id: 'assistant-1',
        role: 'assistant',
        content: '我整理了几个标题给你选。',
        timestamp: new Date().toISOString(),
      }],
      titleOptions: [
        { id: 1, title: '标题一', style: '专业', rationale: '理由一' },
        { id: 2, title: '标题二', style: '痛点', rationale: '理由二' },
      ],
      steps: [{ id: '1', label: '生成内容', status: 'active' }],
      collectedInfo: {
        marketing_goal: '获客',
      },
    });
    let resolveSend: ((value: any) => void) | null = null;
    sendInterviewMessageMock.mockImplementation(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    render(<InterviewView onComplete={vi.fn()} onCancel={vi.fn()} />);

    const titleButton = screen.getByRole('button', { name: /标题一/ });
    fireEvent.click(titleButton);
    fireEvent.click(titleButton);

    await waitFor(() => {
      expect(sendInterviewMessageMock).toHaveBeenCalledTimes(1);
      expect(sendInterviewMessageMock).toHaveBeenCalledWith('session-6', '[选择标题] 标题一');
    });

    resolveSend?.({
      action: 'complete',
      message: {
        type: 'text',
        content: '完美！这是为你生成的小红书内容：',
      },
      result: {
        title: '标题一',
        content: '这是正文',
        collected_info: {
          product_name: 'Uplog',
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByText('完美！这是为你生成的小红书内容：')).toBeTruthy();
    });
  });
});
