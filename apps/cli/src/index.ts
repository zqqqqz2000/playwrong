#!/usr/bin/env bun
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startBridgeHttpServer } from "@playwrong/server";
import type {
  ApplyRequest,
  ApplyResponse,
  CallRequest,
  CallResponse,
  PullFile,
  PullResponse
} from "@playwrong/protocol";

type FlagMap = Record<string, string | boolean>;

interface PullIndex {
  pageId: string;
  rev: number;
  files: Array<Pick<PullFile, "id" | "kind" | "path">>;
  screenshot?: {
    path: string;
    mimeType: string;
  };
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:7878";
const DEFAULT_STATE_DIR = ".bridge";

function parseFlags(args: string[]): FlagMap {
  const out: FlagMap = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token || !token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function getFlag(flags: FlagMap, key: string, fallback?: string): string {
  const value = flags[key];
  if (typeof value === "string") {
    return value;
  }
  if (typeof fallback === "string") {
    return fallback;
  }
  throw new Error(`Missing required flag --${key}`);
}

function getOptionalBooleanFlag(flags: FlagMap, key: string): boolean | undefined {
  const value = flags[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    return true;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error(`Invalid boolean flag --${key}: ${String(value)}`);
}

function getNumberFlag(flags: FlagMap, key: string, fallback: number): number {
  const raw = getFlag(flags, key, String(fallback));
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric flag --${key}: ${raw}`);
  }
  return parsed;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeBytes(path: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeText(path, JSON.stringify(data, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function postJson<T>(endpoint: string, path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body as T;
}

async function getJson<T>(endpoint: string, path: string): Promise<T> {
  const response = await fetch(`${endpoint}${path}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body as T;
}

async function waitForExtensionConnected(
  endpoint: string,
  timeoutMs: number
): Promise<{ connected: boolean; attempts: number; elapsedMs: number }> {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start <= timeoutMs) {
    attempts += 1;
    const status = await getJson<{ connected?: unknown }>(endpoint, "/extension/status");
    if (status.connected === true) {
      return {
        connected: true,
        attempts,
        elapsedMs: Date.now() - start
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    connected: false,
    attempts,
    elapsedMs: Date.now() - start
  };
}

async function refreshPageViaBridge(
  endpoint: string,
  pageId: string
): Promise<{ syncRev: number; call: CallResponse }> {
  const synced = await postJson<{ rev?: unknown }>(endpoint, "/sync/page", { pageId });
  if (typeof synced.rev !== "number") {
    throw new Error(`Unexpected /sync/page response: ${JSON.stringify(synced)}`);
  }

  const payload: CallRequest = {
    pageId,
    baseRev: synced.rev,
    target: { id: "page" },
    fn: "refresh"
  };
  const call = await postJson<CallResponse>(endpoint, "/call", payload);
  return {
    syncRev: synced.rev,
    call
  };
}

async function cmdServe(flags: FlagMap): Promise<void> {
  const host = getFlag(flags, "host", "127.0.0.1");
  const port = Number(getFlag(flags, "port", "7878"));
  startBridgeHttpServer({ host, port });
  console.log(`bridge server listening on http://${host}:${port}`);
  await new Promise(() => {});
}

async function cmdPages(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const data = await getJson<{ pages: unknown[] }>(endpoint, "/pages");
  console.log(JSON.stringify(data, null, 2));
}

async function cmdRemotePages(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const data = await getJson<{ pages: unknown[] }>(endpoint, "/pages/remote");
  console.log(JSON.stringify(data, null, 2));
}

async function cmdSync(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const pageId = getFlag(flags, "page");
  const result = await postJson<Record<string, unknown>>(endpoint, "/sync/page", { pageId });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSyncAll(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const result = await postJson<Record<string, unknown>>(endpoint, "/sync/all", {});
  console.log(JSON.stringify(result, null, 2));
}

async function cmdPull(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const pageId = getFlag(flags, "page");
  const stateDir = getFlag(flags, "state-dir", DEFAULT_STATE_DIR);

  const data = await postJson<PullResponse>(endpoint, "/pull", { pageId });

  const xmlPath = join(stateDir, "pages", pageId, "state.xml");
  await writeText(xmlPath, data.xml);

  for (const file of data.files) {
    await writeText(join(stateDir, file.path), file.content);
  }

  let screenshot: PullIndex["screenshot"] | undefined;
  if (data.screenshot && data.screenshot.encoding === "base64" && data.screenshot.data.length > 0) {
    const ext = data.screenshot.mimeType === "image/jpeg" ? "jpg" : "png";
    const relativePath = join("pages", pageId, `screenshot.${ext}`);
    await writeBytes(join(stateDir, relativePath), Buffer.from(data.screenshot.data, "base64"));
    screenshot = {
      path: relativePath,
      mimeType: data.screenshot.mimeType
    };
  }

  const index: PullIndex = {
    pageId,
    rev: data.rev,
    files: data.files.map((f) => ({ id: f.id, kind: f.kind, path: f.path }))
  };
  if (screenshot) {
    index.screenshot = screenshot;
  }

  await writeJson(join(stateDir, "pages", pageId, "index.json"), index);
  console.log(
    JSON.stringify(
      {
        ok: true,
        pageId,
        rev: data.rev,
        files: data.files.length,
        screenshotPath: screenshot?.path
      },
      null,
      2
    )
  );
}

function parseFileValue(kind: PullFile["kind"], raw: string): string | boolean | string[] {
  if (kind === "toggle") {
    return raw.trim().toLowerCase() === "true";
  }
  if (kind === "select") {
    const text = raw.trim();
    if (text.startsWith("[") && text.endsWith("]")) {
      try {
        return JSON.parse(text) as string[];
      } catch {
        return text ? text.split("\n").map((x) => x.trim()).filter(Boolean) : [];
      }
    }
    return text ? text.split("\n").map((x) => x.trim()).filter(Boolean) : [];
  }
  return raw;
}

async function cmdApply(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const pageId = getFlag(flags, "page");
  const stateDir = getFlag(flags, "state-dir", DEFAULT_STATE_DIR);

  const indexPath = join(stateDir, "pages", pageId, "index.json");
  const index = await readJson<PullIndex>(indexPath);

  const edits: ApplyRequest["edits"] = [];
  for (const file of index.files) {
    const content = await readFile(join(stateDir, file.path), "utf8");
    edits.push({ id: file.id, value: parseFileValue(file.kind, content) });
  }

  const baseRev = Number(getFlag(flags, "rev", String(index.rev)));
  const payload: ApplyRequest = { pageId, baseRev, edits };
  const result = await postJson<ApplyResponse>(endpoint, "/apply", payload);

  index.rev = result.rev;
  await writeJson(indexPath, index);

  console.log(JSON.stringify(result, null, 2));
}

async function cmdCall(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const pageId = getFlag(flags, "page");
  const id = getFlag(flags, "id");
  const fn = getFlag(flags, "fn");
  const stateDir = getFlag(flags, "state-dir", DEFAULT_STATE_DIR);

  const indexPath = join(stateDir, "pages", pageId, "index.json");
  let baseRev = Number(getFlag(flags, "rev", "0"));
  if (!baseRev) {
    const index = await readJson<PullIndex>(indexPath);
    baseRev = index.rev;
  }

  const argsRaw = getFlag(flags, "args", "{}");
  const args = JSON.parse(argsRaw) as Record<string, unknown>;

  const payload: CallRequest = {
    pageId,
    baseRev,
    target: { id },
    fn,
    args
  };

  const result = await postJson<CallResponse>(endpoint, "/call", payload);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdExtensionReload(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const waitMs = getNumberFlag(flags, "wait-ms", 20000);

  const reloadResult = await postJson<{ ok?: unknown }>(endpoint, "/extension/reload", {});
  if (reloadResult.ok !== true) {
    throw new Error(`Unexpected /extension/reload response: ${JSON.stringify(reloadResult)}`);
  }

  const reconnect = await waitForExtensionConnected(endpoint, waitMs);
  if (!reconnect.connected) {
    throw new Error(`Extension reload requested but did not reconnect within ${waitMs}ms`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        extensionReloaded: true,
        connected: true,
        waitMs: reconnect.elapsedMs,
        attempts: reconnect.attempts
      },
      null,
      2
    )
  );
}

async function cmdPageRefresh(flags: FlagMap): Promise<void> {
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);
  const pageId = getFlag(flags, "page");
  const result = await refreshPageViaBridge(endpoint, pageId);
  console.log(
    JSON.stringify(
      {
        ok: true,
        pageId,
        syncRev: result.syncRev,
        call: result.call
      },
      null,
      2
    )
  );
}

function parseSubcommand(args: string[]): { subcommand: string; flags: FlagMap } {
  const first = args[0];
  if (!first || first.startsWith("--")) {
    throw new Error(
      "Usage: bridge mapping-plugins <list|install|enable|disable|uninstall|generate|apply|reload> [flags]\n" +
        "Install flags: --repo-url <git> | --dir <plugin-dir> | --zip <plugin.zip> | --source <git|dir|zip> --path <value>\n" +
        "Reload flags: --reload-extension <true|false> --wait-ms <ms> --page <pageId>"
    );
  }
  return {
    subcommand: first,
    flags: parseFlags(args.slice(1))
  };
}

async function cmdMappingPlugins(args: string[]): Promise<void> {
  const { subcommand, flags } = parseSubcommand(args);
  const endpoint = getFlag(flags, "endpoint", DEFAULT_ENDPOINT);

  if (subcommand === "list" || subcommand === "ls") {
    const result = await getJson<{ plugins: unknown[] }>(endpoint, "/mapping-plugins");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "install" || subcommand === "add") {
    const source = flags.source && typeof flags.source === "string" ? flags.source.trim().toLowerCase() : "";
    const dirPath = flags.dir && typeof flags.dir === "string" ? flags.dir.trim() : "";
    const zipPath = flags.zip && typeof flags.zip === "string" ? flags.zip.trim() : "";
    const path = flags.path && typeof flags.path === "string" ? flags.path.trim() : "";
    const repoUrl = flags["repo-url"] && typeof flags["repo-url"] === "string" ? flags["repo-url"].trim() : "";
    const ref = flags.ref && typeof flags.ref === "string" ? flags.ref : undefined;
    const enabled = getOptionalBooleanFlag(flags, "enabled");

    if ([Boolean(dirPath), Boolean(zipPath)].filter(Boolean).length > 1) {
      throw new Error("Use only one of --dir or --zip");
    }

    const payload: {
      sourceType?: "git" | "dir" | "zip";
      repoUrl?: string;
      path?: string;
      ref?: string;
      enabled?: boolean;
    } = {};

    if (source === "dir" || source === "directory" || dirPath) {
      payload.sourceType = "dir";
      payload.path = dirPath || path;
      if (!payload.path) {
        throw new Error("Missing required flag --dir <plugin-directory> (or --source dir --path <plugin-directory>)");
      }
    } else if (source === "zip" || zipPath) {
      payload.sourceType = "zip";
      payload.path = zipPath || path;
      if (!payload.path) {
        throw new Error("Missing required flag --zip <plugin.zip> (or --source zip --path <plugin.zip>)");
      }
    } else {
      payload.sourceType = "git";
      payload.repoUrl = repoUrl || (source === "git" ? path : "");
      if (!payload.repoUrl) {
        throw new Error("Missing required flag --repo-url <git-repo> (or --source git --path <git-repo>)");
      }
      if (ref) {
        payload.ref = ref;
      }
    }

    if (enabled !== undefined) {
      payload.enabled = enabled;
    }
    const result = await postJson<{ plugin: unknown }>(endpoint, "/mapping-plugins/install", payload);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const pluginId = getFlag(flags, "id");
    const result = await postJson<{ plugin: unknown }>(endpoint, "/mapping-plugins/set-enabled", {
      pluginId,
      enabled: subcommand === "enable"
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "uninstall" || subcommand === "remove" || subcommand === "delete") {
    const pluginId = getFlag(flags, "id");
    const result = await postJson<{ ok: boolean; pluginId: string }>(endpoint, "/mapping-plugins/uninstall", {
      pluginId
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "generate") {
    const result = await postJson<{ generated: unknown }>(endpoint, "/mapping-plugins/generate", {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (subcommand === "apply" || subcommand === "reload") {
    const build = await postJson<Record<string, unknown>>(endpoint, "/mapping-plugins/reload", {});
    if (subcommand === "apply") {
      console.log(JSON.stringify(build, null, 2));
      return;
    }

    const shouldReloadExtension = getOptionalBooleanFlag(flags, "reload-extension") ?? true;
    const waitMs = getNumberFlag(flags, "wait-ms", 20000);
    const pageId = flags.page && typeof flags.page === "string" ? flags.page.trim() : "";

    let extensionReload:
      | {
          requested: true;
          connected: boolean;
          waitMs: number;
          attempts: number;
        }
      | {
          requested: false;
          connected: null;
          waitMs: 0;
          attempts: 0;
        };

    if (shouldReloadExtension) {
      const reloadResult = await postJson<{ ok?: unknown }>(endpoint, "/extension/reload", {});
      if (reloadResult.ok !== true) {
        throw new Error(`Unexpected /extension/reload response: ${JSON.stringify(reloadResult)}`);
      }
      const reconnect = await waitForExtensionConnected(endpoint, waitMs);
      if (!reconnect.connected) {
        throw new Error(`Extension reload requested but did not reconnect within ${waitMs}ms`);
      }
      extensionReload = {
        requested: true,
        connected: true,
        waitMs: reconnect.elapsedMs,
        attempts: reconnect.attempts
      };
    } else {
      extensionReload = {
        requested: false,
        connected: null,
        waitMs: 0,
        attempts: 0
      };
    }

    const output: {
      build: Record<string, unknown>;
      extensionReload: typeof extensionReload;
      pageRefresh?: { syncRev: number; call: CallResponse; pageId: string };
    } = {
      build,
      extensionReload
    };

    if (pageId.length > 0) {
      const refreshed = await refreshPageViaBridge(endpoint, pageId);
      output.pageRefresh = {
        pageId,
        ...refreshed
      };
    }

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  throw new Error(
    `Unknown mapping-plugins subcommand: ${subcommand}. Use list|install|enable|disable|uninstall|generate|apply|reload`
  );
}

async function main(): Promise<void> {
  const [, , command, ...rest] = Bun.argv;
  const flags = parseFlags(rest);

  if (!command) {
    console.log(
      "Usage: bridge <serve|pages|pages-remote|sync|sync-all|pull|apply|call|extension-reload|page-refresh|mapping-plugins> [flags]"
    );
    console.log(
      "Usage: bridge mapping-plugins <list|install|enable|disable|uninstall|generate|apply|reload> [flags]"
    );
    process.exit(1);
  }

  if (command === "serve") {
    await cmdServe(flags);
    return;
  }
  if (command === "pages") {
    await cmdPages(flags);
    return;
  }
  if (command === "pages-remote") {
    await cmdRemotePages(flags);
    return;
  }
  if (command === "sync") {
    await cmdSync(flags);
    return;
  }
  if (command === "sync-all") {
    await cmdSyncAll(flags);
    return;
  }
  if (command === "pull") {
    await cmdPull(flags);
    return;
  }
  if (command === "apply") {
    await cmdApply(flags);
    return;
  }
  if (command === "call") {
    await cmdCall(flags);
    return;
  }
  if (command === "extension-reload") {
    await cmdExtensionReload(flags);
    return;
  }
  if (command === "page-refresh") {
    await cmdPageRefresh(flags);
    return;
  }
  if (command === "mapping-plugins" || command === "plugins") {
    await cmdMappingPlugins(rest);
    return;
  }

  console.log(`Unknown command: ${command}`);
  process.exit(1);
}

void main();
