import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_PLAYWRONG_HOME_DIR = ".config/playwrong";
const DEFAULT_CONFIG_FILE_NAME = "config.toml";

interface ServerConfigSection {
  extension_request_timeout_ms?: number;
  extension_connect_grace_ms?: number;
}

interface PlaywrongConfigFile {
  server?: ServerConfigSection;
}

export interface ServerRuntimeConfig {
  requestTimeoutMs?: number;
  connectGracePeriodMs?: number;
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function resolvePlaywrongHomeDir(input?: string): string {
  const explicit = typeof input === "string" ? input.trim() : "";
  if (explicit) {
    const resolved = expandHomePath(explicit);
    return isAbsolute(resolved) ? resolved : join(process.cwd(), resolved);
  }
  return join(homedir(), DEFAULT_PLAYWRONG_HOME_DIR);
}

function toOptionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.trunc(value);
  if (normalized < 0) {
    return undefined;
  }
  return normalized;
}

function readConfigFile(path: string): PlaywrongConfigFile {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = Bun.TOML.parse(raw) as PlaywrongConfigFile;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function loadServerRuntimeConfig(input?: { playwrongHomeDir?: string }): ServerRuntimeConfig {
  const homeDir = resolvePlaywrongHomeDir(input?.playwrongHomeDir);
  const configPath = join(homeDir, DEFAULT_CONFIG_FILE_NAME);
  const config = readConfigFile(configPath);
  const server = config.server ?? {};

  const requestTimeoutMs = toOptionalNonNegativeInt(server.extension_request_timeout_ms);
  const connectGracePeriodMs = toOptionalNonNegativeInt(server.extension_connect_grace_ms);

  const runtimeConfig: ServerRuntimeConfig = {};
  if (requestTimeoutMs !== undefined) {
    runtimeConfig.requestTimeoutMs = requestTimeoutMs;
  }
  if (connectGracePeriodMs !== undefined) {
    runtimeConfig.connectGracePeriodMs = connectGracePeriodMs;
  }
  return runtimeConfig;
}
