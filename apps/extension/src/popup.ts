const DEFAULT_SERVER_HTTP_URL = "http://127.0.0.1:7878";
const DEFAULT_SERVER_WS_URL = "ws://127.0.0.1:7878/ws/extension";
const STORAGE_SERVER_WS_URL_KEY = "serverWsUrl";
const STORAGE_SERVER_HTTP_URL_KEY = "serverHttpUrl";
const EXTENSION_STATUS_RETRY_DELAYS_MS = [120, 260, 520] as const;

interface PluginScopeRule {
  hosts?: string[];
  paths?: string[];
}

interface PluginSourceGit {
  type: "git";
  repoUrl: string;
  ref?: string;
}

interface PluginSourceDirectory {
  type: "directory";
  path: string;
}

interface PluginSourceZip {
  type: "zip";
  path: string;
}

type PluginSource = PluginSourceGit | PluginSourceDirectory | PluginSourceZip;

interface InstalledPluginRecord {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  match: PluginScopeRule;
  enabled: boolean;
  source: PluginSource;
}

interface PluginListResponse {
  plugins: InstalledPluginRecord[];
}

interface PluginInstallResponse {
  plugin: InstalledPluginRecord;
}

interface PluginToggleResponse {
  plugin: InstalledPluginRecord;
}

interface PluginGenerateResponse {
  generated: {
    outputPath: string;
    pluginCount: number;
    enabledCount: number;
  };
}

interface PluginApplyResponse {
  generated: {
    outputPath: string;
    pluginCount: number;
    enabledCount: number;
  };
  build: {
    stdout: string;
    stderr: string;
  };
}

interface PluginUninstallResponse {
  ok: boolean;
  pluginId: string;
}

interface HealthResponse {
  ok: boolean;
}

interface ExtensionStatusResponse {
  connected: boolean;
}

interface WakeupResponse {
  ok: boolean;
  error?: string;
}

interface ConnectionState {
  endpoint: string;
  serverUp: boolean;
  extensionConnected: boolean;
  checkedAt: string;
  error?: string;
}

const refs = {
  endpointInput: document.querySelector<HTMLInputElement>("#endpointInput"),
  saveEndpointBtn: document.querySelector<HTMLButtonElement>("#saveEndpointBtn"),
  checkConnectionBtn: document.querySelector<HTMLButtonElement>("#checkConnectionBtn"),
  endpointMsg: document.querySelector<HTMLElement>("#endpointMsg"),
  connectionBadge: document.querySelector<HTMLElement>("#connectionBadge"),
  connectionDetail: document.querySelector<HTMLElement>("#connectionDetail"),
  repoUrlInput: document.querySelector<HTMLInputElement>("#repoUrl"),
  repoRefInput: document.querySelector<HTMLInputElement>("#repoRef"),
  repoEnabledInput: document.querySelector<HTMLInputElement>("#repoEnabled"),
  installBtn: document.querySelector<HTMLButtonElement>("#installBtn"),
  installMsg: document.querySelector<HTMLElement>("#installMsg"),
  refreshBtn: document.querySelector<HTMLButtonElement>("#refreshBtn"),
  generateBtn: document.querySelector<HTMLButtonElement>("#generateBtn"),
  applyBtn: document.querySelector<HTMLButtonElement>("#applyBtn"),
  globalMsg: document.querySelector<HTMLElement>("#globalMsg"),
  pluginList: document.querySelector<HTMLElement>("#pluginList"),
  rawOut: document.querySelector<HTMLElement>("#rawOut")
};

let lastConnectionState: ConnectionState | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let statusPollBusy = false;

function requireRef<T>(value: T | null, id: string): T {
  if (!value) {
    throw new Error(`Missing DOM element: ${id}`);
  }
  return value;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showMessage(node: HTMLElement, text: string, isError: boolean): void {
  node.className = isError ? "error" : "ok";
  node.textContent = text;
}

function normalizeHttpUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return DEFAULT_SERVER_HTTP_URL;
  }
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server endpoint must be http:// or https://");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function wsUrlToHttp(wsUrl: string): string {
  const parsed = new URL(wsUrl);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function httpUrlToWs(httpUrl: string): string {
  const parsed = new URL(httpUrl);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  parsed.pathname = "/ws/extension";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function loadServerEndpoint(): Promise<string> {
  const fromStorage = await chrome.storage.local.get([STORAGE_SERVER_HTTP_URL_KEY, STORAGE_SERVER_WS_URL_KEY]);

  const serverHttp = fromStorage[STORAGE_SERVER_HTTP_URL_KEY];
  if (typeof serverHttp === "string" && serverHttp.length > 0) {
    return normalizeHttpUrl(serverHttp);
  }

  const serverWs = fromStorage[STORAGE_SERVER_WS_URL_KEY];
  if (typeof serverWs === "string" && serverWs.length > 0) {
    return normalizeHttpUrl(wsUrlToHttp(serverWs));
  }

  return DEFAULT_SERVER_HTTP_URL;
}

async function saveServerEndpoint(endpoint: string): Promise<void> {
  const normalized = normalizeHttpUrl(endpoint);
  await chrome.storage.local.set({
    [STORAGE_SERVER_HTTP_URL_KEY]: normalized,
    [STORAGE_SERVER_WS_URL_KEY]: httpUrlToWs(normalized)
  });
}

async function requestJson<T>(endpoint: string, path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json" }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, `${endpoint}/`), init);
  } catch (error) {
    throw new Error(`Cannot reach ${endpoint}: ${formatError(error)}`);
  }

  const payload = (await response
    .json()
    .catch(() => ({ error: { message: `Invalid JSON response: ${response.status}` } }))) as {
    error?: { message?: string };
  } & T;

  if (!response.ok) {
    const message = payload.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function parseWakeupResponse(response: unknown): WakeupResponse | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const payload = response as { ok?: unknown; error?: unknown };
  if (typeof payload.ok !== "boolean") {
    return null;
  }
  const normalized: WakeupResponse = { ok: payload.ok };
  if (typeof payload.error === "string" && payload.error.length > 0) {
    normalized.error = payload.error;
  }
  return normalized;
}

async function wakeExtensionBridge(): Promise<string | undefined> {
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "playwrong.wakeup" }, (response: unknown) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          resolve(runtimeError.message || "Failed to wake extension background");
          return;
        }

        const wakeup = parseWakeupResponse(response);
        if (wakeup && !wakeup.ok) {
          resolve(wakeup.error || "Extension wakeup rejected");
          return;
        }
        resolve(undefined);
      });
    } catch (error) {
      resolve(formatError(error));
    }
  });
}

async function probeExtensionConnection(endpoint: string): Promise<{ connected: boolean; error?: string }> {
  let detail: string | undefined = await wakeExtensionBridge();

  for (let attempt = 0; attempt <= EXTENSION_STATUS_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      const delay = EXTENSION_STATUS_RETRY_DELAYS_MS[attempt - 1];
      if (delay === undefined) {
        continue;
      }
      await sleep(delay);
      const wakeError = await wakeExtensionBridge();
      if (wakeError) {
        detail = wakeError;
      }
    }

    try {
      const extension = await requestJson<ExtensionStatusResponse>(endpoint, "/extension/status", "GET");
      if (extension.connected) {
        return { connected: true };
      }
    } catch (error) {
      detail = formatError(error);
    }
  }

  return detail ? { connected: false, error: detail } : { connected: false };
}

function formatScope(scope: PluginScopeRule): string {
  const hosts = scope.hosts ?? [];
  const paths = scope.paths ?? [];
  const chunks: string[] = [];
  for (const host of hosts) {
    chunks.push(`host:${host}`);
  }
  for (const path of paths) {
    chunks.push(`path:${path}`);
  }
  return chunks.join(" ");
}

function formatPluginSource(source: PluginSource): string {
  if (source.type === "git") {
    return `${source.repoUrl}${source.ref ? `#${source.ref}` : ""}`;
  }
  if (source.type === "directory") {
    return `dir:${source.path}`;
  }
  return `zip:${source.path}`;
}

function setControlsEnabled(enabled: boolean): void {
  requireRef(refs.refreshBtn, "refreshBtn").disabled = !enabled;
  requireRef(refs.installBtn, "installBtn").disabled = !enabled;
  requireRef(refs.generateBtn, "generateBtn").disabled = !enabled;
  requireRef(refs.applyBtn, "applyBtn").disabled = !enabled;
}

function renderConnectionState(state: ConnectionState): void {
  const badge = requireRef(refs.connectionBadge, "connectionBadge");
  const detail = requireRef(refs.connectionDetail, "connectionDetail");

  badge.className = "status-pill";
  if (!state.serverUp) {
    badge.classList.add("error");
    badge.textContent = "Server Offline";
  } else if (state.extensionConnected) {
    badge.classList.add("connected");
    badge.textContent = "Bridge Connected";
  } else {
    badge.classList.add("warning");
    badge.textContent = "Server Up / Extension Disconnected";
  }

  const parts = [`endpoint: ${state.endpoint}`, `checked: ${state.checkedAt}`];
  if (state.error) {
    parts.push(`detail: ${state.error}`);
  }
  detail.textContent = parts.join(" | ");

  setControlsEnabled(state.serverUp);

  const globalNode = requireRef(refs.globalMsg, "globalMsg");
  if (!state.serverUp) {
    showMessage(globalNode, "server unavailable, start bridge server first", true);
    requireRef(refs.pluginList, "pluginList").innerHTML = "<div class='muted'>Server unavailable.</div>";
  } else if (!state.extensionConnected) {
    showMessage(globalNode, "server reachable; waiting extension websocket", true);
  }
}

async function fetchConnectionState(endpoint: string): Promise<ConnectionState> {
  const checkedAt = new Date().toLocaleTimeString();

  try {
    const health = await requestJson<HealthResponse>(endpoint, "/health", "GET");
    if (!health.ok) {
      return {
        endpoint,
        serverUp: false,
        extensionConnected: false,
        checkedAt,
        error: "health returned not ok"
      };
    }

    const probe = await probeExtensionConnection(endpoint);
    const state: ConnectionState = {
      endpoint,
      serverUp: true,
      extensionConnected: probe.connected,
      checkedAt
    };
    if (probe.error) {
      state.error = probe.error;
    }
    return state;
  } catch (error) {
    return {
      endpoint,
      serverUp: false,
      extensionConnected: false,
      checkedAt,
      error: formatError(error)
    };
  }
}

function createPluginRow(
  plugin: InstalledPluginRecord,
  endpoint: string,
  onReload: () => Promise<void>,
  allowActions: boolean
): HTMLElement {
  const row = document.createElement("div");
  row.className = "plugin-item";

  const title = document.createElement("div");
  title.className = "plugin-title";
  title.innerHTML = `<strong>${plugin.name}</strong><span>${plugin.pluginId}@${plugin.version}</span>`;

  const source = document.createElement("div");
  source.className = "plugin-meta";
  source.textContent = `source: ${formatPluginSource(plugin.source)}`;

  const scope = document.createElement("div");
  scope.className = "plugin-meta";
  scope.textContent = `scope: ${formatScope(plugin.match) || "(none)"}`;

  const actions = document.createElement("div");
  actions.className = "toolbar";

  const toggle = document.createElement("button");
  toggle.className = "secondary";
  toggle.textContent = plugin.enabled ? "Disable" : "Enable";
  toggle.disabled = !allowActions;
  toggle.onclick = async () => {
    try {
      const out = await requestJson<PluginToggleResponse>(endpoint, "/plugins/set-enabled", "POST", {
        pluginId: plugin.pluginId,
        enabled: !plugin.enabled
      });
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      await onReload();
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), formatError(error), true);
    }
  };

  const uninstall = document.createElement("button");
  uninstall.className = "danger";
  uninstall.textContent = "Uninstall";
  uninstall.disabled = !allowActions;
  uninstall.onclick = async () => {
    if (!confirm(`Uninstall ${plugin.pluginId}?`)) {
      return;
    }
    try {
      const out = await requestJson<PluginUninstallResponse>(endpoint, "/plugins/uninstall", "POST", {
        pluginId: plugin.pluginId
      });
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      await onReload();
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), formatError(error), true);
    }
  };

  actions.appendChild(toggle);
  actions.appendChild(uninstall);

  row.appendChild(title);
  row.appendChild(source);
  row.appendChild(scope);
  row.appendChild(actions);
  return row;
}

async function refreshPlugins(endpoint: string, allowActions: boolean): Promise<void> {
  const listNode = requireRef(refs.pluginList, "pluginList");
  const globalNode = requireRef(refs.globalMsg, "globalMsg");

  showMessage(globalNode, "loading plugins...", false);
  const data = await requestJson<PluginListResponse>(endpoint, "/plugins", "GET");
  requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(data, null, 2);

  listNode.innerHTML = "";
  if (data.plugins.length === 0) {
    listNode.innerHTML = "<div class='muted'>No installed plugins.</div>";
  } else {
    for (const plugin of data.plugins) {
      listNode.appendChild(
        createPluginRow(plugin, endpoint, async () => {
          await refreshPlugins(endpoint, allowActions);
        }, allowActions)
      );
    }
  }

  showMessage(globalNode, `loaded ${data.plugins.length} plugins`, false);
}

async function refreshConnection(endpoint: string, forceReloadPlugins: boolean): Promise<ConnectionState> {
  const prev = lastConnectionState;
  const state = await fetchConnectionState(endpoint);
  lastConnectionState = state;
  renderConnectionState(state);

  const recovered = prev ? !prev.serverUp && state.serverUp : false;
  if (state.serverUp && (forceReloadPlugins || recovered)) {
    try {
      await refreshPlugins(endpoint, state.serverUp);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), formatError(error), true);
    }
  }

  return state;
}

async function ensureServerUp(endpoint: string): Promise<boolean> {
  const state = await refreshConnection(endpoint, false);
  return state.serverUp;
}

function startStatusPolling(endpointInput: HTMLInputElement): void {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }

  statusPollTimer = setInterval(() => {
    if (statusPollBusy) {
      return;
    }
    statusPollBusy = true;
    void (async () => {
      try {
        const endpoint = normalizeHttpUrl(endpointInput.value);
        await refreshConnection(endpoint, false);
      } catch {
        // no-op
      } finally {
        statusPollBusy = false;
      }
    })();
  }, 5000);
}

async function wire(): Promise<void> {
  const endpointInput = requireRef(refs.endpointInput, "endpointInput");
  const endpointMsg = requireRef(refs.endpointMsg, "endpointMsg");

  const currentEndpoint = await loadServerEndpoint();
  endpointInput.value = currentEndpoint;
  showMessage(endpointMsg, `using ${currentEndpoint}`, false);

  requireRef(refs.saveEndpointBtn, "saveEndpointBtn").onclick = async () => {
    try {
      await saveServerEndpoint(endpointInput.value);
      const next = await loadServerEndpoint();
      endpointInput.value = next;
      showMessage(endpointMsg, `saved ${next}`, false);
      await refreshConnection(next, true);
    } catch (error) {
      showMessage(endpointMsg, formatError(error), true);
    }
  };

  requireRef(refs.checkConnectionBtn, "checkConnectionBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      await refreshConnection(endpoint, false);
    } catch (error) {
      showMessage(endpointMsg, formatError(error), true);
    }
  };

  requireRef(refs.refreshBtn, "refreshBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      if (!(await ensureServerUp(endpoint))) {
        return;
      }
      await refreshPlugins(endpoint, true);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), formatError(error), true);
    }
  };

  requireRef(refs.installBtn, "installBtn").onclick = async () => {
    const installMsg = requireRef(refs.installMsg, "installMsg");
    const repoUrl = requireRef(refs.repoUrlInput, "repoUrl").value.trim();
    const ref = requireRef(refs.repoRefInput, "repoRef").value.trim();
    const enabled = requireRef(refs.repoEnabledInput, "repoEnabled").checked;

    if (!repoUrl) {
      showMessage(installMsg, "repoUrl is required", true);
      return;
    }

    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      if (!(await ensureServerUp(endpoint))) {
        showMessage(installMsg, "server unavailable", true);
        return;
      }
      const out = await requestJson<PluginInstallResponse>(endpoint, "/plugins/install", "POST", {
        repoUrl,
        enabled,
        ...(ref ? { ref } : {})
      });
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      showMessage(installMsg, `installed ${out.plugin.pluginId}`, false);
      await refreshPlugins(endpoint, true);
    } catch (error) {
      showMessage(installMsg, formatError(error), true);
    }
  };

  requireRef(refs.generateBtn, "generateBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      if (!(await ensureServerUp(endpoint))) {
        return;
      }
      const out = await requestJson<PluginGenerateResponse>(endpoint, "/plugins/generate", "POST", {});
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      showMessage(requireRef(refs.globalMsg, "globalMsg"), "generated managed plugin registry", false);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), formatError(error), true);
    }
  };

  requireRef(refs.applyBtn, "applyBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      if (!(await ensureServerUp(endpoint))) {
        return;
      }
      const out = await requestJson<PluginApplyResponse>(endpoint, "/plugins/apply", "POST", {});
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      showMessage(requireRef(refs.globalMsg, "globalMsg"), "generated and built extension", false);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), formatError(error), true);
    }
  };

  await refreshConnection(currentEndpoint, true);
  startStatusPolling(endpointInput);

  window.addEventListener("unload", () => {
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
  });
}

void wire();
