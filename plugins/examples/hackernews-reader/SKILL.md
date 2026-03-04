---
name: hackernews-reader-plugin-skill
description: Use the Hacker News reader plugin to extract story actions and open stories from list pages.
---

# Hacker News Reader Plugin Skill

## Usage

1. Sync/pull a Hacker News list page (`/`, `/news`, `/newest`, `/best`).
2. Read `hn.story.list` to get story nodes.
3. Call `hn.story.N.open` with `click` to navigate to the story URL.

## Operations

- Page functions:
  - `refresh()`
  - `debugStories()`
- Node functions:
  - `hn.story.N.open`: `click()`

## Failure Modes

- `PLUGIN_MISS`: not on supported Hacker News list pages.
- Story node not found: run `refresh()` and then `sync/pull`.
- Invoke receipt missing required keys: run `debugStories()` and repull before retry.

## Notes

- Plugin focuses on list extraction and link opening only.
- Non-matching actions return `PLUGIN_MISS`.
- Successful invoke responses use `contractVersion=llm_webop_v2`.
