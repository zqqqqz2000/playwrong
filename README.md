# Playwrong

把浏览器网页抽象成 LLM 可读/可操作的 XML，并通过统一协议 `pull / apply / call` 完成交互。

## 快速使用（先跑通）

### 1. 环境准备
- Bun 1.3+
- Chromium/Chrome（E2E 会自动拉起）
- macOS/Linux（当前脚本主要在这两者验证）

```bash
bun install
```

### 2. 一键跑通（推荐先跑）

#### 框架主链路 E2E（扩展 + server + 协议）
```bash
bun run test:e2e:browser-google
```

#### Codex CLI + Skill 快路径 E2E
```bash
bun run test:e2e:codex-google
```

#### 真实 Google（严格模式，不跳过）
```bash
bun run test:e2e:browser-google:real
bun run test:e2e:codex-google:real
```

> 这四条命令会验证：输入关键词、触发搜索、提取结果列表、翻页节点存在，以及 `google.search` 抽象生效。

---

## 手动联调（CLI + Chrome 扩展）

### 1. 构建扩展
```bash
bun run --cwd apps/extension build
```
产物目录：`apps/extension/dist`

### 2. 在 Chrome 加载扩展
1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择目录 `apps/extension/dist`

### 3. 启动服务（CLI 启 server）
```bash
bun apps/cli/src/index.ts serve --host 127.0.0.1 --port 7878
```

### 4. 查看扩展侧页面
```bash
bun apps/cli/src/index.ts pages-remote --endpoint http://127.0.0.1:7878
```
拿到 `pageId`（通常形如 `tab:123456`）。

### 5. 同步并拉取 XML + editable 文件
```bash
bun apps/cli/src/index.ts sync --endpoint http://127.0.0.1:7878 --page tab:123456
bun apps/cli/src/index.ts pull --endpoint http://127.0.0.1:7878 --page tab:123456 --state-dir .bridge
```

此时会生成：
- XML：`.bridge/pages/tab:123456/state.xml`
- 可编辑文件：`.bridge/pages/tab:123456/editable/*.txt`
- 索引：`.bridge/pages/tab:123456/index.json`

### 6. 修改 editable 后回写页面
```bash
# 例如修改搜索框
printf 'playwrong llm automation\n' > .bridge/pages/tab:123456/editable/search.query.txt

bun apps/cli/src/index.ts apply --endpoint http://127.0.0.1:7878 --page tab:123456 --state-dir .bridge
```

### 7. 调用动作 / 函数
```bash
bun apps/cli/src/index.ts call --endpoint http://127.0.0.1:7878 --page tab:123456 --id page --fn search --args '{"query":"playwrong llm automation"}'
```

---

## LLM 交互模型（核心）

LLM 只需要三类操作：
1. `pull`：获取当前页面 XML 与 editable 映射。
2. `apply`：编辑本地文件后批量回写。
3. `call`：调用节点级或 page 级函数（例如 `click/search/nextPage`）。

冲突策略：
- `REV_MISMATCH` -> 拒绝本次操作，先重新 `pull` 再重试。

---

## Codex Skill 快路径

Skill 目录：`skills/playwrong-google-search-fastpath`

核心脚本：
```bash
bun skills/playwrong-google-search-fastpath/scripts/google_search_fastpath.ts \
  --endpoint http://127.0.0.1:7878 \
  --pageId tab:123456 \
  --query "playwrong llm automation"
```

用于判定“确实走了抽象层”的关键日志：
- `FASTPATH_PAGE_TYPE=google.search`
- `FASTPATH_RESULT_IDS=search.result.N.open...`
- `FASTPATH_NEXT_ACTION=search.pagination.next`

---

## 可配置稳定性（waitForStable）

位置：`apps/extension/src/user-scripts/index.ts`

支持两种方式：
1. 简单规则（k 值/超时/采样间隔等）
- `userSimpleStabilityRules`
2. JS/TS 自定义判定
- `userPluginScripts[].isStable(ctx)`

默认策略是“连续 K 次采样都达标才稳定”，并结合：
- URL 是否稳定
- pending requests
- 最近 DOM mutation 数

---

## 测试命令

### 类型检查 + 全量测试
```bash
bun run typecheck
bun test
```

### 重点 E2E
```bash
bun run test:e2e:browser-google
bun run test:e2e:browser-google:real
bun run test:e2e:codex-google
bun run test:e2e:codex-google:real
```

---

## 目录结构

```text
apps/
  cli/          # bridge CLI（含 serve/pages/sync/pull/apply/call）
  server/       # HTTP + WebSocket gateway + snapshot core
  extension/    # Chrome MV3 扩展（background/content + site scripts）
packages/
  protocol/     # 协议类型、错误码、XML 渲染
  plugin-sdk/   # 匹配器、Locator、插件接口
skills/
  playwrong-google-search-fastpath/   # Codex 快路径 skill
tests/
  unit/         # 单测
  e2e/          # 端到端（含 real-google 与 codex-cli）
```

---

## 关键 API（Server）

- `GET /health`
- `GET /extension/status`
- `GET /pages`
- `GET /pages/remote`
- `POST /sync/page`
- `POST /sync/all`
- `POST /pull`
- `POST /apply`
- `POST /call`

---

## 常见问题

### 1) `Extension websocket not connected`
- 确认扩展已加载 `apps/extension/dist`
- 确认页面已刷新，content script 已注入

### 2) `Expected pageType=google.search`
- 当前页不在 Google 搜索场景
- 先 `pages-remote` 检查 `pageId/url` 再 `sync`

### 3) `REV_MISMATCH`
- 你的本地 editable 不是最新版本
- 重新 `pull` 后再 `apply/call`

### 4) 真实 Google 偶发失败
- 可能触发 consent/anti-bot/地区跳转
- 使用 `:real` 测试时建议独立网络环境重试

---

## 设计文档

- 详细规格：`docs/SPEC.md`
