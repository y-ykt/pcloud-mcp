// © 2026 Yasuhiko Yokote

/**
 * pCloud API client.
 *
 * **All traffic from this server to pCloud goes through this module.**
 * No code path sends an HTTP request without it.
 *
 * Read-only access is guaranteed by structure, not by convention:
 *   - Only four methods can be called: `listfolder` / `stat` / `getfilelink` / `checksumfile`.
 *     **There is no function that takes an arbitrary method name and calls it**
 *   - HTTP is **GET only**. No code path issues POST / PUT / DELETE
 *   - The host `getfilelink` returns is checked to be under the pCloud domain before it is used
 */
import { createHash } from "node:crypto";

import {
  classifyResult,
  type ChecksumResponse,
  type ContentLink,
  type FileLinkResponse,
  type Metadata,
  type MetadataResponse,
  type ResultClass,
} from "./types.ts";

/** Methods that may be called. Anything not listed here cannot be called. */
const ALLOWED_METHODS = ["listfolder", "stat", "getfilelink", "checksumfile"] as const;
type AllowedMethod = (typeof ALLOWED_METHODS)[number];

/** Hosts accepted as a content source. */
const PCLOUD_HOST = /(^|\.)pcloud\.com$/;

export interface ClientOptions {
  /** Default `https://api.pcloud.com` (United States). Europe uses `https://eapi.pcloud.com`. */
  apiHost: string;
  /** Access token obtained through OAuth2. **It never appears in logs or responses.** */
  accessToken: string;
  /** Timeout of a single request (milliseconds). */
  requestTimeoutMs?: number;
  /** Limit on the total wait including retries (milliseconds). It must fit within the 29 seconds of API Gateway. */
  totalBudgetMs?: number;
  /** Maximum number of retries. */
  maxRetries?: number;
  /** Replaceable, for tests. */
  fetchImpl?: typeof fetch;
}

/** Indicates that pCloud refused with a result code. */
export class PCloudError extends Error {
  result: number;
  category: ResultClass;
  method: string;

  constructor(method: string, result: number, message: string) {
    super(message);
    this.name = "PCloudError";
    this.method = method;
    this.result = result;
    this.category = classifyResult(result);
  }

  /** Whether a retry can help. */
  get retryable(): boolean {
    return this.category === "ratelimit" || this.category === "server";
  }
}

/** Indicates that the fetched bytes differ from what pCloud reported. */
export class IntegrityError extends Error {
  detail: string;

  constructor(detail: string) {
    super(`Integrity verification of the fetched content failed: ${detail}`);
    this.name = "IntegrityError";
    this.detail = detail;
  }
}

/**
 * Turns `hash` into a string before parsing.
 *
 * The pCloud `hash` is a 64-bit integer and loses precision when it goes through `JSON.parse`
 * (confirmed by measurement). It is wrapped in quotation marks before it is read as a number.
 */
function preserveHash(rawJson: string): string {
  return rawJson.replace(/"hash"\s*:\s*(-?\d+)/g, '"hash":"$1"');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Result codes that mean the path was not found (measured). */
const NOT_FOUND_RESULTS = new Set([2002, 2009, 2055]);

/**
 * Lists the Unicode normalization forms that may represent the same name.
 *
 * The first is **the form as received**. When the caller passes a name that came from pCloud,
 * the first attempt matches and no extra call is made.
 */
export function pathVariants(path: string): string[] {
  return [...new Set([path, path.normalize("NFD"), path.normalize("NFC")])];
}

export class PCloudClient {
  #apiHost: string;
  #accessToken: string;
  #requestTimeoutMs: number;
  #totalBudgetMs: number;
  #maxRetries: number;
  #fetch: typeof fetch;

  constructor(opts: ClientOptions) {
    this.#apiHost = opts.apiHost.replace(/\/+$/, "");
    this.#accessToken = opts.accessToken;
    this.#requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.#totalBudgetMs = opts.totalBudgetMs ?? 25_000;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  // ------------------------------------------------------------ The four public methods

  /** Listing of a folder. The `folderid` of the root is 0. */
  async listFolder(target: { path: string } | { folderid: number }): Promise<Metadata> {
    const res = await this.#call<MetadataResponse>("listfolder", {
      ...target,
      timeformat: "timestamp",
    });
    return res.metadata;
  }

  /**
   * A folder without its files: its own metadata and its subfolders only.
   *
   * For when only the name and the parent of a folder are needed. A folder can hold tens of
   * thousands of files, and `nofiles` keeps them out of the response.
   */
  async folderInfo(folderid: number): Promise<Metadata> {
    const res = await this.#call<MetadataResponse>("listfolder", {
      folderid,
      nofiles: 1,
      timeformat: "timestamp",
    });
    return res.metadata;
  }

  /** Metadata of one entry. It works for a folder too (measured). */
  async stat(target: { path: string } | { fileid: number }): Promise<Metadata> {
    const res = await this.#call<MetadataResponse>("stat", {
      ...target,
      timeformat: "timestamp",
    });
    return res.metadata;
  }

  /**
   * Builds the content source.
   *
   * **The returned host is used only after it is confirmed to be under the pCloud domain.**
   * The reason is that the server connects to an outside host named by a pCloud response.
   */
  async getFileLink(target: { path: string } | { fileid: number }): Promise<ContentLink> {
    const res = await this.#call<FileLinkResponse>("getfilelink", target);
    const host = res.hosts[0];
    if (host === undefined) {
      throw new PCloudError("getfilelink", 0, "No content host was returned");
    }
    if (!PCLOUD_HOST.test(host)) {
      throw new PCloudError("getfilelink", 0, `An unexpected host was returned: ${host}`);
    }
    return { url: `https://${host}${res.path}`, host, size: res.size, expires: res.expires };
  }

  /** SHA-1 used for integrity verification. Available in both regions. */
  async checksum(target: { path: string } | { fileid: number }): Promise<string> {
    const res = await this.#call<ChecksumResponse>("checksumfile", target);
    return res.sha1;
  }

  // ------------------------------------------------------------ Content fetching

  /**
   * Fetches the content. With `range`, only the bytes from `start` to `end` (inclusive) are requested.
   *
   * Here too, **GET only**. The source must be one that {@link getFileLink} has verified.
   */
  async fetchContent(link: ContentLink, range?: { start: number; end: number }): Promise<Uint8Array> {
    if (!PCLOUD_HOST.test(new URL(link.url).hostname)) {
      throw new PCloudError("content", 0, "The content host is not an expected one");
    }
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = `bytes=${range.start}-${range.end}`;

    const res = await this.#withTimeout((signal) =>
      this.#fetch(link.url, { method: "GET", headers, signal }),
    );
    if (!res.ok && res.status !== 206) {
      throw new PCloudError("content", 0, `Failed to fetch the content: HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Checks that the fetched bytes match what pCloud reported.
   *
   * **Throws when they do not match.** The caller must not return the content.
   * Cannot be used for a partial fetch (when `range` was used).
   */
  verifyIntegrity(bytes: Uint8Array, expected: { size: number; sha1: string }): void {
    if (bytes.byteLength !== expected.size) {
      throw new IntegrityError(`Size mismatch (fetched ${bytes.byteLength} / reported ${expected.size})`);
    }
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    if (sha1 !== expected.sha1) {
      throw new IntegrityError(`SHA-1 mismatch (fetched ${sha1} / reported ${expected.sha1})`);
    }
  }

  // ------------------------------------------------------------ Internal

  /**
   * Calls one of the four allowed methods.
   *
   * The type of `method` is fixed to {@link AllowedMethod}, so
   * **no code path lets a caller pass an arbitrary method name.**
   *
   * **When the path is not found, the lookup is repeated with another Unicode normalization form.**
   * pCloud matches a path as a byte sequence as it is and does not normalize it (measured).
   * Names uploaded from macOS are stored in NFD, so
   * an NFC name entered by the user does not match. The reverse also happens.
   *
   * **Extra calls happen only when the path was not found.**
   * "Not found" is not retried, so the first attempt returns without waiting.
   */
  async #call<T>(method: AllowedMethod, params: Record<string, unknown>): Promise<T> {
    const path = params["path"];
    if (typeof path !== "string") return this.#request<T>(method, params);

    const variants = pathVariants(path);
    let lastError: unknown;
    for (let i = 0; i < variants.length; i++) {
      try {
        return await this.#request<T>(method, { ...params, path: variants[i] });
      } catch (e) {
        lastError = e;
        const notFound = e instanceof PCloudError && NOT_FOUND_RESULTS.has(e.result);
        if (!notFound) throw e;
      }
    }
    throw lastError;
  }

  /** Calls once with one form of the path. Retrying the request is done here. */
  async #request<T>(method: AllowedMethod, params: Record<string, unknown>): Promise<T> {
    const url = new URL(`/${method}`, this.#apiHost);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    url.searchParams.set("access_token", this.#accessToken);

    const deadline = Date.now() + this.#totalBudgetMs;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = Math.min(1000 * 2 ** (attempt - 1), 8000) * (0.5 + Math.random() / 2);
        if (Date.now() + wait > deadline) break;
        await sleep(wait);
      }
      try {
        const res = await this.#withTimeout((signal) =>
          this.#fetch(url, { method: "GET", signal }),   // GET only
        );
        const text = await res.text();
        const body = JSON.parse(preserveHash(text)) as T & { result: number; error?: string };

        if (body.result !== 0) {
          const err = new PCloudError(method, body.result, body.error ?? `result=${body.result}`);
          if (!err.retryable) throw err;
          lastError = err;
          continue;
        }
        return body;
      } catch (e) {
        if (e instanceof PCloudError && !e.retryable) throw e;
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new PCloudError(method, 0, "The request to pCloud failed");
  }

  /** Applies a timeout to a single request. */
  async #withTimeout(run: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.#requestTimeoutMs);
    try {
      return await run(ac.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
