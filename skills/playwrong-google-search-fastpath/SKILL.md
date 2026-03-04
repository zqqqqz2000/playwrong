---
name: playwrong-google-search-fastpath
description: Execute one Playwrong Google search flow with minimal exploration by using the bridge abstraction and fastpath script. Use when Codex needs to quickly verify `pageType=google.search`, run `search`, confirm result actions and pagination, and return machine-readable evidence for E2E or debugging.
---

# Playwrong Google Search Fastpath

Run the deterministic fastpath instead of ad-hoc probing.

## Workflow

1. Ensure prerequisites.
- Bridge server is running on `http://127.0.0.1:7878` (or pass another endpoint).
- Browser extension is connected.
- A target page id is known from `/pages/remote`.

2. Run the fastpath command.
```bash
bun skills/playwrong-google-search-fastpath/scripts/google_search_fastpath.ts \
  --endpoint http://127.0.0.1:7878 \
  --pageId <PAGE_ID> \
  --query "playwrong llm automation"
```

3. Read log evidence from command output.
- `FASTPATH_PAGE_TYPE=google.search`
- `FASTPATH_RESULT_IDS=...search.result.N.open...`
- `FASTPATH_NEXT_ACTION=search.pagination.next`
- When using CLI `pull`, default output now also includes one screenshot saved at `.bridge/pages/<PAGE_ID>/screenshot.png`.

4. Validate action receipt contract for page calls.
- Require `contractVersion=llm_webop_v2`.
- Require `action.targetId`, `action.fn`, `page.urlBefore`, `page.urlAfter`.
- Require `recovery.retryable` and `recovery.suggestedNext`.

5. Return a short JSON result.
- Include whether abstraction was used.
- Include result count and next-page action id.
- Include issues as an array (`[]` when none).

## Rules

- Do not rewrite the flow during E2E unless the command fails.
- Prefer rerun with a new `--query` or larger `--timeoutMs` before changing logic.
- If the command fails, include the exact failing step and latest logs.
- If receipt contract is incomplete, call plugin `debug*` function before fallback probing.

## Resources

- Command implementation: `scripts/google_search_fastpath.ts`
- Quick troubleshooting: `references/troubleshooting.md`
