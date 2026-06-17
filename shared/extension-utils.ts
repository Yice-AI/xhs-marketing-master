import { InjectionEvalResult } from "./extension-contract";

export const isRestrictedUrl = (url: string) => {
  if (!url) return true;
  if (url === "about:blank") return true;
  if (/^chrome-error:/i.test(url)) return true;
  if (/^(chrome|edge|about|view-source|devtools):/i.test(url)) return true;
  if (/^chrome-extension:\/\//i.test(url) && !url.startsWith("chrome-extension://")) return true;

  return false;
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
};

export const base64ToArrayBuffer = (base64: string) => {
  const comma = base64.indexOf(",");
  const cleaned = (comma >= 0 ? base64.slice(comma + 1) : base64).trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = cleaned.length % 4;
  const padded = pad ? cleaned + "=".repeat(4 - pad) : cleaned;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
};

export const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export const unwrapInjectionResult = <T>(response: InjectionEvalResult[] | undefined): T | undefined => {
  const result = response?.[0]?.result;
  if (!result?.success) return undefined;

  return result.data as T;
};
