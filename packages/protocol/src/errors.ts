export type ErrorCode =
  | "REV_MISMATCH"
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "INVALID_REQUEST"
  | "INVALID_TREE"
  | "INVALID_NODE_KIND"
  | "UNDECLARED_FUNCTION"
  | "PLUGIN_MISS"
  | "ACTION_FAIL"
  | "INTERNAL_ERROR";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  REV_MISMATCH: 409,
  NOT_FOUND: 404,
  AMBIGUOUS: 409,
  INVALID_REQUEST: 400,
  INVALID_TREE: 400,
  INVALID_NODE_KIND: 400,
  UNDECLARED_FUNCTION: 400,
  PLUGIN_MISS: 404,
  ACTION_FAIL: 422,
  INTERNAL_ERROR: 500
};

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    const payload: { code: ErrorCode; message: string; details?: Record<string, unknown> } = {
      code: this.code,
      message: this.message
    };
    if (this.details) {
      payload.details = this.details;
    }
    return payload;
  }
}

export function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  return new BridgeError("INTERNAL_ERROR", "Unexpected internal error");
}
