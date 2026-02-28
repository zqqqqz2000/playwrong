export function renderPluginManagerHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Playwrong Plugin Manager</title>
  <style>
    :root {
      --bg: #f3f5f7;
      --card: #ffffff;
      --text: #1f2933;
      --subtle: #52606d;
      --border: #d9e2ec;
      --primary: #0b7285;
      --danger: #b42318;
      --ok: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial;
      color: var(--text);
      background: radial-gradient(circle at 20% -20%, #d8f3dc 0%, transparent 40%), var(--bg);
    }
    .container {
      max-width: 980px;
      margin: 24px auto 40px;
      padding: 0 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 4px 18px rgba(15, 23, 42, 0.06);
    }
    h1 { margin: 0 0 12px; font-size: 24px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    .muted { color: var(--subtle); }
    .row {
      display: grid;
      gap: 8px;
      grid-template-columns: 1fr;
      margin-bottom: 8px;
    }
    @media (min-width: 800px) {
      .row-2 {
        grid-template-columns: 2fr 1fr;
      }
    }
    label { font-size: 13px; color: var(--subtle); }
    input[type="text"] {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
    }
    button {
      border: 0;
      border-radius: 8px;
      padding: 10px 12px;
      cursor: pointer;
      font-weight: 600;
      background: var(--primary);
      color: white;
    }
    button.secondary {
      background: #334e68;
    }
    button.danger {
      background: var(--danger);
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .plugin-list {
      display: grid;
      gap: 10px;
    }
    .plugin-item {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
    }
    .plugin-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }
    .plugin-meta {
      font-size: 13px;
      color: var(--subtle);
      margin-bottom: 6px;
      word-break: break-all;
    }
    .pill {
      display: inline-block;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      background: #e6f4f1;
      color: var(--ok);
      margin-right: 6px;
      margin-bottom: 6px;
    }
    .error {
      color: var(--danger);
      white-space: pre-wrap;
      font-size: 13px;
    }
    .ok {
      color: var(--ok);
      white-space: pre-wrap;
      font-size: 13px;
    }
    pre {
      background: #f7fafc;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      overflow: auto;
      max-height: 260px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Playwrong Plugin Manager</h1>
    <p class="muted">Install plugin packs by git URL, configure enable/disable, then apply to extension build.</p>

    <section class="card">
      <h2>Install From Git</h2>
      <div class="row">
        <label for="repoUrl">Git Repo URL (supports https://, git@, or local path)</label>
        <input id="repoUrl" type="text" placeholder="https://github.com/your-org/playwrong-plugin-xxx.git" />
      </div>
      <div class="row row-2">
        <div>
          <label for="repoRef">Ref (optional tag/branch/commit)</label>
          <input id="repoRef" type="text" placeholder="main" />
        </div>
        <div style="display:flex;align-items:flex-end;gap:8px;">
          <label style="display:flex;align-items:center;gap:6px;color:var(--text)">
            <input id="repoEnabled" type="checkbox" checked /> enabled
          </label>
          <button id="installBtn">Install</button>
        </div>
      </div>
      <div id="installMsg" class="muted"></div>
    </section>

    <section class="card">
      <h2>Installed Plugins</h2>
      <div class="toolbar">
        <button class="secondary" id="refreshBtn">Refresh</button>
        <button id="generateBtn">Generate Managed Registry</button>
        <button id="applyBtn">Generate + Build Extension</button>
      </div>
      <div id="globalMsg" class="muted" style="margin-top:8px"></div>
      <div id="pluginList" class="plugin-list" style="margin-top:12px"></div>
      <pre id="rawOut"></pre>
    </section>
  </div>

  <script>
    const installMsg = document.getElementById("installMsg");
    const globalMsg = document.getElementById("globalMsg");
    const pluginList = document.getElementById("pluginList");
    const rawOut = document.getElementById("rawOut");

    function showMsg(node, text, isError = false) {
      node.className = isError ? "error" : "ok";
      node.textContent = text;
    }

    async function request(path, method, body) {
      const response = await fetch(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = data && data.error ? data.error : { message: "request failed" };
        throw new Error(typeof error.message === "string" ? error.message : JSON.stringify(error));
      }
      return data;
    }

    function renderPlugins(plugins) {
      pluginList.innerHTML = "";
      if (!plugins || plugins.length === 0) {
        pluginList.innerHTML = "<div class='muted'>No installed plugins yet.</div>";
        return;
      }

      for (const plugin of plugins) {
        const item = document.createElement("div");
        item.className = "plugin-item";

        const title = document.createElement("div");
        title.className = "plugin-title";
        title.innerHTML = "<strong>" + plugin.name + "</strong><span>" + plugin.pluginId + "@" + plugin.version + "</span>";

        const meta = document.createElement("div");
        meta.className = "plugin-meta";
        meta.textContent = "source: " + plugin.source.repoUrl + (plugin.source.ref ? "#" + plugin.source.ref : "");

        const scope = document.createElement("div");
        const hosts = (plugin.match && plugin.match.hosts) ? plugin.match.hosts : [];
        const paths = (plugin.match && plugin.match.paths) ? plugin.match.paths : [];
        scope.innerHTML = hosts.map((h) => "<span class='pill'>host:" + h + "</span>").join("") +
          paths.map((p) => "<span class='pill'>path:" + p + "</span>").join("");

        const actions = document.createElement("div");
        actions.className = "toolbar";

        const toggleBtn = document.createElement("button");
        toggleBtn.className = "secondary";
        toggleBtn.textContent = plugin.enabled ? "Disable" : "Enable";
        toggleBtn.onclick = async () => {
          try {
            const next = await request("/plugins/set-enabled", "POST", {
              pluginId: plugin.pluginId,
              enabled: !plugin.enabled
            });
            rawOut.textContent = JSON.stringify(next, null, 2);
            await refreshPlugins();
          } catch (error) {
            showMsg(globalMsg, String(error), true);
          }
        };

        const uninstallBtn = document.createElement("button");
        uninstallBtn.className = "danger";
        uninstallBtn.textContent = "Uninstall";
        uninstallBtn.onclick = async () => {
          if (!confirm("Uninstall " + plugin.pluginId + "?")) {
            return;
          }
          try {
            const out = await request("/plugins/uninstall", "POST", { pluginId: plugin.pluginId });
            rawOut.textContent = JSON.stringify(out, null, 2);
            await refreshPlugins();
          } catch (error) {
            showMsg(globalMsg, String(error), true);
          }
        };

        actions.appendChild(toggleBtn);
        actions.appendChild(uninstallBtn);

        item.appendChild(title);
        item.appendChild(meta);
        if (scope.innerHTML.length > 0) {
          item.appendChild(scope);
        }
        actions && item.appendChild(actions);
        pluginList.appendChild(item);
      }
    }

    async function refreshPlugins() {
      try {
        showMsg(globalMsg, "loading...");
        const data = await request("/plugins", "GET");
        renderPlugins(data.plugins || []);
        rawOut.textContent = JSON.stringify(data, null, 2);
        showMsg(globalMsg, "loaded " + (data.plugins ? data.plugins.length : 0) + " plugins");
      } catch (error) {
        showMsg(globalMsg, String(error), true);
      }
    }

    document.getElementById("refreshBtn").onclick = refreshPlugins;

    document.getElementById("installBtn").onclick = async () => {
      const repoUrl = document.getElementById("repoUrl").value.trim();
      const ref = document.getElementById("repoRef").value.trim();
      const enabled = Boolean(document.getElementById("repoEnabled").checked);
      if (!repoUrl) {
        showMsg(installMsg, "repoUrl is required", true);
        return;
      }
      try {
        const data = await request("/plugins/install", "POST", {
          repoUrl,
          enabled,
          ...(ref ? { ref } : {})
        });
        rawOut.textContent = JSON.stringify(data, null, 2);
        showMsg(installMsg, "installed " + data.plugin.pluginId);
        await refreshPlugins();
      } catch (error) {
        showMsg(installMsg, String(error), true);
      }
    };

    document.getElementById("generateBtn").onclick = async () => {
      try {
        const data = await request("/plugins/generate", "POST", {});
        rawOut.textContent = JSON.stringify(data, null, 2);
        showMsg(globalMsg, "generated managed plugin registry");
      } catch (error) {
        showMsg(globalMsg, String(error), true);
      }
    };

    document.getElementById("applyBtn").onclick = async () => {
      try {
        const data = await request("/plugins/apply", "POST", {});
        rawOut.textContent = JSON.stringify(data, null, 2);
        showMsg(globalMsg, "generated and built extension successfully");
      } catch (error) {
        showMsg(globalMsg, String(error), true);
      }
    };

    refreshPlugins();
  </script>
</body>
</html>`;
}
