# Playwrong Plugin Pack Spec

每个插件仓库必须在根目录提供 `playwrong.plugin.json`。

## 1. Manifest

```json
{
  "schemaVersion": 1,
  "pluginId": "example.wikipedia.search",
  "name": "Wikipedia Search Helper",
  "version": "0.1.0",
  "description": "optional",
  "entry": "src/index.ts",
  "skill": {
    "path": "SKILL.md"
  },
  "match": {
    "hosts": ["*.wikipedia.org"],
    "paths": ["/wiki/*", "/w/index.php"]
  }
}
```

字段说明：
- `schemaVersion`: 当前固定为 `1`
- `pluginId`: 全局唯一，必须小写点分命名（`^[a-z0-9][a-z0-9._-]{1,127}$`）
- `version`: semver 样式（如 `0.1.0`、`1.2.3-beta.1`）
- `entry`: 必填，插件入口 TS/JS 文件（相对路径）
- `skill.path`: 插件 skill 文档路径（相对路径，必填）
- `match`: 插件生效网站范围（至少提供 `hosts` 或 `paths` 之一）

`match` 约束：
- `hosts` 只能是 host pattern，不能带 `http://`、`https://`、`/`、端口号。
- `hosts` 必须小写，支持通配（如 `*.wikipedia.org`）。
- `paths` 必须以 `/` 或 `^` 开头（普通路径或正则字符串）。

## 2. Skill 文档要求（必填）

`skill.path` 指向的文档必须存在，并包含以下内容：
- YAML frontmatter，且至少有 `name` / `description`
- Usage：描述插件如何使用
- Operations / Functions：描述可调用操作和函数
- Failure Modes：列出常见失败与恢复动作

推荐模板：

```md
---
name: your-plugin-skill
description: explain when and how to use this plugin
---

# Your Plugin Skill

## Usage
1. ...
2. ...

## Operations
- Page functions: ...
- Node functions: ...

## Failure Modes
- PLUGIN_MISS: ...
- ACTION_FAIL: ...
```

## 3. Entry 导出约定（必填）

`entry` 文件应导出以下之一：
- `export const pluginScripts: PluginScript[] = [...]`
- `export default PluginScript[]`

server 会在插件安装/启用/重载时，使用 `bun build` 将 `entry` 打包为运行时 JS 模块；
extension 在请求时通过 `GET /mapping-plugins/runtime` 动态获取并加载该模块。

## 4. 行为约定

- 插件无法处理当前页面或动作时，抛出 `new Error("PLUGIN_MISS")`。
- `extract` 只负责语义映射，不做文件投影。
- `setValue` / `invoke` 只操作 DOM 与页面行为。
- 对导航型动作（提交、跳转）必须保证可重试，不依赖单次句柄。
- 建议提供至少一个无副作用 `debug` page function（用于回传当前可识别节点/表单）。

## 5. 生效范围

- `manifest.match` 会作为强制作用域注入到脚本匹配规则。
- 即使脚本内部 `rules` 更宽，也不会越过 manifest 声明的网站范围。

## 6. 稳定性开发检查单（新增）

每次新增站点插件，至少完成以下检查：
- 链路检查：`/health -> /pages/remote -> /sync/page -> /pull` 全部成功。
- 命中检查：`sync/page` 返回的 `pageType`、`pageCalls`、关键节点 id 符合预期。
- 动作检查：至少覆盖 1 个 `setValue`、1 个 `call`、1 次动作后状态变化验证。
- 冲突检查：故意使用旧 `baseRev`，验证系统返回 `REV_MISMATCH` 且流程可恢复。
- 失败检查：验证 `PLUGIN_MISS` 与至少 1 个业务失败路径（如目标节点不存在）。

## 7. 示例

- `plugins/examples/wikipedia-search`
- `plugins/examples/hackernews-reader`
- `plugins/examples/github-repo-manager`
