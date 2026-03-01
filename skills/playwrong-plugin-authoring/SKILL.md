---
name: playwrong-plugin-authoring
description: Create or update Playwrong site plugins with minimal exploration. Use when Codex needs to add a new plugin pack (manifest, skill doc, script implementation, registration, and validation tests) that maps a real page to semantic nodes and pull/apply/call actions.
---

# Playwrong Plugin Authoring

Use this workflow to build stable site plugins.

## When To Use

- User asks to add a new site/page plugin.
- Existing plugin is unstable and needs selector hardening.
- Need plugin-level tests and manifest/skill compliance.

## Required Inputs

- Target site and page scope (`hosts` + `paths`).
- Key user goals (what LLM must do via `pull/apply/call`).
- At least 1 success criterion and 1 failure criterion.

## Output Contract

For each new plugin, always create or update these files:

1. `plugins/examples/<plugin-id>/playwrong.plugin.json`
2. `plugins/examples/<plugin-id>/SKILL.md`
3. `plugins/examples/<plugin-id>/src/index.ts`
4. Extension wiring (managed or local user scripts)
5. Tests (unit and/or e2e) that prove plugin is actually used

## Implementation Flow

1. Define manifest and scope first.
- Follow [`plugins/PLUGIN_SPEC.md`](../../plugins/PLUGIN_SPEC.md).
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

## Definition Of Done

- Plugin passes `PLUGIN_SPEC` rules.
- Skill doc includes `Usage`, `Operations`, `Failure Modes`.
- `sync/page` returns expected `pageType` + key ids.
- Action succeeds without direct CDP/Playwright DOM scripting.

## References

- Spec: `plugins/PLUGIN_SPEC.md`
- Checklist: `references/checklist.md`
- Good examples:
  - `plugins/examples/github-repo-manager`
  - `plugins/examples/wikipedia-search`
  - `plugins/examples/hackernews-reader`
