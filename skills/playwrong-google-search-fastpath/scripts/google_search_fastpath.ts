import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApplyRequest,
  ApplyResponse,
  CallRequest,
  CallResponse,
  PullResponse,
  RemotePageInfo,
  SemanticNode,
  UpsertSnapshotRequest
} from "@playwrong/protocol";

interface FlagMap {
  [key: string]: string;
}

interface SyncResponse extends UpsertSnapshotRequest {
  rev: number;
}

interface FastpathResult {
  ok: true;
  pageId: string;
  pageType: string;
  query: string;
  resultCount: number;
  resultActionIds: string[];
  nextActionId: string;
  rev: number;
}

function parseFlags(argv: string[]): FlagMap {
  const out: FlagMap = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    out[key] = value;
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

function toNumber(raw: string, key: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid number for ${key}: ${raw}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(endpoint: string, path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function getJson<T>(endpoint: string, path: string): Promise<T> {
  const response = await fetch(`${endpoint}${path}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

function collectActionIds(tree: SemanticNode[], matcher: (id: string) => boolean): string[] {
  const ids: string[] = [];
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    if (node.kind === "action" && matcher(node.id)) {
      ids.push(node.id);
    }
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return ids;
}

function pickRemotePage(remotePages: RemotePageInfo[]): RemotePageInfo | null {
  const isGoogle = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return /(^|\.)google\./i.test(parsed.hostname) || parsed.pathname.includes("google-like.html");
    } catch {
      return false;
    }
  };

  return (
    remotePages.find((p) => p.active && isGoogle(p.url)) ??
    remotePages.find((p) => isGoogle(p.url)) ??
    remotePages.find((p) => p.active) ??
    remotePages[0] ??
    null
  );
}

async function syncPageWithRetry(endpoint: string, pageId: string): Promise<SyncResponse> {
  let lastError: unknown = null;
  for (let i = 0; i < 8; i += 1) {
    try {
      return await postJson<SyncResponse>(endpoint, "/sync/page", { pageId });
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("sync/page failed");
}

async function waitForResultTree(input: {
  endpoint: string;
  pageId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  minResults: number;
}): Promise<{ sync: SyncResponse; resultActionIds: string[]; nextActionId: string }> {
  const startedAt = Date.now();
  let lastSync: SyncResponse | null = null;

  while (Date.now() - startedAt <= input.timeoutMs) {
    try {
      const sync = await syncPageWithRetry(input.endpoint, input.pageId);
      lastSync = sync;

      const resultActionIds = collectActionIds(sync.tree, (id) => /^search\.result\.\d+\.open$/.test(id));
      const nextActionId = collectActionIds(sync.tree, (id) => id === "search.pagination.next")[0] ?? "";

      if (resultActionIds.length >= input.minResults && nextActionId) {
        return { sync, resultActionIds, nextActionId };
      }
    } catch {
      // ignore and retry
    }

    await sleep(input.pollIntervalMs);
  }

  const latestCount = lastSync ? collectActionIds(lastSync.tree, (id) => /^search\.result\.\d+\.open$/.test(id)).length : 0;
  throw new Error(`search results not ready before timeout; latestCount=${latestCount}`);
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2));
  const endpoint = getFlag(flags, "endpoint", "http://127.0.0.1:7878");
  const query = getFlag(flags, "query", "playwrong llm automation");
  const outDir = getFlag(flags, "outDir", ".bridge-e2e-google/codex-fastpath");
  const timeoutMs = toNumber(getFlag(flags, "timeoutMs", "30000"), "timeoutMs");
  const pollIntervalMs = toNumber(getFlag(flags, "pollIntervalMs", "500"), "pollIntervalMs");
  const minResults = toNumber(getFlag(flags, "minResults", "3"), "minResults");

  let pageId = flags.pageId;
  if (!pageId) {
    const remote = await getJson<{ pages: RemotePageInfo[] }>(endpoint, "/pages/remote");
    const picked = pickRemotePage(remote.pages);
    if (!picked) {
      throw new Error("No remote pages found; extension might be disconnected");
    }
    pageId = picked.pageId;
  }

  console.log(`FASTPATH_PAGE_ID=${pageId}`);

  const synced = await syncPageWithRetry(endpoint, pageId);
  console.log(`FASTPATH_PAGE_TYPE=${synced.pageType}`);
  if (synced.pageType !== "google.search") {
    throw new Error(`Expected pageType=google.search but got ${synced.pageType}`);
  }

  const pull = await postJson<PullResponse>(endpoint, "/pull", { pageId });
  const queryFile = pull.files.find((file) => file.id === "search.query");
  if (!queryFile) {
    throw new Error("search.query node is missing");
  }

  const applyPayload: ApplyRequest = {
    pageId,
    baseRev: pull.rev,
    edits: [{ id: queryFile.id, value: query }]
  };
  const applyResult = await postJson<ApplyResponse>(endpoint, "/apply", applyPayload);
  console.log(`FASTPATH_APPLY_REV=${applyResult.rev}`);

  const callPayload: CallRequest = {
    pageId,
    baseRev: applyResult.rev,
    target: { id: "page" },
    fn: "search",
    args: { query }
  };
  await postJson<CallResponse>(endpoint, "/call", callPayload);
  console.log("FASTPATH_CALL=page.search");

  const waited = await waitForResultTree({
    endpoint,
    pageId,
    timeoutMs,
    pollIntervalMs,
    minResults
  });

  const pullAfter = await postJson<PullResponse>(endpoint, "/pull", { pageId });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "state-after-search.xml"), pullAfter.xml, "utf8");

  console.log(`FASTPATH_RESULT_IDS=${waited.resultActionIds.join(",")}`);
  console.log(`FASTPATH_NEXT_ACTION=${waited.nextActionId}`);

  const result: FastpathResult = {
    ok: true,
    pageId,
    pageType: synced.pageType,
    query,
    resultCount: waited.resultActionIds.length,
    resultActionIds: waited.resultActionIds,
    nextActionId: waited.nextActionId,
    rev: waited.sync.rev
  };

  await writeFile(join(outDir, "summary.json"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
}

await main();
