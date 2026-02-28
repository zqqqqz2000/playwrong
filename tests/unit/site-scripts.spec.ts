import { describe, expect, it } from "bun:test";
import { pickScript } from "../../packages/plugin-sdk/src/index";
import { createBuiltinSiteScripts } from "../../apps/extension/src/site-scripts/index";

const scripts = createBuiltinSiteScripts();

describe("builtin site scripts", () => {
  const cases: Array<{
    id: string;
    url: string;
    title: string;
    signals: string[];
    expected: string | null;
  }> = [
    {
      id: "google-host",
      url: "https://www.google.com/search?q=llm",
      title: "Google",
      signals: ["has:search.query", "has:search.submit", "has:search.results"],
      expected: "google.search"
    },
    {
      id: "google-fallback-title-signal",
      url: "http://127.0.0.1:8090/google-like.html",
      title: "Google",
      signals: ["has:search.query", "has:search.submit"],
      expected: "google.search"
    },
    {
      id: "bing-host",
      url: "https://www.bing.com/search?q=llm",
      title: "Bing",
      signals: ["has:search.query", "has:search.submit", "has:search.results"],
      expected: "bing.search"
    },
    {
      id: "duck-host",
      url: "https://duckduckgo.com/?q=llm",
      title: "DuckDuckGo",
      signals: ["has:search.query", "has:search.submit", "has:search.results"],
      expected: "duckduckgo.search"
    },
    {
      id: "no-search-signal",
      url: "https://www.google.com/search?q=llm",
      title: "Google",
      signals: ["has:form"],
      expected: null
    },
    {
      id: "unknown-site",
      url: "https://example.com",
      title: "Example",
      signals: ["has:search.query", "has:search.submit"],
      expected: null
    }
  ];

  for (const c of cases) {
    it(`picks script: ${c.id}`, async () => {
      const selected = await pickScript(scripts, {
        url: new URL(c.url),
        title: c.title,
        signals: c.signals
      });
      expect(selected?.script.scriptId ?? null).toBe(c.expected);
    });
  }
});

