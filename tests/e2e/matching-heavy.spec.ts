import { describe, expect, it } from "bun:test";
import { pickScript } from "../../packages/plugin-sdk/src/index";
import type { PluginScript } from "../../packages/plugin-sdk/src/index";

function mkScript(id: string, pathPattern: string, signal: string): PluginScript {
  return {
    scriptId: id,
    priority: 1,
    rules: [
      {
        hosts: ["app.example.com", "beta.example.com", "*.internal.example.com"],
        paths: [pathPattern],
        requiredSignals: [signal],
        pageType: id
      }
    ],
    async extract() { return { pageType: id, tree: [] }; },
    async setValue() {},
    async invoke() { return null; }
  };
}

const scripts: PluginScript[] = [
  mkScript("login", "/login*", "has:form.login"),
  mkScript("settings", "/settings*", "has:nav.settings"),
  mkScript("billing", "/billing*", "has:table.invoice"),
  mkScript("search", "/search*", "has:input.search")
];

describe("heavy page matching", () => {
  const hosts = ["app.example.com", "beta.example.com", "qa.internal.example.com", "evil.com"];
  const pages = [
    { path: "/login", signal: "has:form.login", expected: "login" },
    { path: "/login/v2", signal: "has:form.login", expected: "login" },
    { path: "/settings", signal: "has:nav.settings", expected: "settings" },
    { path: "/settings/profile", signal: "has:nav.settings", expected: "settings" },
    { path: "/billing", signal: "has:table.invoice", expected: "billing" },
    { path: "/billing/2026", signal: "has:table.invoice", expected: "billing" },
    { path: "/search", signal: "has:input.search", expected: "search" },
    { path: "/search/advanced", signal: "has:input.search", expected: "search" }
  ];

  let no = 0;
  for (const host of hosts) {
    for (const page of pages) {
      for (const noise of [[], ["noise:a"], ["noise:a", "noise:b"]]) {
        no += 1;
        it(`massive-${no} host=${host} path=${page.path}`, async () => {
          const selected = await pickScript(scripts, {
            url: new URL(`https://${host}${page.path}`),
            title: "Example",
            signals: [page.signal, ...noise]
          });

          const hostAllowed =
            host === "app.example.com" ||
            host === "beta.example.com" ||
            host.endsWith(".internal.example.com");

          if (!hostAllowed) {
            expect(selected).toBeNull();
            return;
          }

          expect(selected?.script.scriptId).toBe(page.expected);
        });
      }
    }
  }
});
