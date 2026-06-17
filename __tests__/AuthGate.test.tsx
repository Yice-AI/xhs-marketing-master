import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AuthGate from '../components/AuthGate';

const { loginMock, registerMock, fetchMock } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  registerMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    login: loginMock,
    register: registerMock,
  }),
}));

const createAxiosLikeError = (overrides: Record<string, unknown> = {}) => ({
  isAxiosError: true,
  message: 'Request failed',
  response: {
    data: {},
    status: 500,
  },
  ...overrides,
});

describe('AuthGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        latestVersion: '0.1.0',
        minSupportedVersion: '0.1.0',
        downloadUrl: '/downloads/crx-xhs-marketing-extension-0.1.0.zip',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('renders a readable message when login returns validation details', async () => {
    loginMock.mockRejectedValue(createAxiosLikeError({
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
    }));

    render(<AuthGate />);

    fireEvent.change(screen.getByPlaceholderText('输入用户名'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 位'), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: '登录工作台' }));

    await waitFor(() => {
      expect(screen.getByText('密码不能少于 8 位')).toBeTruthy();
    });
  });

  it('renders 401 detail strings without crashing', async () => {
    loginMock.mockRejectedValue(createAxiosLikeError({
      response: {
        data: {
          detail: '用户名或密码错误',
        },
        status: 401,
      },
    }));

    render(<AuthGate />);

    fireEvent.change(screen.getByPlaceholderText('输入用户名'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 位'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: '登录工作台' }));

    await waitFor(() => {
      expect(screen.getByText('用户名或密码错误')).toBeTruthy();
    });
  });

  it('renders register validation errors as readable text', async () => {
    registerMock.mockRejectedValue(createAxiosLikeError({
      response: {
        data: {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'email'],
              msg: 'value is not a valid email address',
            },
          ],
        },
        status: 422,
      },
    }));

    render(<AuthGate />);

    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    fireEvent.change(screen.getByPlaceholderText('输入用户名'), { target: { value: 'tester' } });
    fireEvent.change(screen.getByPlaceholderText('可选，用于找回和运营通知'), { target: { value: 'invalid-email' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 位'), { target: { value: '12345678' } });
    fireEvent.click(screen.getByRole('button', { name: '注册并进入' }));

    await waitFor(() => {
      expect(screen.getByText('邮箱格式不正确')).toBeTruthy();
    });
  });
});
