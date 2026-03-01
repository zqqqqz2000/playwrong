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

export type ExtensionRpcMethod =
  | "pages.list"
  | "page.extract"
  | "page.setValue"
  | "page.call"
  | "page.screenshot";

export type ExtensionRpcParamsByMethod = {
  "pages.list": Record<string, never>;
  "page.extract": { pageId: string };
  "page.setValue": RemoteSetValueParams;
  "page.call": RemoteCallParams;
  "page.screenshot": { pageId: string };
};

export type ExtensionRpcResultByMethod = {
  "pages.list": RemotePageInfo[];
  "page.extract": RemoteExtractResult;
  "page.setValue": { ok: true };
  "page.call": { output?: unknown };
  "page.screenshot": RemoteScreenshotResult;
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
