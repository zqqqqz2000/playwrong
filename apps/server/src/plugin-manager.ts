import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { BridgeError } from "@playwrong/protocol";

export interface PluginScopeRule {
  hosts?: string[];
  paths?: string[];
}

export interface PluginSkillSpec {
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
  enabled: boolean;
  source: PluginSource;
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

function sanitizePluginDirName(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._-]/g, "_");
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
    const dirName = sanitizePluginDirName(manifest.pluginId);
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
      const normalizedPlugins = parsed.plugins.map((plugin) => ({
        ...plugin,
        ...(plugin.skillPath ? { skillPath: plugin.skillPath } : {})
      }));
      return {
        version: 1,
        plugins: normalizedPlugins
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
