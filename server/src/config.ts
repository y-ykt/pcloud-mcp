// © 2026 Yasuhiko Yokote

/**
 * Reads and validates the environment variables.
 *
 * **They are read at startup, and a missing one fails at once.**
 * This keeps a missing setting from showing up as an obscure failure at runtime.
 */

import { comparable, normalizePathWith, rejectionReason } from "./guard/path.ts";

export interface Config {
  /** pCloud API endpoint. The default is the United States. */
  pcloudApiHost: string;
  /** Resource identifier of this server. **It must match the URL the user enters exactly.** */
  resourceUrl: string;
  /**
   * Path this server receives. Default `/mcp`.
   * With the `$default` stage of an HTTP API the stage name is not part of the URL,
   * so this normally equals the path of `resourceUrl`.
   */
  mcpPath: string;
  /**
   * Value published as `scopes_supported` in the PRM document (space-separated).
   * It tells the client what to request.
   */
  scopesSupported: string;
  /**
   * Ranges of source IP addresses allowed to call (comma-separated).
   * An HTTP API has no resource policy, so **the server checks them**.
   */
  allowedCidrs: string;
  /** Issuer URL of the Cognito User Pool. */
  cognitoIssuer: string;
  /** App client dedicated to this server. */
  cognitoClientId: string;
  /** Default number of entries `list` returns. */
  listMaxEntries: number;
  /** Default recursion depth of `list`. */
  listMaxDepth: number;
  /** Limit on the text `read_file` returns (bytes). */
  readMaxBytes: number;
  /** Limit on the size of a non-text file `read_file` fetches (bytes). Also limits a single file read by the git tools. */
  downloadMaxBytes: number;
  /**
   * Names of folders (or files) that are never entered, wherever they appear in a path.
   * They are refused, left out of listings and masked in the log.
   * **Empty by default: nothing is excluded.**
   */
  forbiddenNames: string[];
  /**
   * Folder on pCloud that holds the encrypted bare repositories.
   * The git tools read only from directly under this folder.
   * **`null` when no folder is named: the git tools are then disabled** (not listed, and they read nothing).
   */
  gitRoot: string | null;
  /** Fetch limit for a single git pack (bytes). Because of the authentication tag, a pack can only be fetched whole. */
  gitPackMaxBytes: number;
  /** Log verbosity. */
  logLevel: "debug" | "info" | "warn" | "error";
  /**
   * **Whether the returned body itself is written to the log.**
   *
   * This setting is for investigation only. When true,
   * **file content (base64) stays in CloudWatch for the retention period**.
   * It is separate from `logLevel`, **so that raising the level alone does not leak content**.
   */
  logResponseBody: boolean;
}

/** Absolute limits on counts and sizes that the implementation allows. Configured values must stay within them. */
export const HARD_LIMITS = {
  listMaxEntries: 1000,
  listMaxDepth: 5,
  readMaxBytes: 4 * 1024 * 1024,
  downloadMaxBytes: 64 * 1024 * 1024,
  gitPackMaxBytes: 256 * 1024 * 1024,
} as const;

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer (received: ${raw})`);
  }
  if (n > max) {
    throw new Error(`${key} must be ${max} or less (received: ${n})`);
  }
  return n;
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** Reads a required environment variable as an https URL. */
function urlFromEnv(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    throw new Error(`${key} is not set`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${key} is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`${key} must use https: ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/** Reads a path that starts with `/` and does not end with `/`. */
function pathFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!raw.startsWith("/")) {
    throw new Error(`${key} must start with / (received: ${raw})`);
  }
  return raw.replace(/\/+$/, "") || "/";
}

function requiredFromEnv(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") {
    throw new Error(`${key} is not set`);
  }
  return raw;
}

/**
 * The names that are never entered: a list separated by commas.
 *
 * Each entry is the name of one folder or file, so it cannot contain `/` and cannot be `.` or `..`.
 * A mistake here would silently protect nothing, so it fails at startup instead.
 */
function forbiddenNamesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of (env["FORBIDDEN_NAMES"] ?? "").split(",")) {
    const name = raw.trim();
    if (name === "") continue;
    if (name.includes("/") || name === "." || name === ".." || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error(
        `FORBIDDEN_NAMES must list names of single folders, separated by commas (received: ${JSON.stringify(name)})`,
      );
    }
    const key = comparable(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * The folder of bare repositories. The root itself is not accepted.
 *
 * **It goes through the same check as every other path**, against the forbidden names of this configuration.
 * The git tools build their paths from this value and a repository name, and do not check the result
 * again, so a forbidden folder set here would otherwise be read.
 */
function gitRootFromEnv(env: NodeJS.ProcessEnv, forbiddenNames: readonly string[]): string | null {
  // Not set, or empty: the git tools are disabled. There is no default folder
  if ((env["GIT_ROOT"] ?? "").trim() === "") return null;
  const raw = pathFromEnv(env, "GIT_ROOT", "/");
  let root: string;
  try {
    root = normalizePathWith(raw, forbiddenNames);
  } catch (e) {
    throw new Error(`GIT_ROOT is not accepted: ${rejectionReason(e)} (received: ${JSON.stringify(raw)})`);
  }
  if (root === "/") {
    throw new Error("GIT_ROOT must be a folder below the root");
  }
  return root;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env["PCLOUD_API_HOST"] ?? "https://api.pcloud.com";
  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error(`PCLOUD_API_HOST is not a valid URL: ${host}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`PCLOUD_API_HOST must use https: ${host}`);
  }

  const level = env["LOG_LEVEL"] ?? "info";
  if (!LOG_LEVELS.includes(level as (typeof LOG_LEVELS)[number])) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(" / ")} (received: ${level})`);
  }

  // **Loading only reads.** The list is returned, not put in force: `createHandler` does that,
  // in one place. `GIT_ROOT` below is checked against this list, not against the one in force
  const forbiddenNames = forbiddenNamesFromEnv(env);

  return {
    pcloudApiHost: host.replace(/\/+$/, ""),
    resourceUrl: urlFromEnv(env, "RESOURCE_URL"),
    mcpPath: pathFromEnv(env, "MCP_PATH", "/mcp"),
    scopesSupported: env["MCP_SCOPES"] ?? "pcloud/read",
    allowedCidrs: env["ALLOWED_CIDRS"] ?? "160.79.104.0/21",
    cognitoIssuer: urlFromEnv(env, "COGNITO_ISSUER"),
    cognitoClientId: requiredFromEnv(env, "COGNITO_CLIENT_ID"),
    listMaxEntries: intFromEnv(env, "LIST_MAX_ENTRIES", 200, HARD_LIMITS.listMaxEntries),
    listMaxDepth: intFromEnv(env, "LIST_MAX_DEPTH", 2, HARD_LIMITS.listMaxDepth),
    readMaxBytes: intFromEnv(env, "READ_MAX_BYTES", 256 * 1024, HARD_LIMITS.readMaxBytes),
    downloadMaxBytes: intFromEnv(env, "DOWNLOAD_MAX_BYTES", 1024 * 1024, HARD_LIMITS.downloadMaxBytes),
    forbiddenNames,
    gitRoot: gitRootFromEnv(env, forbiddenNames),
    gitPackMaxBytes: intFromEnv(env, "GIT_PACK_MAX_BYTES", 128 * 1024 * 1024, HARD_LIMITS.gitPackMaxBytes),
    logLevel: level as Config["logLevel"],
    // The default is false. It is enabled only when set explicitly to "true"
    logResponseBody: env["LOG_RESPONSE_BODY"] === "true",
  };
}
