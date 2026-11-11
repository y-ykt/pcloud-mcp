// © 2026 Yasuhiko Yokote

/**
 * Tests for the `tools/call` record (`src/mcp/calllog.ts`).
 *
 * They check two things.
 *   1. The size and the shape are recorded correctly
 *   2. **The content, and the names that policy forbids handling, are not recorded**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setForbiddenNames } from "../src/guard/path.ts";
import { describeTarget, redactPath, summarizeCall } from "../src/mcp/calllog.ts";
import type { ToolResult } from "../src/mcp/protocol.ts";

const imageResult = (chars: number, mime = "image/jpeg"): ToolResult => ({
  content: [
    { type: "text", text: '{"kind":"file"}' },
    { type: "image", data: "A".repeat(chars), mimeType: mime },
  ],
  structuredContent: { kind: "file" },
});

// The names that are masked come from the configuration and are none by default.
// These tests run with two names listed, except where a test sets the list itself
setForbiddenNames(["credentials", "Crypto Folder"]);

describe("redactPath - masks the names that cannot be handled", () => {
  it("**masks nothing when no name is listed**", () => {
    setForbiddenNames([]);
    try {
      assert.equal(redactPath("/credentials/aws.txt"), "/credentials/aws.txt");
      assert.equal(describeTarget({ path: "/Crypto Folder/x" }), "/Crypto Folder/x");
    } finally {
      setForbiddenNames(["credentials", "Crypto Folder"]);
    }
  });

  it("masks credentials", () => {
    assert.equal(redactPath("/credentials/aws.txt"), "/***/aws.txt");
  });

  it("masks Crypto Folder", () => {
    assert.equal(redactPath("/Crypto Folder/tax/2024.pdf"), "/***/tax/2024.pdf");
  });

  it("masks them despite differences in case and surrounding whitespace", () => {
    assert.equal(redactPath("/ Credentials /x"), "/***/x");
  });

  it("leaves an ordinary path unchanged", () => {
    assert.equal(redactPath("/My Pictures/写真/sample.jpg"), "/My Pictures/写真/sample.jpg");
  });
});

describe("describeTarget - how the target is expressed", () => {
  it("uses path when there is one", () => {
    assert.equal(describeTarget({ path: "/a/b.txt" }), "/a/b.txt");
  });

  it("uses file_id when there is no path", () => {
    assert.equal(describeTarget({ file_id: 123 }), "file_id:123");
  });

  it("handles folder_id too", () => {
    assert.equal(describeTarget({ folder_id: 0 }), "folder_id:0");
  });

  it("is undefined when there is none of them", () => {
    assert.equal(describeTarget({}), undefined);
  });

  it("**masking applies to the target too**", () => {
    assert.equal(describeTarget({ path: "/credentials/x" }), "/***/x");
  });
});

describe("summarizeCall - info level", () => {
  const log = summarizeCall("download_file", { path: "/p/sweet.jpg" }, imageResult(216_517), false);

  it("records the tool name and the target", () => {
    assert.equal(log.tool, "download_file");
    assert.equal(log.target, "/p/sweet.jpg");
  });

  it("lists the block types", () => {
    assert.equal(log.blocks, "text,image");
  });

  it("counts the characters of the content correctly", () => {
    assert.equal(log.content_chars, 15 + 216_517);
  });

  it("**does not record the arguments or the per-block detail**", () => {
    assert.equal(log.args, undefined);
    assert.equal(log.block_detail, undefined);
  });

  it("**the base64 data itself appears nowhere**", () => {
    assert.ok(!JSON.stringify(log).includes("AAAA"));
  });
});

describe("summarizeCall - debug level", () => {
  const log = summarizeCall(
    "read_pdf",
    { path: "/credentials/x.pdf", pages: "1-3", dpi: 150, secret: "must-not-be-recorded" },
    imageResult(100, "image/png"),
    true,
  );

  it("records the arguments", () => {
    assert.deepEqual(log.args, { path: "/***/x.pdf", pages: "1-3", dpi: 150 });
  });

  it("**does not record arguments other than the allowed names**", () => {
    assert.ok(!JSON.stringify(log).includes("must-not-be-recorded"));
  });

  it("records the per-block detail", () => {
    assert.deepEqual(log.block_detail, [
      { type: "text", chars: 15 },
      { type: "image", mime: "image/png", chars: 100 },
    ]);
  });
});

describe("summarizeCall - edge cases", () => {
  it("does not fail when there is no response", () => {
    const log = summarizeCall("stat", {}, undefined, false);
    assert.equal(log.blocks, "(none)");
    assert.equal(log.content_chars, 0);
    assert.equal(log.is_error, false);
  });

  it("a tool failure shows in is_error", () => {
    const log = summarizeCall(
      "download_file",
      { path: "/a.pdf" },
      { content: [{ type: "text", text: "x" }], isError: true },
      false,
    );
    assert.equal(log.is_error, true);
  });

  it("counts an embedded resource too", () => {
    const log = summarizeCall(
      "download_file",
      { file_id: 1 },
      {
        content: [
          { type: "resource", resource: { uri: "pcloud://1", mimeType: "application/zip", blob: "B".repeat(40) } },
        ],
      },
      true,
    );
    assert.equal(log.blocks, "resource");
    assert.equal(log.content_chars, 40);
    assert.deepEqual(log.block_detail, [{ type: "resource", mime: "application/zip", chars: 40 }]);
  });
});
