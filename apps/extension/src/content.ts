import { matchHostPattern, matchPathPattern } from "@playwrong/plugin-sdk";
import type {
  MatchContext,
  StabilityPolicy,
  StabilitySnapshot
} from "@playwrong/plugin-sdk";
import type {
  FunctionCallDef,
  LocatorSpec,
  LocatorStrategy,
  PluginExtractResult,
  ScalarValue,
  SemanticNode
} from "@playwrong/protocol";
import type { ContentBridgeError, ContentBridgeRequest, ContentBridgeResponse } from "./messages";
import { ExtensionPluginHost, type SelectedPluginScript } from "./plugin-host";
import { createBuiltinSiteScripts } from "./site-scripts";
import { userPluginScripts, userSimpleStabilityRules, type UserSimpleStabilityRule } from "./user-scripts";

interface LocalExtractResult {
  pageType: string;
  tree: SemanticNode[];
  pageCalls: FunctionCallDef[];
  url: string;
  title: string;
}

const INTERACTIVE_SELECTOR =
  "input,textarea,select,button,a[href],[contenteditable='true'],[role='button'],[role='textbox'],[role='link']";
const SEARCH_QUERY_SELECTOR = "input[name='q'],textarea[name='q']";
const SEARCH_SUBMIT_SELECTOR = "button[type='submit'],input[type='submit'],input[name='btnK']";
const SEARCH_RESULT_SELECTOR = "#search, #b_results, [data-testid='mainline']";

const pluginHost = new ExtensionPluginHost([...createBuiltinSiteScripts(), ...userPluginScripts]);
let latestTree: SemanticNode[] = [];

const DEFAULT_STABILITY_POLICY: Required<StabilityPolicy> = {
  kConsecutive: 8,
  sampleIntervalMs: 100,
  timeoutMs: 8000,
  maxPendingRequests: 0,
  maxRecentMutations: 5
};

const STABLE_MUTATION_WINDOW_MS = 500;
const MAX_STABILITY_HISTORY = 60;

let pendingRequests = 0;
const mutationTimestamps: number[] = [];

function wakeBackgroundSocket(): void {
  try {
    chrome.runtime.sendMessage({ type: "playwrong.wakeup" }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // best-effort wakeup only
  }
}

wakeBackgroundSocket();

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function slugify(value: string): string {
  const normalized = normalizeText(value).toLowerCase();
  const slug = normalized
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  return slug || "node";
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}.${i}`)) {
    i += 1;
  }
  const next = `${base}.${i}`;
  used.add(next);
  return next;
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

function isEnabled(element: Element): boolean {
  if ("disabled" in element && typeof element.disabled === "boolean") {
    return !element.disabled;
  }
  return true;
}

function isInteractiveElement(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.matches("input[type='hidden']")) {
    return false;
  }
  return element.matches(INTERACTIVE_SELECTOR);
}

function inferPageType(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0];
  return first ? slugify(first) : "index";
}

function defaultPageCalls(): FunctionCallDef[] {
  return [
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
    }
  ];
}

function collectMatchSignals(): string[] {
  const signals: string[] = [];

  if (document.querySelector(SEARCH_QUERY_SELECTOR)) {
    signals.push("has:search.query");
  }
  if (document.querySelector(SEARCH_SUBMIT_SELECTOR)) {
    signals.push("has:search.submit");
  }
  if (document.querySelector(SEARCH_RESULT_SELECTOR)) {
    signals.push("has:search.results");
  }

  if (document.querySelector("form")) {
    signals.push("has:form");
  }
  if (document.querySelector("input[type='password']")) {
    signals.push("has:input.password");
  }
  if (document.querySelector("button[type='submit'],input[type='submit']")) {
    signals.push("has:submit");
  }

  return signals;
}

function createMatchContext(): MatchContext {
  return {
    url: new URL(window.location.href),
    title: document.title,
    signals: collectMatchSignals()
  };
}

function isPluginMiss(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code === "PLUGIN_MISS") {
      return true;
    }
  }

  if (error instanceof Error && error.message === "PLUGIN_MISS") {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNonNegative(input: number): number {
  if (!Number.isFinite(input)) {
    return 0;
  }
  return Math.max(0, input);
}

function trackMutationBurst(): void {
  mutationTimestamps.push(Date.now());
}

function recentMutationCount(windowMs: number): number {
  const now = Date.now();
  while (mutationTimestamps.length > 0 && mutationTimestamps[0] !== undefined && mutationTimestamps[0] < now - windowMs) {
    mutationTimestamps.shift();
  }
  return mutationTimestamps.length;
}

function installNetworkTracker(): void {
  const win = window as Window & {
    __playwrongFetchPatched?: boolean;
  };

  if (!win.__playwrongFetchPatched) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
      pendingRequests += 1;
      try {
        return await nativeFetch(...args);
      } finally {
        pendingRequests = clampNonNegative(pendingRequests - 1);
      }
    }) as typeof fetch;
    win.__playwrongFetchPatched = true;
  }

  const xhrProto = XMLHttpRequest.prototype as XMLHttpRequest & {
    __playwrongPatched?: boolean;
  };
  if (xhrProto.__playwrongPatched) {
    return;
  }

  const nativeSend = xhrProto.send;
  xhrProto.send = function patchedSend(...args: unknown[]): void {
    pendingRequests += 1;
    const onDone = () => {
      pendingRequests = clampNonNegative(pendingRequests - 1);
      this.removeEventListener("loadend", onDone);
    };
    this.addEventListener("loadend", onDone);
    (nativeSend as (...inner: unknown[]) => void).apply(this, args);
  };
  xhrProto.__playwrongPatched = true;
}

function installMutationTracker(): void {
  const win = window as Window & {
    __playwrongMutationObserverInstalled?: boolean;
  };
  if (win.__playwrongMutationObserverInstalled) {
    return;
  }

  const root = document.documentElement ?? document.body;
  if (!root) {
    return;
  }

  const observer = new MutationObserver(() => {
    trackMutationBurst();
  });
  observer.observe(root, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true
  });
  win.__playwrongMutationObserverInstalled = true;
}

function createStabilitySnapshot(): StabilitySnapshot {
  return {
    timestamp: Date.now(),
    url: window.location.href,
    title: document.title,
    readyState: document.readyState,
    pendingRequests: pendingRequests,
    recentMutations: recentMutationCount(STABLE_MUTATION_WINDOW_MS)
  };
}

function mergedStabilityPolicy(
  selected: SelectedPluginScript | null,
  simpleRule: UserSimpleStabilityRule | null
): Required<StabilityPolicy> {
  const merged: Required<StabilityPolicy> = { ...DEFAULT_STABILITY_POLICY };

  const pluginPolicy = selected?.script.stability;
  if (pluginPolicy) {
    if (pluginPolicy.kConsecutive !== undefined) {
      merged.kConsecutive = Math.max(1, Math.trunc(pluginPolicy.kConsecutive));
    }
    if (pluginPolicy.sampleIntervalMs !== undefined) {
      merged.sampleIntervalMs = Math.max(20, Math.trunc(pluginPolicy.sampleIntervalMs));
    }
    if (pluginPolicy.timeoutMs !== undefined) {
      merged.timeoutMs = Math.max(200, Math.trunc(pluginPolicy.timeoutMs));
    }
    if (pluginPolicy.maxPendingRequests !== undefined) {
      merged.maxPendingRequests = Math.max(0, Math.trunc(pluginPolicy.maxPendingRequests));
    }
    if (pluginPolicy.maxRecentMutations !== undefined) {
      merged.maxRecentMutations = Math.max(0, Math.trunc(pluginPolicy.maxRecentMutations));
    }
  }

  if (simpleRule) {
    if (simpleRule.kConsecutive !== undefined) {
      merged.kConsecutive = Math.max(1, Math.trunc(simpleRule.kConsecutive));
    }
    if (simpleRule.sampleIntervalMs !== undefined) {
      merged.sampleIntervalMs = Math.max(20, Math.trunc(simpleRule.sampleIntervalMs));
    }
    if (simpleRule.timeoutMs !== undefined) {
      merged.timeoutMs = Math.max(200, Math.trunc(simpleRule.timeoutMs));
    }
    if (simpleRule.maxPendingRequests !== undefined) {
      merged.maxPendingRequests = Math.max(0, Math.trunc(simpleRule.maxPendingRequests));
    }
    if (simpleRule.maxRecentMutations !== undefined) {
      merged.maxRecentMutations = Math.max(0, Math.trunc(simpleRule.maxRecentMutations));
    }
  }

  return merged;
}

function matchSimpleRule(rule: UserSimpleStabilityRule, ctx: MatchContext): number | null {
  let score = 0;

  if (rule.hosts && rule.hosts.length > 0) {
    const hostHit = rule.hosts.some((pattern) => matchHostPattern(pattern, ctx.url.hostname));
    if (!hostHit) {
      return null;
    }
    score += 2;
  }

  if (rule.paths && rule.paths.length > 0) {
    const pathHit = rule.paths.some((pattern) => matchPathPattern(pattern, ctx.url.pathname));
    if (!pathHit) {
      return null;
    }
    score += 2;
  }

  score += (rule.hosts?.length ?? 0) * 0.01;
  score += (rule.paths?.length ?? 0) * 0.01;
  return score;
}

function pickSimpleStabilityRule(ctx: MatchContext): UserSimpleStabilityRule | null {
  let best: { rule: UserSimpleStabilityRule; score: number } | null = null;
  for (const rule of userSimpleStabilityRules) {
    const score = matchSimpleRule(rule, ctx);
    if (score === null) {
      continue;
    }
    if (!best || score > best.score) {
      best = { rule, score };
    }
  }
  return best?.rule ?? null;
}

async function waitForStable(ctx: MatchContext, selected: SelectedPluginScript | null): Promise<void> {
  const simpleRule = pickSimpleStabilityRule(ctx);
  const policy = mergedStabilityPolicy(selected, simpleRule);
  const history: StabilitySnapshot[] = [];

  const startedAt = Date.now();
  let stableUrl = window.location.href;
  let consecutive = 0;

  while (Date.now() - startedAt <= policy.timeoutMs) {
    const snapshot = createStabilitySnapshot();
    history.push(snapshot);
    if (history.length > MAX_STABILITY_HISTORY) {
      history.shift();
    }

    if (snapshot.url !== stableUrl) {
      stableUrl = snapshot.url;
      consecutive = 0;
      await sleep(policy.sampleIntervalMs);
      continue;
    }

    let passed =
      snapshot.readyState !== "loading" &&
      snapshot.pendingRequests <= policy.maxPendingRequests &&
      snapshot.recentMutations <= policy.maxRecentMutations;

    if (passed && selected?.script.isStable) {
      const judged = await selected.script.isStable({
        match: createMatchContext(),
        latest: snapshot,
        history
      });
      passed = Boolean(judged);
    }

    if (passed) {
      consecutive += 1;
      if (consecutive >= policy.kConsecutive) {
        return;
      }
    } else {
      consecutive = 0;
    }

    await sleep(policy.sampleIntervalMs);
  }

  throw createResolveError("ACTION_FAIL", "waitForStable timeout", {
    policy,
    latest: history[history.length - 1]
  });
}

installNetworkTracker();
installMutationTracker();

function shouldWaitForStableAfterCall(input: {
  target: { id: string };
  fn: string;
}): boolean {
  if (input.target.id === "page") {
    if (input.fn === "search" || input.fn === "goto" || input.fn === "refresh" || input.fn === "nextPage") {
      return false;
    }
  }
  if (input.fn === "click" || input.fn === "submit") {
    return false;
  }
  return true;
}

function getAssociatedLabel(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    if (element.labels && element.labels.length > 0) {
      const text = normalizeText(element.labels[0]?.textContent);
      if (text) {
        return text;
      }
    }
  }
  const aria = normalizeText(element.getAttribute("aria-label"));
  if (aria) {
    return aria;
  }
  const placeholder = normalizeText((element as HTMLInputElement).placeholder);
  if (placeholder) {
    return placeholder;
  }
  const name = normalizeText(element.getAttribute("name"));
  if (name) {
    return name;
  }
  const text = normalizeText(element.textContent);
  if (text) {
    return text;
  }
  const id = normalizeText(element.getAttribute("id"));
  if (id) {
    return id;
  }
  return element.tagName.toLowerCase();
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

function buildLocator(element: Element, semanticId: string, hint: string): LocatorSpec {
  const strategies: LocatorStrategy[] = [];
  const dataId = `[data-playwrong-id="${escapeCssValue(semanticId)}"]`;
  strategies.push({ type: "css", query: dataId, weight: 1, required: true });

  const elementId = normalizeText(element.getAttribute("id"));
  if (elementId) {
    strategies.push({ type: "css", query: `#${escapeCssValue(elementId)}`, weight: 0.95 });
  }

  const name = normalizeText(element.getAttribute("name"));
  if (name) {
    strategies.push({
      type: "css",
      query: `${element.tagName.toLowerCase()}[name="${escapeCssValue(name)}"]`,
      weight: 0.75
    });
  }

  const aria = normalizeText(element.getAttribute("aria-label"));
  if (aria) {
    strategies.push({ type: "aria", query: aria, weight: 0.8 });
  }

  if (hint) {
    strategies.push({ type: "text", query: hint, weight: 0.45 });
  }

  const cssPath = buildCssPath(element);
  if (cssPath) {
    strategies.push({ type: "css", query: cssPath, weight: 0.6 });
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

function inferNodeKind(element: Element): SemanticNode["kind"] | null {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === "hidden") {
      return null;
    }
    if (type === "checkbox" || type === "radio") {
      return "toggle";
    }
    if (type === "button" || type === "submit" || type === "reset" || type === "image") {
      return "action";
    }
    return "editable";
  }
  if (element instanceof HTMLTextAreaElement) {
    return "editable";
  }
  if (element instanceof HTMLSelectElement) {
    return "select";
  }
  if (element instanceof HTMLButtonElement) {
    return "action";
  }
  if (element instanceof HTMLAnchorElement) {
    return "action";
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return "editable";
  }
  const role = normalizeText(element.getAttribute("role"));
  if (role === "button" || role === "link") {
    return "action";
  }
  if (role === "textbox") {
    return "editable";
  }
  return null;
}

function getNodeValue(kind: SemanticNode["kind"], element: Element): ScalarValue | undefined {
  if (kind === "editable") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.innerText;
    }
    return normalizeText(element.textContent);
  }

  if (kind === "select" && element instanceof HTMLSelectElement) {
    if (element.multiple) {
      return Array.from(element.selectedOptions).map((option) => option.value);
    }
    return element.value;
  }

  if (kind === "toggle" && element instanceof HTMLInputElement) {
    return element.checked;
  }

  if (kind === "action") {
    return normalizeText(element.textContent);
  }

  return undefined;
}

function getCallsForKind(kind: SemanticNode["kind"]): FunctionCallDef[] | undefined {
  if (kind === "action") {
    return [{ name: "click", sideEffect: true }];
  }
  if (kind === "editable" || kind === "select" || kind === "toggle") {
    return [{ name: "focus", sideEffect: false }];
  }
  return undefined;
}

function setPlaywrongId(element: Element, semanticId: string): void {
  if (element instanceof HTMLElement) {
    element.setAttribute("data-playwrong-id", semanticId);
  }
}

function createNode(
  element: Element,
  parentPrefix: string,
  usedIds: Set<string>
): SemanticNode | null {
  if (!isInteractiveElement(element)) {
    return null;
  }

  const kind = inferNodeKind(element);
  if (!kind) {
    return null;
  }

  const hint = getAssociatedLabel(element);
  const semanticId = uniqueId(`${parentPrefix}.${kind}.${slugify(hint)}`, usedIds);
  setPlaywrongId(element, semanticId);

  const attrs: Record<string, string | number | boolean> = {
    visible: isVisible(element),
    enabled: isEnabled(element)
  };

  if (element instanceof HTMLInputElement) {
    attrs.inputType = element.type;
    attrs.required = element.required;
  }
  if (element instanceof HTMLSelectElement) {
    attrs.multiple = element.multiple;
  }

  const node: SemanticNode = {
    id: semanticId,
    kind,
    label: hint,
    locator: buildLocator(element, semanticId, hint),
    attrs
  };

  const value = getNodeValue(kind, element);
  if (value !== undefined) {
    node.value = value;
  }

  const calls = getCallsForKind(kind);
  if (calls) {
    node.calls = calls;
  }

  return node;
}

function collectNodesFromElements(
  elements: Element[],
  parentPrefix: string,
  usedIds: Set<string>
): SemanticNode[] {
  const nodes: SemanticNode[] = [];
  for (const element of elements) {
    const node = createNode(element, parentPrefix, usedIds);
    if (node) {
      nodes.push(node);
    }
  }
  return nodes;
}

function extractGenericTree(): LocalExtractResult {
  const usedIds = new Set<string>();
  const roots: SemanticNode[] = [];
  const consumed = new Set<Element>();

  const forms = Array.from(document.querySelectorAll("form"));
  forms.forEach((form, index) => {
    const formId = uniqueId(`form.${index + 1}`, usedIds);
    const formLabel =
      normalizeText(form.getAttribute("aria-label")) ||
      normalizeText(form.querySelector("legend")?.textContent) ||
      normalizeText(form.getAttribute("id")) ||
      `Form ${index + 1}`;

    const formElements = Array.from(form.querySelectorAll(INTERACTIVE_SELECTOR));
    const children = collectNodesFromElements(formElements, formId, usedIds);
    for (const element of formElements) {
      consumed.add(element);
    }

    if (children.length > 0) {
      roots.push({
        id: formId,
        kind: "form",
        label: formLabel,
        children
      });
    }
  });

  const standaloneElements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
    (element) => !consumed.has(element) && !element.closest("form")
  );
  const standaloneChildren = collectNodesFromElements(standaloneElements, "page.main", usedIds);
  if (standaloneChildren.length > 0) {
    roots.push({
      id: uniqueId("page.main", usedIds),
      kind: "group",
      label: "Main",
      children: standaloneChildren
    });
  }

  const h1 = normalizeText(document.querySelector("h1")?.textContent);
  if (h1) {
    roots.unshift({
      id: uniqueId("page.heading", usedIds),
      kind: "content",
      label: "Heading",
      value: h1
    });
  }

  return {
    pageType: inferPageType(window.location.pathname),
    tree: roots,
    pageCalls: defaultPageCalls(),
    url: window.location.href,
    title: document.title
  };
}

async function extractTree(): Promise<LocalExtractResult> {
  const matchContext = createMatchContext();
  const selected = await pluginHost.select(matchContext);
  let pluginResult: PluginExtractResult | null = null;

  if (selected) {
    try {
      pluginResult = await selected.script.extract(matchContext);
    } catch (error) {
      if (!isPluginMiss(error)) {
        throw error;
      }
    }
  }

  if (pluginResult && pluginResult.tree.length > 0) {
    latestTree = pluginResult.tree;
    return {
      pageType: pluginResult.pageType,
      tree: pluginResult.tree,
      pageCalls: pluginResult.pageCalls ?? defaultPageCalls(),
      url: window.location.href,
      title: document.title
    };
  }

  const fallback = extractGenericTree();
  latestTree = fallback.tree;
  return fallback;
}

function runXPath(query: string): Element[] {
  const results: Element[] = [];
  const snapshot = document.evaluate(
    query,
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null
  );
  for (let i = 0; i < snapshot.snapshotLength; i += 1) {
    const item = snapshot.snapshotItem(i);
    if (item instanceof Element) {
      results.push(item);
    }
  }
  return results;
}

function queryByStrategy(strategy: LocatorStrategy): Element[] {
  if (strategy.type === "css" || strategy.type === "relative") {
    try {
      return Array.from(document.querySelectorAll(strategy.query));
    } catch {
      return [];
    }
  }
  if (strategy.type === "xpath") {
    return runXPath(strategy.query);
  }
  if (strategy.type === "aria") {
    const q = strategy.query;
    const escaped = escapeCssValue(q);
    const selector = `[aria-label*="${escaped}" i], [name="${escaped}"], [role="${escaped}"]`;
    try {
      return Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
  }
  if (strategy.type === "text") {
    const q = normalizeText(strategy.query).toLowerCase();
    if (!q) {
      return [];
    }
    const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    return candidates.filter((candidate) => {
      const text = normalizeText(candidate.textContent).toLowerCase();
      const aria = normalizeText(candidate.getAttribute("aria-label")).toLowerCase();
      const placeholder = normalizeText((candidate as HTMLInputElement).placeholder).toLowerCase();
      return text.includes(q) || aria.includes(q) || placeholder.includes(q);
    });
  }
  return [];
}

interface ResolveError extends Error {
  code: string;
  details: Record<string, unknown> | undefined;
}

function createResolveError(code: string, message: string, details?: Record<string, unknown>): ResolveError {
  const error = new Error(message) as ResolveError;
  error.code = code;
  error.details = details;
  return error;
}

function resolveElement(
  target: { id: string; path?: string[] },
  locator?: LocatorSpec
): Element {
  const direct = document.querySelector(`[data-playwrong-id="${escapeCssValue(target.id)}"]`);
  if (direct) {
    return direct;
  }

  if (!locator || locator.strategies.length === 0) {
    throw createResolveError("NOT_FOUND", `Cannot locate target ${target.id}: locator missing`);
  }

  const totalWeight = locator.strategies.reduce((sum, strategy) => sum + Math.max(strategy.weight, 0), 0);
  if (totalWeight <= 0) {
    throw createResolveError("INVALID_REQUEST", "Locator total weight must be positive");
  }

  const rawScores = new Map<Element, number>();
  for (const strategy of locator.strategies) {
    const found = queryByStrategy(strategy);
    if (strategy.required && found.length === 0) {
      throw createResolveError("NOT_FOUND", `Required strategy did not match: ${strategy.type}`);
    }
    for (const candidate of found) {
      rawScores.set(candidate, (rawScores.get(candidate) ?? 0) + Math.max(0, strategy.weight));
    }
  }

  if (rawScores.size === 0) {
    throw createResolveError("NOT_FOUND", `Cannot locate target ${target.id}`);
  }

  const threshold = locator.threshold ?? 0.6;
  const ambiguityDelta = locator.ambiguityDelta ?? 0.05;
  const scored = Array.from(rawScores.entries()).map(([candidate, raw]) => {
    let score = raw / totalWeight;
    if (locator.constraints?.visible && !isVisible(candidate)) {
      score -= 0.3;
    }
    if (locator.constraints?.enabled && !isEnabled(candidate)) {
      score -= 0.3;
    }
    if (locator.constraints?.tagNames?.length) {
      const tags = locator.constraints.tagNames.map((tag) => tag.toLowerCase());
      if (!tags.includes(candidate.tagName.toLowerCase())) {
        score -= 0.2;
      }
    }
    return { candidate, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const shortlist = scored.filter((item) => item.score >= threshold);
  if (shortlist.length === 0) {
    throw createResolveError("NOT_FOUND", `No candidate passed threshold for ${target.id}`);
  }

  if (locator.constraints?.unique && shortlist.length > 1) {
    throw createResolveError("AMBIGUOUS", `Target ${target.id} matched multiple candidates`, {
      count: shortlist.length
    });
  }

  if (shortlist.length > 1 && shortlist[0] && shortlist[1]) {
    if (shortlist[0].score - shortlist[1].score <= ambiguityDelta) {
      throw createResolveError("AMBIGUOUS", `Target ${target.id} ambiguous`, {
        topScore: shortlist[0].score,
        secondScore: shortlist[1].score
      });
    }
  }

  const top = shortlist[0];
  if (!top) {
    throw createResolveError("NOT_FOUND", `Cannot locate target ${target.id}`);
  }

  return top.candidate;
}

function dispatchInputEvents(element: Element): void {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setElementValue(element: Element, value: ScalarValue): void {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase();
    if (type === "checkbox" || type === "radio") {
      element.checked = Boolean(value);
      dispatchInputEvents(element);
      return;
    }
    element.value = value === null ? "" : String(value ?? "");
    dispatchInputEvents(element);
    return;
  }

  if (element instanceof HTMLTextAreaElement) {
    element.value = value === null ? "" : String(value ?? "");
    dispatchInputEvents(element);
    return;
  }

  if (element instanceof HTMLSelectElement) {
    if (element.multiple) {
      const values = Array.isArray(value) ? value.map((item) => String(item)) : [String(value ?? "")];
      for (const option of Array.from(element.options)) {
        option.selected = values.includes(option.value);
      }
    } else {
      element.value = value === null ? "" : String(value ?? "");
    }
    dispatchInputEvents(element);
    return;
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    element.innerText = value === null ? "" : String(value ?? "");
    dispatchInputEvents(element);
    return;
  }

  throw createResolveError("INVALID_NODE_KIND", "Element does not support setValue");
}

function executePageCall(fn: string, args?: Record<string, unknown>): unknown {
  if (fn === "refresh") {
    window.location.reload();
    return { ok: true };
  }
  if (fn === "scrollTo") {
    const top = typeof args?.top === "number" ? args.top : 0;
    const left = typeof args?.left === "number" ? args.left : 0;
    window.scrollTo({ top, left, behavior: "auto" });
    return { ok: true };
  }
  if (fn === "goto") {
    const url = args?.url;
    if (typeof url !== "string" || !url) {
      throw createResolveError("INVALID_REQUEST", "goto requires args.url");
    }
    window.location.href = url;
    return { ok: true };
  }
  throw createResolveError("UNDECLARED_FUNCTION", `Unknown page function: ${fn}`);
}

function executeElementCall(element: Element, fn: string, args?: Record<string, unknown>): unknown {
  if (fn === "click") {
    (element as HTMLElement).click();
    return { ok: true };
  }
  if (fn === "focus") {
    (element as HTMLElement).focus();
    return { ok: true };
  }
  if (fn === "scrollIntoView") {
    (element as HTMLElement).scrollIntoView({ block: "center", behavior: "auto" });
    return { ok: true };
  }
  if (fn === "fill") {
    setElementValue(element, (args?.value as ScalarValue) ?? "");
    return { ok: true };
  }
  if (fn === "select") {
    setElementValue(element, (args?.value as ScalarValue) ?? "");
    return { ok: true };
  }
  if (fn === "check") {
    setElementValue(element, true);
    return { ok: true };
  }
  if (fn === "uncheck") {
    setElementValue(element, false);
    return { ok: true };
  }
  if (fn === "submit") {
    const form = element.closest("form");
    if (!form) {
      throw createResolveError("NOT_FOUND", "submit requires a form context");
    }
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
      return { ok: true };
    }
  }
  throw createResolveError("UNDECLARED_FUNCTION", `Unknown element function: ${fn}`);
}

function toErrorPayload(error: unknown): ContentBridgeError {
  if (error && typeof error === "object") {
    const maybe = error as { code?: string; message?: string; details?: Record<string, unknown> };
    if (typeof maybe.message === "string") {
      const payload: ContentBridgeError = {
        code: maybe.code ?? "ACTION_FAIL",
        message: maybe.message
      };
      if (maybe.details) {
        payload.details = maybe.details;
      }
      return payload;
    }
  }
  return {
    code: "INTERNAL_ERROR",
    message: "Unknown extension content script error"
  };
}

chrome.runtime.onMessage.addListener((message: ContentBridgeRequest, _sender, sendResponse) => {
  void (async () => {
    if (message.type === "bridge.extract") {
      const result = await extractTree();
      const response: ContentBridgeResponse<LocalExtractResult> = { ok: true, result };
      sendResponse(response);
      return;
    }

    if (message.type === "bridge.setValue") {
      const matchContext = createMatchContext();
      const selected = await pluginHost.select(matchContext);
      let handledByPlugin = false;
      if (selected) {
        try {
          await selected.script.setValue({ ...matchContext, tree: latestTree, target: message.target }, message.value);
          handledByPlugin = true;
        } catch (error) {
          if (!isPluginMiss(error)) {
            throw error;
          }
        }
      }

      if (!handledByPlugin) {
        const element = resolveElement(message.target, message.locator);
        setElementValue(element, message.value);
      }

      await waitForStable(matchContext, selected);
      const response: ContentBridgeResponse<{ ok: true }> = {
        ok: true,
        result: { ok: true }
      };
      sendResponse(response);
      return;
    }

    if (message.type === "bridge.call") {
      const matchContext = createMatchContext();
      const selected = await pluginHost.select(matchContext);
      let output: unknown;
      let handledByPlugin = false;

      if (selected) {
        try {
          output = await selected.script.invoke(
            { ...matchContext, tree: latestTree, target: message.target },
            message.fn,
            message.args
          );
          handledByPlugin = true;
        } catch (error) {
          if (!isPluginMiss(error)) {
            throw error;
          }
        }
      }

      if (!handledByPlugin) {
        if (message.target.id === "page") {
          output = executePageCall(message.fn, message.args);
        } else {
          const element = resolveElement(message.target, message.locator);
          output = executeElementCall(element, message.fn, message.args);
        }
      }

      if (shouldWaitForStableAfterCall({ target: message.target, fn: message.fn })) {
        await waitForStable(matchContext, selected);
      }
      const response: ContentBridgeResponse<{ output?: unknown }> = {
        ok: true,
        result: { output }
      };
      sendResponse(response);
      return;
    }

    const fallback: ContentBridgeResponse<never> = {
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Unknown content request type"
      }
    };
    sendResponse(fallback);
  })().catch((error: unknown) => {
    const response: ContentBridgeResponse<never> = {
      ok: false,
      error: toErrorPayload(error)
    };
    sendResponse(response);
  });

  return true;
});
