import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { startBridgeHttpServer } from "../../apps/server/src/http";
import type {
  ApplyRequest,
  ApplyResponse,
  CallRequest,
  CallResponse,
  PullResponse,
  RemotePageInfo,
  SemanticNode,
  UpsertSnapshotRequest
} from "../../packages/protocol/src/index";

type E2EMode = "google-like" | "real-google";

const ROOT = process.env.PLAYWRONG_E2E_ROOT || resolve(join(import.meta.dir, "../.."));
const EXTENSION_DIST = join(ROOT, "apps/extension/dist");
const USER_DATA_DIR = join(ROOT, "tmp/e2e/google-user-data");
const FIXTURE_PATH = join(ROOT, "tests/fixtures/google-like.html");
const BRIDGE_STATE_DIR = join(ROOT, ".bridge-e2e-google");
const DEFAULT_ENDPOINT = process.env.PLAYWRONG_E2E_ENDPOINT || "http://127.0.0.1:7878";

const MODE: E2EMode = process.env.PLAYWRONG_E2E_TARGET === "real-google" ? "real-google" : "google-like";
const REAL_GOOGLE_URL = process.env.PLAYWRONG_REAL_GOOGLE_URL || "https://www.google.com/ncr?hl=en";
const APPLY_QUERY_VALUE = "playwrong llm";
const CALL_QUERY_VALUE = "playwrong llm automation";

function assertTruthy<T>(value: T | null | undefined, message: string): T {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(baseUrl: string, pathname: string, payload: unknown): Promise<T> {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function getJson<T>(baseUrl: string, pathname: string): Promise<T> {
  const response = await fetch(new URL(pathname, baseUrl));
  const body = (await response.json()) as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${pathname}: ${JSON.stringify(body)}`);
  }
  return body;
}

function pageLooksLikeTarget(url: string | undefined, mode: E2EMode): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    if (mode === "google-like") {
      return parsed.pathname.includes("google-like.html");
    }
    return /(^|\.)google\./i.test(parsed.hostname);
  } catch {
    return false;
  }
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

function firstMatchingActionId(tree: SemanticNode[], matcher: (id: string) => boolean): string | null {
  return collectActionIds(tree, matcher)[0] ?? null;
}

async function readSearchFieldValue(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const field = document.querySelector("textarea[name='q'],input[name='q']") as
        | HTMLTextAreaElement
        | HTMLInputElement
        | null;
      return field?.value ?? "";
    });
  } catch {
    return "";
  }
}

async function readUrlParam(page: Page, key: string): Promise<string> {
  try {
    return await page.evaluate((k) => {
      try {
        return new URL(window.location.href).searchParams.get(k) ?? "";
      } catch {
        return "";
      }
    }, key);
  } catch {
    return "";
  }
}

async function googleConsentPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = (document.body?.innerText ?? "").toLowerCase();
    if (text.includes("before you continue") || text.includes("consent") || text.includes("privacy & terms")) {
      return true;
    }
    return Boolean(document.querySelector("button#L2AGLb") || document.querySelector("form[action*='consent']"));
  });
}

async function tryAcceptGoogleConsent(page: Page): Promise<boolean> {
  const selectors = [
    "button#L2AGLb",
    "form[action*='consent'] button[type='submit']",
    "button:has-text('I agree')",
    "button:has-text('Accept all')",
    "button:has-text('Accept')",
    "button:has-text('同意')",
    "button:has-text('接受全部')"
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) > 0) {
        const visible = await locator.isVisible().catch(() => false);
        if (visible) {
          await locator.click({ timeout: 2500 });
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
          return true;
        }
      }
    } catch {
      // ignore and continue
    }
  }

  return false;
}

async function ensureRealGoogleReady(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await googleConsentPresent(page)) {
      await tryAcceptGoogleConsent(page);
      await wait(800);
    }

    const state = await page.evaluate(() => {
      const hasSearchField = Boolean(document.querySelector("textarea[name='q'],input[name='q']"));
      const text = (document.body?.innerText ?? "").toLowerCase();
      const captcha =
        text.includes("unusual traffic") ||
        text.includes("our systems have detected") ||
        (text.includes("sorry") && text.includes("not a robot"));
      return {
        host: window.location.hostname,
        hasSearchField,
        captcha
      };
    });

    if (state.captcha) {
      throw new Error("Google anti-bot page detected; cannot complete strict real E2E in this run");
    }

    if (/google\./i.test(state.host) && state.hasSearchField) {
      return;
    }

    await page.goto(REAL_GOOGLE_URL, { waitUntil: "domcontentloaded" });
    await wait(800);
  }

  throw new Error("Cannot reach a valid Google page with editable search box");
}

async function waitForQueryVisible(page: Page, expected: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const urlQ = await readUrlParam(page, "q");
    const field = await readSearchFieldValue(page);
    if (urlQ === expected || field === expected) {
      return;
    }
    await wait(250);
  }
  throw new Error(`Expected query not observed: ${expected}`);
}

async function waitForSearchResultsPage(page: Page): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const state = await page.evaluate(() => {
      const path = window.location.pathname;
      const hasResults = Boolean(
        document.querySelector("#search a h3, .g a h3, a#pnnext, a[aria-label='Next page'], a[aria-label='Next']")
      );
      return { path, hasResults };
    });

    if (state.path.includes("/search") && state.hasResults) {
      return;
    }

    await wait(300);
  }

  throw new Error("Google results page did not appear after search call");
}

async function waitForPaginationAdvance(page: Page, beforeStart: string, beforeUrl: string): Promise<{ start: string; url: string }> {
  for (let i = 0; i < 40; i += 1) {
    const currentUrl = page.url();
    const start = await readUrlParam(page, "start");
    if (start !== beforeStart || currentUrl !== beforeUrl) {
      return { start, url: currentUrl };
    }
    await wait(300);
  }
  throw new Error("Pagination did not advance to next page");
}

async function syncPageWithRetry(
  baseUrl: string,
  pageId: string,
  page: Page
): Promise<UpsertSnapshotRequest & { rev: number }> {
  let lastError: unknown = null;

  for (let i = 0; i < 8; i += 1) {
    try {
      return await postJson<UpsertSnapshotRequest & { rev: number }>(baseUrl, "/sync/page", { pageId });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Receiving end does not exist") || message.includes("request timed out")) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        await wait(500);
        continue;
      }
      throw error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("sync/page failed");
}

async function main(): Promise<void> {
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await rm(BRIDGE_STATE_DIR, { recursive: true, force: true });
  await mkdir(join(ROOT, "tmp/e2e"), { recursive: true });
  await mkdir(BRIDGE_STATE_DIR, { recursive: true });

  await Bun.$`bun run --cwd ${join(ROOT, "apps/extension")} build`.quiet();

  let fixtureServer: ReturnType<typeof Bun.serve> | null = null;
  if (MODE === "google-like") {
    fixtureServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 8091,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/google-like.html") {
          return new Response(Bun.file(FIXTURE_PATH), {
            headers: { "content-type": "text/html; charset=utf-8" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });
  }

  const endpointUrl = new URL(DEFAULT_ENDPOINT);
  const endpointPort = Number(endpointUrl.port || (endpointUrl.protocol === "https:" ? "443" : "80"));
  let bridgeStarted: ReturnType<typeof startBridgeHttpServer> | null = null;
  let useExternalServer = false;

  try {
    bridgeStarted = startBridgeHttpServer({
      host: endpointUrl.hostname,
      port: endpointPort
    });
  } catch {
    const health = await fetch(new URL("/health", DEFAULT_ENDPOINT)).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(`Cannot start bridge server at ${DEFAULT_ENDPOINT} and no external server found`);
    }
    useExternalServer = true;
  }
  const bridgeBaseUrl = DEFAULT_ENDPOINT;

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: "chromium",
      headless: true,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      locale: "en-US",
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`,
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const page = await context.newPage();
    if (MODE === "google-like") {
      await page.goto("http://127.0.0.1:8091/google-like.html", { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(REAL_GOOGLE_URL, { waitUntil: "domcontentloaded" });
      await ensureRealGoogleReady(page);
    }

    let connected = false;
    for (let i = 0; i < 200; i += 1) {
      const status = await getJson<{ connected: boolean }>(bridgeBaseUrl, "/extension/status");
      if (status.connected) {
        connected = true;
        break;
      }
      await wait(100);
    }
    if (!connected) {
      throw new Error("Extension websocket not connected");
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await wait(500);
    if (MODE === "real-google") {
      await ensureRealGoogleReady(page);
    }

    let remotePages: { pages: RemotePageInfo[] } | null = null;
    for (let i = 0; i < 50; i += 1) {
      try {
        remotePages = await getJson<{ pages: RemotePageInfo[] }>(bridgeBaseUrl, "/pages/remote");
        break;
      } catch {
        await wait(200);
      }
    }
    if (!remotePages) {
      throw new Error("Cannot list remote pages from extension");
    }

    const currentUrl = page.url();
    const remotePage =
      remotePages.pages.find((p) => p.active && p.url === currentUrl) ??
      remotePages.pages.find((p) => p.url === currentUrl) ??
      remotePages.pages.find((p) => p.active && pageLooksLikeTarget(p.url, MODE)) ??
      remotePages.pages.find((p) => pageLooksLikeTarget(p.url, MODE));
    const pageId = assertTruthy(remotePage?.pageId, `Cannot find target page for mode=${MODE}`);

    const synced = await syncPageWithRetry(bridgeBaseUrl, pageId, page);

    if (synced.pageType !== "google.search") {
      throw new Error(`Expected pageType=google.search but got ${synced.pageType}`);
    }

    const pull = await postJson<PullResponse>(bridgeBaseUrl, "/pull", { pageId });
    await writeFile(join(BRIDGE_STATE_DIR, `state-${MODE}-before.xml`), pull.xml, "utf8");

    const queryFile = pull.files.find((f) => f.id === "search.query");
    const queryNodeId = assertTruthy(queryFile?.id, "Missing editable node search.query");

    const applyReq: ApplyRequest = {
      pageId,
      baseRev: pull.rev,
      edits: [{ id: queryNodeId, value: APPLY_QUERY_VALUE }]
    };
    const apply = await postJson<ApplyResponse>(bridgeBaseUrl, "/apply", applyReq);

    const fieldValue = await readSearchFieldValue(page);
    if (fieldValue !== APPLY_QUERY_VALUE) {
      throw new Error(`Expected query value ${APPLY_QUERY_VALUE}, got ${fieldValue}`);
    }

    const pageSearchCall: CallRequest = {
      pageId,
      baseRev: apply.rev,
      target: { id: "page" },
      fn: "search",
      args: { query: CALL_QUERY_VALUE }
    };
    await postJson<CallResponse>(bridgeBaseUrl, "/call", pageSearchCall);
    await waitForQueryVisible(page, CALL_QUERY_VALUE);

    if (MODE === "real-google") {
      await waitForSearchResultsPage(page);
    }

    const syncedAfterSearch = await syncPageWithRetry(bridgeBaseUrl, pageId, page);

    const resultActionIds = collectActionIds(syncedAfterSearch.tree, (id) => /^search\.result\.\d+\.open$/.test(id));
    if (resultActionIds.length < 3) {
      throw new Error(`Expected at least 3 search results, got ${resultActionIds.length}`);
    }

    const nextActionId = firstMatchingActionId(syncedAfterSearch.tree, (id) => id === "search.pagination.next");
    const nextId = assertTruthy(nextActionId, "Missing pagination action search.pagination.next");

    const beforeStart = await readUrlParam(page, "start");
    const beforeUrl = page.url();

    const nextCall: CallRequest = {
      pageId,
      baseRev: syncedAfterSearch.rev,
      target: { id: nextId },
      fn: "click"
    };
    await postJson<CallResponse>(bridgeBaseUrl, "/call", nextCall);

    const afterPage = await waitForPaginationAdvance(page, beforeStart, beforeUrl);

    const syncedAfterNext = await syncPageWithRetry(bridgeBaseUrl, pageId, page);

    const pullAfterNext = await postJson<PullResponse>(bridgeBaseUrl, "/pull", { pageId });
    await writeFile(join(BRIDGE_STATE_DIR, `state-${MODE}-after-next.xml`), pullAfterNext.xml, "utf8");

    const resultActionIdsAfterNext = collectActionIds(
      syncedAfterNext.tree,
      (id) => /^search\.result\.\d+\.open$/.test(id)
    );
    if (resultActionIdsAfterNext.length < 3) {
      throw new Error(`Expected at least 3 results after next page, got ${resultActionIdsAfterNext.length}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: MODE,
          pageId,
          pageType: synced.pageType,
          query: CALL_QUERY_VALUE,
          resultCountPage1: resultActionIds.length,
          resultCountPage2: resultActionIdsAfterNext.length,
          startBefore: beforeStart,
          startAfter: afterPage.start,
          urlAfter: afterPage.url
        },
        null,
        2
      )
    );
  } finally {
    if (context) {
      await context.close();
    }
    if (!useExternalServer && bridgeStarted) {
      bridgeStarted.server.stop(true);
    }
    fixtureServer?.stop(true);
  }
}

await main();
