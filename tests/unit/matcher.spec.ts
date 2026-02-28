import { describe, expect, it } from "bun:test";
import {
  evaluateRule,
  matchHostPattern,
  matchPathPattern,
  pickScript
} from "../../packages/plugin-sdk/src/index";
import type { MatchContext, PluginScript } from "../../packages/plugin-sdk/src/index";

describe("matchHostPattern", () => {
  const cases: Array<[string, string, boolean]> = [
    ["app.example.com", "app.example.com", true],
    ["APP.EXAMPLE.COM", "app.example.com", true],
    ["*.example.com", "app.example.com", true],
    ["*.example.com", "a.b.example.com", true],
    ["*.example.com", "example.com", false],
    ["api.*.example.com", "api.dev.example.com", true],
    ["api.*.example.com", "api.example.com", false],
    ["*.internal.example.com", "a.internal.example.com", true],
    ["*.internal.example.com", "internal.example.com", false],
    ["evil.com", "app.example.com", false]
  ];

  for (const [pattern, host, expected] of cases) {
    it(`host pattern ${pattern} -> ${host}`, () => {
      expect(matchHostPattern(pattern, host)).toBe(expected);
    });
  }
});

describe("matchPathPattern", () => {
  const cases: Array<[string | RegExp, string, boolean]> = [
    ["/login", "/login", true],
    ["/login", "/login/v2", false],
    ["/login*", "/login/v2", true],
    ["/account/*", "/account/profile", true],
    ["/account/*", "/settings", false],
    [/^\/billing\/\d+$/, "/billing/42", true],
    [/^\/billing\/\d+$/, "/billing/x", false],
    ["^/search", "/search/result", true],
    ["^/search", "/other", false]
  ];

  for (const [pattern, path, expected] of cases) {
    it(`path pattern ${String(pattern)} -> ${path}`, () => {
      expect(matchPathPattern(pattern, path)).toBe(expected);
    });
  }
});

describe("evaluateRule", () => {
  const ctx: MatchContext = {
    url: new URL("https://app.example.com/login?next=%2Fhome&mode=pwd"),
    title: "Sign In - Example",
    signals: ["has:form.login", "has:input[name=email]", "has:button[type=submit]"]
  };

  it("matches complete rule", () => {
    const result = evaluateRule(
      {
        hosts: ["*.example.com"],
        paths: ["/login*"],
        query: { mode: "pwd" },
        titleIncludes: ["sign in"],
        requiredSignals: ["has:form.login"]
      },
      ctx
    );
    expect(result.matched).toBe(true);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it("rejects forbidden signal", () => {
    const result = evaluateRule(
      {
        hosts: ["*.example.com"],
        paths: ["/login*"],
        forbiddenSignals: ["has:captcha"]
      },
      { ...ctx, signals: [...(ctx.signals ?? []), "has:captcha"] }
    );
    expect(result.matched).toBe(false);
  });

  it("fails on missing required signal", () => {
    const result = evaluateRule(
      {
        hosts: ["*.example.com"],
        requiredSignals: ["has:2fa"]
      },
      ctx
    );
    expect(result.matched).toBe(false);
    expect(result.reason).toContain("signal_miss");
  });
});

describe("pickScript", () => {
  const scripts: PluginScript[] = [
    {
      scriptId: "login",
      priority: 10,
      rules: [{ hosts: ["*.example.com"], paths: ["/login*"], pageType: "login" }],
      async extract() { return { pageType: "login", tree: [] }; },
      async setValue() {},
      async invoke() { return null; }
    },
    {
      scriptId: "settings",
      priority: 1,
      rules: [{ hosts: ["*.example.com"], paths: ["/settings*"], pageType: "settings" }],
      async extract() { return { pageType: "settings", tree: [] }; },
      async setValue() {},
      async invoke() { return null; }
    }
  ];

  it("selects login script", async () => {
    const selected = await pickScript(scripts, {
      url: new URL("https://app.example.com/login"),
      title: "Login"
    });
    expect(selected?.script.scriptId).toBe("login");
    expect(selected?.result.pageType).toBe("login");
  });

  it("returns null when no script matches", async () => {
    const selected = await pickScript(scripts, {
      url: new URL("https://app.unknown.com/login"),
      title: "Login"
    });
    expect(selected).toBeNull();
  });
});

describe("massive matching matrix", () => {
  const hosts = ["app.example.com", "beta.example.com", "qa.internal.example.com", "evil.com"];
  const paths = ["/login", "/login/v2", "/account", "/account/profile", "/billing/9", "/search"];
  const queries = ["?mode=pwd", "?mode=sso", ""];
  let i = 0;

  for (const host of hosts) {
    for (const path of paths) {
      for (const query of queries) {
        i += 1;
        it(`matrix-${i} ${host}${path}${query}`, () => {
          const ctx: MatchContext = {
            url: new URL(`https://${host}${path}${query}`),
            title: "Example"
          };
          const result = evaluateRule(
            {
              hosts: ["*.example.com", "*.internal.example.com"],
              paths: ["/login*", "/account*", /^\/billing\/\d+$/]
            },
            ctx
          );
          const hostOk = host.endsWith("example.com") || host.endsWith("internal.example.com");
          const pathOk =
            path.startsWith("/login") ||
            path.startsWith("/account") ||
            /^\/billing\/\d+$/.test(path);
          expect(result.matched).toBe(hostOk && pathOk);
        });
      }
    }
  }
});
