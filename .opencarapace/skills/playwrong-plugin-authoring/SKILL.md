---
name: playwrong-plugin-authoring
description: Create or update Playwrong mapping plugins with minimal exploration. Use when Codex needs to add a plugin pack that maps real pages to LLM-readable XML and verifies runtime behavior through mapping-plugins management commands and pull/apply/call evidence.
---

# Playwrong Mapping Plugin Authoring

Use this workflow to build stable mapping plugins.

## When To Use

- User asks to add a new site/page mapping plugin.
- Existing mapping plugin is unstable and needs selector hardening.
- Need plugin-level tests and manifest/skill compliance.

## Required Inputs

- Target site and page scope (`hosts` + `paths`).
- Key user goals (what LLM must do via `pull/apply/call`).
- At least 1 success criterion and 1 failure criterion.

## Mapping Plugin CLI Commands

Use this command set as the default lifecycle for mapping plugin management.

```bash
bun apps/cli/src/index.ts mapping-plugins list --endpoint http://127.0.0.1:7878
bun apps/cli/src/index.ts mapping-plugins install --endpoint http://127.0.0.1:7878 --repo-url <GIT_URL> --enabled true
bun apps/cli/src/index.ts mapping-plugins enable --endpoint http://127.0.0.1:7878 --id <PLUGIN_ID>
bun apps/cli/src/index.ts mapping-plugins disable --endpoint http://127.0.0.1:7878 --id <PLUGIN_ID>
bun apps/cli/src/index.ts mapping-plugins generate --endpoint http://127.0.0.1:7878
bun apps/cli/src/index.ts mapping-plugins reload --endpoint http://127.0.0.1:7878
bun apps/cli/src/index.ts mapping-plugins uninstall --endpoint http://127.0.0.1:7878 --id <PLUGIN_ID>
```

Mapping plugin runtime storage isolation:

- Plugin runtime state is stored outside the Playwrong repo.
- Use `PLAYWRONG_HOME` to override root path.
- Default root is `~/.config/playwrong`.
- Registry and installed plugin code live under `${PLAYWRONG_HOME}/plugins` (or `~/.config/playwrong/plugins` when env is unset).
- Installed plugin directory uses `pluginId` directly under `${PLAYWRONG_HOME}/plugins/installed/`.
- Do not rely on `playwrong/plugins/registry.json` as runtime source of truth.
- For immutable packaged extension delivery, prefer declarative runtime plugins via `runtime.path`; extension reads them dynamically from `/mapping-plugins/runtime` without rebuild.

`reload` regenerates managed mapping scripts and rebuilds extension artifacts.

Recommended hot-reload command when validating a live tab:

```bash
bun apps/cli/src/index.ts mapping-plugins reload \
  --endpoint http://127.0.0.1:7878 \
  --reload-extension true \
  --wait-ms 20000 \
  --page <PAGE_ID>
```

## Output Contract

For each new plugin, always create or update these files:

1. `plugins/examples/<plugin-id>/playwrong.plugin.json`
2. `plugins/examples/<plugin-id>/SKILL.md`
3. `plugins/examples/<plugin-id>/src/index.ts`
4. Extension wiring (managed or local user scripts)
5. Tests (unit and/or e2e) that prove plugin is actually used

## Implementation Flow

1. Define manifest and scope first.
- Follow [`plugins/PLUGIN_SPEC.md`](../../../plugins/PLUGIN_SPEC.md).
- Keep `pluginId` lowercase and `version` semver-style.
- Keep runtime matching self-contained in plugin scripts (`script.rules`). Do not depend on core repo generated files to inject manifest `match` rules.
- If target environment cannot rebuild extension, add `runtime.path` JSON and validate behavior through runtime endpoint instead of relying on `mapping-plugins reload`.

2. Implement `extract` first.
- Emit nested semantic tree with stable ids.
- Provide page-level functions in `pageCalls` for high-value flows.
- Prefer putting persistent observational data into XML nodes in `extract` (for example result/log/overview panels), instead of relying only on debug function return payloads.

3. Implement `setValue` and `invoke`.
- For unsupported actions return `PLUGIN_MISS`.
- Prefer multi-layer selectors:
  - exact selector
  - semantic fallback (`id/name/aria/placeholder`)
  - global fallback scan
- Prefer runtime instance APIs over DOM scraping when available:
  - Example: for Monaco-based editors, first try editor/model instances (`window.monaco.editor.getEditors()` + model `getValue/setValue`) through a safe bridge.
  - Use DOM fallback only when instance APIs are unavailable or blocked.
  - Keep this logic generic (capability bridge in runtime, site behavior in mapping plugin), avoid hardcoding site-specific rules in core runtime.

4. Add a debug function.
- Add one no-side-effect function (for example `debugForm` / `debugNodes`) to return what plugin can see.

5. Add/refresh tests.
- Include at least:
  - plugin install/validation test
  - one action test (`setValue` or `call`)
  - one post-action state assertion

6. Verify runtime path.
- Confirm logs include `/sync/page`, `/pull`, `/apply` or `/call`.
- Confirm page type and key node ids after sync.
- Confirm `pull` artifacts include local screenshot output at `.bridge/pages/<pageId>/screenshot.png` when extension is connected.
- Confirm mapping plugin lifecycle is operable through `mapping-plugins` commands.
- For every critical step, keep both machine evidence and visual evidence:
  - call response JSON (`stepXX_<action>_call.json`)
  - pull response JSON (`stepXX_<action>_pull.json`)
  - screenshot (`stepXX_<action>.png`)

7. Use screenshot-first debugging (no direct Playwright probing by default).
- Prefer `pull` screenshots plus `sync/call` outputs to judge whether behavior really changed.
- If visual state and call output disagree, trust runtime evidence first, then re-pull after 1-2s and compare again.
- Record one final screenshot after run/debug to prove result/log pane state.

8. Handle connection/revision flakiness explicitly.
- If `/extension/status` is false or `PLUGIN_MISS: No extension is connected`, wait and retry.
- Use `extension-reload` (or `mapping-plugins reload --reload-extension true`) before asking user for manual operations.
- If `REV_MISMATCH` appears, run `pull` to refresh revision and retry the call.

9. Keep responsibilities separated.
- Mapping plugin owns site behavior (Monaco instance APIs, selection logic, run button detection).
- Playwrong runtime/CLI owns transport/reload/retry mechanics.
- Do not hardcode site-specific editor logic into runtime core files.

## Definition Of Done

- Plugin passes `PLUGIN_SPEC` rules.
- Skill doc includes `Usage`, `Operations`, `Failure Modes`.
- `sync/page` returns expected `pageType` + key ids.
- Action succeeds without direct CDP/Playwright DOM scripting.
- For framework/editor pages, instance-first path is verified before DOM fallback.
- `mapping-plugins install|enable|reload|uninstall` path is verified for the target plugin.
- Verification includes screenshots from `pull`, not only JSON outputs.

## References

- Spec: `plugins/PLUGIN_SPEC.md`
- Checklist: `references/checklist.md`
- Good examples:
  - `plugins/examples/github-repo-manager`
  - `plugins/examples/wikipedia-search`
  - `plugins/examples/hackernews-reader`
