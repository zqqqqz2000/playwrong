import { describe, expect, it } from "bun:test";
import { renderPageXml } from "../../packages/protocol/src/index";
import { projectPullFiles } from "../../apps/server/src/index";

describe("projection", () => {
  it("renders nested XML and file mapping", () => {
    const snapshot = {
      pageId: "p1",
      pageType: "login",
      rev: 7,
      updatedAt: Date.now(),
      tree: [
        {
          id: "login.form",
          kind: "form" as const,
          children: [
            { id: "login.email", kind: "editable" as const, value: "a@b.com" },
            { id: "login.password", kind: "editable" as const, value: "" },
            { id: "login.submit", kind: "action" as const, value: "Sign in" }
          ]
        }
      ]
    };

    const xml = renderPageXml(snapshot);
    expect(xml).toContain("<form id=\"login.form\">");
    expect(xml).toContain("<editable id=\"login.email\">");
    expect(xml).toContain("a@b.com");

    const files = projectPullFiles("p1", snapshot.tree);
    expect(files).toHaveLength(2);
    const first = files[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.path).toContain("pages/p1/editable/");
    }
  });

  it("sanitizes node id in file path", () => {
    const tree = [{ id: "x/y:z", kind: "editable" as const, value: "v" }];
    const files = projectPullFiles("p1", tree);
    const first = files[0];
    expect(first).toBeDefined();
    if (first) {
      expect(first.path).toContain("x_y_z");
    }
  });
});
