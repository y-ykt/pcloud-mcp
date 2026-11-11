// © 2026 Yasuhiko Yokote

/**
 * Tests of the git tools (`src/git/tools.ts`).
 *
 * The repository is the synthetic one from `git-fixtures.ts`. pCloud is not used.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setForbiddenNames } from "../src/guard/path.ts";
import { loadConfig } from "../src/config.ts";
import { GitRepo } from "../src/git/repo.ts";
import { callGitTool, dispatchGitTool, gitToolDefinitions, repoPathOf } from "../src/git/tools.ts";
import { GitRepoError } from "../src/git/repo.ts";
import type { ToolResult } from "../src/mcp/protocol.ts";
import { makeDocx, makePdf, makePng, makeWebp, makeWebpHeader, makeXlsx } from "./fixtures.ts";
import { KEY, repoWithEntry, sampleRepo, FakeRepo } from "./git-fixtures.ts";

/** The folder the git tools read in these tests. */
const GIT_ROOT = "/git-repository";

const CONFIG = loadConfig({
  RESOURCE_URL: "https://x.example.com/mcp",
  COGNITO_ISSUER: "https://y.example.com",
  COGNITO_CLIENT_ID: "c",
  FORBIDDEN_NAMES: "credentials,Crypto Folder",
  // The git tools exist only when a folder is named
  GIT_ROOT,
} as NodeJS.ProcessEnv);
// Loading does not put the names in force; the handler does that in the server. Here it is done by hand
setForbiddenNames(CONFIG.forbiddenNames);

function call(r: FakeRepo, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const repoFor = (repoPath: string) =>
    new GitRepo({ fetcher: r.fetcher(), key: KEY, repoPath });
  return dispatchGitTool(repoFor, CONFIG, name, { repo: "sample.git", ...args });
}

function data(result: ToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe("repoPathOf - repository name validation", () => {
  it("adds .git and places the name directly under /git-repository", () => {
    assert.equal(repoPathOf("example", GIT_ROOT), "/git-repository/example.git");
    assert.equal(repoPathOf("example.git", GIT_ROOT), "/git-repository/example.git");
  });

  it("rejects a name that could leave the root", () => {
    for (const bad of ["../Crypto Folder", "a/b", "a/../b", ".hidden", "", "  ", 42, undefined]) {
      assert.throws(() => repoPathOf(bad, GIT_ROOT), GitRepoError, String(bad));
    }
  });

  it("uses the configured root", () => {
    assert.equal(repoPathOf("sample", "/repos/bare"), "/repos/bare/sample.git");
  });
});

describe("GIT_ROOT", () => {
  const base = {
    RESOURCE_URL: "https://example.com/mcp",
    COGNITO_ISSUER: "https://example.com/pool",
    COGNITO_CLIENT_ID: "client",
    FORBIDDEN_NAMES: "credentials,Crypto Folder",
  };

  it("**is not set by default: the git tools are disabled**", () => {
    assert.equal(loadConfig(base).gitRoot, null);
    assert.equal(loadConfig({ ...base, GIT_ROOT: "" }).gitRoot, null);
    assert.equal(loadConfig({ ...base, GIT_ROOT: "   " }).gitRoot, null);
  });

  it("reads the value and drops a trailing slash", () => {
    assert.equal(loadConfig({ ...base, GIT_ROOT: "/repos/bare/" }).gitRoot, "/repos/bare");
  });

  it("rejects the root, a relative path, and ..", () => {
    for (const bad of ["/", "repos", "/a/../b"]) {
      assert.throws(() => loadConfig({ ...base, GIT_ROOT: bad }), /GIT_ROOT/, `accepted: ${JSON.stringify(bad)}`);
    }
  });

  it("**is checked like any other path: no forbidden folder, no `.`, no control character**", () => {
    for (const bad of ["/credentials/repos", "/Crypto Folder/x", "/repos/CREDENTIALS", "/a/./b", "/a/\u0001b"]) {
      assert.throws(
        () => loadConfig({ ...base, GIT_ROOT: bad }),
        /GIT_ROOT/,
        `accepted: ${JSON.stringify(bad)}`,
      );
    }
  });

  it("an empty segment does not reach the path that is looked up", () => {
    assert.equal(loadConfig({ ...base, GIT_ROOT: "/repos//bare" }).gitRoot, "/repos/bare");
  });

  it("appears in the tool descriptions", () => {
    const defs = gitToolDefinitions(loadConfig({ ...base, GIT_ROOT: "/repos/bare" }));
    assert.ok(defs.every((d) => d.description.includes("/repos/bare")));
  });
});

describe("git_ls", () => {
  it("returns the root listing with type", async () => {
    const { r } = sampleRepo();
    const d = data(await call(r, "git_ls", {}));
    assert.equal(d["path"], "/");
    assert.deepEqual(
      (d["entries"] as Array<{ name: string; type: string }>).map((e) => [e.name, e.type]),
      [
        ["README.md", "file"],
        ["docs", "dir"],
      ],
    );
  });

  it("accepts ref and a subdirectory", async () => {
    const { r, c1 } = sampleRepo();
    const d = data(await call(r, "git_ls", { ref: c1, path: "docs" }));
    assert.equal(d["commit"], c1);
    assert.equal((d["entries"] as Array<{ name: string }>)[0]?.name, "設計.md");
  });

  it("lists from a commit that exists only in a pack (the state after git gc)", async () => {
    const r = new FakeRepo();
    const blob = r.putObject("blob", Buffer.from("hi\n"));
    const root = r.tree([["100644", "hi.txt", blob]]);
    const commitBody = Buffer.from(
      `tree ${root}\nauthor A <a@b.c> 0 +0000\ncommitter A <a@b.c> 0 +0000\n\npacked\n`,
      "utf8",
    );
    const [commitHash] = r.putPack([{ type: "commit", body: commitBody }]);
    r.putText("HEAD", "ref: refs/heads/main\n");
    r.putText("refs/heads/main", `${commitHash}\n`);
    const d = data(await call(r, "git_ls", {}));
    assert.deepEqual(
      (d["entries"] as Array<{ name: string }>).map((e) => e.name),
      ["hi.txt"],
    );
  });
});

describe("git_read", () => {
  it("returns the text content and states the verification", async () => {
    const { r } = sampleRepo();
    const d = data(await call(r, "git_read", { path: "docs/設計.md" }));
    assert.equal(d["content"], "# 設計\n");
    assert.equal(d["truncated"], false);
    assert.match(String(d["verified"]), /SHA-1/);
  });

  it("returns no content for binary and reports the size and mode", async () => {
    const { r, root } = sampleRepo();
    const bin = r.putObject("blob", Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]));
    const newRoot = r.tree([["100644", "data.bin", bin]]);
    const c = r.commit(newRoot, [], "bin\n");
    void root;
    const result = await call(r, "git_read", { ref: c, path: "data.bin" });
    assert.equal(result.isError, true);
    const d = data(result);
    assert.equal(d["size"], 5);
    assert.equal(d["content"], undefined);
  });

  it("gives isError without path", async () => {
    const { r } = sampleRepo();
    assert.equal((await call(r, "git_read", {})).isError, true);
  });

  it("returns only the beginning of text over the limit and says so", async () => {
    const { r } = sampleRepo();
    const big = r.putObject("blob", Buffer.from("あ".repeat(200_000), "utf8"));
    const newRoot = r.tree([["100644", "big.txt", big]]);
    const c = r.commit(newRoot, [], "big\n");
    const d = data(await call(r, "git_read", { ref: c, path: "big.txt" }));
    assert.equal(d["truncated"], true);
    assert.ok(String(d["note"]).includes("Only the first"));
    assert.ok((d["returned_bytes"] as number) <= CONFIG.readMaxBytes);
  });
});

describe("git_read - binary (same converters as read_file)", () => {
  /** Builds a repository that holds a single file. */
  it("PDF: returns the page count without pages and image blocks with pages", async () => {
    const r = repoWithEntry("100644", "doc.pdf", makePdf(2));
    const info = data(await call(r, "git_read", { path: "doc.pdf" }));
    assert.equal(info["kind"], "pdf_info");
    assert.equal(info["page_count"], 2);
    assert.match(String(info["verified"]), /object name matches the SHA-1 of the content/);

    const result = await call(r, "git_read", { path: "doc.pdf", pages: "1" });
    assert.equal(data(result)["kind"], "pdf_pages");
    assert.ok(result.content.some((b) => b.type === "image"));
  });

  it("Word: is converted to Markdown, and the source names the repository and the commit", async () => {
    const r = repoWithEntry("100644", "設計書.docx", makeDocx(["Hello", "World"]));
    const result = await call(r, "git_read", { path: "設計書.docx" });
    const d = data(result);
    assert.equal(d["kind"], "office");
    assert.equal(result.content[1]?.type, "text");
    assert.match(String((result.content[1] as { text: string }).text), /Hello/);
    assert.match(String((result.content[0] as { text: string }).text), /[0-9a-f]{7} of sample\.git/);
  });

  it("Excel: cell values appear in the Markdown", async () => {
    const r = repoWithEntry("100644", "表.xlsx", makeXlsx([["name", "value"], ["alpha", "42"]]));
    const result = await call(r, "git_read", { path: "表.xlsx" });
    assert.equal(data(result)["kind"], "office");
    assert.match(String((result.content[1] as { text: string }).text), /alpha/);
  });

  it("image: is returned as an image block", async () => {
    const r = repoWithEntry("100644", "図.png", makePng(10, 10));
    const result = await call(r, "git_read", { path: "図.png" });
    assert.equal(data(result)["kind"], "image");
    assert.ok(result.content.some((b) => b.type === "image"));
  });

  it("refuses a legacy Office format, stating the reason", async () => {
    const r = repoWithEntry("100644", "old.doc", Buffer.from("dummy"));
    const result = await call(r, "git_read", { path: "old.doc" });
    assert.equal(result.isError, true);
    assert.match(String(data(result)["error"]), /Office formats from before 2007/);
  });

  it("refuses an image format the receiving side cannot read", async () => {
    const r = repoWithEntry("100644", "pic.bmp", Buffer.from([0x42, 0x4d, 0x00]));
    const result = await call(r, "git_read", { path: "pic.bmp" });
    assert.equal(result.isError, true);
    assert.match(String(data(result)["error"]), /JPEG, PNG, GIF and WebP/);
  });

  it("refuses binary over the limit at the check after inflation", async () => {
    // The limit for an image is downloadMaxBytes (1 MiB). Store a png larger than that
    const big = Buffer.alloc(CONFIG.downloadMaxBytes + 1, 7);
    const r = repoWithEntry("100644", "big.png", big);
    const result = await call(r, "git_read", { path: "big.png" });
    assert.equal(result.isError, true);
    assert.match(String(data(result)["error"]), /The file exceeds the limit/);
  });
});

describe("git_log", () => {
  it("returns newest first", async () => {
    const { r, c1, c2 } = sampleRepo();
    const d = data(await call(r, "git_log", {}));
    assert.equal(d["count"], 2);
    const commits = d["commits"] as Array<{ hash: string; message: string; author: string }>;
    assert.deepEqual(
      commits.map((c) => [c.hash, c.message]),
      [
        [c2, "second"],
        [c1, "first"],
      ],
    );
    assert.equal(commits[0]?.author, "A");
  });

  it("stops at max_count and says the result may be cut off", async () => {
    const { r } = sampleRepo();
    const d = data(await call(r, "git_log", { max_count: 1 }));
    assert.equal(d["count"], 1);
    assert.ok(String(d["note"]).includes("may have been cut off at the count limit (1)"));
  });
});

describe("definitions", () => {
  it("all 3 tools carry the read-only annotation", () => {
    const defs = gitToolDefinitions(CONFIG);
    assert.deepEqual(
      defs.map((d) => d.name),
      ["git_ls", "git_read", "git_log"],
    );
    for (const d of defs) {
      assert.equal((d.annotations as { readOnlyHint: boolean }).readOnlyHint, true);
    }
  });
});

describe("git_read - notes of a text response", () => {
  it("a symbolic link is noted", async () => {
    const d = data(await call(repoWithEntry("120000", "link", "docs/target.md"), "git_read", { path: "link" }));
    assert.equal(d["truncated"], false);
    assert.equal(d["note"], "This is a symbolic link. content is the path of the link target.");
  });

  it("**a truncated symbolic link keeps both notes**", async () => {
    const target = "a".repeat(CONFIG.readMaxBytes + 10);
    const d = data(await call(repoWithEntry("120000", "link", target), "git_read", { path: "link" }));
    assert.equal(d["truncated"], true);
    assert.equal(d["returned_bytes"], CONFIG.readMaxBytes);
    assert.match(String(d["note"]), /Only the first \d+ bytes of \d+ bytes in total were returned\./);
    assert.match(String(d["note"]), /This is a symbolic link\. content is the path of the link target\./);
  });
});

describe("git_read - a symbolic link whose name looks like another format", () => {
  // The content of a link is the path of its target, never an image, a PDF or a document
  for (const name of ["logo.png", "manual.pdf", "report.docx"]) {
    it(`**${name} is returned as the path of its target**`, async () => {
      const d = data(await call(repoWithEntry("120000", name, "../assets/target"), "git_read", { path: name }));
      assert.equal(d["kind"], "text");
      assert.equal(d["content"], "../assets/target");
      assert.equal(d["note"], "This is a symbolic link. content is the path of the link target.");
    });
  }
});

describe("**a ref cannot point outside the repository**", () => {
  /** Runs a tool and records every path the repository asks the storage for. */
  async function requested(tool: string, args: Record<string, unknown>) {
    const r = sampleRepo().r;
    const paths: string[] = [];
    const inner = r.fetcher();
    const fetcher = {
      fetchFile: (p: string, max?: number) => (paths.push(p), inner.fetchFile(p, max)),
      listNames: (p: string) => (paths.push(p), inner.listNames(p)),
    };
    const repoFor = (repoPath: string) => new GitRepo({ fetcher, key: KEY, repoPath });
    const result = await dispatchGitTool(repoFor, CONFIG, tool, { repo: "sample.git", ...args });
    return { result, paths };
  }

  const bad = [
    "refs/../../../credentials/secret.key",
    "../../../Crypto Folder/x",
    "refs/heads/../../HEAD",
    "/refs/heads/main",
    "refs//heads/main",
    "refs/heads/main/",
    "refs/heads/.hidden",
    "refs/heads/a\u0001b",
    "refs/heads/a b",
    "refs/heads/a\\b",
    "main.lock",
    "a:b",
  ];
  for (const tool of ["git_ls", "git_read", "git_log"]) {
    for (const ref of bad) {
      it(`${tool} refuses ${JSON.stringify(ref)} without asking the storage for anything`, async () => {
        const { result, paths } = await requested(tool, { ref, path: "README.md" });
        assert.equal(result.isError, true);
        assert.match(String(data(result)["error"]), /Not a valid ref name/);
        assert.deepEqual(paths, [], "the storage was asked although the ref is not valid");
      });
    }
  }

  it("ordinary refs are still accepted", async () => {
    for (const ref of ["HEAD", "main", "refs/heads/main"]) {
      const { result, paths } = await requested("git_log", { ref });
      assert.notEqual(result.isError, true, ref);
      assert.ok(paths.every((p) => p.startsWith("/git-repository/sample.git/")), ref);
    }
  });
});

describe("git_read - **a name that is refused is refused before the repository is read**", () => {
  /** Runs git_read and counts how often the repository asks the storage for something. */
  async function readCounting(r: FakeRepo, args: Record<string, unknown>) {
    let asked = 0;
    const inner = r.fetcher();
    const fetcher = {
      fetchFile: (p: string, max?: number) => (asked++, inner.fetchFile(p, max)),
      listNames: (p: string) => (asked++, inner.listNames(p)),
    };
    const repoFor = (repoPath: string) => new GitRepo({ fetcher, key: KEY, repoPath });
    const result = await dispatchGitTool(repoFor, CONFIG, "git_read", { repo: "sample.git", ...args });
    return { result, asked };
  }

  // Resolving a tree can mean fetching a whole pack. A request that the name alone decides must not pay for it
  for (const [name, pattern] of [
    ["old.doc", /Office formats from before 2007/],
    ["pic.bmp", /This image format cannot be handled/],
  ] as const) {
    it(`${name}: refused without asking the storage, whether it is a file or a symbolic link`, async () => {
      for (const mode of ["100644", "120000"]) {
        const { result, asked } = await readCounting(repoWithEntry(mode, name, "x"), { path: name });
        assert.equal(result.isError, true);
        assert.match(String(data(result)["error"]), pattern);
        assert.equal(asked, 0, `the storage was asked ${asked} times (mode ${mode})`);
      }
    });

    it(`${name}: with as_text a symbolic link of that name returns the path of its target`, async () => {
      const { result } = await readCounting(repoWithEntry("120000", name, "../assets/target"), { path: name, as_text: true });
      assert.equal(data(result)["content"], "../assets/target");
      assert.equal(data(result)["note"], "This is a symbolic link. content is the path of the link target.");
    });
  }
});

describe("**the git tools are disabled when no folder is named**", () => {
  const DISABLED = loadConfig({
    RESOURCE_URL: "https://x.example.com/mcp",
    COGNITO_ISSUER: "https://y.example.com",
    COGNITO_CLIENT_ID: "c",
  } as NodeJS.ProcessEnv);

  it("no git tool is listed", () => {
    assert.deepEqual(gitToolDefinitions(DISABLED), []);
    assert.deepEqual(gitToolDefinitions(CONFIG).map((d) => d.name), ["git_ls", "git_read", "git_log"]);
  });

  for (const tool of ["git_ls", "git_read", "git_log"]) {
    it(`${tool} answers that the feature is disabled, without reading anything`, async () => {
      let asked = 0;
      const inner = sampleRepo().r.fetcher();
      const fetcher = {
        fetchFile: (p: string, max?: number) => (asked++, inner.fetchFile(p, max)),
        listNames: (p: string) => (asked++, inner.listNames(p)),
      };
      const repoFor = (repoPath: string) => new GitRepo({ fetcher, key: KEY, repoPath });
      const result = await dispatchGitTool(repoFor, DISABLED, tool, { repo: "sample.git", path: "README.md" });
      assert.equal(result.isError, true);
      assert.match(String(data(result)["error"]), /The git tools are disabled/);
      assert.match(String(data(result)["error"]), /gitRoot/);
      assert.equal(asked, 0);
    });
  }

  it("**a call does not ask for the key either**", async () => {
    let keyAsked = 0;
    const keyProvider = { get: () => (keyAsked++, Promise.resolve(KEY)) };
    // No pCloud client is needed: the call must stop before it is used
    const result = await callGitTool(undefined as never, keyProvider, DISABLED, "git_ls", { repo: "sample.git" });
    assert.equal(result.isError, true);
    assert.match(String(data(result)["error"]), /The git tools are disabled/);
    assert.equal(keyAsked, 0);
  });
});

describe("the forbidden names and the git tools", () => {
  const withList = async (names: string[], run: () => Promise<void>) => {
    setForbiddenNames(names);
    try {
      await run();
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  };

  it("**a branch may have the name of a forbidden folder**", async () => {
    const r = new FakeRepo();
    const blob = r.putObject("blob", Buffer.from("hello\n", "utf8"));
    const c = r.commit(r.tree([["100644", "README.md", blob]]), [], "first\n");
    r.putText("HEAD", "ref: refs/heads/private\n");
    r.putText("refs/heads/private", `${c}\n`);
    await withList(["private", "refs", "objects", "HEAD"], async () => {
      // HEAD points at the branch, so every tool goes through it
      assert.equal(data(await call(r, "git_read", { path: "README.md" }))["content"], "hello\n");
      assert.notEqual((await call(r, "git_log", {})).isError, true);
      assert.notEqual((await call(r, "git_ls", { ref: "private" })).isError, true);
    });
  });

  it("**a repository with a forbidden name is refused**", async () => {
    await withList(["secret.git", "vault"], async () => {
      assert.throws(() => repoPathOf("secret", GIT_ROOT), GitRepoError);
      assert.throws(() => repoPathOf("SECRET.git", GIT_ROOT), GitRepoError);
      assert.equal(repoPathOf("open", GIT_ROOT), "/git-repository/open.git");
      // The folder is checked again here, should a configuration reach this point unchecked
      assert.throws(() => repoPathOf("open", "/vault/repos"), GitRepoError);
    });
  });
});

describe("git_read - a WebP that is too large", () => {
  it("**is refused with the limit of a WebP, not the general one**", async () => {
    // A WebP header followed by padding, 70 KiB in all: over the 64 KiB a WebP may have
    const big = new Uint8Array(70 * 1024);
    big.set(makeWebpHeader(640, 480));
    const result = await call(repoWithEntry("100644", "big.webp", big), "git_read", { path: "big.webp" });
    assert.equal(result.isError, true);
    assert.match(String(data(result)["error"]), /This WebP image is too large to return \(71680 bytes \/ limit 65536 bytes\)/);
    assert.equal(data(result)["reason"], "webp-too-large");
  });

  it("**the limit of a WebP is applied to the image, not to the stored object**", async () => {
    // A stored object is encrypted and compressed, so its size is not the size of the image.
    // Applying 64 KiB to it would refuse an image just under the limit, with an error about the object
    /** Records the size limit each read is given. */
    class Recording extends GitRepo {
      limits: (number | undefined)[] = [];
      override readEntry(...args: Parameters<GitRepo["readEntry"]>) {
        this.limits.push(args[2]);
        return super.readEntry(...args);
      }
    }
    const limitFor = async (name: string, content: Uint8Array) => {
      const r = repoWithEntry("100644", name, content);
      let repo: Recording | undefined;
      const repoFor = (repoPath: string) => (repo = new Recording({ fetcher: r.fetcher(), key: KEY, repoPath }));
      await dispatchGitTool(repoFor, CONFIG, "git_read", { repo: "sample.git", path: name });
      return repo!.limits[0];
    };
    assert.equal(await limitFor("a.webp", makeWebp()), CONFIG.downloadMaxBytes);
    assert.equal(await limitFor("a.png", makePng(10, 10)), CONFIG.downloadMaxBytes);
  });

  it("**a WebP just under the limit is returned, one just over is refused**", async () => {
    const ofSize = (bytes: number) => {
      const b = new Uint8Array(bytes);
      b.set(makeWebpHeader(640, 480));
      return b;
    };
    const under = await call(repoWithEntry("100644", "a.webp", ofSize(64 * 1024)), "git_read", { path: "a.webp" });
    assert.notEqual(under.isError, true);
    const over = await call(repoWithEntry("100644", "a.webp", ofSize(64 * 1024 + 1)), "git_read", { path: "a.webp" });
    assert.equal(over.isError, true);
    assert.equal(data(over)["reason"], "webp-too-large");
    assert.ok(!String(data(over)["error"]).includes("objects/"), "the path of the stored object is disclosed");
  });

  it("**a failure of the image step keeps its reason**", async () => {
    // Too many pixels for a WebP: refused by the image step, not by this tool
    const result = await call(repoWithEntry("100644", "wide.webp", makeWebpHeader(5000, 10)), "git_read", { path: "wide.webp" });
    assert.equal(result.isError, true);
    assert.equal(data(result)["reason"], "webp-too-many-pixels");
  });

  it("a small WebP is returned", async () => {
    const result = await call(repoWithEntry("100644", "small.webp", makeWebp()), "git_read", { path: "small.webp" });
    assert.notEqual(result.isError, true);
    assert.equal(data(result)["returned_content_type"], "image/webp");
  });
});
