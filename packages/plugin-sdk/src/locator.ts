import { BridgeError } from "@playwrong/protocol";
import type { LocatorSpec, LocatorStrategy } from "@playwrong/protocol";

export interface LocatorCandidate {
  key: string;
  visible?: boolean;
  enabled?: boolean;
  tagName?: string;
  role?: string;
  text?: string;
}

export interface LocatorRuntime {
  find(strategy: LocatorStrategy): Promise<LocatorCandidate[]>;
}

export type ResolveResult =
  | {
      ok: true;
      candidate: LocatorCandidate;
      score: number;
      candidates: Array<{ key: string; score: number }>;
    }
  | {
      ok: false;
      code: "NOT_FOUND" | "AMBIGUOUS";
      reason: string;
      candidates?: Array<{ key: string; score: number }>;
    };

interface ScoreState {
  candidate: LocatorCandidate;
  raw: number;
  bonus: number;
  penalty: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function textBonus(nearbyText: string[] | undefined, text: string | undefined): number {
  if (!nearbyText?.length || !text) {
    return 0;
  }
  const lower = text.toLowerCase();
  for (const token of nearbyText) {
    if (lower.includes(token.toLowerCase())) {
      return 0.05;
    }
  }
  return 0;
}

export async function resolveLocator(spec: LocatorSpec, runtime: LocatorRuntime): Promise<ResolveResult> {
  if (!spec.strategies.length) {
    throw new BridgeError("INVALID_REQUEST", "LocatorSpec.strategies cannot be empty");
  }

  const totalWeight = spec.strategies.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  if (totalWeight <= 0) {
    throw new BridgeError("INVALID_REQUEST", "LocatorSpec total weight must be > 0");
  }

  const scoreMap = new Map<string, ScoreState>();

  for (const strategy of spec.strategies) {
    const found = await runtime.find(strategy);

    if (strategy.required && found.length === 0) {
      return {
        ok: false,
        code: "NOT_FOUND",
        reason: `required strategy missing: ${strategy.type}:${strategy.query}`
      };
    }

    for (const candidate of found) {
      const state = scoreMap.get(candidate.key) ?? {
        candidate,
        raw: 0,
        bonus: 0,
        penalty: 0
      };

      state.raw += Math.max(0, strategy.weight);
      scoreMap.set(candidate.key, state);
    }
  }

  const threshold = spec.threshold ?? 0.6;
  const ambiguityDelta = spec.ambiguityDelta ?? 0.05;
  const entries: Array<{ key: string; state: ScoreState; score: number }> = [];

  for (const [key, state] of scoreMap.entries()) {
    if (spec.constraints?.visible && state.candidate.visible === false) {
      state.penalty += 0.3;
    }
    if (spec.constraints?.enabled && state.candidate.enabled === false) {
      state.penalty += 0.3;
    }
    if (spec.constraints?.tagNames?.length && state.candidate.tagName) {
      const allowed = spec.constraints.tagNames.map((x) => x.toLowerCase());
      if (!allowed.includes(state.candidate.tagName.toLowerCase())) {
        state.penalty += 0.2;
      }
    }
    if (spec.anchors?.role && state.candidate.role === spec.anchors.role) {
      state.bonus += 0.03;
    }
    state.bonus += textBonus(spec.anchors?.nearbyText, state.candidate.text);

    const score = clamp(state.raw / totalWeight + state.bonus - state.penalty);
    entries.push({ key, state, score });
  }

  entries.sort((a, b) => b.score - a.score);
  const shortlist = entries.filter((entry) => entry.score >= threshold);

  if (shortlist.length === 0) {
    return {
      ok: false,
      code: "NOT_FOUND",
      reason: "no candidate passed threshold",
      candidates: entries.map((x) => ({ key: x.key, score: x.score }))
    };
  }

  if (spec.constraints?.unique && shortlist.length > 1) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      reason: "unique constraint violated",
      candidates: shortlist.map((x) => ({ key: x.key, score: x.score }))
    };
  }

  const top = shortlist[0];
  if (!top) {
    return {
      ok: false,
      code: "NOT_FOUND",
      reason: "no candidate passed threshold"
    };
  }

  const second = shortlist[1];
  if (second && top.score - second.score <= ambiguityDelta) {
    return {
      ok: false,
      code: "AMBIGUOUS",
      reason: "top candidates too close",
      candidates: shortlist.map((x) => ({ key: x.key, score: x.score }))
    };
  }

  return {
    ok: true,
    candidate: top.state.candidate,
    score: top.score,
    candidates: shortlist.map((x) => ({ key: x.key, score: x.score }))
  };
}
