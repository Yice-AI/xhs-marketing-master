import {
  EXTENSION_CONSTANT,
  EXTENSION_DOM_ATTRIBUTE,
  EXTENSION_DOM_BRIDGE,
  EXTENSION_EVENT_NAME,
  EXTENSION_NAME,
} from "@shared/extension-contract";

const appendScript = (script: HTMLScriptElement) => {
  const target = document.head || document.documentElement || document.body;
  if (target) {
    target.appendChild(script);
    return true;
  }

  return false;
};

const dispatchDomEvent = (eventName: string, detail: Record<string, unknown>) => {
  document.dispatchEvent(new CustomEvent(eventName, { detail }));
};

let domBridgeInstalled = false;

const installDomBridge = () => {
  if (domBridgeInstalled) {
    return;
  }
  domBridgeInstalled = true;

  const root = document.documentElement;
  if (root) {
    root.setAttribute(EXTENSION_DOM_ATTRIBUTE, chrome.runtime.id);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return false;
    if ((message as { type?: string }).type !== EXTENSION_CONSTANT.extension.event.transport.message.type) return false;

    const transport = message as { event: string; params: Record<string, unknown> };
    dispatchDomEvent(EXTENSION_DOM_BRIDGE.event, transport);
    return false;
  });

  document.addEventListener(EXTENSION_DOM_BRIDGE.invokeRequest, (event) => {
    const detail = (event as CustomEvent<{ requestId?: string; invoke?: string; params?: unknown }>).detail;
    if (!detail?.requestId || !detail.invoke) return;

    chrome.runtime.sendMessage(
      {
        type: EXTENSION_CONSTANT.extension.invoke.transport.message.type,
        invoke: detail.invoke,
        params: detail.params,
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError;
        dispatchDomEvent(EXTENSION_DOM_BRIDGE.invokeResponse, {
          requestId: detail.requestId,
          success: !runtimeError && Boolean(response?.success),
          data: response?.data,
          message: runtimeError?.message || response?.message || "invoke failed",
        });
      },
    );
  });

  document.addEventListener(EXTENSION_DOM_BRIDGE.emitRequest, (event) => {
    const detail = (event as CustomEvent<{ event?: string; payload?: unknown }>).detail;
    if (!detail?.event) return;

    chrome.runtime.sendMessage({
      type: EXTENSION_CONSTANT.extension.event.transport.message.type,
      event: detail.event,
      params: {
        payload: detail.payload,
        timestamp: Date.now(),
        from: { platform: "content-script", service: "dom-bridge" },
      },
    });
  });

  dispatchDomEvent(EXTENSION_DOM_BRIDGE.ready, {
    extensionId: chrome.runtime.id,
    name: EXTENSION_NAME,
    version: chrome.runtime.getManifest().version,
  });
};

let initialized = false;

const notifyReady = () => {
  if (initialized) {
    return;
  }
  initialized = true;
  chrome.runtime.sendMessage({
    type: EXTENSION_CONSTANT.extension.event.transport.message.type,
    event: "content-script:inject",
    params: {
      payload: {
        tab: {
          url: window.location.href,
          title: document.title,
        },
      },
      timestamp: Date.now(),
      from: { platform: "content-script", service: "inject" },
    },
  });
};

const installNetworkHook = () => {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content-script/library/inject.js");
  script.async = false;

  if (appendScript(script)) {
    window.setTimeout(notifyReady, 0);
    return;
  }

  window.setTimeout(installNetworkHook, 50);
};

window.addEventListener("__EXTENSION_INJECT_READY__", notifyReady, { once: true });
installDomBridge();
installNetworkHook();
