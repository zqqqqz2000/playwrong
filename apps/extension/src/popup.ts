const DEFAULT_SERVER_HTTP_URL = "http://127.0.0.1:7878";
const DEFAULT_SERVER_WS_URL = "ws://127.0.0.1:7878/ws/extension";
const STORAGE_SERVER_WS_URL_KEY = "serverWsUrl";
const STORAGE_SERVER_HTTP_URL_KEY = "serverHttpUrl";

interface PluginScopeRule {
  hosts?: string[];
  paths?: string[];
}

interface PluginSourceGit {
  type: "git";
  repoUrl: string;
  ref?: string;
}

interface InstalledPluginRecord {
  pluginId: string;
  name: string;
  version: string;
  description?: string;
  match: PluginScopeRule;
  enabled: boolean;
  source: PluginSourceGit;
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

const refs = {
  endpointInput: document.querySelector<HTMLInputElement>("#endpointInput"),
  saveEndpointBtn: document.querySelector<HTMLButtonElement>("#saveEndpointBtn"),
  endpointMsg: document.querySelector<HTMLElement>("#endpointMsg"),
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

function requireRef<T>(value: T | null, id: string): T {
  if (!value) {
    throw new Error(`Missing DOM element: ${id}`);
  }
  return value;
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
  const fromStorage = await chrome.storage.local.get([
    STORAGE_SERVER_HTTP_URL_KEY,
    STORAGE_SERVER_WS_URL_KEY
  ]);

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

  const response = await fetch(new URL(path, `${endpoint}/`), init);
  const payload = (await response.json()) as { error?: { message?: string } } & T;
  if (!response.ok) {
    const message = payload.error?.message || `Request failed: ${response.status}`;
    throw new Error(message);
  }
  return payload;
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

function createPluginRow(plugin: InstalledPluginRecord, endpoint: string, onReload: () => Promise<void>): HTMLElement {
  const row = document.createElement("div");
  row.className = "plugin-item";

  const title = document.createElement("div");
  title.className = "plugin-title";
  title.innerHTML = `<strong>${plugin.name}</strong><span>${plugin.pluginId}@${plugin.version}</span>`;

  const source = document.createElement("div");
  source.className = "plugin-meta";
  source.textContent = `source: ${plugin.source.repoUrl}${plugin.source.ref ? `#${plugin.source.ref}` : ""}`;

  const scope = document.createElement("div");
  scope.className = "plugin-meta";
  scope.textContent = `scope: ${formatScope(plugin.match) || "(none)"}`;

  const actions = document.createElement("div");
  actions.className = "toolbar";

  const toggle = document.createElement("button");
  toggle.className = "secondary";
  toggle.textContent = plugin.enabled ? "Disable" : "Enable";
  toggle.onclick = async () => {
    try {
      const out = await requestJson<PluginToggleResponse>(endpoint, "/plugins/set-enabled", "POST", {
        pluginId: plugin.pluginId,
        enabled: !plugin.enabled
      });
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      await onReload();
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), String(error), true);
    }
  };

  const uninstall = document.createElement("button");
  uninstall.className = "danger";
  uninstall.textContent = "Uninstall";
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
      showMessage(requireRef(refs.globalMsg, "globalMsg"), String(error), true);
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

async function refreshPlugins(endpoint: string): Promise<void> {
  const listNode = requireRef(refs.pluginList, "pluginList");
  const globalNode = requireRef(refs.globalMsg, "globalMsg");

  showMessage(globalNode, "loading...", false);
  const data = await requestJson<PluginListResponse>(endpoint, "/plugins", "GET");
  requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(data, null, 2);

  listNode.innerHTML = "";
  if (data.plugins.length === 0) {
    listNode.innerHTML = "<div class='muted'>No installed plugins.</div>";
  } else {
    for (const plugin of data.plugins) {
      listNode.appendChild(createPluginRow(plugin, endpoint, async () => {
        await refreshPlugins(endpoint);
      }));
    }
  }

  showMessage(globalNode, `loaded ${data.plugins.length} plugins`, false);
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
      await refreshPlugins(next);
    } catch (error) {
      showMessage(endpointMsg, String(error), true);
    }
  };

  requireRef(refs.refreshBtn, "refreshBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      await refreshPlugins(endpoint);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), String(error), true);
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
      const out = await requestJson<PluginInstallResponse>(endpoint, "/plugins/install", "POST", {
        repoUrl,
        enabled,
        ...(ref ? { ref } : {})
      });
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      showMessage(installMsg, `installed ${out.plugin.pluginId}`, false);
      await refreshPlugins(endpoint);
    } catch (error) {
      showMessage(installMsg, String(error), true);
    }
  };

  requireRef(refs.generateBtn, "generateBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      const out = await requestJson<PluginGenerateResponse>(endpoint, "/plugins/generate", "POST", {});
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      showMessage(requireRef(refs.globalMsg, "globalMsg"), "generated managed plugin registry", false);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), String(error), true);
    }
  };

  requireRef(refs.applyBtn, "applyBtn").onclick = async () => {
    try {
      const endpoint = normalizeHttpUrl(endpointInput.value);
      const out = await requestJson<PluginApplyResponse>(endpoint, "/plugins/apply", "POST", {});
      requireRef(refs.rawOut, "rawOut").textContent = JSON.stringify(out, null, 2);
      showMessage(requireRef(refs.globalMsg, "globalMsg"), "generated and built extension", false);
    } catch (error) {
      showMessage(requireRef(refs.globalMsg, "globalMsg"), String(error), true);
    }
  };

  await refreshPlugins(currentEndpoint);
}

void wire();
