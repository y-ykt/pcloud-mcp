// © 2026 Yasuhiko Yokote

/**
 * Tests of reading the environment variables (`src/config.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { isForbiddenName, setForbiddenNames } from "../src/guard/path.ts";

const base = {
  RESOURCE_URL: "https://example.com/mcp",
  COGNITO_ISSUER: "https://example.com/pool",
  COGNITO_CLIENT_ID: "client",
};

describe("FORBIDDEN_NAMES - the names that are never entered", () => {
  it("**is empty by default: nothing is excluded**", () => {
    assert.deepEqual(loadConfig(base).forbiddenNames, []);
    assert.deepEqual(loadConfig({ ...base, FORBIDDEN_NAMES: "" }).forbiddenNames, []);
    assert.deepEqual(loadConfig({ ...base, FORBIDDEN_NAMES: " , ," }).forbiddenNames, []);
  });

  it("reads a list separated by commas, keeping spaces inside a name", () => {
    assert.deepEqual(
      loadConfig({ ...base, FORBIDDEN_NAMES: "credentials, Crypto Folder ,private" }).forbiddenNames,
      ["credentials", "Crypto Folder", "private"],
    );
  });

  it("drops a name given twice, without regard to case", () => {
    assert.deepEqual(
      loadConfig({ ...base, FORBIDDEN_NAMES: "credentials,Credentials,CREDENTIALS" }).forbiddenNames,
      ["credentials"],
    );
  });

  it("**rejects an entry that is not the name of one folder**", () => {
    for (const bad of ["a/b", "/credentials", ".", "..", "a\u0001b"]) {
      assert.throws(
        () => loadConfig({ ...base, FORBIDDEN_NAMES: `ok,${bad}` }),
        /FORBIDDEN_NAMES/,
        `accepted: ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("the forbidden names and loading the configuration", () => {
  it("GIT_ROOT is checked against the names that were listed", () => {
    assert.throws(
      () => loadConfig({ ...base, FORBIDDEN_NAMES: "credentials", GIT_ROOT: "/credentials/repos" }),
      /GIT_ROOT is not accepted/,
    );
  });

  it("**with no name listed, such a folder is accepted**", () => {
    assert.equal(loadConfig({ ...base, GIT_ROOT: "/credentials/repos" }).gitRoot, "/credentials/repos");
  });

  it("**loading only reads: it does not change the names in force**", () => {
    setForbiddenNames(["in-force"]);
    try {
      const cfg = loadConfig({ ...base, FORBIDDEN_NAMES: "credentials" });
      assert.deepEqual(cfg.forbiddenNames, ["credentials"]);
      assert.equal(isForbiddenName("in-force"), true, "the list in force was replaced by a load");
      assert.equal(isForbiddenName("credentials"), false, "a load put its list in force");
      // A load that fails leaves it alone as well
      assert.throws(() => loadConfig({ ...base, FORBIDDEN_NAMES: "credentials", GIT_ROOT: "/credentials/x" }));
      assert.equal(isForbiddenName("in-force"), true);
    } finally {
      setForbiddenNames([]);
    }
  });
});
