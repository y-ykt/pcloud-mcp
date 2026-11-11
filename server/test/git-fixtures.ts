// © 2026 Yasuhiko Yokote

/**
 * Synthetic repository for the git tests.
 *
 * Objects are built in the real format (zlib, named by their SHA-1),
 * encrypted with AES-256-GCM and stored in a Map. **No real repository and no pCloud access is used.**
 * Shared by `git-repo.test.ts` and `git-tools.test.ts`.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { GitRepo, type GitFetcher, type GitRepoOptions } from "../src/git/repo.ts";

export const KEY = Buffer.alloc(32, 9);
export const BASE = "/git-repository/sample.git";

export function encrypt(plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** A repository under construction. Adding an object returns its real hash. */
export class FakeRepo {
  files = new Map<string, Buffer>();

  putObject(type: string, body: Buffer): string {
    const full = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, "latin1"), body]);
    const hash = createHash("sha1").update(full).digest("hex");
    this.files.set(
      `${BASE}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`,
      encrypt(deflateSync(full)),
    );
    return hash;
  }

  putText(rel: string, text: string): void {
    this.files.set(`${BASE}/${rel}`, encrypt(Buffer.from(text, "utf8")));
  }

  tree(entries: Array<[mode: string, name: string, hash: string]>): string {
    const body = Buffer.concat(
      entries.map(([mode, name, hash]) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`, "utf8"), Buffer.from(hash, "hex")]),
      ),
    );
    return this.putObject("tree", body);
  }

  commit(tree: string, parents: string[], message: string): string {
    const lines = [
      `tree ${tree}`,
      ...parents.map((p) => `parent ${p}`),
      "author A <a@b.c> 1234567890 +0900",
      "committer A <a@b.c> 1234567890 +0900",
      "",
      message,
    ];
    return this.putObject("commit", Buffer.from(lines.join("\n"), "utf8"));
  }

  fetcher(): GitFetcher {
    const files = this.files;
    return {
      fetchFile: (path) => Promise.resolve(files.get(path)),
      listNames: (path) => {
        const prefix = `${path}/`;
        const names = new Set<string>();
        for (const k of files.keys()) {
          if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0] ?? "");
        }
        return Promise.resolve(names.size > 0 ? [...names] : undefined);
      },
    };
  }

  repo(opts: Partial<GitRepoOptions> = {}): GitRepo {
    return new GitRepo({
      fetcher: this.fetcher(),
      key: KEY,
      repoPath: BASE,
      // Keep the tests from writing into the real /tmp/pcloud-git
      cacheDir: mkdtempSync(join(tmpdir(), "git-cache-")),
      ...opts,
    });
  }

  /**
   * Stores the objects in a pack (plus its idx). Returns the hash of each object.
   * They are not stored as loose objects, so they can be read only from the pack.
   */
  putPack(objs: Array<{ type: string; body: Buffer }>): string[] {
    const { pack, offsets } = buildPack(
      objs.map((o) => ({ kind: "plain" as const, type: o.type, body: o.body })),
    );
    const hashes = objs.map((o) =>
      createHash("sha1")
        .update(`${o.type} ${o.body.length}\0`, "latin1")
        .update(o.body)
        .digest("hex"),
    );
    this.putPackRaw(pack, hashes.map((hash, i) => ({ hash, offset: offsets[i]! })));
    return hashes;
  }

  /** Stores a hand-built pack and its index entries as they are (for tests with deltas). */
  putPackRaw(pack: Buffer, entries: Array<{ hash: string; offset: number }>): void {
    const name = `pack-${String(FakeRepo.packSeq++).padStart(40, "0")}`;
    this.files.set(`${BASE}/objects/pack/${name}.pack`, encrypt(pack));
    this.files.set(`${BASE}/objects/pack/${name}.idx`, encrypt(buildIdx(entries)));
  }

  static packSeq = 0;
}

/**
 * Builds an idx (version 2) by hand (test only).
 * Each hash in `entries` is 40 hexadecimal characters. An offset of 2^31 or more goes to the large offset table.
 */
export function buildIdx(entries: Array<{ hash: string; offset: number }>): Buffer {
  const sorted = [...entries].sort((a, b) => a.hash.localeCompare(b.hash));
  const fanout = Buffer.alloc(256 * 4);
  for (let b = 0, i = 0; b < 256; b++) {
    while (i < sorted.length && parseInt(sorted[i]!.hash.slice(0, 2), 16) <= b) i++;
    fanout.writeUInt32BE(i, b * 4);
  }
  const shas = Buffer.concat(sorted.map((e) => Buffer.from(e.hash, "hex")));
  const crcs = Buffer.alloc(4 * sorted.length);
  const large: bigint[] = [];
  const offs = Buffer.alloc(4 * sorted.length);
  sorted.forEach((e, i) => {
    if (e.offset < 0x80000000) {
      offs.writeUInt32BE(e.offset, i * 4);
    } else {
      offs.writeUInt32BE((0x80000000 | large.length) >>> 0, i * 4);
      large.push(BigInt(e.offset));
    }
  });
  const largeBuf = Buffer.alloc(8 * large.length);
  large.forEach((v, i) => largeBuf.writeBigUInt64BE(v, i * 8));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xff744f63, 0);
  header.writeUInt32BE(2, 4);
  return Buffer.concat([header, fanout, shas, crcs, offs, largeBuf, Buffer.alloc(40)]);
}

// ---------------------------------------------------------------- building a pack by hand

const PACK_TYPE_NUM: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Variable-length entry header (3 bits of type plus the length, 7 bits at a time, low bits first). */
function packEntryHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  let v = Math.floor(size / 16);
  if (v > 0) first |= 0x80;
  bytes.push(first);
  while (v > 0) {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Encoding of the negative offset of an ofs_delta (same as git: each further byte adds (value+1)<<7). */
function ofsEncode(distance: number): Buffer {
  let v = distance;
  const out = [v & 0x7f];
  v = Math.floor(v / 128);
  while (v > 0) {
    v -= 1;
    out.unshift(0x80 | (v & 0x7f));
    v = Math.floor(v / 128);
  }
  return Buffer.from(out);
}

/** Variable-length integer of a delta (7 bits at a time, low bits first). */
function deltaVarint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

export function deltaCopy(offset: number, size: number): Buffer {
  const bytes: number[] = [];
  let cmd = 0x80;
  for (let i = 0; i < 4; i++) {
    const b = (offset >> (8 * i)) & 0xff;
    if (b !== 0) {
      cmd |= 1 << i;
      bytes.push(b);
    }
  }
  const encodedSize = size === 0x10000 ? 0 : size;
  for (let i = 0; i < 3; i++) {
    const b = (encodedSize >> (8 * i)) & 0xff;
    if (b !== 0) {
      cmd |= 0x10 << i;
      bytes.push(b);
    }
  }
  return Buffer.from([cmd, ...bytes]);
}

export function deltaInsert(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([data.length]), data]);
}

export function buildDelta(baseLen: number, resultLen: number, ops: Buffer[]): Buffer {
  return Buffer.concat([deltaVarint(baseLen), deltaVarint(resultLen), ...ops]);
}

export type PackEntry =
  | { kind: "plain"; type: string; body: Buffer }
  | { kind: "ofs"; baseIndex: number; delta: Buffer }
  | { kind: "ref"; baseHash: string; delta: Buffer };

/** Builds a pack (version 2) by hand. The returned offsets are the start position of each entry. */
export function buildPack(entries: PackEntry[]): { pack: Buffer; offsets: number[] } {
  const header = Buffer.alloc(12);
  header.write("PACK", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);

  const parts: Buffer[] = [header];
  const offsets: number[] = [];
  let pos = 12;
  for (const e of entries) {
    offsets.push(pos);
    let piece: Buffer;
    if (e.kind === "plain") {
      const num = PACK_TYPE_NUM[e.type];
      if (num === undefined) throw new Error(`unknown type: ${e.type}`);
      piece = Buffer.concat([packEntryHeader(num, e.body.length), deflateSync(e.body)]);
    } else if (e.kind === "ofs") {
      const baseOffset = offsets[e.baseIndex];
      if (baseOffset === undefined) throw new Error("base must precede delta");
      piece = Buffer.concat([
        packEntryHeader(6, e.delta.length),
        ofsEncode(pos - baseOffset),
        deflateSync(e.delta),
      ]);
    } else {
      piece = Buffer.concat([
        packEntryHeader(7, e.delta.length),
        Buffer.from(e.baseHash, "hex"),
        deflateSync(e.delta),
      ]);
    }
    parts.push(piece);
    pos += piece.length;
  }
  parts.push(Buffer.alloc(20)); // Trailing SHA-1 (not verified, so filled with zeros)
  return { pack: Buffer.concat(parts), offsets };
}

/**
 * A repository of one commit on `main` that holds a single entry.
 *
 * `mode` is the git mode of the entry: `100644` for a file, `120000` for a symbolic link
 * (its content is then the path of the link target).
 */
export function repoWithEntry(mode: string, name: string, content: Uint8Array | string): FakeRepo {
  const r = new FakeRepo();
  const blob = r.putObject("blob", typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content));
  const c = r.commit(r.tree([[mode, name, blob]]), [], "add\n");
  r.putText("HEAD", "ref: refs/heads/main\n");
  r.putText("refs/heads/main", `${c}\n`);
  return r;
}

/** Builds a repository of 2 commits that holds README.md and docs/設計.md (a Japanese file name). */
export function sampleRepo() {
  const r = new FakeRepo();
  const readme = r.putObject("blob", Buffer.from("hello\n", "utf8"));
  const design = r.putObject("blob", Buffer.from("# 設計\n", "utf8"));
  const docs = r.tree([["100644", "設計.md", design]]);
  const root = r.tree([
    ["100644", "README.md", readme],
    ["40000", "docs", docs],
  ]);
  const c1 = r.commit(root, [], "first\n");
  const c2 = r.commit(root, [c1], "second\n");
  r.putText("HEAD", "ref: refs/heads/main\n");
  r.putText("refs/heads/main", `${c2}\n`);
  return { r, c1, c2, root };
}
