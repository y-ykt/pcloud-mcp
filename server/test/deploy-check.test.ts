// © 2026 Yasuhiko Yokote

/**
 * The check made at deployment (`infra/validate.ts`) against the check the server makes at startup
 * (`src/config.ts`).
 *
 * The two are written separately because the packages are built separately.
 * **This test is what keeps them from drifting apart**: for every input, both must give the same verdict.
 * A value accepted at deployment and refused at startup would deploy a server that cannot start.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";

// `infra` is a separate package with its own compiler settings, so its file is loaded at run time
// instead of being made part of this package's type check. The two functions are typed here
const { checkGitRoot, checkKnownKeys, KNOWN_KEYS, parseForbiddenNames } = (await import(
  new URL("../../infra/validate.ts", import.meta.url).href
)) as {
  checkGitRoot: (gitRoot: string, forbiddenNames: readonly string[]) => void;
  checkKnownKeys: (keys: readonly string[], project: string) => void;
  KNOWN_KEYS: readonly string[];
  parseForbiddenNames: (raw: string) => string[];
};

const base = {
  RESOURCE_URL: "https://example.com/mcp",
  COGNITO_ISSUER: "https://example.com/pool",
  COGNITO_CLIENT_ID: "client",
};

const accepts = (run: () => void): boolean => {
  try {
    run();
    return true;
  } catch {
    return false;
  }
};

/** gitRoot, forbiddenNames, and whether the pair must be accepted. */
const cases: [gitRoot: string, forbiddenNames: string, accepted: boolean][] = [
  // Not set: the git tools are disabled, which is a valid configuration
  ["", "", true],
  ["   ", "", true],
  ["", "credentials", true],
  ["/git-repository", "", true],
  ["/git-repository", "credentials,Crypto Folder", true],
  ["/repos/bare/", "", true],
  ["/repos//bare", "", true],
  ["/credentials/repos", "", true],
  ["/ok", " , ,", true],
  ["/", "", false],
  ["repos", "", false],
  ["/a/../b", "", false],
  ["/a/./b", "", false],
  ["/a/\u0001b", "", false],
  ["/credentials/repos", "credentials", false],
  ["/a/CREDENTIALS", "credentials", false],
  ["/Crypto Folder/x", "credentials, Crypto Folder", false],
  ["/private/x", "Private", false],
  ["/ok", "a/b", false],
  ["/ok", "..", false],
  ["/ok", "a\u0001b", false],
  // A trailing "/" is dropped before anything is measured
  ["/repos/bare///", "", true],
  ["///", "", false],
  [`/${"a".repeat(1000)}/${"b".repeat(1000)}/${"c".repeat(1000)}/${"d".repeat(1000)}/${"e".repeat(91)}/`, "", true],
  [`/${"a".repeat(1023)}//`, "", true],
  // Lengths are counted in bytes of UTF-8. One name must be shorter than 1024 bytes, the whole path at most 4096
  [`/${"a".repeat(1023)}`, "", true],
  [`/${"a".repeat(1024)}`, "", false],
  [`/${"\u3042".repeat(341)}`, "", true],
  [`/${"\u3042".repeat(342)}`, "", false],
  [`/${"a".repeat(1000)}/${"b".repeat(1000)}/${"c".repeat(1000)}/${"d".repeat(1000)}/${"e".repeat(91)}`, "", true],
  [`/${"a".repeat(1000)}/${"b".repeat(1000)}/${"c".repeat(1000)}/${"d".repeat(1000)}/${"e".repeat(92)}`, "", false],
];

describe("the deployment check and the server agree", () => {
  for (const [gitRoot, names, accepted] of cases) {
    // A long value is shortened in the title only
    const shown = gitRoot.length > 40 ? `${gitRoot.slice(0, 20)}... (${Buffer.byteLength(gitRoot)} bytes)` : gitRoot;
    it(`${accepted ? "accept" : "refuse"} gitRoot ${JSON.stringify(shown)} with forbiddenNames ${JSON.stringify(names)}`, () => {
      const atDeployment = accepts(() => checkGitRoot(gitRoot, parseForbiddenNames(names)));
      // The deployment leaves the variable out when the list is empty
      const atStartup = accepts(() =>
        loadConfig({ ...base, GIT_ROOT: gitRoot, ...(names.trim() === "" ? {} : { FORBIDDEN_NAMES: names }) }),
      );
      assert.equal(atDeployment, accepted, "at deployment");
      assert.equal(atStartup, accepted, "at startup");
    });
  }
});

describe("**a key that the deployment does not know stops it**", () => {
  // A misspelled key is otherwise ignored without a word, and its setting silently does not apply.
  // With `forbiddenNames` that means nothing is excluded although the file says otherwise
  const project = "pcloud-mcp";

  it("accepts the keys it knows, and keys of other namespaces", () => {
    checkKnownKeys(
      ["pcloud-mcp:gitRoot", "pcloud-mcp:forbiddenNames", "pcloud-mcp:gitKeyFile", "aws:region", "other:whatever"],
      project,
    );
    checkKnownKeys([], project);
  });

  it("refuses a misspelled key and names it, with the key it resembles", () => {
    assert.throws(
      () => checkKnownKeys(["pcloud-mcp:gitRoot", "pcloud-mcp:forbiddenName"], project),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("pcloud-mcp:forbiddenName") &&
        e.message.includes("forbiddenNames") &&
        !e.message.includes("pcloud-mcp:gitRoot,"),
    );
    assert.throws(() => checkKnownKeys(["pcloud-mcp:GitRoot"], project), /pcloud-mcp:GitRoot/);
    assert.throws(() => checkKnownKeys(["pcloud-mcp:gitroot", "pcloud-mcp:nonsense"], project), /gitroot.*nonsense|nonsense.*gitroot/s);
  });

  const infra = (name: string) => readFileSync(new URL(`../../infra/${name}`, import.meta.url), "utf8");
  const keysIn = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => m[1]!);

  it("**every key the program reads is a known key**", () => {
    const read = keysIn(infra("index.ts"), /cfg\.get\w*\("(\w+)"\)/g);
    assert.ok(read.length >= 10, "the keys read by index.ts were not found");
    for (const key of read) assert.ok(KNOWN_KEYS.includes(key), `index.ts reads ${key}, which is not a known key`);
  });

  it("every key declared in Pulumi.yaml or shown in the example file is a known key", () => {
    for (const file of ["Pulumi.yaml", "Pulumi.prod.yaml.example"]) {
      const keys = keysIn(infra(file), /^\s+(?:# )?pcloud-mcp:(\w+):/gm);
      assert.ok(keys.length >= 5, `no keys found in ${file}`);
      for (const key of keys) assert.ok(KNOWN_KEYS.includes(key), `${file} has ${key}, which is not a known key`);
    }
  });

  it("every key the scripts read is a known key", () => {
    for (const script of ["_config.sh", "set-pcloud-token", "set-git-encrypt-key"]) {
      const text = readFileSync(new URL(`../../bin/${script}`, import.meta.url), "utf8");
      for (const key of keysIn(text, /\bcfg (\w+)[ ")]/g)) {
        assert.ok(KNOWN_KEYS.includes(key), `${script} reads ${key}, which is not a known key`);
      }
    }
  });
});
