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
- `pluginId`: 全局唯一，建议小写+点分命名
- `entry`: 插件入口 TS 文件（相对路径）
- `skill.path`: 插件 skill 文档路径（相对路径，必填）
- `match`: 插件生效网站范围（至少提供 `hosts` 或 `paths` 之一）

## 2. Skill 文档要求（必填）

`skill.path` 指向的文档必须存在，并包含以下内容：
- Usage：描述插件如何使用
- Operations / Functions：描述可调用操作和函数

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
```

## 3. Entry 导出约定

`entry` 文件应导出以下之一：
- `export const pluginScripts: PluginScript[] = [...]`
- `export default PluginScript[]`

脚本接口使用 `@playwrong/plugin-sdk` 中的 `PluginScript`。

## 4. 行为约定

- 插件无法处理当前页面或动作时，抛出 `new Error("PLUGIN_MISS")`。
- `extract` 只负责语义映射，不做文件投影。
- `setValue` / `invoke` 只操作 DOM 与页面行为。

## 5. 生效范围

- `manifest.match` 会作为强制作用域注入到脚本匹配规则。
- 即使脚本内部 `rules` 更宽，也不会越过 manifest 声明的网站范围。

## 6. 示例

- `plugins/examples/wikipedia-search`
- `plugins/examples/hackernews-reader`
- `plugins/examples/github-repo-manager`
