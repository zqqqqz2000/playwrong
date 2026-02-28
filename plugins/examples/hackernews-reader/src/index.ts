import type { PluginScript } from "@playwrong/plugin-sdk";
import type { PluginExtractResult, SemanticNode } from "@playwrong/protocol";

function text(input: string | null | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

function extractStories(): SemanticNode[] {
  const rows = Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.athing"));
  const items: SemanticNode[] = [];

  for (let i = 0; i < rows.length && i < 20; i += 1) {
    const row = rows[i];
    const anchor = row.querySelector<HTMLAnchorElement>(".titleline > a");
    if (!anchor) {
      continue;
    }

    const label = text(anchor.textContent) || `Story ${i + 1}`;
    const href = anchor.href || "";
    items.push({
      id: `hn.story.${i + 1}`,
      kind: "item",
      label,
      children: [
        {
          id: `hn.story.${i + 1}.open`,
          kind: "action",
          label,
          value: label,
          attrs: href ? { href } : undefined,
          calls: [{ name: "click", sideEffect: true }]
        }
      ]
    });
  }

  return items;
}

function findNodeById(tree: SemanticNode[], id: string): SemanticNode | null {
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.shift();
    if (!node) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return null;
}

export const pluginScripts: PluginScript[] = [
  {
    scriptId: "example.hackernews.reader.v1",
    priority: 650,
    rules: [{ hosts: ["news.ycombinator.com"], paths: ["/", "/news", "/newest", "/best"] }],
    async extract(): Promise<PluginExtractResult> {
      const stories = extractStories();
      return {
        pageType: "hackernews.list",
        tree: [
          {
            id: "hn.story.list",
            kind: "list",
            label: "Hacker News Stories",
            children: stories
          }
        ],
        pageCalls: [{ name: "refresh", sideEffect: true }]
      };
    },
    async setValue(): Promise<void> {
      throw new Error("PLUGIN_MISS");
    },
    async invoke(ctx, fn): Promise<unknown> {
      if (!/^hn\.story\.\d+\.open$/.test(ctx.target.id) || fn !== "click") {
        throw new Error("PLUGIN_MISS");
      }

      const node = findNodeById(ctx.tree, ctx.target.id);
      const href = typeof node?.attrs?.href === "string" ? node.attrs.href : "";
      if (!href) {
        throw new Error("PLUGIN_MISS");
      }

      window.location.href = href;
      return { ok: true, href };
    }
  }
];
