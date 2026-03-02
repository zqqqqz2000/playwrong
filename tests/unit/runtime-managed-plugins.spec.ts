import { afterEach, describe, expect, it } from "bun:test";
import { buildRuntimeManagedPluginScripts } from "../../apps/extension/src/runtime-managed-plugins";
import type { RuntimePluginPackPayload } from "../../apps/extension/src/messages";

const ORIGINAL_DOCUMENT = globalThis.document;

afterEach(() => {
  if (ORIGINAL_DOCUMENT) {
    globalThis.document = ORIGINAL_DOCUMENT;
    return;
  }
  Reflect.deleteProperty(globalThis, "document");
});

describe("runtime managed plugins", () => {
  it("parses runtime pack and extracts fields/lists from HTML", async () => {
    if (typeof DOMParser === "undefined") {
      return;
    }

    const html = `
      <html>
        <head><title>Runtime Test</title></head>
        <body>
          <main>
            <h1>Wedata Runtime</h1>
            <div class="result-card"><span class="title">row-1</span><a href="/r1">open</a></div>
            <div class="result-card"><span class="title">row-2</span><a href="/r2">open</a></div>
          </main>
        </body>
      </html>
    `;

    const parsed = new DOMParser().parseFromString(html, "text/html");
    globalThis.document = parsed;

    const pack: RuntimePluginPackPayload = {
      pluginId: "example.runtime.plugin",
      name: "runtime",
      version: "0.1.0",
      updatedAt: new Date().toISOString(),
      runtimeJson: JSON.stringify({
        scripts: [
          {
            scriptId: "example.runtime.script",
            rules: [{ hosts: ["example.com"] }],
            extract: {
              pageType: "runtime.test",
              rootSelector: "main",
              fields: [
                {
                  id: "page.title",
                  label: "Title",
                  select: { selector: "h1" }
                }
              ],
              lists: [
                {
                  id: "result.list",
                  itemSelector: ".result-card",
                  fields: [
                    { id: "title", selector: ".title" },
                    { id: "link", selector: "a", attr: "href" }
                  ]
                }
              ]
            }
          }
        ]
      })
    };

    const scripts = buildRuntimeManagedPluginScripts([pack]);
    expect(scripts).toHaveLength(1);
    const runtimeScript = scripts[0];
    if (!runtimeScript) {
      throw new Error("runtime script missing");
    }

    const result = await runtimeScript.extract({
      url: new URL("https://example.com/foo"),
      title: "Runtime Test",
      signals: []
    });

    expect(result.pageType).toBe("runtime.test");
    expect(result.tree.length).toBeGreaterThan(0);

    const listNode = result.tree.find((node) => node.id === "result.list");
    expect(listNode?.kind).toBe("list");
    expect(listNode?.children?.length).toBe(2);
  });
});
