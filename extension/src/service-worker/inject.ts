import {
  EXTENSION_CONSTANT,
  EXTENSION_DOM_BRIDGE,
  EXTENSION_EVENT_NAME,
  EXTENSION_NAME,
  ExtensionClient,
  ExtensionRuntime,
} from "@shared/extension-contract";
import { isRestrictedUrl } from "@shared/extension-utils";

import logger from "@/lib/logger";
import { EventBus } from "@/internal/event";
import { trustRegistry } from "@/internal/trust";

export class PageInjector {
  constructor(
    private eventBus: EventBus,
    private version: string,
    private releaseId: string,
  ) {
    this.eventBus.on("content-script:inject", ({ payload: { tab } }) => {
      if (tab.id !== undefined) {
        this.inject(tab.id);
      }
    });
  }

  private inject(tabId: number) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab.id || isRestrictedUrl(tab.url || "") || !trustRegistry.isTrustedTab(tab)) {
        return;
      }

      chrome.scripting
        .executeScript({
          world: "MAIN",
          target: { tabId: tab.id },
          args: [
            {
              extensionId: chrome.runtime.id,
              name: EXTENSION_NAME,
              version: this.version,
              manifestVersion: chrome.runtime.getManifest().version,
              buildMarker: __EXTENSION_BUILD_MARKER__,
              releaseId: this.releaseId,
              eventTransportType: EXTENSION_CONSTANT.extension.event.transport.message.type,
              eventName: EXTENSION_EVENT_NAME,
              domEmitRequestEvent: EXTENSION_DOM_BRIDGE.emitRequest,
              tabId,
            },
          ],
          func: ({ extensionId, name, version, manifestVersion, buildMarker, releaseId, eventTransportType, eventName, domEmitRequestEvent, tabId: currentTabId }) => {
            const runtime: ExtensionRuntime = { platform: "web", tabId: currentTabId };
            const sendInvoke: ExtensionClient["invoke"] = (invoke, params) =>
              new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(
                  extensionId,
                  {
                    type: `${name}-extension-invoke`,
                    invoke,
                    params,
                  },
                  (response) => {
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                      reject(runtimeError);
                      return;
                    }
                    if (!response?.success) {
                      reject(new Error(response?.message || "invoke failed"));
                      return;
                    }
                    resolve(response.data);
                  },
                );
              });

            const pageEvent = (() => {
              const handlers = {};

              const on = (event, handler) => {
                if (!handlers[event]) {
                  handlers[event] = [];
                }
                handlers[event].push(handler);
              };

              const off = (event, handler) => {
                if (!handlers[event]) return;
                const index = handlers[event].indexOf(handler);
                if (index >= 0) {
                  handlers[event].splice(index, 1);
                }
              };

              const dispatch = (event, params) => {
                (handlers[event] || []).slice().forEach((handler) => {
                  Promise.resolve()
                    .then(() => handler(params))
                    .catch((error) => console.error("[xhs-marketing-extension event]", error));
                });
              };

              const emit = (event, payload) => {
                const params = { payload, timestamp: Date.now(), from: runtime };
                dispatch(event, params);
                document.dispatchEvent(
                  new CustomEvent(domEmitRequestEvent, {
                    detail: {
                      event,
                      payload,
                    },
                  }),
                );
              };

              const listener = (browserEvent) => {
                const message = browserEvent.detail?.message;
                if (message?.type !== eventTransportType) return;
                dispatch(message.event, message.params);
              };
              document.removeEventListener(eventName, listener);
              document.addEventListener(eventName, listener);

              return { on, off, emit };
            })();

            window[name] = {
              id: extensionId,
              name,
              version,
              manifestVersion,
              buildMarker,
              releaseId,
              invoke: sendInvoke,
              event: pageEvent,
              network: { hook: window.__NETWORK_HOOK__ },
            };
          },
        })
        .then(() => this.eventBus.emit("service-worker:application:inject", { tab }))
        .catch((error) => logger.error("inject page bridge failed", error));
    });
  }
}
