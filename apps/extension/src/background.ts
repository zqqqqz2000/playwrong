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
import type { ContentBridgeRequest, ContentBridgeResponse } from "./messages";

const DEFAULT_SERVER_WS_URL = "ws://127.0.0.1:7878/ws/extension";
const STORAGE_SERVER_WS_URL_KEY = "serverWsUrl";
const RECONNECT_DELAY_MS = 1500;

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
  // Keep runtime connection deterministic for local bridge runs.
  // Popup can still update storage, but background always dials the default local endpoint.
  return DEFAULT_SERVER_WS_URL;
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

  const response = await sendToTab<ContentExtractResult>(tabId, { type: "bridge.extract" });
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
  const request: ContentBridgeRequest = {
    type: "bridge.setValue",
    target: params.target,
    value: params.value
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
  const request: ContentBridgeRequest = {
    type: "bridge.call",
    target: params.target,
    fn: params.fn
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
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    const connectedEvent: ExtensionRpcEnvelope = {
      type: "rpc.event",
      event: "extension.connected",
      payload: {
        agent: "playwrong-extension"
      }
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(connectedEvent));
    }
  });

  socket.addEventListener("message", (event) => {
    onSocketMessage(event as MessageEvent<string>);
  });

  socket.addEventListener("close", () => {
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    if (socket && socket.readyState !== WebSocket.OPEN) {
      socket.close();
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void connectSocket();
});

chrome.runtime.onStartup.addListener(() => {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }
  const type = (message as { type?: unknown }).type;
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
