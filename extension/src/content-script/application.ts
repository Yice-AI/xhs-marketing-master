import { EXTENSION_CONSTANT } from "@shared/extension-contract";

chrome.runtime.sendMessage({
  type: EXTENSION_CONSTANT.extension.event.transport.message.type,
  event: "content-script:application:init",
  params: {
    payload: {
      tab: {
        url: window.location.href,
        title: document.title,
      },
    },
    timestamp: Date.now(),
    from: { platform: "content-script", service: "application" },
  },
});
