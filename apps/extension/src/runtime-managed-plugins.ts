import type { PluginScript, ScriptMatchRule } from "@playwrong/plugin-sdk";
import type { FunctionCallDef, PluginExtractResult, SemanticNode } from "@playwrong/protocol";
import type { RuntimePluginPackPayload } from "./messages";

interface RuntimeRuleSpec {
  hosts?: string[];
  paths?: string[];
  titleIncludes?: string[];
  requiredSignals?: string[];
  forbiddenSignals?: string[];
}

interface RuntimeSelectSpec {
  selector: string;
  attr?: string;
  all?: boolean;
  joinWith?: string;
  html?: boolean;
  trim?: boolean;
}

interface RuntimeFieldSpec {
  id: string;
  kind?: SemanticNode["kind"];
  label?: string;
  select: RuntimeSelectSpec;
}

interface RuntimeListFieldSpec {
  id: string;
  kind?: SemanticNode["kind"];
  label?: string;
  selector: string;
  attr?: string;
  html?: boolean;
  trim?: boolean;
}

interface RuntimeListSpec {
  id: string;
  label?: string;
  itemSelector: string;
  itemIdPrefix?: string;
  fields: RuntimeListFieldSpec[];
}

interface RuntimeExtractSpec {
  pageType: string;
  rootSelector?: string;
  fields: RuntimeFieldSpec[];
  lists: RuntimeListSpec[];
  pageCalls?: FunctionCallDef[];
}

interface RuntimeScriptSpec {
  scriptId: string;
  priority?: number;
  rules: RuntimeRuleSpec[];
  extract: RuntimeExtractSpec;
}

interface RuntimePackFile {
  scripts: RuntimeScriptSpec[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const parsed = asString(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asFunctionCalls(value: unknown): FunctionCallDef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: FunctionCallDef[] = [];
  for (const item of value) {
    const obj = asObject(item);
    if (!obj) {
      continue;
    }
    const name = asString(obj.name);
    if (!name) {
      continue;
    }
    const next: FunctionCallDef = { name };
    if (typeof obj.sideEffect === "boolean") {
      next.sideEffect = obj.sideEffect;
    }
    const argsSchema = asObject(obj.argsSchema);
    if (argsSchema) {
      next.argsSchema = argsSchema;
    }
    const returns = asString(obj.returns);
    if (returns) {
      next.returns = returns;
    }
    out.push(next);
  }
  return out.length > 0 ? out : undefined;
}

function parseRule(value: unknown): RuntimeRuleSpec | null {
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const rule: RuntimeRuleSpec = {};
  const hosts = asStringArray(obj.hosts);
  const paths = asStringArray(obj.paths);
  const titleIncludes = asStringArray(obj.titleIncludes);
  const requiredSignals = asStringArray(obj.requiredSignals);
  const forbiddenSignals = asStringArray(obj.forbiddenSignals);

  if (hosts.length > 0) {
    rule.hosts = hosts;
  }
  if (paths.length > 0) {
    rule.paths = paths;
  }
  if (titleIncludes.length > 0) {
    rule.titleIncludes = titleIncludes;
  }
  if (requiredSignals.length > 0) {
    rule.requiredSignals = requiredSignals;
  }
  if (forbiddenSignals.length > 0) {
    rule.forbiddenSignals = forbiddenSignals;
  }

  if (!rule.hosts && !rule.paths && !rule.titleIncludes && !rule.requiredSignals && !rule.forbiddenSignals) {
    return null;
  }
  return rule;
}

function parseSelect(value: unknown): RuntimeSelectSpec | null {
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const selector = asString(obj.selector);
  if (!selector) {
    return null;
  }
  const select: RuntimeSelectSpec = { selector };

  const attr = asString(obj.attr);
  if (attr) {
    select.attr = attr;
  }
  const joinWith = asString(obj.joinWith);
  if (joinWith) {
    select.joinWith = joinWith;
  }
  const all = asBoolean(obj.all);
  if (all !== undefined) {
    select.all = all;
  }
  const html = asBoolean(obj.html);
  if (html !== undefined) {
    select.html = html;
  }
  const trim = asBoolean(obj.trim);
  if (trim !== undefined) {
    select.trim = trim;
  }

  return select;
}

function asNodeKind(value: unknown): SemanticNode["kind"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const kinds = new Set<SemanticNode["kind"]>([
    "group",
    "section",
    "form",
    "list",
    "item",
    "table",
    "row",
    "cell",
    "editable",
    "action",
    "select",
    "toggle",
    "content"
  ]);
  return kinds.has(value as SemanticNode["kind"]) ? (value as SemanticNode["kind"]) : undefined;
}

function parseField(value: unknown): RuntimeFieldSpec | null {
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const id = asString(obj.id);
  if (!id) {
    return null;
  }
  const select = parseSelect(obj.select);
  if (!select) {
    return null;
  }
  const out: RuntimeFieldSpec = {
    id,
    select
  };
  const label = asString(obj.label);
  if (label) {
    out.label = label;
  }
  const kind = asNodeKind(obj.kind);
  if (kind) {
    out.kind = kind;
  }
  return out;
}

function parseListField(value: unknown): RuntimeListFieldSpec | null {
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const id = asString(obj.id);
  const selector = asString(obj.selector);
  if (!id || !selector) {
    return null;
  }
  const out: RuntimeListFieldSpec = {
    id,
    selector
  };
  const label = asString(obj.label);
  if (label) {
    out.label = label;
  }
  const kind = asNodeKind(obj.kind);
  if (kind) {
    out.kind = kind;
  }
  const attr = asString(obj.attr);
  if (attr) {
    out.attr = attr;
  }
  const html = asBoolean(obj.html);
  if (html !== undefined) {
    out.html = html;
  }
  const trim = asBoolean(obj.trim);
  if (trim !== undefined) {
    out.trim = trim;
  }
  return out;
}

function parseList(value: unknown): RuntimeListSpec | null {
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const id = asString(obj.id);
  const itemSelector = asString(obj.itemSelector);
  if (!id || !itemSelector) {
    return null;
  }
  const fieldsRaw = Array.isArray(obj.fields) ? obj.fields : [];
  const fields = fieldsRaw.map(parseListField).filter((item): item is RuntimeListFieldSpec => item !== null);
  if (fields.length === 0) {
    return null;
  }
  const out: RuntimeListSpec = {
    id,
    itemSelector,
    fields
  };
  const label = asString(obj.label);
  if (label) {
    out.label = label;
  }
  const itemIdPrefix = asString(obj.itemIdPrefix);
  if (itemIdPrefix) {
    out.itemIdPrefix = itemIdPrefix;
  }
  return out;
}

function parseScript(value: unknown): RuntimeScriptSpec | null {
  const obj = asObject(value);
  if (!obj) {
    return null;
  }

  const scriptId = asString(obj.scriptId);
  if (!scriptId) {
    return null;
  }

  const extractObj = asObject(obj.extract);
  if (!extractObj) {
    return null;
  }
  const pageType = asString(extractObj.pageType);
  if (!pageType) {
    return null;
  }

  const fieldsRaw = Array.isArray(extractObj.fields) ? extractObj.fields : [];
  const listsRaw = Array.isArray(extractObj.lists) ? extractObj.lists : [];
  const fields = fieldsRaw.map(parseField).filter((item): item is RuntimeFieldSpec => item !== null);
  const lists = listsRaw.map(parseList).filter((item): item is RuntimeListSpec => item !== null);

  const extract: RuntimeExtractSpec = {
    pageType,
    fields,
    lists
  };

  const rootSelector = asString(extractObj.rootSelector);
  if (rootSelector) {
    extract.rootSelector = rootSelector;
  }
  const pageCalls = asFunctionCalls(extractObj.pageCalls);
  if (pageCalls) {
    extract.pageCalls = pageCalls;
  }

  const script: RuntimeScriptSpec = {
    scriptId,
    rules: [],
    extract
  };

  const priority = asNumber(obj.priority);
  if (priority !== undefined) {
    script.priority = priority;
  }

  if (Array.isArray(obj.rules)) {
    const parsedRules = obj.rules.map(parseRule).filter((item): item is RuntimeRuleSpec => item !== null);
    if (parsedRules.length > 0) {
      script.rules = parsedRules;
    }
  }

  return script;
}

function parsePack(runtimeJson: string): RuntimePackFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(runtimeJson);
  } catch {
    return null;
  }
  const obj = asObject(parsed);
  if (!obj || !Array.isArray(obj.scripts)) {
    return null;
  }
  const scripts = obj.scripts.map(parseScript).filter((item): item is RuntimeScriptSpec => item !== null);
  if (scripts.length === 0) {
    return null;
  }
  return { scripts };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function selectWithin(scope: ParentNode, selector: string): Element[] {
  try {
    return Array.from(scope.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function readValueFromElement(
  element: Element,
  input: {
    attr?: string;
    html?: boolean;
    trim?: boolean;
  }
): string {
  let raw = "";
  if (input.attr) {
    raw = element.getAttribute(input.attr) ?? "";
  } else if (input.html) {
    raw = element.innerHTML;
  } else {
    raw = element.textContent ?? "";
  }
  if (input.trim === false) {
    return raw;
  }
  return normalizeText(raw);
}

function readSelectValue(scope: ParentNode, select: RuntimeSelectSpec): string | undefined {
  const elements = selectWithin(scope, select.selector);
  if (elements.length === 0) {
    return undefined;
  }
  const readOptions: { attr?: string; html?: boolean; trim?: boolean } = {};
  if (select.attr !== undefined) {
    readOptions.attr = select.attr;
  }
  if (select.html !== undefined) {
    readOptions.html = select.html;
  }
  if (select.trim !== undefined) {
    readOptions.trim = select.trim;
  }
  const values = elements
    .map((element) => readValueFromElement(element, readOptions))
    .filter((item) => item.length > 0);
  if (values.length === 0) {
    return undefined;
  }
  if (select.all) {
    return values.join(select.joinWith ?? " ");
  }
  return values[0];
}

function readListFieldValue(scope: ParentNode, field: RuntimeListFieldSpec): string | undefined {
  const elements = selectWithin(scope, field.selector);
  if (elements.length === 0) {
    return undefined;
  }
  const first = elements[0];
  if (!first) {
    return undefined;
  }
  const readOptions: { attr?: string; html?: boolean; trim?: boolean } = {};
  if (field.attr !== undefined) {
    readOptions.attr = field.attr;
  }
  if (field.html !== undefined) {
    readOptions.html = field.html;
  }
  if (field.trim !== undefined) {
    readOptions.trim = field.trim;
  }
  const value = readValueFromElement(first, readOptions);
  return value.length > 0 ? value : undefined;
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

function makeFieldNode(id: string, kind: SemanticNode["kind"], label: string | undefined, value: string): SemanticNode {
  const node: SemanticNode = {
    id,
    kind,
    value
  };
  if (label) {
    node.label = label;
  }
  return node;
}

function buildTree(extract: RuntimeExtractSpec): SemanticNode[] {
  const usedIds = new Set<string>();
  const roots: SemanticNode[] = [];

  const rootScope: ParentNode = (() => {
    if (!extract.rootSelector) {
      return document;
    }
    const first = selectWithin(document, extract.rootSelector)[0];
    return first ?? document;
  })();

  for (const field of extract.fields) {
    const value = readSelectValue(rootScope, field.select);
    if (value === undefined) {
      continue;
    }
    const nodeId = uniqueId(field.id, usedIds);
    roots.push(makeFieldNode(nodeId, field.kind ?? "content", field.label, value));
  }

  for (const list of extract.lists) {
    const items = selectWithin(rootScope, list.itemSelector);
    if (items.length === 0) {
      continue;
    }

    const children: SemanticNode[] = [];
    for (const [index, item] of items.entries()) {
      const itemBase = list.itemIdPrefix ? `${list.itemIdPrefix}.${index + 1}` : `${list.id}.${index + 1}`;
      const itemId = uniqueId(itemBase, usedIds);
      const itemChildren: SemanticNode[] = [];
      for (const field of list.fields) {
        const value = readListFieldValue(item, field);
        if (value === undefined) {
          continue;
        }
        const fieldId = uniqueId(`${itemId}.${field.id}`, usedIds);
        itemChildren.push(makeFieldNode(fieldId, field.kind ?? "content", field.label, value));
      }
      if (itemChildren.length === 0) {
        continue;
      }
      const itemNode: SemanticNode = {
        id: itemId,
        kind: "item",
        children: itemChildren
      };
      children.push(itemNode);
    }

    if (children.length === 0) {
      continue;
    }

    const listNode: SemanticNode = {
      id: uniqueId(list.id, usedIds),
      kind: "list",
      children
    };
    if (list.label) {
      listNode.label = list.label;
    }
    roots.push(listNode);
  }

  return roots;
}

function toRules(rules: RuntimeRuleSpec[]): ScriptMatchRule[] {
  return rules.map((rule) => {
    const out: ScriptMatchRule = {};
    if (rule.hosts && rule.hosts.length > 0) {
      out.hosts = rule.hosts;
    }
    if (rule.paths && rule.paths.length > 0) {
      out.paths = rule.paths;
    }
    if (rule.titleIncludes && rule.titleIncludes.length > 0) {
      out.titleIncludes = rule.titleIncludes;
    }
    if (rule.requiredSignals && rule.requiredSignals.length > 0) {
      out.requiredSignals = rule.requiredSignals;
    }
    if (rule.forbiddenSignals && rule.forbiddenSignals.length > 0) {
      out.forbiddenSignals = rule.forbiddenSignals;
    }
    return out;
  });
}

function toPluginScript(script: RuntimeScriptSpec): PluginScript {
  const pluginScript: PluginScript = {
    scriptId: script.scriptId,
    async extract(): Promise<PluginExtractResult> {
      const tree = buildTree(script.extract);
      if (tree.length === 0) {
        throw new Error("PLUGIN_MISS");
      }
      const result: PluginExtractResult = {
        pageType: script.extract.pageType,
        tree
      };
      if (script.extract.pageCalls) {
        result.pageCalls = script.extract.pageCalls;
      }
      return result;
    },
    async setValue() {
      throw new Error("PLUGIN_MISS");
    },
    async invoke() {
      throw new Error("PLUGIN_MISS");
    }
  };
  if (script.priority !== undefined) {
    pluginScript.priority = script.priority;
  }
  if (script.rules.length > 0) {
    pluginScript.rules = toRules(script.rules);
  }
  return pluginScript;
}

export function buildRuntimeManagedPluginScripts(packs: RuntimePluginPackPayload[] | undefined): PluginScript[] {
  if (!packs || packs.length === 0) {
    return [];
  }
  const scripts: PluginScript[] = [];
  for (const pack of packs) {
    const parsed = parsePack(pack.runtimeJson);
    if (!parsed) {
      console.warn(`[playwrong] skip runtime plugin ${pack.pluginId}: invalid runtimeJson`);
      continue;
    }
    for (const script of parsed.scripts) {
      scripts.push(toPluginScript(script));
    }
  }
  return scripts;
}
