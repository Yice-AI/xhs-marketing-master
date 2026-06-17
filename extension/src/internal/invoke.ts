import {
  EXTENSION_CONSTANT,
  ExtensionClient,
  ExtensionInvokeParams,
  ExtensionInvokeResponse,
  ExtensionInvokeType,
  ServiceWorkerFetchResponse,
} from "@shared/extension-contract";
import { createChromeDebuggerHandlers } from "@shared/debugger-invoke";
import { arrayBufferToBase64 } from "@shared/extension-utils";

import logger from "@/lib/logger";
import { trustRegistry } from "@/internal/trust";

const debuggerHandlers = createChromeDebuggerHandlers(chrome.debugger, logger);

export type InvokeTransportMessage<T extends ExtensionInvokeType> = {
  type: typeof EXTENSION_CONSTANT.extension.invoke.transport.message.type;
  invoke: T;
  params: ExtensionInvokeParams<T>;
};

const tabsHandlers = {
  "chrome:tabs:current": async (_params: undefined, sender?: chrome.runtime.MessageSender) => sender?.tab,
  "chrome:tabs:create": async (params: ExtensionInvokeParams<"chrome:tabs:create">) => {
    const { url, ...rest } = params.createProperties;
    if (params.createProperties.openerTabId !== undefined) {
      const opener = await chrome.tabs.get(params.createProperties.openerTabId);
      const emptyTab = await chrome.tabs.create(rest as chrome.tabs.CreateProperties);
      if (trustRegistry.isTrustedTab(opener)) {
        trustRegistry.addTab(emptyTab);
      }
      return (await chrome.tabs.update(emptyTab.id, { url })) || emptyTab;
    }

    const created = await chrome.tabs.create(params.createProperties as chrome.tabs.CreateProperties);
    if (trustRegistry.isTrustedTab(created)) {
      trustRegistry.addTab(created);
    }
    return created;
  },
  "chrome:tabs:get": (params: ExtensionInvokeParams<"chrome:tabs:get">) => chrome.tabs.get(params.tabId),
  "chrome:tabs:query": (params: ExtensionInvokeParams<"chrome:tabs:query">) =>
    chrome.tabs.query(params.queryInfo as chrome.tabs.QueryInfo),
  "chrome:tabs:remove": (params: ExtensionInvokeParams<"chrome:tabs:remove">) => chrome.tabs.remove(params.tabIds),
  "chrome:tabs:update": (params: ExtensionInvokeParams<"chrome:tabs:update">) =>
    chrome.tabs.update(params.tabId, params.updateProperties as chrome.tabs.UpdateProperties),
  "chrome:debugger:attach": (params: ExtensionInvokeParams<"chrome:debugger:attach">) =>
    debuggerHandlers.attach(params.target, params.requiredVersion),
  "chrome:debugger:detach": (params: ExtensionInvokeParams<"chrome:debugger:detach">) =>
    debuggerHandlers.detach(params),
  "chrome:debugger:getTargets": () => debuggerHandlers.getTargets(),
  "chrome:debugger:sendCommand": (params: ExtensionInvokeParams<"chrome:debugger:sendCommand">) =>
    debuggerHandlers.sendCommand(params.target, params.method, params.commandParams),
  "chrome:debugger:dispatchMouseClick": async (
    params: ExtensionInvokeParams<"chrome:debugger:dispatchMouseClick">,
  ) => {
    const target = { tabId: params.tabId } as chrome.debugger.Debuggee;
    let attachedByThisCall = false;

    try {
      try {
        await debuggerHandlers.attach(target, "1.3");
        attachedByThisCall = true;
      } catch (error) {
        throw error;
      }

      await debuggerHandlers.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: params.x,
        y: params.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await debuggerHandlers.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: params.x,
        y: params.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      await debuggerHandlers.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: params.x,
        y: params.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });

      return { ok: true };
    } finally {
      if (attachedByThisCall) {
        try {
          await debuggerHandlers.detach(target);
        } catch (error) {
          debuggerHandlers.warnOnDetachFailure(error);
        }
      }
    }
  },
} satisfies Record<string, (...args: any[]) => Promise<any>>;

const extraHandlers = {
  "service-worker:fetch": async (
    params: ExtensionInvokeParams<"service-worker:fetch">,
  ): Promise<ServiceWorkerFetchResponse> => {
    const url = new URL(params.url);
    const { query, ...init } = params.init || {};

    Object.entries(query || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((item) => url.searchParams.append(key, item));
      } else {
        url.searchParams.append(key, value);
      }
    });

    const response = await fetch(url.toString(), { ...init, method: params.method });
    return {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      redirected: response.redirected,
      type: response.type,
      url: response.url,
      headers: Object.fromEntries(response.headers.entries()),
      body: arrayBufferToBase64(await response.arrayBuffer()),
    };
  },
  "web:runtime:evaluate": async (params: ExtensionInvokeParams<"web:runtime:evaluate">) =>
    chrome.scripting.executeScript({
      world: "MAIN",
      target: { tabId: params.tabId },
      args: [{ args: params.args, code: params.code }],
      func: async ({ args, code }) => {
        const callable = new Function(`return ${code}`)();
        if (typeof callable !== "function") {
          return { success: true, data: callable, message: "ok" };
        }

        try {
          return { success: true, data: await callable(...(args || [])), message: "ok" };
        } catch (error) {
          return {
            success: false,
            data: null,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }),
} satisfies Record<string, (...args: any[]) => Promise<any>>;

const handlers = {
  ...tabsHandlers,
  ...extraHandlers,
} as const;

export class InvokeBridge {
  dispatch<T extends ExtensionInvokeType>(
    invoke: T,
    params?: ExtensionInvokeParams<T>,
    sender?: chrome.runtime.MessageSender,
  ): Promise<ExtensionInvokeResponse<T>> {
    return new Promise((resolve, reject) => {
      const handler = handlers[invoke] as
        | ((params: ExtensionInvokeParams<T>, sender?: chrome.runtime.MessageSender) => Promise<ExtensionInvokeResponse<T>>)
        | undefined;

      if (!handler) {
        reject(new Error(`Unsupported invoke: ${invoke}`));
        return;
      }

      Promise.resolve(handler(params as ExtensionInvokeParams<T>, sender))
        .then((response) => resolve(response))
        .catch((error) => reject(error));
    });
  }

  onMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
    if (!message || typeof message !== "object") return false;
    if ((message as { type?: string }).type !== EXTENSION_CONSTANT.extension.invoke.transport.message.type) return false;
    if (!trustRegistry.isTrustedSender(sender)) return false;

    const transport = message as InvokeTransportMessage<ExtensionInvokeType>;
    this.dispatch(transport.invoke, transport.params as never, sender)
      .then((data) => sendResponse({ success: true, data, message: "ok" }))
      .catch((reason) => {
        logger.error("invoke failed", transport.invoke, reason);
        sendResponse({
          success: false,
          data: null,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      });

    return true;
  }

  createPageInvoke(extensionId: string): ExtensionClient["invoke"] {
    return <T extends ExtensionInvokeType>(invoke: T, params?: ExtensionInvokeParams<T>) =>
      new Promise<ExtensionInvokeResponse<T>>((resolve, reject) => {
        chrome.runtime.sendMessage(
          extensionId,
          {
            type: EXTENSION_CONSTANT.extension.invoke.transport.message.type,
            invoke,
            params,
          } as InvokeTransportMessage<T>,
          (response?: { success: boolean; data: ExtensionInvokeResponse<T>; message: string }) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(runtimeError);
              return;
            }
            if (!response?.success) {
              reject(new Error(response?.message || `Invoke failed: ${invoke}`));
              return;
            }
            resolve(response.data);
          },
        );
      });
  }
}
