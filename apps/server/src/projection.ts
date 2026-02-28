import { walkNodes } from "@playwrong/protocol";
import type { PullFile, ScalarValue, SemanticNode } from "@playwrong/protocol";

function sanitizeNodeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function scalarToFileContent(value: ScalarValue | undefined): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function nodeKindToFileKind(
  kind: SemanticNode["kind"]
): PullFile["kind"] | undefined {
  if (kind === "editable") {
    return "editable";
  }
  if (kind === "select") {
    return "select";
  }
  if (kind === "toggle") {
    return "toggle";
  }
  return undefined;
}

export function projectPullFiles(pageId: string, tree: SemanticNode[]): PullFile[] {
  const files: PullFile[] = [];

  walkNodes(tree, (node) => {
    const fileKind = nodeKindToFileKind(node.kind);
    if (!fileKind) {
      return;
    }
    files.push({
      id: node.id,
      kind: fileKind,
      path: `pages/${pageId}/editable/${sanitizeNodeId(node.id)}.txt`,
      content: scalarToFileContent(node.value)
    });
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}
