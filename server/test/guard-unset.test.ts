// © 2026 Yasuhiko Yokote

/**
 * The path check before the forbidden names have been set.
 *
 * In its own file on purpose: every test file runs in its own process, and this one must start
 * in the state in which nothing has set the names yet.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasForbiddenNames,
  isForbiddenName,
  normalizePath,
  normalizePathWith,
  normalizeStructure,
  setForbiddenNames,
} from "../src/guard/path.ts";
import { redactPath } from "../src/mcp/calllog.ts";

describe("**before the forbidden names are set, nothing is let through**", () => {
  // "Not set" must not mean "nothing is forbidden": a caller that forgot to set the names would
  // then read everything, although the configuration lists names

  it("a check against the names in force fails, whatever the path", () => {
    for (const run of [
      () => normalizePath("/My Documents/a.txt"),
      () => normalizePath("/"),
      () => isForbiddenName("a"),
      () => hasForbiddenNames(),
      () => redactPath("/a/b"),
    ]) {
      assert.throws(run, /forbidden names have not been set/);
    }
  });

  it("the checks that do not use the names in force work", () => {
    assert.equal(normalizeStructure("/repo.git/HEAD"), "/repo.git/HEAD");
    assert.equal(normalizePathWith("/a/b", ["x"]), "/a/b");
  });

  it("once the names are set, also to none, the checks work", () => {
    setForbiddenNames([]);
    assert.equal(normalizePath("/My Documents/a.txt"), "/My Documents/a.txt");
    assert.equal(hasForbiddenNames(), false);
    setForbiddenNames(["private"]);
    assert.equal(isForbiddenName("Private"), true);
  });
});
