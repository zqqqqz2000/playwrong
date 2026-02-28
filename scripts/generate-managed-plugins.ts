import { join } from "node:path";
import { PluginManager } from "../apps/server/src/plugin-manager";

const workspaceRoot = join(import.meta.dir, "..");
const manager = new PluginManager({ workspaceRoot });
const output = await manager.generateManagedPluginsFile();
console.log(JSON.stringify(output, null, 2));
