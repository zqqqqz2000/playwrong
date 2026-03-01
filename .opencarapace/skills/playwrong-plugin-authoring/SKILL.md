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

`reload` regenerates managed mapping scripts and rebuilds extension artifacts.

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

2. Implement `extract` first.
- Emit nested semantic tree with stable ids.
- Provide page-level functions in `pageCalls` for high-value flows.

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

## Definition Of Done

- Plugin passes `PLUGIN_SPEC` rules.
- Skill doc includes `Usage`, `Operations`, `Failure Modes`.
- `sync/page` returns expected `pageType` + key ids.
- Action succeeds without direct CDP/Playwright DOM scripting.
- For framework/editor pages, instance-first path is verified before DOM fallback.
- `mapping-plugins install|enable|reload|uninstall` path is verified for the target plugin.

## References

- Spec: `plugins/PLUGIN_SPEC.md`
- Checklist: `references/checklist.md`
- Good examples:
  - `plugins/examples/github-repo-manager`
  - `plugins/examples/wikipedia-search`
  - `plugins/examples/hackernews-reader`
