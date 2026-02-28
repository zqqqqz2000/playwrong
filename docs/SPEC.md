# Playwrong Bridge Spec (v0.1)

## 1. 目标
- 把网页抽象成 LLM 易读的 XML。
- LLM 统一通过 `pull / apply / call` 交互。
- 插件层只做语义映射与动作执行，不感知文件系统。

## 2. 已确认约束
- 插件仅扩展侧执行。
- XML 先不分片。
- 冲突策略：`REV_MISMATCH` 时拒绝并要求重拉。
- 不做敏感字段脱敏。
- 节点结构使用嵌套树，直观优先。

## 3. 架构
- `packages/protocol`: 协议类型、错误码、XML 投影工具。
- `packages/plugin-sdk`: 插件脚本接口、页面匹配器、Locator 解析器。
- `apps/server`: 会话核心、快照管理、HTTP API、扩展 WebSocket RPC 网关。
  - 插件管理 API：`/plugins` 系列路由（git 安装、启停、生成/构建）。
- `apps/cli`: 面向人类/LLM 的命令行入口，负责同步、文件投影与动作调用。
- `apps/extension`: Chrome 插件运行时（`background + content script`），负责提取与执行。
  - 内置站点脚本：`google.search / bing.search / duckduckgo.search`，未命中时回退通用抽取器。
  - 用户可配置脚本：`apps/extension/src/user-scripts/index.ts`
    - 简单规则：`userSimpleStabilityRules`（可配置 `kConsecutive` 等稳定阈值）
    - TS 插件：`userPluginScripts`（可写 `isStable(ctx)` 自定义稳定判定）
    - 托管插件：`managed-plugins.generated.ts`（由 `plugins/registry.json` 生成）

## 4. 职责边界（关键）
- 插件输入：URL/标题/信号上下文。
- 插件输出：`SemanticNode tree` + `functionCall` 能力。
- Server 负责：
  - 生成 `state.xml`
  - 生成/读取 `editable` 文件映射
  - 版本冲突控制
- CLI 负责：
  - `pull` 后落盘 XML 和 editable 文件
  - `apply` 时读取文件并上送 server

## 5. 语义树
- 节点：`group/section/form/list/item/table/row/cell/editable/action/select/toggle/content`
- 可操作叶子节点建议携带 `locator`
- `calls` 可挂在叶子节点，也可挂在 page 级别

## 6. LocatorSpec
- 多策略定位（aria/css/xpath/text/relative）+ 权重
- 可选约束（visible/enabled/unique/tagNames）
- 可选锚点（URL/附近文本/角色）
- 执行流程：候选召回 -> 打分 -> 阈值过滤 -> 歧义检测

## 7. 交互流程
### Pull
1. `bridge sync --page tab:<id>` 或 `bridge sync-all` 触发扩展抽取并 upsert 快照
2. `bridge pull --page p1`
3. 返回 XML + editable 文件清单 + rev

### Apply
1. LLM 修改 editable 文件
2. `bridge apply --page p1`，携带 baseRev
3. server 校验 rev，一致则逐项 setValue
4. 成功后 rev +1；不一致返回 `REV_MISMATCH`

### Call
1. `bridge call --page p1 --id login.submit --fn click`
2. 校验函数声明
3. 插件执行 invoke，必要时 rev +1

## 8. 多页面
- `session -> pages[]`
- 页面标识采用 `tab:<tabId>`，每页独立 `pageId/rev/index.json/state.xml/editable/*`
- ID 在 page 内唯一

## 12. 运行命令
- 启动服务：`bridge serve`
- 插件管理 UI：在 Chrome 扩展 popup 内使用
- 查看扩展远端页面：`bridge pages-remote`
- 同步单页：`bridge sync --page tab:123`
- 同步全部：`bridge sync-all`
- 拉取本地投影：`bridge pull --page tab:123`
- 回写编辑：`bridge apply --page tab:123`
- 调用动作：`bridge call --page tab:123 --id login.submit --fn click`

## 13. 扩展构建
- 构建命令：`bun run --cwd apps/extension build`
- 产物目录：`apps/extension/dist`
- 直接加载 `dist/manifest.json` 到 Chrome 开发者模式即可联调

## 9. Playwright 兼容策略
- 外层可由 Playwright 自动编排页面生命周期
- 语义抽取与动作执行仍走同一扩展协议
- LLM 仍只感知 `pull/apply/call`

## 10. 错误码
- `REV_MISMATCH`
- `NOT_FOUND`
- `AMBIGUOUS`
- `INVALID_REQUEST`
- `INVALID_TREE`
- `INVALID_NODE_KIND`
- `UNDECLARED_FUNCTION`
- `PLUGIN_MISS`
- `ACTION_FAIL`
- `INTERNAL_ERROR`

## 11. 测试策略
- 单元测试：匹配、定位、投影、核心状态机。
- E2E 测试：pull/apply/call 全链路、多页面、冲突。
- 网页匹配逻辑：参数化海量用例（host/path/query/signals/title）。
- 真实浏览器联调：`bun run test:e2e:browser-google`（扩展 + server + CLI 协议 + 页面状态变化观测）。
- Codex CLI 联调：`bun run test:e2e:codex-google`（真实调用 codex + skill 快路径脚本，校验 `google.search` 抽象与结果节点证据）。

## 14. Codex Skill 快路径
- Skill 目录：`skills/playwrong-google-search-fastpath`
- 目标：让 Codex 在 E2E 中直接执行固定命令，不做大范围探索。
- 主命令：
  - `bun skills/playwrong-google-search-fastpath/scripts/google_search_fastpath.ts --endpoint http://127.0.0.1:7878 --pageId <PAGE_ID> --query \"playwrong llm automation\"`
- 关键日志（用于判定是否走抽象）：
  - `FASTPATH_PAGE_TYPE=google.search`
  - `FASTPATH_RESULT_IDS=search.result.N.open...`
  - `FASTPATH_NEXT_ACTION=search.pagination.next`

## 15. 插件包规范
- 插件仓库必须含 `playwrong.plugin.json`
- `match.hosts/paths` 声明插件网站作用域
- `entry` 导出 `pluginScripts` 或 `default`（`PluginScript[]`）
- 服务端支持 `git clone` 安装到 `plugins/installed/*`
- 用户可在 UI 或 API 中配置插件启用/禁用
