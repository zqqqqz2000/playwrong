import type { FunctionCallDef, LocatorSpec, ScalarValue, SemanticNode } from "./types";

export interface RemotePageInfo {
  pageId: string;
  url?: string;
  title?: string;
  active?: boolean;
}

export interface RemoteExtractResult {
  pageId: string;
  pageType: string;
  tree: SemanticNode[];
  pageCalls?: FunctionCallDef[];
  url?: string;
  title?: string;
}

export interface RemoteSetValueParams {
  pageId: string;
  target: { id: string; path?: string[] };
  locator?: LocatorSpec;
  value: ScalarValue;
}

export interface RemoteCallParams {
  pageId: string;
  target: { id: string; path?: string[] };
  locator?: LocatorSpec;
  fn: string;
  args?: Record<string, unknown>;
}

export interface RemoteScreenshotResult {
  mimeType: string;
  encoding: "base64";
  data: string;
}

export interface RemoteMainWorldInvokeResult {
  ok: boolean;
  value?: unknown;
  reason?: string;
  error?: string;
}

export type ExtensionRpcMethod =
  | "pages.list"
  | "page.activate"
  | "page.extract"
  | "page.mainworldInvoke"
  | "page.setValue"
  | "page.call"
  | "page.screenshot"
  | "extension.reload";

export type ExtensionRpcParamsByMethod = {
  "pages.list": Record<string, never>;
  "page.activate": { pageId: string };
  "page.extract": { pageId: string };
  "page.mainworldInvoke": { pageId: string; code: string; args?: unknown[] };
  "page.setValue": RemoteSetValueParams;
  "page.call": RemoteCallParams;
  "page.screenshot": { pageId: string };
  "extension.reload": Record<string, never>;
};

export type ExtensionRpcResultByMethod = {
  "pages.list": RemotePageInfo[];
  "page.activate": { ok: true };
  "page.extract": RemoteExtractResult;
  "page.mainworldInvoke": RemoteMainWorldInvokeResult;
  "page.setValue": { ok: true };
  "page.call": { output?: unknown };
  "page.screenshot": RemoteScreenshotResult;
  "extension.reload": { ok: true };
};

export interface ExtensionRpcRequest<
  M extends ExtensionRpcMethod = ExtensionRpcMethod
> {
  type: "rpc.request";
  id: string;
  method: M;
  params: ExtensionRpcParamsByMethod[M];
}

export interface ExtensionRpcError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ExtensionRpcSuccessResponse {
  type: "rpc.response";
  id: string;
  ok: true;
  result: unknown;
}

export interface ExtensionRpcFailureResponse {
  type: "rpc.response";
  id: string;
  ok: false;
  error: ExtensionRpcError;
}

export type ExtensionRpcResponse = ExtensionRpcSuccessResponse | ExtensionRpcFailureResponse;

export interface ExtensionRpcEvent {
  type: "rpc.event";
  event: string;
  payload?: Record<string, unknown>;
}

export type ExtensionRpcEnvelope = ExtensionRpcRequest | ExtensionRpcResponse | ExtensionRpcEvent;
