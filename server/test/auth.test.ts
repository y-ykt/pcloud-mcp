// © 2026 Yasuhiko Yokote

/**
 * Tests for token verification and the PRM document.
 *
 * The keys are generated inside the tests, and a `fetch` that returns the JWKS is injected.
 * They check that **a valid token is accepted, and that a tampered token, an expired token,
 * a wrong issuer and a wrong audience are rejected**.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

import { TokenVerifier, AuthError, type AuthFailure } from "../src/auth/verify.ts";
import { buildPrm, prmServedPaths, prmPublicUrl, wwwAuthenticate } from "../src/auth/prm.ts";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL";
const CLIENT_ID = "1example23456789";
const RESOURCE = "https://mcp.example.com/mcp";
const KID = "test-key-1";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Builds a JWT. A minimal implementation, for the tests only. */
function sign(
  claims: Record<string, unknown>,
  opts: { key?: KeyObject; kid?: string; alg?: string } = {},
): string {
  const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const s = createSign("RSA-SHA256");
  s.update(body);
  s.end();
  return `${body}.${s.sign(opts.key ?? privateKey).toString("base64url")}`;
}

const now = () => Math.floor(Date.now() / 1000);

/** Claims that are accepted as they are. Each test replaces some of them. */
function validClaims(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "11111111-2222-3333-4444-555555555555",
    iss: ISSUER,
    client_id: CLIENT_ID,
    token_use: "access",
    scope: "pcloud/read",
    exp: now() + 3600,
    iat: now(),
    ...extra,
  };
}

/** A `fetch` that returns the JWKS. It also counts its calls. */
function jwksFetch(keys = [{ ...(publicKey.export({ format: "jwk" }) as object), kid: KID, alg: "RS256", use: "sig" }]) {
  const state = { calls: 0 };
  const impl = (async (url: unknown) => {
    state.calls++;
    assert.match(String(url), /\/\.well-known\/jwks\.json$/);
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, state };
}

function verifier(fetchImpl: typeof fetch) {
  return new TokenVerifier({ issuer: ISSUER, clientId: CLIENT_ID, resourceUrl: RESOURCE, fetchImpl });
}

/** Checks that the token is rejected for the given reason. */
async function rejects(token: string, failure: AuthFailure, v = verifier(jwksFetch().impl)): Promise<void> {
  await assert.rejects(
    () => v.verify(token),
    (e: unknown) => {
      assert.ok(e instanceof AuthError, `not an AuthError: ${String(e)}`);
      assert.equal(e.failure, failure, `wrong reason (actual: ${e.failure})`);
      return true;
    },
  );
}

describe("TokenVerifier - tokens that must be accepted", () => {
  test("accepts a valid token", async () => {
    const v = verifier(jwksFetch().impl);
    const r = await v.verify(sign(validClaims()));
    assert.equal(r.clientId, CLIENT_ID);
    assert.deepEqual(r.scopes, ["pcloud/read"]);
    assert.ok(r.sub.length > 0);
  });

  test("accepts a token whose `aud` names this server", async () => {
    const v = verifier(jwksFetch().impl);
    const r = await v.verify(sign(validClaims({ aud: RESOURCE })));
    assert.equal(r.clientId, CLIENT_ID);
  });

  test("accepts a token whose `resource` names this server", async () => {
    const v = verifier(jwksFetch().impl);
    await v.verify(sign(validClaims({ resource: RESOURCE })));
  });

  test("reuses the JWKS without fetching it again", async () => {
    const { impl, state } = jwksFetch();
    const v = verifier(impl);
    await v.verify(sign(validClaims()));
    await v.verify(sign(validClaims()));
    assert.equal(state.calls, 1);
  });
});

describe("TokenVerifier - tokens that must be rejected", () => {
  test("a tampered token", async () => {
    const token = sign(validClaims());
    const [h, p, s] = token.split(".");
    // Replace the payload only
    const tampered = `${h}.${b64url(JSON.stringify(validClaims({ scope: "pcloud/write" })))}.${s}`;
    await rejects(tampered, "bad-signature");
  });

  test("a token signed with another key", async () => {
    await rejects(sign(validClaims(), { key: other.privateKey }), "bad-signature");
  });

  test("an expired token", async () => {
    await rejects(sign(validClaims({ exp: now() - 3600 })), "expired");
  });

  test("a token that is not yet valid", async () => {
    await rejects(sign(validClaims({ nbf: now() + 3600 })), "not-yet-valid");
  });

  test("a token from another issuer", async () => {
    await rejects(sign(validClaims({ iss: "https://evil.example.com/pool" })), "wrong-issuer");
  });

  test("a token for another audience - `aud`", async () => {
    await rejects(sign(validClaims({ aud: "https://other.example.com/mcp" })), "wrong-audience");
  });

  test("a token for another audience - `client_id`", async () => {
    await rejects(sign(validClaims({ client_id: "9other87654321" })), "wrong-audience");
  });

  test("an ID token (wrong `token_use`)", async () => {
    await rejects(sign(validClaims({ token_use: "id" })), "wrong-token-use");
  });

  test("a token with a replaced signature algorithm", async () => {
    const header = b64url(JSON.stringify({ alg: "none", kid: KID, typ: "JWT" }));
    await rejects(`${header}.${b64url(JSON.stringify(validClaims()))}.`, "malformed");
    await rejects(sign(validClaims(), { alg: "HS256" }), "unsupported-alg");
  });

  test("a token whose key is not found", async () => {
    await rejects(sign(validClaims(), { kid: "unknown-kid" }), "unknown-key");
  });

  test("a malformed token", async () => {
    for (const t of ["", "abc", "a.b", "a.b.c.d", "..", "a..c"]) {
      await rejects(t, "malformed");
    }
  });
});

describe("TokenVerifier.extractBearer", () => {
  test("extracts the token", () => {
    assert.equal(TokenVerifier.extractBearer("Bearer abc.def.ghi"), "abc.def.ghi");
    assert.equal(TokenVerifier.extractBearer("bearer abc.def.ghi"), "abc.def.ghi");
  });

  test("returns null when there is none", () => {
    for (const h of [undefined, "", "Basic abc", "Bearer"]) {
      assert.equal(TokenVerifier.extractBearer(h), null);
    }
  });
});

describe("PRM", () => {
  test("`resource` equals the resource identifier exactly", () => {
    const doc = buildPrm({ resourceUrl: RESOURCE, issuer: ISSUER, scopes: ["pcloud/read"] });
    assert.equal(doc.resource, RESOURCE);
    assert.deepEqual(doc.authorization_servers, [ISSUER]);
    assert.deepEqual(doc.bearer_methods_supported, ["header"]);
    assert.deepEqual(doc.scopes_supported, ["pcloud/read"]);
  });

  test("lists exactly one authorization server", () => {
    assert.equal(buildPrm({ resourceUrl: RESOURCE, issuer: ISSUER }).authorization_servers.length, 1);
  });

  test("paths the server answers - both the path-inserted form and the root form", () => {
    assert.deepEqual(prmServedPaths("/mcp"), [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]);
    assert.deepEqual(prmServedPaths("/"), ["/.well-known/oauth-protected-resource"]);
  });

  test("the public URL keeps the stage name", () => {
    // An API Gateway URL contains the stage name. Without it the document cannot be fetched
    assert.equal(
      prmPublicUrl("https://abc.execute-api.ap-northeast-1.amazonaws.com/prod/mcp", "/mcp"),
      "https://abc.execute-api.ap-northeast-1.amazonaws.com/prod/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(
      prmPublicUrl(RESOURCE, "/mcp"),
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  test("the value of `WWW-Authenticate`", () => {
    assert.equal(
      wwwAuthenticate(RESOURCE, "/mcp"),
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    const withError = wwwAuthenticate(RESOURCE, "/mcp", { code: "invalid_token", description: "The token has expired" });
    assert.match(withError, /error="invalid_token"/);
    assert.match(withError, /error_description="The token has expired"/);
  });

  test("no quotation mark or line break gets into `WWW-Authenticate`", () => {
    const v = wwwAuthenticate(RESOURCE, "/mcp", { code: "invalid_token", description: 'a"b\nc' });
    assert.equal(v.split('"').length % 2, 1, "the quotation marks are unbalanced");
    assert.ok(!v.includes("\n"));
  });
});
