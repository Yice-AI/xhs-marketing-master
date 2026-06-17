import { BrowserTab, ExtensionClient, XhsLoginStatus } from "../shared/extension-contract";
import { sleep, unwrapInjectionResult } from "../shared/extension-utils";

const XHS_CREATOR_URL = "https://creator.xiaohongshu.com/publish/publish?target=image";

export const waitForTabReady = async (extension: ExtensionClient, tabId: number, timeoutMs = 10000) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const currentTab = await extension.invoke("chrome:tabs:get", { tabId });
    if (currentTab.status === "complete") {
      await sleep(1200);
      return currentTab;
    }
    await sleep(400);
  }

  return extension.invoke("chrome:tabs:get", { tabId });
};

export const ensureXhsCreatorTab = async (
  extension: ExtensionClient,
  currentTab?: BrowserTab,
  existingTab?: BrowserTab,
  active = false,
) => {
  if (existingTab?.id !== undefined) {
    const updated = await extension.invoke("chrome:tabs:update", {
      tabId: existingTab.id,
      updateProperties: {
        url: XHS_CREATOR_URL,
        active,
      },
    });

    return updated || existingTab;
  }

  return extension.invoke("chrome:tabs:create", {
    createProperties: {
      url: XHS_CREATOR_URL,
      active,
      ...(currentTab?.id !== undefined ? { openerTabId: currentTab.id } : {}),
    },
  });
};

export const detectXhsLogin = async (extension: ExtensionClient, targetTabId: number): Promise<XhsLoginStatus> => {
  await waitForTabReady(extension, targetTabId);

  const detectionCode = () => {
    const text = document.body?.innerText || "";
    const url = window.location.href;
    const inXhsDomain = url.includes("xiaohongshu.com");

    const publishControls = Boolean(
      document.querySelector("input[type='file']") ||
        document.querySelector(".publish-page-publish-btn button") ||
        document.querySelector(".editor-container [role='textbox']"),
    );

    const loginMarkers = [
      "扫码登录",
      "手机号登录",
      "登录后继续",
      "请先登录",
      "注册登录",
      "打开小红书 App 扫码登录",
    ];

    const hasLoginMarker =
      loginMarkers.some((marker) => text.includes(marker)) ||
      Boolean(document.querySelector("img[src*='qrcode']")) ||
      url.includes("login");

    const browseControls = Boolean(
      document.querySelector("#search-input") ||
        document.querySelector(".search-icon") ||
        document.querySelector(".note-item") ||
        document.querySelector("[class*='avatar']"),
    );

    if (publishControls) {
      return { loggedIn: true, message: "已检测到创作者发布页能力", url };
    }

    if (hasLoginMarker) {
      return { loggedIn: false, message: "浏览器尚未登录小红书创作者中心", url };
    }

    if (url.includes("creator.xiaohongshu.com")) {
      return { loggedIn: true, message: "已进入创作者中心页面", url };
    }

    if (inXhsDomain && browseControls) {
      return { loggedIn: true, message: "已检测到小红书页面可交互状态", url };
    }

    return { loggedIn: false, message: "尚未进入可确认登录状态的页面", url };
  };

  try {
    const response = await extension.invoke("web:runtime:evaluate", {
      tabId: targetTabId,
      args: [],
      code: detectionCode.toString(),
    });

    const evaluated = unwrapInjectionResult<XhsLoginStatus>(response);
    if (evaluated) {
      return evaluated;
    }
  } catch (error) {
    console.warn("[xhsSession] evaluate login status failed", error);
  }

  try {
    const tab = await extension.invoke("chrome:tabs:get", { tabId: targetTabId });
    const currentUrl = tab?.url || "";
    const currentTitle = tab?.title || "";
    const lowerTitle = currentTitle.toLowerCase();

    if (currentUrl.includes("creator.xiaohongshu.com") && !lowerTitle.includes("登录") && !lowerTitle.includes("login")) {
      return {
        loggedIn: true,
        message: "已进入创作者中心页面（兜底检测）",
        url: currentUrl,
      };
    }

    return {
      loggedIn: false,
      message: "无法确认登录状态，请确认创作者中心页面已完成登录",
      url: currentUrl,
    };
  } catch (error) {
    console.warn("[xhsSession] fallback tab inspection failed", error);
    return {
      loggedIn: false,
      message: "无法检测浏览器中的小红书登录状态",
    };
  }
};
