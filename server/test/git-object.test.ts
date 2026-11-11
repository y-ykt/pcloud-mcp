// © 2026 Yasuhiko Yokote

/**
 * Tests of git loose object parsing (`src/git/object.ts`).
 *
 * The objects are built inside the tests. **No real repository is used.**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import {
  GitFormatError,
  parseCommit,
  parseLooseObject,
  parseTree,
} from "../src/git/object.ts";

/** Builds a loose object (test only). */
function loose(type: string, body: Buffer | string): Buffer {
  const b = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return deflateSync(Buffer.concat([Buffer.from(`${type} ${b.length}\0`, "latin1"), b]));
}

/** Builds the binary form of one tree entry. */
function treeEntry(mode: string, name: string, hashByte: number): Buffer {
  return Buffer.concat([
    Buffer.from(`${mode} ${name}\0`, "utf8"),
    Buffer.alloc(20, hashByte),
  ]);
}

describe("parseLooseObject", () => {
  it("inflates a blob", () => {
    const o = parseLooseObject(loose("blob", "hello"));
    assert.equal(o.type, "blob");
    assert.equal(o.body.toString("utf8"), "hello");
  });

  it("throws GitFormatError for data that is not zlib", () => {
    assert.throws(() => parseLooseObject(Buffer.from("not zlib at all")), GitFormatError);
  });

  it("throws GitFormatError for an unknown type", () => {
    assert.throws(() => parseLooseObject(loose("blub", "x")), GitFormatError);
  });

  it("throws GitFormatError when the length in the header does not match the body", () => {
    const bad = deflateSync(Buffer.from("blob 99\0hello", "latin1"));
    assert.throws(() => parseLooseObject(bad), GitFormatError);
  });
});

describe("parseTree", () => {
  it("lists entries, telling files from directories", () => {
    const body = Buffer.concat([
      treeEntry("100644", "README.md", 0xaa),
      treeEntry("40000", "docs", 0xbb),
      treeEntry("100755", "run.sh", 0xcc),
    ]);
    const entries = parseTree(body);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], {
      mode: "100644",
      name: "README.md",
      hash: "aa".repeat(20),
      isDir: false,
    });
    assert.equal(entries[1]?.isDir, true);
    assert.equal(entries[2]?.mode, "100755");
  });

  it("reads a Japanese file name as UTF-8", () => {
    const entries = parseTree(treeEntry("100644", "設計書.md", 0x11));
    assert.equal(entries[0]?.name, "設計書.md");
  });

  it("throws GitFormatError when an entry is truncated", () => {
    const body = treeEntry("100644", "a.txt", 0x22).subarray(0, 15);
    assert.throws(() => parseTree(body), GitFormatError);
  });

  it("gives an empty list for an empty tree", () => {
    assert.deepEqual(parseTree(Buffer.alloc(0)), []);
  });
});

describe("parseCommit", () => {
  const TREE = "1234567890abcdef1234567890abcdef12345678";
  const PARENT = "fedcba0987654321fedcba0987654321fedcba09";

  it("reads the tree, parent, author and message", () => {
    const c = parseCommit(
      Buffer.from(
        `tree ${TREE}\n` +
          `parent ${PARENT}\n` +
          `author Test Author <y@example.com> 1234567890 +0900\n` +
          `committer Test Author <y@example.com> 1234567890 +0900\n` +
          `\n` +
          `Say the tree is clean\n\nbody line\n`,
        "utf8",
      ),
    );
    assert.equal(c.tree, TREE);
    assert.deepEqual(c.parents, [PARENT]);
    assert.equal(c.author?.name, "Test Author");
    assert.equal(c.author?.email, "y@example.com");
    // 1234567890 is 2009-02-13 23:31:30 in UTC. At +0900 it is 08:31:30 on the next day
    assert.equal(c.author?.date, "2009-02-14 08:31:30 +0900");
    assert.equal(c.message, "Say the tree is clean\n\nbody line\n");
  });

  it("reads a first commit too (no parent)", () => {
    const c = parseCommit(
      Buffer.from(`tree ${TREE}\nauthor A <a@b.c> 0 +0000\n\nfirst\n`, "utf8"),
    );
    assert.deepEqual(c.parents, []);
    assert.equal(c.author?.date, "1970-01-01 00:00:00 +0000");
  });

  it("skips a multi-line header such as gpgsig", () => {
    const c = parseCommit(
      Buffer.from(
        `tree ${TREE}\n` +
          `gpgsig -----BEGIN PGP SIGNATURE-----\n` +
          ` line2ofsig\n` +
          ` -----END PGP SIGNATURE-----\n` +
          `\n` +
          `signed commit\n`,
        "utf8",
      ),
    );
    assert.equal(c.tree, TREE);
    assert.equal(c.message, "signed commit\n");
  });

  it("converts a negative time zone offset correctly", () => {
    const c = parseCommit(
      Buffer.from(`tree ${TREE}\nauthor A <a@b.c> 1234567890 -0500\n\nx\n`, "utf8"),
    );
    assert.equal(c.author?.date, "2009-02-13 18:31:30 -0500");
  });

  it("throws GitFormatError when there is no tree", () => {
    assert.throws(() => parseCommit(Buffer.from("author A <a@b.c> 0 +0000\n\nx\n")), GitFormatError);
  });
});
