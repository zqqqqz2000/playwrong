import type { LocatorSpec, ScalarValue } from "@playwrong/protocol";

export interface RuntimePluginPackPayload {
  pluginId: string;
  name: string;
  version: string;
  updatedAt: string;
  moduleUrl?: string;
}

export type ContentBridgeRequest =
  | {
      type: "playwrong.ping";
    }
  | {
      type: "bridge.extract";
      runtimePluginPacks?: RuntimePluginPackPayload[];
    }
  | {
      type: "bridge.setValue";
      target: { id: string; path?: string[] };
      locator?: LocatorSpec;
      value: ScalarValue;
      runtimePluginPacks?: RuntimePluginPackPayload[];
    }
  | {
      type: "bridge.call";
      target: { id: string; path?: string[] };
      locator?: LocatorSpec;
      fn: string;
      args?: Record<string, unknown>;
      runtimePluginPacks?: RuntimePluginPackPayload[];
    };

export interface ContentBridgeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ContentBridgeResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: ContentBridgeError };
