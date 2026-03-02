import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager } from "../../apps/server/src/plugin-manager";

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function createTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "playwrong-plugin-test-"));
  tmpRoots.push(dir);
  return dir;
}

function createManager(workspace: string): PluginManager {
  return new PluginManager({
    workspaceRoot: workspace,
    playwrongHomeDir: join(workspace, ".playwrong-home"),
    generatedFilePath: join(workspace, "generated", "managed-plugins.generated.ts"),
    generatedBridgeFilePath: join(workspace, "bridge", "managed-plugins.generated.ts")
  });
}

async function createPluginDir(
  root: string,
  input: { pluginId: string; hosts: string[]; dirName?: string; runtimeScriptId?: string }
): Promise<string> {
  const repoDir = join(root, input.dirName ?? "plugin-repo");
  await mkdir(join(repoDir, "src"), { recursive: true });

  const runtimeConfig = input.runtimeScriptId
    ? {
        runtime: { path: "runtime-plugin.json" }
      }
    : {};

  await writeFile(
    join(repoDir, "playwrong.plugin.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        pluginId: input.pluginId,
        name: "Test Plugin",
        version: "0.1.0",
        entry: "src/index.ts",
        skill: { path: "SKILL.md" },
        match: { hosts: input.hosts },
        ...runtimeConfig
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    join(repoDir, "src/index.ts"),
    [
      'import type { PluginScript } from "@playwrong/plugin-sdk";',
      "export const pluginScripts: PluginScript[] = [",
      "  {",
      `    scriptId: ${JSON.stringify(`${input.pluginId}.script`)},`,
      "    async extract() {",
      "      throw new Error(\"PLUGIN_MISS\");",
      "    },",
      "    async setValue() {",
      "      throw new Error(\"PLUGIN_MISS\");",
      "    },",
      "    async invoke() {",
      "      throw new Error(\"PLUGIN_MISS\");",
      "    }",
      "  }",
      "];",
      ""
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(repoDir, "SKILL.md"),
    [
      "---",
      "name: test-plugin-skill",
      "description: Test plugin skill document for install flow.",
      "---",
      "",
      "# Test Plugin Skill",
      "",
      "## Usage",
      "1. Install plugin.",
      "2. Sync/pull page.",
      "3. Use extract/setValue/invoke through bridge.",
      "",
      "## Operations",
      "- Page functions: refresh()",
      "- Node functions: click(), focus()",
      "",
      "## Failure Modes",
      "- PLUGIN_MISS: page unsupported.",
      "- ACTION_FAIL: target node missing."
    ].join("\n"),
    "utf8"
  );

  if (input.runtimeScriptId) {
    await writeFile(
      join(repoDir, "runtime-plugin.json"),
      JSON.stringify(
        {
          scripts: [
            {
              scriptId: input.runtimeScriptId,
              rules: [{ hosts: input.hosts }],
              extract: {
                pageType: "runtime.test",
                fields: [
                  {
                    id: "runtime.title",
                    select: { selector: "title" }
                  }
                ]
              }
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );
  }

  return repoDir;
}

async function createGitPluginRepo(root: string, input: { pluginId: string; hosts: string[] }): Promise<string> {
  const repoDir = await createPluginDir(root, input);
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git config user.email test@example.com`.cwd(repoDir).quiet();
  await Bun.$`git config user.name test`.cwd(repoDir).quiet();
  await Bun.$`git add .`.cwd(repoDir).quiet();
  await Bun.$`git commit -m init`.cwd(repoDir).quiet();
  return repoDir;
}

describe("PluginManager", () => {
  it("installs plugin from local git repo and toggles enabled", async () => {
    const workspace = await createTempWorkspace();
    const pluginRepo = await createGitPluginRepo(workspace, {
      pluginId: "example.local.plugin",
      hosts: ["example.com"]
    });

    const manager = createManager(workspace);
    const installed = await manager.installFromGit({ repoUrl: pluginRepo, enabled: true });

    expect(installed.pluginId).toBe("example.local.plugin");
    expect(installed.enabled).toBe(true);

    const listed1 = await manager.listPlugins();
    expect(listed1).toHaveLength(1);
    expect(listed1[0]?.pluginId).toBe("example.local.plugin");

    const toggled = await manager.setPluginEnabled("example.local.plugin", false);
    expect(toggled.enabled).toBe(false);

    const listed2 = await manager.listPlugins();
    expect(listed2[0]?.enabled).toBe(false);

    const generated = await manager.generateManagedPluginsFile();
    expect(generated.pluginCount).toBe(1);
    expect(generated.enabledCount).toBe(0);

    const generatedContent = await readFile(join(workspace, "generated", "managed-plugins.generated.ts"), "utf8");
    expect(generatedContent).toContain("managedPluginModules");
    expect(generatedContent).not.toContain("example.local.plugin");
    expect(generatedContent).not.toContain("example.com");

    await manager.uninstallPlugin("example.local.plugin");
    const listed3 = await manager.listPlugins();
    expect(listed3).toHaveLength(0);
  });

  it("installs plugin from a local directory path", async () => {
    const workspace = await createTempWorkspace();
    const pluginDir = await createPluginDir(workspace, {
      pluginId: "example.local.dir.plugin",
      hosts: ["example.com"],
      dirName: "local-plugin-dir"
    });

    const manager = createManager(workspace);
    const installed = await manager.installFromDirectory({ path: pluginDir, enabled: true });

    expect(installed.pluginId).toBe("example.local.dir.plugin");
    expect(installed.enabled).toBe(true);
    expect(installed.source.type).toBe("directory");

    const listed = await manager.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.pluginId).toBe("example.local.dir.plugin");
  });

  it("lists enabled runtime plugin packs without rebuilding extension", async () => {
    const workspace = await createTempWorkspace();
    const pluginDir = await createPluginDir(workspace, {
      pluginId: "example.runtime.plugin",
      hosts: ["example.com"],
      dirName: "runtime-plugin-dir",
      runtimeScriptId: "example.runtime.script"
    });

    const manager = createManager(workspace);
    await manager.installFromDirectory({ path: pluginDir, enabled: true });

    const runtimePacks = await manager.listEnabledRuntimePluginPacks();
    expect(runtimePacks).toHaveLength(1);
    expect(runtimePacks[0]?.pluginId).toBe("example.runtime.plugin");
    expect(runtimePacks[0]?.runtimeJson).toContain("example.runtime.script");
  });

  it("installs plugin from a zip archive path", async () => {
    const workspace = await createTempWorkspace();
    const manager = createManager(workspace);

    try {
      await Bun.$`which zip`.quiet();
      await Bun.$`which unzip`.quiet();
    } catch {
      return;
    }

    await createPluginDir(workspace, {
      pluginId: "example.local.zip.plugin",
      hosts: ["example.com"],
      dirName: "local-plugin-zip-src"
    });

    const zipPath = join(workspace, "local-plugin.zip");
    await Bun.$`zip -qr ${zipPath} local-plugin-zip-src`.cwd(workspace).quiet();

    const installed = await manager.installFromZip({ path: zipPath, enabled: true });
    expect(installed.pluginId).toBe("example.local.zip.plugin");
    expect(installed.source.type).toBe("zip");

    const listed = await manager.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.pluginId).toBe("example.local.zip.plugin");
  });

  it("rejects plugin manifest without match scope", async () => {
    const workspace = await createTempWorkspace();
    const repoDir = join(workspace, "bad-plugin");
    await mkdir(join(repoDir, "src"), { recursive: true });

    await writeFile(
      join(repoDir, "playwrong.plugin.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          pluginId: "bad.plugin",
          name: "Bad Plugin",
          version: "0.0.1",
          entry: "src/index.ts",
          skill: { path: "SKILL.md" },
          match: {}
        },
        null,
        2
      ),
      "utf8"
    );

    await writeFile(join(repoDir, "src/index.ts"), "export const pluginScripts = [];", "utf8");
    await writeFile(
      join(repoDir, "SKILL.md"),
      [
        "---",
        "name: bad-plugin-skill",
        "description: skill",
        "---",
        "",
        "# Bad Plugin Skill",
        "",
        "## Usage",
        "1. Example",
        "",
      "## Operations",
      "- click()",
      "",
      "## Failure Modes",
      "- PLUGIN_MISS"
    ].join("\n"),
    "utf8"
  );
    await Bun.$`git init`.cwd(repoDir).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(repoDir).quiet();
    await Bun.$`git config user.name test`.cwd(repoDir).quiet();
    await Bun.$`git add .`.cwd(repoDir).quiet();
    await Bun.$`git commit -m init`.cwd(repoDir).quiet();

    const manager = createManager(workspace);
    await expect(manager.installFromGit({ repoUrl: repoDir })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });

  it("rejects plugin skill missing failure modes section", async () => {
    const workspace = await createTempWorkspace();
    const repoDir = await createGitPluginRepo(workspace, {
      pluginId: "example.skill.missing.failure",
      hosts: ["example.com"]
    });

    await writeFile(
      join(repoDir, "SKILL.md"),
      [
        "---",
        "name: missing-failure-modes-skill",
        "description: Skill doc for validation.",
        "---",
        "",
        "# Missing Failure Modes Skill",
        "",
        "## Usage",
        "1. Example",
        "",
        "## Operations",
        "- refresh()"
      ].join("\n"),
      "utf8"
    );
    await Bun.$`git add SKILL.md`.cwd(repoDir).quiet();
    await Bun.$`git commit -m update-skill`.cwd(repoDir).quiet();

    const manager = createManager(workspace);
    await expect(manager.installFromGit({ repoUrl: repoDir })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });

  it("rejects invalid host patterns in manifest", async () => {
    const workspace = await createTempWorkspace();
    const repoDir = await createGitPluginRepo(workspace, {
      pluginId: "example.bad.host.pattern",
      hosts: ["example.com"]
    });

    await writeFile(
      join(repoDir, "playwrong.plugin.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          pluginId: "example.bad.host.pattern",
          name: "Bad Host Pattern",
          version: "0.1.0",
          entry: "src/index.ts",
          skill: { path: "SKILL.md" },
          match: { hosts: ["https://example.com"] }
        },
        null,
        2
      ),
      "utf8"
    );
    await Bun.$`git add playwrong.plugin.json`.cwd(repoDir).quiet();
    await Bun.$`git commit -m update-manifest-host-pattern`.cwd(repoDir).quiet();

    const manager = createManager(workspace);
    await expect(manager.installFromGit({ repoUrl: repoDir })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
  });
});
