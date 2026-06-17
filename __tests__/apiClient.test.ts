import { AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import apiClient, { AuthRequiredError, getAuthRequiredEventName, normalizeAppErrorMessage } from '../services/apiClient';

const createAxiosLikeError = (overrides: Record<string, unknown> = {}) => ({
  isAxiosError: true,
  message: 'Request failed',
  response: {
    data: {},
    status: 500,
  },
  ...overrides,
});

describe('normalizeAppErrorMessage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns string detail messages directly', () => {
    const error = createAxiosLikeError({
      response: {
        data: {
          detail: '用户名或密码错误',
        },
        status: 401,
      },
    });

    expect(normalizeAppErrorMessage(error)).toBe('用户名或密码错误');
  });

  it('formats FastAPI validation detail arrays into readable text', () => {
    const error = createAxiosLikeError({
      response: {
        data: {
          detail: [
            {
              type: 'string_too_short',
              loc: ['body', 'password'],
              msg: 'String should have at least 8 characters',
              ctx: { min_length: 8 },
            },
          ],
        },
        status: 422,
      },
    });

    expect(normalizeAppErrorMessage(error)).toBe('密码不能少于 8 位');
  });

  it('extracts readable messages from object-shaped detail payloads', () => {
    const error = createAxiosLikeError({
      response: {
        data: {
          detail: {
            message: '对象格式的错误信息',
          },
        },
        status: 400,
      },
    });

    expect(normalizeAppErrorMessage(error)).toBe('对象格式的错误信息');
  });

  it('falls back to axios error.message when payload has no readable detail', () => {
    const error = createAxiosLikeError({
      message: 'Request failed with status code 500',
    });

    expect(normalizeAppErrorMessage(error)).toBe('Request failed with status code 500');
  });

  it('falls back to Error.message for non-axios errors', () => {
    expect(normalizeAppErrorMessage(new Error('普通异常'))).toBe('普通异常');
  });
});

describe('apiClient interview helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts interview start with the dedicated timeout', async () => {
    const postMock = vi.spyOn((apiClient as any).client, 'post').mockResolvedValue({
      data: {
        session_id: 'session-1',
        action: 'ask',
        message: {
          type: 'text',
          content: '你好',
        },
      },
    });

    await apiClient.startInterview();

    expect(postMock).toHaveBeenCalledWith('/interview/start', {}, {
      timeout: 60000,
    });
  });

  it('posts interview messages with the dedicated timeout', async () => {
    const postMock = vi.spyOn((apiClient as any).client, 'post').mockResolvedValue({
      data: {
        action: 'ask',
        message: {
          type: 'text',
          content: '继续说说',
        },
      },
    });

    await apiClient.sendInterviewMessage('session-2', '我想做获客');

    expect(postMock).toHaveBeenCalledWith('/interview/message', {
      session_id: 'session-2',
      message: '我想做获客',
    }, {
      timeout: 60000,
    });
  });

  it('injects Authorization headers for interview requests', async () => {
    window.localStorage.setItem('xhs_access_token', 'token-123');
    const requestInterceptor = (apiClient as any).client.interceptors.request.handlers[0].fulfilled;

    const nextConfig = await requestInterceptor({
      url: '/interview/start',
      headers: {},
    });

    const headers = AxiosHeaders.from(nextConfig.headers || {});
    expect(headers.get('Authorization')).toBe('Bearer token-123');
  });

  it('rejects unauthenticated interview requests with AuthRequiredError', async () => {
    const authRequiredListener = vi.fn();
    window.addEventListener(getAuthRequiredEventName(), authRequiredListener);
    const requestInterceptor = (apiClient as any).client.interceptors.request.handlers[0].fulfilled;

    await expect(requestInterceptor({
      url: '/interview/start',
      headers: {},
    })).rejects.toBeInstanceOf(AuthRequiredError);

    expect(authRequiredListener).toHaveBeenCalledTimes(1);
    window.removeEventListener(getAuthRequiredEventName(), authRequiredListener);
  });

  it('turns interview 401 responses into AuthRequiredError', async () => {
    window.localStorage.setItem('xhs_access_token', 'token-123');
    const authRequiredListener = vi.fn();
    window.addEventListener(getAuthRequiredEventName(), authRequiredListener);
    const responseRejected = (apiClient as any).client.interceptors.response.handlers[0].rejected;

    await expect(responseRejected(createAxiosLikeError({
      config: { url: '/interview/message' },
      response: {
        data: {
          detail: '登录态已失效，请重新登录',
        },
        status: 401,
      },
    }))).rejects.toMatchObject({
      name: 'AuthRequiredError',
      message: '登录态已失效，请重新登录后继续访谈。',
    });

    expect(window.localStorage.getItem('xhs_access_token')).toBeNull();
    expect(authRequiredListener).toHaveBeenCalledTimes(1);
    window.removeEventListener(getAuthRequiredEventName(), authRequiredListener);
  });
});
