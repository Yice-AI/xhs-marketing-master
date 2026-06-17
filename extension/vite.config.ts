import path from "path";
import { fileURLToPath } from "url";

import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import zip from "vite-plugin-zip-pack";

import manifest from "./manifest.config";
import pkg from "./package.json";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionVersion = process.env.EXTENSION_RELEASE_VERSION || pkg.version;
const extensionBuildMarker = process.env.EXTENSION_BUILD_MARKER || new Date().toISOString();
const extensionReleaseId = process.env.EXTENSION_RELEASE_ID || extensionBuildMarker.replace(/[^0-9]/g, "").slice(0, 14) || "local";
const trustedWebOrigins = (process.env.EXTENSION_ALLOWED_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5174,
    cors: { origin: [/chrome-extension:\/\//] },
    hmr: { port: 5174 },
    fs: {
      allow: [dirname, path.resolve(dirname, "..")],
    },
  },
  plugins: [
    crx({ manifest }),
    zip({ outDir: "release", outFileName: `crx-${pkg.name}-${extensionVersion}-${extensionReleaseId}.zip` }),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(dirname, "../shared"),
      "@": path.resolve(dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  define: {
    __EXTENSION_VERSION__: JSON.stringify(extensionVersion),
    __EXTENSION_BUILD_MARKER__: JSON.stringify(extensionBuildMarker),
    __EXTENSION_RELEASE_ID__: JSON.stringify(extensionReleaseId),
    __TRUSTED_WEB_ORIGINS__: JSON.stringify(trustedWebOrigins),
  },
});
