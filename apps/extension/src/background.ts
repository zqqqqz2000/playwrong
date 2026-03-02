import type {
  ExtensionRpcEnvelope,
  ExtensionRpcError,
  ExtensionRpcFailureResponse,
  ExtensionRpcMethod,
  ExtensionRpcRequest,
  ExtensionRpcResponse,
  ExtensionRpcResultByMethod,
  RemoteExtractResult
} from "@playwrong/protocol";
import type { ContentBridgeRequest, ContentBridgeResponse, RuntimePluginPackPayload } from "./messages";

const DEFAULT_SERVER_WS_URL = "ws://127.0.0.1:7878/ws/extension";
const STORAGE_SERVER_WS_URL_KEY = "serverWsUrl";
const RECONNECT_DELAY_MS = 1500;
const RECONNECT_ALARM_NAME = "playwrong.reconnect";
const RECONNECT_ALARM_PERIOD_MINUTES = 1;
const CONTENT_BRIDGE_READY_FLAG = "__playwrongContentBridgeReady";
const INJECT_DEBOUNCE_MS = 5000;

interface ContentExtractResult {
  pageType: string;
  tree: RemoteExtractResult["tree"];
  pageCalls: NonNullable<RemoteExtractResult["pageCalls"]>;
  url: string;
  title: string;
}

class RpcHandledError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const lastInjectAtByTab = new Map<number, number>();
const injectingTabIds = new Set<number>();
let ensureContentBridgePromise: Promise<void> | null = null;

function ensureReconnectAlarm(): void {
  chrome.alarms.create(RECONNECT_ALARM_NAME, {
    periodInMinutes: RECONNECT_ALARM_PERIOD_MINUTES
  });
}

function toRpcError(error: unknown): ExtensionRpcError {
  if (error instanceof RpcHandledError) {
    const payload: ExtensionRpcError = {
      code: error.code,
      message: error.message
    };
    if (error.details) {
      payload.details = error.details;
    }
    return payload;
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL_ERROR",
      message: error.message
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Unknown extension background error"
  };
}

async function getServerWsUrl(): Promise<string> {
  const fromStorage = await chrome.storage.local.get(STORAGE_SERVER_WS_URL_KEY);
  const maybeUrl = fromStorage[STORAGE_SERVER_WS_URL_KEY];
  if (typeof maybeUrl === "string" && maybeUrl.length > 0) {
    return maybeUrl;
  }
  return DEFAULT_SERVER_WS_URL;
}

function wsToHttpBase(wsUrl: string): string | null {
  try {
    const parsed = new URL(wsUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function parseRuntimePluginPacksPayload(input: unknown): RuntimePluginPackPayload[] {
  if (!input || typeof input !== "object") {
    return [];
  }
  const record = input as { plugins?: unknown };
  if (!Array.isArray(record.plugins)) {
    return [];
  }

  const out: RuntimePluginPackPayload[] = [];
  for (const candidate of record.plugins) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const plugin = candidate as {
      pluginId?: unknown;
      name?: unknown;
      version?: unknown;
      updatedAt?: unknown;
      moduleCode?: unknown;
    };
    if (
      typeof plugin.pluginId !== "string" ||
      typeof plugin.name !== "string" ||
      typeof plugin.version !== "string" ||
      typeof plugin.updatedAt !== "string" ||
      typeof plugin.moduleCode !== "string"
    ) {
      continue;
    }
    out.push({
      pluginId: plugin.pluginId,
      name: plugin.name,
      version: plugin.version,
      updatedAt: plugin.updatedAt,
      moduleCode: plugin.moduleCode
    });
  }
  return out;
}

async function fetchRuntimePluginPacks(): Promise<RuntimePluginPackPayload[]> {
  const wsUrl = await getServerWsUrl();
  const baseUrl = wsToHttpBase(wsUrl);
  if (!baseUrl) {
    return [];
  }

  try {
    const response = await fetch(new URL("/mapping-plugins/runtime", baseUrl), {
      method: "GET",
      headers: {
        "content-type": "application/json"
      }
    });
    if (!response.ok) {
      return [];
    }
    return parseRuntimePluginPacksPayload(await response.json());
  } catch {
    return [];
  }
}

function parsePageId(pageId: string): number {
  const match = /^tab:(\d+)$/.exec(pageId);
  if (!match) {
    throw new RpcHandledError("INVALID_REQUEST", `Invalid pageId format: ${pageId}`);
  }
  return Number(match[1]);
}

function ensureTabMessageResponse<T>(response: ContentBridgeResponse<T> | undefined): ContentBridgeResponse<T> {
  if (!response) {
    throw new RpcHandledError("ACTION_FAIL", "No response from content script");
  }
  return response;
}

async function sendToTab<T>(tabId: number, message: ContentBridgeRequest): Promise<ContentBridgeResponse<T>> {
  return await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: ContentBridgeResponse<T> | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new RpcHandledError("ACTION_FAIL", runtimeError.message || "tabs.sendMessage failed"));
        return;
      }
      resolve(ensureTabMessageResponse(response));
    });
  });
}

async function getTrackableTabs(): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => {
    if (tab.id === undefined) {
      return false;
    }
    if (!tab.url) {
      return false;
    }
    return tab.url.startsWith("http://") || tab.url.startsWith("https://");
  });
}

async function hasContentBridge(tabId: number): Promise<boolean> {
  try {
    const response = await sendToTab<{ ok: true }>(tabId, { type: "playwrong.ping" });
    return response.ok;
  } catch {
    return false;
  }
}

async function hasContentBridgeMarker(tabId: number): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (readyFlag: string) => {
        const global = window as unknown as Record<string, unknown>;
        return global[readyFlag] === true;
      },
      args: [CONTENT_BRIDGE_READY_FLAG]
    });
    return Boolean(results[0]?.result);
  } catch {
    return false;
  }
}

async function injectContentBridge(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) {
    return;
  }
  if (tab.status !== "complete") {
    return;
  }
  if (injectingTabIds.has(tabId)) {
    return;
  }

  const now = Date.now();
  const lastInjectAt = lastInjectAtByTab.get(tabId) ?? 0;
  if (now - lastInjectAt < INJECT_DEBOUNCE_MS) {
    return;
  }
  lastInjectAtByTab.set(tabId, now);
  injectingTabIds.add(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } finally {
    injectingTabIds.delete(tabId);
  }
}

async function ensureContentBridgeInjectedOnce(): Promise<void> {
  const tabs = await getTrackableTabs();
  for (const tab of tabs) {
    const tabId = tab.id;
    if (tabId === undefined) {
      continue;
    }
    const ready = await hasContentBridge(tabId);
    if (ready) {
      continue;
    }
    const markerReady = await hasContentBridgeMarker(tabId);
    if (markerReady) {
      continue;
    }
    try {
      await injectContentBridge(tab);
    } catch {
      // best effort inject; some tabs may not allow script execution.
    }
  }
}

function ensureContentBridgeInjected(): Promise<void> {
  if (ensureContentBridgePromise) {
    return ensureContentBridgePromise;
  }
  ensureContentBridgePromise = ensureContentBridgeInjectedOnce().finally(() => {
    ensureContentBridgePromise = null;
  });
  return ensureContentBridgePromise;
}

type MainWorldMonacoAction = "read" | "set";

interface MainWorldMonacoResponse {
  ok: boolean;
  value?: string;
  reason?: string;
  error?: string;
}

interface MainWorldClickResponse {
  ok: boolean;
  reason?: string;
  error?: string;
}

interface MainWorldClickRequest {
  markerAttr: string;
  markerValue: string;
}

interface MainWorldInvokeRequest {
  code: string;
  args: unknown[];
}

interface MainWorldInvokeResponse {
  ok: boolean;
  value?: unknown;
  reason?: string;
  error?: string;
}

async function callMonacoInMainWorld(
  tabId: number,
  action: MainWorldMonacoAction,
  value?: string
): Promise<MainWorldMonacoResponse> {
  const request: { action: MainWorldMonacoAction; value?: string } = { action };
  if (value !== undefined) {
    request.value = value;
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (request: { action: MainWorldMonacoAction; value?: string }) => {
      const globalObj = window as unknown as {
        monaco?: {
          editor?: {
            getEditors?: () => Array<{
              hasTextFocus?: () => boolean;
              getModel?: () => {
                getValue?: () => string | null | undefined;
                setValue?: (next: string) => void;
              } | null;
            }>;
          };
        };
      };

      const editors = globalObj.monaco?.editor?.getEditors?.() ?? [];
      if (!Array.isArray(editors) || editors.length === 0) {
        return {
          ok: false,
          reason: "no_monaco_editors"
        };
      }

      const focused = editors.find((editor) => editor?.hasTextFocus?.() === true);
      const ordered = focused ? [focused, ...editors.filter((editor) => editor !== focused)] : editors;
      const model = ordered
        .map((editor) => editor?.getModel?.())
        .find((candidate) => candidate && typeof candidate.getValue === "function");
      if (!model) {
        return {
          ok: false,
          reason: "no_monaco_model"
        };
      }

      if (request.action === "set") {
        if (typeof model.setValue !== "function") {
          return {
            ok: false,
            reason: "no_monaco_setter"
          };
        }
        model.setValue(typeof request.value === "string" ? request.value : "");
        return {
          ok: true
        };
      }

      const raw = model.getValue?.();
      return {
        ok: true,
        value: typeof raw === "string" ? raw : String(raw ?? "")
      };
    },
    args: [request]
  });

  if (!result || typeof result.result !== "object" || result.result === null) {
    return {
      ok: false,
      error: "invalid_main_world_response"
    };
  }

  const payload = result.result as {
    ok?: unknown;
    value?: unknown;
    reason?: unknown;
    error?: unknown;
  };
  const response: MainWorldMonacoResponse = {
    ok: payload.ok === true
  };
  if (typeof payload.value === "string") {
    response.value = payload.value;
  }
  if (typeof payload.reason === "string") {
    response.reason = payload.reason;
  }
  if (typeof payload.error === "string") {
    response.error = payload.error;
  }
  return response;
}

async function callClickInMainWorld(tabId: number, request: MainWorldClickRequest): Promise<MainWorldClickResponse> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (request: MainWorldClickRequest) => {
      const attr = typeof request.markerAttr === "string" ? request.markerAttr : "";
      const value = typeof request.markerValue === "string" ? request.markerValue : "";
      if (!attr || !value) {
        return {
          ok: false,
          reason: "invalid_marker"
        };
      }

      const escaped =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(value)
          : value.replace(/["\\]/g, "\\$&");
      const selector = `[${attr}="${escaped}"]`;
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLElement)) {
        return {
          ok: false,
          reason: "target_not_found"
        };
      }

      const rect = target.getBoundingClientRect();
      const clientX = rect.left + Math.max(1, Math.floor(rect.width / 2));
      const clientY = rect.top + Math.max(1, Math.floor(rect.height / 2));

      const mouseBase: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        button: 0,
        buttons: 1,
        clientX,
        clientY
      };
      const pointerBase: PointerEventInit = {
        ...mouseBase,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true
      };

      if (typeof PointerEvent === "function") {
        target.dispatchEvent(new PointerEvent("pointerdown", pointerBase));
        target.dispatchEvent(new PointerEvent("pointerup", pointerBase));
      }
      target.dispatchEvent(new MouseEvent("mousedown", mouseBase));
      target.dispatchEvent(new MouseEvent("mouseup", mouseBase));
      target.dispatchEvent(new MouseEvent("click", mouseBase));
      target.click();
      return {
        ok: true
      };
    },
    args: [request]
  });

  if (!result || typeof result.result !== "object" || result.result === null) {
    return {
      ok: false,
      error: "invalid_main_world_click_response"
    };
  }
  const payload = result.result as {
    ok?: unknown;
    reason?: unknown;
    error?: unknown;
  };
  const response: MainWorldClickResponse = {
    ok: payload.ok === true
  };
  if (typeof payload.reason === "string") {
    response.reason = payload.reason;
  }
  if (typeof payload.error === "string") {
    response.error = payload.error;
  }
  return response;
}

async function callInvokeInMainWorld(tabId: number, request: MainWorldInvokeRequest): Promise<MainWorldInvokeResponse> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (request: MainWorldInvokeRequest) => {
        try {
          if (typeof request.code !== "string" || request.code.trim().length === 0) {
            return {
              ok: false,
              reason: "invalid_code"
            };
          }
          const args = Array.isArray(request.args) ? request.args : [];
          const runner = new Function("args", request.code) as (args: unknown[]) => unknown;
          const value = await Promise.resolve(runner(args));
          return {
            ok: true,
            value
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      },
      args: [request]
    });

    if (!result || typeof result.result !== "object" || result.result === null) {
      return {
        ok: false,
        error: "invalid_main_world_invoke_response"
      };
    }

    const payload = result.result as {
      ok?: unknown;
      value?: unknown;
      reason?: unknown;
      error?: unknown;
    };
    const response: MainWorldInvokeResponse = {
      ok: payload.ok === true
    };
    if ("value" in payload) {
      response.value = payload.value;
    }
    if (typeof payload.reason === "string") {
      response.reason = payload.reason;
    }
    if (typeof payload.error === "string") {
      response.error = payload.error;
    }
    return response;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function listRemotePages(): Promise<ExtensionRpcResultByMethod["pages.list"]> {
  const tabs = await getTrackableTabs();
  return tabs.map((tab) => {
    const page = {
      pageId: `tab:${tab.id as number}`
    } as ExtensionRpcResultByMethod["pages.list"][number];
    if (tab.url) {
      page.url = tab.url;
    }
    if (tab.title) {
      page.title = tab.title;
    }
    page.active = Boolean(tab.active);
    return page;
  });
}

async function extractRemotePage(pageId: string): Promise<ExtensionRpcResultByMethod["page.extract"]> {
  const tabId = parsePageId(pageId);
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }

  const runtimePluginPacks = await fetchRuntimePluginPacks();
  const response = await sendToTab<ContentExtractResult>(tabId, {
    type: "bridge.extract",
    runtimePluginPacks
  });
  if (!response.ok) {
    throw new RpcHandledError(response.error.code, response.error.message, response.error.details);
  }

  const result: ExtensionRpcResultByMethod["page.extract"] = {
    pageId,
    pageType: response.result.pageType,
    tree: response.result.tree,
    pageCalls: response.result.pageCalls,
    url: response.result.url,
    title: response.result.title
  };

  if (tab?.url && !result.url) {
    result.url = tab.url;
  }
  if (tab?.title && !result.title) {
    result.title = tab.title;
  }
  return result;
}

async function setRemoteValue(
  params: ExtensionRpcRequest<"page.setValue">["params"]
): Promise<ExtensionRpcResultByMethod["page.setValue"]> {
  const tabId = parsePageId(params.pageId);
  const runtimePluginPacks = await fetchRuntimePluginPacks();
  const request: ContentBridgeRequest = {
    type: "bridge.setValue",
    target: params.target,
    value: params.value,
    runtimePluginPacks
  };
  if (params.locator) {
    request.locator = params.locator;
  }

  const response = await sendToTab<{ ok: true }>(tabId, request);
  if (!response.ok) {
    throw new RpcHandledError(response.error.code, response.error.message, response.error.details);
  }
  return { ok: true };
}

async function callRemoteFunction(
  params: ExtensionRpcRequest<"page.call">["params"]
): Promise<ExtensionRpcResultByMethod["page.call"]> {
  const tabId = parsePageId(params.pageId);
  const runtimePluginPacks = await fetchRuntimePluginPacks();
  const request: ContentBridgeRequest = {
    type: "bridge.call",
    target: params.target,
    fn: params.fn,
    runtimePluginPacks
  };
  if (params.locator) {
    request.locator = params.locator;
  }
  if (params.args) {
    request.args = params.args;
  }

  const response = await sendToTab<{ output?: unknown }>(tabId, request);
  if (!response.ok) {
    throw new RpcHandledError(response.error.code, response.error.message, response.error.details);
  }
  return response.result;
}

function parseBase64DataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) {
    throw new RpcHandledError("ACTION_FAIL", "Invalid screenshot payload");
  }
  return {
    mimeType: match[1] || "image/png",
    data: match[2] || ""
  };
}

async function captureRemotePageScreenshot(pageId: string): Promise<ExtensionRpcResultByMethod["page.screenshot"]> {
  const tabId = parsePageId(pageId);
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new RpcHandledError("NOT_FOUND", `Tab not found for pageId: ${pageId}`);
  }

  const windowId = tab.windowId;
  if (windowId === undefined) {
    throw new RpcHandledError("ACTION_FAIL", `Cannot resolve window for pageId: ${pageId}`);
  }

  const activeTabs = await chrome.tabs.query({ windowId, active: true });
  const prevActiveTabId = activeTabs[0]?.id;
  const switched = tab.active !== true;

  try {
    if (switched) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const parsed = parseBase64DataUrl(dataUrl);
    return {
      mimeType: parsed.mimeType,
      encoding: "base64",
      data: parsed.data
    };
  } finally {
    if (switched && prevActiveTabId !== undefined && prevActiveTabId !== tabId) {
      try {
        await chrome.tabs.update(prevActiveTabId, { active: true });
      } catch {
        // best effort restore
      }
    }
  }
}

function requestExtensionReload(): ExtensionRpcResultByMethod["extension.reload"] {
  // Allow rpc.response to flush before service worker restarts.
  setTimeout(() => {
    chrome.runtime.reload();
  }, 80);
  return { ok: true };
}

async function handleRpcRequest<M extends ExtensionRpcMethod>(
  method: M,
  params: ExtensionRpcRequest<M>["params"]
): Promise<ExtensionRpcResultByMethod[M]> {
  if (method === "pages.list") {
    return (await listRemotePages()) as ExtensionRpcResultByMethod[M];
  }
  if (method === "page.extract") {
    return (await extractRemotePage((params as { pageId: string }).pageId)) as ExtensionRpcResultByMethod[M];
  }
  if (method === "page.setValue") {
    return (await setRemoteValue(params as ExtensionRpcRequest<"page.setValue">["params"])) as ExtensionRpcResultByMethod[M];
  }
  if (method === "page.call") {
    return (await callRemoteFunction(params as ExtensionRpcRequest<"page.call">["params"])) as ExtensionRpcResultByMethod[M];
  }
  if (method === "page.screenshot") {
    return (await captureRemotePageScreenshot((params as { pageId: string }).pageId)) as ExtensionRpcResultByMethod[M];
  }
  if (method === "extension.reload") {
    return requestExtensionReload() as ExtensionRpcResultByMethod[M];
  }
  throw new RpcHandledError("INVALID_REQUEST", `Unsupported RPC method: ${String(method)}`);
}

function sendEnvelope(envelope: ExtensionRpcResponse): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(envelope));
}

function onSocketMessage(event: MessageEvent<string>): void {
  let envelope: ExtensionRpcEnvelope;
  try {
    envelope = JSON.parse(event.data) as ExtensionRpcEnvelope;
  } catch {
    return;
  }

  if (envelope.type !== "rpc.request") {
    return;
  }

  void (async () => {
    try {
      const result = await handleRpcRequest(envelope.method, envelope.params);
      const response: ExtensionRpcResponse = {
        type: "rpc.response",
        id: envelope.id,
        ok: true,
        result
      };
      sendEnvelope(response);
    } catch (error) {
      const response: ExtensionRpcFailureResponse = {
        type: "rpc.response",
        id: envelope.id,
        ok: false,
        error: toRpcError(error)
      };
      sendEnvelope(response);
    }
  })();
}

function scheduleReconnect(): void {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectSocket();
  }, RECONNECT_DELAY_MS);
}

async function connectSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = await getServerWsUrl();
  let nextSocket: WebSocket;
  try {
    nextSocket = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    throw new RpcHandledError("ACTION_FAIL", `Invalid websocket endpoint: ${wsUrl}`);
  }
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    const connectedEvent: ExtensionRpcEnvelope = {
      type: "rpc.event",
      event: "extension.connected",
      payload: {
        agent: "playwrong-extension"
      }
    };
    if (socket === nextSocket && nextSocket.readyState === WebSocket.OPEN) {
      nextSocket.send(JSON.stringify(connectedEvent));
    }
    void ensureContentBridgeInjected();
  });

  nextSocket.addEventListener("message", (event) => {
    onSocketMessage(event as MessageEvent<string>);
  });

  nextSocket.addEventListener("close", () => {
    if (socket === nextSocket) {
      socket = null;
    }
    scheduleReconnect();
  });

  nextSocket.addEventListener("error", () => {
    if (nextSocket.readyState !== WebSocket.OPEN) {
      nextSocket.close();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureReconnectAlarm();
  void ensureContentBridgeInjected();
  void connectSocket();
});

chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm();
  void ensureContentBridgeInjected();
  void connectSocket();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM_NAME) {
    return;
  }
  void connectSocket();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (!changes[STORAGE_SERVER_WS_URL_KEY]) {
    return;
  }
  if (socket) {
    socket.close();
  } else {
    scheduleReconnect();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }
  const type = (message as { type?: unknown }).type;
  if (type === "playwrong.mainworld.monaco") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        error: "Cannot resolve sender tab"
      } satisfies MainWorldMonacoResponse);
      return;
    }

    const actionRaw = (message as { action?: unknown }).action;
    if (actionRaw !== "read" && actionRaw !== "set") {
      sendResponse({
        ok: false,
        error: "Invalid main world Monaco action"
      } satisfies MainWorldMonacoResponse);
      return;
    }
    const valueRaw = (message as { value?: unknown }).value;
    const nextValue = typeof valueRaw === "string" ? valueRaw : undefined;

    void callMonacoInMainWorld(tabId, actionRaw, nextValue)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies MainWorldMonacoResponse);
      });
    return true;
  }

  if (type === "playwrong.mainworld.click") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        error: "Cannot resolve sender tab"
      } satisfies MainWorldClickResponse);
      return;
    }

    const markerAttr = (message as { markerAttr?: unknown }).markerAttr;
    const markerValue = (message as { markerValue?: unknown }).markerValue;
    if (typeof markerAttr !== "string" || !markerAttr || typeof markerValue !== "string" || !markerValue) {
      sendResponse({
        ok: false,
        error: "Invalid main world click payload"
      } satisfies MainWorldClickResponse);
      return;
    }

    void callClickInMainWorld(tabId, { markerAttr, markerValue })
      .then((result) => {
        sendResponse(result);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies MainWorldClickResponse);
      });
    return true;
  }

  if (type === "playwrong.mainworld.invoke") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        error: "Cannot resolve sender tab"
      } satisfies MainWorldInvokeResponse);
      return;
    }

    const code = (message as { code?: unknown }).code;
    const args = (message as { args?: unknown }).args;
    if (typeof code !== "string" || code.trim().length === 0) {
      sendResponse({
        ok: false,
        error: "Invalid main world invoke payload: code is required"
      } satisfies MainWorldInvokeResponse);
      return;
    }
    if (code.length > 50000) {
      sendResponse({
        ok: false,
        error: "Invalid main world invoke payload: code too large"
      } satisfies MainWorldInvokeResponse);
      return;
    }

    void callInvokeInMainWorld(tabId, { code, args: Array.isArray(args) ? args : [] })
      .then((result) => {
        sendResponse(result);
      })
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        } satisfies MainWorldInvokeResponse);
      });
    return true;
  }

  if (type !== "playwrong.wakeup") {
    return;
  }
  void connectSocket()
    .then(() => {
      void ensureContentBridgeInjected();
      sendResponse({ ok: true });
    })
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  return true;
});

void connectSocket();
ensureReconnectAlarm();
