// © 2026 Yasuhiko Yokote

/**
 * Tests of pack reading (`src/git/pack.ts`). The pack is built by hand inside the tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitFormatError, type GitObject } from "../src/git/object.ts";
import { applyDelta, parsePackHeader, readPackedObject } from "../src/git/pack.ts";
import { buildDelta, buildPack, deltaCopy, deltaInsert } from "./git-fixtures.ts";

const noFind = () => undefined;
const noBase = (hash: string): Promise<GitObject> => {
  throw new Error(`resolveBase was called: ${hash}`);
};

describe("parsePackHeader", () => {
  it("reads the version and the object count", () => {
    const { pack } = buildPack([{ kind: "plain", type: "blob", body: Buffer.from("x") }]);
    assert.deepEqual(parsePackHeader(pack), { version: 2, count: 1 });
  });

  it("throws GitFormatError for a wrong magic", () => {
    assert.throws(() => parsePackHeader(Buffer.alloc(40)), GitFormatError);
  });
});

describe("readPackedObject - no delta", () => {
  it("extracts an entry at any position among several", async () => {
    const { pack, offsets } = buildPack([
      { kind: "plain", type: "blob", body: Buffer.from("first\n") },
      { kind: "plain", type: "commit", body: Buffer.from("tree ...") },
      { kind: "plain", type: "blob", body: Buffer.from("third\n") },
    ]);
    const o2 = await readPackedObject(pack, offsets[2]!, noFind, noBase);
    assert.equal(o2.type, "blob");
    assert.equal(o2.body.toString("utf8"), "third\n");
    const o1 = await readPackedObject(pack, offsets[1]!, noFind, noBase);
    assert.equal(o1.type, "commit");
  });

  it("reads a length of 16 or more correctly (variable-length header of 2 bytes or more)", async () => {
    const body = Buffer.from("a".repeat(5000));
    const { pack, offsets } = buildPack([{ kind: "plain", type: "blob", body }]);
    const o = await readPackedObject(pack, offsets[0]!, noFind, noBase);
    assert.equal(o.body.length, 5000);
  });
});

describe("readPackedObject - delta", () => {
  const base = Buffer.from("Hello, world! This is the base object.");

  it("ofs_delta: applies copy and insert, and takes the type of the base", async () => {
    // "Hello, world!" (copy 0..13) + "!!" (insert) + " base object." (copy 25..38)
    const delta = buildDelta(base.length, 13 + 2 + 13, [
      deltaCopy(0, 13),
      deltaInsert(Buffer.from("!!")),
      deltaCopy(25, 13),
    ]);
    const { pack, offsets } = buildPack([
      { kind: "plain", type: "blob", body: base },
      { kind: "ofs", baseIndex: 0, delta },
    ]);
    const o = await readPackedObject(pack, offsets[1]!, noFind, noBase);
    assert.equal(o.type, "blob");
    assert.equal(o.body.toString("utf8"), "Hello, world!!! base object.");
  });

  it("ref_delta: looks up the base with findInPack when it is in the same pack", async () => {
    const baseHash = "ab".repeat(20);
    const delta = buildDelta(base.length, 5, [deltaCopy(7, 5)]);
    const { pack, offsets } = buildPack([
      { kind: "plain", type: "tree", body: base },
      { kind: "ref", baseHash, delta },
    ]);
    const find = (h: string) => (h === baseHash ? offsets[0] : undefined);
    const o = await readPackedObject(pack, offsets[1]!, find, noBase);
    assert.equal(o.type, "tree");
    assert.equal(o.body.toString("utf8"), "world");
  });

  it("ref_delta: passes a base that is not in the pack to resolveBase", async () => {
    const baseHash = "cd".repeat(20);
    const delta = buildDelta(base.length, 5, [deltaCopy(0, 5)]);
    const { pack, offsets } = buildPack([{ kind: "ref", baseHash, delta }]);
    const resolver = (h: string): Promise<GitObject> => {
      assert.equal(h, baseHash);
      return Promise.resolve({ type: "blob", body: base });
    };
    const o = await readPackedObject(pack, offsets[0]!, noFind, resolver);
    assert.equal(o.body.toString("utf8"), "Hello");
  });

  it("restores a delta chain too (the base of a delta is a delta)", async () => {
    const d1 = buildDelta(base.length, 13, [deltaCopy(0, 13)]); // "Hello, world!"
    const d2 = buildDelta(13, 6, [deltaCopy(7, 5), deltaInsert(Buffer.from("!"))]); // "world!"
    const { pack, offsets } = buildPack([
      { kind: "plain", type: "blob", body: base },
      { kind: "ofs", baseIndex: 0, delta: d1 },
      { kind: "ofs", baseIndex: 1, delta: d2 },
    ]);
    const o = await readPackedObject(pack, offsets[2]!, noFind, noBase);
    assert.equal(o.body.toString("utf8"), "world!");
  });

  it("a copy length of 0 means 65536 bytes", async () => {
    const big = Buffer.alloc(70000, 0x42);
    const delta = buildDelta(big.length, 0x10000, [deltaCopy(0, 0x10000)]);
    const { pack, offsets } = buildPack([
      { kind: "plain", type: "blob", body: big },
      { kind: "ofs", baseIndex: 0, delta },
    ]);
    const o = await readPackedObject(pack, offsets[1]!, noFind, noBase);
    assert.equal(o.body.length, 0x10000);
  });
});

describe("applyDelta - reporting failures", () => {
  it("throws GitFormatError when the base length differs from the recorded one", () => {
    const delta = buildDelta(99, 1, [deltaCopy(0, 1)]);
    assert.throws(() => applyDelta(Buffer.from("abc"), delta), GitFormatError);
  });

  it("throws GitFormatError when a copy exceeds the range of the base", () => {
    const delta = buildDelta(3, 10, [deltaCopy(1, 10)]);
    assert.throws(() => applyDelta(Buffer.from("abc"), delta), GitFormatError);
  });

  it("throws GitFormatError when the result length does not match the recorded one", () => {
    const delta = buildDelta(3, 99, [deltaCopy(0, 3)]);
    assert.throws(() => applyDelta(Buffer.from("abc"), delta), GitFormatError);
  });
});
