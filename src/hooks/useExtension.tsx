import React, { createContext, useContext, useEffect, useState } from "react";

import {
  BrowserTab,
  ExtensionClient,
  EXTENSION_NAME,
  LEGACY_EXTENSION_NAME,
} from "../../shared/extension-contract";

export interface ExtensionProviderState {
  tab: BrowserTab | undefined;
  setTab: React.Dispatch<React.SetStateAction<BrowserTab | undefined>>;
  extension: ExtensionClient | undefined;
  setExtension: React.Dispatch<React.SetStateAction<ExtensionClient | undefined>>;
}

const initialState: ExtensionProviderState = {
  tab: undefined,
  setTab: () => null,
  extension: undefined,
  setExtension: () => null,
};

const Context = createContext<ExtensionProviderState>(initialState);
const EXTENSION_NAME_CANDIDATES = [LEGACY_EXTENSION_NAME, EXTENSION_NAME] as const;

const findPageExtension = (): ExtensionClient | undefined =>
  EXTENSION_NAME_CANDIDATES.map((name) => (window as any)[name] as ExtensionClient | undefined).find(Boolean);

export const useExtension = () => {
  const context = useContext(Context);
  if (context === undefined) throw new Error("useExtension must be used within a ExtensionProvider");
  return context;
};

export const ExtensionProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [tab, setTab] = useState<BrowserTab>();
  const [extension, setExtension] = useState<ExtensionClient>();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncExtension = () => {
      const current = findPageExtension();
      setExtension(current);
      return current;
    };

    const originalDescriptors = EXTENSION_NAME_CANDIDATES.map((name) => ({
      name,
      currentValue: (window as any)[name],
    }));

    originalDescriptors.forEach(({ name, currentValue }) => {
      const shadowKey = `_${name}`;

      Object.defineProperty(window, name, {
        configurable: true,
        set(value) {
          this[shadowKey] = value;
          setExtension(value);
        },
        get() {
          return this[shadowKey];
        },
      });

      (window as any)[name] = currentValue;
    });

    syncExtension();

    const retryTimer = window.setInterval(() => {
      if (syncExtension()) {
        window.clearInterval(retryTimer);
      }
    }, 1000);

    const handleFocus = () => {
      syncExtension();
    };

    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(retryTimer);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (extension) {
      extension.invoke("chrome:tabs:current").then((t) => setTab(t)).catch(console.error);
    }
  }, [extension]);

  useEffect(() => {
    if (!extension || !tab?.id) return;
    const deal = (params: { payload: { tabId: number; tab: BrowserTab } }) => {
      if (params.payload.tabId !== tab.id) return;
      setTab((prevTab) => ({ ...(prevTab || {}), ...params.payload.tab }));
    };
    extension.event.on("chrome:tabs:onUpdated", deal);

    return () => extension.event.off("chrome:tabs:onUpdated", deal);
  }, [extension, tab?.id]);

  return <Context.Provider value={{ tab, setTab, extension, setExtension }}>{children}</Context.Provider>;
};
