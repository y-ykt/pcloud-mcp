// © 2026 Yasuhiko Yokote

/**
 * Tests for PDF rendering (`src/pdf/render.ts`).
 *
 * The PDFs used by the tests are built here.
 * This keeps binaries out of the repository and lets each test choose the page count and size.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRegion, REGION_LIMITS } from "../src/pdf/region.ts";
import { clampDpi, edgeCappedDpi, higherDpi, nextDpi, pageBudget, parsePages, PDF_LIMITS, PdfError, renderPdf } from "../src/pdf/render.ts";
import { makeMarkedPdf } from "./fixtures.ts";

// ---------------------------------------------------------------- PDFs for the tests

/**
 * Builds a PDF with the given number of empty pages.
 *
 * The cross-reference table (xref) is built correctly too.
 * Given a broken PDF, mupdf starts a repair and takes a different code path from the one under test.
 */
function makePdf(pageCount: number, widthPt = 200, heightPt = 100): Uint8Array {
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...pageIds.map(
      () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] >>`,
    ),
  ];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });

  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// ---------------------------------------------------------------- parsePages

describe("parsePages - parsing the page specification", () => {
  it("a single page", () => {
    assert.deepEqual(parsePages("1", 10), [1]);
  });

  it("a range", () => {
    assert.deepEqual(parsePages("2-4", 10), [2, 3, 4]);
  });

  it("commas combined with ranges", () => {
    assert.deepEqual(parsePages("1-3,7", 10), [1, 2, 3, 7]);
  });

  it("accepts whitespace", () => {
    assert.deepEqual(parsePages("  2, 5 - 6 ", 10), [2, 5, 6]);
  });

  it("removes duplicates and sorts in ascending order", () => {
    assert.deepEqual(parsePages("3, 1-2 ,1", 10), [1, 2, 3]);
  });

  it("accepts exactly the last page", () => {
    assert.deepEqual(parsePages("10", 10), [10]);
  });

  const rejected: [string, string, string][] = [
    ["empty", "", "empty-spec"],
    ["whitespace only", "   ", "empty-spec"],
    ["page 0", "0", "out-of-range"],
    ["beyond the page count", "11", "out-of-range"],
    ["range end beyond the page count", "9-11", "out-of-range"],
    ["not a number", "abc", "bad-spec"],
    ["reversed range", "3-1", "bad-spec"],
    ["separator only", ",", "bad-spec"],
    ["negative number", "-1", "bad-spec"],
    ["decimal", "1.5", "bad-spec"],
  ];
  for (const [name, spec, reason] of rejected) {
    it(`rejects: ${name} (${JSON.stringify(spec)})`, () => {
      assert.throws(
        () => parsePages(spec, 10),
        (e: unknown) => e instanceof PdfError && e.reason === reason,
      );
    });
  }

  it(`rejects more than the per-call limit (${PDF_LIMITS.maxPagesPerCall} pages)`, () => {
    const over = PDF_LIMITS.maxPagesPerCall + 1;
    assert.deepEqual(parsePages(`1-${PDF_LIMITS.maxPagesPerCall}`, 100).length, PDF_LIMITS.maxPagesPerCall);
    assert.throws(
      () => parsePages(`1-${over}`, 100),
      (e: unknown) => e instanceof PdfError && e.reason === "too-many-pages",
    );
  });
});

// ---------------------------------------------------------------- clampDpi

describe("clampDpi - clamping the resolution", () => {
  it("keeps a value inside the range", () => {
    assert.equal(clampDpi(150), 150);
  });

  it("raises a value below the minimum to the minimum", () => {
    assert.equal(clampDpi(10), PDF_LIMITS.minDpi);
  });

  it("lowers a value above the maximum to the maximum", () => {
    assert.equal(clampDpi(10_000), PDF_LIMITS.maxDpi);
  });

  it("rounds to an integer", () => {
    assert.equal(clampDpi(150.6), 151);
  });

  it("uses the default when the value is not a number", () => {
    for (const v of [undefined, null, "150", NaN, Infinity, {}]) {
      assert.equal(clampDpi(v), PDF_LIMITS.defaultDpi);
    }
  });
});

// ---------------------------------------------------------------- renderPdf

describe("renderPdf - rendering", () => {
  it("without pages, returns only the page count and renders nothing", async () => {
    const r = await renderPdf(makePdf(5), undefined, 150);
    assert.equal(r.pageCount, 5);
    assert.deepEqual(r.rendered, []);
    assert.equal(r.truncated, false);
    assert.equal(r.totalBytes, 0);
  });

  it("renders only the specified pages, in ascending order", async () => {
    const r = await renderPdf(makePdf(5), "3,1", 72);
    assert.deepEqual(
      r.rendered.map((p) => p.page),
      [1, 3],
    );
  });

  it("**returns either PNG or JPEG**", async () => {
    const r = await renderPdf(makePdf(1), "1", 72);
    const page = r.rendered[0]!;
    assert.ok(["image/png", "image/jpeg"].includes(page.mimeType));
    const sig = page.mimeType === "image/png" ? PNG_SIGNATURE : JPEG_SIGNATURE;
    assert.deepEqual([...page.bytes.subarray(0, sig.length)], sig);
  });

  it("**chooses PNG for a blank page**", async () => {
    // A single-color area is very small as PNG. If it comes back as JPEG, the selection is broken
    const r = await renderPdf(makePdf(1), "1", 72);
    assert.equal(r.rendered[0]!.mimeType, "image/png");
  });

  it("scales with dpi (72pt = 1 inch)", async () => {
    const at72 = await renderPdf(makePdf(1, 216, 144), "1", 72);
    const at144 = await renderPdf(makePdf(1, 216, 144), "1", 144);
    assert.deepEqual([at72.rendered[0]!.width, at72.rendered[0]!.height], [216, 144]);
    assert.deepEqual([at144.rendered[0]!.width, at144.rendered[0]!.height], [432, 288]);
  });

  it("a wrong page specification becomes a PdfError", async () => {
    await assert.rejects(
      renderPdf(makePdf(2), "5", 72),
      (e: unknown) => e instanceof PdfError && e.reason === "out-of-range",
    );
  });

  it("bytes that are not a PDF give not-a-pdf", async () => {
    await assert.rejects(
      renderPdf(new TextEncoder().encode("This is not a PDF"), "1", 72),
      (e: unknown) => e instanceof PdfError && e.reason === "not-a-pdf",
    );
  });

  it("does not open a PDF larger than the limit", async () => {
    const huge = new Uint8Array(PDF_LIMITS.maxPdfBytes + 1);
    await assert.rejects(
      renderPdf(huge, "1", 72),
      (e: unknown) => e instanceof PdfError && e.reason === "pdf-too-large",
    );
  });
});

describe("nextDpi - estimating the next resolution to try", () => {
  it("**estimates a size that fits in one step**", () => {
    // 169 KiB at 150 dpi, limit 96 KiB. The pixel count is proportional to the square of the resolution, so
    // 150 x sqrt(96/169) is about 113. Multiplied by 0.97 it is around 109
    const n = nextDpi(150, 169 * 1024, 96 * 1024);
    assert.ok(n >= 105 && n <= 115, `the estimate is off: ${n}`);
  });

  it("**is finer than steps of 80%**", () => {
    // From 160 dpi, steps of 80% give 128 -> 102 -> 82, which skips over 96
    assert.ok(nextDpi(160, 200 * 1024, 96 * 1024) > 82, "the step is still coarse");
  });

  it("always decreases (the loop terminates)", () => {
    for (const [cur, bytes] of [[150, 1], [100, 90 * 1024], [80, 10]] as [number, number][]) {
      assert.ok(nextDpi(cur, bytes, 96 * 1024) < cur, `did not decrease: ${cur}`);
    }
  });

  it("does not go below the minimum", () => {
    assert.equal(nextDpi(80, 99_999_999, 1), PDF_LIMITS.minDpi);
  });

  it("does not break when the size is 0", () => {
    assert.equal(nextDpi(150, 0, 96 * 1024), PDF_LIMITS.minDpi);
  });
});

describe("pageBudget - the size allotted to one page", () => {
  const TOTAL = PDF_LIMITS.maxTotalBytes;

  it("**is constant regardless of the page count**", () => {
    // The effective limit is the size of one image, not of the whole response (measured).
    // Raising the budget for a single page makes that one image fail to be delivered
    for (const n of [1, 2, 3, 10]) {
      assert.equal(pageBudget(n, TOTAL), PDF_LIMITS.maxPageBytes, `a different value for ${n} pages`);
    }
  });

  it("**is within the size that was observed to be delivered**", () => {
    // 96 KiB is about 128,000 characters in base64. About 144,000 characters were observed to be delivered
    const base64Chars = Math.ceil(PDF_LIMITS.maxPageBytes / 3) * 4;
    assert.ok(base64Chars < 144_000, `too large: ${base64Chars} characters`);
  });

  it("does not break for 0 pages", () => {
    assert.equal(pageBudget(0, TOTAL), PDF_LIMITS.maxPageBytes);
  });
});

describe("renderPdf - the per-page limit", () => {
  it("**lowers the resolution when the page does not fit the limit**", async () => {
    // With an extremely small limit, the resolution should go down to the minimum
    const r = await renderPdf(makePdf(1, 600, 800), "1", 300, { maxPageBytes: 1 });
    assert.equal(r.rendered[0]!.dpi, PDF_LIMITS.minDpi);
    assert.deepEqual(r.reduced, [1]);
  });

  it("renders at the requested resolution when the page fits", async () => {
    const r = await renderPdf(makePdf(1, 200, 100), "1", 150);
    assert.equal(r.rendered[0]!.dpi, 150);
    assert.deepEqual(r.reduced, []);
  });

  it("lists only the lowered pages in reduced", async () => {
    const r = await renderPdf(makePdf(2, 200, 100), "1-2", 72);
    assert.deepEqual(r.reduced, [], "a page is listed although it was not lowered");
  });
});

describe("renderPdf - the total size limit", () => {
  it("at the limit, does not render the rest and lists it in skipped", async () => {
    // With a limit of 1 byte, page 2 and later never fit
    const r = await renderPdf(makePdf(4), "1-4", 72, { maxBytes: 1 });
    assert.deepEqual(
      r.rendered.map((p) => p.page),
      [1],
    );
    assert.equal(r.truncated, true);
    assert.deepEqual(r.skipped, [2, 3, 4]);
  });

  it("always returns page 1, even when it exceeds the limit", async () => {
    const r = await renderPdf(makePdf(1), "1", 72, { maxBytes: 1 });
    assert.equal(r.rendered.length, 1);
    assert.equal(r.truncated, false);
    assert.ok(r.totalBytes > 1);
  });

  it("truncated is false when everything fits the limit", async () => {
    const r = await renderPdf(makePdf(3), "1-3", 72);
    assert.equal(r.rendered.length, 3);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.skipped, []);
  });
});

// ---------------------------------------------------------------- cropping a region

/**
 * Decodes the returned image and reads the pixel at the given fractional position.
 *
 * **A wrong crop still renders successfully.**
 * The size alone does not show that a different location was returned, so the content is checked.
 */
async function samplePixel(
  bytes: Uint8Array,
  fx: number,
  fy: number,
): Promise<[number, number, number]> {
  const mupdf = await import("mupdf");
  const pixmap = new mupdf.Image(bytes).toPixmap();
  try {
    const n = pixmap.getNumberOfComponents();
    const stride = pixmap.getStride();
    const px = pixmap.getPixels();
    const x = Math.min(Math.floor(pixmap.getWidth() * fx), pixmap.getWidth() - 1);
    const y = Math.min(Math.floor(pixmap.getHeight() * fy), pixmap.getHeight() - 1);
    const at = y * stride + x * n;
    return [px[at] as number, px[at + 1] as number, px[at + 2] as number];
  } finally {
    pixmap.destroy();
  }
}

const isBlack = (p: [number, number, number]): boolean => p.every((v) => v < 64);
const isWhite = (p: [number, number, number]): boolean => p.every((v) => v > 192);

describe("renderPdf - cropping a region", () => {
  it("renders the whole page when no region is given", async () => {
    const r = await renderPdf(makeMarkedPdf(400, 200), "1", 72);
    assert.equal(r.rendered[0]!.width, 400);
    assert.equal(r.rendered[0]!.height, 200);
  });

  it("**a quarter gives about half the width and height**", async () => {
    const r = await renderPdf(makeMarkedPdf(400, 200), "1", 72, {
      region: parseRegion("top-left"),
    });
    // Overlap is added only at the inner cuts
    const o = REGION_LIMITS.overlap;
    assert.equal(r.rendered[0]!.width, Math.ceil(200 * (1 + o)));
    assert.equal(r.rendered[0]!.height, Math.ceil(100 * (1 + o)));
  });

  it("**asking for the top left returns the mark painted at the top left** (top and bottom are not swapped)", async () => {
    const r = await renderPdf(makeMarkedPdf(400, 200), "1", 72, {
      region: parseRegion("top-left"),
    });
    const p = await samplePixel(r.rendered[0]!.bytes, 0.25, 0.25);
    assert.ok(isBlack(p), `no mark at the top left: ${p.join(",")}`);
  });

  it("**cells without the mark are white** (no other location is returned)", async () => {
    const pdf = makeMarkedPdf(400, 200);
    for (const name of ["top-right", "bottom-left", "bottom-right"]) {
      const r = await renderPdf(pdf, "1", 72, { region: parseRegion(name) });
      const p = await samplePixel(r.rendered[0]!.bytes, 0.5, 0.5);
      assert.ok(isWhite(p), `${name} has the mark: ${p.join(",")}`);
    }
  });

  it("crops the same way for a grid cell", async () => {
    const r = await renderPdf(makeMarkedPdf(400, 200), "1", 72, { region: parseRegion("2x2:1") });
    const p = await samplePixel(r.rendered[0]!.bytes, 0.25, 0.25);
    assert.ok(isBlack(p), `2x2:1 does not point to the top left: ${p.join(",")}`);
  });

  it("**a narrower region allows a higher resolution under the same limit**", async () => {
    // Give the same limit and compare the resolution reached for the whole page and for a quarter
    const pdf = makeMarkedPdf(1200, 1600);
    const limit = 24 * 1024;
    const whole = await renderPdf(pdf, "1", PDF_LIMITS.maxDpi, { maxPageBytes: limit });
    const quarter = await renderPdf(pdf, "1", PDF_LIMITS.maxDpi, {
      maxPageBytes: limit,
      region: parseRegion("top-left"),
    });
    assert.ok(
      quarter.rendered[0]!.dpi > whole.rendered[0]!.dpi,
      `whole page ${whole.rendered[0]!.dpi} dpi, quarter ${quarter.rendered[0]!.dpi} dpi`,
    );
  });
});

describe("higherDpi - estimating how to reuse the unused budget", () => {
  const BUDGET = 96 * 1024;

  it("**uses the budget that a measured case left unused**", () => {
    // A quarter region ended at 105 dpi / 67,831 B. The maximum that fits is 126 dpi
    const n = higherDpi(105, 67_831, BUDGET, PDF_LIMITS.maxDpi);
    assert.ok(n >= 118 && n <= 126, `the estimate is off: ${n}`);
  });

  it("**does not exceed the requested value**", () => {
    // Rendering at a resolution that was not requested only increases the amount returned
    assert.equal(higherDpi(105, 1, BUDGET, 150), 150);
  });

  it("always increases", () => {
    assert.ok(higherDpi(100, 95 * 1024, BUDGET, 300) > 100);
  });

  it("does not break when the size is 0", () => {
    assert.equal(higherDpi(105, 0, BUDGET, 200), 200);
  });
});

describe("renderPdf - the limit holds after raising the resolution again", () => {
  it("**discards a raised result that exceeds the limit**", async () => {
    const pdf = makeMarkedPdf(1200, 1600);
    const limit = 24 * 1024;
    const r = await renderPdf(pdf, "1", PDF_LIMITS.maxDpi, {
      maxPageBytes: limit,
      region: parseRegion("top-left"),
    });
    assert.ok(
      r.rendered[0]!.bytes.byteLength <= limit,
      `exceeded the limit ${limit}: ${r.rendered[0]!.bytes.byteLength}`,
    );
  });

  it("does not go above the requested value when the page fits as requested", async () => {
    const r = await renderPdf(makeMarkedPdf(200, 100), "1", 100);
    assert.equal(r.rendered[0]!.dpi, 100);
  });
});

describe("edgeCappedDpi - stays within the pixel count above which the receiver downscales", () => {
  const MAX = PDF_LIMITS.maxEdgePixels;

  it("**returns the resolution that just fits the limit**", () => {
    // A4 portrait (595x842pt) rendered at 300 dpi has a long edge of 3508 pixels
    const n = edgeCappedDpi(595, 842, 300);
    assert.ok((842 * n) / 72 <= MAX, `the long edge is ${(842 * n) / 72} pixels`);
    assert.ok((842 * (n + 1)) / 72 > MAX, `can still be raised: ${n}`);
  });

  it("is as requested when the page fits", () => {
    assert.equal(edgeCappedDpi(200, 100, 150), 150);
  });

  it("**judges by the long edge for both landscape and portrait**", () => {
    assert.equal(edgeCappedDpi(842, 595, 300), edgeCappedDpi(595, 842, 300));
  });

  it("does not go below the minimum", () => {
    // Even for extremely large paper, being downscaled is better than being too coarse to read
    assert.equal(edgeCappedDpi(100_000, 100_000, 300), PDF_LIMITS.minDpi);
  });

  it("does not break when the size is 0", () => {
    assert.equal(edgeCappedDpi(0, 0, 150), 150);
  });
});

describe("renderPdf - the long edge limit", () => {
  it("**the long edge of a cell does not exceed the limit**", async () => {
    // A quarter of an A4-size page rendered at 300 dpi used to be 1825 pixels
    const r = await renderPdf(makeMarkedPdf(595, 842), "1", PDF_LIMITS.maxDpi, {
      region: parseRegion("top-left"),
    });
    const p = r.rendered[0]!;
    assert.ok(
      Math.max(p.width, p.height) <= PDF_LIMITS.maxEdgePixels,
      `long edge ${Math.max(p.width, p.height)} pixels`,
    );
  });

  it("**does not mix the reason for the cap with reduced**", async () => {
    const r = await renderPdf(makeMarkedPdf(595, 842), "1", PDF_LIMITS.maxDpi);
    assert.deepEqual(r.edgeCapped, [1], "the long edge cap is not listed");
    assert.deepEqual(r.reduced, [], "listed in reduced although the budget is not the reason");
  });

  it("does not cap a small page", async () => {
    const r = await renderPdf(makeMarkedPdf(200, 100), "1", 150);
    assert.deepEqual(r.edgeCapped, []);
  });
});
