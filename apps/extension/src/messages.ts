import type { LocatorSpec, ScalarValue } from "@playwrong/protocol";

export type ContentBridgeRequest =
  | {
      type: "playwrong.ping";
    }
  | {
      type: "bridge.extract";
    }
  | {
      type: "bridge.setValue";
      target: { id: string; path?: string[] };
      locator?: LocatorSpec;
      value: ScalarValue;
    }
  | {
      type: "bridge.call";
      target: { id: string; path?: string[] };
      locator?: LocatorSpec;
      fn: string;
      args?: Record<string, unknown>;
    };

export interface ContentBridgeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ContentBridgeResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: ContentBridgeError };
