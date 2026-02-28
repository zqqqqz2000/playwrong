import { describe, expect, it } from "bun:test";
import { BridgeCore, type ExecutionBridge } from "../../apps/server/src/index";
import type { LocatorSpec, ScalarValue } from "../../packages/protocol/src/index";

class RecorderBridge implements ExecutionBridge {
  readonly setOps: Array<{ id: string; value: ScalarValue }> = [];
  readonly callOps: Array<{ id: string; fn: string }> = [];

  async setValue(input: {
    pageId: string;
    target: { id: string; path?: string[] };
    locator?: LocatorSpec;
    value: ScalarValue;
  }): Promise<void> {
    this.setOps.push({ id: input.target.id, value: input.value });
  }

  async call(input: {
    pageId: string;
    target: { id: string; path?: string[] };
    locator?: LocatorSpec;
    fn: string;
    args?: Record<string, unknown>;
  }): Promise<unknown> {
    this.callOps.push({ id: input.target.id, fn: input.fn });
    return { ok: true };
  }
}

function makeTree() {
  return [
    {
      id: "login.form",
      kind: "form" as const,
      children: [
        { id: "login.email", kind: "editable" as const, value: "" },
        { id: "login.password", kind: "editable" as const, value: "" },
        {
          id: "login.submit",
          kind: "action" as const,
          calls: [{ name: "click", sideEffect: true }]
        }
      ]
    }
  ];
}

describe("BridgeCore", () => {
  it("pull/apply/call flow", async () => {
    const core = new BridgeCore();
    const bridge = new RecorderBridge();

    core.upsertSnapshot({
      pageId: "p1",
      pageType: "login",
      tree: makeTree(),
      pageCalls: [{ name: "refresh", sideEffect: true }]
    });

    const pull1 = core.pull({ pageId: "p1" });
    expect(pull1.rev).toBe(1);
    expect(pull1.xml).toContain("<form id=\"login.form\">");

    const apply = await core.apply(
      {
        pageId: "p1",
        baseRev: pull1.rev,
        edits: [{ id: "login.email", value: "a@b.com" }]
      },
      bridge
    );
    expect(apply.rev).toBe(2);
    expect(bridge.setOps).toHaveLength(1);

    const call = await core.call(
      {
        pageId: "p1",
        baseRev: apply.rev,
        target: { id: "login.submit" },
        fn: "click"
      },
      bridge
    );
    expect(call.rev).toBe(3);
    expect(bridge.callOps).toHaveLength(1);
  });

  it("throws rev mismatch", async () => {
    const core = new BridgeCore();
    const bridge = new RecorderBridge();

    core.upsertSnapshot({ pageId: "p1", pageType: "login", tree: makeTree() });

    await expect(
      core.apply(
        {
          pageId: "p1",
          baseRev: 999,
          edits: [{ id: "login.email", value: "x" }]
        },
        bridge
      )
    ).rejects.toThrow("Revision mismatch");
  });

  it("rejects non-editable apply target", async () => {
    const core = new BridgeCore();
    const bridge = new RecorderBridge();

    core.upsertSnapshot({ pageId: "p1", pageType: "login", tree: makeTree() });

    await expect(
      core.apply(
        {
          pageId: "p1",
          baseRev: 1,
          edits: [{ id: "login.submit", value: "x" }]
        },
        bridge
      )
    ).rejects.toThrow("Node is not editable");
  });

  it("rejects undeclared function", async () => {
    const core = new BridgeCore();
    const bridge = new RecorderBridge();

    core.upsertSnapshot({ pageId: "p1", pageType: "login", tree: makeTree() });

    await expect(
      core.call(
        {
          pageId: "p1",
          baseRev: 1,
          target: { id: "login.submit" },
          fn: "hover"
        },
        bridge
      )
    ).rejects.toThrow("Function hover is not declared");
  });
});
