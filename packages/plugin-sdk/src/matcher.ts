import type { MatchContext, MatchResult, PluginScript, ScriptMatchRule } from "./types";

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchHostPattern(pattern: string, host: string): boolean {
  if (!pattern.includes("*")) {
    return pattern.toLowerCase() === host.toLowerCase();
  }
  return wildcardToRegExp(pattern).test(host);
}

export function matchPathPattern(pattern: string | RegExp, pathname: string): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(pathname);
  }
  if (pattern.startsWith("^")) {
    return new RegExp(pattern).test(pathname);
  }
  if (pattern.includes("*")) {
    return wildcardToRegExp(pattern).test(pathname);
  }
  return pattern === pathname;
}

function matchQueryValue(value: string, expected: string | RegExp): boolean {
  if (expected instanceof RegExp) {
    return expected.test(value);
  }
  return value === expected;
}

export function evaluateRule(rule: ScriptMatchRule, ctx: MatchContext): MatchResult {
  const reasons: string[] = [];
  const url = ctx.url;
  let score = 0.05;

  if (rule.hosts?.length) {
    const hostHit = rule.hosts.some((p) => matchHostPattern(p, url.hostname));
    if (!hostHit) {
      return { matched: false, score: 0, reason: "host_miss" };
    }
    score += 0.35;
    reasons.push("host_hit");
  }

  if (rule.paths?.length) {
    const pathHit = rule.paths.some((p) => matchPathPattern(p, url.pathname));
    if (!pathHit) {
      return { matched: false, score: 0, reason: "path_miss" };
    }
    score += 0.25;
    reasons.push("path_hit");
  }

  if (rule.query) {
    for (const [key, expected] of Object.entries(rule.query)) {
      const got = url.searchParams.get(key);
      if (!got || !matchQueryValue(got, expected)) {
        return { matched: false, score: 0, reason: `query_miss:${key}` };
      }
      score += 0.05;
    }
    reasons.push("query_hit");
  }

  if (rule.titleIncludes?.length) {
    const title = (ctx.title ?? "").toLowerCase();
    for (const token of rule.titleIncludes) {
      if (!title.includes(token.toLowerCase())) {
        return { matched: false, score: 0, reason: `title_miss:${token}` };
      }
      score += 0.08;
    }
    reasons.push("title_hit");
  }

  const signals = new Set(ctx.signals ?? []);

  if (rule.requiredSignals?.length) {
    for (const signal of rule.requiredSignals) {
      if (!signals.has(signal)) {
        return { matched: false, score: 0, reason: `signal_miss:${signal}` };
      }
      score += 0.07;
    }
    reasons.push("required_signal_hit");
  }

  if (rule.forbiddenSignals?.length) {
    for (const signal of rule.forbiddenSignals) {
      if (signals.has(signal)) {
        return { matched: false, score: 0, reason: `forbidden_signal:${signal}` };
      }
    }
  }

  score += rule.scoreBoost ?? 0;
  score = Math.max(0, Math.min(0.99, score));

  const result: MatchResult = {
    matched: true,
    score
  };

  if (rule.pageType) {
    result.pageType = rule.pageType;
  }

  const reason = reasons.join(",");
  if (reason.length > 0) {
    result.reason = reason;
  }

  return result;
}

export async function pickScript(
  scripts: PluginScript[],
  ctx: MatchContext
): Promise<{ script: PluginScript; result: MatchResult } | null> {
  let best:
    | {
        script: PluginScript;
        result: MatchResult;
      }
    | undefined;

  for (const script of scripts) {
    const candidates: MatchResult[] = [];

    if (script.rules?.length) {
      for (const rule of script.rules) {
        candidates.push(evaluateRule(rule, ctx));
      }
    }

    if (script.match) {
      candidates.push(await script.match(ctx));
    }

    const localBest = candidates
      .filter((c) => c.matched)
      .sort((a, b) => b.score - a.score)[0];

    if (!localBest) {
      continue;
    }

    if (!best) {
      best = { script, result: localBest };
      continue;
    }

    const scoreGap = localBest.score - best.result.score;
    if (scoreGap > 0) {
      best = { script, result: localBest };
      continue;
    }

    if (scoreGap === 0) {
      const p1 = script.priority ?? 0;
      const p2 = best.script.priority ?? 0;
      if (p1 > p2) {
        best = { script, result: localBest };
        continue;
      }
      if (p1 === p2 && script.scriptId < best.script.scriptId) {
        best = { script, result: localBest };
      }
    }
  }

  return best ?? null;
}
