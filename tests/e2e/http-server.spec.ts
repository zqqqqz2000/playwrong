import { afterEach, describe, expect, it } from "bun:test";
import { ExtensionGateway, startBridgeHttpServer } from "../../apps/server/src/index";
import type {
  ApplyRequest,
  CallRequest,
  PullResponse,
  RemoteCallParams,
  RemoteExtractResult,
  RemotePageInfo,
  RemoteScreenshotResult,
  RemoteSetValueParams
} from "../../packages/protocol/src/index";

class FakeExtensionGateway extends ExtensionGateway {
  readonly setOps: RemoteSetValueParams[] = [];
  readonly callOps: RemoteCallParams[] = [];

  constructor() {
    super({ requestTimeoutMs: 20 });
  }

  override isConnected(): boolean {
    return true;
  }

  override async listPages(): Promise<RemotePageInfo[]> {
    return [
      {
        pageId: "tab:1",
        url: "https://example.com/login",
        title: "Login",
        active: true
      }
    ];
  }

  override async extractPage(pageId: string): Promise<RemoteExtractResult> {
    return {
      pageId,
      pageType: "login",
      tree: [
        {
          id: "login.form",
          kind: "form",
          children: [
            { id: "login.email", kind: "editable", value: "" },
            { id: "login.submit", kind: "action", calls: [{ name: "click", sideEffect: true }] }
          ]
        }
      ],
      pageCalls: [{ name: "refresh", sideEffect: true }],
      url: "https://example.com/login",
      title: "Login"
    };
  }

  override async setValue(input: RemoteSetValueParams): Promise<void> {
    this.setOps.push(input);
  }

  override async call(input: RemoteCallParams): Promise<unknown> {
    this.callOps.push(input);
    return { done: true };
  }

  override async captureScreenshot(_pageId: string): Promise<RemoteScreenshotResult | null> {
    return {
      mimeType: "image/png",
      encoding: "base64",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII="
    };
  }
}

const servers: Array<ReturnType<typeof startBridgeHttpServer>["server"]> = [];

afterEach(() => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      server.stop(true);
    }
  }
});

async function postJson<T>(baseUrl: string, pathname: string, payload: unknown): Promise<T> {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = (await response.json()) as T;
  if (!response.ok) {
    throw new Error(JSON.stringify(body));
  }
  return body;
}

describe("HTTP server with extension gateway", () => {
  it("supports sync -> pull -> apply -> call end-to-end", async () => {
    const gateway = new FakeExtensionGateway();
    const started = startBridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      extensionGateway: gateway
    });
    servers.push(started.server);
    const baseUrl = started.server.url.toString();

    const synced = await postJson<{ pageId: string; rev: number }>(baseUrl, "/sync/page", {
      pageId: "tab:1"
    });
    expect(synced.pageId).toBe("tab:1");
    expect(synced.rev).toBe(1);

    const pull = await postJson<PullResponse>(baseUrl, "/pull", { pageId: "tab:1" });
    expect(pull.rev).toBe(1);
    expect(pull.xml).toContain("login.email");
    expect(pull.screenshot?.mimeType).toBe("image/png");

    const applyPayload: ApplyRequest = {
      pageId: "tab:1",
      baseRev: pull.rev,
      edits: [{ id: "login.email", value: "qa@example.com" }]
    };
    const apply = await postJson<{ rev: number; updatedIds: string[] }>(baseUrl, "/apply", applyPayload);
    expect(apply.rev).toBe(2);
    expect(apply.updatedIds).toEqual(["login.email"]);
    expect(gateway.setOps).toHaveLength(1);

    const callPayload: CallRequest = {
      pageId: "tab:1",
      baseRev: apply.rev,
      target: { id: "login.submit" },
      fn: "click"
    };
    const call = await postJson<{ rev: number; output?: unknown }>(baseUrl, "/call", callPayload);
    expect(call.rev).toBe(3);
    expect(gateway.callOps).toHaveLength(1);
  });

  it("sync-all pulls all remote pages", async () => {
    const gateway = new FakeExtensionGateway();
    const started = startBridgeHttpServer({
      host: "127.0.0.1",
      port: 0,
      extensionGateway: gateway
    });
    servers.push(started.server);
    const baseUrl = started.server.url.toString();

    const result = await postJson<{ count: number; synced: Array<{ pageId: string }> }>(
      baseUrl,
      "/sync/all",
      {}
    );
    expect(result.count).toBe(1);
    expect(result.synced[0]?.pageId).toBe("tab:1");
  });
});
