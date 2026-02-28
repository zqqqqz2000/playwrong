import type { PluginExtractResult, ScalarValue, SemanticNode } from "@playwrong/protocol";

export interface MatchContext {
  url: URL;
  title?: string;
  signals?: string[];
}

export interface MatchResult {
  matched: boolean;
  score: number;
  pageType?: string;
  reason?: string;
}

export interface ScriptMatchRule {
  hosts?: string[];
  paths?: Array<string | RegExp>;
  query?: Record<string, string | RegExp>;
  titleIncludes?: string[];
  requiredSignals?: string[];
  forbiddenSignals?: string[];
  pageType?: string;
  scoreBoost?: number;
}

export interface NodeTarget {
  id: string;
  path?: string[];
}

export interface ExtractContext extends MatchContext {}

export interface ActionContext extends MatchContext {
  tree: SemanticNode[];
  target: NodeTarget;
}

export interface PluginScript {
  scriptId: string;
  priority?: number;
  rules?: ScriptMatchRule[];
  match?: (ctx: MatchContext) => MatchResult | Promise<MatchResult>;
  extract(ctx: ExtractContext): Promise<PluginExtractResult>;
  setValue(ctx: ActionContext, value: ScalarValue): Promise<void>;
  invoke(ctx: ActionContext, fn: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface SitePlugin {
  pluginId: string;
  scripts: PluginScript[];
}
