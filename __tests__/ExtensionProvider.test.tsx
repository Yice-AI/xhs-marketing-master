import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { ExtensionProvider, useExtension } from '../src/hooks/useExtension';

const Probe = () => {
  const { extension } = useExtension();
  return <div data-testid="extension-name">{extension?.name || 'missing'}</div>;
};

const legacyExtension = {
  id: 'legacy-extension-id',
  name: 'browser-client-monorepo',
  version: '1.0.0',
  invoke: vi.fn().mockResolvedValue(undefined),
  event: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
  network: {
    hook: {
      xhr: { send: { on: vi.fn(), off: vi.fn(), hook: {} } },
      fetch: {
        request: { on: vi.fn(), off: vi.fn(), hook: {} },
        response: { on: vi.fn(), off: vi.fn(), hook: {} },
      },
    },
  },
};

describe('ExtensionProvider', () => {
  afterEach(() => {
    delete (window as any)['xhs-marketing-extension'];
    delete (window as any)['browser-client-monorepo'];
    delete (window as any)['_xhs-marketing-extension'];
    delete (window as any)['_browser-client-monorepo'];
    delete (window as any).__xhsMarketingDomBridgeClient__;
    document.documentElement.removeAttribute('data-xhs-marketing-extension');
    vi.clearAllMocks();
  });

  it('detects the legacy extension object name as a fallback', async () => {
    (window as any)['browser-client-monorepo'] = legacyExtension;

    render(
      <ExtensionProvider>
        <Probe />
      </ExtensionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('extension-name').textContent).toBe('browser-client-monorepo');
    });
  });

  it('shows missing when no page bridge is available', async () => {
    render(
      <ExtensionProvider>
        <Probe />
      </ExtensionProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('extension-name').textContent).toBe('missing');
    });
  });
});
