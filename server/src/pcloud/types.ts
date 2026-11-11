// © 2026 Yasuhiko Yokote

/**
 * Types of pCloud API responses.
 *
 * Names are not changed for the receiver's convenience: **they are kept as pCloud returns them.**
 * Conversion to the shape given to callers (formatted `snake_case` metadata) is
 * the responsibility of the tool layer and is not done here.
 */

/** Classification of result codes. */
export type ResultClass =
  | "client"    // 1xxx caller error
  | "data"      // 2xxx invalid target or data
  | "permanent" // 3xxx retrying does not help
  | "ratelimit" // 4xxx rate limit
  | "server"    // 5xxx server side
  | "other";

export function classifyResult(result: number): ResultClass {
  if (result >= 1000 && result < 2000) return "client";
  if (result >= 2000 && result < 3000) return "data";
  if (result >= 3000 && result < 4000) return "permanent";
  if (result >= 4000 && result < 5000) return "ratelimit";
  if (result >= 5000 && result < 6000) return "server";
  return "other";
}

/**
 * Metadata as returned by pCloud.
 *
 * `hash` is a 64-bit integer, and **parsing the JSON as it is loses precision** (measured).
 * The client turns it into a string before parsing, so it is held as `string` here too.
 */
export interface Metadata {
  name: string;
  isfolder: boolean;
  fileid?: number;
  folderid?: number;
  parentfolderid?: number;
  path?: string;
  size?: number;
  contenttype?: string;
  category?: number;
  hash?: string;
  thumb?: boolean;
  icon?: string;
  created?: number;
  modified?: number;
  ismine?: boolean;
  isshared?: boolean;
  width?: number;
  height?: number;
  contents?: Metadata[];
}

/** Response of `listfolder` / `stat`. */
export interface MetadataResponse {
  result: number;
  metadata: Metadata;
}

/** Response of `getfilelink`. The URL is built by joining `hosts[0]` and `path`. */
export interface FileLinkResponse {
  result: number;
  hosts: string[];
  path: string;
  size: number;
  expires: string;
}

/**
 * Response of `checksumfile`.
 *
 * **The kinds returned differ by region.** The United States returns `sha1` and `md5`, Europe `sha1` and `sha256`.
 * `sha1` is available in both, so it is used for integrity verification.
 */
export interface ChecksumResponse {
  result: number;
  sha1: string;
  md5?: string;
  sha256?: string;
  metadata: Metadata;
}

/** A content source that has been built. */
export interface ContentLink {
  url: string;
  host: string;
  size: number;
  /** Expiry time reported by pCloud (a string in RFC 2822 format). */
  expires: string;
}
