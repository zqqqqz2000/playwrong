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
  timeout: ReturnType<typeof setTimeout>;
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
}

export class ExtensionGateway implements ExecutionBridge {
  private socket: ExtensionSocketLike | null = null;
  private pending = new Map<string, PendingRpc>();
  private seq = 0;
  private readonly requestTimeoutMs: number;

  constructor(options: ExtensionGatewayOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  attach(socket: ExtensionSocketLike): void {
    this.socket = socket;
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

    clearTimeout(pending.timeout);
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

  private async request<M extends ExtensionRpcMethod>(
    method: M,
    params: ExtensionRpcParamsByMethod[M]
  ): Promise<ExtensionRpcResultByMethod[M]> {
    const socket = this.socket;
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
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("ACTION_FAIL", `Extension request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
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
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
