import {
  BridgeError,
  type ErrorCode,
  type ExtensionRpcEnvelope,
  type ExtensionRpcFailureResponse,
  type ExtensionRpcMethod,
  type ExtensionRpcParamsByMethod,
  type ExtensionRpcRequest,
  type ExtensionRpcResponse,
  type ExtensionRpcResultByMethod,
  type RemoteCallParams,
  type RemoteExtractResult,
  type RemotePageInfo,
  type RemoteSetValueParams
} from "@playwrong/protocol";
import type { ExecutionBridge } from "./core";

export interface ExtensionSocketLike {
  send(data: string): unknown;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

const KNOWN_ERROR_CODES: ErrorCode[] = [
  "REV_MISMATCH",
  "NOT_FOUND",
  "AMBIGUOUS",
  "INVALID_REQUEST",
  "INVALID_TREE",
  "INVALID_NODE_KIND",
  "UNDECLARED_FUNCTION",
  "PLUGIN_MISS",
  "ACTION_FAIL",
  "INTERNAL_ERROR"
];

function isKnownErrorCode(value: string): value is ErrorCode {
  return KNOWN_ERROR_CODES.includes(value as ErrorCode);
}

function decodeMessage(message: string | Uint8Array | ArrayBuffer): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(message);
  }
  return new TextDecoder().decode(message);
}

export interface ExtensionGatewayOptions {
  requestTimeoutMs?: number;
  connectGracePeriodMs?: number;
}

export class ExtensionGateway implements ExecutionBridge {
  private socket: ExtensionSocketLike | null = null;
  private pending = new Map<string, PendingRpc>();
  private connectWaiters = new Set<() => void>();
  private seq = 0;
  private readonly requestTimeoutMs: number | null;
  private readonly connectGracePeriodMs: number;

  constructor(options: ExtensionGatewayOptions = {}) {
    const rawTimeout = options.requestTimeoutMs;
    if (rawTimeout === undefined || rawTimeout === null) {
      this.requestTimeoutMs = null;
    } else {
      const normalized = Math.trunc(rawTimeout);
      this.requestTimeoutMs = Number.isFinite(normalized) && normalized > 0 ? normalized : null;
    }
    const rawGrace = options.connectGracePeriodMs;
    if (rawGrace === undefined || rawGrace === null) {
      this.connectGracePeriodMs = 3000;
    } else {
      const normalized = Math.trunc(rawGrace);
      this.connectGracePeriodMs = Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
    }
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  attach(socket: ExtensionSocketLike): void {
    this.socket = socket;
    for (const notify of this.connectWaiters) {
      notify();
    }
    this.connectWaiters.clear();
  }

  detach(socket?: ExtensionSocketLike): void {
    if (socket && this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.rejectAllPending(new BridgeError("PLUGIN_MISS", "Extension disconnected"));
  }

  handleIncoming(message: string | Uint8Array | ArrayBuffer): void {
    let envelope: ExtensionRpcEnvelope;

    try {
      envelope = JSON.parse(decodeMessage(message)) as ExtensionRpcEnvelope;
    } catch {
      return;
    }

    if (envelope.type !== "rpc.response") {
      return;
    }

    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }

    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this.pending.delete(envelope.id);

    if (envelope.ok) {
      pending.resolve(envelope.result);
      return;
    }

    pending.reject(this.toBridgeError(envelope));
  }

  async listPages(): Promise<RemotePageInfo[]> {
    const result = await this.request("pages.list", {});
    if (!Array.isArray(result)) {
      throw new BridgeError("ACTION_FAIL", "Invalid pages.list response");
    }
    return result as RemotePageInfo[];
  }

  async extractPage(pageId: string): Promise<RemoteExtractResult> {
    const result = await this.request("page.extract", { pageId });
    if (!result || typeof result !== "object") {
      throw new BridgeError("ACTION_FAIL", "Invalid page.extract response");
    }
    return result as RemoteExtractResult;
  }

  async setValue(input: RemoteSetValueParams): Promise<void> {
    await this.request("page.setValue", input);
  }

  async call(input: RemoteCallParams): Promise<unknown> {
    const result = await this.request("page.call", input);
    if (result && typeof result === "object" && "output" in result) {
      return (result as { output?: unknown }).output;
    }
    return result;
  }

  async captureScreenshot(pageId: string): Promise<ExtensionRpcResultByMethod["page.screenshot"] | null> {
    if (!this.socket) {
      return null;
    }
    const result = await this.request("page.screenshot", { pageId });
    if (!result || typeof result !== "object") {
      throw new BridgeError("ACTION_FAIL", "Invalid page.screenshot response");
    }
    return result as ExtensionRpcResultByMethod["page.screenshot"];
  }

  async reloadExtension(): Promise<void> {
    const hadSocket = this.socket !== null;
    try {
      const result = await this.request("extension.reload", {});
      if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
        throw new BridgeError("ACTION_FAIL", "Invalid extension.reload response");
      }
    } catch (error) {
      if (hadSocket && error instanceof BridgeError && error.code === "PLUGIN_MISS") {
        // Extension can drop websocket immediately during self-reload before replying.
        return;
      }
      throw error;
    }
  }

  private async request<M extends ExtensionRpcMethod>(
    method: M,
    params: ExtensionRpcParamsByMethod[M]
  ): Promise<ExtensionRpcResultByMethod[M]> {
    let socket = this.socket;
    if (!socket) {
      const connected = await this.waitForConnection(this.connectGracePeriodMs);
      if (connected) {
        socket = this.socket;
      }
    }
    if (!socket) {
      throw new BridgeError("PLUGIN_MISS", "No extension is connected");
    }

    const id = this.nextId();
    const request: ExtensionRpcRequest<M> = {
      type: "rpc.request",
      id,
      method,
      params
    };

    const payload = JSON.stringify(request);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout =
        this.requestTimeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new BridgeError("ACTION_FAIL", `Extension request timed out: ${method}`));
            }, this.requestTimeoutMs);

      const pending: PendingRpc = { resolve, reject };
      if (timeout) {
        pending.timeout = timeout;
      }
      this.pending.set(id, pending);
    });

    try {
      socket.send(payload);
    } catch {
      this.pending.delete(id);
      throw new BridgeError("PLUGIN_MISS", "Failed to send command to extension");
    }

    const result = await promise;
    return result as ExtensionRpcResultByMethod[M];
  }

  private nextId(): string {
    this.seq += 1;
    return `rpc-${this.seq}`;
  }

  private toBridgeError(response: ExtensionRpcFailureResponse): BridgeError {
    const code = response.error.code;
    if (code && isKnownErrorCode(code)) {
      return new BridgeError(code, response.error.message, response.error.details);
    }
    return new BridgeError("ACTION_FAIL", response.error.message, response.error.details);
  }

  private rejectAllPending(error: BridgeError): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private async waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.socket) {
      return true;
    }
    if (timeoutMs <= 0) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const onAttach = () => {
        clearTimeout(timer);
        this.connectWaiters.delete(onAttach);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.connectWaiters.delete(onAttach);
        resolve(Boolean(this.socket));
      }, timeoutMs);
      this.connectWaiters.add(onAttach);
    });
  }
}
