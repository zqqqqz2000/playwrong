# Plugin Authoring Checklist

## Selector Robustness

- Prefer semantic attributes over brittle index-based selectors.
- Add fallback for shadow-dom/global scans when primary selector is missing.
- Keep at least one locator path that does not depend on visual text.

## Runtime Verification

- Verify `/pages/remote` returns target page.
- Verify `/sync/page` returns expected `pageType`.
- Verify `/pull` includes expected XML nodes or editable files.
- Verify `/call` and `/apply` increment rev and produce observable state changes.

## Failure Coverage

- Node missing -> expect `PLUGIN_MISS` or structured failure.
- Stale rev -> expect `REV_MISMATCH` and repull path.
- Permission/login prerequisite missing -> explicit actionable error.
