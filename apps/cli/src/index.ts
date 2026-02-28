#!/usr/bin/env bun
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

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
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

  const index: PullIndex = {
    pageId,
    rev: data.rev,
    files: data.files.map((f) => ({ id: f.id, kind: f.kind, path: f.path }))
  };

  await writeJson(join(stateDir, "pages", pageId, "index.json"), index);
  console.log(JSON.stringify({ ok: true, pageId, rev: data.rev, files: data.files.length }, null, 2));
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

async function main(): Promise<void> {
  const [, , command, ...rest] = Bun.argv;
  const flags = parseFlags(rest);

  if (!command) {
    console.log("Usage: bridge <serve|pages|pages-remote|sync|sync-all|pull|apply|call> [flags]");
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

  console.log(`Unknown command: ${command}`);
  process.exit(1);
}

void main();
