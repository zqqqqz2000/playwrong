import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { startBridgeHttpServer } from "@playwrong/server";
import type { ApplyRequest, ApplyResponse, CallRequest, CallResponse, PullResponse, UpsertSnapshotRequest } from "@playwrong/protocol";

interface RemotePageInfo {
  pageId: string;
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

const ROOT = process.cwd();
const EXTENSION_DIST = join(ROOT, "apps/extension/dist");
const USER_DATA_DIR = process.env.PLAYWRONG_GH_USER_DATA_DIR || join(ROOT, "tmp/e2e/github-user-data");
const LOG_DIR = join(ROOT, "tmp/e2e/github-create");
const HEADLESS = process.env.PLAYWRONG_GH_HEADLESS === "1";
const BROWSER_CHANNEL = process.env.PLAYWRONG_GH_BROWSER_CHANNEL || "chrome";
const REPO_NAME = process.env.PLAYWRONG_GH_REPO_NAME || "playwrong";
const REPO_DESCRIPTION = process.env.PLAYWRONG_GH_REPO_DESCRIPTION || "Playwrong automation bridge";
const VISIBILITY = process.env.PLAYWRONG_GH_VISIBILITY === "private" ? "private" : "public";
const AUTO_INIT = process.env.PLAYWRONG_GH_AUTO_INIT === "1";
const LOGIN_WAIT_MS = Number(process.env.PLAYWRONG_GH_LOGIN_WAIT_MS || "600000");
const OP_LOG_PATH = join(LOG_DIR, "playwrong-ops.json");
const opLog: Array<{ ts: string; method: "GET" | "POST"; path: string; payload?: unknown }> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson<T>(baseUrl: string, pathname: string, payload: unknown): Promise<T> {
  opLog.push({ ts: new Date().toISOString(), method: "POST", path: pathname, payload });
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    const message = body.error?.message || `POST ${pathname} failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function getJson<T>(baseUrl: string, pathname: string): Promise<T> {
  opLog.push({ ts: new Date().toISOString(), method: "GET", path: pathname });
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "GET",
    headers: { "content-type": "application/json" }
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    const message = body.error?.message || `GET ${pathname} failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

async function waitExtensionConnected(baseUrl: string): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const status = await getJson<{ connected: boolean }>(baseUrl, "/extension/status");
    if (status.connected) {
      console.log("extension connected");
      return;
    }
    if (i % 50 === 0) {
      console.log(`waiting extension connection... attempt=${i}`);
    }
    await sleep(100);
  }
  throw new Error("Extension websocket not connected");
}

async function syncPageWithRetry(baseUrl: string, pageId: string, page: Page): Promise<UpsertSnapshotRequest & { rev: number }> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      return await postJson<UpsertSnapshotRequest & { rev: number }>(baseUrl, "/sync/page", { pageId });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/Execution context was destroyed|Cannot access a closed page/i.test(message)) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      await sleep(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("sync/page failed");
}

async function findCurrentRemotePage(baseUrl: string, currentUrl: string): Promise<RemotePageInfo> {
  const pages = await getJson<{ pages: RemotePageInfo[] }>(baseUrl, "/pages/remote");
  const selected =
    pages.pages.find((p) => p.active && p.url === currentUrl) ??
    pages.pages.find((p) => p.url === currentUrl) ??
    pages.pages.find((p) => p.active && /github\.com/.test(p.url)) ??
    pages.pages.find((p) => /github\.com/.test(p.url));

  if (!selected) {
    throw new Error("Cannot find active GitHub page in /pages/remote");
  }
  return selected;
}

async function waitForNewRepoPage(baseUrl: string, pageId: string, page: Page): Promise<UpsertSnapshotRequest & { rev: number }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LOGIN_WAIT_MS) {
    const synced = await syncPageWithRetry(baseUrl, pageId, page);
    if (synced.pageType === "github.repo.new") {
      return synced;
    }

    if (synced.pageType === "github.login") {
      console.log("GitHub login required. Please finish login in the opened browser window...");
    } else {
      console.log(`Waiting for github.repo.new, current pageType=${synced.pageType}, url=${page.url()}`);
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for github.repo.new (waited ${LOGIN_WAIT_MS}ms)`);
}

function findFileValue(files: PullResponse["files"], id: string): PullResponse["files"][number] | undefined {
  return files.find((file) => file.id === id);
}

async function run(): Promise<void> {
  console.log("step: prepare workspace");
  await mkdir(join(ROOT, "tmp/e2e"), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });

  console.log("step: build extension");
  await Bun.$`bun run --cwd ${join(ROOT, "apps/extension")} build`;

  console.log("step: start bridge server");
  const started = startBridgeHttpServer({ host: "127.0.0.1", port: 7878 });
  const baseUrl = started.server.url.toString();

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
  try {
    console.log(`step: launch browser channel=${BROWSER_CHANNEL} headless=${HEADLESS}`);
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      channel: BROWSER_CHANNEL,
      headless: HEADLESS,
      ignoreDefaultArgs: [
        "--use-mock-keychain",
        "--password-store=basic"
      ],
      args: [
        `--disable-extensions-except=${EXTENSION_DIST}`,
        `--load-extension=${EXTENSION_DIST}`
      ]
    });

    console.log("step: goto github/new");
    const page = await context.newPage();
    await page.goto("https://github.com/new", { waitUntil: "domcontentloaded" });

    console.log("step: wait extension websocket");
    await waitExtensionConnected(baseUrl);
    console.log("step: reload page");
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(800);

    console.log("step: resolve remote page");
    const remote = await findCurrentRemotePage(baseUrl, page.url());
    const pageId = remote.pageId;
    console.log(`step: pageId=${pageId}`);

    console.log("step: wait for github.repo.new snapshot");
    const syncedNew = await waitForNewRepoPage(baseUrl, pageId, page);
    console.log(`step: snapshot pageType=${syncedNew.pageType}`);
    const pull = await postJson<PullResponse>(baseUrl, "/pull", { pageId });

    const edits: ApplyRequest["edits"] = [];
    if (findFileValue(pull.files, "github.repo.new.name")) {
      edits.push({ id: "github.repo.new.name", value: REPO_NAME });
    }
    if (findFileValue(pull.files, "github.repo.new.description")) {
      edits.push({ id: "github.repo.new.description", value: REPO_DESCRIPTION });
    }

    if (findFileValue(pull.files, "github.repo.new.visibility.public")) {
      edits.push({ id: "github.repo.new.visibility.public", value: VISIBILITY === "public" });
    }
    if (findFileValue(pull.files, "github.repo.new.visibility.private")) {
      edits.push({ id: "github.repo.new.visibility.private", value: VISIBILITY === "private" });
    }
    if (findFileValue(pull.files, "github.repo.new.auto_init")) {
      edits.push({ id: "github.repo.new.auto_init", value: AUTO_INIT });
    }

    if (!findFileValue(pull.files, "github.repo.new.name")) {
      await writeFile(join(LOG_DIR, "pull-before-create.xml"), pull.xml, "utf8");
      throw new Error("Missing github.repo.new.name editable file. GitHub plugin may not be active.");
    }

    console.log("step: apply form edits");
    const apply = await postJson<ApplyResponse>(baseUrl, "/apply", {
      pageId,
      baseRev: pull.rev,
      edits
    } satisfies ApplyRequest);

    console.log("step: submit create repository action");
    await postJson<CallResponse>(baseUrl, "/call", {
      pageId,
      baseRev: apply.rev,
      target: { id: "github.repo.new.submit" },
      fn: "click",
      args: {}
    } satisfies CallRequest);

    console.log("step: wait for repository url");
    await page.waitForURL(new RegExp(`github\\.com/[^/]+/${REPO_NAME}(?:/|$)`), { timeout: 120000 });
    await page.waitForLoadState("domcontentloaded");

    console.log("step: pull final xml");
    const syncedAfter = await syncPageWithRetry(baseUrl, pageId, page);
    const pullAfter = await postJson<PullResponse>(baseUrl, "/pull", { pageId });

    await writeFile(join(LOG_DIR, "state-after-create.xml"), pullAfter.xml, "utf8");

    const repoMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/.exec(page.url());
    if (!repoMatch) {
      throw new Error(`Repository URL not detected after creation: ${page.url()}`);
    }

    const owner = repoMatch[1] ?? "";
    const repo = repoMatch[2] ?? "";
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    await writeFile(
      join(LOG_DIR, "result.json"),
      JSON.stringify(
        {
          ok: true,
          pageId,
          pageTypeBefore: syncedNew.pageType,
          pageTypeAfter: syncedAfter.pageType,
          owner,
          repo,
          repoUrl,
          url: page.url()
        },
        null,
        2
      ),
      "utf8"
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          owner,
          repo,
          repoUrl,
          url: page.url(),
          logDir: LOG_DIR
        },
        null,
        2
      )
    );
  } finally {
    await writeFile(OP_LOG_PATH, JSON.stringify(opLog, null, 2), "utf8");
    if (context) {
      await context.close();
    }
    started.server.stop(true);
  }
}

await run();
