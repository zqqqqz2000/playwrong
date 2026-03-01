import type { PluginScript } from "@playwrong/plugin-sdk";
import { managedPluginScripts } from "./managed-plugins.generated";
import { githubRepoManagerPluginScripts } from "./examples/github-repo-manager";

export interface UserSimpleStabilityRule {
  ruleId: string;
  hosts?: string[];
  paths?: Array<string | RegExp>;
  kConsecutive?: number;
  sampleIntervalMs?: number;
  timeoutMs?: number;
  maxPendingRequests?: number;
  maxRecentMutations?: number;
}

// User-defined simple rules (k value etc.).
export const userSimpleStabilityRules: UserSimpleStabilityRule[] = [
  // Example:
  // {
  //   ruleId: "google.relaxed.stable",
  //   hosts: ["www.google.com", "google.com", "*.google.*"],
  //   paths: ["/search"],
  //   kConsecutive: 6,
  //   sampleIntervalMs: 120,
  //   timeoutMs: 10000,
  //   maxPendingRequests: 2,
  //   maxRecentMutations: 8
  // }
];

// User-defined TS plugin scripts with optional `isStable` judge.
export const localUserPluginScripts: PluginScript[] = [
  ...githubRepoManagerPluginScripts,
  // Example:
  // {
  //   scriptId: "user.google.stable-judge",
  //   priority: 1000,
  //   rules: [{ hosts: ["www.google.com", "google.com", "*.google.*"], paths: ["/search"] }],
  //   stability: { kConsecutive: 5, sampleIntervalMs: 100, timeoutMs: 12000 },
  //   async isStable(input) {
  //     const query = input.match.url.searchParams.get("q") ?? "";
  //     const hasQuery = query.length > 0;
  //     return hasQuery && input.latest.pendingRequests <= 1 && input.latest.recentMutations <= 10;
  //   },
  //   async extract() {
  //     throw new Error("PLUGIN_MISS");
  //   },
  //   async setValue() {
  //     throw new Error("PLUGIN_MISS");
  //   },
  //   async invoke() {
  //     throw new Error("PLUGIN_MISS");
  //   }
  // }
];

export const userPluginScripts: PluginScript[] = [...managedPluginScripts, ...localUserPluginScripts];
