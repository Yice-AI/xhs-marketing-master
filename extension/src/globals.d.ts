declare global {
  const __EXTENSION_VERSION__: string;
  const __EXTENSION_BUILD_MARKER__: string;
  const __EXTENSION_RELEASE_ID__: string;

  interface Window {
    __NETWORK_HOOK__?: unknown;
  }
}

export {};
