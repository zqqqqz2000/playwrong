import { pickScript } from "@playwrong/plugin-sdk";
import type { MatchContext, MatchResult, NodeTarget, PluginScript } from "@playwrong/plugin-sdk";
import type { PluginExtractResult, ScalarValue, SemanticNode } from "@playwrong/protocol";

export interface SelectedPluginScript {
  script: PluginScript;
  result: MatchResult;
}

export class ExtensionPluginHost {
  constructor(private readonly scripts: PluginScript[]) {}

  async select(ctx: MatchContext): Promise<SelectedPluginScript | null> {
    return await pickScript(this.scripts, ctx);
  }

  async extract(ctx: MatchContext): Promise<PluginExtractResult | null> {
    const selected = await this.select(ctx);
    if (!selected) {
      return null;
    }
    return selected.script.extract(ctx);
  }

  async setValue(
    ctx: MatchContext,
    tree: SemanticNode[],
    target: NodeTarget,
    value: ScalarValue
  ): Promise<void> {
    const selected = await this.select(ctx);
    if (!selected) {
      throw new Error("PLUGIN_MISS");
    }
    await selected.script.setValue({ ...ctx, tree, target }, value);
  }

  async call(
    ctx: MatchContext,
    tree: SemanticNode[],
    target: NodeTarget,
    fn: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    const selected = await this.select(ctx);
    if (!selected) {
      throw new Error("PLUGIN_MISS");
    }
    return selected.script.invoke({ ...ctx, tree, target }, fn, args);
  }
}
