import type { PluginScript } from "@playwrong/plugin-sdk";
import { createSearchEngineScripts } from "./search-engines";

export function createBuiltinSiteScripts(): PluginScript[] {
  return [...createSearchEngineScripts()];
}

