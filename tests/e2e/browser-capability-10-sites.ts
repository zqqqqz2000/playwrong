import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { startBridgeHttpServer } from "../../apps/server/src/http";
import type {
  PullResponse,
  RemotePageInfo,
  SemanticNode,
  UpsertSnapshotRequest
} from "../../packages/protocol/src/index";

interface SearchBehavior {
  kind: "search";
  query: string;
  minResultActions: number;
  requireNextAction?: boolean;
}

interface RefreshBehavior {
  kind: "refresh";
}

type SiteBehavior = SearchBehavior | RefreshBehavior;

interface SiteCase {
  id: string;
  url: string;
  allowedPageTypes?: string[];
  requiredNodeIds?: string[];
  behaviors: SiteBehavior[];
}

interface BehaviorResult {
  kind: SiteBehavior["kind"];
  ok: boolean;
  issues: string[];
  details: Record<string, unknown>;
}

interface SiteResult {
  id: string;
  url: string;
  pageId: string;
  pageType: string;
  rev: number;
  nodeCount: number;
  actionCount: number;
  editableCount: number;
  fileCount: number;
  xmlLength: number;
  behaviorResults: BehaviorResult[];
  ok: boolean;
  issues: string[];
}

const ROOT = process.env.PLAYWRONG_E2E_ROOT || resolve(join(import.meta.dir, "../.."));
const EXTENSION_DIST = join(ROOT, "apps/extension/dist");
const USER_DATA_DIR = join(ROOT, "tmp/e2e/capability-10-sites-user-data");
const REPORT_DIR = join(ROOT, "tmp/e2e/capability-10-sites");
const DEFAULT_ENDPOINT = "http://127.0.0.1:7878";
const HEADLESS = !["0", "false", "no"].includes((process.env.PLAYWRONG_E2E_HEADLESS ?? "1").toLowerCase());

const SEARCH_QUERY = "playwrong llm automation";

const SITE_CASES: SiteCase[] = [
  {
    id: "google",
    url: "https://www.google.com/ncr?hl=en",
    allowedPageTypes: ["google.search"],
    requiredNodeIds: ["search.query"],
    behaviors: [{ kind: "search", query: SEARCH_QUERY, minResultActions: 3, requireNextAction: true }]
  },
  {
    id: "bing",
    url: "https://www.bing.com/search?q=playwrong",
    allowedPageTypes: ["bing.search"],
    requiredNodeIds: ["search.query"],
    behaviors: [{ kind: "search", query: SEARCH_QUERY, minResultActions: 3, requireNextAction: true }]
  },
  {
    id: "duckduckgo",
    url: "https://duckduckgo.com/",
    allowedPageTypes: ["duckduckgo.search"],
    requiredNodeIds: ["search.query"],
    behaviors: [{ kind: "search", query: SEARCH_QUERY, minResultActions: 3 }]
  },
  {
    id: "github",
    url: "https://github.com/",
    allowedPageTypes: ["github.repo.new", "github.login", "github.page"],
    behaviors: [{ kind: "refresh" }]
  },
  {
    id: "wikipedia",
    url: "https://www.wikipedia.org/wiki/Main_Page",
    behaviors: [{ kind: "refresh" }]
  },
  {
    id: "hackernews",
    url: "https://news.ycombinator.com/",
    behaviors: [{ kind: "refresh" }]
  },
  {
    id: "stackoverflow",
    url: "https://stackoverflow.com/questions",
    behaviors: [{ kind: "refresh" }]
  },
  {
    id: "npm",
    url: "https://www.npmjs.com/",
    behaviors: [{ kind: "refresh" }]
  },
  {
    id: "mdn",
    url: "https://developer.mozilla.org/en-US/",
    behaviors: [{ kind: "refresh" }]
  },
  {
    id: "python",
    url: "https://www.python.org/",
    behaviors: [{ kind: "refresh" }]
  }
];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(baseUrl: string, pathname: string, payload: unknown): Promise<T> {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as T & { error?: { code?: string; message?: string } };
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function getJson<T>(baseUrl: string, pathname: string): Promise<T> {
  const response = await fetch(new URL(pathname, baseUrl));
  const body = (await response.json()) as T & { error?: { code?: string; message?: string } };
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${JSON.stringify(body)}`);
  }
  return body;
}

function flattenNodes(tree: SemanticNode[]): SemanticNode[] {
  const all: SemanticNode[] = [];
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    all.push(node);
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return all;
}

function countResultActions(tree: SemanticNode[]): number {
  return flattenNodes(tree).filter((node) => node.kind === "action" && /^search\.result\.\d+\.open$/.test(node.id)).length;
}

function hasNextPagination(tree: SemanticNode[]): boolean {
  return flattenNodes(tree).some((node) => node.id === "search.pagination.next" && node.kind === "action");
}

function detectKnownBlockers(pageType: string, tree: SemanticNode[]): string[] {
  const issues: string[] = [];
  const flat = flattenNodes(tree);
  const textBlob = flat
    .map((node) => `${node.label ?? ""} ${typeof node.value === "string" ? node.value : ""}`)
    .join(" ")
    .toLowerCase();

  if (textBlob.includes("captcha") || textBlob.includes("unusual traffic") || textBlob.includes("not a robot")) {
    issues.push("captcha_or_antibot_detected");
  }
  if (pageType.includes("login") && !textBlob.includes("github")) {
    issues.push("login_page_detected");
  }
  return issues;
}

async function waitExtensionConnected(baseUrl: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      const status = await getJson<{ connected: boolean }>(baseUrl, "/extension/status");
      if (status.connected) {
        return;
      }
    } catch {
      // ignore
    }
    await wait(250);
  }
  throw new Error("Extension websocket not connected");
}

function hostFromUrl(input: string): string {
  return new URL(input).hostname;
}

function pickPageId(pages: RemotePageInfo[], targetUrl: string): string | null {
  const host = hostFromUrl(targetUrl);
  const hostMatch = (url: string | undefined): boolean => {
    if (!url) {
      return false;
    }
    try {
      return new URL(url).hostname === host;
    } catch {
      return false;
    }
  };

  const activeHost = pages.find((p) => p.active && hostMatch(p.url));
  if (activeHost) {
    return activeHost.pageId;
  }

  const anyHost = pages.find((p) => hostMatch(p.url));
  if (anyHost) {
    return anyHost.pageId;
  }

  const activeAny = pages.find((p) => p.active);
  return activeAny?.pageId ?? null;
}

async function syncPageWithRetry(baseUrl: string, pageId: string): Promise<UpsertSnapshotRequest & { rev: number }> {
  let lastError: unknown = null;

  for (let i = 0; i < 12; i += 1) {
    try {
      return await postJson<UpsertSnapshotRequest & { rev: number }>(baseUrl, "/sync/page", { pageId });
    } catch (error) {
      lastError = error;
      await wait(450);
    }
  }

  throw new Error(`sync/page failed for ${pageId}: ${String(lastError)}`);
}

function hasPageCall(snapshot: UpsertSnapshotRequest & { rev: number }, name: string): boolean {
  return (snapshot.pageCalls ?? []).some((c) => c.name === name);
}

async function runRefreshBehavior(baseUrl: string, pageId: string, snapshot: UpsertSnapshotRequest & { rev: number }): Promise<{
  result: BehaviorResult;
  snapshot: UpsertSnapshotRequest & { rev: number };
}> {
  const issues: string[] = [];

  if (!hasPageCall(snapshot, "refresh")) {
    issues.push("missing_page_call:refresh");
    return {
      result: {
        kind: "refresh",
        ok: false,
        issues,
        details: { pageType: snapshot.pageType }
      },
      snapshot
    };
  }

  let callRev = snapshot.rev;
  try {
    const callOut = await postJson<{ rev: number }>(baseUrl, "/call", {
      pageId,
      baseRev: snapshot.rev,
      target: { id: "page" },
      fn: "refresh",
      args: {}
    });
    callRev = callOut.rev;
  } catch (error) {
    issues.push(`call_failed:${error instanceof Error ? error.message : String(error)}`);
    return {
      result: {
        kind: "refresh",
        ok: false,
        issues,
        details: { pageType: snapshot.pageType }
      },
      snapshot
    };
  }

  await wait(900);
  const syncedAfter = await syncPageWithRetry(baseUrl, pageId);

  if (syncedAfter.rev < callRev) {
    issues.push(`rev_not_advanced:expected>=${callRev},got=${syncedAfter.rev}`);
  }

  return {
    result: {
      kind: "refresh",
      ok: issues.length === 0,
      issues,
      details: {
        beforeRev: snapshot.rev,
        afterRev: syncedAfter.rev,
        pageType: syncedAfter.pageType
      }
    },
    snapshot: syncedAfter
  };
}

async function runSearchBehavior(
  baseUrl: string,
  pageId: string,
  snapshot: UpsertSnapshotRequest & { rev: number },
  behavior: SearchBehavior
): Promise<{
  result: BehaviorResult;
  snapshot: UpsertSnapshotRequest & { rev: number };
}> {
  const issues: string[] = [];
  let readySnapshot = snapshot;

  // Search pages can jitter through redirects/reloads; wait until search capability is fully exposed.
  for (let i = 0; i < 20; i += 1) {
    const flat = flattenNodes(readySnapshot.tree);
    const hasQueryNode = flat.some((node) => node.id === "search.query" && node.kind === "editable");
    if (hasPageCall(readySnapshot, "search") && hasQueryNode) {
      break;
    }
    await wait(400);
    readySnapshot = await syncPageWithRetry(baseUrl, pageId);
  }

  const readyFlat = flattenNodes(readySnapshot.tree);
  const hasQueryNode = readyFlat.some((node) => node.id === "search.query" && node.kind === "editable");
  if (!hasPageCall(readySnapshot, "search") || !hasQueryNode) {
    if (!hasPageCall(readySnapshot, "search")) {
      issues.push("missing_page_call:search");
    }
    if (!hasQueryNode) {
      issues.push("missing_node:search.query");
    }
    return {
      result: {
        kind: "search",
        ok: false,
        issues,
        details: {
          pageType: readySnapshot.pageType,
          nodeIdsSample: readyFlat.slice(0, 20).map((node) => node.id)
        }
      },
      snapshot: readySnapshot
    };
  }

  let callRev = readySnapshot.rev;
  try {
    const callOut = await postJson<{ rev: number }>(baseUrl, "/call", {
      pageId,
      baseRev: readySnapshot.rev,
      target: { id: "page" },
      fn: "search",
      args: { query: behavior.query }
    });
    callRev = callOut.rev;
  } catch (error) {
    issues.push(`call_failed:${error instanceof Error ? error.message : String(error)}`);
    return {
      result: {
        kind: "search",
        ok: false,
        issues,
        details: { pageType: readySnapshot.pageType }
      },
      snapshot: readySnapshot
    };
  }

  let latest = readySnapshot;
  let resultCount = 0;
  let next = false;

  for (let i = 0; i < 32; i += 1) {
    await wait(500);
    latest = await syncPageWithRetry(baseUrl, pageId);
    resultCount = countResultActions(latest.tree);
    next = hasNextPagination(latest.tree);
    if (resultCount >= behavior.minResultActions) {
      break;
    }
  }

  if (latest.rev < callRev) {
    issues.push(`rev_not_advanced:expected>=${callRev},got=${latest.rev}`);
  }
  if (resultCount < behavior.minResultActions) {
    issues.push(`insufficient_results:${resultCount}<${behavior.minResultActions}`);
  }
  if (behavior.requireNextAction && !next) {
    issues.push("missing_next_pagination_action");
  }

  return {
    result: {
      kind: "search",
      ok: issues.length === 0,
      issues,
      details: {
        query: behavior.query,
        beforeRev: readySnapshot.rev,
        afterRev: latest.rev,
        pageType: latest.pageType,
        resultCount,
        hasNextPagination: next
      }
    },
    snapshot: latest
  };
}

async function runSiteCase(input: {
  baseUrl: string;
  page: Page;
  site: SiteCase;
}): Promise<SiteResult> {
  const { baseUrl, page, site } = input;

  try {
    await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch {
    await page.goto(site.url, { waitUntil: "commit", timeout: 20000 });
  }
  await wait(1600);

  const pages = await getJson<{ pages: RemotePageInfo[] }>(baseUrl, "/pages/remote");
  const pageId = pickPageId(pages.pages, site.url);
  if (!pageId) {
    throw new Error(`Cannot resolve pageId for site ${site.id}`);
  }

  let snapshot = await syncPageWithRetry(baseUrl, pageId);
  const pull = await postJson<PullResponse>(baseUrl, "/pull", { pageId });

  const flat = flattenNodes(snapshot.tree);
  const actionCount = flat.filter((node) => node.kind === "action").length;
  const editableCount = flat.filter((node) => node.kind === "editable").length;

  const issues = detectKnownBlockers(snapshot.pageType, snapshot.tree);

  if (site.allowedPageTypes && !site.allowedPageTypes.includes(snapshot.pageType)) {
    issues.push(`unexpected_page_type:${snapshot.pageType}`);
  }

  if (site.requiredNodeIds?.length) {
    const nodeIds = new Set(flat.map((node) => node.id));
    for (const required of site.requiredNodeIds) {
      if (!nodeIds.has(required)) {
        issues.push(`missing_node:${required}`);
      }
    }
  }

  if (!pull.xml.includes("<page ")) {
    issues.push("xml_missing_page_root");
  }

  if (snapshot.rev < 1) {
    issues.push("invalid_rev");
  }

  if ((snapshot.pageCalls?.length ?? 0) === 0 && flat.length === 0) {
    issues.push("no_capability_exposed");
  }

  const behaviorResults: BehaviorResult[] = [];
  for (const behavior of site.behaviors) {
    if (behavior.kind === "refresh") {
      const run = await runRefreshBehavior(baseUrl, pageId, snapshot);
      behaviorResults.push(run.result);
      snapshot = run.snapshot;
      continue;
    }

    const run = await runSearchBehavior(baseUrl, pageId, snapshot, behavior);
    behaviorResults.push(run.result);
    snapshot = run.snapshot;
  }

  const behaviorIssues = behaviorResults.flatMap((r, idx) => r.issues.map((issue) => `behavior[${idx}:${r.kind}]:${issue}`));
  issues.push(...behaviorIssues);

  const ok = issues.length === 0 && behaviorResults.every((r) => r.ok);

  return {
    id: site.id,
    url: site.url,
    pageId,
    pageType: snapshot.pageType,
    rev: snapshot.rev,
    nodeCount: flat.length,
    actionCount,
    editableCount,
    fileCount: pull.files.length,
    xmlLength: pull.xml.length,
    behaviorResults,
    ok,
    issues
  };
}

async function main(): Promise<void> {
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await rm(REPORT_DIR, { recursive: true, force: true });
  await mkdir(USER_DATA_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });

  let bridgeStarted: ReturnType<typeof startBridgeHttpServer> | null = null;
  let useExternalServer = false;

  try {
    bridgeStarted = startBridgeHttpServer({ host: "127.0.0.1", port: 7878 });
  } catch {
    const health = await fetch(new URL("/health", DEFAULT_ENDPOINT)).catch(() => null);
    if (!health || !health.ok) {
      throw new Error("Cannot start bridge server at 127.0.0.1:7878 and no external server found");
    }
    useExternalServer = true;
  }
  const baseUrl = DEFAULT_ENDPOINT;

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: "chromium",
    headless: HEADLESS,
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    locale: "en-US",
    args: [
      `--disable-extensions-except=${EXTENSION_DIST}`,
      `--load-extension=${EXTENSION_DIST}`,
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await waitExtensionConnected(baseUrl);

    const results: SiteResult[] = [];
    for (const site of SITE_CASES) {
      try {
        const result = await runSiteCase({ baseUrl, page, site });
        results.push(result);
        const behaviorSummary = result.behaviorResults.map((b) => `${b.kind}:${b.ok ? "ok" : "fail"}`).join("|");
        console.log(`[site=${site.id}] pageType=${result.pageType} ok=${result.ok} behaviors=${behaviorSummary} issues=${result.issues.join(",")}`);
      } catch (error) {
        const failedResult: SiteResult = {
          id: site.id,
          url: site.url,
          pageId: "",
          pageType: "",
          rev: 0,
          nodeCount: 0,
          actionCount: 0,
          editableCount: 0,
          fileCount: 0,
          xmlLength: 0,
          behaviorResults: [],
          ok: false,
          issues: [`runtime_error:${error instanceof Error ? error.message : String(error)}`]
        };
        results.push(failedResult);
        console.log(`[site=${site.id}] ok=false issues=${failedResult.issues.join(",")}`);
      }
    }

    const failed = results.filter((r) => !r.ok);
    const summary = {
      ok: failed.length === 0,
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      results
    };

    const reportPath = join(REPORT_DIR, "summary.json");
    await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

    console.log(`REPORT=${reportPath}`);
    console.log(JSON.stringify(summary, null, 2));

    if (failed.length > 0) {
      throw new Error(`Capability test failed on ${failed.length} sites`);
    }
  } finally {
    await context.close();
    if (!useExternalServer && bridgeStarted) {
      bridgeStarted.server.stop(true);
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
