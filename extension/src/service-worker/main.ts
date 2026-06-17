import { EXTENSION_CONSTANT } from "@shared/extension-contract";

import logger from "@/lib/logger";
import { EventBus } from "@/internal/event";
import { InvokeBridge } from "@/internal/invoke";
import { ChromeEventBridge } from "@/service-worker/chrome-event";
import { PageInjector } from "@/service-worker/inject";

const version = __EXTENSION_VERSION__;
const releaseId = __EXTENSION_RELEASE_ID__;
const runtime = { platform: "service-worker" } as const;
const eventBus = new EventBus(runtime);
const invokeBridge = new InvokeBridge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  eventBus.onMessage(message, sender);
  return invokeBridge.onMessage(message, sender, sendResponse);
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  eventBus.onMessage(message, sender);
  return invokeBridge.onMessage(message, sender, sendResponse);
});

new ChromeEventBridge(eventBus).init();
new PageInjector(eventBus, version, releaseId);

logger.info(`${EXTENSION_CONSTANT.extension.name} service worker ready`, { version, releaseId });
