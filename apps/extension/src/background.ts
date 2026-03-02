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
const INJECT_DEBOUNCE_MS = 5000;
const CONTENT_BRIDGE_RETRY_DELAY_MS = 120;
const RUNTIME_PLUGIN_CACHE_TTL_MS = 5000;

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
let runtimePluginFetchPromise: Promise<RuntimePluginPackPayload[]> | null = null;
let runtimePluginCache:
  | {
      packs: RuntimePluginPackPayload[];
      hash: string;
      fetchedAt: number;
    }
  | null = null;

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

function hashRuntimePluginPacks(packs: readonly RuntimePluginPackPayload[]): string {
  return packs.map((pack) => `${pack.pluginId}:${pack.version}:${pack.updatedAt}:${pack.moduleUrl ?? ""}`).join("|");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      moduleUrlPath?: unknown;
    };
    if (
      typeof plugin.pluginId !== "string" ||
      typeof plugin.name !== "string" ||
      typeof plugin.version !== "string" ||
      typeof plugin.updatedAt !== "string"
    ) {
      continue;
    }
    const parsedPack: RuntimePluginPackPayload = {
      pluginId: plugin.pluginId,
      name: plugin.name,
      version: plugin.version,
      updatedAt: plugin.updatedAt
    };
    if (typeof plugin.moduleUrlPath === "string" && plugin.moduleUrlPath.length > 0) {
      parsedPack.moduleUrl = plugin.moduleUrlPath;
    } else {
      continue;
    }
    out.push(parsedPack);
  }
  return out;
}

async function fetchRuntimePluginPacks(): Promise<RuntimePluginPackPayload[]> {
  const now = Date.now();
  if (runtimePluginCache && now - runtimePluginCache.fetchedAt <= RUNTIME_PLUGIN_CACHE_TTL_MS) {
    return runtimePluginCache.packs;
  }
  if (runtimePluginFetchPromise) {
    return await runtimePluginFetchPromise;
  }

  runtimePluginFetchPromise = (async () => {
    const wsUrl = await getServerWsUrl();
    const baseUrl = wsToHttpBase(wsUrl);
    if (!baseUrl) {
      return runtimePluginCache?.packs ?? [];
    }

    try {
      const response = await fetch(new URL("/mapping-plugins/runtime", baseUrl), {
        method: "GET",
        headers: {
          "content-type": "application/json"
        }
      });
      if (!response.ok) {
        return runtimePluginCache?.packs ?? [];
      }

      const packs = parseRuntimePluginPacksPayload(await response.json());
      for (const pack of packs) {
        if (typeof pack.moduleUrl === "string" && pack.moduleUrl.length > 0) {
          pack.moduleUrl = new URL(pack.moduleUrl, baseUrl).toString();
        }
      }

      const hash = hashRuntimePluginPacks(packs);
      if (runtimePluginCache && runtimePluginCache.hash === hash) {
        runtimePluginCache.fetchedAt = Date.now();
        return runtimePluginCache.packs;
      }
      runtimePluginCache = {
        packs,
        hash,
        fetchedAt: Date.now()
      };
      return packs;
    } catch {
      return runtimePluginCache?.packs ?? [];
    }
  })();

  try {
    return await runtimePluginFetchPromise;
  } finally {
    runtimePluginFetchPromise = null;
  }
}

function isTransientTabMessageError(message: string): boolean {
  return (
    message.includes("Receiving end does not exist") ||
    message.includes("Could not establish connection") ||
    message.includes("message channel closed before a response was received") ||
    message.includes("The frame was removed") ||
    message.includes("No matching message handler")
  );
}

async function sendMessageToTab<T>(tabId: number, message: ContentBridgeRequest): Promise<ContentBridgeResponse<T>> {
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

async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (tab.status === "complete") {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status !== "complete") {
        return;
      }
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureTabCanReceiveMessages(tabId: number): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new RpcHandledError("NOT_FOUND", `Tab not found for id: ${tabId}`);
  }

  if (!tab.url || (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))) {
    throw new RpcHandledError("ACTION_FAIL", `Tab cannot inject content bridge: ${tab.url ?? "unknown"}`);
  }
  if (tab.status !== "complete") {
    await waitForTabComplete(tabId, 4000);
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new RpcHandledError("NOT_FOUND", `Tab not found for id: ${tabId}`);
    }
  }
  if (await hasContentBridge(tabId)) {
    return;
  }
  await injectContentBridge(tab);
  await sleep(CONTENT_BRIDGE_RETRY_DELAY_MS);
}

async function sendToTab<T>(tabId: number, message: ContentBridgeRequest): Promise<ContentBridgeResponse<T>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await sendMessageToTab<T>(tabId, message);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (!isTransientTabMessageError(messageText) || attempt >= 1) {
        throw error;
      }
      await ensureTabCanReceiveMessages(tabId);
    }
  }
  throw new RpcHandledError("ACTION_FAIL", "tabs.sendMessage failed after retries");
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
    const response = await sendMessageToTab<{ ok: true }>(tabId, { type: "playwrong.ping" });
    return response.ok;
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
  } catch {
    // best effort inject; some tabs may not allow script execution.
  } finally {
    injectingTabIds.delete(tabId);
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

async function activateRemotePage(pageId: string): Promise<ExtensionRpcResultByMethod["page.activate"]> {
  const tabId = parsePageId(pageId);
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    throw new RpcHandledError("NOT_FOUND", `Tab not found for pageId: ${pageId}`);
  }
  return { ok: true };
}

async function invokeInMainWorldRemote(
  params: ExtensionRpcRequest<"page.mainworldInvoke">["params"]
): Promise<ExtensionRpcResultByMethod["page.mainworldInvoke"]> {
  const tabId = parsePageId(params.pageId);
  const code = typeof params.code === "string" ? params.code : "";
  if (!code.trim()) {
    throw new RpcHandledError("INVALID_REQUEST", "code is required");
  }
  const args = Array.isArray(params.args) ? params.args : [];
  return await callInvokeInMainWorld(tabId, { code, args });
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
  if (method === "page.activate") {
    return (await activateRemotePage((params as { pageId: string }).pageId)) as ExtensionRpcResultByMethod[M];
  }
  if (method === "page.extract") {
    return (await extractRemotePage((params as { pageId: string }).pageId)) as ExtensionRpcResultByMethod[M];
  }
  if (method === "page.mainworldInvoke") {
    return (await invokeInMainWorldRemote(params as ExtensionRpcRequest<"page.mainworldInvoke">["params"])) as ExtensionRpcResultByMethod[M];
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
  void connectSocket();
});

chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm();
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
  runtimePluginCache = null;
  runtimePluginFetchPromise = null;
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
