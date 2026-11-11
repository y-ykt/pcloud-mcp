// © 2026 Yasuhiko Yokote

/**
 * Entry point called from API Gateway.
 *
 * The deployment is an HTTP API (payload format 2.0). The REST API event shape (format 1.0)
 * is accepted as well.
 *
 * Routing is done here, not in API Gateway. The `$default` route sends every request to this function,
 * so it receives requests for every method and path.
 *
 * | Method and path | Response |
 * |---|---|
 * | `POST /mcp` | Verifies the token, handles the MCP message and returns **a single JSON document** |
 * | `GET /mcp` | **405** (because SSE is not implemented) |
 * | `GET /.well-known/oauth-protected-resource[/mcp]` | The PRM document |
 * | Anything else | 404 |
 *
 * Never logged:
 *   the pCloud token / access tokens / file content / the URLs returned by `getfilelink`
 */
import { createHash } from "node:crypto";
import { setForbiddenNames } from "./guard/path.ts";
import { loadConfig, type Config } from "./config.ts";
import { isAllowedIp, parseCidrs } from "./guard/ip.ts";
import { AuthError, TokenVerifier } from "./auth/verify.ts";
import { buildPrm, prmServedPaths, wwwAuthenticate } from "./auth/prm.ts";
import { handleMessage, type JsonRpcResponse, type Server, type ToolResult } from "./mcp/protocol.ts";
import { summarizeCall } from "./mcp/calllog.ts";
import { callTool, toolDefinitions } from "./mcp/tools.ts";
import { callGitTool, gitToolDefinitions } from "./git/tools.ts";
import { secretsManagerKeyProvider, type KeyProvider } from "./git/crypto.ts";
import { PCloudClient } from "./pcloud/client.ts";

// ---------------------------------------------------------------- Input and output shapes

/**
 * The request API Gateway passes in. Only the fields that are used are declared.
 *
 * Format 2.0 of an HTTP API is the main case, but the REST API shape (format 1.0) is accepted too.
 * Whichever arrives, {@link normalize} converts it to the same shape.
 */
export interface ProxyEvent {
  version?: string;
  /** Format 2.0 */
  rawPath?: string;
  requestContext?: {
    http?: { method?: string; path?: string; sourceIp?: string };
    identity?: { sourceIp?: string };
  };
  /** Format 1.0 */
  httpMethod?: string;
  path?: string;

  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

/** A request with the format differences removed. */
interface Request {
  method: string;
  path: string;
  sourceIp: string | undefined;
}

function normalize(event: ProxyEvent): Request {
  const method = (event.requestContext?.http?.method ?? event.httpMethod ?? "").toUpperCase();
  const raw = event.rawPath ?? event.requestContext?.http?.path ?? event.path ?? "";
  const path = raw.replace(/\/+$/, "") || "/";
  const sourceIp = event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp;
  return { method, path, sourceIp };
}

export interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

const json = (statusCode: number, body: unknown, extra: Record<string, string> = {}): ProxyResult => ({
  statusCode,
  headers: { ...JSON_HEADERS, ...extra },
  body: JSON.stringify(body),
});

/** Looks up a header, ignoring the case of its name. */
function header(event: ProxyEvent, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === target && v !== undefined) return v;
  }
  return undefined;
}

/** Extracts the request body. It may arrive base64-encoded. */
function bodyText(event: ProxyEvent): string {
  const raw = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
}

// ---------------------------------------------------------------- Logging

/**
 * Builds a log entry from the selected fields.
 *
 * **A caught exception is never written as it is**, because an exception thrown by the pCloud client
 * may contain a URL or a token.
 */
function log(cfg: Config, level: Config["logLevel"], fields: Record<string, unknown>): void {
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  if (order[level] < order[cfg.logLevel]) return;
  process.stdout.write(`${JSON.stringify({ level, ...fields })}\n`);
}

/**
 * Number of characters put into one CloudWatch event.
 *
 * **The limit is 256 KB.** base64 takes one byte per character, but
 * the body also contains Japanese text and grows through JSON escaping.
 * A line over the limit is truncated and **corrupted without any error**, so the body is split well below it.
 */
const LOG_CHUNK_CHARS = 64_000;

/**
 * Logs the returned body itself, in chunks (only when `LOG_RESPONSE_BODY=true`).
 *
 * **This setting is for investigation only.**
 * When enabled, **file content stays in CloudWatch**.
 *
 * The length and the SHA-256 are logged as well, **so that the rejoined chunks can be checked against the original**.
 */
function logResponseBody(cfg: Config, body: string): void {
  if (!cfg.logResponseBody || body === "") return;
  const total = Math.ceil(body.length / LOG_CHUNK_CHARS);
  const digest = createHash("sha256").update(body).digest("hex");
  for (let i = 0; i < total; i++) {
    log(cfg, "info", {
      event: "response_body",
      seq: i,
      of: total,
      chars: body.length,
      sha256: digest,
      data: body.slice(i * LOG_CHUNK_CHARS, (i + 1) * LOG_CHUNK_CHARS),
    });
  }
}

/**
 * Extracts the additional fields logged for a `tools/call`.
 *
 * The request and the response are already available here, so **the tools do not need to take on any logging responsibility.**
 * If building the record fails, the call itself still succeeds. A response is not dropped for the sake of logging.
 */
function callFields(
  message: unknown,
  response: JsonRpcResponse | null,
  verbose: boolean,
): Record<string, unknown> {
  try {
    const params = (message as { params?: Record<string, unknown> }).params ?? {};
    const name = typeof params["name"] === "string" ? params["name"] : "(unknown)";
    const raw = params["arguments"];
    const args =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    return summarizeCall(name, args, response?.result as ToolResult | undefined, verbose);
  } catch {
    return { tool: "(failed to build the record)" };
  }
}

// ---------------------------------------------------------------- pCloud token

/** Describes only the part of the Secrets Manager SDK that this server uses. */
interface SecretsManagerModule {
  SecretsManagerClient: new (config: { region: string }) => {
    send(command: unknown): Promise<{ SecretString?: string }>;
  };
  GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
}

/** A way to obtain the pCloud access token. */
export interface TokenProvider {
  get(): Promise<string>;
}

/**
 * Reads from Secrets Manager.
 *
 * **The token is kept in memory only for the lifetime of the execution environment.**
 * A pCloud token does not expire, so fetching it again on expiry is not considered.
 *
 * The AWS SDK is loaded dynamically, so that tests and checks run without installing the SDK
 * (the Lambda Node.js execution environment includes the SDK).
 */
export function secretsManagerTokenProvider(secretArn: string, region: string): TokenProvider {
  let cached: string | undefined;
  return {
    async get(): Promise<string> {
      if (cached !== undefined) return cached;
      // Resolved only at runtime, so that the development environment does not need the SDK
      const specifier = "@aws-sdk/client-secrets-manager";
      const sdk = (await import(specifier).catch(() => {
        throw new Error(`Could not load ${specifier}`);
      })) as SecretsManagerModule;
      const client = new sdk.SecretsManagerClient({ region });
      const res = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretArn }));
      const raw = res.SecretString;
      if (raw === undefined || raw === "") {
        throw new Error("The secret has no value. Register it");
      }
      // Accepts either {"access_token":"…"} or the token itself
      let token = raw.trim();
      if (token.startsWith("{")) {
        const parsed = JSON.parse(token) as Record<string, unknown>;
        const v = parsed["access_token"];
        if (typeof v !== "string" || v === "") {
          throw new Error("The secret has no access_token");
        }
        token = v;
      }
      cached = token;
      return token;
    },
  };
}

// ---------------------------------------------------------------- Main

export interface HandlerDeps {
  config: Config;
  tokenProvider: TokenProvider;
  verifier: TokenVerifier;
  /** The git decryption key. Without it the git tools refuse, saying it is not configured. */
  keyProvider?: KeyProvider;
}

export function createHandler(deps: HandlerDeps): (event: ProxyEvent) => Promise<ProxyResult> {
  const { config: cfg, tokenProvider, verifier, keyProvider } = deps;
  // **The one place where the forbidden names are put in force.** `loadConfig` only reads them
  setForbiddenNames(cfg.forbiddenNames);
  const prmDoc = buildPrm({
    resourceUrl: cfg.resourceUrl,
    issuer: cfg.cognitoIssuer,
    scopes: cfg.scopesSupported.split(/\s+/).filter((s) => s.length > 0),
  });
  const allowedCidrs = parseCidrs(cfg.allowedCidrs);
  const prmRoutes = new Set(prmServedPaths(cfg.mcpPath));
  const mcpPath = cfg.mcpPath;

  // Kept in this closure and reused by later invocations in the same execution environment
  let client: PCloudClient | undefined;

  /**
   * The pCloud client is **created only when a tool is first run.**
   * This avoids calling Secrets Manager for `initialize` or `tools/list`.
   */
  async function getClient(): Promise<PCloudClient> {
    client ??= new PCloudClient({
      apiHost: cfg.pcloudApiHost,
      accessToken: await tokenProvider.get(),
    });
    return client;
  }

  const server: Server = {
    name: "pcloud",
    version: "0.1.0",
    tools: [...toolDefinitions(cfg), ...gitToolDefinitions(cfg)],
    callTool: async (name, args) =>
      name.startsWith("git_")
        ? callGitTool(await getClient(), keyProvider, cfg, name, args)
        : callTool(await getClient(), cfg, name, args),
  };

  return async function handle(event: ProxyEvent): Promise<ProxyResult> {
    const started = Date.now();
    const { method, path, sourceIp } = normalize(event);

    // ---- Source address check. Rejects before token verification
    if (!isAllowedIp(sourceIp, allowedCidrs)) {
      // Log the source address. When the configured ranges differ from the actual ones, this is the only information available
      log(cfg, "warn", { event: "source_rejected", method, path, source_ip: sourceIp });
      // The allowed ranges are not disclosed
      return json(403, { error: "Source address not allowed" });
    }

    // ---- The PRM document is served without authentication
    if (method === "GET" && prmRoutes.has(path)) {
      return json(200, prmDoc, { "cache-control": "public, max-age=3600" });
    }

    // ---- SSE is not implemented, so GET gets 405
    if (method === "GET" && path === mcpPath) {
      return json(405, { error: "This resource accepts POST only" }, { allow: "POST" });
    }

    if (path !== mcpPath) {
      return json(404, { error: "No such path" });
    }
    if (method !== "POST") {
      return json(405, { error: "This resource accepts POST only" }, { allow: "POST" });
    }

    // ---- Authentication
    const token = TokenVerifier.extractBearer(header(event, "authorization"));
    if (token === null) {
      return json(
        401,
        { error: "Authentication required" },
        { "www-authenticate": wwwAuthenticate(cfg.resourceUrl, cfg.mcpPath) },
      );
    }
    let sub: string;
    try {
      sub = (await verifier.verify(token)).sub;
    } catch (e) {
      const failure = e instanceof AuthError ? e.failure : "invalid";
      const description = e instanceof AuthError ? e.message : "The token cannot be verified";
      log(cfg, "warn", { event: "auth_rejected", failure });
      return json(
        401,
        { error: description },
        {
          "www-authenticate": wwwAuthenticate(cfg.resourceUrl, cfg.mcpPath, {
            code: "invalid_token",
            description,
          }),
        },
      );
    }

    // ---- MCP message
    let message: unknown;
    try {
      message = JSON.parse(bodyText(event));
    } catch {
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Cannot be parsed as JSON" },
      });
    }
    if (Array.isArray(message)) {
      // Batches are not handled (removed in MCP 2025-06-18)
      return json(400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Several messages cannot be sent together in one request" },
      });
    }

    try {
      const response = await handleMessage(message, server);
      const rpcMethod = typeof (message as { method?: unknown })?.method === "string"
        ? (message as { method: string }).method
        : "(unknown)";
      // The response JSON is also what is returned, so **it is built once and reused.**
      // Building it a second time to measure its size would be wasteful for a response of about 900 KB
      const body = response === null ? "" : JSON.stringify(response);
      log(cfg, "info", {
        event: "mcp_call",
        method: rpcMethod,
        sub,
        elapsed_ms: Date.now() - started,
        ok: response?.error === undefined,
        // **Size of the body actually returned.** This is the value that counts against the receiver's limit
        body_chars: body.length,
        // Records which tool returned what and how much. **The content itself is not recorded**
        ...(rpcMethod === "tools/call"
          ? callFields(message, response, cfg.logLevel === "debug")
          : {}),
      });
      logResponseBody(cfg, body);
      // A notification gets no body
      return response === null
        ? { statusCode: 202, headers: JSON_HEADERS, body: "" }
        : { statusCode: 200, headers: JSON_HEADERS, body };
    } catch (e) {
      log(cfg, "error", {
        event: "internal_error",
        message: e instanceof Error ? e.message : "unknown",
      });
      return json(500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal server failure" },
      });
    }
  };
}

// ---------------------------------------------------------------- Lambda entry point

let cached: ((event: ProxyEvent) => Promise<ProxyResult>) | undefined;

/** The function Lambda calls. */
export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  if (cached === undefined) {
    const config = loadConfig();
    const secretArn = process.env["PCLOUD_SECRET_ARN"];
    if (secretArn === undefined || secretArn === "") {
      throw new Error("PCLOUD_SECRET_ARN is not set");
    }
    // Lambda always sets AWS_REGION. No region is assumed when it is missing
    const region = process.env["AWS_REGION"];
    if (region === undefined || region === "") {
      throw new Error("AWS_REGION is not set");
    }
    const gitSecretArn = process.env["GIT_SECRET_ARN"];
    cached = createHandler({
      config,
      tokenProvider: secretsManagerTokenProvider(secretArn, region),
      verifier: new TokenVerifier({
        issuer: config.cognitoIssuer,
        clientId: config.cognitoClientId,
        resourceUrl: config.resourceUrl,
      }),
      ...(gitSecretArn !== undefined && gitSecretArn !== ""
        ? { keyProvider: secretsManagerKeyProvider(gitSecretArn, region) }
        : {}),
    });
  }
  return cached(event);
}
