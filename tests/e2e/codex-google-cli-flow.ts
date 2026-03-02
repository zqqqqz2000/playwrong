import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import type { RemotePageInfo, SemanticNode, UpsertSnapshotRequest } from "../../packages/protocol/src/index";
import {
  allocateFreePort,
  configureExtensionBridgeEndpoint,
  httpBaseToWsUrl,
  startIsolatedBridgeServer,
  waitForExtensionConnection
} from "./support/isolated-bridge";

type E2EMode = "google-like" | "real-google";

interface CodexAssessment {
  usedSkill: boolean;
  usedGoogleAbstraction: boolean;
  pageType: string;
  resultCount: number;
  nextActionId: string;
  evidence: string[];
  issues: string[];
}

const ROOT = process.env.PLAYWRONG_E2E_ROOT || resolve(join(import.meta.dir, "../.."));
const EXTENSION_DIST = join(ROOT, "apps/extension/dist");
const USER_DATA_DIR = join(ROOT, "tmp/e2e/codex-google-user-data");
const FIXTURE_PATH = join(ROOT, "tests/fixtures/google-like.html");
const BRIDGE_STATE_DIR = join(ROOT, ".bridge-e2e-google/codex-cli");
const EXTERNAL_ENDPOINT = process.env.PLAYWRONG_E2E_ENDPOINT?.trim();

const MODE: E2EMode = process.env.PLAYWRONG_E2E_TARGET === "real-google" ? "real-google" : "google-like";
const REAL_GOOGLE_URL = process.env.PLAYWRONG_REAL_GOOGLE_URL || "https://www.google.com/ncr?hl=en";
const SEARCH_QUERY = process.env.PLAYWRONG_CODEX_QUERY || "playwrong llm automation";
const CODEX_TIMEOUT_MS = Number(process.env.PLAYWRONG_CODEX_TIMEOUT_MS || "240000");

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
      // continue
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
      throw new Error("Google anti-bot page detected; cannot complete strict real Codex E2E in this run");
    }

    if (/google\./i.test(state.host) && state.hasSearchField) {
      return;
    }

    await page.goto(REAL_GOOGLE_URL, { waitUntil: "domcontentloaded" });
    await wait(800);
  }

  throw new Error("Cannot reach a valid Google page with editable search box");
}

async function runCodexSearch(input: {
  endpoint: string;
  pageId: string;
  query: string;
  logDir: string;
}): Promise<{
  assessment: CodexAssessment;
  commandOutputs: string;
  commandLines: string[];
}> {
  await mkdir(input.logDir, { recursive: true });

  const schemaPath = join(input.logDir, "codex-output-schema.json");
  const lastMessagePath = join(input.logDir, "codex-last-message.json");
  const rawStdoutPath = join(input.logDir, "codex-stdout.log");
  const rawStderrPath = join(input.logDir, "codex-stderr.log");

  const schema = {
    type: "object",
    properties: {
      usedSkill: { type: "boolean" },
      usedGoogleAbstraction: { type: "boolean" },
      pageType: { type: "string" },
      resultCount: { type: "number" },
      nextActionId: { type: "string" },
      evidence: {
        type: "array",
        items: { type: "string" }
      },
      issues: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["usedSkill", "usedGoogleAbstraction", "pageType", "resultCount", "nextActionId", "evidence", "issues"],
    additionalProperties: false
  };
  await writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");

  const fastpathOutDir = join(input.logDir, "fastpath-run");
  const prompt = [
    "你在 Playwrong 仓库根目录。",
    "这是 E2E 测试，不要修改代码。",
    "必须使用 skill 文件：skills/playwrong-google-search-fastpath/SKILL.md。",
    "只执行 skill 的快路径命令，不要做额外探索。",
    `执行命令：bun skills/playwrong-google-search-fastpath/scripts/google_search_fastpath.ts --endpoint ${input.endpoint} --pageId ${input.pageId} --query \"${input.query}\" --outDir ${fastpathOutDir}`,
    "从命令日志提取证据，并判断是否使用了 google.search 抽象。",
    "最后仅按 schema 输出 JSON，issues 没有问题就返回空数组。"
  ].join("\n");

  const proc = Bun.spawn(
    [
      "codex",
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--cd",
      ROOT,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      lastMessagePath,
      prompt
    ],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe"
    }
  );

  const timeout = setTimeout(() => {
    proc.kill();
  }, CODEX_TIMEOUT_MS);

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  await writeFile(rawStdoutPath, stdout, "utf8");
  await writeFile(rawStderrPath, stderr, "utf8");

  if (exitCode !== 0) {
    throw new Error(`codex exec failed: exit=${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const events = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type?: string;
          item?: { type?: string; command?: string; aggregated_output?: string };
        };
      } catch {
        return null;
      }
    })
    .filter((value): value is { type?: string; item?: { type?: string; command?: string; aggregated_output?: string } } =>
      Boolean(value)
    );

  const commandEvents = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution");
  const commandOutputs = commandEvents
    .map((event) => event.item?.aggregated_output ?? "")
    .filter(Boolean)
    .join("\n");
  const commandLines = commandEvents.map((event) => event.item?.command ?? "").filter(Boolean);

  const lastMessageRaw = await readFile(lastMessagePath, "utf8");
  const assessment = JSON.parse(lastMessageRaw) as CodexAssessment;

  return {
    assessment,
    commandOutputs,
    commandLines
  };
}

async function main(): Promise<void> {
  await rm(USER_DATA_DIR, { recursive: true, force: true });
  await rm(BRIDGE_STATE_DIR, { recursive: true, force: true });
  await mkdir(join(ROOT, "tmp/e2e"), { recursive: true });
  await mkdir(BRIDGE_STATE_DIR, { recursive: true });

  await Bun.$`bun run --cwd ${join(ROOT, "apps/extension")} build`.quiet();

  let fixtureServer: ReturnType<typeof Bun.serve> | null = null;
  let fixtureBaseUrl = "";
  if (MODE === "google-like") {
    const fixturePort = await allocateFreePort("127.0.0.1");
    fixtureBaseUrl = `http://127.0.0.1:${fixturePort}`;
    fixtureServer = Bun.serve({
      hostname: "127.0.0.1",
      port: fixturePort,
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

  let bridgeBaseUrl = EXTERNAL_ENDPOINT ?? "";
  let bridgeWsUrl = "";
  const isolatedBridge = EXTERNAL_ENDPOINT ? null : await startIsolatedBridgeServer("127.0.0.1");
  if (isolatedBridge) {
    bridgeBaseUrl = isolatedBridge.baseUrl;
    bridgeWsUrl = isolatedBridge.wsUrl;
  } else {
    const health = await fetch(new URL("/health", bridgeBaseUrl)).catch(() => null);
    if (!health || !health.ok) {
      throw new Error(`Cannot use external bridge server at ${bridgeBaseUrl}`);
    }
    bridgeWsUrl = httpBaseToWsUrl(bridgeBaseUrl);
  }

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

    await configureExtensionBridgeEndpoint(context, bridgeWsUrl);
    await waitForExtensionConnection(bridgeBaseUrl, 30_000);

    const page = await context.newPage();
    if (MODE === "google-like") {
      await page.goto(`${fixtureBaseUrl}/google-like.html`, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(REAL_GOOGLE_URL, { waitUntil: "domcontentloaded" });
      await ensureRealGoogleReady(page);
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await wait(500);
    if (MODE === "real-google") {
      await ensureRealGoogleReady(page);
    }

    const remotePages = await getJson<{ pages: RemotePageInfo[] }>(bridgeBaseUrl, "/pages/remote");
    const currentUrl = page.url();
    const remotePage =
      remotePages.pages.find((p) => p.active && p.url === currentUrl) ??
      remotePages.pages.find((p) => p.url === currentUrl) ??
      remotePages.pages.find((p) => p.active && pageLooksLikeTarget(p.url, MODE)) ??
      remotePages.pages.find((p) => pageLooksLikeTarget(p.url, MODE));

    const pageId = assertTruthy(remotePage?.pageId, `Cannot find target page for mode=${MODE}`);

    const codexRun = await runCodexSearch({
      endpoint: bridgeBaseUrl,
      pageId,
      query: SEARCH_QUERY,
      logDir: join(BRIDGE_STATE_DIR, "codex")
    });

    if (!codexRun.commandLines.some((line) => line.includes("skills/playwrong-google-search-fastpath/scripts/google_search_fastpath.ts"))) {
      throw new Error("Codex did not run the fastpath script command from skill");
    }

    const hasPageTypeEvidence =
      codexRun.commandOutputs.includes("FASTPATH_PAGE_TYPE=google.search") ||
      codexRun.commandOutputs.includes("\"pageType\": \"google.search\"");
    if (!hasPageTypeEvidence) {
      throw new Error("Missing log evidence: google.search page type");
    }

    if (!codexRun.commandOutputs.includes("FASTPATH_RESULT_IDS=") || !codexRun.commandOutputs.includes("search.result.")) {
      throw new Error("Missing log evidence: search result action ids");
    }

    if (!codexRun.commandOutputs.includes("FASTPATH_NEXT_ACTION=search.pagination.next")) {
      throw new Error("Missing log evidence: pagination next action");
    }

    const assessment = codexRun.assessment;
    if (assessment.pageType && assessment.pageType !== "google.search") {
      throw new Error(`Expected assessment.pageType=google.search, got ${assessment.pageType}`);
    }
    if (Number.isFinite(assessment.resultCount) && assessment.resultCount > 0 && assessment.resultCount < 3) {
      throw new Error(`Expected assessment.resultCount>=3, got ${assessment.resultCount}`);
    }
    if (assessment.nextActionId && assessment.nextActionId !== "search.pagination.next") {
      throw new Error(`Expected nextActionId=search.pagination.next, got ${assessment.nextActionId}`);
    }

    const syncedAfter = await postJson<UpsertSnapshotRequest & { rev: number }>(bridgeBaseUrl, "/sync/page", { pageId });
    const resultIdsAfter = collectActionIds(syncedAfter.tree, (id) => /^search\.result\.\d+\.open$/.test(id));
    const nextAfter = collectActionIds(syncedAfter.tree, (id) => id === "search.pagination.next")[0] ?? "";

    if (resultIdsAfter.length < 3) {
      throw new Error(`Framework verification failed: expected >=3 results, got ${resultIdsAfter.length}`);
    }
    if (!nextAfter) {
      throw new Error("Framework verification failed: missing search.pagination.next");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: MODE,
          pageId,
          query: SEARCH_QUERY,
          pageType: syncedAfter.pageType,
          resultCount: resultIdsAfter.length,
          nextActionId: nextAfter,
          codexIssues: assessment.issues,
          codexEvidence: assessment.evidence
        },
        null,
        2
      )
    );
  } finally {
    if (context) {
      await context.close();
    }
    isolatedBridge?.stop();
    fixtureServer?.stop(true);
  }
}

await main();
