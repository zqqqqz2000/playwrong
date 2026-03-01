import {
  BridgeError,
  ERROR_HTTP_STATUS,
  toBridgeError,
  type ApplyRequest,
  type CallRequest,
  type PullRequest,
  type UpsertSnapshotRequest
} from "@playwrong/protocol";
import { BridgeCore, type ExecutionBridge } from "./core";
import { ExtensionGateway } from "./extension-gateway";
import { PluginManager } from "./plugin-manager";

export interface StartBridgeHttpServerOptions {
  host?: string;
  port?: number;
  core?: BridgeCore;
  executor?: ExecutionBridge;
  extensionGateway?: ExtensionGateway;
  pluginManager?: PluginManager;
}

interface SyncPageRequest {
  pageId: string;
}

interface InstallPluginRequest {
  sourceType?: "git" | "dir" | "zip";
  repoUrl?: string;
  path?: string;
  ref?: string;
  enabled?: boolean;
}

interface SetPluginEnabledRequest {
  pluginId: string;
  enabled: boolean;
}

interface UninstallPluginRequest {
  pluginId: string;
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function mapWsUrlToPageType(url: string | undefined): string {
  if (!url) {
    return "generic";
  }
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0];
    return first ? first.toLowerCase() : "index";
  } catch {
    return "generic";
  }
}

function isMappingPluginRoute(pathname: string, suffix = ""): boolean {
  return pathname === `/plugins${suffix}` || pathname === `/mapping-plugins${suffix}`;
}

export function startBridgeHttpServer(options: StartBridgeHttpServerOptions = {}): {
  server: ReturnType<typeof Bun.serve>;
  core: BridgeCore;
  extensionGateway: ExtensionGateway;
} {
  const core = options.core ?? new BridgeCore();
  const extensionGateway = options.extensionGateway ?? new ExtensionGateway();
  const pluginManager = options.pluginManager ?? new PluginManager();
  const executor = options.executor ?? extensionGateway;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 7878;

  const server = Bun.serve<{ clientId: string }>({
    hostname: host,
    port,
    fetch: async (request, serverRef) => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/ws/extension") {
        const upgraded = serverRef.upgrade(request, {
          data: { clientId: crypto.randomUUID() }
        });
        if (upgraded) {
          return;
        }
        return json(500, { error: { code: "INTERNAL_ERROR", message: "websocket upgrade failed" } });
      }

      try {
        if (request.method === "GET" && url.pathname === "/health") {
          return json(200, { ok: true });
        }

        if (request.method === "GET" && url.pathname === "/extension/status") {
          return json(200, { connected: extensionGateway.isConnected() });
        }

        if (request.method === "GET" && url.pathname === "/pages") {
          return json(200, { pages: core.listPages() });
        }

        if (request.method === "GET" && url.pathname === "/pages/remote") {
          const pages = await extensionGateway.listPages();
          return json(200, { pages });
        }

        if (request.method === "GET" && isMappingPluginRoute(url.pathname)) {
          const plugins = await pluginManager.listPlugins();
          return json(200, { plugins });
        }

        if (request.method === "POST" && isMappingPluginRoute(url.pathname, "/install")) {
          const payload = await readJson<InstallPluginRequest>(request);
          const plugin = await pluginManager.install(payload);
          return json(200, { plugin });
        }

        if (request.method === "POST" && isMappingPluginRoute(url.pathname, "/set-enabled")) {
          const payload = await readJson<SetPluginEnabledRequest>(request);
          if (!payload.pluginId || typeof payload.enabled !== "boolean") {
            throw new BridgeError("INVALID_REQUEST", "pluginId and enabled are required", {
              fields: ["pluginId", "enabled"]
            });
          }
          const plugin = await pluginManager.setPluginEnabled(payload.pluginId, payload.enabled);
          return json(200, { plugin });
        }

        if (request.method === "POST" && isMappingPluginRoute(url.pathname, "/uninstall")) {
          const payload = await readJson<UninstallPluginRequest>(request);
          if (!payload.pluginId) {
            throw new BridgeError("INVALID_REQUEST", "pluginId is required", {
              field: "pluginId"
            });
          }
          await pluginManager.uninstallPlugin(payload.pluginId);
          return json(200, { ok: true, pluginId: payload.pluginId });
        }

        if (request.method === "POST" && isMappingPluginRoute(url.pathname, "/generate")) {
          const generated = await pluginManager.generateManagedPluginsFile();
          return json(200, { generated });
        }

        if (
          request.method === "POST" &&
          (isMappingPluginRoute(url.pathname, "/apply") || isMappingPluginRoute(url.pathname, "/reload"))
        ) {
          const output = await pluginManager.applyPluginsToExtensionBuild();
          return json(200, output);
        }

        if (request.method === "POST" && url.pathname === "/snapshot/upsert") {
          const payload = await readJson<UpsertSnapshotRequest>(request);
          return json(200, core.upsertSnapshot(payload));
        }

        if (request.method === "POST" && url.pathname === "/sync/page") {
          const payload = await readJson<SyncPageRequest>(request);
          if (!payload.pageId) {
            return json(400, { error: { code: "INVALID_REQUEST", message: "pageId is required" } });
          }

          const extracted = await extensionGateway.extractPage(payload.pageId);
          const upsertPayload: UpsertSnapshotRequest = {
            pageId: extracted.pageId,
            pageType: extracted.pageType || mapWsUrlToPageType(extracted.url),
            tree: extracted.tree
          };
          if (extracted.pageCalls) {
            upsertPayload.pageCalls = extracted.pageCalls;
          }
          if (extracted.url !== undefined) {
            upsertPayload.url = extracted.url;
          }
          if (extracted.title !== undefined) {
            upsertPayload.title = extracted.title;
          }

          const snapshot = core.upsertSnapshot(upsertPayload);
          return json(200, snapshot);
        }

        if (request.method === "POST" && url.pathname === "/sync/all") {
          const remotePages = await extensionGateway.listPages();
          const synced: Array<{ pageId: string; rev: number; pageType: string }> = [];

          for (const remote of remotePages) {
            const extracted = await extensionGateway.extractPage(remote.pageId);
            const upsertPayload: UpsertSnapshotRequest = {
              pageId: extracted.pageId,
              pageType: extracted.pageType || mapWsUrlToPageType(extracted.url ?? remote.url),
              tree: extracted.tree
            };
            if (extracted.pageCalls) {
              upsertPayload.pageCalls = extracted.pageCalls;
            }
            const resolvedUrl = extracted.url ?? remote.url;
            if (resolvedUrl !== undefined) {
              upsertPayload.url = resolvedUrl;
            }
            const resolvedTitle = extracted.title ?? remote.title;
            if (resolvedTitle !== undefined) {
              upsertPayload.title = resolvedTitle;
            }

            const snapshot = core.upsertSnapshot(upsertPayload);
            synced.push({
              pageId: snapshot.pageId,
              rev: snapshot.rev,
              pageType: snapshot.pageType
            });
          }

          return json(200, { count: synced.length, synced });
        }

        if (request.method === "POST" && url.pathname === "/pull") {
          const payload = await readJson<PullRequest>(request);
          const response = core.pull(payload);
          if (extensionGateway.isConnected()) {
            try {
              const screenshot = await extensionGateway.captureScreenshot(payload.pageId);
              if (screenshot) {
                response.screenshot = screenshot;
              }
            } catch {
              // screenshot is best effort and must not break pull
            }
          }
          return json(200, response);
        }

        if (request.method === "POST" && url.pathname === "/apply") {
          const payload = await readJson<ApplyRequest>(request);
          return json(200, await core.apply(payload, executor));
        }

        if (request.method === "POST" && url.pathname === "/call") {
          const payload = await readJson<CallRequest>(request);
          return json(200, await core.call(payload, executor));
        }

        return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
      } catch (error) {
        const bridgeError = toBridgeError(error);
        const status = ERROR_HTTP_STATUS[bridgeError.code] ?? 500;
        return json(status, { error: bridgeError.toJSON() });
      }
    },
    websocket: {
      open(ws) {
        extensionGateway.attach(ws);
      },
      message(_ws, message) {
        extensionGateway.handleIncoming(message);
      },
      close(ws) {
        extensionGateway.detach(ws);
      }
    }
  });

  return { server, core, extensionGateway };
}
