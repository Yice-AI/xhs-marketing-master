import { EventBus } from "@/internal/event";
import { trustRegistry } from "@/internal/trust";

export class ChromeEventBridge {
  constructor(private eventBus: EventBus) {}

  init() {
    const emit = this.eventBus.emit.bind(this.eventBus);

    chrome.tabs.onActivated.addListener((activeInfo) => emit("chrome:tabs:onActivated", { activeInfo }));
    chrome.tabs.onAttached.addListener((tabId, attachInfo) => emit("chrome:tabs:onAttached", { tabId, attachInfo }));
    chrome.tabs.onCreated.addListener((tab) => emit("chrome:tabs:onCreated", { tab }));
    chrome.tabs.onDetached.addListener((tabId, detachInfo) => emit("chrome:tabs:onDetached", { tabId, detachInfo }));
    chrome.tabs.onHighlighted.addListener((highlightInfo) => emit("chrome:tabs:onHighlighted", { highlightInfo }));
    chrome.tabs.onMoved.addListener((tabId, moveInfo) => emit("chrome:tabs:onMoved", { tabId, moveInfo }));
    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      trustRegistry.removeTab(tabId);
      emit("chrome:tabs:onRemoved", { tabId, removeInfo });
    });
    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
      emit("chrome:tabs:onReplaced", { addedTabId, removedTabId }),
    );
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => emit("chrome:tabs:onUpdated", { tabId, changeInfo, tab }));
  }
}
