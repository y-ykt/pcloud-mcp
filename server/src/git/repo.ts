// © 2026 Yasuhiko Yokote

/**
 * Reading a bare repository (both loose objects and packs).
 *
 * The layout on pCloud is that of an ordinary bare repository (path names are not encrypted).
 * **Only the file contents are encrypted**, so reading goes in this order: fetch, decrypt, inflate.
 *
 * An object that is not loose is extracted from a pack (`idx.ts` / `pack.ts`).
 * Because of the authentication tag, a pack **can only be fetched and decrypted whole**,
 * so the decrypted pack is stored in `/tmp` and reused for the lifetime of the execution environment
 * (a pack name is derived from its content and never changes, so the copy cannot become stale).
 *
 * The integrity of what was fetched is verified by a property of git itself:
 * **an object name is the SHA-1 of its content (`<type> <length>\0<body>`).**
 * If the hash matches after decryption and inflation (and, for a pack, delta application),
 * the whole path from fetching the ciphertext to restoring the object was correct.
 * This is a stronger verification than comparing against the pCloud checksum, and it needs no extra API call.
 */
import { normalizeStructure, rejectionReason } from "../guard/path.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PCloudError, type PCloudClient } from "../pcloud/client.ts";
import { decrypt } from "./crypto.ts";
import { parseIndex } from "./idx.ts";
import {
  parseCommit,
  parseLooseObject,
  parseTree,
  type CommitInfo,
  type GitObject,
  type TreeEntry,
} from "./object.ts";
import { parsePackHeader, readPackedObject } from "./pack.ts";

/** A failure that can be shown to the user as is. */
export class GitRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRepoError";
  }
}

// ---------------------------------------------------------------- fetch abstraction

/** Fetches the files of a repository. Tests replace it with a fixed Map. */
export interface GitFetcher {
  /** Fetches a whole file. undefined if not found. `maxBytes` overrides the default limit. */
  fetchFile(path: string, maxBytes?: number): Promise<Buffer | undefined>;
  /** Listing of the names directly under a folder. undefined if the folder does not exist. */
  listNames(path: string): Promise<string[] | undefined>;
}

/** result values meaning that a path was not found (the same measured values as in client.ts, plus 2005). */
const NOT_FOUND_RESULTS = new Set([2002, 2005, 2009, 2055]);

function isNotFound(e: unknown): boolean {
  return e instanceof PCloudError && NOT_FOUND_RESULTS.has(e.result);
}

/** Fetching through pCloud. All communication goes through the existing {@link PCloudClient}. */
export function pcloudGitFetcher(client: PCloudClient, defaultMaxBytes: number): GitFetcher {
  /**
   * **The shape of every path is checked right before pCloud is asked.**
   * The paths are built from a repository name, a ref and names found in the repository,
   * and this is the one place all of them pass. A `..` or a control character stops here
   * even if an earlier check let it through.
   *
   * **The forbidden names are not applied here.** Inside a repository a branch, a tag or a file of
   * git may be called anything. The folder and the name of the repository are checked against the
   * forbidden names where the path of the repository is put together (`repoPathOf`).
   */
  const checked = (path: string): string => {
    try {
      normalizeStructure(path);
    } catch (e) {
      throw new GitRepoError(`This path cannot be read: ${rejectionReason(e)}`);
    }
    return path;
  };
  return {
    async fetchFile(rawPath: string, maxBytes = defaultMaxBytes): Promise<Buffer | undefined> {
      const path = checked(rawPath);
      let link;
      try {
        link = await client.getFileLink({ path });
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
      if (link.size !== undefined && link.size > maxBytes) {
        throw new GitRepoError(
          `The file is too large (${link.size} bytes; limit ${maxBytes}): ${path}`,
        );
      }
      const bytes = await client.fetchContent(link);
      if (link.size !== undefined && bytes.byteLength !== link.size) {
        throw new GitRepoError(
          `The fetched size differs from the declared size (fetched ${bytes.byteLength} / declared ${link.size}): ${path}`,
        );
      }
      return Buffer.from(bytes);
    },
    async listNames(rawPath: string): Promise<string[] | undefined> {
      const path = checked(rawPath);
      try {
        const meta = await client.listFolder({ path });
        return (meta.contents ?? []).map((c) => c.name);
      } catch (e) {
        if (isNotFound(e)) return undefined;
        throw e;
      }
    },
  };
}

// ---------------------------------------------------------------- main part

const FULL_HASH = /^[0-9a-f]{40}$/;

/**
 * Whether a string can be the name of a ref. The rules are those git itself applies to ref names.
 *
 * **A ref becomes part of a path** (`refs/heads/<name>`), so a name that is not checked could
 * point outside the repository.
 */
export function isValidRefName(name: string): boolean {
  if (name === "" || name.length > 255) return false;
  // Control characters, space, and the characters git does not allow in a ref name
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  return name.split("/").every((seg) => !seg.startsWith(".") && !seg.endsWith(".lock"));
}

/** SHA-1 of `<type> <length>\0<body>`. This is the object name. */
function objectHash(type: string, body: Buffer): string {
  return createHash("sha1")
    .update(`${type} ${body.length}\0`, "latin1")
    .update(body)
    .digest("hex");
}

export interface GitLogEntry extends CommitInfo {
  hash: string;
}

/** Timings taken when a pack is fetched and decrypted. Used for measurement and for the operational record. */
export interface PackLoadInfo {
  pack: string;
  /** Where it came from. cache means /tmp; pcloud means it was fetched and decrypted. */
  source: "cache" | "pcloud";
  bytes: number;
  fetchMs: number;
  decryptMs: number;
}

export interface GitRepoOptions {
  fetcher: GitFetcher;
  key: Buffer;
  repoPath: string;
  /** Fetch limit for one pack (bytes). Default 128 MiB. */
  packMaxBytes?: number;
  /** Where decrypted packs are stored. Default /tmp/pcloud-git. */
  cacheDir?: string;
  /** Called when a pack is loaded (for the record). */
  onPackLoad?: (info: PackLoadInfo) => void;
}

export class GitRepo {
  #fetcher: GitFetcher;
  #key: Buffer;
  #base: string;
  #packMaxBytes: number;
  #cacheDir: string;
  #onPackLoad: ((info: PackLoadInfo) => void) | undefined;
  /** packed-refs is read only once (an instance lives for one tool call). */
  #packedRefs: Map<string, string> | undefined;
  /** Decrypted packs. Reused within the same tool call. */
  #packCache = new Map<string, Buffer>();

  constructor(opts: GitRepoOptions) {
    this.#fetcher = opts.fetcher;
    this.#key = opts.key;
    this.#base = opts.repoPath.replace(/\/+$/, "");
    this.#packMaxBytes = opts.packMaxBytes ?? 128 * 1024 * 1024;
    this.#cacheDir = opts.cacheDir ?? "/tmp/pcloud-git";
    this.#onPackLoad = opts.onPackLoad;
  }

  /** Repository name (for example `example.git`). Used to state the source in a response. */
  get name(): string {
    return this.#base.split("/").pop() ?? this.#base;
  }

  /** Fetches and decrypts. undefined if not found. `maxBytes` overrides the fetch limit. */
  async #readDecrypted(rel: string, maxBytes?: number): Promise<Buffer | undefined> {
    const data = await this.#fetcher.fetchFile(`${this.#base}/${rel}`, maxBytes);
    return data === undefined ? undefined : decrypt(this.#key, data);
  }

  // ------------------------------------------------------------ resolving a ref

  /**
   * Turns a ref into a commit hash. Accepted forms:
   *   - omitted (HEAD)
   *   - a hash itself (40 hexadecimal characters)
   *   - a branch name or tag name (`main` / `refs/heads/main` / `refs/tags/v1`)
   */
  async resolveRef(ref = "HEAD"): Promise<string> {
    let current = ref.trim();
    /** Whether the previous hop dereferenced HEAD. Used for the fallback when its target does not exist. */
    let viaHead = false;
    for (let hop = 0; hop < 5; hop++) {
      if (FULL_HASH.test(current)) return current;
      // Checked on every hop: the name may come from the caller or from a file in the repository
      if (!isValidRefName(current)) {
        throw new GitRepoError(`Not a valid ref name: ${JSON.stringify(current)}`);
      }

      const candidates =
        current === "HEAD"
          ? ["HEAD"]
          : current.startsWith("refs/")
            ? [current]
            : [`refs/heads/${current}`, `refs/tags/${current}`];

      let value: string | undefined;
      for (const rel of candidates) {
        const data = await this.#readDecrypted(rel);
        if (data !== undefined) {
          value = data.toString("utf8").trim();
          break;
        }
      }
      // If it is not loose, look in packed-refs (after `git gc` the refs move there)
      value ??= await this.#lookupPackedRef(
        candidates.filter((c) => c !== "HEAD"),
      );
      if (value === undefined) {
        /**
         * The branch that HEAD points to sometimes does not exist (measured).
         * It happens when HEAD still has the default from `git init --bare` (master)
         * while the branch that was pushed is main. `git push` does not rewrite the remote HEAD.
         * Correcting HEAD on the pCloud side is not an option (overwriting is not allowed), so the fallback is applied here.
         */
        if (viaHead) {
          const fallback = await this.#fallbackBranch();
          if (fallback !== undefined) {
            current = fallback;
            viaHead = false;
            continue;
          }
          throw new GitRepoError(
            `HEAD points to ${current}, but that branch does not exist. ` +
              "Specify a branch name in ref",
          );
        }
        throw new GitRepoError(`ref not found: ${ref}`);
      }
      if (value.startsWith("ref: ")) {
        viaHead = current === "HEAD";
        current = value.slice(5).trim();
        continue;
      }
      current = value;
    }
    throw new GitRepoError(`The ref indirection is too deep: ${ref}`);
  }

  /** Substitute for when the target of HEAD does not exist. Chosen in this order: main, master, the only branch when there is exactly one. */
  async #fallbackBranch(): Promise<string | undefined> {
    const names = new Set(
      (await this.#fetcher.listNames(`${this.#base}/refs/heads`)) ?? [],
    );
    await this.#lookupPackedRef([]); // makes packed-refs load
    for (const name of this.#packedRefs?.keys() ?? []) {
      if (name.startsWith("refs/heads/")) names.add(name.slice("refs/heads/".length));
    }
    const pick = names.has("main")
      ? "main"
      : names.has("master")
        ? "master"
        : names.size === 1
          ? [...names][0]
          : undefined;
    return pick === undefined ? undefined : `refs/heads/${pick}`;
  }

  async #lookupPackedRef(names: string[]): Promise<string | undefined> {
    if (this.#packedRefs === undefined) {
      this.#packedRefs = new Map();
      const data = await this.#readDecrypted("packed-refs");
      if (data !== undefined) {
        for (const line of data.toString("utf8").split("\n")) {
          // A line starting with `^` is the target of the preceding tag (peeled). Not used here
          if (line.startsWith("#") || line.startsWith("^")) continue;
          const sp = line.indexOf(" ");
          if (sp === 40 && FULL_HASH.test(line.slice(0, 40))) {
            this.#packedRefs.set(line.slice(sp + 1).trim(), line.slice(0, 40));
          }
        }
      }
    }
    for (const name of names) {
      const hash = this.#packedRefs.get(name);
      if (hash !== undefined) return hash;
    }
    return undefined;
  }

  // ------------------------------------------------------------ objects

  /**
   * Reads an object. If it is not loose, it is extracted from a pack.
   * `maxBytes` overrides the fetch limit for a loose object (for reading a file larger than the default, such as a PDF).
   */
  async readObject(hash: string, maxBytes?: number): Promise<GitObject> {
    if (!FULL_HASH.test(hash)) {
      throw new GitRepoError(`Unexpected hash format: ${hash}`);
    }
    const rel = `objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
    const data = await this.#readDecrypted(rel, maxBytes);
    const obj = data !== undefined ? parseLooseObject(data) : await this.#readFromPacks(hash);
    if (obj === undefined) {
      throw new GitRepoError(`Object not found: ${hash}`);
    }
    const actual = objectHash(obj.type, obj.body);
    if (actual !== hash) {
      throw new GitRepoError(
        `Integrity verification of the fetched object failed (name ${hash} / SHA-1 of the content ${actual})`,
      );
    }
    return obj;
  }

  // ------------------------------------------------------------ pack

  /**
   * Extracts from the packs. Each idx (small) is searched in turn, and only the pack that contains the object is loaded.
   * undefined if no pack has it.
   */
  async #readFromPacks(hash: string): Promise<GitObject | undefined> {
    const names = await this.#fetcher.listNames(`${this.#base}/objects/pack`);
    if (names === undefined) return undefined;
    for (const idxName of names.filter((n) => n.endsWith(".idx")).sort()) {
      const idxData = await this.#readDecrypted(`objects/pack/${idxName}`);
      if (idxData === undefined) continue;
      const index = parseIndex(idxData);
      const offset = index.find(hash);
      if (offset === undefined) continue;
      const pack = await this.#loadPack(idxName.replace(/\.idx$/, ".pack"));
      return readPackedObject(
        pack,
        offset,
        (h) => index.find(h),
        // when the base of a ref_delta is outside the pack (loose or in another pack)
        (h) => this.readObject(h),
      );
    }
    return undefined;
  }

  /**
   * Loads a pack. The order is: memory, /tmp, pCloud.
   *
   * /tmp holds **the decrypted pack (plaintext)** (the user's decision, 2026-07-28).
   * A pack name contains the SHA-1 of its content and never changes, so the cache does not become stale.
   * Failing to write to /tmp is not treated as a failure (memory is enough for the duration of the call).
   */
  async #loadPack(packName: string): Promise<Buffer> {
    if (!/^pack-[0-9a-f]{40,64}\.pack$/.test(packName)) {
      throw new GitRepoError(`Unexpected pack name: ${packName}`);
    }
    const cached = this.#packCache.get(packName);
    if (cached !== undefined) return cached;

    const cachePath = join(this.#cacheDir, packName);
    try {
      const fromTmp = await readFile(cachePath);
      parsePackHeader(fromTmp); // check that prevents using a truncated file
      this.#packCache.set(packName, fromTmp);
      this.#onPackLoad?.({ pack: packName, source: "cache", bytes: fromTmp.length, fetchMs: 0, decryptMs: 0 });
      return fromTmp;
    } catch {
      /* not there: fetch it */
    }

    const t0 = Date.now();
    const data = await this.#fetcher.fetchFile(
      `${this.#base}/objects/pack/${packName}`,
      this.#packMaxBytes,
    );
    if (data === undefined) {
      throw new GitRepoError(`Pack not found: ${packName}`);
    }
    const t1 = Date.now();
    const plain = decrypt(this.#key, data);
    const t2 = Date.now();
    parsePackHeader(plain);
    this.#packCache.set(packName, plain);
    this.#onPackLoad?.({
      pack: packName,
      source: "pcloud",
      bytes: plain.length,
      fetchMs: t1 - t0,
      decryptMs: t2 - t1,
    });

    // Write under another name and then rename, so that a partially written file is never visible
    try {
      await mkdir(this.#cacheDir, { recursive: true });
      const tmp = `${cachePath}.writing-${process.pid}`;
      await writeFile(tmp, plain);
      await rename(tmp, cachePath);
    } catch {
      /* can continue even if /tmp is full */
    }
    return plain;
  }

  /**
   * Reads a commit. A ref resolved from a tag name can be an annotated tag,
   * so the target of `object` is followed to reach the commit. At most 3 objects are read,
   * which allows up to 2 levels of tag.
   */
  async readCommit(hash: string): Promise<GitLogEntry> {
    let current = hash;
    for (let hop = 0; hop < 3; hop++) {
      const obj = await this.readObject(current);
      if (obj.type === "commit") {
        return { hash: current, ...parseCommit(obj.body) };
      }
      if (obj.type === "tag") {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.body.toString("utf8"));
        if (!m || m[1] === undefined) {
          throw new GitRepoError(`Unexpected tag format: ${current}`);
        }
        current = m[1];
        continue;
      }
      throw new GitRepoError(`Not a commit (${obj.type}): ${current}`);
    }
    throw new GitRepoError(`The tag indirection is too deep: ${hash}`);
  }

  // ------------------------------------------------------------ trees and files

  /** Name comparison inside a tree. Tolerates a difference in Unicode normalization form (same reason as in client.ts). */
  #sameName(entryName: string, wanted: string): boolean {
    return (
      entryName === wanted ||
      entryName.normalize("NFC") === wanted.normalize("NFC")
    );
  }

  /** Listing of the given directory at the given commit. `dirPath` is separated by `/` (empty means the root). */
  async listTree(commitHash: string, dirPath = ""): Promise<TreeEntry[]> {
    const commit = await this.readCommit(commitHash);
    let treeHash = commit.tree;
    const segments = dirPath.split("/").filter((s) => s.length > 0);
    for (const seg of segments) {
      const obj = await this.readObject(treeHash);
      if (obj.type !== "tree") {
        throw new GitRepoError(`Not a tree: ${treeHash}`);
      }
      const entry = parseTree(obj.body).find((e) => this.#sameName(e.name, seg));
      if (entry === undefined) {
        throw new GitRepoError(`Directory not found: ${dirPath}`);
      }
      if (!entry.isDir) {
        throw new GitRepoError(`Not a directory: ${seg}`);
      }
      treeHash = entry.hash;
    }
    const obj = await this.readObject(treeHash);
    if (obj.type !== "tree") {
      throw new GitRepoError(`Not a tree: ${treeHash}`);
    }
    return parseTree(obj.body);
  }

  /**
   * Finds the tree entry of a file, without reading its content.
   *
   * Separate from reading so that the caller can look at the mode first:
   * a symbolic link is handled differently whatever its name looks like.
   */
  async findEntry(commitHash: string, filePath: string): Promise<TreeEntry> {
    const segments = filePath.split("/").filter((s) => s.length > 0);
    const name = segments.pop();
    if (name === undefined) {
      throw new GitRepoError("The file path is empty");
    }
    const entries = await this.listTree(commitHash, segments.join("/"));
    const entry = entries.find((e) => this.#sameName(e.name, name));
    if (entry === undefined) {
      throw new GitRepoError(`File not found: ${filePath}`);
    }
    if (entry.isDir) {
      throw new GitRepoError(`This is a directory. Use git_ls: ${filePath}`);
    }
    if (entry.mode === "160000") {
      throw new GitRepoError(`Cannot be read because it is a submodule: ${filePath}`);
    }
    return entry;
  }

  /**
   * Reads the content of an entry found by {@link findEntry}. Returns the body of the blob (plaintext).
   * `maxBytes` overrides the fetch limit for the blob. It is not applied to commits and trees (they are small, so it is not needed).
   */
  async readEntry(entry: TreeEntry, filePath: string, maxBytes?: number): Promise<Buffer> {
    const obj = await this.readObject(entry.hash, maxBytes);
    if (obj.type !== "blob") {
      throw new GitRepoError(`Not a blob (${obj.type}): ${filePath}`);
    }
    return obj.body;
  }

  // ------------------------------------------------------------ history

  /** History that follows the first parent. Does not enter the side branches of a merge. */
  async log(startHash: string, maxCount: number): Promise<GitLogEntry[]> {
    const entries: GitLogEntry[] = [];
    let current: string | undefined = startHash;
    while (current !== undefined && entries.length < maxCount) {
      const commit: GitLogEntry = await this.readCommit(current);
      entries.push(commit);
      current = commit.parents[0];
    }
    return entries;
  }
}
