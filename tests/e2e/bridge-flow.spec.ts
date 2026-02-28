import { describe, expect, it } from "bun:test";
import { BridgeCore, type ExecutionBridge } from "../../apps/server/src/index";
import type { LocatorSpec, ScalarValue } from "../../packages/protocol/src/index";

class E2EBridge implements ExecutionBridge {
  setCount = 0;
  callCount = 0;

  async setValue(input: {
    pageId: string;
    target: { id: string; path?: string[] };
    locator?: LocatorSpec;
    value: ScalarValue;
  }): Promise<void> {
    this.setCount += 1;
  }

  async call(input: {
    pageId: string;
    target: { id: string; path?: string[] };
    locator?: LocatorSpec;
    fn: string;
    args?: Record<string, unknown>;
  }): Promise<unknown> {
    this.callCount += 1;
    return { done: true, fn: input.fn };
  }
}

describe("E2E bridge core", () => {
  it("supports pull -> apply -> call", async () => {
    const core = new BridgeCore();
    const bridge = new E2EBridge();

    core.upsertSnapshot({
      pageId: "p-login",
      pageType: "login",
      tree: [
        {
          id: "login.form",
          kind: "form",
          children: [
            { id: "login.email", kind: "editable", value: "" },
            { id: "login.password", kind: "editable", value: "" },
            { id: "login.submit", kind: "action", calls: [{ name: "click", sideEffect: true }] }
          ]
        }
      ]
    });

    const pull = core.pull({ pageId: "p-login" });
    expect(pull.rev).toBe(1);

    const apply = await core.apply(
      {
        pageId: "p-login",
        baseRev: pull.rev,
        edits: [
          { id: "login.email", value: "bot@example.com" },
          { id: "login.password", value: "123456" }
        ]
      },
      bridge
    );
    expect(apply.rev).toBe(2);
    expect(bridge.setCount).toBe(2);

    const call = await core.call(
      {
        pageId: "p-login",
        baseRev: apply.rev,
        target: { id: "login.submit" },
        fn: "click"
      },
      bridge
    );
    expect(call.rev).toBe(3);
    expect(bridge.callCount).toBe(1);
  });

  it("requires repull after rev mismatch", async () => {
    const core = new BridgeCore();
    const bridge = new E2EBridge();

    core.upsertSnapshot({
      pageId: "p1",
      pageType: "simple",
      tree: [{ id: "a", kind: "editable", value: "" }]
    });

    const pull = core.pull({ pageId: "p1" });
    await core.apply({ pageId: "p1", baseRev: pull.rev, edits: [{ id: "a", value: "1" }] }, bridge);

    await expect(
      core.apply({ pageId: "p1", baseRev: pull.rev, edits: [{ id: "a", value: "2" }] }, bridge)
    ).rejects.toThrow("Revision mismatch");
  });
});
