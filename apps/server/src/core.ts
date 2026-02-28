import {
  BridgeError,
  assertUniqueNodeIds,
  findNodeById,
  isEditableKind,
  renderPageXml,
  type ApplyRequest,
  type ApplyResponse,
  type CallRequest,
  type CallResponse,
  type LocatorSpec,
  type PageSnapshot,
  type PullRequest,
  type PullResponse,
  type ScalarValue,
  type UpsertSnapshotRequest
} from "@playwrong/protocol";
import { projectPullFiles } from "./projection";

export interface ExecutionBridge {
  setValue(input: {
    pageId: string;
    target: { id: string; path?: string[] };
    locator?: LocatorSpec;
    value: ScalarValue;
  }): Promise<void>;

  call(input: {
    pageId: string;
    target: { id: string; path?: string[] };
    locator?: LocatorSpec;
    fn: string;
    args?: Record<string, unknown>;
  }): Promise<unknown>;
}

export class NoopExecutionBridge implements ExecutionBridge {
  async setValue(): Promise<void> {}
  async call(): Promise<unknown> {
    return null;
  }
}

export class BridgeCore {
  private readonly snapshots = new Map<string, PageSnapshot>();

  upsertSnapshot(input: UpsertSnapshotRequest): PageSnapshot {
    assertUniqueNodeIds(input.tree);

    const prev = this.snapshots.get(input.pageId);
    const snapshot: PageSnapshot = {
      pageId: input.pageId,
      pageType: input.pageType,
      rev: prev ? prev.rev + 1 : 1,
      tree: structuredClone(input.tree),
      updatedAt: Date.now()
    };
    if (input.pageCalls) {
      snapshot.pageCalls = structuredClone(input.pageCalls);
    }
    if (input.url !== undefined) {
      snapshot.url = input.url;
    }
    if (input.title !== undefined) {
      snapshot.title = input.title;
    }

    this.snapshots.set(snapshot.pageId, snapshot);
    return structuredClone(snapshot);
  }

  listPages(): Array<{ pageId: string; rev: number; pageType: string; url?: string; title?: string }> {
    return Array.from(this.snapshots.values()).map((s) => {
      const result: { pageId: string; rev: number; pageType: string; url?: string; title?: string } =
        {
          pageId: s.pageId,
          rev: s.rev,
          pageType: s.pageType
        };
      if (s.url !== undefined) {
        result.url = s.url;
      }
      if (s.title !== undefined) {
        result.title = s.title;
      }
      return result;
    });
  }

  pull(input: PullRequest): PullResponse {
    const snapshot = this.requireSnapshot(input.pageId);
    return {
      pageId: snapshot.pageId,
      rev: snapshot.rev,
      xml: renderPageXml(snapshot),
      files: projectPullFiles(snapshot.pageId, snapshot.tree)
    };
  }

  async apply(input: ApplyRequest, executor: ExecutionBridge): Promise<ApplyResponse> {
    const snapshot = this.requireSnapshot(input.pageId);
    this.ensureRev(snapshot, input.baseRev);

    const updatedIds: string[] = [];

    for (const edit of input.edits) {
      const node = findNodeById(snapshot.tree, edit.id);
      if (!node) {
        throw new BridgeError("NOT_FOUND", `Node not found: ${edit.id}`, { id: edit.id });
      }
      if (!isEditableKind(node.kind)) {
        throw new BridgeError("INVALID_NODE_KIND", `Node is not editable: ${edit.id}`, {
          id: edit.id,
          kind: node.kind
        });
      }

      const target: { id: string; path?: string[] } = edit.path
        ? { id: edit.id, path: edit.path }
        : { id: edit.id };
      const setInput: Parameters<ExecutionBridge["setValue"]>[0] = {
        pageId: snapshot.pageId,
        target,
        value: edit.value
      };
      if (node.locator) {
        setInput.locator = node.locator;
      }

      await executor.setValue(setInput);

      node.value = edit.value;
      updatedIds.push(edit.id);
    }

    if (updatedIds.length > 0) {
      snapshot.rev += 1;
      snapshot.updatedAt = Date.now();
    }

    return {
      pageId: snapshot.pageId,
      rev: snapshot.rev,
      updatedIds
    };
  }

  async call(input: CallRequest, executor: ExecutionBridge): Promise<CallResponse> {
    const snapshot = this.requireSnapshot(input.pageId);
    this.ensureRev(snapshot, input.baseRev);

    let locator: LocatorSpec | undefined;
    let sideEffect = true;

    if (input.target.id === "page") {
      const callDef = snapshot.pageCalls?.find((c) => c.name === input.fn);
      if (!callDef) {
        throw new BridgeError("UNDECLARED_FUNCTION", `Undeclared page function: ${input.fn}`, {
          fn: input.fn
        });
      }
      sideEffect = callDef.sideEffect ?? true;
    } else {
      const node = findNodeById(snapshot.tree, input.target.id);
      if (!node) {
        throw new BridgeError("NOT_FOUND", `Node not found: ${input.target.id}`, {
          id: input.target.id
        });
      }

      const callDef = node.calls?.find((c) => c.name === input.fn);
      if (!callDef) {
        throw new BridgeError(
          "UNDECLARED_FUNCTION",
          `Function ${input.fn} is not declared on node ${input.target.id}`,
          { id: input.target.id, fn: input.fn }
        );
      }

      locator = node.locator;
      sideEffect = callDef.sideEffect ?? true;
    }

    const callInput: Parameters<ExecutionBridge["call"]>[0] = {
      pageId: snapshot.pageId,
      target: input.target,
      fn: input.fn
    };
    if (locator) {
      callInput.locator = locator;
    }
    if (input.args) {
      callInput.args = input.args;
    }
    const output = await executor.call(callInput);

    if (sideEffect) {
      snapshot.rev += 1;
      snapshot.updatedAt = Date.now();
    }

    return {
      pageId: snapshot.pageId,
      rev: snapshot.rev,
      output
    };
  }

  private requireSnapshot(pageId: string): PageSnapshot {
    const snapshot = this.snapshots.get(pageId);
    if (!snapshot) {
      throw new BridgeError("NOT_FOUND", `Page not found: ${pageId}`, { pageId });
    }
    return snapshot;
  }

  private ensureRev(snapshot: PageSnapshot, baseRev: number): void {
    if (snapshot.rev !== baseRev) {
      throw new BridgeError("REV_MISMATCH", "Revision mismatch, please pull again", {
        expectedRev: snapshot.rev,
        receivedRev: baseRev
      });
    }
  }
}
