// © 2026 Yasuhiko Yokote

/**
 * Inflating and parsing git loose objects.
 *
 * A loose object is compressed with zlib (deflate). Inflated, it has the form
 *
 *   <type> <body length>\0<body>
 *
 * (the type is commit / tree / blob / tag). It maps to the path
 * `objects/ab/cdef...` (the first 2 digits of the SHA-1 are the directory, the remaining 38 the file name).
 *
 * The pack format (`objects/pack/`) is not handled here (see pack.ts).
 */
import { inflateSync } from "node:zlib";

export class GitFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFormatError";
  }
}

export type GitObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
  type: GitObjectType;
  body: Buffer;
}

const OBJECT_TYPES: readonly GitObjectType[] = ["commit", "tree", "blob", "tag"];

/** Inflates a decrypted loose object, validates the header and extracts the body. */
export function parseLooseObject(data: Buffer): GitObject {
  let inflated: Buffer;
  try {
    inflated = inflateSync(data);
  } catch {
    throw new GitFormatError("Cannot be inflated as zlib. It may not be a loose object");
  }
  const nul = inflated.indexOf(0);
  if (nul < 0) {
    throw new GitFormatError("The header terminator (NUL) is missing");
  }
  const header = inflated.subarray(0, nul).toString("latin1");
  const sp = header.indexOf(" ");
  if (sp < 0) {
    throw new GitFormatError(`Unexpected header format: ${header}`);
  }
  const type = header.slice(0, sp) as GitObjectType;
  if (!OBJECT_TYPES.includes(type)) {
    throw new GitFormatError(`Unknown type: ${header.slice(0, sp)}`);
  }
  const size = Number(header.slice(sp + 1));
  const body = inflated.subarray(nul + 1);
  if (!Number.isInteger(size) || size !== body.length) {
    throw new GitFormatError(
      `The body length does not match (header ${header.slice(sp + 1)}, actual ${body.length})`,
    );
  }
  return { type, body };
}

// ---------------------------------------------------------------- tree

export interface TreeEntry {
  /** Octal string. File 100644 / executable 100755 / directory 40000 / symbolic link 120000 / submodule 160000 */
  mode: string;
  name: string;
  /** SHA-1 (40 hexadecimal characters) */
  hash: string;
  isDir: boolean;
}

/**
 * Parses the body of a tree. It is binary: a sequence of entries, each of the form
 *
 *   <mode> <name>\0<SHA-1 (20 raw bytes)>
 *
 * The name is read as UTF-8.
 */
export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < body.length) {
    const sp = body.indexOf(0x20, pos);
    const nul = sp < 0 ? -1 : body.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > body.length) {
      throw new GitFormatError(`A tree entry is truncated (position ${pos})`);
    }
    const mode = body.subarray(pos, sp).toString("latin1");
    const name = body.subarray(sp + 1, nul).toString("utf8");
    const hash = body.subarray(nul + 1, nul + 21).toString("hex");
    entries.push({ mode, name, hash, isDir: mode === "40000" });
    pos = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commit

export interface PersonLine {
  name: string;
  email: string;
  /** Example: 2026-07-28 09:00:00 +0900 (expressed in the UTC offset recorded in the commit) */
  date: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: PersonLine | undefined;
  committer: PersonLine | undefined;
  message: string;
}

/** Reads a line such as `author A U Thor <a@b.c> 1234567890 +0900`. */
function parsePerson(rest: string): PersonLine | undefined {
  const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(rest);
  if (!m) return undefined;
  const [, name, email, epoch, tz] = m as unknown as [string, string, string, string, string];
  const offsetMin = (tz.startsWith("-") ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3)));
  const local = new Date((Number(epoch) + offsetMin * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${tz}`;
  return { name, email, date };
}

/**
 * Parses the body of a commit. Header lines (tree / parent / author / committer and so on)
 * continue up to a blank line, and the message follows.
 * Multi-line headers such as gpgsig (continuation lines start with a space) are skipped.
 */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString("utf8");
  const blank = text.indexOf("\n\n");
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? "" : text.slice(blank + 2);

  let tree = "";
  const parents: string[] = [];
  let author: PersonLine | undefined;
  let committer: PersonLine | undefined;
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue; // continuation of a multi-line header
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    if (key === "tree") tree = rest;
    else if (key === "parent") parents.push(rest);
    else if (key === "author") author = parsePerson(rest);
    else if (key === "committer") committer = parsePerson(rest);
  }
  if (!/^[0-9a-f]{40}$/.test(tree)) {
    throw new GitFormatError("The commit has no tree");
  }
  return { tree, parents, author, committer, message };
}
