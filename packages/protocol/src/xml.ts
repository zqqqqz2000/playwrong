import type { PageSnapshot, ScalarValue, SemanticNode } from "./types";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function scalarToText(value: ScalarValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

function renderAttrs(attrs: Record<string, string | number | boolean | undefined>): string {
  const pairs: string[] = [];
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw === undefined) {
      continue;
    }
    pairs.push(`${key}="${escapeXml(String(raw))}"`);
  }
  return pairs.length ? ` ${pairs.join(" ")}` : "";
}

function renderNode(node: SemanticNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const attrs = renderAttrs({
    id: node.id,
    label: node.label,
    ...(node.attrs ?? {})
  });

  const callLines =
    node.calls?.map((call) => {
      const cAttrs = renderAttrs({
        name: call.name,
        sideEffect: call.sideEffect,
        returns: call.returns
      });
      return `${indent}  <functionCall${cAttrs}/>`;
    }) ?? [];

  const childLines = node.children?.map((child) => renderNode(child, depth + 1)) ?? [];
  const valueText = scalarToText(node.value);
  const hasInner = valueText.length > 0 || callLines.length > 0 || childLines.length > 0;

  if (!hasInner) {
    return `${indent}<${node.kind}${attrs}/>`;
  }

  const lines: string[] = [`${indent}<${node.kind}${attrs}>`];
  if (valueText.length > 0) {
    lines.push(`${indent}  ${escapeXml(valueText)}`);
  }
  lines.push(...callLines);
  lines.push(...childLines);
  lines.push(`${indent}</${node.kind}>`);
  return lines.join("\n");
}

export function renderPageXml(snapshot: PageSnapshot): string {
  const attrs = renderAttrs({
    id: snapshot.pageId,
    rev: snapshot.rev,
    pageType: snapshot.pageType,
    url: snapshot.url,
    title: snapshot.title
  });

  const pageCalls =
    snapshot.pageCalls?.map((call) => {
      const cAttrs = renderAttrs({
        name: call.name,
        sideEffect: call.sideEffect,
        returns: call.returns
      });
      return `  <functionCall${cAttrs}/>`;
    }) ?? [];

  const nodes = snapshot.tree.map((node) => renderNode(node, 1));
  return ["<page" + attrs + ">", ...pageCalls, ...nodes, "</page>"].join("\n");
}
