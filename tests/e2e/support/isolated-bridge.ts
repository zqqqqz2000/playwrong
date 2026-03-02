import { createServer } from "node:net";
import type { BrowserContext, Worker } from "playwright";
import { startBridgeHttpServer } from "../../../apps/server/src/http";

const EXTENSION_WS_STORAGE_KEY = "serverWsUrl";

export interface IsolatedBridgeServer {
  host: string;
  port: number;
  baseUrl: string;
  wsUrl: string;
  stop: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function allocateFreePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Cannot resolve an ephemeral port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export function httpBaseToWsUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws/extension";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export async function startIsolatedBridgeServer(host = "127.0.0.1"): Promise<IsolatedBridgeServer> {
  const port = await allocateFreePort(host);
  const started = startBridgeHttpServer({ host, port });
  const baseUrl = `http://${host}:${port}`;
  return {
    host,
    port,
    baseUrl,
    wsUrl: httpBaseToWsUrl(baseUrl),
    stop: () => {
      started.server.stop(true);
    }
  };
}

async function waitForExtensionServiceWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith("chrome-extension://"));
  if (existing) {
    return existing;
  }
  return await context.waitForEvent("serviceworker", {
    timeout: 20_000,
    predicate: (worker) => worker.url().startsWith("chrome-extension://")
  });
}

export async function configureExtensionBridgeEndpoint(context: BrowserContext, wsUrl: string): Promise<void> {
  const worker = await waitForExtensionServiceWorker(context);
  await worker.evaluate(
    async ({ key, value }) => {
      await chrome.storage.local.set({ [key]: value });
      return true;
    },
    {
      key: EXTENSION_WS_STORAGE_KEY,
      value: wsUrl
    }
  );
}

export async function waitForExtensionConnection(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(new URL("/extension/status", baseUrl));
      if (response.ok) {
        const body = (await response.json()) as { connected?: unknown };
        if (body.connected === true) {
          return;
        }
      }
    } catch {
      // keep polling
    }
    await sleep(100);
  }
  throw new Error(`Extension websocket not connected to ${baseUrl} within ${timeoutMs}ms`);
}
