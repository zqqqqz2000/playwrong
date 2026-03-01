---
name: github-repo-manager-plugin-skill
description: Use the GitHub repository manager plugin to create repositories via Playwrong pull/apply/call without direct DOM scripting.
---

# GitHub Repository Manager Skill

## Usage

1. Open a GitHub page and run `sync` then `pull`.
2. If not on `/new`, call page function `openNewRepository`.
3. On `/new`, edit `github.repo.new.name` (and optional description/toggles), then `apply`.
4. Call `github.repo.new.submit.click` or page function `createRepository`.
5. Sync again and verify URL becomes `https://github.com/<owner>/<repo>`.

## Operations

- Page functions:
  - `openNewRepository()`
  - `createRepository({ name, description?, visibility?, autoInit? })`
  - `refresh()`
- Node functions:
  - `github.repo.new.open`: `click()`
  - `github.repo.new.name`: `focus()`
  - `github.repo.new.description`: `focus()`
  - `github.repo.new.submit`: `click()`, `submit()`
  - `github.repo.new.visibility.public`: `click()`
  - `github.repo.new.visibility.private`: `click()`
  - `github.repo.new.auto_init`: `click()`

## Failure Modes

- `PLUGIN_MISS`: page is outside GitHub scope or target DOM is unavailable.
- `Unknown page function`: extension still running old build; refresh extension and run `sync`.
- Repository create failed server-side: check name conflict/permissions and retry with a new name.

## Notes

- This plugin requires signed-in GitHub session for repository creation.
- If target page cannot be handled, plugin returns `PLUGIN_MISS` and runtime falls back.
