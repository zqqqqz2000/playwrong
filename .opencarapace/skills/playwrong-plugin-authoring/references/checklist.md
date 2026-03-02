# Plugin Authoring Checklist

## Mapping Plugin CLI Path

- Verify `mapping-plugins list` can discover plugin state.
- Verify `mapping-plugins install` installs from git and updates registry.
- Verify `mapping-plugins enable` and `mapping-plugins disable` toggle enabled status.
- Verify `mapping-plugins reload` recompiles enabled plugin entries for runtime delivery without rebuilding extension artifacts.
- Verify `mapping-plugins reload --reload-extension true --page <PAGE_ID>` can complete without manual browser operations.
- Verify `mapping-plugins uninstall` removes plugin directory and registry entry.

## Selector Robustness

- Prefer semantic attributes over brittle index-based selectors.
- Add fallback for shadow-dom/global scans when primary selector is missing.
- Keep at least one locator path that does not depend on visual text.

## Runtime Verification

- Verify `/pages/remote` returns target page.
- Verify `/sync/page` returns expected `pageType`.
- Verify `/pull` includes expected XML nodes or editable files.
- Verify each key action has screenshot evidence from `pull`.
- Verify `/call` and `/apply` increment rev and produce observable state changes.
- For Monaco/CodeMirror-like editors, verify instance-first read/write path before DOM fallback.
- If main-world access is required, keep bridge generic and leave page-specific selection logic in the mapping plugin.
- Verify run/log/debug action returns structured status snippets (not just success booleans).

## Failure Coverage

- Node missing -> expect `PLUGIN_MISS` or structured failure.
- Stale rev -> expect `REV_MISMATCH` and repull path.
- Permission/login prerequisite missing -> explicit actionable error.
- Extension websocket transient disconnect -> auto retry path and reconnect check on `/extension/status`.
