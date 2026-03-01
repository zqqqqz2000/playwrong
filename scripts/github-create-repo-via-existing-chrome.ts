import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
const SERVER_ENDPOINT = process.env.PLAYWRONG_GH_ENDPOINT || "http://127.0.0.1:7878";
const CHROME_PROFILE_ROOT =
  process.env.PLAYWRONG_GH_USER_DATA_DIR ||
  join(process.env.HOME || "", "Library/Application Support/Google/Chrome");
const REPO_NAME = process.env.PLAYWRONG_GH_REPO_NAME || "playwrong";
const REPO_DESCRIPTION = process.env.PLAYWRONG_GH_REPO_DESCRIPTION || "Playwrong automation bridge";
const REPO_VISIBILITY = process.env.PLAYWRONG_GH_VISIBILITY === "private" ? "private" : "public";
const AUTO_INIT = process.env.PLAYWRONG_GH_AUTO_INIT === "1";
const LOGIN_WAIT_MS = Number(process.env.PLAYWRONG_GH_LOGIN_WAIT_MS || "600000");
const CREATE_WAIT_MS = Number(process.env.PLAYWRONG_GH_CREATE_WAIT_MS || "120000");
const LOG_DIR = join(ROOT, "tmp/e2e/github-create");
const OPS_LOG = join(LOG_DIR, "playwrong-ops.json");
const SERVER_LOG = join(LOG_DIR, "server.log");
const SERVER_ERR = join(LOG_DIR, "server.err.log");

const opLog: Array<{ ts: string; method: "GET" | "POST"; path: string; payload?: unknown }> = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(path: string): Promise<T> {
  opLog.push({ ts: new Date().toISOString(), method: "GET", path });
  const response = await fetch(new URL(path, SERVER_ENDPOINT), {
    method: "GET",
    headers: { "content-type": "application/json" }
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || `GET ${path} failed: ${response.status}`);
  }
  return body;
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  opLog.push({ ts: new Date().toISOString(), method: "POST", path, payload });
  const response = await fetch(new URL(path, SERVER_ENDPOINT), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message || `POST ${path} failed: ${response.status}`);
  }
  return body;
}

function pickGithubPage(pages: RemotePageInfo[]): RemotePageInfo | null {
  return (
    pages.find((p) => p.active && /github\.com/.test(p.url)) ??
    pages.find((p) => /github\.com/.test(p.url)) ??
    null
  );
}

async function waitServerHealthy(): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      await getJson<{ ok: boolean }>("/health");
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("Bridge server did not become healthy");
}

async function waitExtensionConnected(): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const status = await getJson<{ connected: boolean }>("/extension/status");
    if (status.connected) {
      console.log("extension connected");
      return;
    }
    if (i % 50 === 0) {
      console.log(`waiting extension websocket... attempt=${i}`);
    }
    await sleep(100);
  }
  throw new Error("Extension websocket not connected");
}

async function waitGithubPage(): Promise<RemotePageInfo> {
  for (let i = 0; i < 300; i += 1) {
    const out = await getJson<{ pages: RemotePageInfo[] }>("/pages/remote");
    const page = pickGithubPage(out.pages);
    if (page) {
      return page;
    }
    await sleep(200);
  }
  throw new Error("No GitHub page found in /pages/remote");
}

async function waitForNewRepoSnapshot(pageId: string): Promise<UpsertSnapshotRequest & { rev: number }> {
  const startedAt = Date.now();
  let openedNewRepo = false;

  while (Date.now() - startedAt < LOGIN_WAIT_MS) {
    const synced = await postJson<UpsertSnapshotRequest & { rev: number }>("/sync/page", { pageId });
    if (synced.pageType === "github.repo.new") {
      return synced;
    }

    if (synced.pageType === "github.page" && !openedNewRepo) {
      await postJson<CallResponse>("/call", {
        pageId,
        baseRev: synced.rev,
        target: { id: "page" },
        fn: "openNewRepository",
        args: {}
      } satisfies CallRequest);
      openedNewRepo = true;
      await sleep(1000);
      continue;
    }

    if (synced.pageType === "github.login") {
      console.log("GitHub login required in your opened Chrome. Please finish login (incl. 2FA), script will continue...");
    } else {
      console.log(`waiting github.repo.new, current pageType=${synced.pageType}`);
    }

    await sleep(1000);
  }

  throw new Error(`Timed out waiting for github.repo.new (${LOGIN_WAIT_MS}ms)`);
}

async function waitRepositoryUrl(repoName: string): Promise<{ owner: string; repo: string; url: string }> {
  const startedAt = Date.now();
  const pattern = new RegExp(`^https://github\\.com/([^/]+)/(${repoName})(?:/|$)`);

  while (Date.now() - startedAt < CREATE_WAIT_MS) {
    const pages = await getJson<{ pages: RemotePageInfo[] }>("/pages/remote");
    const page = pickGithubPage(pages.pages);
    const currentUrl = page?.url ?? "";
    const match = pattern.exec(currentUrl);
    if (match) {
      return {
        owner: match[1] ?? "",
        repo: match[2] ?? "",
        url: currentUrl
      };
    }
    await sleep(1000);
  }

  throw new Error(`Repository URL did not appear within ${CREATE_WAIT_MS}ms`);
}

async function main(): Promise<void> {
  await mkdir(join(ROOT, "tmp/e2e"), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });

  await Bun.$`bun run --cwd ${join(ROOT, "apps/extension")} build`;

  await Bun.$`pkill -f "Google Chrome"`.nothrow();
  await sleep(1000);

  const serverOut = Bun.file(SERVER_LOG);
  const serverErr = Bun.file(SERVER_ERR);
  await rm(SERVER_LOG, { force: true });
  await rm(SERVER_ERR, { force: true });

  const serverProcess = Bun.spawn(["bun", "apps/cli/src/index.ts", "serve", "--host", "127.0.0.1", "--port", "7878"], {
    cwd: ROOT,
    stdout: serverOut,
    stderr: serverErr
  });

  try {
    await waitServerHealthy();

    await Bun.$`open -na "Google Chrome" --args --disable-extensions-except=${EXTENSION_DIST} --load-extension=${EXTENSION_DIST} --user-data-dir=${CHROME_PROFILE_ROOT} https://github.com/new`;

    await waitExtensionConnected();
    const remote = await waitGithubPage();
    const pageId = remote.pageId;

    const syncedNew = await waitForNewRepoSnapshot(pageId);
    const pull = await postJson<PullResponse>("/pull", { pageId });
    await writeFile(join(LOG_DIR, "state-before-create.xml"), pull.xml, "utf8");

    const edits: ApplyRequest["edits"] = [];
    const has = (id: string): boolean => pull.files.some((f) => f.id === id);

    if (!has("github.repo.new.name")) {
      throw new Error("Missing github.repo.new.name editable node; GitHub plugin not applied");
    }

    edits.push({ id: "github.repo.new.name", value: REPO_NAME });
    if (has("github.repo.new.description")) {
      edits.push({ id: "github.repo.new.description", value: REPO_DESCRIPTION });
    }
    if (has("github.repo.new.visibility.public")) {
      edits.push({ id: "github.repo.new.visibility.public", value: REPO_VISIBILITY === "public" });
    }
    if (has("github.repo.new.visibility.private")) {
      edits.push({ id: "github.repo.new.visibility.private", value: REPO_VISIBILITY === "private" });
    }
    if (has("github.repo.new.auto_init")) {
      edits.push({ id: "github.repo.new.auto_init", value: AUTO_INIT });
    }

    const apply = await postJson<ApplyResponse>("/apply", {
      pageId,
      baseRev: pull.rev,
      edits
    } satisfies ApplyRequest);

    await postJson<CallResponse>("/call", {
      pageId,
      baseRev: apply.rev,
      target: { id: "github.repo.new.submit" },
      fn: "click",
      args: {}
    } satisfies CallRequest);

    const repoInfo = await waitRepositoryUrl(REPO_NAME);

    const syncedAfter = await postJson<UpsertSnapshotRequest & { rev: number }>("/sync/page", { pageId });
    const pullAfter = await postJson<PullResponse>("/pull", { pageId });
    await writeFile(join(LOG_DIR, "state-after-create.xml"), pullAfter.xml, "utf8");

    const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`;

    const remotes = (await Bun.$`git remote`.quiet().text()).split(/\r?\n/).filter(Boolean);
    if (remotes.includes("origin")) {
      await Bun.$`git remote set-url origin ${repoUrl}`;
    } else {
      await Bun.$`git remote add origin ${repoUrl}`;
    }

    await Bun.$`git push -u origin main`;

    const summary = {
      ok: true,
      pageId,
      pageTypeBefore: syncedNew.pageType,
      pageTypeAfter: syncedAfter.pageType,
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      repoUrl,
      url: repoInfo.url,
      logDir: LOG_DIR
    };

    await writeFile(join(LOG_DIR, "result.json"), JSON.stringify(summary, null, 2), "utf8");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await writeFile(OPS_LOG, JSON.stringify(opLog, null, 2), "utf8");
    serverProcess.kill();
  }
}

await main();
