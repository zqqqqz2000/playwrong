import { BridgeError } from "./errors";
import type { NodeKind, SemanticNode } from "./types";

export const CONTAINER_KINDS = new Set<NodeKind>([
  "page",
  "group",
  "section",
  "form",
  "list",
  "item",
  "table",
  "row",
  "cell"
]);

export const EDITABLE_KINDS = new Set<NodeKind>(["editable", "select", "toggle"]);

export function isContainerKind(kind: NodeKind): boolean {
  return CONTAINER_KINDS.has(kind);
}

export function isEditableKind(kind: NodeKind): boolean {
  return EDITABLE_KINDS.has(kind);
}

export function walkNodes(
  nodes: SemanticNode[],
  visitor: (node: SemanticNode, path: string[]) => void,
  path: string[] = []
): void {
  for (const node of nodes) {
    const nextPath = [...path, node.id];
    visitor(node, nextPath);
    if (node.children?.length) {
      walkNodes(node.children, visitor, nextPath);
    }
  }
}

export function findNodeById(nodes: SemanticNode[], id: string): SemanticNode | undefined {
  for (const node of nodes) {
    if (node.id === id) {
      return node;
    }
    if (node.children?.length) {
      const found = findNodeById(node.children, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

export function assertUniqueNodeIds(nodes: SemanticNode[]): void {
  const ids = new Set<string>();
  walkNodes(nodes, (node) => {
    if (ids.has(node.id)) {
      throw new BridgeError("INVALID_TREE", `Duplicate node id: ${node.id}`, { id: node.id });
    }
    ids.add(node.id);
  });
}
