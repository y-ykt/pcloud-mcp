// © 2026 Yasuhiko Yokote

/**
 * Tests of pack index parsing (`src/git/idx.ts`). The idx is built by hand inside the tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitFormatError } from "../src/git/object.ts";
import { parseIndex } from "../src/git/idx.ts";
import { buildIdx } from "./git-fixtures.ts";

const H = (head: string) => head + "0".repeat(40 - head.length);

describe("parseIndex", () => {
  const entries = [
    { hash: H("00ab"), offset: 12 },
    { hash: H("7f01"), offset: 3456 },
    { hash: H("7f02"), offset: 78 },
    { hash: H("ff9c"), offset: 901 },
  ];
  const idx = parseIndex(buildIdx(entries));

  it("gives the object count and looks up each offset", () => {
    assert.equal(idx.count, 4);
    for (const e of entries) {
      assert.equal(idx.find(e.hash), e.offset, e.hash);
    }
  });

  it("returns undefined for a missing hash (even when the first byte matches)", () => {
    assert.equal(idx.find(H("7f03")), undefined);
    assert.equal(idx.find(H("aa")), undefined);
  });

  it("looks up an offset of 2^31 or more in the large offset table", () => {
    const big = parseIndex(
      buildIdx([
        { hash: H("01"), offset: 100 },
        { hash: H("02"), offset: 0x1_2345_6789 },
      ]),
    );
    assert.equal(big.find(H("02")), 0x1_2345_6789);
    assert.equal(big.find(H("01")), 100);
  });

  it("throws GitFormatError for a wrong magic or input that is too short", () => {
    assert.throws(() => parseIndex(Buffer.alloc(2000)), GitFormatError);
    assert.throws(() => parseIndex(Buffer.alloc(10)), GitFormatError);
  });
});
