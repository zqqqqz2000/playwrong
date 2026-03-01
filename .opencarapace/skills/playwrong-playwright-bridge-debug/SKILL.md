---
name: playwrong-playwright-bridge-debug
description: Debug bridge-driven browser workflows with deterministic pull/call evidence. Prefer pull screenshots and bridge APIs; use Playwright only for browser bootstrap/login/session setup.
---

# Playwrong Playwright Bridge Debug

Use this workflow for runtime debugging when a browser page is already connected to Playwrong.

## Core Rule

- Default to `sync/pull/call` evidence.
- Do **not** use Playwright page probing unless bridge evidence is insufficient.
- `pull` already writes a screenshot; use it as the primary visual proof.

## When To Use

- Bridge command works intermittently and needs deterministic step evidence.
- Extension reconnect/reload behavior is flaky and needs retry-safe validation.
- Need to prove a user-facing UI change with screenshot + call outputs.

## Workflow

1. Check transport status.
- `curl -s http://127.0.0.1:7878/extension/status`
- If disconnected, wait/retry first; then run:
```bash
bun apps/cli/src/index.ts extension-reload --endpoint http://127.0.0.1:7878 --wait-ms 20000
```

2. Identify target page and sync.
```bash
bun apps/cli/src/index.ts pages-remote --endpoint http://127.0.0.1:7878
bun apps/cli/src/index.ts sync --endpoint http://127.0.0.1:7878 --page <PAGE_ID>
```

3. Execute step-by-step actions with artifacts.
- For each step, save:
  - `stepXX_<action>_call.json`
  - `stepXX_<action>_pull.json`
  - `stepXX_<action>.png` (copied from `state-dir/pages/<PAGE_ID>/screenshot.png`)

4. Verify final behavior from both machine and visual signals.
- Compare call output fields (for example `action`, `hasSelection`, `matchedRunning`).
- Confirm screenshot shows expected UI state.

## Operations

- Pull with screenshot:
```bash
bun apps/cli/src/index.ts pull --endpoint http://127.0.0.1:7878 --page <PAGE_ID> --state-dir <DIR>
```
- Safe plugin rebuild + reload + target page refresh:
```bash
bun apps/cli/src/index.ts mapping-plugins reload \
  --endpoint http://127.0.0.1:7878 \
  --reload-extension true \
  --wait-ms 20000 \
  --page <PAGE_ID>
```
- Page refresh only:
```bash
bun apps/cli/src/index.ts page-refresh --endpoint http://127.0.0.1:7878 --page <PAGE_ID>
```

## Failure Modes

- `PLUGIN_MISS: No extension is connected`:
  - wait and retry status check
  - run `extension-reload`
  - retry command
- `REV_MISMATCH`:
  - run `pull` to refresh rev
  - retry `call`/`apply`
- Call says success but UI seems unchanged:
  - run `pull` again after 1-2 seconds
  - compare updated screenshot and editable file content
- `mapping-plugins reload --page` fails after extension reload:
  - rerun once with retry after reconnect
  - separate `mapping-plugins reload` and `page-refresh` if needed

## Definition Of Done

- Step artifacts are complete and ordered.
- Final screenshot and call output prove behavior.
- No manual browser operation is required for reconnect/reload in normal path.
