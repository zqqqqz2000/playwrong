import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { BridgeError } from "@playwrong/protocol";

export interface PluginScopeRule {
  hosts?: string[];
  paths?: string[];
}

export interface PluginSkillSpec {
  path: string;
}

export interface PluginRuntimeSpec {
  path: string;
}

export interface PluginPackManifest {
  schemaVersion: 1;
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  match: PluginScopeRule;
  skill: PluginSkillSpec;
  runtime?: PluginRuntimeSpec;
}

export interface PluginSourceGit {
  type: "git";
  repoUrl: string;
  ref?: string;
}

export interface PluginSourceDirectory {
  type: "directory";
  path: string;
}

export interface PluginSourceZip {
  type: "zip";
  path: string;
}

export type PluginSource = PluginSourceGit | PluginSourceDirectory | PluginSourceZip;

export interface InstalledPluginRecord {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  entry: string;
  match: PluginScopeRule;
  skillPath?: string;
  runtimePath?: string;
  enabled: boolean;
  source: PluginSource;
  installedAt: string;
  updatedAt: string;
  dirName: string;
}

export interface RuntimePluginPack {
  pluginId: string;
  name: string;
  version: string;
  updatedAt: string;
  runtimeJson: string;
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

export interface InstallPluginFromDirectoryInput {
  path: string;
  enabled?: boolean;
}

export interface InstallPluginFromZipInput {
  path: string;
  enabled?: boolean;
}

export interface InstallPluginInput {
  sourceType?: "git" | "dir" | "zip";
  repoUrl?: string;
  path?: string;
  ref?: string;
  enabled?: boolean;
}

export interface PluginManagerOptions {
  workspaceRoot?: string;
  playwrongHomeDir?: string;
  pluginsRootDir?: string;
  generatedFilePath?: string;
  managedRuntimeModulePath?: string;
  // Backward compatible alias for managedRuntimeModulePath.
  generatedBridgeFilePath?: string;
  extensionBuildCommand?: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_REGISTRY_FILE = "registry.json";
const DEFAULT_INSTALLED_DIR = "installed";
const PLAYWRONG_HOME_ENV = "PLAYWRONG_HOME";
const DEFAULT_PLAYWRONG_HOME_DIR = ".config/playwrong";
const DEFAULT_RUNTIME_MANAGED_PACKAGE_NAME = "@playwrong/runtime-managed-plugins";

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
    return item.trim();
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

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function resolvePlaywrongHomeDir(input?: string): string {
  const explicit = typeof input === "string" ? input.trim() : "";
  if (explicit) {
    const resolved = expandHomePath(explicit);
    return isAbsolute(resolved) ? resolved : join(process.cwd(), resolved);
  }

  const fromEnv = typeof process.env[PLAYWRONG_HOME_ENV] === "string" ? process.env[PLAYWRONG_HOME_ENV].trim() : "";
  if (fromEnv) {
    const resolved = expandHomePath(fromEnv);
    return isAbsolute(resolved) ? resolved : join(process.cwd(), resolved);
  }

  return join(homedir(), DEFAULT_PLAYWRONG_HOME_DIR);
}

function buildPluginDirName(pluginId: string): string {
  return pluginId;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isSafeRelativePath(path: string): boolean {
  if (!path || typeof path !== "string") {
    return false;
  }
  if (isAbsolute(path)) {
    return false;
  }
  if (path.includes("..")) {
    return false;
  }
  return true;
}

function validatePluginSkillContent(content: string, skillPath: string): void {
  const trimmed = content.trim();
  if (trimmed.length < 80) {
    throw new BridgeError("INVALID_REQUEST", "Plugin skill document is too short", {
      skillPath
    });
  }

  const hasUsage = /^##\s*(usage|how to use|use|用法|使用)/im.test(trimmed);
  const hasOps = /^##\s*(operations?|functions?|actions?|操作|函数|可用函数)/im.test(trimmed);
  if (!hasUsage || !hasOps) {
    throw new BridgeError(
      "INVALID_REQUEST",
      "Plugin skill must include sections for usage and operations/functions",
      {
        skillPath,
        requires: ["## Usage", "## Operations"]
      }
    );
  }

  const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*/.exec(content);
  if (!frontmatter) {
    throw new BridgeError("INVALID_REQUEST", "Plugin skill must include YAML frontmatter", {
      skillPath,
      requires: ["name", "description"]
    });
  }
  const frontmatterBody = frontmatter[1] ?? "";
  if (!/^name:\s*\S+/im.test(frontmatterBody) || !/^description:\s*.+/im.test(frontmatterBody)) {
    throw new BridgeError("INVALID_REQUEST", "Plugin skill frontmatter must include name and description", {
      skillPath
    });
  }

  const hasFailureModes = /^##\s*(failure modes?|errors?|failures?|故障|失败|异常)/im.test(trimmed);
  if (!hasFailureModes) {
    throw new BridgeError("INVALID_REQUEST", "Plugin skill must include a failure modes section", {
      skillPath,
      requires: ["## Failure Modes"]
    });
  }
}

function validateHostPattern(host: string): void {
  if (host !== host.toLowerCase()) {
    throw new BridgeError("INVALID_REQUEST", "match.hosts must be lowercase", { host });
  }
  if (/^https?:\/\//i.test(host) || host.includes("/") || host.includes(":")) {
    throw new BridgeError("INVALID_REQUEST", "match.hosts must be host patterns only", { host });
  }
  if (!/^[a-z0-9.*-]+(\.[a-z0-9.*-]+)*$/.test(host)) {
    throw new BridgeError("INVALID_REQUEST", "Invalid host pattern in match.hosts", { host });
  }
}

function validatePathPattern(path: string): void {
  if (path.includes("://")) {
    throw new BridgeError("INVALID_REQUEST", "match.paths must be path patterns only", { path });
  }
  if (!(path.startsWith("/") || path.startsWith("^"))) {
    throw new BridgeError("INVALID_REQUEST", "match.paths must start with '/' or '^'", { path });
  }
}

function validateVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new BridgeError("INVALID_REQUEST", "version must be semver-like", { version });
  }
}

// PluginManager manages mapping plugins that convert site pages into semantic XML for LLM workflows.
export class PluginManager {
  private readonly workspaceRoot: string;
  private readonly playwrongHomeDir: string;
  private readonly pluginsRootDir: string;
  private readonly installedRootDir: string;
  private readonly registryPath: string;
  private readonly legacyPluginsRootDir: string;
  private readonly legacyInstalledRootDir: string;
  private readonly legacyRegistryPath: string;
  private readonly generatedFilePath: string;
  private readonly managedRuntimeModulePath: string;
  private readonly extensionBuildCommand: string[];
  private didMigrateLegacyLayout = false;

  constructor(options: PluginManagerOptions = {}) {
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.playwrongHomeDir = resolvePlaywrongHomeDir(options.playwrongHomeDir);
    this.pluginsRootDir = options.pluginsRootDir ?? join(this.playwrongHomeDir, "plugins");
    this.installedRootDir = join(this.pluginsRootDir, DEFAULT_INSTALLED_DIR);
    this.registryPath = join(this.pluginsRootDir, DEFAULT_REGISTRY_FILE);
    this.legacyPluginsRootDir = join(this.workspaceRoot, "plugins");
    this.legacyInstalledRootDir = join(this.legacyPluginsRootDir, DEFAULT_INSTALLED_DIR);
    this.legacyRegistryPath = join(this.legacyPluginsRootDir, DEFAULT_REGISTRY_FILE);
    this.generatedFilePath = options.generatedFilePath ?? join(this.playwrongHomeDir, "generated", "managed-plugins.generated.ts");
    this.managedRuntimeModulePath =
      options.managedRuntimeModulePath ??
      options.generatedBridgeFilePath ??
      join(this.workspaceRoot, "node_modules/@playwrong/runtime-managed-plugins/index.ts");
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

  async listEnabledRuntimePluginPacks(): Promise<RuntimePluginPack[]> {
    const registry = await this.readRegistry();
    const enabledWithRuntime = registry.plugins
      .filter((plugin) => plugin.enabled && typeof plugin.runtimePath === "string" && plugin.runtimePath.length > 0)
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));

    const packs: RuntimePluginPack[] = [];
    for (const plugin of enabledWithRuntime) {
      const runtimeRelPath = plugin.runtimePath;
      if (!runtimeRelPath) {
        continue;
      }
      const runtimeAbsPath = join(this.installedRootDir, plugin.dirName, runtimeRelPath);
      await this.assertFileExists(runtimeAbsPath, `runtime.path not found for plugin ${plugin.pluginId}`);
      const runtimeJson = await readFile(runtimeAbsPath, "utf8");
      packs.push({
        pluginId: plugin.pluginId,
        name: plugin.name,
        version: plugin.version,
        updatedAt: plugin.updatedAt,
        runtimeJson
      });
    }
    return packs;
  }

  async install(input: InstallPluginInput): Promise<InstalledPluginRecord> {
    const sourceTypeRaw = typeof input.sourceType === "string" ? input.sourceType : "git";
    const sourceType = sourceTypeRaw.trim().toLowerCase();
    if (sourceType === "git") {
      const repoUrl = input.repoUrl ?? "";
      const nextInput: InstallPluginFromGitInput = { repoUrl };
      if (input.ref !== undefined) {
        nextInput.ref = input.ref;
      }
      if (input.enabled !== undefined) {
        nextInput.enabled = input.enabled;
      }
      return this.installFromGit(nextInput);
    }
    if (sourceType === "dir") {
      const nextInput: InstallPluginFromDirectoryInput = { path: input.path ?? "" };
      if (input.enabled !== undefined) {
        nextInput.enabled = input.enabled;
      }
      return this.installFromDirectory(nextInput);
    }
    if (sourceType === "zip") {
      const nextInput: InstallPluginFromZipInput = { path: input.path ?? "" };
      if (input.enabled !== undefined) {
        nextInput.enabled = input.enabled;
      }
      return this.installFromZip(nextInput);
    }
    throw new BridgeError("INVALID_REQUEST", "sourceType must be one of git|dir|zip", {
      sourceType
    });
  }

  async installFromGit(input: InstallPluginFromGitInput): Promise<InstalledPluginRecord> {
    if (!input.repoUrl || input.repoUrl.trim().length === 0) {
      throw new BridgeError("INVALID_REQUEST", "repoUrl is required", { field: "repoUrl" });
    }
    const repoUrl = input.repoUrl.trim();

    await this.ensureBaseDirs();

    const stageDir = this.newTmpInstallDir("stage");
    const source: PluginSourceGit = {
      type: "git",
      repoUrl
    };
    if (input.ref) {
      source.ref = input.ref;
    }

    try {
      await this.runCommand(["git", "clone", "--depth", "1", repoUrl, stageDir], this.workspaceRoot);
      if (input.ref && input.ref.trim().length > 0) {
        await this.runCommand(["git", "-C", stageDir, "checkout", input.ref], this.workspaceRoot);
      }
      return this.installFromStageDir({
        stageDir,
        enabled: input.enabled ?? true,
        source
      });
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true });
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError("ACTION_FAIL", "Failed to install plugin from git", {
        repoUrl,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async installFromDirectory(input: InstallPluginFromDirectoryInput): Promise<InstalledPluginRecord> {
    if (!input.path || input.path.trim().length === 0) {
      throw new BridgeError("INVALID_REQUEST", "path is required", { field: "path" });
    }
    const rawPath = input.path.trim();

    await this.ensureBaseDirs();

    const sourcePath = this.resolveInputPath(rawPath);
    await this.assertFileExists(sourcePath, "Plugin directory not found");
    const stageDir = this.newTmpInstallDir("stage");
    try {
      await cp(sourcePath, stageDir, {
        recursive: true,
        force: true
      });
      return this.installFromStageDir({
        stageDir,
        enabled: input.enabled ?? true,
        source: {
          type: "directory",
          path: sourcePath
        }
      });
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true });
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError("ACTION_FAIL", "Failed to install plugin from directory", {
        path: rawPath,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async installFromZip(input: InstallPluginFromZipInput): Promise<InstalledPluginRecord> {
    if (!input.path || input.path.trim().length === 0) {
      throw new BridgeError("INVALID_REQUEST", "path is required", { field: "path" });
    }
    const rawPath = input.path.trim();

    await this.ensureBaseDirs();

    const zipPath = this.resolveInputPath(rawPath);
    await this.assertFileExists(zipPath, "Plugin zip not found");
    const extractDir = this.newTmpInstallDir("extract");
    const stageDir = this.newTmpInstallDir("stage");
    try {
      await this.runCommand(["unzip", "-q", zipPath, "-d", extractDir], this.workspaceRoot);
      const pluginRoot = await this.findPluginRoot(extractDir);
      await cp(pluginRoot, stageDir, {
        recursive: true,
        force: true
      });
      return this.installFromStageDir({
        stageDir,
        enabled: input.enabled ?? true,
        source: {
          type: "zip",
          path: zipPath
        }
      });
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true });
      if (error instanceof BridgeError) {
        throw error;
      }
      throw new BridgeError("ACTION_FAIL", "Failed to install plugin from zip", {
        path: rawPath,
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await rm(extractDir, { recursive: true, force: true });
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
    const moduleVarNames: string[] = [];

    for (const [i, plugin] of enabledPlugins.entries()) {
      const entryAbsPath = await this.resolvePluginEntryPath(plugin);
      const modulePath = ensureFileImportPath(outputDir, entryAbsPath);
      const moduleVar = `pluginModule${i}`;
      importLines.push(`import * as ${moduleVar} from "${modulePath}";`);
      moduleVarNames.push(moduleVar);
    }

    const moduleListLiteral = moduleVarNames.join(", ");
    const content = [
      "/* eslint-disable */",
      "// AUTO-GENERATED FILE. DO NOT EDIT.",
      "// Generated by PluginManager.generateManagedPluginsFile().",
      'import type { PluginScript } from "@playwrong/plugin-sdk";',
      importLines.join("\n"),
      "",
      "type PluginModuleLike = { pluginScripts?: PluginScript[]; default?: PluginScript[] };",
      "",
      "function normalizePluginScripts(input: unknown, moduleIndex: number): PluginScript[] {",
      "  const candidate = input as PluginModuleLike;",
      "  const scripts = Array.isArray(candidate.pluginScripts)",
      "    ? candidate.pluginScripts",
      "    : Array.isArray(candidate.default)",
      "      ? candidate.default",
      "      : [];",
      "  return scripts.map((script, index) => ({",
      "    ...script,",
      "    scriptId: script.scriptId || `managed.plugin.${moduleIndex + 1}.${index + 1}`",
      "  }));",
      "}",
      "",
      `const managedPluginModules: PluginModuleLike[] = [${moduleListLiteral}];`,
      "",
      "export const managedPluginScripts: PluginScript[] = managedPluginModules.flatMap((entry, moduleIndex) =>",
      "  normalizePluginScripts(entry, moduleIndex)",
      ");",
      "",
      "export const managedPluginInfo = {",
      "  moduleCount: managedPluginModules.length,",
      "  scriptCount: managedPluginScripts.length",
      "};",
      "",
      "export const managedPluginModuleCount = managedPluginModules.length;",
      "",
      "export const managedPluginScriptCount = managedPluginScripts.length;",
      "",
      ""
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    await writeFile(this.generatedFilePath, content, "utf8");
    await this.writeManagedRuntimeModule();
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

  private newTmpInstallDir(kind: "stage" | "extract"): string {
    return join(this.pluginsRootDir, `.tmp-install-${kind}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  }

  private resolveInputPath(pathValue: string): string {
    if (isAbsolute(pathValue)) {
      return pathValue;
    }
    return join(this.workspaceRoot, pathValue);
  }

  private async findPluginRoot(extractDir: string): Promise<string> {
    const queue: string[] = [extractDir];
    const visited = new Set<string>();
    let scanned = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      scanned += 1;
      if (scanned > 400) {
        break;
      }

      const manifestPath = join(current, "playwrong.plugin.json");
      try {
        await access(manifestPath);
        return current;
      } catch {
        // continue scanning
      }

      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        queue.push(join(current, entry.name));
      }
    }

    throw new BridgeError("NOT_FOUND", "Missing playwrong.plugin.json in zip package", {
      path: extractDir
    });
  }

  private async installFromStageDir(input: {
    stageDir: string;
    enabled: boolean;
    source: PluginSource;
  }): Promise<InstalledPluginRecord> {
    const manifest = await this.readManifest(input.stageDir);
    const dirName = buildPluginDirName(manifest.pluginId);
    const destDir = join(this.installedRootDir, dirName);
    await rm(destDir, { recursive: true, force: true });
    await rename(input.stageDir, destDir);

    const next = await this.upsertRecordFromManifest(manifest, {
      dirName,
      enabled: input.enabled,
      source: input.source
    });

    await this.generateManagedPluginsFile();
    return next;
  }

  private async resolvePluginEntryPath(plugin: InstalledPluginRecord): Promise<string> {
    const rootDir = join(this.installedRootDir, plugin.dirName);
    const entryPath = join(rootDir, plugin.entry);
    await this.assertFileExists(entryPath, `entry not found for plugin ${plugin.pluginId}`);
    return entryPath;
  }

  private async upsertRecordFromManifest(
    manifest: PluginPackManifest,
    input: { dirName: string; enabled: boolean; source: PluginSource }
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
      skillPath: manifest.skill.path,
      enabled: input.enabled,
      source: input.source,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      dirName: input.dirName
    };
    if (manifest.description !== undefined) {
      record.description = manifest.description;
    }
    if (manifest.runtime?.path) {
      record.runtimePath = manifest.runtime.path;
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
        throw new BridgeError("INVALID_REQUEST", "Invalid plugins registry format", {
          registryPath: this.registryPath
        });
      }
      const normalizedPlugins = parsed.plugins.map((plugin) => ({
        ...plugin,
        ...(plugin.skillPath ? { skillPath: plugin.skillPath } : {})
      }));
      const registry: PluginRegistryFile = {
        version: 1,
        plugins: normalizedPlugins
      };
      await this.normalizeRegistryDirNames(registry);
      return registry;
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
    if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(parsed.pluginId)) {
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
    validateVersion(parsed.version);
    if (!parsed.entry || typeof parsed.entry !== "string") {
      throw new BridgeError("INVALID_REQUEST", "entry is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (!isSafeRelativePath(parsed.entry)) {
      throw new BridgeError("INVALID_REQUEST", "entry must be a safe relative path", {
        entry: parsed.entry
      });
    }
    if (!parsed.skill || typeof parsed.skill !== "object") {
      throw new BridgeError("INVALID_REQUEST", "skill is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (!parsed.skill.path || typeof parsed.skill.path !== "string") {
      throw new BridgeError("INVALID_REQUEST", "skill.path is required in playwrong.plugin.json", {
        manifestPath
      });
    }
    if (!isSafeRelativePath(parsed.skill.path)) {
      throw new BridgeError("INVALID_REQUEST", "skill.path must be a safe relative path", {
        skillPath: parsed.skill.path
      });
    }

    let runtimePath: string | undefined;
    if (parsed.runtime !== undefined) {
      if (!parsed.runtime || typeof parsed.runtime !== "object") {
        throw new BridgeError("INVALID_REQUEST", "runtime must be an object when provided", {
          manifestPath
        });
      }
      const runtime = parsed.runtime as Partial<PluginRuntimeSpec>;
      if (!runtime.path || typeof runtime.path !== "string") {
        throw new BridgeError("INVALID_REQUEST", "runtime.path must be a string when runtime is provided", {
          manifestPath
        });
      }
      if (!isSafeRelativePath(runtime.path)) {
        throw new BridgeError("INVALID_REQUEST", "runtime.path must be a safe relative path", {
          runtimePath: runtime.path
        });
      }
      runtimePath = runtime.path;
    }

    if (!parsed.match || typeof parsed.match !== "object") {
      throw new BridgeError("INVALID_REQUEST", "match is required in playwrong.plugin.json", {
        manifestPath
      });
    }

    const hosts = parsed.match.hosts ? ensureArrayString(parsed.match.hosts, "match.hosts") : undefined;
    const paths = parsed.match.paths ? ensureArrayString(parsed.match.paths, "match.paths") : undefined;
    if (hosts) {
      for (const host of hosts) {
        validateHostPattern(host);
      }
    }
    if (paths) {
      for (const path of paths) {
        validatePathPattern(path);
      }
    }

    if ((!hosts || hosts.length === 0) && (!paths || paths.length === 0)) {
      throw new BridgeError("INVALID_REQUEST", "match.hosts or match.paths must be provided", {
        match: parsed.match
      });
    }

    const entryPath = join(pluginRootDir, parsed.entry);
    await this.assertFileExists(entryPath, `Plugin entry not found: ${parsed.entry}`);
    const skillPath = join(pluginRootDir, parsed.skill.path);
    await this.assertFileExists(skillPath, `Plugin skill not found: ${parsed.skill.path}`);
    const skillContent = await readFile(skillPath, "utf8");
    validatePluginSkillContent(skillContent, parsed.skill.path);
    if (runtimePath) {
      const runtimeFilePath = join(pluginRootDir, runtimePath);
      await this.assertFileExists(runtimeFilePath, `Plugin runtime file not found: ${runtimePath}`);
      try {
        JSON.parse(await readFile(runtimeFilePath, "utf8"));
      } catch (error) {
        throw new BridgeError("INVALID_REQUEST", "runtime.path must point to valid JSON", {
          runtimePath,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const manifest: PluginPackManifest = {
      schemaVersion: 1,
      pluginId: parsed.pluginId,
      name: parsed.name,
      version: parsed.version,
      entry: parsed.entry,
      match: {
        ...(hosts ? { hosts } : {}),
        ...(paths ? { paths } : {})
      },
      skill: {
        path: parsed.skill.path
      }
    };
    if (parsed.description && typeof parsed.description === "string") {
      manifest.description = parsed.description;
    }
    if (runtimePath) {
      manifest.runtime = {
        path: runtimePath
      };
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
    await this.migrateLegacyWorkspaceLayout();
    await mkdir(this.pluginsRootDir, { recursive: true });
    await mkdir(this.installedRootDir, { recursive: true });
  }

  private async writeManagedRuntimeModule(): Promise<void> {
    const moduleDir = dirname(this.managedRuntimeModulePath);
    await mkdir(moduleDir, { recursive: true });
    const importPath = ensureFileImportPath(moduleDir, this.generatedFilePath);
    const content = [
      "/* eslint-disable */",
      "// AUTO-GENERATED FILE. DO NOT EDIT.",
      "// Generated by PluginManager.generateManagedPluginsFile().",
      `export { managedPluginScripts, managedPluginInfo, managedPluginModuleCount, managedPluginScriptCount } from ${JSON.stringify(importPath)};`,
      ""
    ].join("\n");
    await writeFile(this.managedRuntimeModulePath, content, "utf8");

    const packageJsonPath = join(moduleDir, "package.json");
    const packageJson = {
      name: DEFAULT_RUNTIME_MANAGED_PACKAGE_NAME,
      private: true,
      type: "module",
      main: "./index.ts"
    };
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }

  private async migrateLegacyWorkspaceLayout(): Promise<void> {
    if (this.didMigrateLegacyLayout) {
      return;
    }
    this.didMigrateLegacyLayout = true;
    if (this.pluginsRootDir === this.legacyPluginsRootDir) {
      return;
    }

    const hasCurrentRegistry = await pathExists(this.registryPath);
    const hasLegacyRegistry = await pathExists(this.legacyRegistryPath);
    if (hasCurrentRegistry || !hasLegacyRegistry) {
      return;
    }

    await mkdir(this.pluginsRootDir, { recursive: true });
    await mkdir(this.installedRootDir, { recursive: true });

    const legacyInstalledExists = await pathExists(this.legacyInstalledRootDir);
    if (legacyInstalledExists) {
      await cp(this.legacyInstalledRootDir, this.installedRootDir, {
        recursive: true,
        force: true
      });
    }
    await cp(this.legacyRegistryPath, this.registryPath, {
      force: true
    });
  }

  private async normalizeRegistryDirNames(registry: PluginRegistryFile): Promise<void> {
    let changed = false;
    for (const plugin of registry.plugins) {
      const expectedDirName = buildPluginDirName(plugin.pluginId);
      if (plugin.dirName === expectedDirName) {
        continue;
      }

      const currentDirName = plugin.dirName;
      const currentDir = join(this.installedRootDir, currentDirName);
      const expectedDir = join(this.installedRootDir, expectedDirName);
      const currentExists = await pathExists(currentDir);
      const expectedExists = await pathExists(expectedDir);
      if (currentExists && !expectedExists) {
        await rename(currentDir, expectedDir);
      } else if (currentExists && expectedExists) {
        await rm(currentDir, { recursive: true, force: true });
      }
      plugin.dirName = expectedDirName;
      changed = true;
    }

    if (changed) {
      await this.writeRegistry(registry);
    }
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
