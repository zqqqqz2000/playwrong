import { describe, expect, it } from "bun:test";
import { ExtensionGateway, type ExtensionSocketLike } from "../../apps/server/src/index";

class FakeSocket implements ExtensionSocketLike {
  readonly sent: string[] = [];

  send(data: string): unknown {
    this.sent.push(data);
    return data.length;
  }
}

function lastRequest(socket: FakeSocket): { id: string; method: string } {
  const raw = socket.sent[socket.sent.length - 1];
  if (!raw) {
    throw new Error("No request sent");
  }
  const parsed = JSON.parse(raw) as { id: string; method: string };
  return {
    id: parsed.id,
    method: parsed.method
  };
}

describe("ExtensionGateway", () => {
  it("returns PLUGIN_MISS when no extension socket is connected", async () => {
    const gateway = new ExtensionGateway({ requestTimeoutMs: 30 });
    await expect(gateway.listPages()).rejects.toMatchObject({ code: "PLUGIN_MISS" });
  });

  it("sends rpc request and resolves with rpc response", async () => {
    const gateway = new ExtensionGateway({ requestTimeoutMs: 100 });
    const socket = new FakeSocket();
    gateway.attach(socket);

    const pending = gateway.listPages();
    const request = lastRequest(socket);
    expect(request.method).toBe("pages.list");

    gateway.handleIncoming(
      JSON.stringify({
        type: "rpc.response",
        id: request.id,
        ok: true,
        result: [{ pageId: "tab:11", url: "https://example.com" }]
      })
    );

    await expect(pending).resolves.toEqual([{ pageId: "tab:11", url: "https://example.com" }]);
  });

  it("maps extension error response to BridgeError", async () => {
    const gateway = new ExtensionGateway({ requestTimeoutMs: 100 });
    const socket = new FakeSocket();
    gateway.attach(socket);

    const pending = gateway.call({
      pageId: "tab:11",
      target: { id: "login.submit" },
      fn: "click"
    });
    const request = lastRequest(socket);
    expect(request.method).toBe("page.call");

    gateway.handleIncoming(
      JSON.stringify({
        type: "rpc.response",
        id: request.id,
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Target node missing"
        }
      })
    );

    await expect(pending).rejects.toMatchObject({ code: "NOT_FOUND", message: "Target node missing" });
  });

  it("times out pending requests", async () => {
    const gateway = new ExtensionGateway({ requestTimeoutMs: 10 });
    const socket = new FakeSocket();
    gateway.attach(socket);

    await expect(gateway.listPages()).rejects.toMatchObject({ code: "ACTION_FAIL" });
  });

  it("rejects pending requests when socket disconnects", async () => {
    const gateway = new ExtensionGateway({ requestTimeoutMs: 200 });
    const socket = new FakeSocket();
    gateway.attach(socket);

    const pending = gateway.listPages();
    gateway.detach(socket);

    await expect(pending).rejects.toMatchObject({ code: "PLUGIN_MISS" });
  });
});
