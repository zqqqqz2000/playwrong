---
name: "playwrong-runtime"
description: "Use Playwrong runtime bridge to connect browser pages, sync/pull/apply/call, and manage runtime mapping plugins without extension rebuild."
---

# Playwrong Runtime Skill

Use this skill when you need to operate web pages through Playwrong server + extension.

## Usage

1. Start server:
```bash
bun apps/cli/src/index.ts serve --host 127.0.0.1 --port 7878
```
2. Check extension connection:
```bash
curl -sS http://127.0.0.1:7878/extension/status
```
3. List browser tabs:
```bash
bun apps/cli/src/index.ts pages-remote --endpoint http://127.0.0.1:7878
```
4. For a target page:
```bash
bun apps/cli/src/index.ts sync --endpoint http://127.0.0.1:7878 --page tab:<id>
bun apps/cli/src/index.ts pull --endpoint http://127.0.0.1:7878 --page tab:<id> --state-dir .bridge
```
5. Execute page function:
```bash
bun apps/cli/src/index.ts call --endpoint http://127.0.0.1:7878 --page tab:<id> --state-dir .bridge --id page --fn <fn> --args '{}'
```

## Operations

- Core bridge: `sync`, `pull`, `apply`, `call`
- Remote tabs: `pages-remote`
- Extension control: `extension-reload`, `page-refresh`
- Mapping plugins:
  - `mapping-plugins list`
  - `mapping-plugins install --dir <path> --enabled true`
  - `mapping-plugins apply`
  - `mapping-plugins enable|disable|uninstall|reload`

## Config

Use TOML config only (no env):
- `~/.config/playwrong/config.toml`
- Key server fields:
  - `extension_request_timeout_ms`
  - `extension_connect_grace_ms`
  - `websocket_idle_timeout_seconds`

## Failure Modes

- `No extension is connected`
  - Verify extension loaded and popup points to `ws://127.0.0.1:7878/ws/extension`.
- Frequent disconnect / timeout
  - Increase `extension_connect_grace_ms` and keep `websocket_idle_timeout_seconds = 0`.
- `REV_MISMATCH`
  - Re-run `pull` to refresh local revision before `apply`/`call`.
- `PLUGIN_MISS`
  - Current page not matched by plugin scope or required surface not ready.

## Stability Checklist

- Always do `sync -> pull -> call`, then `pull` again after side effects.
- Validate success by post-state, not only action return (URL/tree/result).
- Prefer runtime plugin path (`/mapping-plugins/runtime/module/<pluginId>`) over ad-hoc injection.
