// © 2026 Yasuhiko Yokote

/**
 * Tests for the entry point (routing and the 401 response).
 *
 * Nothing connects to pCloud. An injected provider stands in for fetching the token.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";

import { createHandler, type ProxyEvent, type TokenProvider } from "../src/handler.ts";
import { TokenVerifier } from "../src/auth/verify.ts";
import { isForbiddenName } from "../src/guard/path.ts";
import type { Config } from "../src/config.ts";

const ISSUER = "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_TESTPOOL";
const CLIENT_ID = "1example23456789";
const RESOURCE = "https://mcp.example.com/mcp";
const KID = "test-key-1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function accessToken(extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT" };
  const claims = {
    sub: "11111111-2222-3333-4444-555555555555",
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: "access",
    exp: now + 3600,
    ...extra,
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const s = createSign("RSA-SHA256");
  s.update(body);
  s.end();
  return `${body}.${s.sign(privateKey).toString("base64url")}`;
}

const jwksFetch = (async () =>
  new Response(
    JSON.stringify({
      keys: [{ ...(publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" }],
    }),
    { status: 200 },
  )) as unknown as typeof fetch;

const config: Config = {
  pcloudApiHost: "https://api.pcloud.com",
  resourceUrl: RESOURCE,
  mcpPath: "/mcp",
  scopesSupported: "pcloud/read",
  allowedCidrs: "160.79.104.0/21,203.0.113.0/24",
  cognitoIssuer: ISSUER,
  cognitoClientId: CLIENT_ID,
  listMaxEntries: 200,
  listMaxDepth: 2,
  forbiddenNames: [],
  gitRoot: "/git-repository",
  gitPackMaxBytes: 128 * 1024 * 1024,
  readMaxBytes: 262144,
  downloadMaxBytes: 1048576,
  logLevel: "error",
  logResponseBody: false, // no log output during the tests
};

/** A token provider that counts its calls. */
function countingProvider(): TokenProvider & { calls: number } {
  const p = {
    calls: 0,
    async get() {
      p.calls++;
      return "dummy-pcloud-token";
    },
  };
  return p;
}

function build(provider: TokenProvider = countingProvider(), cfg: Config = config) {
  return createHandler({
    config: cfg,
    tokenProvider: provider,
    verifier: new TokenVerifier({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      resourceUrl: RESOURCE,
      fetchImpl: jwksFetch,
    }),
  });
}

/** A source address inside the allowed range. */
const ALLOWED_IP = "203.0.113.10";

/** Builds a request in the HTTP API payload format 2.0. */
function event(
  method: string,
  path: string,
  opts: { auth?: string; body?: unknown; sourceIp?: string; base64?: boolean } = {},
): ProxyEvent {
  const body =
    opts.body === undefined
      ? null
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  return {
    version: "2.0",
    rawPath: path,
    requestContext: { http: { method, path, sourceIp: opts.sourceIp ?? ALLOWED_IP } },
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
    ...(body === null ? {} : { body }),
    ...(opts.base64 === true ? { isBase64Encoded: true } : {}),
  };
}

const post = (body: unknown, auth?: string): ProxyEvent =>
  event("POST", "/mcp", auth === undefined ? { body } : { body, auth });

const get = (path: string): ProxyEvent => event("GET", path);

describe("PRM", () => {
  test("is served at both the path-inserted form and the root form", async () => {
    const h = build();
    for (const p of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await h(get(p));
      assert.equal(res.statusCode, 200);
      const doc = JSON.parse(res.body) as { resource: string; authorization_servers: string[] };
      assert.equal(doc.resource, RESOURCE, "resource does not equal the resource identifier");
      assert.deepEqual(doc.authorization_servers, [ISSUER]);
    }
  });

  test("is served without authentication", async () => {
    const res = await build()(get("/.well-known/oauth-protected-resource/mcp"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["www-authenticate"], undefined);
  });
});

describe("routing", () => {
  test("GET /mcp returns 405 with Allow", async () => {
    const res = await build()(get("/mcp"));
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers["allow"], "POST");
  });

  test("an unknown path returns 404", async () => {
    assert.equal((await build()(get("/whatever"))).statusCode, 404);
  });

  test("a trailing slash is ignored", async () => {
    assert.equal((await build()(get("/mcp/"))).statusCode, 405);
  });
});

describe("authentication", () => {
  test("no token returns 401 with WWW-Authenticate", async () => {
    const res = await build()(post({ jsonrpc: "2.0", id: 1, method: "ping" }));
    assert.equal(res.statusCode, 401);
    const wa = res.headers["www-authenticate"] ?? "";
    assert.match(wa, /^Bearer resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\//);
    assert.ok(!wa.includes("error="), "error must not be added when there is no token");
  });

  test("an invalid token returns 401 with error=invalid_token", async () => {
    const res = await build()(post({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer a.b.c"));
    assert.equal(res.statusCode, 401);
    assert.match(res.headers["www-authenticate"] ?? "", /error="invalid_token"/);
  });

  test("an expired token also returns 401", async () => {
    const expired = accessToken({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await build()(post({ jsonrpc: "2.0", id: 1, method: "ping" }, `Bearer ${expired}`));
    assert.equal(res.statusCode, 401);
  });

  test("a valid token is accepted", async () => {
    const res = await build()(post({ jsonrpc: "2.0", id: 1, method: "ping" }, `Bearer ${accessToken()}`));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { jsonrpc: "2.0", id: 1, result: {} });
  });

  test("the header name is case-insensitive", async () => {
    const h = build();
    const res = await h({
      ...event("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } }),
      headers: { AUTHORIZATION: `Bearer ${accessToken()}` },
    });
    assert.equal(res.statusCode, 200);
  });
});

describe("MCP messages", () => {
  test("initialize does not fetch the pCloud token", async () => {
    const provider = countingProvider();
    const h = build(provider);
    const res = await h(
      post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, `Bearer ${accessToken()}`),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(provider.calls, 0, "initialize called Secrets Manager");
  });

  test("tools/list does not fetch it either", async () => {
    const provider = countingProvider();
    const res = await build(provider)(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, `Bearer ${accessToken()}`),
    );
    const body = JSON.parse(res.body) as { result: { tools: { name: string }[] } };
    assert.deepEqual(
      body.result.tools.map((t) => t.name),
      ["list", "stat", "read_file", "git_ls", "git_read", "git_log"],
    );
    assert.equal(provider.calls, 0);
  });

  test("**tools/list has no git tool when the git feature is disabled**", async () => {
    const res = await build(countingProvider(), { ...config, gitRoot: null })(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, `Bearer ${accessToken()}`),
    );
    const body = JSON.parse(res.body) as { result: { tools: { name: string }[] } };
    assert.deepEqual(body.result.tools.map((t) => t.name), ["list", "stat", "read_file"]);
  });

  test("a git tool called by name while disabled is an unknown tool, and nothing is fetched", async () => {
    const provider = countingProvider();
    const res = await build(provider, { ...config, gitRoot: null })(
      post(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "git_ls", arguments: { repo: "x" } } },
        `Bearer ${accessToken()}`,
      ),
    );
    // A tool that is not listed is refused by the protocol layer, like any other unknown name
    const body = JSON.parse(res.body) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32601);
    assert.equal(body.error.message, "Unknown tool: git_ls");
    assert.equal(provider.calls, 0, "the pCloud token was fetched for a call that cannot do anything");
  });

  test("broken JSON returns 400 with -32700", async () => {
    const res = await build()(post("{not json", `Bearer ${accessToken()}`));
    assert.equal(res.statusCode, 400);
    assert.equal((JSON.parse(res.body) as { error: { code: number } }).error.code, -32700);
  });

  test("a batch returns 400 with -32600", async () => {
    const res = await build()(post([{ jsonrpc: "2.0", id: 1, method: "ping" }], `Bearer ${accessToken()}`));
    assert.equal(res.statusCode, 400);
    assert.equal((JSON.parse(res.body) as { error: { code: number } }).error.code, -32600);
  });

  test("a notification gets no body", async () => {
    const res = await build()(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }, `Bearer ${accessToken()}`),
    );
    assert.equal(res.statusCode, 202);
    assert.equal(res.body, "");
  });

  test("a body delivered as base64 is read too", async () => {
    const res = await build()(
      event("POST", "/mcp", {
        auth: `Bearer ${accessToken()}`,
        body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })).toString("base64"),
        base64: true,
      }),
    );
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as { id: number }).id, 7);
  });

  test("an unsupported method returns -32601", async () => {
    const res = await build()(
      post({ jsonrpc: "2.0", id: 3, method: "resources/read" }, `Bearer ${accessToken()}`),
    );
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as { error: { code: number } }).error.code, -32601);
  });
});

describe("source address check", () => {
  test("an address outside the range returns 403, rejected before authentication", async () => {
    const res = await build()(
      event("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" }, sourceIp: "198.51.100.7" }),
    );
    assert.equal(res.statusCode, 403);
    // The allowed range must not be disclosed
    assert.ok(!res.body.includes("160.79"), "the allowed range leaked into the response");
  });

  test("the PRM document is not served outside the range either", async () => {
    const res = await build()(
      event("GET", "/.well-known/oauth-protected-resource/mcp", { sourceIp: "198.51.100.7" }),
    );
    assert.equal(res.statusCode, 403);
  });

  test("an unknown source address is rejected too", async () => {
    const res = await build()({ version: "2.0", rawPath: "/mcp", requestContext: { http: { method: "POST" } } });
    assert.equal(res.statusCode, 403);
  });

  test("IPv6 is not allowed", async () => {
    const res = await build()(event("GET", "/mcp", { sourceIp: "2001:db8::1" }));
    assert.equal(res.statusCode, 403);
  });

  test("the REST API payload format (1.0) works too", async () => {
    const res = await build()({
      httpMethod: "GET",
      path: "/mcp",
      headers: {},
      requestContext: { identity: { sourceIp: ALLOWED_IP } },
    });
    assert.equal(res.statusCode, 405);
  });
});

describe("the forbidden names are put in force by the handler", () => {
  test("**building a handler applies the list of its configuration**", () => {
    build(countingProvider(), { ...config, forbiddenNames: ["only-here"] });
    assert.equal(isForbiddenName("only-here"), true);
    build(countingProvider(), { ...config, forbiddenNames: [] });
    assert.equal(isForbiddenName("only-here"), false);
  });
});
