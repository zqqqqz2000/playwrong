import type { PluginScript } from "@playwrong/plugin-sdk";
import type { FunctionCallDef, PluginExtractResult, SemanticNode } from "@playwrong/protocol";

const RECEIPT_VERSION = "llm_webop_v2";

function text(input: string | null | undefined): string {
  return (input ?? "").replace(/\s+/g, " ").trim();
}

interface InvokeReceiptOptions {
  usedSelector?: string;
  retryable?: boolean;
  suggestedNext?: string;
}

function withInvokeReceipt(
  targetId: string,
  fn: string,
  urlBefore: string,
  data: Record<string, unknown> = {},
  options: InvokeReceiptOptions = {}
): Record<string, unknown> {
  return {
    ...data,
    ok: true,
    contractVersion: RECEIPT_VERSION,
    action: {
      targetId,
      fn
    },
    page: {
      urlBefore,
      urlAfter: window.location.href
    },
    diagnostics: {
      usedSelector: options.usedSelector ?? null
    },
    recovery: {
      retryable: options.retryable ?? true,
      suggestedNext: options.suggestedNext ?? "sync_then_pull"
    }
  };
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

function buildDebugStoriesPayload(): Record<string, unknown> {
  const stories = extractStories();
  return {
    url: window.location.href,
    title: document.title,
    storyCount: stories.length,
    storyActionIds: stories
      .map((item) => item.children?.[0]?.id)
      .filter((id): id is string => typeof id === "string")
  };
}

const PAGE_CALLS: FunctionCallDef[] = [
  { name: "refresh", sideEffect: true },
  { name: "debugStories", sideEffect: false }
];

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
        pageCalls: PAGE_CALLS
      };
    },
    async setValue(): Promise<void> {
      throw new Error("PLUGIN_MISS");
    },
    async invoke(ctx, fn): Promise<unknown> {
      const urlBefore = window.location.href;

      if (ctx.target.id === "page" && fn === "refresh") {
        window.location.reload();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore);
      }

      if (ctx.target.id === "page" && fn === "debugStories") {
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, buildDebugStoriesPayload(), {
          retryable: false,
          suggestedNext: "none"
        });
      }

      if (!/^hn\.story\.\d+\.open$/.test(ctx.target.id) || fn !== "click") {
        throw new Error("PLUGIN_MISS");
      }

      const node = findNodeById(ctx.tree, ctx.target.id);
      const href = typeof node?.attrs?.href === "string" ? node.attrs.href : "";
      if (!href) {
        throw new Error("PLUGIN_MISS");
      }

      window.location.href = href;
      return withInvokeReceipt(ctx.target.id, fn, urlBefore, { href }, { usedSelector: ".titleline > a" });
    }
  }
];
