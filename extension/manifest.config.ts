import { defineManifest } from "@crxjs/vite-plugin";

import { EXTENSION_CONSTANT } from "../shared/extension-contract";
import pkg from "./package.json";

const extensionVersion = process.env.EXTENSION_RELEASE_VERSION || pkg.version;
const defaultOrigins = [
  "http://localhost:3000/*",
  "http://127.0.0.1:3000/*",
  "http://localhost:5173/*",
  "http://127.0.0.1:5173/*",
];

const configuredOrigins = (process.env.EXTENSION_ALLOWED_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((origin) => {
    if (origin === "<all_urls>") {
      return origin;
    }

    return origin.endsWith("/*") ? origin : `${origin}/*`;
  });

const webOrigins = configuredOrigins.length > 0 ? configuredOrigins : defaultOrigins;

export default defineManifest(({ mode }) => ({
  manifest_version: 3,
  name: `${mode === "development" ? "[DEV] " : ""}${EXTENSION_CONSTANT.extension.name}`,
  description: EXTENSION_CONSTANT.extension.description,
  version: extensionVersion,
  action: {
    default_popup: "src/popup/index.html",
  },
  background: {
    service_worker: "src/service-worker/main.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content-script/application.ts"],
      run_at: "document_start",
    },
    {
      matches: ["<all_urls>"],
      js: ["src/content-script/inject.ts"],
      run_at: "document_start",
    },
  ],
  permissions: ["tabs", "activeTab", "scripting", "debugger"],
  host_permissions: ["<all_urls>"],
  externally_connectable: {
    matches: webOrigins,
  },
  web_accessible_resources: [
    {
      resources: ["src/content-script/library/inject.js"],
      matches: ["<all_urls>"],
    },
  ],
}));
