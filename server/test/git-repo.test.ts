// © 2026 Yasuhiko Yokote

/**
 * Tests of repository reading (`src/git/repo.ts`).
 *
 * A small bare repository is synthesized inside the tests. Objects are built in the real
 * format (zlib, named by their SHA-1), encrypted with AES-256-GCM and stored in a Map.
 * **No real repository and no pCloud access is used.**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { GitRepoError, isValidRefName, pcloudGitFetcher, type GitRepo } from "../src/git/repo.ts";
import { setForbiddenNames } from "../src/guard/path.ts";
import { PCloudClient } from "../src/pcloud/client.ts";
import {
  BASE,
  buildDelta,
  buildPack,
  deltaInsert,
  encrypt,
  FakeRepo,
  sampleRepo,
} from "./git-fixtures.ts";

const sha1obj = (type: string, body: Buffer) =>
  createHash("sha1").update(`${type} ${body.length}\0`, "latin1").update(body).digest("hex");

describe("resolveRef", () => {
  it("follows HEAD to the branch and then to the hash", async () => {
    const { r, c2 } = sampleRepo();
    assert.equal(await r.repo().resolveRef(), c2);
    assert.equal(await r.repo().resolveRef("main"), c2);
    assert.equal(await r.repo().resolveRef("refs/heads/main"), c2);
  });

  it("returns a hash as it is", async () => {
    const { r, c1 } = sampleRepo();
    assert.equal(await r.repo().resolveRef(c1), c1);
  });

  it("looks up packed-refs too (the state after git gc)", async () => {
    const { r, c1 } = sampleRepo();
    r.putText("packed-refs", `# pack-refs with: peeled\n${c1} refs/tags/v1\n`);
    assert.equal(await r.repo().resolveRef("v1"), c1);
  });

  it("throws GitRepoError for a missing ref", async () => {
    const { r } = sampleRepo();
    await assert.rejects(r.repo().resolveRef("nonexistent"), GitRepoError);
  });

  it("falls back to an existing branch when the target of HEAD does not exist (a state observed in practice)", async () => {
    // HEAD still has the default of git init --bare (master) and only main was pushed
    const { r, c2 } = sampleRepo();
    r.putText("HEAD", "ref: refs/heads/master\n");
    assert.equal(await r.repo().resolveRef(), c2);
  });

  it("refuses, naming the target, when there is no branch to fall back to either", async () => {
    const { r } = sampleRepo();
    r.putText("HEAD", "ref: refs/heads/master\n");
    r.files.delete(`${BASE}/refs/heads/main`);
    await assert.rejects(r.repo().resolveRef(), /HEAD points to refs\/heads\/master, but that branch does not exist/);
  });

  it("does not fall back when a branch name is given (a mistyped name must not resolve to another branch)", async () => {
    const { r } = sampleRepo();
    await assert.rejects(r.repo().resolveRef("master"), /ref not found: master/);
  });
});

describe("readCommit", () => {
  it("peels an annotated tag down to the commit", async () => {
    const { r, c1 } = sampleRepo();
    const tag = r.putObject(
      "tag",
      Buffer.from(`object ${c1}\ntype commit\ntag v1\n\nrelease\n`, "utf8"),
    );
    const commit = await r.repo().readCommit(tag);
    assert.equal(commit.hash, c1);
    assert.equal(commit.message, "first\n");
  });
});

/** Reads a file the way `git_read` does: find the entry, then read it. */
async function readFile(repo: GitRepo, commit: string, path: string): Promise<Buffer> {
  return repo.readEntry(await repo.findEntry(commit, path), path);
}

describe("listTree / findEntry / readEntry", () => {
  it("lists the root", async () => {
    const { r, c2 } = sampleRepo();
    const entries = await r.repo().listTree(c2);
    assert.deepEqual(
      entries.map((e) => [e.name, e.isDir]),
      [
        ["README.md", false],
        ["docs", true],
      ],
    );
  });

  it("lists a subdirectory and reads a file with a Japanese name", async () => {
    const { r, c2 } = sampleRepo();
    const entries = await r.repo().listTree(c2, "docs");
    assert.equal(entries[0]?.name, "設計.md");
    const body = await readFile(r.repo(), c2, "docs/設計.md");
    assert.equal(body.toString("utf8"), "# 設計\n");
  });

  it("throws GitRepoError for a missing file and for a directory", async () => {
    const { r, c2 } = sampleRepo();
    await assert.rejects(r.repo().findEntry(c2, "missing.txt"), GitRepoError);
    await assert.rejects(r.repo().findEntry(c2, "docs"), /This is a directory/);
  });
});

describe("log", () => {
  it("follows the first parent and returns newest first", async () => {
    const { r, c1, c2 } = sampleRepo();
    const log = await r.repo().log(c2, 10);
    assert.deepEqual(
      log.map((e) => [e.hash, e.message]),
      [
        [c2, "second\n"],
        [c1, "first\n"],
      ],
    );
  });

  it("stops at max_count", async () => {
    const { r, c2 } = sampleRepo();
    assert.equal((await r.repo().log(c2, 1)).length, 1);
  });
});

describe("integrity and pack handling", () => {
  it("throws GitRepoError when the name and the SHA-1 of the content differ", async () => {
    const r = new FakeRepo();
    const good = r.putObject("blob", Buffer.from("x"));
    // Replace the content with that of another object (name and content do not match)
    const other = Buffer.concat([Buffer.from("blob 1\0", "latin1"), Buffer.from("y")]);
    r.files.set(
      `${BASE}/objects/${good.slice(0, 2)}/${good.slice(2)}`,
      encrypt(deflateSync(other)),
    );
    await assert.rejects(r.repo().readObject(good), /Integrity verification/);
  });

  it("reports a missing object when no pack has it", async () => {
    const { r } = sampleRepo();
    r.putPack([{ type: "blob", body: Buffer.from("unrelated") }]);
    const missing = "0".repeat(40);
    await assert.rejects(r.repo().readObject(missing), /Object not found/);
  });
});

describe("reading from a pack", () => {
  it("reads an object that exists only in a pack, reached through a tree", async () => {
    const r = new FakeRepo();
    const [blobHash] = r.putPack([{ type: "blob", body: Buffer.from("packed content\n") }]);
    const root = r.tree([["100644", "packed.txt", blobHash!]]);
    const c = r.commit(root, [], "pack\n");
    const body = await readFile(r.repo(), c, "packed.txt");
    assert.equal(body.toString("utf8"), "packed content\n");
  });

  it("restores an ofs_delta and passes the SHA-1 verification", async () => {
    const r = new FakeRepo();
    const base = Buffer.from("base-content");
    const result = Buffer.from("XY");
    const delta = buildDelta(base.length, result.length, [deltaInsert(result)]);
    const { pack, offsets } = buildPack([
      { kind: "plain", type: "blob", body: base },
      { kind: "ofs", baseIndex: 0, delta },
    ]);
    r.putPackRaw(pack, [
      { hash: sha1obj("blob", base), offset: offsets[0]! },
      { hash: sha1obj("blob", result), offset: offsets[1]! },
    ]);
    const obj = await r.repo().readObject(sha1obj("blob", result));
    assert.equal(obj.body.toString("utf8"), "XY");
  });

  it("reads from the cache in /tmp the second time (does not fetch from pCloud again)", async () => {
    const r = new FakeRepo();
    const [h] = r.putPack([{ type: "blob", body: Buffer.from("cached\n") }]);
    const dir = mkdtempSync(join(tmpdir(), "git-cache-test-"));
    const loads: string[] = [];
    await r.repo({ cacheDir: dir, onPackLoad: (i) => loads.push(i.source) }).readObject(h!);
    // Even with the pack file removed from the pCloud side (the idx stays), the cache serves the read
    const packKey = [...r.files.keys()].find((k) => k.endsWith(".pack"));
    r.files.delete(packKey!);
    const obj = await r
      .repo({ cacheDir: dir, onPackLoad: (i) => loads.push(i.source) })
      .readObject(h!);
    assert.equal(obj.body.toString("utf8"), "cached\n");
    assert.deepEqual(loads, ["pcloud", "cache"]);
  });
});

describe("isValidRefName", () => {
  it("accepts the names git accepts", () => {
    for (const ok of ["HEAD", "main", "refs/heads/main", "refs/tags/v1.0", "feature/x-1", "refs/heads/\u8a2d\u8a08"]) {
      assert.equal(isValidRefName(ok), true, ok);
    }
  });

  it("**rejects everything that could leave the repository or is not a ref name in git**", () => {
    for (const bad of [
      "", "..", "a/../b", "refs/../x", "/abs", "a//b", "a/", "a.", ".a", "a/.b", "a.lock", "a/b.lock",
      "a b", "a\tb", "a\u0000b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b", "x".repeat(256),
    ]) {
      assert.equal(isValidRefName(bad), false, JSON.stringify(bad));
    }
  });
});

describe("pcloudGitFetcher - **every path is checked right before pCloud is asked**", () => {
  // One of the refused paths below depends on the list of forbidden names
  setForbiddenNames(["credentials", "Crypto Folder"]);

  function fetcherWithLog() {
    const calls: string[] = [];
    const impl = ((input: string | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ result: 2009, error: "File not found." })));
    }) as unknown as typeof fetch;
    const client = new PCloudClient({ apiHost: "https://api.pcloud.com", accessToken: "t", fetchImpl: impl });
    return { calls, fetcher: pcloudGitFetcher(client, 1024) };
  }

  for (const bad of [
    "/git-repository/x.git/refs/../../../credentials/secret.key",
    "/git-repository/x.git/../../Crypto Folder/x",
    "/git-repository/x.git/./HEAD",
    "/git-repository/x.git/a\u0001b",
  ]) {
    it(`refuses ${JSON.stringify(bad)} without calling pCloud`, async () => {
      const { calls, fetcher } = fetcherWithLog();
      await assert.rejects(fetcher.fetchFile(bad), (e: unknown) => e instanceof GitRepoError && /cannot be read/.test(e.message));
      await assert.rejects(fetcher.listNames(bad), (e: unknown) => e instanceof GitRepoError && /cannot be read/.test(e.message));
      assert.deepEqual(calls, []);
    });
  }

  it("**a name inside a repository is not compared with the forbidden names**", async () => {
    // A branch, a tag or a file of git may be called anything. Only the folder and the name of
    // the repository are places the user chose, and those are checked where they are put together
    for (const inside of ["refs/heads/credentials", "refs/tags/Crypto Folder", "objects/ab/cdef"]) {
      const { calls, fetcher } = fetcherWithLog();
      assert.equal(await fetcher.fetchFile(`/git-repository/x.git/${inside}`), undefined, inside);
      assert.equal(calls.length, 1, inside);
    }
  });

  it("an ordinary path reaches pCloud", async () => {
    const { calls, fetcher } = fetcherWithLog();
    assert.equal(await fetcher.fetchFile("/git-repository/x.git/HEAD"), undefined);
    assert.equal(calls.length, 1);
  });
});
