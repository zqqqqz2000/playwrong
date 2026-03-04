---
name: "playwrong-mapping-plugin-dev"
description: "Develop and debug Playwrong mapping plugins with runtime-first loading, clear error semantics, and stable main-world interaction patterns."
---

# Playwrong Mapping Plugin Dev Skill

Use this skill when creating or modifying `playwrong.plugin.json` plugins.

## Usage

1. Create plugin manifest with required fields:
- `schemaVersion`, `pluginId`, `name`, `version`, `entry`, `skill.path`, `match.hosts`, `match.paths`
2. Implement `entry` export:
- `export const pluginScripts: PluginScript[] = [...]`
- or `export default [...]`
3. Install/apply runtime plugin:
```bash
bun apps/cli/src/index.ts mapping-plugins install --endpoint http://127.0.0.1:7878 --dir <plugin-dir> --enabled true
bun apps/cli/src/index.ts mapping-plugins apply --endpoint http://127.0.0.1:7878
```
4. Validate via real page:
```bash
sync -> pull -> call -> pull
```

## Development Rules

- Runtime-first: plugin must be dynamically loaded at runtime, no extension rebuild dependency.
- Strict scope: constrain via `match.hosts`/`match.paths`.
- Error semantics:
  - `PLUGIN_MISS`: page/surface not handled by plugin.
  - `ACTION_FAIL`: matched page but action execution failed.
- Main world access:
  - Use SDK `invokeInMainWorld` only.
  - Do not create action-specific channels (`*.monaco`, `*.click`, etc.).
- Do not trust one action result; verify by post-state transition.
- Stability is business-semantic, not visual-only:
  - Global `waitForStable` is necessary but insufficient for async business flows.
  - Implement plugin `isStable(ctx)` for key routes and gate on terminal API signal (`status + payload`) plus UI loading cleared.
- Action semantics must be explicit:
  - Distinguish `triggered` from `completed`.
  - Do not return pre-action snapshots as post-action result.
  - For async actions, return deferred state and require follow-up `sync -> pull`.
- Read operations should be dual-channel:
  - Primary path: structured UI extraction (fast, local context).
  - Fallback path: API-backed extraction when UI is still rendering or sparse.
  - Always return source attribution (for example `source: "ui" | "api"`).
- Surface diagnostics in every non-trivial read/call:
  - Include enough fields to explain empty results (`status`, parse success, entry count, error snippet).
  - Keep diagnostics bounded and machine-parseable.

## Debug Workflow

1. Surface check:
```bash
bun apps/cli/src/index.ts sync --endpoint http://127.0.0.1:7878 --page tab:<id>
bun apps/cli/src/index.ts pull --endpoint http://127.0.0.1:7878 --page tab:<id> --state-dir .bridge
```
2. Function check:
- Call target function with minimal args.
- Pull again and confirm expected tree/url/result mutation.
3. Main-world/isolated-world check:
- If click appears successful but route/state unchanged, switch to `invokeInMainWorld` path.
4. Retry/connectivity check:
- If transport errors are transient, retry after ensuring tab ready/extension connected.

## Failure Modes

- CSP blocks inline/blob loading
  - Avoid inline script fallback; use runtime module URL and `invokeInMainWorld` bridge.
- Intermittent timeout/disconnect
  - Distinguish transport failure from business failure.
  - Tune server grace/timeout, and add bounded retry on transient errors.
- Trigger/read race condition
  - Root cause: result read happens before business data reaches terminal state.
  - Fix: gate with plugin `isStable` using business API status and payload readiness.
- Match/open mismatch
  - Prefer deterministic matching (exact/contains) + authoritative fallback channel over fuzzy scoring-only strategy.

## Stable Abstractions (Reusable)

- Single generic bridge capability > many site/action special channels.
- Business-ready stability > visual-ready stability.
- Dual-channel reads (UI + API fallback) for async surfaces.
- “Action + Post-condition” as one atomic contract.
- Explicit action phase (`triggered` vs `completed`) in results.
- Layered diagnostics:
  - connection
  - page match
  - action execution
  - post-state verification
