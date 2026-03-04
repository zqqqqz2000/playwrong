import type { PluginScript } from "@playwrong/plugin-sdk";
import type { FunctionCallDef, PluginExtractResult, SemanticNode } from "@playwrong/protocol";

const QUERY_SELECTOR = "#searchInput, input[name='search']";
const SUBMIT_SELECTOR = "button.cdx-search-input__end-button, button[type='submit']";
const ARTICLE_SELECTOR = "#mw-content-text a[href^='/wiki/']";
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

function buildDebugSurface(): Record<string, unknown> {
  const queryInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(QUERY_SELECTOR);
  const submitButton = document.querySelector<HTMLElement>(SUBMIT_SELECTOR);
  const results = extractResultNodes();
  return {
    url: window.location.href,
    title: document.title,
    hasQueryInput: Boolean(queryInput),
    hasSubmitButton: Boolean(submitButton),
    queryPreview: (queryInput?.value ?? "").slice(0, 120),
    resultCount: results.length,
    resultActionIds: results
      .map((item) => item.children?.[0]?.id)
      .filter((id): id is string => typeof id === "string")
  };
}

function extractResultNodes(): SemanticNode[] {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(ARTICLE_SELECTOR))
    .filter((anchor) => text(anchor.textContent).length > 0)
    .slice(0, 8);

  const items: SemanticNode[] = [];
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const label = text(link?.textContent) || `Article ${i + 1}`;
    const href = link?.href || "";
    items.push({
      id: `wiki.result.${i + 1}`,
      kind: "item",
      label,
      children: [
        {
          id: `wiki.result.${i + 1}.open`,
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
    const current = stack.shift();
    if (!current) {
      continue;
    }
    if (current.id === id) {
      return current;
    }
    if (current.children?.length) {
      stack.push(...current.children);
    }
  }
  return null;
}

const pageCalls: FunctionCallDef[] = [
  {
    name: "search",
    sideEffect: true,
    argsSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    }
  },
  { name: "refresh", sideEffect: true },
  { name: "debugSurface", sideEffect: false }
];

export const pluginScripts: PluginScript[] = [
  {
    scriptId: "example.wikipedia.search.v1",
    priority: 700,
    rules: [
      {
        hosts: ["*.wikipedia.org"],
        paths: ["/wiki/*", "/w/index.php"]
      }
    ],
    async extract(): Promise<PluginExtractResult> {
      const queryInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(QUERY_SELECTOR);
      const queryValue = queryInput?.value ?? "";

      const tree: SemanticNode[] = [
        {
          id: "wiki.search.form",
          kind: "form",
          label: "Wikipedia Search",
          children: [
            {
              id: "wiki.search.query",
              kind: "editable",
              label: "Search Query",
              value: queryValue,
              calls: [
                { name: "focus", sideEffect: false },
                { name: "submit", sideEffect: true }
              ]
            },
            {
              id: "wiki.search.submit",
              kind: "action",
              label: "Search",
              value: "Search",
              calls: [{ name: "click", sideEffect: true }]
            }
          ]
        }
      ];

      const results = extractResultNodes();
      if (results.length > 0) {
        tree.push({
          id: "wiki.search.results",
          kind: "list",
          label: "Search Results",
          children: results
        });
      }

      return {
        pageType: "wikipedia.page",
        tree,
        pageCalls
      };
    },
    async setValue(ctx, value): Promise<void> {
      if (ctx.target.id !== "wiki.search.query") {
        throw new Error("PLUGIN_MISS");
      }

      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(QUERY_SELECTOR);
      if (!input) {
        throw new Error("PLUGIN_MISS");
      }

      input.value = String(value ?? "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    async invoke(ctx, fn, args): Promise<unknown> {
      const urlBefore = window.location.href;

      if (ctx.target.id === "page" && fn === "refresh") {
        window.location.reload();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore);
      }

      if (ctx.target.id === "page" && fn === "search") {
        const query = typeof args?.query === "string" ? args.query : "";
        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(QUERY_SELECTOR);
        const submit = document.querySelector<HTMLElement>(SUBMIT_SELECTOR);
        if (!input || !submit) {
          throw new Error("PLUGIN_MISS");
        }
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        submit.click();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, { query }, { usedSelector: `${QUERY_SELECTOR} -> ${SUBMIT_SELECTOR}` });
      }

      if (ctx.target.id === "page" && fn === "debugSurface") {
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, buildDebugSurface(), {
          retryable: false,
          suggestedNext: "none"
        });
      }

      if ((ctx.target.id === "wiki.search.submit" || ctx.target.id === "wiki.search.query") && (fn === "click" || fn === "submit")) {
        const submit = document.querySelector<HTMLElement>(SUBMIT_SELECTOR);
        if (!submit) {
          throw new Error("PLUGIN_MISS");
        }
        submit.click();
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, {}, { usedSelector: SUBMIT_SELECTOR });
      }

      if (/^wiki\.result\.\d+\.open$/.test(ctx.target.id) && fn === "click") {
        const node = findNodeById(ctx.tree, ctx.target.id);
        const href = typeof node?.attrs?.href === "string" ? node.attrs.href : "";
        if (!href) {
          throw new Error("PLUGIN_MISS");
        }
        window.location.href = href;
        return withInvokeReceipt(ctx.target.id, fn, urlBefore, { href });
      }

      throw new Error("PLUGIN_MISS");
    }
  }
];
