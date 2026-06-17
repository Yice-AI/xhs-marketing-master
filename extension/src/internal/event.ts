import {
  EXTENSION_CONSTANT,
  EXTENSION_EVENT_NAME,
  ExtensionClient,
  ExtensionEventHandler,
  ExtensionEventParams,
  ExtensionEventPayload,
  ExtensionEventType,
  ExtensionRuntime,
} from "@shared/extension-contract";

import logger from "@/lib/logger";
import { trustRegistry } from "@/internal/trust";

export type EventTransportMessage<T extends ExtensionEventType> = {
  type: typeof EXTENSION_CONSTANT.extension.event.transport.message.type;
  event: T;
  params: ExtensionEventParams<T>;
};

type HandlerStore = {
  [T in ExtensionEventType]?: ExtensionEventHandler<T>[];
};

export class EventBus {
  private handlers: HandlerStore = {};

  constructor(private runtime: ExtensionRuntime) {}

  on<T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>) {
    if (!this.handlers[event]) {
      this.handlers[event] = [];
    }

    (this.handlers[event] as ExtensionEventHandler<T>[]).push(handler);
  }

  off<T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>) {
    const handlers = this.handlers[event] as ExtensionEventHandler<T>[] | undefined;
    if (!handlers) return;

    const index = handlers.indexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  }

  emit<T extends ExtensionEventType>(event: T, payload: ExtensionEventPayload<T>) {
    const params: ExtensionEventParams<T> = {
      payload,
      timestamp: Date.now(),
      from: this.runtime,
    };

    this.dispatch(event, params);
    this.broadcast(event, params);
  }

  onMessage(message: unknown, sender: chrome.runtime.MessageSender) {
    if (!message || typeof message !== "object") return;
    if ((message as { type?: string }).type !== EXTENSION_CONSTANT.extension.event.transport.message.type) return;

    const transport = message as EventTransportMessage<ExtensionEventType>;
    const payloadWithSenderTab =
      sender.tab &&
      (transport.event === "content-script:inject" || transport.event === "content-script:application:init")
        ? { ...transport.params.payload, tab: sender.tab }
        : transport.params.payload;

    this.dispatch(transport.event, {
      ...transport.params,
      payload: payloadWithSenderTab,
      from: { ...transport.params.from, sender },
    } as ExtensionEventParams<ExtensionEventType>);
  }

  private dispatch<T extends ExtensionEventType>(event: T, params: ExtensionEventParams<T>) {
    const handlers = (this.handlers[event] || []) as ExtensionEventHandler<T>[];
    handlers.slice().forEach((handler) => {
      Promise.resolve()
        .then(() => handler(params))
        .catch((error) => logger.error("event handler failed", event, error));
    });
  }

  private broadcast<T extends ExtensionEventType>(event: T, params: ExtensionEventParams<T>) {
    const message: EventTransportMessage<T> = {
      type: EXTENSION_CONSTANT.extension.event.transport.message.type,
      event,
      params,
    };

    chrome.runtime.sendMessage(message).catch(() => undefined);

    chrome.tabs.query({}, (tabs) => {
      tabs
        .filter((tab) => trustRegistry.isTrustedTab(tab))
        .forEach((tab) => {
          if (tab.id === undefined) return;

          chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
          chrome.scripting
            .executeScript({
              world: "MAIN",
              target: { tabId: tab.id },
              args: [{ eventName: EXTENSION_EVENT_NAME, message }],
              func: ({ eventName, message: payload }) => {
                document.dispatchEvent(new CustomEvent(eventName, { detail: { message: payload } }));
              },
            })
            .catch(() => undefined);
        });
    });
  }
}

export const createPageEventClient = (
  extensionId: string,
  runtime: ExtensionRuntime,
  sendInvoke: ExtensionClient["invoke"],
) => {
  const handlers: HandlerStore = {};

  const on = <T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>) => {
    if (!handlers[event]) {
      handlers[event] = [];
    }
    (handlers[event] as ExtensionEventHandler<T>[]).push(handler);
  };

  const off = <T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>) => {
    const store = handlers[event] as ExtensionEventHandler<T>[] | undefined;
    if (!store) return;
    const index = store.indexOf(handler);
    if (index >= 0) {
      store.splice(index, 1);
    }
  };

  const dispatch = <T extends ExtensionEventType>(event: T, params: ExtensionEventParams<T>) => {
    const store = (handlers[event] || []) as ExtensionEventHandler<T>[];
    store.slice().forEach((handler) => {
      Promise.resolve()
        .then(() => handler(params))
        .catch((error) => logger.error("page event handler failed", event, error));
    });
  };

  const emit = <T extends ExtensionEventType>(event: T, payload: ExtensionEventPayload<T>) => {
    const params: ExtensionEventParams<T> = {
      payload,
      timestamp: Date.now(),
      from: runtime,
    };
    dispatch(event, params);

    chrome.runtime.sendMessage(extensionId, {
      type: EXTENSION_CONSTANT.extension.event.transport.message.type,
      event,
      params,
    });
  };

  const listener = (browserEvent: Event) => {
    const detail = (browserEvent as CustomEvent<{ message?: EventTransportMessage<ExtensionEventType> }>).detail;
    const transport = detail?.message;
    if (!transport) return;

    dispatch(transport.event, transport.params as ExtensionEventParams<ExtensionEventType>);
  };

  document.removeEventListener(EXTENSION_EVENT_NAME, listener);
  document.addEventListener(EXTENSION_EVENT_NAME, listener);

  return { on, off, emit, dispatch, sendInvoke };
};
