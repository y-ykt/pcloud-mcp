// © 2026 Yasuhiko Yokote

/**
 * Protected Resource Metadata (RFC 9728) and the `WWW-Authenticate` header.
 *
 * Requirements:
 *   - An unauthenticated request gets **401** and `WWW-Authenticate: Bearer resource_metadata="…"`
 *   - `resource` in the PRM document must **match the URL the user entered exactly**
 *   - Of `authorization_servers`, **only the first entry is used**
 *
 * **The public URL and the path the server receives are handled separately,**
 * the former as `resourceUrl`, the latter as `mcpPath`.
 * With the `$default` stage of an HTTP API the URL contains no stage name, and the path of
 * `resourceUrl` equals `mcpPath`. A URL with a leading part that does not reach the server
 * (such as a stage name) is supported too:
 *   public URL     `https://…/prod/mcp`
 *   received path  `/mcp`
 */

export interface PrmOptions {
  /** Resource identifier of this server. Exactly the same value as the URL the user enters. */
  resourceUrl: string;
  /** Issuer URL of the authorization server (the Cognito User Pool). */
  issuer: string;
  /** Scopes the resource server accepts. */
  scopes?: string[];
}

export interface PrmDocument {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
}

/** Builds the PRM document. */
export function buildPrm(opts: PrmOptions): PrmDocument {
  return {
    resource: opts.resourceUrl,
    // Only the first entry is used, so only one is listed
    authorization_servers: [opts.issuer],
    bearer_methods_supported: ["header"],
    ...(opts.scopes && opts.scopes.length > 0 ? { scopes_supported: opts.scopes } : {}),
  };
}

const WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * PRM paths **the server accepts**.
 *
 * RFC 9728 defines a form in which the resource path is inserted after `.well-known`.
 * Because clients differ in how they discover the document, **the same document is also served at the root location**.
 */
export function prmServedPaths(mcpPath: string): string[] {
  const p = mcpPath.replace(/\/+$/, "");
  return p === "" || p === "/" ? [WELL_KNOWN] : [`${WELL_KNOWN}${p}`, WELL_KNOWN];
}

/**
 * The leading part of the resource URL that does not reach the server (such as the stage name).
 *
 * From `https://…/prod/mcp` and `/mcp` it yields `/prod`.
 */
function basePrefix(resourceUrl: string, mcpPath: string): string {
  const pathname = new URL(resourceUrl).pathname.replace(/\/+$/, "");
  const p = mcpPath.replace(/\/+$/, "");
  return pathname.endsWith(p) ? pathname.slice(0, pathname.length - p.length) : "";
}

/**
 * Absolute URL of the PRM document **as reachable from outside**, placed in `WWW-Authenticate`.
 *
 * When the resource URL has a leading part (such as a stage name), it is kept; without it the URL
 * could not be fetched. When there is none, the path is the well-known path itself.
 */
export function prmPublicUrl(resourceUrl: string, mcpPath: string): string {
  const u = new URL(resourceUrl);
  const path = `${basePrefix(resourceUrl, mcpPath)}${prmServedPaths(mcpPath)[0]}`;
  return new URL(path, u.origin).toString();
}

/**
 * Builds the value of the `WWW-Authenticate` header.
 *
 * When there is no token, it gives only `resource_metadata`.
 * When the token is invalid, it adds `error` as RFC 6750 specifies.
 */
export function wwwAuthenticate(
  resourceUrl: string,
  mcpPath: string,
  error?: { code: string; description: string },
): string {
  const parts = [`Bearer resource_metadata="${prmPublicUrl(resourceUrl, mcpPath)}"`];
  if (error) {
    parts.push(`error="${error.code}"`);
    // Keep quotation marks and line breaks out of the value
    parts.push(`error_description="${error.description.replace(/["\r\n]/g, " ")}"`);
  }
  return parts.join(", ");
}
