import { describe, expect, it } from "bun:test";
import {
  resolveLocator,
  type LocatorCandidate,
  type LocatorRuntime
} from "../../packages/plugin-sdk/src/index";
import type { LocatorSpec, LocatorStrategy } from "../../packages/protocol/src/index";

class FakeRuntime implements LocatorRuntime {
  constructor(private readonly table: Record<string, LocatorCandidate[]>) {}

  async find(strategy: LocatorStrategy): Promise<LocatorCandidate[]> {
    return this.table[`${strategy.type}:${strategy.query}`] ?? [];
  }
}

describe("resolveLocator", () => {
  it("chooses highest weighted candidate", async () => {
    const runtime = new FakeRuntime({
      "aria:Email input": [{ key: "A", visible: true, enabled: true, text: "Email" }],
      "css:#email": [{ key: "A", visible: true, enabled: true }]
    });

    const spec: LocatorSpec = {
      version: 1,
      strategies: [
        { type: "aria", query: "Email input", weight: 0.6 },
        { type: "css", query: "#email", weight: 0.4 }
      ],
      threshold: 0.5
    };

    const result = await resolveLocator(spec, runtime);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.key).toBe("A");
    }
  });

  it("returns NOT_FOUND when required strategy misses", async () => {
    const runtime = new FakeRuntime({});
    const spec: LocatorSpec = {
      version: 1,
      strategies: [{ type: "css", query: "#missing", weight: 1, required: true }]
    };
    const result = await resolveLocator(spec, runtime);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND");
    }
  });

  it("returns AMBIGUOUS when top scores are too close", async () => {
    const runtime = new FakeRuntime({
      "css:.btn": [
        { key: "A", visible: true, enabled: true },
        { key: "B", visible: true, enabled: true }
      ]
    });

    const spec: LocatorSpec = {
      version: 1,
      strategies: [{ type: "css", query: ".btn", weight: 1 }],
      threshold: 0.3,
      ambiguityDelta: 0.1
    };

    const result = await resolveLocator(spec, runtime);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("AMBIGUOUS");
    }
  });

  it("applies visibility penalty", async () => {
    const runtime = new FakeRuntime({
      "css:input": [
        { key: "A", visible: false, enabled: true },
        { key: "B", visible: true, enabled: true }
      ]
    });

    const spec: LocatorSpec = {
      version: 1,
      strategies: [{ type: "css", query: "input", weight: 1 }],
      constraints: { visible: true },
      threshold: 0.4
    };

    const result = await resolveLocator(spec, runtime);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.key).toBe("B");
    }
  });
});

describe("resolveLocator heavy matrix", () => {
  const thresholds = [0.2, 0.4, 0.6, 0.8];
  const highWeights = [0.5, 0.7, 0.9];
  const lowWeights = [0.1, 0.2, 0.3];
  let caseNo = 0;

  for (const threshold of thresholds) {
    for (const high of highWeights) {
      for (const low of lowWeights) {
        caseNo += 1;
        it(`matrix-${caseNo} threshold=${threshold} high=${high} low=${low}`, async () => {
          const runtime = new FakeRuntime({
            "aria:email": [{ key: "A", visible: true, enabled: true }],
            "css:#email": [{ key: "A", visible: true, enabled: true }],
            "text:email": [{ key: "B", visible: true, enabled: true }]
          });

          const spec: LocatorSpec = {
            version: 1,
            threshold,
            strategies: [
              { type: "aria", query: "email", weight: high },
              { type: "css", query: "#email", weight: high },
              { type: "text", query: "email", weight: low }
            ]
          };

          const result = await resolveLocator(spec, runtime);
          const expectedTopScore = (high + high) / (high + high + low);
          if (expectedTopScore >= threshold) {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.candidate.key).toBe("A");
            }
          } else {
            expect(result.ok).toBe(false);
          }
        });
      }
    }
  }
});
