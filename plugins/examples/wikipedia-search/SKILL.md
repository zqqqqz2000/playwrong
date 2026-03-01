---
name: wikipedia-search-plugin-skill
description: Use the Wikipedia search plugin to fill query, submit search, and open extracted result actions on wikipedia.org pages.
---

# Wikipedia Search Plugin Skill

## Usage

1. Sync/pull a Wikipedia page matched by this plugin.
2. Edit `wiki.search.query` and apply, or call page function `search`.
3. Read `wiki.search.results` and call `wiki.result.N.open` to open an article.

## Operations

- Page functions:
  - `search(query: string)`
  - `refresh()`
- Node functions:
  - `wiki.search.query`: `focus()`, `submit()`
  - `wiki.search.submit`: `click()`
  - `wiki.result.N.open`: `click()`

## Failure Modes

- `PLUGIN_MISS`: page structure changed or page is outside plugin scope.
- Search result list empty: keep query, run `refresh()`, then `sync/pull` again.

## Notes

- Plugin scope is restricted by manifest match rules for `*.wikipedia.org`.
- If DOM structure is unavailable, plugin returns `PLUGIN_MISS` and runtime falls back.
