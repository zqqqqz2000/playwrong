# Troubleshooting

## Common failures

1. `Expected pageType=google.search`
- Cause: wrong page selected or Google script not matched.
- Fix: verify `pageId`, rerun sync, ensure current tab is Google search/home page.

2. `query node search.query is missing`
- Cause: extractor did not expose editable search field yet.
- Fix: run sync again after page fully loads.

3. `search results not ready`
- Cause: navigation delay, consent page, anti-bot page, or unstable network.
- Fix: increase `--timeoutMs`, ensure consent handled, retry on a fresh browser context.

4. Missing `search.pagination.next`
- Cause: only one page of results or layout variant.
- Fix: use another query with more results.
