import { describe, expect, it, vi } from 'vitest';

import { createChromeDebuggerHandlers, isIgnorableDebuggerError } from './debugger-invoke';

describe('debugger invoke helpers', () => {
  it('ignores already attached and not attached debugger errors', () => {
    expect(isIgnorableDebuggerError(new Error('Debugger is already attached to the target'), 'already_attached')).toBe(true);
    expect(isIgnorableDebuggerError(new Error('Debugger is not attached to the target'), 'not_attached')).toBe(true);
    expect(isIgnorableDebuggerError(new Error('Something else failed'), 'already_attached')).toBe(false);
  });

  it('normalizes attach and detach calls while keeping sendCommand/getTargets intact', async () => {
    const debuggerApi = {
      attach: vi.fn()
        .mockRejectedValueOnce(new Error('already attached'))
        .mockResolvedValueOnce(undefined),
      detach: vi.fn()
        .mockRejectedValueOnce(new Error('not attached'))
        .mockResolvedValueOnce(undefined),
      getTargets: vi.fn().mockResolvedValue([{ id: 'target-1' }]),
      sendCommand: vi.fn().mockResolvedValue({ ok: true }),
    };

    const handlers = createChromeDebuggerHandlers(debuggerApi);

    await expect(handlers.attach({ tabId: 1 }, '1.3')).resolves.toBeUndefined();
    await expect(handlers.attach({ tabId: 2 }, '1.3')).resolves.toBeUndefined();
    await expect(handlers.detach({ tabId: 1 })).resolves.toBeUndefined();
    await expect(handlers.detach({ tabId: 2 })).resolves.toBeUndefined();
    await expect(handlers.getTargets()).resolves.toEqual([{ id: 'target-1' }]);
    await expect(handlers.sendCommand({ tabId: 1 }, 'Input.dispatchMouseEvent', { x: 1, y: 2 })).resolves.toEqual({ ok: true });
  });
});
