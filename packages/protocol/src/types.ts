export type NodeKind =
  | "page"
  | "group"
  | "section"
  | "form"
  | "list"
  | "item"
  | "table"
  | "row"
  | "cell"
  | "editable"
  | "action"
  | "select"
  | "toggle"
  | "content";

export type LocatorStrategyType = "aria" | "css" | "xpath" | "text" | "relative";
export type ScalarValue = string | number | boolean | null | string[];

export interface FunctionCallDef {
  name: string;
  argsSchema?: Record<string, unknown>;
  returns?: string;
  sideEffect?: boolean;
}

export interface LocatorStrategy {
  type: LocatorStrategyType;
  query: string;
  weight: number;
  required?: boolean;
}

export interface LocatorAnchor {
  urlPattern?: string;
  frame?: "main" | "any";
  role?: string;
  nearbyText?: string[];
}

export interface LocatorConstraints {
  visible?: boolean;
  enabled?: boolean;
  unique?: boolean;
  tagNames?: string[];
}

export interface LocatorSpec {
  version: 1;
  anchors?: LocatorAnchor;
  strategies: LocatorStrategy[];
  constraints?: LocatorConstraints;
  threshold?: number;
  ambiguityDelta?: number;
}

export interface SemanticNode {
  id: string;
  kind: NodeKind;
  label?: string;
  value?: ScalarValue;
  attrs?: Record<string, string | number | boolean>;
  locator?: LocatorSpec;
  calls?: FunctionCallDef[];
  children?: SemanticNode[];
}

export interface PluginExtractResult {
  pageType: string;
  tree: SemanticNode[];
  pageCalls?: FunctionCallDef[];
}

export interface PageSnapshot {
  pageId: string;
  pageType: string;
  rev: number;
  tree: SemanticNode[];
  pageCalls?: FunctionCallDef[];
  url?: string;
  title?: string;
  updatedAt: number;
}

export interface PullFile {
  id: string;
  kind: "editable" | "select" | "toggle";
  path: string;
  content: string;
}

export interface PullRequest {
  pageId: string;
}

export interface PullScreenshot {
  mimeType: string;
  encoding: "base64";
  data: string;
}

export interface PullResponse {
  pageId: string;
  rev: number;
  xml: string;
  files: PullFile[];
  screenshot?: PullScreenshot;
}

export interface ApplyEdit {
  id: string;
  value: ScalarValue;
  path?: string[];
}

export interface ApplyRequest {
  pageId: string;
  baseRev: number;
  edits: ApplyEdit[];
}

export interface ApplyResponse {
  pageId: string;
  rev: number;
  updatedIds: string[];
}

export interface CallRequest {
  pageId: string;
  baseRev: number;
  target: { id: string; path?: string[] };
  fn: string;
  args?: Record<string, unknown>;
}

export interface CallResponse {
  pageId: string;
  rev: number;
  output?: unknown;
}

export interface UpsertSnapshotRequest {
  pageId: string;
  pageType: string;
  tree: SemanticNode[];
  pageCalls?: FunctionCallDef[];
  url?: string;
  title?: string;
}
