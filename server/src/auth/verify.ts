// © 2026 Yasuhiko Yokote

/**
 * Access token verification.
 *
 * **Verification is done inside the Lambda function itself. No API Gateway Lambda authorizer is used.**
 * This gives reliable control over the `WWW-Authenticate` header sent with a `401`.
 *
 * What is checked (the token is rejected if any one check fails):
 *   signature / `iss` / `exp` and `nbf` / `token_use` / audience (`aud` or `client_id`)
 *
 * There are no package dependencies. The signature is verified with `node:crypto`.
 */
import { createPublicKey, createVerify, timingSafeEqual, type webcrypto } from "node:crypto";

/** Signature algorithm of the access tokens Cognito issues. **No other algorithm is accepted.** */
const ALLOWED_ALG = "RS256";

/** Allowance for clock skew (seconds). */
const CLOCK_SKEW_SEC = 60;

/** Interval at which the JWKS is fetched again (milliseconds). */
const JWKS_TTL_MS = 10 * 60 * 1000;

/** Minimum interval between refetches triggered by an unknown `kid` (milliseconds). It prevents fetches in rapid succession. */
const JWKS_MIN_REFRESH_MS = 60 * 1000;

export type AuthFailure =
  | "malformed"
  | "unsupported-alg"
  | "unknown-key"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "wrong-issuer"
  | "wrong-token-use"
  | "wrong-audience";

/** Indicates that a token was not accepted. The caller maps it to 401. */
export class AuthError extends Error {
  failure: AuthFailure;

  constructor(failure: AuthFailure, message: string) {
    super(message);
    this.name = "AuthError";
    this.failure = failure;
  }
}

export interface VerifyOptions {
  /** Issuer URL of the User Pool. */
  issuer: string;
  /** App client dedicated to this server. */
  clientId: string;
  /** Resource identifier of this server. The same value as `resource` in the PRM document. */
  resourceUrl: string;
  /** Replaceable, for tests. */
  fetchImpl?: typeof fetch;
}

/** Contents of a token that passed verification. **The token itself is not kept.** */
export interface VerifiedToken {
  sub: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

const b64urlToBuffer = (s: string): Buffer => Buffer.from(s, "base64url");

function decodeJson(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(b64urlToBuffer(part).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AuthError("malformed", "The token contents are invalid");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Fetches the JWKS and keeps it.
 *
 * To follow key rotation, it is fetched again when an unknown `kid` is seen.
 * A minimum interval keeps these fetches from happening in rapid succession.
 */
export class JwksCache {
  #url: string;
  #fetch: typeof fetch;
  #keys = new Map<string, Jwk>();
  #fetchedAt = 0;

  constructor(issuer: string, fetchImpl: typeof fetch = fetch) {
    this.#url = `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
    this.#fetch = fetchImpl;
  }

  async get(kid: string): Promise<Jwk> {
    const age = Date.now() - this.#fetchedAt;
    if (this.#keys.size === 0 || age > JWKS_TTL_MS) await this.#refresh();

    let key = this.#keys.get(kid);
    if (key === undefined && Date.now() - this.#fetchedAt > JWKS_MIN_REFRESH_MS) {
      await this.#refresh();
      key = this.#keys.get(kid);
    }
    if (key === undefined) {
      throw new AuthError("unknown-key", "The signing key of the token was not found");
    }
    return key;
  }

  async #refresh(): Promise<void> {
    const res = await this.#fetch(this.#url, { method: "GET" });
    if (!res.ok) throw new AuthError("unknown-key", `Failed to fetch the signing keys: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    this.#keys = new Map((body.keys ?? []).filter((k) => k.kid).map((k) => [k.kid, k]));
    this.#fetchedAt = Date.now();
  }
}

/** Verifies the signature part. */
function verifySignature(token: string, jwk: Jwk): boolean {
  const lastDot = token.lastIndexOf(".");
  const signed = token.slice(0, lastDot);
  const signature = b64urlToBuffer(token.slice(lastDot + 1));
  const key = createPublicKey({ key: jwk as unknown as webcrypto.JsonWebKey, format: "jwk" });
  const v = createVerify("RSA-SHA256");
  v.update(signed);
  v.end();
  return v.verify(key, signature);
}

/**
 * Compares strings. Strings of different lengths are unequal at once; strings of equal length are
 * compared in constant time (`timingSafeEqual` requires equal lengths).
 */
function equals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class TokenVerifier {
  #opts: VerifyOptions;
  #jwks: JwksCache;

  constructor(opts: VerifyOptions) {
    this.#opts = opts;
    this.#jwks = new JwksCache(opts.issuer, opts.fetchImpl ?? fetch);
  }

  /**
   * Extracts the token from the value of the `Authorization` header.
   *
   * @returns The token, or `null` when there is none (the caller returns 401)
   */
  static extractBearer(authorization: string | undefined): string | null {
    if (authorization === undefined) return null;
    const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    return m?.[1] ?? null;
  }

  /** Verifies the token. Throws {@link AuthError} when it does not pass. */
  async verify(token: string): Promise<VerifiedToken> {
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
      throw new AuthError("malformed", "The token format is invalid");
    }

    const header = decodeJson(parts[0]!);
    if (header["alg"] !== ALLOWED_ALG) {
      // Prevents substitution with `none` or HMAC
      throw new AuthError("unsupported-alg", `Unexpected signature algorithm: ${String(header["alg"])}`);
    }
    const kid = header["kid"];
    if (typeof kid !== "string") {
      throw new AuthError("malformed", "kid is missing");
    }

    const jwk = await this.#jwks.get(kid);
    if (!verifySignature(token, jwk)) {
      throw new AuthError("bad-signature", "The signature is not valid");
    }

    const claims = decodeJson(parts[1]!);
    const now = Math.floor(Date.now() / 1000);

    const exp = claims["exp"];
    if (typeof exp !== "number" || exp + CLOCK_SKEW_SEC < now) {
      throw new AuthError("expired", "The token has expired");
    }
    const nbf = claims["nbf"];
    if (typeof nbf === "number" && nbf - CLOCK_SKEW_SEC > now) {
      throw new AuthError("not-yet-valid", "The token is not yet valid");
    }

    const iss = claims["iss"];
    if (typeof iss !== "string" || !equals(iss, this.#opts.issuer)) {
      throw new AuthError("wrong-issuer", "Unexpected token issuer");
    }

    if (claims["token_use"] !== "access") {
      throw new AuthError("wrong-token-use", "Not an access token");
    }

    this.#checkAudience(claims);

    const scope = claims["scope"];
    return {
      sub: typeof claims["sub"] === "string" ? claims["sub"] : "",
      clientId: String(claims["client_id"] ?? ""),
      scopes: typeof scope === "string" ? scope.split(" ").filter(Boolean) : [],
      expiresAt: exp,
    };
  }

  /**
   * Checks whether the token is intended for this server.
   *
   * The MCP specification requires this check. When the token carries `aud`, one of its values must
   * equal the resource URL. Otherwise, when it carries `resource`, that must equal the resource URL.
   * **When it carries neither, a matching `client_id` is used instead.**
   * The last case assumes there is exactly one app client and it is dedicated to this server.
   */
  #checkAudience(claims: Record<string, unknown>): void {
    const { resourceUrl, clientId } = this.#opts;

    const aud = claims["aud"];
    const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.map(String) : [];
    if (audiences.length > 0) {
      if (!audiences.some((a) => equals(a, resourceUrl))) {
        throw new AuthError("wrong-audience", "The token is not intended for this server");
      }
      return;
    }

    const resource = claims["resource"];
    if (typeof resource === "string") {
      if (!equals(resource, resourceUrl)) {
        throw new AuthError("wrong-audience", "The token is not intended for this server");
      }
      return;
    }

    const cid = claims["client_id"];
    if (typeof cid !== "string" || !equals(cid, clientId)) {
      throw new AuthError("wrong-audience", "The token was not issued to the client of this server");
    }
  }
}
