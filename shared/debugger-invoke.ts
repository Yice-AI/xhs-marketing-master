export type DebuggerCommandParams = Record<string, unknown> | undefined;

export type DebuggerTargetLike = {
  tabId?: number;
  targetId?: string;
};

export type DebuggerApiLike = {
  attach: (target: DebuggerTargetLike, version: string) => Promise<void>;
  detach: (target: DebuggerTargetLike) => Promise<void>;
  getTargets: () => Promise<Array<object>>;
  sendCommand: (
    target: DebuggerTargetLike,
    method: string,
    commandParams?: DebuggerCommandParams,
  ) => Promise<object | undefined>;
};

type LoggerLike = {
  warn?: (...args: unknown[]) => void;
};

const getErrorMessage = (error: unknown) => (
  error instanceof Error
    ? error.message
    : String(error || "")
);

export const isIgnorableDebuggerError = (error: unknown, expected: "already_attached" | "not_attached") => {
  const message = getErrorMessage(error).toLowerCase();
  if (expected === "already_attached") {
    return message.includes("already attached");
  }
  return message.includes("not attached");
};

export const createChromeDebuggerHandlers = (debuggerApi: DebuggerApiLike, logger?: LoggerLike) => ({
  attach: async (target: DebuggerTargetLike, requiredVersion: string) => {
    try {
      await debuggerApi.attach(target, requiredVersion);
    } catch (error) {
      if (!isIgnorableDebuggerError(error, "already_attached")) {
        throw error;
      }
    }
  },
  detach: async (target: DebuggerTargetLike) => {
    try {
      await debuggerApi.detach(target);
    } catch (error) {
      if (!isIgnorableDebuggerError(error, "not_attached")) {
        throw error;
      }
    }
  },
  getTargets: async () => debuggerApi.getTargets(),
  sendCommand: async (
    target: DebuggerTargetLike,
    method: string,
    commandParams?: DebuggerCommandParams,
  ) => debuggerApi.sendCommand(target, method, commandParams),
  warnOnDetachFailure: (error: unknown) => {
    if (!isIgnorableDebuggerError(error, "not_attached")) {
      logger?.warn?.("debugger detach failed", error);
    }
  },
});
