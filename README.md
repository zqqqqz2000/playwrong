# Playwrong

Playwrong is a production-focused browser automation bridge for LLM systems.  
It converts live web pages into structured XML and executes interaction through one unified contract: `pull`, `apply`, `call`.

## English Guide

### Overview

Playwrong provides a stable abstraction layer between web pages and language models.

- XML snapshot generation for live browser state
- Editable field extraction for deterministic text updates
- Function-level actions for page and element operations
- Mapping plugin driven site specialization for domain workflows
- CLI and extension runtime for local or integrated operation

### Architecture

- `apps/cli` exposes command workflows such as serve, sync, pull, apply, call, mapping-plugins
- `apps/server` provides HTTP and WebSocket gateway services
- `apps/extension` runs Chrome MV3 scripts and bridge communication
- `packages/protocol` defines protocol types, XML rendering, and error model
- `packages/plugin-sdk` provides matcher, locator, and plugin interfaces
- `plugins` stores mapping plugin specification and examples
- `skills` contains Codex workflow skills for fast path automation and mapping plugin authoring

### XML Example For LLM

`pull` returns a JSON payload where the `xml` field is the page snapshot consumed by the LLM.

```xml
<page id="tab:123456" rev="42" pageType="google.search" url="https://www.google.com/search?q=playwrong+llm+automation" title="playwrong llm automation - Google Search">
  <functionCall name="search" sideEffect="true"/>
  <section id="search.root" label="Google Search">
    <editable id="search.query" label="Query">
      playwrong llm automation
    </editable>
    <action id="search.submit" label="Google Search"/>
    <list id="search.results">
      <item id="search.result.1">
        <content id="search.result.1.title">Playwrong - GitHub</content>
        <action id="search.result.1.open" label="Open result"/>
      </item>
    </list>
    <action id="search.pagination.next" label="Next page"/>
  </section>
</page>
```

### Quick Start

Requirements

- Bun version 1.3 or newer
- Chromium or Chrome
- macOS or Linux

Install dependencies

```bash
bun install
```

Start server

```bash
bun run cli:serve
```

Compile browser extension

```bash
bun run build:extension
```

Install extension in Chrome

Load extension from `apps/extension/dist` in Chrome extension page with developer mode enabled.

### Manual Workflow

Start server

```bash
bun run cli:serve
```

Compile browser extension

```bash
bun run build:extension
```

Install extension in Chrome

Load extension from `apps/extension/dist` in Chrome extension page with developer mode enabled.

List remote pages

```bash
bun apps/cli/src/index.ts pages-remote --endpoint http://127.0.0.1:7878
```

Sync and pull state

```bash
bun apps/cli/src/index.ts sync --endpoint http://127.0.0.1:7878 --page tab:123456
bun apps/cli/src/index.ts pull --endpoint http://127.0.0.1:7878 --page tab:123456 --state-dir .bridge
```

`pull` now writes XML, editable files, and a default screenshot at `.bridge/pages/tab:123456/screenshot.png`.

Apply local editable updates

```bash
printf 'playwrong llm automation\n' > .bridge/pages/tab:123456/editable/search.query.txt
bun apps/cli/src/index.ts apply --endpoint http://127.0.0.1:7878 --page tab:123456 --state-dir .bridge
```

Invoke page function

```bash
bun apps/cli/src/index.ts call --endpoint http://127.0.0.1:7878 --page tab:123456 --id page --fn search --args '{"query":"playwrong llm automation"}'
```

### Mapping Plugin Framework

Mapping plugin repository must include `playwrong.plugin.json` at root.

Runtime storage isolation for mapping plugins:

- Plugin install/registry state is outside this repository.
- Root path: `~/.config/playwrong`.
- Runtime files:
  - registry: `~/.config/playwrong/plugins/registry.json`
  - installed plugins: `~/.config/playwrong/plugins/installed/<pluginId>`

Server runtime config file:

- Path: `~/.config/playwrong/config.toml`
- Supported keys:

```toml
[server]
# Optional. Omit for no per-request timeout.
extension_request_timeout_ms = 0

# Optional. Grace period before reporting "No extension is connected".
extension_connect_grace_ms = 10000

# Optional. WebSocket idle timeout in seconds. 0 means never idle-timeout.
websocket_idle_timeout_seconds = 0
```

Required manifest fields

- `schemaVersion` protocol schema version
- `pluginId` unique plugin id
- `name` display name
- `version` semantic version
- `entry` relative TypeScript/JavaScript entry path
- `skill.path` relative skill document path
- `match.hosts` host matching rule
- `match.paths` path matching rule

Runtime plugin modules are discovered from `/mapping-plugins/runtime` and loaded from `/mapping-plugins/runtime/module/<pluginId>` by extension at request time.
Server compiles each enabled plugin `entry` to a bundled JS module (via `bun build`) and delivers module URLs dynamically.
Dynamic plugin install/enable/disable does not require extension rebuild.
For MAIN world access, plugins should use SDK helper `invokeInMainWorld` (message type `playwrong.mainworld.invoke`) only.
Do not depend on action-specific custom channels.

Skill document pointed by `skill.path` must include the following sections.

- `Usage`
- `Operations` or `Functions`
- `Failure Modes`

If current page is unsupported, throw `new Error` with value `PLUGIN_MISS`.

Specification document: `plugins/PLUGIN_SPEC.md`.

### Mapping Plugin Management via CLI

List mapping plugins

```bash
bun apps/cli/src/index.ts mapping-plugins list --endpoint http://127.0.0.1:7878
```

Install mapping plugin from git

```bash
bun apps/cli/src/index.ts mapping-plugins install --endpoint http://127.0.0.1:7878 --repo-url <GIT_URL> --enabled true
```

Inspect enabled runtime packs

```bash
curl -s http://127.0.0.1:7878/mapping-plugins/runtime | jq
```

Enable or disable mapping plugin

```bash
bun apps/cli/src/index.ts mapping-plugins enable --endpoint http://127.0.0.1:7878 --id example.http.plugin
bun apps/cli/src/index.ts mapping-plugins disable --endpoint http://127.0.0.1:7878 --id example.http.plugin
```

Uninstall mapping plugin

```bash
bun apps/cli/src/index.ts mapping-plugins uninstall --endpoint http://127.0.0.1:7878 --id example.http.plugin
```

Reload mapping plugin runtime modules

```bash
bun apps/cli/src/index.ts mapping-plugins reload --endpoint http://127.0.0.1:7878
```

`reload` recompiles enabled plugin entries into runtime modules; extension rebuild is skipped.

Use skill `.opencarapace/skills/playwrong-plugin-authoring` to guide mapping plugin implementation and validation with this command set.

### LLM Interaction Contract

Core operations

1. `pull` reads XML snapshot and editable mapping.
2. `apply` writes local editable changes back to page state.
3. `call` executes element or page function.

### LLM Web Operation Compatibility Contract (v2)

To keep agent behavior deterministic across heterogeneous websites, all action results should follow a stable receipt envelope.

For successful `call` actions (including plugin `invoke`):

```json
{
  "ok": true,
  "contractVersion": "llm_webop_v2",
  "action": {
    "targetId": "page|node.id",
    "fn": "functionName"
  },
  "page": {
    "urlBefore": "https://example.com/before",
    "urlAfter": "https://example.com/after"
  },
  "diagnostics": {
    "usedSelector": "optional selector or strategy hint",
    "domChanged": true
  },
  "recovery": {
    "retryable": true,
    "suggestedNext": "sync_then_pull"
  },
  "data": {
    "pluginSpecific": "payload"
  }
}
```

For failures, return a typed error at the boundary (or throw a plugin error that maps to one):

```json
{
  "ok": false,
  "error_code": "NOT_FOUND|NOT_VISIBLE|DETACHED|NAVIGATION_TIMEOUT|BLOCKED_BY_MODAL|PLUGIN_MISS|ACTION_FAIL",
  "retryable": true,
  "suggestedNext": "retry_same_action|sync_then_pull|close_modal_then_retry",
  "message": "short actionable reason"
}
```

Compatibility rules:

- Keep `pull -> apply/call -> pull` as the default stabilization loop.
- Prefer id-based actions and stable references over repeated free-form selector exploration.
- Every plugin should expose at least one non-side-effect `debug*` page function to surface current DOM/actionability context.
- Recovery must be explicit: include whether retry is safe and what the next step should be.

Conflict rule

- `REV_MISMATCH` means local state is stale
- run `pull` again before retry

### Stability Policy

Stability logic is configured in `apps/extension/src/user-scripts/index.ts`.

Available strategy groups

- simple rule configuration with k threshold, timeout, and sampling interval
- custom `isStable` logic in plugin scripts

Default behavior requires continuous success across k samples, plus URL stability, pending request status, and DOM mutation signals.

### Developer E2E Suites

These suites are mainly for local development and integration debugging.

```bash
bun run test:e2e:browser-google
bun run test:e2e:browser-google:real
bun run test:e2e:capability-10-sites
bun run test:e2e:codex-google
bun run test:e2e:codex-google:real
```

### Testing

Type and full test suite

```bash
bun run typecheck
bun test
```

Plugin management suites

```bash
bun test tests/unit/plugin-manager.spec.ts
bun test tests/e2e/plugin-manager-http.spec.ts
```

### Server API

- `GET /health`
- `GET /extension/status`
- `GET /pages`
- `GET /pages/remote`
- `GET /mapping-plugins`
- `POST /sync/page`
- `POST /sync/all`
- `POST /pull`
- `POST /apply`
- `POST /call`
- `POST /mapping-plugins/install`
- `POST /mapping-plugins/set-enabled`
- `POST /mapping-plugins/uninstall`
- `POST /mapping-plugins/generate`
- `POST /mapping-plugins/apply`
- `POST /mapping-plugins/reload`

Compatibility note

- Legacy `/plugins` endpoints are still supported for backward compatibility.

### Repository Layout

```text
apps/
  cli/
  server/
  extension/
packages/
  protocol/
  plugin-sdk/
plugins/
  PLUGIN_SPEC.md
  examples/
  installed/
.opencarapace/
  skills/
    playwrong-plugin-authoring/
skills/
  playwrong-google-search-fastpath/
tests/
  unit/
  e2e/
```

### Troubleshooting

`Extension websocket not connected`

- verify extension build is loaded from `apps/extension/dist`
- refresh target page to ensure content script injection

`Expected pageType=google.search`

- verify current page is Google search context
- run `pages-remote` and then run `sync`

`REV_MISMATCH`

- local editable files are stale
- run `pull` and retry

Real Google suite may fail intermittently due to consent pages, anti-bot checks, or region routing changes.

### Documents

- `docs/SPEC.md`
- `docs/V2.md`

---

## 中文说明

### 项目简介

Playwrong 是面向生产场景的浏览器自动化桥接层。  
项目将网页状态抽象为结构化 XML，并通过统一协议 `pull`、`apply`、`call` 与 LLM 协同执行交互。

### 核心能力

- 生成可读、可对比的页面 XML 快照
- 提取可编辑字段并支持确定性回写
- 提供节点级与页面级函数调用模型
- 支持映射插件化站点适配与领域流程扩展
- 提供 CLI 与扩展协同运行模式

### 架构组成

- `apps/cli` 提供 serve、sync、pull、apply、call、mapping-plugins 等命令入口
- `apps/server` 提供 HTTP 与 WebSocket 网关
- `apps/extension` 负责 Chrome MV3 侧脚本与桥接通信
- `packages/protocol` 定义协议类型、XML 渲染与错误模型
- `packages/plugin-sdk` 提供匹配器、定位器与插件接口
- `plugins` 存放映射插件规范、示例、安装目录与注册状态
- `skills` 存放 Codex 自动化流程能力，包含映射插件编写流程

### LLM 接收 XML 示例

`pull` 返回的 JSON 中，`xml` 字段就是 LLM 直接读取的页面结构。

```xml
<page id="tab:123456" rev="42" pageType="google.search" url="https://www.google.com/search?q=playwrong+llm+automation" title="playwrong llm automation - Google Search">
  <functionCall name="search" sideEffect="true"/>
  <section id="search.root" label="Google Search">
    <editable id="search.query" label="Query">
      playwrong llm automation
    </editable>
    <action id="search.submit" label="Google Search"/>
    <list id="search.results">
      <item id="search.result.1">
        <content id="search.result.1.title">Playwrong - GitHub</content>
        <action id="search.result.1.open" label="Open result"/>
      </item>
    </list>
    <action id="search.pagination.next" label="Next page"/>
  </section>
</page>
```

### 快速开始

环境要求

- Bun 版本 1.3 或更新版本
- Chromium 或 Chrome
- macOS 或 Linux

安装依赖

```bash
bun install
```

启动服务

```bash
bun run cli:serve
```

编译浏览器扩展

```bash
bun run build:extension
```

安装浏览器扩展

在 Chrome 扩展页面开启开发者模式，并加载 `apps/extension/dist`。

### 手动联调流程

启动服务

```bash
bun run cli:serve
```

编译浏览器扩展

```bash
bun run build:extension
```

安装浏览器扩展

在 Chrome 扩展页面开启开发者模式，并加载 `apps/extension/dist`。

查看远端页面

```bash
bun apps/cli/src/index.ts pages-remote --endpoint http://127.0.0.1:7878
```

同步并拉取状态

```bash
bun apps/cli/src/index.ts sync --endpoint http://127.0.0.1:7878 --page tab:123456
bun apps/cli/src/index.ts pull --endpoint http://127.0.0.1:7878 --page tab:123456 --state-dir .bridge
```

`pull` 现在会落盘 XML、editable 文件，以及默认截图 `.bridge/pages/tab:123456/screenshot.png`。

修改后回写页面

```bash
printf 'playwrong llm automation\n' > .bridge/pages/tab:123456/editable/search.query.txt
bun apps/cli/src/index.ts apply --endpoint http://127.0.0.1:7878 --page tab:123456 --state-dir .bridge
```

调用函数

```bash
bun apps/cli/src/index.ts call --endpoint http://127.0.0.1:7878 --page tab:123456 --id page --fn search --args '{"query":"playwrong llm automation"}'
```

### 映射插件体系

映射插件仓库根目录需要提供 `playwrong.plugin.json`。

映射插件运行态存储隔离：

- 插件安装与注册状态不写入当前仓库。
- 根目录固定为 `~/.config/playwrong`。
- 运行态路径：
  - registry：`~/.config/playwrong/plugins/registry.json`
  - 已安装插件：`~/.config/playwrong/plugins/installed/<pluginId>`

server 运行时配置文件：

- 路径：`~/.config/playwrong/config.toml`
- 支持字段：

```toml
[server]
# 可选。不配置表示不启用单次请求超时。
extension_request_timeout_ms = 0

# 可选。扩展未连接时等待重连的宽限时间（毫秒）。
extension_connect_grace_ms = 10000

# 可选。WebSocket 空闲超时（秒）。0 表示不因空闲断开。
websocket_idle_timeout_seconds = 0
```

关键字段

- `schemaVersion`
- `pluginId`
- `name`
- `version`
- `entry`
- `skill.path`
- `match.hosts`
- `match.paths`

extension 会先通过 `/mapping-plugins/runtime` 读取插件元数据，再通过 `/mapping-plugins/runtime/module/<pluginId>` 动态加载模块。
server 会把每个启用插件的 `entry` 用 `bun build` 编译为 JS bundle，并以 runtime URL 方式下发。
安装/启停插件无需重打包 extension。
MAIN world 访问统一通过 SDK 的 `invokeInMainWorld`（`playwrong.mainworld.invoke`）。
不要依赖动作特化的自定义通道。

`skill.path` 指向的文档必须包含以下章节。

- `Usage`
- `Operations` 或 `Functions`
- `Failure Modes`

插件入口支持以下导出形式。

- `export const pluginScripts`
- `export default`

当页面不匹配时，返回 `PLUGIN_MISS` 错误。

完整规范见 `plugins/PLUGIN_SPEC.md`。

### 通过 CLI 管理映射插件

查看映射插件列表

```bash
bun apps/cli/src/index.ts mapping-plugins list --endpoint http://127.0.0.1:7878
```

从 git 安装映射插件

```bash
bun apps/cli/src/index.ts mapping-plugins install --endpoint http://127.0.0.1:7878 --repo-url <GIT_URL> --enabled true
```

查看已启用 runtime packs

```bash
curl -s http://127.0.0.1:7878/mapping-plugins/runtime | jq
```

启用或禁用映射插件

```bash
bun apps/cli/src/index.ts mapping-plugins enable --endpoint http://127.0.0.1:7878 --id example.http.plugin
bun apps/cli/src/index.ts mapping-plugins disable --endpoint http://127.0.0.1:7878 --id example.http.plugin
```

卸载映射插件

```bash
bun apps/cli/src/index.ts mapping-plugins uninstall --endpoint http://127.0.0.1:7878 --id example.http.plugin
```

重载映射插件运行时模块

```bash
bun apps/cli/src/index.ts mapping-plugins reload --endpoint http://127.0.0.1:7878
```

`reload` 会重新编译已启用插件 entry 到运行时模块，不重建扩展。

建议使用 `.opencarapace/skills/playwrong-plugin-authoring` 作为映射插件编写与验证流程的统一指导。

兼容说明

- 仍支持旧的 `/plugins` 路由，便于平滑迁移。

### 协议模型

核心操作

1. `pull` 获取 XML 与 editable 映射
2. `apply` 批量回写本地修改
3. `call` 调用节点级或页面级函数

冲突规则

- `REV_MISMATCH` 表示本地状态过期
- 需先执行 `pull` 再重试

### 稳定性策略

配置位置为 `apps/extension/src/user-scripts/index.ts`。

支持两类策略

- 简单规则配置，包含 k 阈值、超时与采样间隔
- 在插件脚本中实现自定义 `isStable`

默认策略要求连续 k 次采样满足条件，并结合 URL 稳定性、请求状态与 DOM 变更信号共同判定。

### 开发联调 E2E 套件

以下用例主要用于本地开发与联调排障。

```bash
bun run test:e2e:browser-google
bun run test:e2e:browser-google:real
bun run test:e2e:capability-10-sites
bun run test:e2e:codex-google
bun run test:e2e:codex-google:real
```

### 测试命令

类型检查与全量测试

```bash
bun run typecheck
bun test
```

插件管理测试

```bash
bun test tests/unit/plugin-manager.spec.ts
bun test tests/e2e/plugin-manager-http.spec.ts
```

### 常见问题

`Extension websocket not connected`

- 确认已加载 `apps/extension/dist`
- 刷新页面，确保注入 content script

`Expected pageType=google.search`

- 当前页面不是 Google 搜索上下文
- 先执行 `pages-remote`，再执行 `sync`

`REV_MISMATCH`

- 本地 editable 文件版本过旧
- 重新执行 `pull` 后重试

真实 Google 用例可能因 consent 页面、反机器人策略或地区路由变化出现偶发失败。

### 参考文档

- `docs/SPEC.md`
- `docs/V2.md`
