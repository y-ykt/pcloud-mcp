// © 2026 Yasuhiko Yokote

/**
 * Tests for how `read_file` dispatches by format (`src/mcp/tools.ts`).
 *
 * They check **what is returned for each format** and **that nothing unsupported is fetched**.
 * The latter is central to the design ("do not transfer what is known not to get through")
 * and cannot be checked from the response alone. **The requests to pCloud themselves are counted.**
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { ToolResult } from "../src/mcp/protocol.ts";
import { callTool, contentNote, pdfProse, pdfTextFields, toolDefinitions } from "../src/mcp/tools.ts";
import { forgetAllowedFolders, knownFolder, rememberAllowedFolders, setForbiddenNames } from "../src/guard/path.ts";
import { PCloudClient } from "../src/pcloud/client.ts";
import { PDF_LIMITS } from "../src/pdf/render.ts";
import { parseRegion } from "../src/pdf/region.ts";
import { makeDocx, makeInkPdf, makePdf, makePng, makeTextPdf, makeWebp, makeWebpHeader, makeXlsx } from "./fixtures.ts";

const CONFIG = loadConfig({
  RESOURCE_URL: "https://x.example.com/mcp",
  COGNITO_ISSUER: "https://y.example.com",
  COGNITO_CLIENT_ID: "c",
  FORBIDDEN_NAMES: "credentials,Crypto Folder",
} as NodeJS.ProcessEnv);
// Loading does not put the names in force; the handler does that in the server. Here it is done by hand
setForbiddenNames(CONFIG.forbiddenNames);

interface Called {
  result: ToolResult;
  /** The methods called on pCloud (`stat` / `getfilelink` / `checksumfile` / `content`). */
  calls: string[];
}

/** Runs `read_file` once against a fake pCloud transport and records what was called. */
async function read(
  bytes: Uint8Array,
  meta: { name: string; contenttype?: string; isfolder?: boolean; size?: number },
  args: Record<string, unknown> = {},
): Promise<Called> {
  const calls: string[] = [];
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const impl = ((input: string | URL) => {
    const s = String(input);
    if (s.includes("p.pcloud.com")) {
      calls.push("content");
      return Promise.resolve(new Response(bytes));
    }
    const u = new URL(s);
    const method = u.pathname.slice(1);
    calls.push(method);
    const body =
      method === "stat"
        ? {
            result: 0,
            metadata: {
              fileid: 7,
              isfolder: meta.isfolder ?? false,
              size: meta.size ?? bytes.byteLength,
              ...meta,
            },
          }
        : method === "getfilelink"
          ? { result: 0, hosts: ["p.pcloud.com"], path: "/x", size: bytes.byteLength, expires: "" }
          : { result: 0, sha1 };
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as unknown as typeof fetch;

  const client = new PCloudClient({
    apiHost: "https://api.pcloud.com",
    accessToken: "t",
    fetchImpl: impl,
  });
  const result = await callTool(client, CONFIG, "read_file", { path: `/${meta.name}`, ...args });
  return { result, calls };
}

const kindOf = (r: ToolResult): unknown =>
  (r.structuredContent as Record<string, unknown> | undefined)?.["kind"];
const blocksOf = (r: ToolResult): string => r.content.map((b) => b.type).join(",");
const errorOf = (r: ToolResult): string =>
  String((JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>)["error"]);

// ---------------------------------------------------------------- number of tools

describe("tool list", () => {
  it("**is consolidated into three tools**", () => {
    assert.deepEqual(
      toolDefinitions(CONFIG).map((t) => t.name),
      ["list", "stat", "read_file"],
    );
  });

  it("read_file has all the arguments for every format", () => {
    const def = toolDefinitions(CONFIG).find((t) => t.name === "read_file")!;
    const props = Object.keys(
      (def.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    for (const a of ["path", "file_id", "as_text", "pages", "region", "dpi", "max_edge", "quality", "max_chars", "include_notes"]) {
      assert.ok(props.includes(a), `${a} is missing`);
    }
  });
});

// ---------------------------------------------------------------- dispatch by format

describe("read_file - dispatch by format", () => {
  it("returns the content of a text file", async () => {
    const { result } = await read(new TextEncoder().encode("# 見出し\nほんぶん"), {
      name: "note.md",
      contenttype: "text/markdown",
    });
    assert.equal(kindOf(result), "text");
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["content"], "# 見出し\nほんぶん");
    assert.equal(s["verified"], "Size and SHA-1 match pCloud");
  });

  it("**goes as far as fetching when it succeeds** (confirms that the recording works)", async () => {
    // Without this, the "not fetched" checks below could pass vacuously without anyone noticing
    const { calls } = await read(new TextEncoder().encode("body"), {
      name: "note.txt",
      contenttype: "text/plain",
    });
    assert.ok(calls.includes("stat"), "stat was not called");
    assert.ok(calls.includes("getfilelink"), "the download link was not looked up");
    assert.ok(calls.includes("content"), "the content was not fetched");
    assert.ok(calls.includes("checksumfile"), "the SHA-1 was not checked");
  });

  it("downscales an image and returns it as image", async () => {
    const { result } = await read(makePng(2000, 1000), {
      name: "a.png",
      contenttype: "image/png",
    });
    assert.equal(kindOf(result), "image");
    assert.equal(blocksOf(result), "text,image");
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["original_pixels"], "2000x1000");
    assert.equal(s["downscaled"], true);
  });

  it("**returns a WebP image as it is, labeled image/webp**", async () => {
    // A complete 1x1 lossless WebP. It cannot be decoded here, so it must not be re-encoded or relabeled
    const webp = Buffer.from(makeWebp());
    const { result } = await read(new Uint8Array(webp), { name: "a.webp", contenttype: "image/webp" });
    assert.equal(kindOf(result), "image");
    assert.equal(blocksOf(result), "text,image");
    const image = result.content[1] as { type: string; data: string; mimeType: string };
    assert.equal(image.mimeType, "image/webp");
    assert.equal(image.data, webp.toString("base64"));
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["original_pixels"], "1x1");
    assert.equal(s["downscaled"], false);
    assert.equal(s["returned_content_type"], "image/webp");
    assert.equal(s["max_edge_not_applied"], undefined);
  });

  it("**refuses a WebP that is too large before fetching anything**", async () => {
    // 500 KiB: under the general limit for images (1 MiB here), but a WebP cannot be made smaller
    const { result, calls } = await read(makeWebpHeader(640, 480), {
      name: "big.webp",
      contenttype: "image/webp",
      size: 500 * 1024,
    });
    assert.equal(result.isError, true);
    assert.match(errorOf(result), /This WebP image is too large to return \(512000 bytes \/ limit 65536 bytes\)/);
    assert.match(errorOf(result), /A WebP image cannot be downscaled by this connector/);
    assert.deepEqual(calls, ["stat"], "something was fetched for a file that is always refused");
  });

  it("a PNG of the same size is still fetched and downscaled", async () => {
    const { calls } = await read(makePng(2000, 1000), { name: "a.png", contenttype: "image/png", size: 500 * 1024 });
    assert.ok(calls.includes("getfilelink"));
  });

  it("**says so when max_edge could not be applied to a WebP**", async () => {
    const { result } = await read(makeWebpHeader(2000, 1500), { name: "a.webp", contenttype: "image/webp" }, { max_edge: 512 });
    assert.equal(kindOf(result), "image");
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /was not downscaled to the long edge of 512 px/);
    assert.match(text, /A WebP image cannot be downscaled by this connector/);
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["downscaled"], false);
    assert.equal(s["returned_pixels"], "2000x1500");
    assert.equal(s["max_edge_not_applied"], 512);
  });

  it("returns a Word document as Markdown", async () => {
    const { result } = await read(makeDocx(["first line", "second line"]), {
      name: "a.docx",
      contenttype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    assert.equal(kindOf(result), "office");
    assert.equal(blocksOf(result), "text,text");
    assert.match((result.content[1] as { text: string }).text, /first line/);
  });

  it("returns an Excel workbook as Markdown too", async () => {
    const { result } = await read(makeXlsx([["A", "B"], ["1", "2"]]), {
      name: "a.xlsx",
      contenttype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    assert.equal(kindOf(result), "office");
    assert.match((result.content[1] as { text: string }).text, /\| A \| B \|/);
  });

  it("**returns only the page count of a PDF when pages is omitted**", async () => {
    const { result } = await read(makePdf(5), { name: "a.pdf", contenttype: "application/pdf" });
    assert.equal(kindOf(result), "pdf_info");
    assert.equal(blocksOf(result), "text");
    assert.equal((result.structuredContent as Record<string, unknown>)["page_count"], 5);
  });

  it("returns images of a PDF when pages is given", async () => {
    const { result } = await read(makePdf(5), { name: "a.pdf", contenttype: "application/pdf" }, {
      pages: "1,3",
    });
    assert.equal(kindOf(result), "pdf_pages");
    // **Images come first.** With the notes first, the receiving side talked about the notes instead (measured)
    assert.equal(blocksOf(result), "image,image,text");
    assert.deepEqual(
      (result.structuredContent as Record<string, unknown>)["rendered_pages"],
      [1, 3],
    );
  });

  it("**returns a single image even when region is given**", async () => {
    const { result } = await read(makePdf(5), { name: "a.pdf", contenttype: "application/pdf" }, {
      pages: "2",
      region: "top-left",
    });
    assert.equal(blocksOf(result), "image,text");
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["region"], "top-left");
    assert.match(String(s["region_shows"]), /the top-left quarter/);
    assert.match(String(s["region_note"]), /call again with a different region/);
  });

  it("**states first what the response contains**", async () => {
    // When what cannot be done is listed first, the receiving side talks about that instead (measured)
    const { result } = await read(makePdf(1, 200, 100), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.match(String(s["shows"]), /Page 1, the whole page, is rendered as an image at \d+ dpi \(\d+x\d+ px/);
    assert.match(String(s["shows"]), /placed in the image block of this response/);
  });

  it("**always includes the rule about sources, whether or not rendering succeeded**", async () => {
    // If it is included only when the resolution was lowered, the caution becomes tied to "a sign of failure".
    // When it was removed, an answer came back that filled unreadable parts with the common format of drawings (measured)
    for (const args of [{ pages: "1" }, { pages: "1", region: "3x3:5" }]) {
      const { result } = await read(makeInkPdf([1 / 3, 1 / 3, 2 / 3, 2 / 3]), {
        name: "a.pdf",
        contenttype: "application/pdf",
      }, args);
      const rule = String((result.structuredContent as Record<string, unknown>)["reading_rule"]);
      assert.match(rule, /State only the text and symbols that can be read from the image/, JSON.stringify(args));
      assert.match(rule, /Do not fill in from the common format of drawings or stock phrases/, JSON.stringify(args));
    }
  });

  it("**the text block holds the visible text, not a copy of the JSON**", async () => {
    const { result } = await read(makeTextPdf([["ABC", 20, 40], ["XYZ", 20, 120]]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const text = (result.content[1] as { text: string }).text;
    assert.ok(!text.trimStart().startsWith("{"), "the whole JSON was put in");
    assert.match(text, /Text visible in this region/);
    assert.match(text, /ABC/);
    assert.match(text, /XYZ/);
    assert.match(text, /Use this list as the authority/);
    // Machine-readable values stay in structuredContent
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["has_text_layer"], true);
    assert.equal(s["text_lines"], 2);
  });

  it("**lists only the text visible in the region when the region is narrowed**", async () => {
    // The page is 200x200 pt. XYZ is near the top edge, ABC near the bottom edge
    const { result } = await read(makeTextPdf([["ABC", 20, 20], ["XYZ", 20, 180]]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", region: "top" });
    const text = (result.content[1] as { text: string }).text;
    assert.match(text, /XYZ/);
    assert.ok(!text.includes("ABC"), "text that is not visible was listed");
  });

  it("**says so when there is no text layer**", async () => {
    // If it were silently left empty, it would be mistaken for "a page with no text"
    const { result } = await read(makeInkPdf([0.4, 0.4, 0.6, 0.6]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const text = (result.content[1] as { text: string }).text;
    assert.match(text, /This PDF has no text layer/);
    assert.match(text, /Do not fill in from common formats or stock phrases/);
    assert.equal((result.structuredContent as Record<string, unknown>)["has_text_layer"], false);
  });

  it("**used_dpi is the value actually rendered**", async () => {
    // When pages held down by the long-edge limit were taken out of reduced, the requested value was still being reported
    const { result } = await read(makeInkPdf([0, 0, 1, 1], 595, 842), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", dpi: 150 });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["requested_dpi"], 150);
    assert.notEqual(s["used_dpi"], 150, "the requested value is reported although the resolution was held down");
    assert.match(String(s["shows"]), new RegExp(`${String(s["used_dpi"])} dpi`));
  });

  it("**renders the whole page when region is omitted, and adds no extra note**", async () => {
    const { result } = await read(makePdf(1), { name: "a.pdf", contenttype: "application/pdf" }, {
      pages: "1",
    });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["region"], "full");
    assert.equal(s["region_note"], undefined);
  });

  it("**raises the default resolution when region is given**", async () => {
    // The automatic adjustment only lowers the resolution, so with the usual default a narrowed region would leave the pixel budget unused
    const { result } = await read(makePdf(1), { name: "a.pdf", contenttype: "application/pdf" }, {
      pages: "1",
      region: "3x3:5",
    });
    assert.equal(
      (result.structuredContent as Record<string, unknown>)["requested_dpi"],
      PDF_LIMITS.defaultRegionDpi,
    );
  });

  it("**refuses without fetching when the form of region is wrong**", async () => {
    const { result, calls } = await read(makePdf(1), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", region: "upper left" });
    assert.equal(result.isError, true);
    assert.match(errorOf(result), /The form of region is wrong/);
    assert.deepEqual(calls, ["stat"], "the PDF was fetched although the form is wrong");
  });

  it("**adds where the content is when returning the whole page**", async () => {
    // A PDF with only the top-right 1/9 filled
    const { result } = await read(makeInkPdf([2 / 3, 0, 1, 1 / 3]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.deepEqual(s["content_at"], ["3x3:3"], "the location is wrong");
    assert.match(String(s["ink_note"]), /3x3:3/);
    assert.equal((s["ink_map"] as Record<string, number>)["3x3:3"], 1);
  });

  it("**says so and points to the content when a blank cell is requested**", async () => {
    // Without this, the receiving side mistakes it for "the resolution is too low"
    const { result } = await read(makeInkPdf([2 / 3, 0, 1, 1 / 3]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", region: "3x3:1" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["region_ink"], 0);
    assert.match(String(s["blank_note"]), /Almost nothing is drawn in this cell/);
    assert.match(String(s["blank_note"]), /3x3:3/, "the location of the content is not given");
    assert.match(String(s["blank_note"]), /The resolution is not the reason it cannot be read/);
  });

  it("adds no blank note to a cell that has content", async () => {
    const { result } = await read(makeInkPdf([2 / 3, 0, 1, 1 / 3]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", region: "3x3:3" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["region_ink"], 1);
    assert.equal(s["blank_note"], undefined);
  });

  it("**omits the content location when returning two or more pages**", async () => {
    // The distribution of a single page must not be presented as if it described all of them
    const { result } = await read(makePdf(5), { name: "a.pdf", contenttype: "application/pdf" }, {
      pages: "1,3",
    });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["ink_map"], undefined);
    assert.equal(s["content_at"], undefined);
  });

  it("**keeps a resolution held by the long edge separate from the note about the size budget**", async () => {
    const { result } = await read(makeInkPdf([0, 0, 1, 1], 595, 842), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.deepEqual(s["edge_capped_pages"], [1]);
    assert.match(String(s["edge_capped_note"]), /narrow the area with region/);
    assert.equal(s["reduced_pages"], undefined, "pages with a different reason were mixed in");
  });

  it("**dispatches by extension even when `contenttype` is unreliable**", async () => {
    const { result } = await read(makeDocx(["body"]), {
      name: "a.docx",
      contenttype: "application/octet-stream",
    });
    assert.equal(kindOf(result), "office");
  });
});

// ---------------------------------------------------------------- refusals

describe("read_file - what it cannot handle", () => {
  it("cannot read a folder", async () => {
    const { result, calls } = await read(new Uint8Array(0), { name: "d", isfolder: true });
    assert.equal(result.isError, true);
    assert.deepEqual(calls, ["stat"], "a fetch was attempted for a folder");
  });

  it("**refuses old Office formats without fetching**", async () => {
    const { result, calls } = await read(new Uint8Array([1, 2, 3]), {
      name: "a.doc",
      contenttype: "application/msword",
    });
    assert.equal(result.isError, true);
    assert.match(errorOf(result), /Office formats from before 2007/);
    assert.deepEqual(calls, ["stat"], "a refused format was fetched");
  });

  it("**refuses formats it cannot provide without fetching**", async () => {
    const { result, calls } = await read(new Uint8Array([1, 2, 3]), {
      name: "a.mp3",
      contenttype: "audio/mpeg",
    });
    assert.equal(result.isError, true);
    assert.match(errorOf(result), /The content of this format cannot be provided/);
    assert.match(errorOf(result), /as_text/, "the alternative is not mentioned");
    assert.deepEqual(calls, ["stat"], "a refused format was fetched");
  });

  it("**also refuses image formats the receiving side cannot read, without fetching**", async () => {
    const { result, calls } = await read(new Uint8Array([1, 2, 3]), {
      name: "a.heic",
      contenttype: "image/heic",
    });
    assert.equal(result.isError, true);
    assert.match(errorOf(result), /JPEG, PNG, GIF and WebP/);
    assert.deepEqual(calls, ["stat"]);
  });

  it("refuses an image that is too large without fetching", async () => {
    const { result, calls } = await read(makePng(4, 4), {
      name: "a.png",
      contenttype: "image/png",
      size: 99_000_000,
    });
    assert.equal(result.isError, true);
    assert.match(errorOf(result), /The file exceeds the limit/);
    assert.deepEqual(calls, ["stat"]);
  });

  it("**does not return embedded resources**", async () => {
    // Confirms that a format known not to get through is not sent
    const { result } = await read(new Uint8Array([1, 2, 3]), {
      name: "a.zip",
      contenttype: "application/zip",
    });
    assert.ok(!blocksOf(result).includes("resource"));
  });
});

// ---------------------------------------------------------------- as_text

describe("read_file - as_text", () => {
  it("**can read a file as text even without an extension**", async () => {
    const { result } = await read(new TextEncoder().encode("拡張子なしの本文"), {
      name: "data",
      contenttype: "application/octet-stream",
    });
    assert.equal(result.isError, true, "it should refuse unless as_text is given");

    const forced = await read(new TextEncoder().encode("拡張子なしの本文"), {
      name: "data",
      contenttype: "application/octet-stream",
    }, { as_text: true });
    assert.equal(kindOf(forced.result), "text");
    assert.equal(
      (forced.result.structuredContent as Record<string, unknown>)["content"],
      "拡張子なしの本文",
    );
  });

  it("does not return as text what cannot be decoded", async () => {
    // A byte sequence that is valid neither as UTF-8 nor as any of the candidate encodings
    const bad = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x81, 0xff, 0xff]);
    const { result } = await read(bad, { name: "x.bin" }, { as_text: true });
    // It starts with what looks like a BOM, so decoding itself may succeed. Only checks **that no broken characters are returned**
    if (result.isError !== true) {
      const s = result.structuredContent as Record<string, unknown>;
      assert.equal(typeof s["content"], "string");
    }
  });
});

describe("read_file - wording for PDFs", () => {
  it("**does not call a page with text \"almost blank\"**", async () => {
    // Ink is measured at 36 dpi, so a page with only text measures as faint
    const { result } = await read(makeTextPdf([["ABC", 20, 40]]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const text = (result.content[1] as { text: string }).text;
    assert.ok(!text.includes("almost blank"), "it is called blank although it has text");
    assert.match(text, /ABC/);
    // The machine-readable part must agree with the sentence
    const s = result.structuredContent as Record<string, unknown>;
    assert.ok(!String(s["ink_note"] ?? "").includes("almost blank"), "ink_note calls it blank");
    assert.deepEqual(s["content_at"], []);
  });

  it("**says nothing about blankness when several pages are returned**", async () => {
    // The statement is about one page, and nothing was measured per page here, so it must not appear at all
    const { result } = await read(makePdf(2), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1-2" });
    // With several pages the blocks are ordered differently, so look at every text block
    const text = result.content
      .map((c) => (c as { text?: string }).text ?? "")
      .join("\n");
    assert.match(text, /Pages 1, 2 are rendered/);
    assert.ok(!text.includes("almost blank"), "a statement about one page appears for several pages");
    assert.ok(!text.includes("This page"), "a statement about one page appears for several pages");
  });

  it("a page with nothing on it is still called almost blank, in both parts", async () => {
    const { result } = await read(makePdf(1), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1" });
    const text = (result.content[1] as { text: string }).text;
    assert.match(text, /This page is almost blank\./);
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["ink_note"], "This page is almost blank.");
  });
});

describe("pdfProse - when the text could not be extracted", () => {
  const prose = (failed: boolean) =>
    pdfProse(
      { shows: "Page 1 is rendered." },
      { text: { hasTextLayer: false, failed, lines: [], chars: 0, truncated: false, totalLines: 0 } },
      parseRegion("full"),
      true,
      undefined,
      "Verified.",
    );

  it("**says that extraction failed, not that the PDF has no text layer**", () => {
    const text = prose(true);
    assert.match(text, /\[Text\] The text of this page could not be extracted/);
    assert.match(text, /Whether the page has a text layer is not known/);
    assert.match(text, /Do not fill in from common formats or stock phrases/);
    assert.doesNotMatch(text, /has no text layer/);
    assert.doesNotMatch(text, /almost blank/, "a page whose text is unknown must not be called blank");
  });

  it("**the machine-readable part does not claim \"no text layer\" either**", () => {
    const failed = pdfTextFields({ hasTextLayer: false, failed: true, lines: [], chars: 0, truncated: false, totalLines: 0 });
    // Nothing but the failure: a line count of 0 would be read as "a page without text"
    assert.deepEqual(failed, { text_extraction_failed: true });
    const scanned = pdfTextFields({ hasTextLayer: false, failed: false, lines: [], chars: 0, truncated: false, totalLines: 0 });
    assert.equal(scanned["has_text_layer"], false);
    assert.ok(!("text_extraction_failed" in scanned));
  });

  it("a page without a text layer keeps the earlier wording", () => {
    const text = prose(false);
    assert.match(text, /This PDF has no text layer/);
    assert.doesNotMatch(text, /could not be extracted/);
  });
});

// ---------------------------------------------------------------- reaching a file or folder by ID

/**
 * A fake pCloud that answers `stat` and `listfolder` by ID.
 * `file` is the metadata `stat` returns; `folders` maps a folder ID to the metadata `listfolder` returns.
 */
function byId(file: Record<string, unknown>, folders: Record<number, Record<string, unknown>> = {}) {
  // Each fake pCloud is a different tree: what was learned about another one must not carry over
  forgetAllowedFolders();
  const calls: string[] = [];
  /** The query string of every listfolder call, to see how the folders were asked for. */
  const listQueries: URLSearchParams[] = [];
  const bytes = new TextEncoder().encode("hello");
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const impl = ((input: string | URL) => {
    const s = String(input);
    if (s.includes("p.pcloud.com")) {
      calls.push("content");
      return Promise.resolve(new Response(bytes));
    }
    const u = new URL(s);
    const method = u.pathname.slice(1);
    calls.push(method);
    if (method === "listfolder") listQueries.push(u.searchParams);
    const body =
      method === "stat"
        ? { result: 0, metadata: { fileid: 7, isfolder: false, size: bytes.byteLength, contenttype: "text/plain", ...file } }
        : method === "listfolder"
          ? folders[Number(u.searchParams.get("folderid"))] === undefined
            ? { result: 2005, error: "Directory does not exist." }
            : { result: 0, metadata: { isfolder: true, contents: [], ...folders[Number(u.searchParams.get("folderid"))] } }
          : method === "getfilelink"
            ? { result: 0, hosts: ["p.pcloud.com"], path: "/x", size: bytes.byteLength, expires: "" }
            : { result: 0, sha1 };
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as unknown as typeof fetch;
  const client = new PCloudClient({ apiHost: "https://api.pcloud.com", accessToken: "t", fetchImpl: impl });
  const run = (tool: string, args: Record<string, unknown>) => callTool(client, CONFIG, tool, args);
  return { calls, listQueries, run };
}

/** As {@link byId}, but what was learned about the folders so far is kept: the same tree, seen again. */
function byIdKeeping(file: Record<string, unknown>, folders: Record<number, Record<string, unknown>>) {
  const kept = [5, 6, 9, 10, 11, 12].map((id) => [id, knownFolder(id)] as const);
  const fake = byId(file, folders);
  for (const [id, known] of kept) {
    if (known !== undefined) rememberAllowedFolders([{ id, path: known.path }], known.until);
  }
  return fake;
}

const reasonOf = (r: ToolResult): unknown =>
  (JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>)["reason"];

describe("**an ID does not get around the forbidden folders**", () => {
  for (const tool of ["read_file", "stat"]) {
    it(`${tool}: a file under a forbidden folder is refused, as it is by path`, async () => {
      const p = byId({ name: "x.txt", path: "/credentials/x.txt" });
      const r = await p.run(tool, { file_id: 7 });
      assert.equal(r.isError, true);
      assert.equal(reasonOf(r), "forbidden-name");
      assert.ok(!p.calls.includes("getfilelink"), "the content was requested");
      assert.ok(!JSON.stringify(r).includes("x.txt"), "the name of the file is disclosed");
    });

    it(`${tool}: when pCloud returns no path, the folder that holds the file is checked`, async () => {
      const p = byId({ name: "x.txt", parentfolderid: 5 }, { 5: { name: "Crypto Folder", folderid: 5, path: "/a/Crypto Folder" } });
      const r = await p.run(tool, { file_id: 7 });
      assert.equal(r.isError, true);
      assert.equal(reasonOf(r), "forbidden-name");
      assert.ok(!p.calls.includes("getfilelink"), "the content was requested");
    });

    it(`${tool}: a file that itself has a forbidden name is refused`, async () => {
      const r = await byId({ name: "credentials", parentfolderid: 0 }).run(tool, { file_id: 7 });
      assert.equal(reasonOf(r), "forbidden-name");
    });

    it(`${tool}: **refused when where the file is cannot be determined**`, async () => {
      // No path on the file, and none on its folder either
      const p = byId({ name: "x.txt", parentfolderid: 5 }, { 5: { name: "a", folderid: 5 } });
      const r = await p.run(tool, { file_id: 7 });
      assert.equal(r.isError, true);
      assert.equal(reasonOf(r), "location-unknown");
      assert.ok(!p.calls.includes("getfilelink"), "the content was requested");
    });

    it(`${tool}: a file elsewhere is still reached by ID`, async () => {
      const withPath = byId({ name: "x.txt", path: "/My Documents/x.txt" });
      assert.notEqual((await withPath.run(tool, { file_id: 7 })).isError, true);
      assert.ok(!withPath.calls.includes("listfolder"), "an extra call was made although the path was known");

      const viaFolder = byId({ name: "x.txt", parentfolderid: 5 }, { 5: { name: "My Documents", folderid: 5, path: "/My Documents" } });
      assert.notEqual((await viaFolder.run(tool, { file_id: 7 })).isError, true);

      const inRoot = byId({ name: "x.txt", parentfolderid: 0 });
      assert.notEqual((await inRoot.run(tool, { file_id: 7 })).isError, true);
    });
  }

  it("list: a forbidden folder is refused when given by folder_id", async () => {
    const p = byId({}, { 9: { name: "credentials", folderid: 9, path: "/credentials", contents: [{ name: "secret.key", isfolder: false, fileid: 1 }] } });
    const r = await p.run("list", { folder_id: 9 });
    assert.equal(r.isError, true);
    assert.equal(reasonOf(r), "forbidden-name");
    assert.ok(!JSON.stringify(r).includes("secret.key"), "the content of the folder is disclosed");
  });

  it("list: refused when the folder has no path and a forbidden name", async () => {
    const r = await byId({}, { 9: { name: "Crypto Folder", folderid: 9, parentfolderid: 0 } }).run("list", { folder_id: 9 });
    assert.equal(reasonOf(r), "forbidden-name");
  });

  it("list: a folder elsewhere is still listed by folder_id", async () => {
    const p = byId({}, { 9: { name: "ok", folderid: 9, path: "/ok", contents: [{ name: "a.txt", isfolder: false, fileid: 1, size: 1 }] } });
    const r = await p.run("list", { folder_id: 9 });
    assert.notEqual(r.isError, true);
    assert.ok(JSON.stringify(r).includes("a.txt"));
  });
});

describe("contentNote - the one sentence about where the content is", () => {
  const page = (over: Partial<{ failed: boolean; totalLines: number }>) => ({
    text: { hasTextLayer: false, failed: false, lines: [], chars: 0, truncated: false, totalLines: 0, ...over },
  });

  it("says where the ink is when there is some", () => {
    assert.equal(contentNote(page({}), ["3x3:3"]), "The content is concentrated in 3x3:3.");
  });

  it("calls a page blank only when it has neither ink nor text", () => {
    assert.equal(contentNote(page({}), []), "This page is almost blank.");
    assert.equal(contentNote(page({ totalLines: 3 }), []), undefined);
  });

  it("**says nothing when the text could not be extracted**", () => {
    assert.equal(contentNote(page({ failed: true }), []), undefined);
  });

  it("says nothing when several pages are returned", () => {
    assert.equal(contentNote(undefined, []), undefined);
  });
});

describe("read_file - a region of a PDF page", () => {
  it("**does not call a region with text \"almost nothing drawn\"**", async () => {
    // Text only: the ink measured at 36 dpi is faint, yet the region has a line of text
    const { result } = await read(makeTextPdf([["ABC", 20, 180]]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", region: "top-left" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["text_lines"], 1);
    assert.equal(s["blank_note"], undefined, "the region is called blank although text was read from it");
    assert.match((result.content[1] as { text: string }).text, /ABC/);
  });

  it("a region without ink and without text is still called blank", async () => {
    const { result } = await read(makeTextPdf([["ABC", 20, 180]]), {
      name: "a.pdf",
      contenttype: "application/pdf",
    }, { pages: "1", region: "bottom-right" });
    const s = result.structuredContent as Record<string, unknown>;
    assert.equal(s["text_lines"], 0);
    assert.match(String(s["blank_note"]), /Almost nothing is drawn in this cell/);
  });
});

describe("the forbidden names come from the configuration", () => {
  const folder = {
    9: {
      name: "top", folderid: 9, path: "/top",
      contents: [
        { name: "credentials", isfolder: true, folderid: 10 },
        { name: "notes.txt", isfolder: false, fileid: 1, size: 1 },
      ],
    },
  };
  const namesIn = (r: ToolResult) =>
    ((r.structuredContent as { entries: { name: string }[] }).entries ?? []).map((e) => e.name);

  it("a listed name is left out of a listing, and the listing says so", async () => {
    const r = await byId({}, folder).run("list", { folder_id: 9 });
    assert.deepEqual(namesIn(r), ["notes.txt"]);
    assert.deepEqual((r.structuredContent as { excluded: { name: string }[] }).excluded.map((e) => e.name), ["credentials"]);
  });

  it("**with no name listed, nothing is refused or left out**", async () => {
    setForbiddenNames([]);
    try {
      const listed = await byId({}, folder).run("list", { folder_id: 9 });
      assert.deepEqual(namesIn(listed), ["credentials", "notes.txt"]);

      for (const tool of ["read_file", "stat"]) {
        const byPath = byId({ name: "x.txt" });
        assert.notEqual((await byPath.run(tool, { path: "/credentials/x.txt" })).isError, true, tool);
        const byFileId = byId({ name: "x.txt", path: "/Crypto Folder/x.txt" });
        assert.notEqual((await byFileId.run(tool, { file_id: 7 })).isError, true, tool);
      }
    } finally {
      setForbiddenNames(["credentials", "Crypto Folder"]);
    }
  });
});

describe("reaching an entry by ID - what pCloud returns does not decide whether it works", () => {
  it("**the root folder is listed by folder_id 0, even when pCloud returns no path for it**", async () => {
    // The root has no parent, and here no path either
    const p = byId({}, { 0: { name: "/", folderid: 0, contents: [{ name: "a.txt", isfolder: false, fileid: 1, size: 1 }] } });
    const r = await p.run("list", { folder_id: 0 });
    assert.notEqual(r.isError, true);
    assert.ok(JSON.stringify(r).includes("a.txt"));
  });

  it("**without a path, the folders above the entry are checked by name, up to the root**", async () => {
    const folders = {
      5: { name: "a", folderid: 5, parentfolderid: 6 },
      6: { name: "Credentials", folderid: 6, parentfolderid: 0 },
    };
    for (const tool of ["read_file", "stat"]) {
      const p = byId({ name: "x.txt", parentfolderid: 5 }, folders);
      const r = await p.run(tool, { file_id: 7 });
      assert.equal(reasonOf(r), "forbidden-name", tool);
      assert.ok(!p.calls.includes("getfilelink"), "the content was requested");
    }
  });

  it("without a path, an entry whose folders are all allowed is reached", async () => {
    const folders = {
      5: { name: "a", folderid: 5, parentfolderid: 6 },
      6: { name: "b", folderid: 6, parentfolderid: 0 },
    };
    for (const tool of ["read_file", "stat"]) {
      const p = byId({ name: "x.txt", parentfolderid: 5 }, folders);
      assert.notEqual((await p.run(tool, { file_id: 7 })).isError, true, tool);
      assert.equal(p.calls.filter((c) => c === "listfolder").length, 2, "one call per folder above the entry");
    }
  });

  it("a chain of folders that never reaches the root is refused", async () => {
    // Each folder names the other as its parent
    const folders = {
      5: { name: "a", folderid: 5, parentfolderid: 6 },
      6: { name: "b", folderid: 6, parentfolderid: 5 },
    };
    const r = await byId({ name: "x.txt", parentfolderid: 5 }, folders).run("stat", { file_id: 7 });
    assert.equal(reasonOf(r), "location-unknown");
  });

  it("**with no name listed, nothing is refused: the folders are asked about only to find the path**", async () => {
    setForbiddenNames([]);
    try {
      for (const tool of ["read_file", "stat"]) {
        // No path, and a parent that pCloud does not describe: with a list this would be refused.
        // Here the entry is returned all the same, without a path
        const p = byId({ name: "x.txt", parentfolderid: 5 });
        const r = await p.run(tool, { file_id: 7 });
        assert.notEqual(r.isError, true, tool);
        assert.ok(!("path" in (r.structuredContent as Record<string, unknown>)), tool);
        // One attempt to describe the folder above, and no more
        assert.equal(p.calls.filter((c) => c === "listfolder").length, 1, tool);
      }
      // A listing by ID asks for the folder once, and learns about it from that same answer
      const listed = byId({}, { 9: { name: "top", folderid: 9, parentfolderid: 0, contents: [] } });
      const r = await listed.run("list", { folder_id: 9 });
      assert.notEqual(r.isError, true);
      assert.equal((r.structuredContent as { path?: string }).path, "/top");
      assert.equal(listed.calls.filter((c) => c === "listfolder").length, 1);
    } finally {
      setForbiddenNames(["credentials", "Crypto Folder"]);
    }
  });
});

describe("list by folder_id - **the paths in the answer are the real ones, or absent**", () => {
  type Listed = { path?: string; folder_id?: number; note?: string; entries: Record<string, unknown>[] };
  const listed = (r: ToolResult) => r.structuredContent as Listed;
  const file = (name: string, fileid: number) => ({ name, isfolder: false, fileid, size: 1 });

  it("uses the path pCloud returns for the folder", async () => {
    const p = byId({}, { 9: { name: "deep", folderid: 9, path: "/top/deep", contents: [file("a.txt", 1)] } });
    const r = listed(await p.run("list", { folder_id: 9 }));
    assert.equal(r.path, "/top/deep");
    assert.deepEqual(r.entries.map((e) => e["path"]), ["/top/deep/a.txt"]);
  });

  it("the root is / even when pCloud returns no path for it", async () => {
    const p = byId({}, { 0: { name: "/", folderid: 0, contents: [file("a.txt", 1)] } });
    const r = listed(await p.run("list", { folder_id: 0 }));
    assert.equal(r.path, "/");
    assert.deepEqual(r.entries.map((e) => e["path"]), ["/a.txt"]);
  });

  it("**when the location is not known, no path is invented**", async () => {
    setForbiddenNames([]);
    try {
      // A folder somewhere below the root, for which pCloud returns no path
      const folders = {
        9: { name: "deep", folderid: 9, parentfolderid: 4, contents: [file("a.txt", 1), { name: "sub", isfolder: true, folderid: 10 }] },
        10: { name: "sub", folderid: 10, parentfolderid: 9, contents: [file("b.txt", 2)] },
      };
      const r = listed(await byId({}, folders).run("list", { folder_id: 9, recursive: true }));
      assert.equal(r.path, undefined, "a path was given for a folder whose location is not known");
      assert.equal(r.folder_id, 9);
      assert.deepEqual(r.entries.map((e) => e["name"]), ["a.txt", "sub", "b.txt"]);
      for (const e of r.entries) {
        assert.ok(!("path" in e), `a path was invented for ${String(e["name"])}: ${String(e["path"])}`);
      }
      // The entries can still be reached, by their IDs
      assert.deepEqual(r.entries.map((e) => e["file_id"] ?? e["folder_id"]), [1, 10, 2]);
      assert.match(String(r.note), /file_id/);
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("**both notes are kept when the listing is also cut off**", async () => {
    setForbiddenNames([]);
    try {
      const folders = { 9: { name: "deep", folderid: 9, parentfolderid: 4, contents: [file("a.txt", 1), file("b.txt", 2)] } };
      const r = listed(await byId({}, folders).run("list", { folder_id: 9, max_entries: 1 }));
      assert.equal(r.entries.length, 1);
      assert.match(String(r.note), /The location of this folder is not known/);
      assert.match(String(r.note), /the limit on the number of entries \(1\) was reached/);
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("a subfolder for which pCloud does return a path gives its entries that path", async () => {
    setForbiddenNames([]);
    try {
      const folders = {
        9: { name: "deep", folderid: 9, parentfolderid: 4, contents: [{ name: "sub", isfolder: true, folderid: 10 }] },
        10: { name: "sub", folderid: 10, path: "/top/deep/sub", contents: [file("b.txt", 2)] },
      };
      const r = listed(await byId({}, folders).run("list", { folder_id: 9, recursive: true }));
      const byName = Object.fromEntries(r.entries.map((e) => [String(e["name"]), e["path"]]));
      assert.equal(byName["sub"], undefined);
      assert.equal(byName["b.txt"], "/top/deep/sub/b.txt");
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("listing by path is unchanged", async () => {
    // The fake answers listfolder by ID only, so the path is given as the ID of the root here
    const p = byId({}, { 0: { name: "/", folderid: 0, path: "/", contents: [file("a.txt", 1)] } });
    const r = listed(await p.run("list", { folder_id: 0 }));
    assert.equal(r.note, undefined);
  });

  it("stat by file_id does not present the name as a path", async () => {
    setForbiddenNames([]);
    try {
      const noPath = (await byId({ name: "x.txt", parentfolderid: 5 }).run("stat", { file_id: 7 })).structuredContent as Record<string, unknown>;
      assert.ok(!("path" in noPath), `a path was invented: ${String(noPath["path"])}`);
      assert.equal(noPath["file_id"], 7);
      const withPath = (await byId({ name: "x.txt", path: "/a/x.txt" }).run("stat", { file_id: 7 })).structuredContent as Record<string, unknown>;
      assert.equal(withPath["path"], "/a/x.txt");
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });
});

describe("reaching an entry by ID - the folders above it are not asked for again and again", () => {
  const folders = {
    5: { name: "a", folderid: 5, parentfolderid: 6 },
    6: { name: "b", folderid: 6, parentfolderid: 0 },
  };
  const listCalls = (p: { calls: string[] }) => p.calls.filter((c) => c === "listfolder").length;

  it("**a folder found to be allowed is remembered**", async () => {
    const p = byId({ name: "x.txt", parentfolderid: 5 }, folders);
    assert.notEqual((await p.run("stat", { file_id: 7 })).isError, true);
    assert.equal(listCalls(p), 2);
    // The same file again, then its content: nothing more is asked about the folders
    assert.notEqual((await p.run("stat", { file_id: 7 })).isError, true);
    assert.notEqual((await p.run("read_file", { file_id: 7 })).isError, true);
    assert.equal(listCalls(p), 2);
  });

  it("**a refusal is not remembered as an allowance**", async () => {
    const closed = { 5: { name: "a", folderid: 5, parentfolderid: 6 }, 6: { name: "credentials", folderid: 6, parentfolderid: 0 } };
    const p = byId({ name: "x.txt", parentfolderid: 5 }, closed);
    assert.equal(reasonOf(await p.run("stat", { file_id: 7 })), "forbidden-name");
    assert.equal(reasonOf(await p.run("stat", { file_id: 7 })), "forbidden-name");
  });

  it("**changing the forbidden names forgets what was remembered**", async () => {
    const p = byId({ name: "x.txt", parentfolderid: 5 }, folders);
    assert.notEqual((await p.run("stat", { file_id: 7 })).isError, true);
    setForbiddenNames(["b"]);
    try {
      assert.equal(reasonOf(await p.run("stat", { file_id: 7 })), "forbidden-name");
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("the folders above are asked for without their files", async () => {
    const p = byId({ name: "x.txt", parentfolderid: 5 }, folders);
    await p.run("stat", { file_id: 7 });
    assert.deepEqual(p.listQueries.map((q) => q.get("nofiles")), ["1", "1"]);
    // An ordinary listing still asks for the files: the last call is the listing itself
    const l = byId({}, { 9: { name: "ok", folderid: 9, path: "/ok", contents: [] } });
    await l.run("list", { folder_id: 9 });
    assert.equal(l.listQueries.at(-1)?.get("nofiles"), null);
  });

  it("**a forbidden folder given by folder_id is refused before its content is asked for**", async () => {
    const p = byId({}, { 9: { name: "credentials", folderid: 9, path: "/credentials", contents: [{ name: "secret.key", isfolder: false, fileid: 1 }] } });
    assert.equal(reasonOf(await p.run("list", { folder_id: 9 })), "forbidden-name");
    // Every call asked for the folder without its files: the files never left pCloud
    assert.ok(p.listQueries.length >= 1);
    assert.deepEqual([...new Set(p.listQueries.map((q) => q.get("nofiles")))], ["1"]);
  });

  it("**a folder that passed because of a remembered one is asked about again when that one runs out**", async (t) => {
    let clock = 1_000_000;
    t.mock.method(Date, "now", () => clock);
    // /b/a holds x.txt; /b/a/c holds y.txt
    const tree = {
      5: { name: "a", folderid: 5, parentfolderid: 6 },
      6: { name: "b", folderid: 6, parentfolderid: 0 },
      9: { name: "c", folderid: 9, parentfolderid: 5 },
    };
    const p = byId({ name: "x.txt", parentfolderid: 5 }, tree);
    await p.run("stat", { file_id: 7 }); // asks about 5 and 6; both good for 5 minutes from now
    assert.equal(listCalls(p), 2);

    // 4 minutes 50 seconds later, a file in c: c is asked about, and passes because a is remembered
    clock += 4 * 60_000 + 50_000;
    const q = byIdKeeping({ name: "y.txt", parentfolderid: 9 }, tree);
    await q.run("stat", { file_id: 7 });
    assert.equal(listCalls(q), 1);

    // 20 seconds later the first finding has run out. c rested on it, so c is asked about again
    clock += 20_000;
    await q.run("stat", { file_id: 7 });
    assert.ok(listCalls(q) > 1, "c was still treated as allowed after the finding it rested on had run out");
  });

  it("**the walk up the folders stops when it takes too long**", async (t) => {
    // Every call to pCloud takes 6 seconds on this clock; the walk may take 10
    let clock = 1_000_000;
    t.mock.method(Date, "now", () => clock);
    const deep: Record<number, Record<string, unknown>> = {};
    for (let id = 10; id < 30; id++) deep[id] = { name: `d${id}`, folderid: id, parentfolderid: id + 1 };
    deep[30] = { name: "top", folderid: 30, parentfolderid: 0 };
    const p = byId({ name: "x.txt", parentfolderid: 10 }, deep);
    const slow = p.calls;
    // Advance the clock on every call recorded by the fake
    const push = slow.push.bind(slow);
    slow.push = (...items: string[]) => {
      clock += 6_000;
      return push(...items);
    };
    const r = await p.run("stat", { file_id: 7 });
    assert.equal(reasonOf(r), "location-unknown");
    assert.match(errorOf(r), /took too long/);
    assert.ok(listCalls(p) <= 3, `the walk went on for ${listCalls(p)} folders`);
  });
});

describe("read_file by file_id - **the name alone is never given as the path**", () => {
  const structured = (r: ToolResult) => r.structuredContent as Record<string, unknown>;
  const errorBody = (r: ToolResult) => JSON.parse((r.content[0] as { text: string }).text) as Record<string, unknown>;

  it("text: no path when the location is not known, the ID always", async () => {
    setForbiddenNames([]);
    try {
      const s = structured(await byId({ name: "report.txt", parentfolderid: 5 }).run("read_file", { file_id: 7 }));
      assert.equal(s["kind"], "text");
      assert.ok(!("path" in s), `a path was invented: ${String(s["path"])}`);
      assert.equal(s["file_id"], 7);
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("text: the path pCloud returns is used", async () => {
    const s = structured(await byId({ name: "report.txt", path: "/Docs/2024/report.txt" }).run("read_file", { file_id: 7 }));
    assert.equal(s["path"], "/Docs/2024/report.txt");
    assert.equal(s["file_id"], 7);
  });

  it("an image: no path when the location is not known", async () => {
    setForbiddenNames([]);
    try {
      const png = makePng(10, 10);
      // The fake serves "hello" as content, so the size is made to match and the result is a refusal;
      // what matters here is what identifies the file in the answer
      const r = await byId({ name: "a.bmp", contenttype: "image/bmp", parentfolderid: 5, size: png.byteLength }).run("read_file", { file_id: 7 });
      assert.equal(r.isError, true);
      const body = errorBody(r);
      assert.ok(!("path" in body), `a path was invented: ${String(body["path"])}`);
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("a refusal carries the ID, not a path made from the name", async () => {
    setForbiddenNames([]);
    try {
      const folder = errorBody(await byId({ name: "docs", isfolder: true, folderid: 7, parentfolderid: 5 }).run("read_file", { file_id: 7 }));
      assert.match(String(folder["error"]), /A folder cannot be read/);
      assert.ok(!("path" in folder), `a path was invented: ${String(folder["path"])}`);

      const legacy = errorBody(await byId({ name: "old.doc", contenttype: "application/msword", parentfolderid: 5 }).run("read_file", { file_id: 7 }));
      assert.ok(!("path" in legacy), `a path was invented: ${String(legacy["path"])}`);
      assert.equal(legacy["file_id"], 7);
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("by path the answers are unchanged", async () => {
    const s = structured(await byId({ name: "report.txt" }).run("read_file", { path: "/Docs/report.txt" }));
    assert.equal(s["path"], "/Docs/report.txt");
  });
});

describe("reaching an entry by ID - **the answer carries its real path**", () => {
  // pCloud returns no path when an entry is asked for by ID (measured against the real service).
  // The path is put together from the names of the folders above the entry
  const tree = {
    5: { name: "a", folderid: 5, parentfolderid: 6, contents: [{ name: "x.txt", isfolder: false, fileid: 7, size: 5 }, { name: "sub", isfolder: true, folderid: 9 }] },
    6: { name: "b", folderid: 6, parentfolderid: 0 },
    9: { name: "sub", folderid: 9, parentfolderid: 5, contents: [{ name: "y.txt", isfolder: false, fileid: 8, size: 5 }] },
  };
  const structured = (r: ToolResult) => r.structuredContent as Record<string, unknown>;
  const listCalls = (p: { calls: string[] }) => p.calls.filter((c) => c === "listfolder").length;

  for (const names of [[], ["credentials", "Crypto Folder"]]) {
    const label = names.length === 0 ? "with no name forbidden" : "with names forbidden";

    it(`stat and read_file by file_id give the path (${label})`, async () => {
      setForbiddenNames(names);
      try {
        const p = byId({ name: "x.txt", parentfolderid: 5 }, tree);
        assert.equal(structured(await p.run("stat", { file_id: 7 }))["path"], "/b/a/x.txt");
        assert.equal(listCalls(p), 2, "one call per folder above the entry");
        // The folders are remembered: the content is read without asking about them again
        const read = structured(await p.run("read_file", { file_id: 7 }));
        assert.equal(read["path"], "/b/a/x.txt");
        assert.equal(read["file_id"], 7);
        assert.equal(listCalls(p), 2);
      } finally {
        setForbiddenNames(CONFIG.forbiddenNames);
      }
    });

    it(`list by folder_id gives the path of the folder and of its entries (${label})`, async () => {
      setForbiddenNames(names);
      try {
        const r = structured(await byId({}, tree).run("list", { folder_id: 5, recursive: true })) as {
          path?: string; note?: string; entries: Record<string, unknown>[];
        };
        assert.equal(r.path, "/b/a");
        assert.equal(r.note, undefined);
        assert.deepEqual(r.entries.map((e) => e["path"]), ["/b/a/x.txt", "/b/a/sub", "/b/a/sub/y.txt"]);
      } finally {
        setForbiddenNames(CONFIG.forbiddenNames);
      }
    });
  }

  it("**a path that cannot be put together is left out, and the entry is still returned** (no name forbidden)", async () => {
    setForbiddenNames([]);
    try {
      // The folder above is not described by pCloud at all
      const s = structured(await byId({ name: "x.txt", parentfolderid: 77 }).run("stat", { file_id: 7 }));
      assert.ok(!("path" in s), `a path was invented: ${String(s["path"])}`);
      assert.equal(s["file_id"], 7);
    } finally {
      setForbiddenNames(CONFIG.forbiddenNames);
    }
  });

  it("with names forbidden, an entry whose place cannot be found is refused, as before", async () => {
    const r = await byId({ name: "x.txt", parentfolderid: 5 }, { 5: { name: "a", folderid: 5 } }).run("stat", { file_id: 7 });
    assert.equal(reasonOf(r), "location-unknown");
  });

  it("a forbidden folder above the entry still refuses it, and no path is given away", async () => {
    const closed = { 5: { name: "a", folderid: 5, parentfolderid: 6 }, 6: { name: "Credentials", folderid: 6, parentfolderid: 0 } };
    const r = await byId({ name: "x.txt", parentfolderid: 5 }, closed).run("stat", { file_id: 7 });
    assert.equal(reasonOf(r), "forbidden-name");
    assert.ok(!JSON.stringify(r).includes("x.txt"));
  });
});
