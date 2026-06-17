const __extension_origin_network__ = {
  fetch: window.fetch.bind(window),
  xhr: {
    open: XMLHttpRequest.prototype.open,
    send: XMLHttpRequest.prototype.send,
    setRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
  },
};

const __extension_network_hook__ = {
  fetch: { request: {}, response: {} },
  xhr: { send: {} },
};

const __xhs_early_pending_fetch_requests__ = window.__XHS_EARLY_PENDING_FETCH_REQUESTS__ || new Map();
const __xhs_early_captured_search_requests__ = window.__XHS_EARLY_CAPTURED_SEARCH_REQUESTS__ || [];
const __xhs_early_trace_state__ = window.__XHS_EARLY_SEARCH_TRACE_STATE__ || { current: 0 };
window.__XHS_EARLY_PENDING_FETCH_REQUESTS__ = __xhs_early_pending_fetch_requests__;
window.__XHS_EARLY_CAPTURED_SEARCH_REQUESTS__ = __xhs_early_captured_search_requests__;
window.__XHS_EARLY_SEARCH_TRACE_STATE__ = __xhs_early_trace_state__;

const __xhs_trim_early_capture__ = () => {
  while (__xhs_early_captured_search_requests__.length > 30) {
    __xhs_early_captured_search_requests__.shift();
  }
};

const __xhs_parse_json_safe__ = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const __xhs_normalize_request_url__ = (input) => {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return String(input || "");
};

const __xhs_get_request_method__ = (input, init) => (
  String(
    init?.method
    || (typeof Request !== "undefined" && input instanceof Request ? input.method : "")
    || "GET"
  ).toUpperCase()
);

const __xhs_fetch_request_key__ = (url, method) => `${method}::${url}`;

const __xhs_extract_sync_body__ = (input, init) => {
  if (init?.body !== undefined) {
    if (typeof init.body === "string") {
      return __xhs_parse_json_safe__(init.body, {});
    }
    if (typeof URLSearchParams !== "undefined" && init.body instanceof URLSearchParams) {
      return Object.fromEntries(init.body.entries());
    }
  }
  return {};
};

const __xhs_looks_like_search_notes_request__ = (url, body) => {
  const normalized = String(url || "").trim().toLowerCase();
  const hasSearchPath = (
    normalized.includes("/api/sns/web/v1/search/notes") ||
    normalized.includes("/api/sns/web/v2/search/notes") ||
    normalized.includes("/api/sns/web/search/notes") ||
    normalized.includes("/search/notes")
  );
  if (hasSearchPath) return true;

  if (!body || typeof body !== "object") return false;
  const filters = Array.isArray(body.filters) ? body.filters : [];
  const filterTypes = filters.map((item) => String(item?.type || "").trim());
  const hasKeyword = Boolean(String(body.keyword || "").trim());
  const hasSearchFilters = (
    filterTypes.includes("filter_note_type") ||
    filterTypes.includes("filter_note_time") ||
    Object.prototype.hasOwnProperty.call(body, "filter_note_type") ||
    Object.prototype.hasOwnProperty.call(body, "filter_note_time")
  );
  return hasKeyword && hasSearchFilters;
};

const __xhs_record_early_capture__ = (detail) => {
  __xhs_early_captured_search_requests__.push(detail);
  __xhs_trim_early_capture__();
};

const __extension_network_hook_run__ = (funcs, args) => {
  for (const [name, func] of Object.entries(funcs)) {
    try {
      func(...args());
    } catch (error) {
      console.log(name, error);
    }
  }
};

window.fetch = function (input, init) {
  const requestUrl = __xhs_normalize_request_url__(input);
  const method = __xhs_get_request_method__(input, init);
  const requestKey = __xhs_fetch_request_key__(requestUrl, method);
  const body = __xhs_extract_sync_body__(input, init);
  if (__xhs_looks_like_search_notes_request__(requestUrl, body)) {
    __xhs_early_pending_fetch_requests__.set(requestKey, {
      body,
      method,
      updatedAt: Date.now(),
    });
  }

  __extension_network_hook_run__(__extension_network_hook__.fetch.request, () => [input, init]);

  return __extension_origin_network__.fetch.apply(this, [input, init]).then((response) => {
    const cachedRequest = __xhs_early_pending_fetch_requests__.get(requestKey);
    const cachedBody = cachedRequest?.body || body;
    const contentType = response.headers.get("content-type") || "";
    if (__xhs_looks_like_search_notes_request__(requestUrl, cachedBody) && contentType.includes("application/json")) {
      response.clone().json().then((responseData) => {
        __xhs_early_trace_state__.current += 1;
        __xhs_record_early_capture__({
          url: requestUrl,
          method,
          body: cachedBody,
          resp: responseData,
          requestTraceId: `early-fetch-${__xhs_early_trace_state__.current}`,
          requestCapturedAt: Date.now(),
          requestSource: "fetch_response",
          bridgeForwarded: false,
          earlyCaptured: true,
        });
      }).catch(() => {});
    }
    __xhs_early_pending_fetch_requests__.delete(requestKey);
    __extension_network_hook_run__(__extension_network_hook__.fetch.response, () => [input, init, response.clone()]);
    return response;
  });
};

const getXhrMeta = (xhr) => {
  if (xhr.__hook_meta__) return xhr.__hook_meta__;
  Object.defineProperty(xhr, "__hook_meta__", {
    value: {
      method: undefined,
      url: undefined,
      async: true,
      user: undefined,
      password: undefined,
      headers: {},
      body: undefined,
    },
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return xhr.__hook_meta__;
};

XMLHttpRequest.prototype.open = function (method, url, async = true, user = null, password = null) {
  const meta = getXhrMeta(this);
  meta.method = method;
  meta.url = typeof url === "string" ? url : String(url);
  meta.async = async;
  meta.user = user;
  meta.password = password;

  return __extension_origin_network__.xhr.open.apply(this, arguments);
};

XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
  const meta = getXhrMeta(this);
  meta.headers[String(name).toLowerCase()] = String(value);

  return __extension_origin_network__.xhr.setRequestHeader.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function (body) {
  const meta = getXhrMeta(this);
  meta.body = body;

  this.addEventListener("load", () => {
    const url = String(meta.url || "");
    const parsedBody = __xhs_parse_json_safe(meta.body?.toString?.() || meta.body, {});
    if (!__xhs_looks_like_search_notes_request__(url, parsedBody)) return;
    const contentType = this.getResponseHeader("content-type") || "";
    if (!contentType.includes("application/json")) return;
    const responseData = __xhs_parse_json_safe(this.responseText, null);
    if (responseData === null) return;
    __xhs_early_trace_state__.current += 1;
    __xhs_record_early_capture__({
      url,
      method: meta.method,
      body: parsedBody,
      resp: responseData,
      requestTraceId: `early-xhr-${__xhs_early_trace_state__.current}`,
      requestCapturedAt: Date.now(),
      requestSource: "xhr",
      bridgeForwarded: false,
      earlyCaptured: true,
    });
  });

  __extension_network_hook_run__(__extension_network_hook__.xhr.send, () => [meta, this]);

  return __extension_origin_network__.xhr.send.apply(this, arguments);
};

const __extension_network_hook_register__ = (hook) => ({
  on: (name, func) => {
    hook[name] = func;
  },
  off: (name) => {
    delete hook[name];
  },
  hook,
});

window.__NETWORK_HOOK__ = {
  fetch: {
    request: __extension_network_hook_register__(__extension_network_hook__.fetch.request),
    response: __extension_network_hook_register__(__extension_network_hook__.fetch.response),
  },
  xhr: { send: __extension_network_hook_register__(__extension_network_hook__.xhr.send) },
};

window.__XHS_MARKETING_EXTENSION_DIAGNOSTICS__ = {
  ...(window.__XHS_MARKETING_EXTENSION_DIAGNOSTICS__ || {}),
  stage: "network_hook_ready",
  url: window.location.href,
  readyState: document.readyState,
  updatedAt: Date.now(),
  networkHookReady: true,
  xhrHookReady: true,
  fetchRequestHookReady: true,
  fetchResponseHookReady: true,
  registeredXhrHooks: Object.keys(window.__NETWORK_HOOK__.xhr.send.hook || {}),
  registeredFetchRequestHooks: Object.keys(window.__NETWORK_HOOK__.fetch.request.hook || {}),
  registeredFetchResponseHooks: Object.keys(window.__NETWORK_HOOK__.fetch.response.hook || {}),
  earlyCapturedSearchRequestCount: __xhs_early_captured_search_requests__.length,
};

window.dispatchEvent(new CustomEvent("__EXTENSION_INJECT_READY__", {}));
