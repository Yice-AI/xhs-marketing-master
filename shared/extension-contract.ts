export const EXTENSION_NAME = "xhs-marketing-extension";
export const LEGACY_EXTENSION_NAME = "browser-client-monorepo";
export const EXTENSION_NAME_FALLBACKS = [LEGACY_EXTENSION_NAME] as const;
export const EXTENSION_DOM_ATTRIBUTE = "data-xhs-marketing-extension";
export const EXTENSION_DOM_BRIDGE = {
  ready: `${EXTENSION_NAME}:dom:ready`,
  invokeRequest: `${EXTENSION_NAME}:dom:invoke`,
  invokeResponse: `${EXTENSION_NAME}:dom:invoke:response`,
  event: `${EXTENSION_NAME}:dom:event`,
  emitRequest: `${EXTENSION_NAME}:dom:emit`,
} as const;

export const EXTENSION_CONSTANT = {
  name: EXTENSION_NAME,
  extension: {
    name: EXTENSION_NAME,
    description: "XHS Marketing Browser Bridge",
    event: {
      transport: {
        message: {
          type: `${EXTENSION_NAME}-extension-event` as const,
        },
      },
    },
    invoke: {
      transport: {
        message: {
          type: `${EXTENSION_NAME}-extension-invoke` as const,
        },
      },
    },
  },
} as const;

export type RuntimePlatform = "service-worker" | "content-script" | "web";

export interface ExtensionRuntime {
  platform: RuntimePlatform;
  service?: string;
  tabId?: number;
  windowId?: number;
}

export interface BrowserTab {
  id?: number;
  windowId?: number;
  title?: string;
  url?: string;
  status?: string;
  active?: boolean;
  favIconUrl?: string;
}

export interface InjectionEvalResult<T = unknown> {
  frameId?: number;
  result: {
    success: boolean;
    data: T;
    message: string;
  };
}

export interface ServiceWorkerFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  type: ResponseType | string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface XhsLoginStatus {
  loggedIn: boolean;
  message: string;
  url?: string;
}

export type XhsOperationErrorCode = "extension_unavailable" | "xhs_login_required" | "page_interaction_failed";

export interface XhsOperationResult<T = void> {
  success: boolean;
  code?: XhsOperationErrorCode;
  message: string;
  data?: T;
}

type ExtensionEventPayloadMap = {
  "internal:init:state:change": { state?: "initializing" | "ready" | "error" };
  "content-script:application:init": { tab: BrowserTab };
  "content-script:inject": { tab: BrowserTab };
  "service-worker:application:inject": { tab: BrowserTab };
  "scraper:bridge-debug": Record<string, unknown>;
  "chrome:tabs:onActivated": { activeInfo: Record<string, unknown> };
  "chrome:tabs:onAttached": { tabId: number; attachInfo: Record<string, unknown> };
  "chrome:tabs:onCreated": { tab: BrowserTab };
  "chrome:tabs:onDetached": { tabId: number; detachInfo: Record<string, unknown> };
  "chrome:tabs:onHighlighted": { highlightInfo: Record<string, unknown> };
  "chrome:tabs:onMoved": { tabId: number; moveInfo: Record<string, unknown> };
  "chrome:tabs:onRemoved": { tabId: number; removeInfo: Record<string, unknown> };
  "chrome:tabs:onReplaced": { addedTabId: number; removedTabId: number };
  "chrome:tabs:onUpdated": { tabId: number; changeInfo: Record<string, unknown>; tab: BrowserTab };
  "chrome:tabs:onZoomChange": { zoomChangeInfo: Record<string, unknown> };
};

export type ExtensionEventType = keyof ExtensionEventPayloadMap;

export type ExtensionEventPayload<T extends ExtensionEventType> = ExtensionEventPayloadMap[T];

export interface ExtensionEventParams<T extends ExtensionEventType> {
  payload: ExtensionEventPayload<T>;
  timestamp: number;
  from: ExtensionRuntime & { sender?: unknown };
}

export type ExtensionEventHandler<T extends ExtensionEventType> = (params: ExtensionEventParams<T>) => void;

type ExtensionInvokeMap = {
  "chrome:tabs:current": { params: undefined; resp?: BrowserTab };
  "chrome:tabs:create": {
    params: { createProperties: { url?: string; openerTabId?: number; active?: boolean } & Record<string, unknown> };
    resp: BrowserTab;
  };
  "chrome:tabs:get": { params: { tabId: number }; resp: BrowserTab };
  "chrome:tabs:query": { params: { queryInfo: Record<string, unknown> }; resp: BrowserTab[] };
  "chrome:tabs:remove": { params: { tabIds: number[] }; resp: void };
  "chrome:tabs:update": {
    params: { tabId?: number; updateProperties: { url?: string; active?: boolean } & Record<string, unknown> };
    resp?: BrowserTab;
  };
  "chrome:debugger:attach": {
    params: { target: { tabId?: number; targetId?: string }; requiredVersion: string };
    resp: void;
  };
  "chrome:debugger:detach": {
    params: { tabId?: number; targetId?: string };
    resp: void;
  };
  "chrome:debugger:getTargets": {
    params: undefined;
    resp: Array<Record<string, unknown>>;
  };
  "chrome:debugger:sendCommand": {
    params: { target: { tabId?: number; targetId?: string }; method: string; commandParams?: Record<string, unknown> };
    resp?: Record<string, unknown>;
  };
  "chrome:debugger:dispatchMouseClick": {
    params: { tabId: number; x: number; y: number };
    resp: { ok: boolean };
  };
  "service-worker:fetch": {
    params: {
      url: string;
      method: string;
      init?: RequestInit & { query?: Record<string, string | string[]> };
    };
    resp: ServiceWorkerFetchResponse;
  };
  "web:runtime:evaluate": {
    params: { tabId: number; args?: unknown[]; code: string };
    resp: InjectionEvalResult[];
  };
};

export type ExtensionInvokeType = keyof ExtensionInvokeMap;
export type ExtensionInvokeParams<T extends ExtensionInvokeType> = ExtensionInvokeMap[T]["params"];
export type ExtensionInvokeResponse<T extends ExtensionInvokeType> = ExtensionInvokeMap[T]["resp"];

export interface NetworkHookRegistration<TArgs extends unknown[]> {
  on: (name: string, handler: (...args: TArgs) => void) => void;
  off: (name: string) => void;
  hook: Record<string, (...args: TArgs) => void>;
}

export interface ExtensionClient {
  id: string;
  name: string;
  version: string;
  manifestVersion?: string;
  buildMarker?: string;
  releaseId?: string;
  invoke: <T extends ExtensionInvokeType>(
    invoke: T,
    params?: ExtensionInvokeParams<T>,
  ) => Promise<ExtensionInvokeResponse<T>>;
  event: {
    on: <T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>) => void;
    off: <T extends ExtensionEventType>(event: T, handler: ExtensionEventHandler<T>) => void;
    emit: <T extends ExtensionEventType>(event: T, payload: ExtensionEventPayload<T>) => void;
  };
  network: {
    hook: {
      xhr: {
        send: NetworkHookRegistration<[Record<string, unknown>, XMLHttpRequest]>;
      };
      fetch: {
        request: NetworkHookRegistration<[RequestInfo | URL, RequestInit | undefined]>;
        response: NetworkHookRegistration<[RequestInfo | URL, RequestInit | undefined, Response]>;
      };
    };
  };
}

export const EXTENSION_EVENT_NAME = `${EXTENSION_NAME}-${EXTENSION_CONSTANT.extension.event.transport.message.type}-event`;
