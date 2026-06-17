declare const __TRUSTED_WEB_ORIGINS__: string[];

const trustedOrigins = new Set((__TRUSTED_WEB_ORIGINS__ || []).map((item) => item.trim()).filter(Boolean));

const getOrigin = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
};

const isTrustedUrl = (rawUrl: string) => {
  const origin = getOrigin(rawUrl);
  return Boolean(origin) && trustedOrigins.has(origin);
};

class TrustRegistry {
  private tabIds = new Set<number>();

  addTab(tab: chrome.tabs.Tab) {
    if (tab.id !== undefined) {
      this.tabIds.add(tab.id);
    }
  }

  removeTab(tabId: number) {
    this.tabIds.delete(tabId);
  }

  isTrustedSender(sender: chrome.runtime.MessageSender) {
    if (sender.id && sender.id === chrome.runtime.id) return true;
    if (sender.tab?.id !== undefined && this.tabIds.has(sender.tab.id)) return true;

    const rawUrl = sender.origin || sender.url || sender.tab?.url || "";
    return isTrustedUrl(rawUrl);
  }

  isTrustedTab(tab: chrome.tabs.Tab) {
    if (tab.id !== undefined && this.tabIds.has(tab.id)) return true;
    return isTrustedUrl(tab.url || "");
  }
}

export const trustRegistry = new TrustRegistry();
