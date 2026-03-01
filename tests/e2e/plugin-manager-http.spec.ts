import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, startBridgeHttpServer } from "../../apps/server/src/index";

const servers: Array<ReturnType<typeof startBridgeHttpServer>["server"]> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      server.stop(true);
    }
  }

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "playwrong-plugin-http-"));
  tempRoots.push(root);
  await mkdir(join(root, "plugins/installed"), { recursive: true });
  await writeFile(join(root, "plugins/registry.json"), JSON.stringify({ version: 1, plugins: [] }, null, 2), "utf8");
  return root;
}

async function createPluginDir(root: string, dirName = "http-plugin-repo"): Promise<string> {
  const repoDir = join(root, dirName);
  await mkdir(join(repoDir, "src"), { recursive: true });

  await writeFile(
    join(repoDir, "playwrong.plugin.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        pluginId: "example.http.plugin",
        name: "HTTP Test Plugin",
        version: "0.1.0",
        entry: "src/index.ts",
        skill: { path: "SKILL.md" },
        match: { hosts: ["example.com"] }
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
      '    scriptId: "example.http.plugin.script",',
      "    async extract() { throw new Error(\"PLUGIN_MISS\"); },",
      "    async setValue() { throw new Error(\"PLUGIN_MISS\"); },",
      "    async invoke() { throw new Error(\"PLUGIN_MISS\"); }",
      "  }",
      "];"
    ].join("\n"),
    "utf8"
  );

  await writeFile(
    join(repoDir, "SKILL.md"),
    [
      "---",
      "name: http-test-plugin-skill",
      "description: Skill document for plugin manager HTTP integration test.",
      "---",
      "",
      "# HTTP Test Plugin Skill",
      "",
      "## Usage",
      "1. Install plugin from git.",
      "2. Enable plugin and sync/pull page state.",
      "",
      "## Operations",
      "- Page functions: refresh()",
      "- Node functions: click()",
      "",
      "## Failure Modes",
      "- PLUGIN_MISS"
    ].join("\n"),
    "utf8"
  );

  return repoDir;
}

async function createGitPluginRepo(root: string): Promise<string> {
  const repoDir = await createPluginDir(root);
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git config user.email test@example.com`.cwd(repoDir).quiet();
  await Bun.$`git config user.name test`.cwd(repoDir).quiet();
  await Bun.$`git add .`.cwd(repoDir).quiet();
  await Bun.$`git commit -m init`.cwd(repoDir).quiet();
  return repoDir;
}

async function requestJson<T>(baseUrl: string, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(new URL(path, baseUrl), {
    ...init
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(JSON.stringify(payload));
  }
  return payload;
}

describe("Plugin manager HTTP routes", () => {
  it("supports mapping plugin install/list/toggle/uninstall", async () => {
    const workspace = await createWorkspace();
    const repo = await createGitPluginRepo(workspace);

    const pluginManager = new PluginManager({
      workspaceRoot: workspace,
      extensionBuildCommand: ["bun", "--version"]
    });

    const started = startBridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      pluginManager
    });
    servers.push(started.server);
    const baseUrl = started.server.url.toString();

    const initial = await requestJson<{ plugins: unknown[] }>(baseUrl, "/mapping-plugins", "GET");
    expect(initial.plugins).toHaveLength(0);

    const installResult = await requestJson<{ plugin: { pluginId: string; enabled: boolean } }>(
      baseUrl,
      "/mapping-plugins/install",
      "POST",
      { repoUrl: repo, enabled: true }
    );
    expect(installResult.plugin.pluginId).toBe("example.http.plugin");
    expect(installResult.plugin.enabled).toBe(true);

    const listResult = await requestJson<{ plugins: Array<{ pluginId: string; enabled: boolean }> }>(
      baseUrl,
      "/mapping-plugins",
      "GET"
    );
    expect(listResult.plugins).toHaveLength(1);

    const backwardCompatibleList = await requestJson<{ plugins: Array<{ pluginId: string }> }>(baseUrl, "/plugins", "GET");
    expect(backwardCompatibleList.plugins).toHaveLength(1);

    const toggleResult = await requestJson<{ plugin: { enabled: boolean } }>(
      baseUrl,
      "/mapping-plugins/set-enabled",
      "POST",
      { pluginId: "example.http.plugin", enabled: false }
    );
    expect(toggleResult.plugin.enabled).toBe(false);

    const generateResult = await requestJson<{ generated: { enabledCount: number } }>(
      baseUrl,
      "/mapping-plugins/generate",
      "POST",
      {}
    );
    expect(generateResult.generated.enabledCount).toBe(0);

    const localDir = await createPluginDir(workspace, "http-plugin-dir");
    const installFromDir = await requestJson<{ plugin: { pluginId: string; enabled: boolean } }>(
      baseUrl,
      "/mapping-plugins/install",
      "POST",
      { sourceType: "dir", path: localDir, enabled: true }
    );
    expect(installFromDir.plugin.pluginId).toBe("example.http.plugin");
    expect(installFromDir.plugin.enabled).toBe(true);

    const uninstallResult = await requestJson<{ ok: boolean }>(baseUrl, "/mapping-plugins/uninstall", "POST", {
      pluginId: "example.http.plugin"
    });
    expect(uninstallResult.ok).toBe(true);

    const afterUninstall = await requestJson<{ plugins: unknown[] }>(baseUrl, "/mapping-plugins", "GET");
    expect(afterUninstall.plugins).toHaveLength(0);
  });
});
