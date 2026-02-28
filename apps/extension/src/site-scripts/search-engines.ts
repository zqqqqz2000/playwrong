import type { PluginScript } from "@playwrong/plugin-sdk";
import type {
  FunctionCallDef,
  LocatorSpec,
  LocatorStrategy,
  ScalarValue,
  SemanticNode
} from "@playwrong/protocol";

interface SearchEngineConfig {
  scriptId: string;
  pageType: string;
  hosts: string[];
  titleTokens: string[];
  inputSelectors: string[];
  submitSelectors: string[];
  resultTitleSelectors: string[];
  nextPageSelectors: string[];
}

interface ScriptError extends Error {
  code: string;
  details: Record<string, unknown> | undefined;
}

const SEARCH_PAGE_CALLS: FunctionCallDef[] = [
  { name: "refresh", sideEffect: true },
  {
    name: "scrollTo",
    sideEffect: true,
    argsSchema: {
      type: "object",
      properties: {
        top: { type: "number" },
        left: { type: "number" }
      }
    }
  },
  {
    name: "goto",
    sideEffect: true,
    argsSchema: {
      type: "object",
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    }
  },
  {
    name: "search",
    sideEffect: true,
    argsSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"]
    }
  },
  {
    name: "nextPage",
    sideEffect: true
  }
];

const ENGINE_CONFIGS: SearchEngineConfig[] = [
  {
    scriptId: "google.search",
    pageType: "google.search",
    hosts: ["google.com", "www.google.com", "*.google.*"],
    titleTokens: ["google"],
    inputSelectors: ["textarea[name='q']", "input[name='q']"],
    submitSelectors: ["button[type='submit']", "input[name='btnK']"],
    resultTitleSelectors: ["#search a h3", ".g a h3", "a h3"],
    nextPageSelectors: ["a#pnnext", "a[aria-label='Next page']", "a[aria-label='Next']", "a[aria-label='下一页']"]
  },
  {
    scriptId: "bing.search",
    pageType: "bing.search",
    hosts: ["bing.com", "www.bing.com"],
    titleTokens: ["bing"],
    inputSelectors: ["textarea[name='q']", "input[name='q']"],
    submitSelectors: ["button[type='submit']", "input[type='submit']"],
    resultTitleSelectors: ["#b_results li.b_algo h2 a", "#b_results h2 a", "h2 a"],
    nextPageSelectors: ["a.sb_pagN", "a[title='Next page']", "a[aria-label='Next page']"]
  },
  {
    scriptId: "duckduckgo.search",
    pageType: "duckduckgo.search",
    hosts: ["duckduckgo.com", "www.duckduckgo.com"],
    titleTokens: ["duckduckgo"],
    inputSelectors: ["input[name='q']", "textarea[name='q']"],
    submitSelectors: ["button[type='submit']", "input[type='submit']"],
    resultTitleSelectors: ["article a h2", "[data-testid='result-title-a']"],
    nextPageSelectors: ["a.result--more__btn", "button.result--more__btn", "a[aria-label='Next']"]
  }
];

function makeError(code: string, message: string, details?: Record<string, unknown>): ScriptError {
  const error = new Error(message) as ScriptError;
  error.code = code;
  error.details = details;
  return error;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  const normalized = normalizeText(value).toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  return slug || "item";
}

function escapeCssValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return true;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function buildCssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const elementId = current.getAttribute("id");
    if (elementId) {
      parts.push(`${tag}#${escapeCssValue(elementId)}`);
      break;
    }

    let part = tag;
    if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children).filter(
        (candidate) => candidate.tagName === current?.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.push(part);
    current = current.parentElement;
  }

  parts.reverse();
  return parts.join(" > ");
}

function markSemanticId(element: Element, semanticId: string): void {
  if (element instanceof HTMLElement) {
    element.setAttribute("data-playwrong-id", semanticId);
  }
}

function buildLocator(
  element: Element,
  semanticId: string,
  label: string,
  primarySelector?: string
): LocatorSpec {
  const strategies: LocatorStrategy[] = [];
  strategies.push({
    type: "css",
    query: `[data-playwrong-id="${escapeCssValue(semanticId)}"]`,
    weight: 1,
    required: true
  });

  if (primarySelector) {
    strategies.push({
      type: "css",
      query: primarySelector,
      weight: 0.85
    });
  }

  const elementId = normalizeText(element.getAttribute("id"));
  if (elementId) {
    strategies.push({ type: "css", query: `#${escapeCssValue(elementId)}`, weight: 0.8 });
  }

  const name = normalizeText(element.getAttribute("name"));
  if (name) {
    strategies.push({
      type: "css",
      query: `${element.tagName.toLowerCase()}[name="${escapeCssValue(name)}"]`,
      weight: 0.7
    });
  }

  const aria = normalizeText(element.getAttribute("aria-label"));
  if (aria) {
    strategies.push({ type: "aria", query: aria, weight: 0.75 });
  }

  if (label) {
    strategies.push({ type: "text", query: label, weight: 0.45 });
  }

  const cssPath = buildCssPath(element);
  if (cssPath) {
    strategies.push({ type: "css", query: cssPath, weight: 0.55 });
  }

  return {
    version: 1,
    strategies,
    constraints: {
      visible: true
    },
    threshold: 0.55,
    ambiguityDelta: 0.04
  };
}

function firstElement<T extends Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll<T>(selector));
    const firstVisible = candidates.find((candidate) => isVisible(candidate));
    if (firstVisible) {
      return firstVisible;
    }
    if (candidates[0]) {
      return candidates[0];
    }
  }
  return null;
}

function getSearchField(config: SearchEngineConfig): HTMLInputElement | HTMLTextAreaElement | null {
  return firstElement<HTMLInputElement | HTMLTextAreaElement>(config.inputSelectors);
}

function setSearchFieldValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: ScalarValue
): void {
  const next = value === null ? "" : Array.isArray(value) ? value.join(" ") : String(value ?? "");
  field.value = next;
  dispatchInputEvents(field);
}

function submitSearch(config: SearchEngineConfig, field?: HTMLInputElement | HTMLTextAreaElement): void {
  const submit = firstElement<HTMLElement>(config.submitSelectors);
  if (submit) {
    submit.click();
    return;
  }

  const form = field?.closest("form");
  if (form instanceof HTMLFormElement) {
    form.requestSubmit();
    return;
  }

  throw makeError("NOT_FOUND", `Search submit button not found for ${config.scriptId}`);
}

function collectResultAnchors(config: SearchEngineConfig): HTMLAnchorElement[] {
  const anchors: HTMLAnchorElement[] = [];
  const seen = new Set<HTMLAnchorElement>();

  for (const selector of config.resultTitleSelectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    for (const candidate of candidates) {
      const anchor = candidate instanceof HTMLAnchorElement ? candidate : candidate.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) {
        continue;
      }
      if (seen.has(anchor)) {
        continue;
      }
      seen.add(anchor);
      anchors.push(anchor);
      if (anchors.length >= 8) {
        return anchors;
      }
    }
  }

  return anchors;
}

function getNextPageControl(config: SearchEngineConfig): HTMLElement | null {
  return firstElement<HTMLElement>(config.nextPageSelectors);
}

function parseResultIndex(targetId: string): number | null {
  const match = /^search\.result\.(\d+)\.open$/.exec(targetId);
  if (!match) {
    return null;
  }
  const index = Number(match[1]);
  if (!Number.isInteger(index) || index < 1) {
    return null;
  }
  return index;
}

function createSearchScript(config: SearchEngineConfig): PluginScript {
  return {
    scriptId: config.scriptId,
    priority: 100,
    rules: [
      {
        hosts: config.hosts,
        requiredSignals: ["has:search.query"],
        pageType: config.pageType,
        scoreBoost: 0.35
      },
      {
        titleIncludes: config.titleTokens,
        requiredSignals: ["has:search.query"],
        pageType: config.pageType,
        scoreBoost: 0.12
      }
    ],
    async extract() {
      const queryField = getSearchField(config);
      if (!queryField) {
        throw makeError("PLUGIN_MISS", `Search input missing for ${config.scriptId}`);
      }

      const queryLabel = "Search Query";
      markSemanticId(queryField, "search.query");
      const formChildren: SemanticNode[] = [
        {
          id: "search.query",
          kind: "editable",
          label: queryLabel,
          value: queryField.value,
          locator: buildLocator(queryField, "search.query", queryLabel, config.inputSelectors[0]),
          calls: [
            { name: "focus", sideEffect: false },
            { name: "submit", sideEffect: true }
          ]
        }
      ];

      const submit = firstElement<HTMLElement>(config.submitSelectors);
      if (submit) {
        const submitLabel = normalizeText(submit.textContent) || "Search";
        markSemanticId(submit, "search.submit");
        formChildren.push({
          id: "search.submit",
          kind: "action",
          label: submitLabel,
          value: submitLabel,
          locator: buildLocator(submit, "search.submit", submitLabel, config.submitSelectors[0]),
          calls: [{ name: "click", sideEffect: true }]
        });
      }

      const roots: SemanticNode[] = [
        {
          id: "search.form",
          kind: "form",
          label: "Search",
          children: formChildren
        }
      ];

      const results = collectResultAnchors(config);
      if (results.length > 0) {
        const listChildren: SemanticNode[] = [];
        results.forEach((anchor, idx) => {
          const resultIndex = idx + 1;
          const text = normalizeText(anchor.querySelector("h3")?.textContent) || normalizeText(anchor.textContent);
          const label = text || `Result ${resultIndex}`;
          const itemId = `search.result.${resultIndex}`;
          const openId = `${itemId}.open`;
          markSemanticId(anchor, openId);

          listChildren.push({
            id: itemId,
            kind: "item",
            label,
            children: [
              {
                id: openId,
                kind: "action",
                label,
                value: label,
                locator: buildLocator(anchor, openId, label),
                attrs: {
                  href: anchor.href || anchor.getAttribute("href") || ""
                },
                calls: [{ name: "click", sideEffect: true }]
              }
            ]
          });
        });

        roots.push({
          id: "search.results",
          kind: "list",
          label: "Results",
          children: listChildren
        });
      }

      const nextPageControl = getNextPageControl(config);
      if (nextPageControl) {
        const nextLabel = normalizeText(nextPageControl.textContent) || "Next Page";
        markSemanticId(nextPageControl, "search.pagination.next");
        roots.push({
          id: "search.pagination",
          kind: "group",
          label: "Pagination",
          children: [
            {
              id: "search.pagination.next",
              kind: "action",
              label: nextLabel,
              value: nextLabel,
              locator: buildLocator(
                nextPageControl,
                "search.pagination.next",
                nextLabel,
                config.nextPageSelectors[0]
              ),
              calls: [{ name: "click", sideEffect: true }]
            }
          ]
        });
      }

      return {
        pageType: config.pageType,
        tree: roots,
        pageCalls: SEARCH_PAGE_CALLS
      };
    },
    async setValue(ctx, value) {
      if (ctx.target.id !== "search.query") {
        throw makeError("PLUGIN_MISS", `Unhandled set target: ${ctx.target.id}`);
      }
      const queryField = getSearchField(config);
      if (!queryField) {
        throw makeError("NOT_FOUND", `Search input missing for ${config.scriptId}`);
      }
      setSearchFieldValue(queryField, value);
    },
    async invoke(ctx, fn, args) {
      if (ctx.target.id === "page" && fn === "search") {
        const query = args?.query;
        if (typeof query !== "string" || query.length === 0) {
          throw makeError("INVALID_REQUEST", "page.search requires args.query");
        }
        const queryField = getSearchField(config);
        if (!queryField) {
          throw makeError("NOT_FOUND", `Search input missing for ${config.scriptId}`);
        }
        setSearchFieldValue(queryField, query);
        submitSearch(config, queryField);
        return { ok: true, query };
      }

      if (ctx.target.id === "page" && fn === "nextPage") {
        const nextPageControl = getNextPageControl(config);
        if (!nextPageControl) {
          throw makeError("NOT_FOUND", `Next page control missing for ${config.scriptId}`);
        }
        nextPageControl.click();
        return { ok: true };
      }

      if (ctx.target.id === "search.query") {
        const queryField = getSearchField(config);
        if (!queryField) {
          throw makeError("NOT_FOUND", `Search input missing for ${config.scriptId}`);
        }

        if (fn === "focus") {
          queryField.focus();
          return { ok: true };
        }
        if (fn === "submit") {
          submitSearch(config, queryField);
          return { ok: true };
        }
        throw makeError("UNDECLARED_FUNCTION", `Unsupported function on search.query: ${fn}`);
      }

      if (ctx.target.id === "search.submit") {
        if (fn !== "click") {
          throw makeError("UNDECLARED_FUNCTION", `Unsupported function on search.submit: ${fn}`);
        }
        submitSearch(config);
        return { ok: true };
      }

      const resultIndex = parseResultIndex(ctx.target.id);
      if (resultIndex !== null) {
        if (fn !== "click") {
          throw makeError("UNDECLARED_FUNCTION", `Unsupported function on ${ctx.target.id}: ${fn}`);
        }
        const results = collectResultAnchors(config);
        const anchor = results[resultIndex - 1];
        if (!anchor) {
          throw makeError("NOT_FOUND", `Search result target missing: ${ctx.target.id}`);
        }
        anchor.click();
        return {
          ok: true,
          result: resultIndex,
          href: anchor.href || anchor.getAttribute("href") || ""
        };
      }

      if (ctx.target.id === "search.pagination.next") {
        if (fn !== "click") {
          throw makeError("UNDECLARED_FUNCTION", `Unsupported function on ${ctx.target.id}: ${fn}`);
        }
        const nextPageControl = getNextPageControl(config);
        if (!nextPageControl) {
          throw makeError("NOT_FOUND", `Next page control missing for ${config.scriptId}`);
        }
        nextPageControl.click();
        return { ok: true };
      }

      throw makeError("PLUGIN_MISS", `Unhandled call target: ${ctx.target.id}`);
    }
  };
}

export function createSearchEngineScripts(): PluginScript[] {
  return ENGINE_CONFIGS.map((config) => createSearchScript(config));
}
