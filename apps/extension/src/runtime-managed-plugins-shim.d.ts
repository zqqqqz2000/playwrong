declare module "@playwrong/runtime-managed-plugins" {
  import type { PluginScript } from "@playwrong/plugin-sdk";

  export const managedPluginScripts: PluginScript[];
  export const managedPluginInfo: {
    moduleCount: number;
    scriptCount: number;
  };
  export const managedPluginModuleCount: number;
  export const managedPluginScriptCount: number;
}
