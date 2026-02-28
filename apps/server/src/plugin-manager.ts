import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { BridgeError } from "@playwrong/protocol";

export interface PluginScopeRule {
  hosts?: string[];
  paths?: string[];
}

export interface PluginPackManifest {
  schemaVersion: 1;
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  match: PluginScopeRule;
}

export interface PluginSourceGit {
  type: "git";
  repoUrl: string;
  ref?: string;
}

export interface InstalledPluginRecord {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  match: PluginScopeRule;
  enabled: boolean;
  source: PluginSourceGit;
  installedAt: string;
  updatedAt: string;
  dirName: string;
}

interface PluginRegistryFile {
  version: 1;
  plugins: InstalledPluginRecord[];
}

export interface InstallPluginFromGitInput {
  repoUrl: string;
  ref?: string;
  enabled?: boolean;
}

export interface PluginManagerOptions {
  workspaceRoot?: string;
  pluginsRootDir?: string;
  generatedFilePath?: string;
  extensionBuildCommand?: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_REGISTRY_FILE = "registry.json";
const DEFAULT_INSTALLED_DIR = "installed";

function nowIso(): string {
  return new Date().toISOString();
}

function ensureArrayString(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new BridgeError("INVALID_REQUEST", `Invalid ${key}: expected array`, { key });
  }
  const parsed = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new BridgeError("INVALID_REQUEST", `Invalid ${key}: expected non-empty strings`, {
        key,
        value: item
      });
    }
    return item;
  });
  return parsed;
}

function ensureFileImportPath(fromDir: string, absPath: string): string {
  let importPath = relative(fromDir, absPath).replaceAll("\\", "/");
  if (!importPath.startsWith(".")) {
    importPath = `./${importPath}`;
  }
  importPath = importPath.replace(/\.(ts|tsx)$/, "");
  return importPath;
}

function sanitizePluginDirName(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class PluginManager {
  private readonly workspaceRoot: string;
  private readonly pluginsRootDir: string;
  private readonly installedRootDir: string;
  private readonly registryPath: string;
  private readonly generatedFilePath: string;
  private readonly extensionBuildCommand: string[];

  constructor(options: PluginManagerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.pluginsRootDir = options.pluginsRootDir ?? join(this.workspaceRoot, "plugins");
    this.installedRootDir = join(this.pluginsRootDir, DEFAULT_INSTALLED_DIR);
    this.registryPath = join(this.pluginsRootDir, DEFAULT_REGISTRY_FILE);
    this.generatedFilePath =
      options.generatedFilePath ?? join(this.workspaceRoot, "apps/extension/src/user-scripts/managed-plugins.generated.ts");
    this.extensionBuildCommand =
      options.extensionBuildCommand ?? ["bun", "run", "--cwd", join(this.workspaceRoot, "apps/extension"), "build"];
  }

  async listPlugins(): Promise<InstalledPluginRecord[]> {
    const registry = await this.readRegistry();
    return registry.plugins
      .slice()
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
      .map((plugin) => ({ ...plugin }));
  }

  async installFromGit(input: InstallPluginFromGitInput): Promise<InstalledPluginRecord> {
    if (!input.repoUrl || input.repoUrl.trim().length === 0) {
      throw new BridgeError("INVALID_REQUEST", "repoUrl is required", { field: "repoUrl" });
    }

    await this.ensureBaseDirs();

    const tmpDir = join(this.pluginsRootDir, `.tmp-install-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
    try {
      await this.runCommand(["git", "clone", "--depth", "1", input.repoUrl, tmpDir], this.workspaceRoot);
      if (input.ref && input.ref.trim().length > 0) {
        await this.runCommand(["git", "-C", tmpDir, "checkout", input.ref], this.workspaceRoot);
      }

      const manifest = await this.readManifest(tmpDir);
      const dirName = sanitizePluginDirName(manifest.pluginId);
      const destDir = join(this.installedRootDir, dirName);
      await rm(destDir, { recursive: true, force: true });
      await rename(tmpDir, destDir);

      const enabled = input.enabled ?? true;
      const next = await this.upsertRecordFromManifest(manifest, {
        dirName,
        enabled,
        source: {
          type: "git",
          repoUrl: input.repoUrl,
          ...(input.ref ? { ref: input.ref } : {})
        }
      });

      await this.generateManagedPluginsFile();
      return next;
    } catch (error) {
      await rm(tmpDir, { recursive: true, force: true });
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError("ACTION_FAIL", "Failed to install plugin from git", {
        repoUrl: input.repoUrl,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<InstalledPluginRecord> {
    if (!pluginId) {
      throw new BridgeError("INVALID_REQUEST", "pluginId is required", { field: "pluginId" });
    }

    const registry = await this.readRegistry();
    const existing = registry.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!existing) {
      throw new BridgeError("NOT_FOUND", `Plugin not found: ${pluginId}`, { pluginId });
    }

    existing.enabled = enabled;
    existing.updatedAt = nowIso();
    await this.writeRegistry(registry);
    await this.generateManagedPluginsFile();
    return { ...existing };
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    if (!pluginId) {
      throw new BridgeError("INVALID_REQUEST", "pluginId is required", { field: "pluginId" });
    }

    const registry = await this.readRegistry();
    const existing = registry.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!existing) {
      throw new BridgeError("NOT_FOUND", `Plugin not found: ${pluginId}`, { pluginId });
    }

    const pluginDir = join(this.installedRootDir, existing.dirName);
    await rm(pluginDir, { recursive: true, force: true });

    registry.plugins = registry.plugins.filter((plugin) => plugin.pluginId !== pluginId);
    await this.writeRegistry(registry);
    await this.generateManagedPluginsFile();
  }

  async generateManagedPluginsFile(): Promise<{ outputPath: string; pluginCount: number; enabledCount: number }> {
    await this.ensureBaseDirs();

    const registry = await this.readRegistry();
    const outputDir = dirname(this.generatedFilePath);
    await mkdir(outputDir, { recursive: true });

    const enabledPlugins = registry.plugins.filter((plugin) => plugin.enabled);
    const importLines: string[] = [];
    const entryLines: string[] = [];

    for (const [i, plugin] of enabledPlugins.entries()) {
      const entryAbsPath = await this.resolvePluginEntryPath(plugin);
      const modulePath = ensureFileImportPath(outputDir, entryAbsPath);
      importLines.push(`import * as pluginModule${i} from "${modulePath}";`);

      const scopeLiteral = JSON.stringify(
        {
          ...(plugin.match.hosts && plugin.match.hosts.length > 0 ? { hosts: plugin.match.hosts } : {}),
          ...(plugin.match.paths && plugin.match.paths.length > 0 ? { paths: plugin.match.paths } : {})
        },
        null,
        2
      )
        .split("\n")
        .join("\n      ");

      entryLines.push(`  {
    pluginId: ${JSON.stringify(plugin.pluginId)},
    scripts: normalizePluginScripts(pluginModule${i}),
    scope: ${scopeLiteral}
  }`);
    }

    const content = [
      "/* eslint-disable */",
      "// AUTO-GENERATED FILE. DO NOT EDIT.",
      "// Generated by PluginManager.generateManagedPluginsFile().",
      'import type { PluginScript, ScriptMatchRule } from "@playwrong/plugin-sdk";',
      importLines.join("\n"),
      "",
      "type PluginModuleLike = { pluginScripts?: PluginScript[]; default?: PluginScript[] };",
      "",
      "function normalizePluginScripts(input: unknown): PluginScript[] {",
      "  const candidate = input as PluginModuleLike;",
      "  if (Array.isArray(candidate.pluginScripts)) {",
      "    return candidate.pluginScripts;",
      "  }",
      "  if (Array.isArray(candidate.default)) {",
      "    return candidate.default;",
      "  }",
      "  return [];",
      "}",
      "",
      "function mergeScope(pluginId: string, scripts: PluginScript[], scope: ScriptMatchRule): PluginScript[] {",
      "  return scripts.map((script, index) => {",
      "    const scriptId = script.scriptId || `${pluginId}.${index + 1}`;",
      "    const rules = script.rules && script.rules.length > 0 ? [scope, ...script.rules] : [scope];",
      "    return { ...script, scriptId, rules };",
      "  });",
      "}",
      "",
      "const managedPluginEntries: Array<{ pluginId: string; scripts: PluginScript[]; scope: ScriptMatchRule }> = [",
      entryLines.join(",\n"),
      "];",
      "",
      "export const managedPluginScripts: PluginScript[] = managedPluginEntries.flatMap((entry) =>",
      "  mergeScope(entry.pluginId, entry.scripts, entry.scope)",
      ");",
      "",
      "export const managedPluginInfo = managedPluginEntries.map((entry) => ({",
      "  pluginId: entry.pluginId,",
      "  scriptCount: entry.scripts.length",
      "}));",
      ""
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    await writeFile(this.generatedFilePath, content, "utf8");
    return {
      outputPath: this.generatedFilePath,
      pluginCount: registry.plugins.length,
      enabledCount: enabledPlugins.length
    };
  }

  async applyPluginsToExtensionBuild(): Promise<{
    generated: { outputPath: string; pluginCount: number; enabledCount: number };
    build: CommandResult;
  }> {
    const generated = await this.generateManagedPluginsFile();
    const build = await this.runCommand(this.extensionBuildCommand, this.workspaceRoot);
    return { generated, build };
  }

  private async resolvePluginEntryPath(plugin: InstalledPluginRecord): Promise<string> {
    const rootDir = join(this.installedRootDir, plugin.dirName);
    const entryPath = join(rootDir, plugin.entry);
    await this.assertFileExists(entryPath, `entry not found for plugin ${plugin.pluginId}`);
    return entryPath;
  }

  private async upsertRecordFromManifest(
    manifest: PluginPackManifest,
    input: { dirName: string; enabled: boolean; source: PluginSourceGit }
  ): Promise<InstalledPluginRecord> {
    const registry = await this.readRegistry();
    const now = nowIso();
    const existing = registry.plugins.find((plugin) => plugin.pluginId === manifest.pluginId);

    const record: InstalledPluginRecord = {
      pluginId: manifest.pluginId,
      name: manifest.name,
      version: manifest.version,
      entry: manifest.entry,
      match: manifest.match,
      enabled: input.enabled,
      source: input.source,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      dirName: input.dirName
    };
    if (manifest.description !== undefined) {
      record.description = manifest.description;
    }

    const nextPlugins = registry.plugins.filter((plugin) => plugin.pluginId !== manifest.pluginId);
    nextPlugins.push(record);
    nextPlugins.sort((a, b) => a.pluginId.localeCompare(b.pluginId));

    registry.plugins = nextPlugins;
    await this.writeRegistry(registry);
    return { ...record };
  }

  private async readRegistry(): Promise<PluginRegistryFile> {
    await this.ensureBaseDirs();

    try {
      const raw = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PluginRegistryFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
        throw new BridgeError("INVALID_REQUEST", "Invalid plugins/registry.json format", {
          registryPath: this.registryPath
        });
      }
      return {
        version: 1,
        plugins: parsed.plugins
      };
    } catch (error) {
      if (error instanceof BridgeError) {
        throw error;
      }
      const fallback: PluginRegistryFile = { version: 1, plugins: [] };
      await this.writeRegistry(fallback);
      return fallback;
    }
  }

  private async writeRegistry(registry: PluginRegistryFile): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    await writeFile(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  }

  private async readManifest(pluginRootDir: string): Promise<PluginPackManifest> {
    const manifestPath = join(pluginRootDir, "playwrong.plugin.json");
    await this.assertFileExists(manifestPath, "Missing playwrong.plugin.json in plugin repository");

    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginPackManifest>;

    if (parsed.schemaVersion !== 1) {
      throw new BridgeError("INVALID_REQUEST", "Unsupported plugin schemaVersion", {
        schemaVersion: parsed.schemaVersion
      });
    }
    if (!parsed.pluginId || typeof parsed.pluginId !== "string") {
      throw new BridgeError("INVALID_REQUEST", "pluginId is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,127}$/i.test(parsed.pluginId)) {
      throw new BridgeError("INVALID_REQUEST", "Invalid pluginId format", {
        pluginId: parsed.pluginId
      });
    }
    if (!parsed.name || typeof parsed.name !== "string") {
      throw new BridgeError("INVALID_REQUEST", "name is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (!parsed.version || typeof parsed.version !== "string") {
      throw new BridgeError("INVALID_REQUEST", "version is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (!parsed.entry || typeof parsed.entry !== "string") {
      throw new BridgeError("INVALID_REQUEST", "entry is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (isAbsolute(parsed.entry) || parsed.entry.includes("..")) {
      throw new BridgeError("INVALID_REQUEST", "entry must be a safe relative path", {
        entry: parsed.entry
      });
    }
    if (!parsed.match || typeof parsed.match !== "object") {
      throw new BridgeError("INVALID_REQUEST", "match is required in playwrong.plugin.json", {
        manifestPath
      });
    }

    const hosts = parsed.match.hosts ? ensureArrayString(parsed.match.hosts, "match.hosts") : undefined;
    const paths = parsed.match.paths ? ensureArrayString(parsed.match.paths, "match.paths") : undefined;

    if ((!hosts || hosts.length === 0) && (!paths || paths.length === 0)) {
      throw new BridgeError("INVALID_REQUEST", "match.hosts or match.paths must be provided", {
        match: parsed.match
      });
    }

    const entryPath = join(pluginRootDir, parsed.entry);
    await this.assertFileExists(entryPath, `Plugin entry not found: ${parsed.entry}`);

    const manifest: PluginPackManifest = {
      schemaVersion: 1,
      pluginId: parsed.pluginId,
      name: parsed.name,
      version: parsed.version,
      entry: parsed.entry,
      match: {
        ...(hosts ? { hosts } : {}),
        ...(paths ? { paths } : {})
      }
    };
    if (parsed.description && typeof parsed.description === "string") {
      manifest.description = parsed.description;
    }

    return manifest;
  }

  private async assertFileExists(path: string, message: string): Promise<void> {
    try {
      await access(path);
    } catch {
      throw new BridgeError("NOT_FOUND", message, { path });
    }
  }

  private async ensureBaseDirs(): Promise<void> {
    await mkdir(this.pluginsRootDir, { recursive: true });
    await mkdir(this.installedRootDir, { recursive: true });
  }

  private async runCommand(command: string[], cwd: string): Promise<CommandResult> {
    if (command.length === 0) {
      throw new BridgeError("INVALID_REQUEST", "Command is empty", {});
    }

    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe"
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    if (exitCode !== 0) {
      throw new BridgeError("ACTION_FAIL", `Command failed: ${command.join(" ")}`, {
        command,
        cwd,
        exitCode,
        stderr,
        stdout
      });
    }

    return { stdout, stderr };
  }
}
