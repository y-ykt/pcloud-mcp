// © 2026 Yasuhiko Yokote

/**
 * Tests for text layer extraction (`src/pdf/text.ts`).
 *
 * **Listing text that is not shown in the image causes misreading.**
 * These tests check that the returned text matches the rendered region.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Rect } from "../src/pdf/region.ts";
import {
  extractPageText,
  linesFromJson,
  overlapsRegion,
  selectLines,
  TEXT_LIMITS,
} from "../src/pdf/text.ts";
import { makeTextPdf } from "./fixtures.ts";

const PAGE: Rect = [0, 0, 100, 100];
const texts = (r: { lines: { text: string }[] }): string[] => r.lines.map((l) => l.text);
const line = (text: string, x: number, y: number, w = 10, h = 10) => ({
  text,
  bbox: { x, y, w, h },
});

// ---------------------------------------------------------------- region test

describe("overlapsRegion", () => {
  it("includes a line that is entirely inside", () => {
    assert.equal(overlapsRegion({ x: 10, y: 10, w: 10, h: 10 }, PAGE), true);
  });

  it("excludes a line that is entirely outside", () => {
    assert.equal(overlapsRegion({ x: 200, y: 200, w: 10, h: 10 }, PAGE), false);
  });

  it("**includes a line that is mostly inside, even if it extends past the edge**", () => {
    // 15 of the width 20 is inside = 0.75
    assert.equal(overlapsRegion({ x: 85, y: 10, w: 20, h: 10 }, PAGE), true);
  });

  it("**excludes a line that is mostly outside** (the adjacent cell picks it up)", () => {
    // 10 of the width 30 is inside = 0.33. The other 2/3 is on the adjacent side, which is more than half there
    assert.equal(overlapsRegion({ x: 90, y: 10, w: 30, h: 10 }, PAGE), false);
  });

  it("**excludes a line that only touches the region**", () => {
    assert.equal(overlapsRegion({ x: 95, y: 10, w: 20, h: 10 }, PAGE), false);
  });

  it("includes a line exactly at the threshold", () => {
    // 10 of the width 20 is inside = 0.5
    assert.equal(TEXT_LIMITS.minOverlap, 0.5);
    assert.equal(overlapsRegion({ x: 90, y: 10, w: 20, h: 10 }, PAGE), true);
  });

  it("judges a line with no area as a point", () => {
    assert.equal(overlapsRegion({ x: 50, y: 50, w: 0, h: 0 }, PAGE), true);
    assert.equal(overlapsRegion({ x: 150, y: 50, w: 0, h: 0 }, PAGE), false);
  });
});

// ---------------------------------------------------------------- filtering

describe("selectLines", () => {
  // Only 1/4 of the center line falls in the top-left region (an example of a line that is excluded)
  const all = [line("top-left", 5, 5), line("bottom-right", 80, 80), line("center", 45, 45)];

  it("returns everything when the region is omitted", () => {
    const r = selectLines(all, undefined, PAGE);
    assert.deepEqual(texts(r), ["top-left", "bottom-right", "center"]);
    assert.equal(r.totalLines, 3);
  });

  it("**returns only the lines inside the region**", () => {
    const r = selectLines(all, [0, 0, 50, 50], PAGE);
    assert.deepEqual(texts(r), ["top-left"], "text that is not shown in the image is listed");
    // The line count before filtering stays available after filtering
    assert.equal(r.totalLines, 3);
  });

  it("**a line across a cut is always picked up on one side**", () => {
    // Nothing may be left out. A line on the boundary must not disappear from both sides
    const straddling = [line("straddling", 45, 10, 10, 10)];
    const left = texts(selectLines(straddling, [0, 0, 52, 100], PAGE));
    const right = texts(selectLines(straddling, [48, 0, 100, 100], PAGE));
    assert.ok(left.length + right.length >= 1, "the line is missing from both cells");
  });

  it("**does not reorder** (content order is kept)", () => {
    // On a rotated drawing, sorting by coordinates gives an unnatural order
    assert.deepEqual(texts(selectLines(all, undefined, PAGE)), ["top-left", "bottom-right", "center"]);
  });

  it("**distinguishes no text layer from no text in the region**", () => {
    assert.equal(selectLines([], undefined, PAGE).hasTextLayer, false);
    const outside = selectLines(all, [200, 200, 300, 300], PAGE);
    assert.equal(outside.hasTextLayer, true, "text exists but is reported as absent");
    assert.deepEqual(texts(outside), []);
  });

  it("truncates at the limit and reports it", () => {
    const many = Array.from({ length: 2000 }, (_, i) => line(`${i}`.repeat(10), 5, 5));
    const r = selectLines(many, undefined, PAGE);
    assert.equal(r.truncated, true);
    assert.ok(r.chars <= TEXT_LIMITS.maxChars, `${r.chars} characters were returned`);
  });
});

// ---------------------------------------------------------------- reading the JSON

describe("linesFromJson", () => {
  it("extracts lines and positions", () => {
    const json = {
      blocks: [{ lines: [{ text: "a", bbox: { x: 1, y: 2, w: 3, h: 4 } }] }],
    };
    assert.deepEqual(linesFromJson(json), [{ text: "a", bbox: { x: 1, y: 2, w: 3, h: 4 } }]);
  });

  it("**drops lines that are only whitespace**", () => {
    const json = { blocks: [{ lines: [{ text: "  ", bbox: {} }, { text: " x ", bbox: {} }] }] };
    assert.deepEqual(
      linesFromJson(json).map((l) => l.text),
      ["x"],
    );
  });

  it("skips blocks without lines, such as image blocks", () => {
    const json = { blocks: [{ type: "image" }, { lines: [{ text: "y", bbox: {} }] }] };
    assert.equal(linesFromJson(json).length, 1);
  });

  it("does not crash on a malformed shape", () => {
    for (const v of [null, undefined, {}, { blocks: "x" }, { blocks: [null] }]) {
      assert.deepEqual(linesFromJson(v), []);
    }
  });
});

// ---------------------------------------------------------------- a real PDF

describe("extractPageText - a real PDF", () => {
  const open = async (pdf: Uint8Array) => {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdf, "application/pdf");
    return { mupdf, doc, page: doc.loadPage(0) };
  };

  it("**extracts the text layer when there is one**", async () => {
    const { mupdf, doc, page } = await open(makeTextPdf([["ABC", 20, 40], ["XYZ", 20, 80]]));
    try {
      const r = extractPageText(mupdf, page);
      assert.equal(r.hasTextLayer, true);
      // The order is left to mupdf. This checks that **nothing is left out**
      assert.deepEqual([...texts(r)].sort(), ["ABC", "XYZ"]);
    } finally {
      page.destroy();
      doc.destroy();
    }
  });

  it("**with a region, returns only the text shown there**", async () => {
    const { mupdf, doc, page } = await open(makeTextPdf([["ABC", 20, 40], ["XYZ", 20, 180]]));
    try {
      // The page is 200x200pt. Only the top half is specified (in mupdf the top edge is y=0)
      const r = extractPageText(mupdf, page, [0, 0, 200, 100]);
      assert.deepEqual(texts(r), ["XYZ"], "text that is not shown in the top half is returned");
      assert.equal(r.totalLines, 2);
    } finally {
      page.destroy();
      doc.destroy();
    }
  });

  it("**reports that a PDF has no text layer**", async () => {
    const { makeMarkedPdf } = await import("./fixtures.ts");
    const { mupdf, doc, page } = await open(makeMarkedPdf(200, 100));
    try {
      const r = extractPageText(mupdf, page);
      assert.equal(r.hasTextLayer, false);
      assert.equal(r.failed, false, "a page without text is not a failure");
      assert.deepEqual(texts(r), []);
    } finally {
      page.destroy();
      doc.destroy();
    }
  });
});

describe("extractPageText - when extraction fails", () => {
  // A stand-in for a mupdf page whose text cannot be extracted
  const brokenPage = (asJSON: () => string, onDestroy: () => void = () => {}) =>
    ({
      toStructuredText: () => ({ asJSON, destroy: onDestroy }),
      getBounds: () => [0, 0, 100, 100],
    }) as unknown as import("mupdf").Page;

  it("**reports the failure instead of \"no text layer\" alone**", async () => {
    const mupdf = await import("mupdf");
    let destroyed = 0;
    const r = extractPageText(mupdf, brokenPage(() => "{not json", () => destroyed++));
    assert.equal(r.failed, true);
    assert.equal(r.hasTextLayer, false);
    assert.deepEqual(texts(r), []);
    assert.equal(destroyed, 1, "the structured text must be released");
  });

  it("a failure inside mupdf is reported in the same way", async () => {
    const mupdf = await import("mupdf");
    const page = {
      toStructuredText: () => {
        throw new Error("mupdf failed");
      },
      getBounds: () => [0, 0, 100, 100],
    } as unknown as import("mupdf").Page;
    assert.equal(extractPageText(mupdf, page).failed, true);
  });

  it("a page whose text was extracted is not a failure", () => {
    assert.equal(selectLines([line("a", 0, 0, 10, 10)], undefined, PAGE).failed, false);
    assert.equal(selectLines([], undefined, PAGE).failed, false);
  });
});

// ---------------------------------------------------------------- position

describe("selectLines - position", () => {
  it("**returns positions as percentages, with the page top left at 0,0 and the bottom right at 100,100**", () => {
    const r = selectLines([line("corner", 0, 0, 10, 10), line("edge", 90, 90, 10, 10)], undefined, PAGE);
    assert.deepEqual(r.lines[0], { text: "corner", x: 5, y: 5 });
    assert.deepEqual(r.lines[1], { text: "edge", x: 95, y: 95 });
  });

  it("**the reference is the page, not the region** (the same scale for any region)", () => {
    const all = [line("near bottom-right", 80, 80)];
    const whole = selectLines(all, undefined, PAGE).lines[0];
    const zoomed = selectLines(all, [50, 50, 100, 100], PAGE).lines[0];
    assert.deepEqual(whole, zoomed, "the position changes with the region");
  });

  it("is a percentage on a page whose origin is not 0", () => {
    const r = selectLines([line("mid", 60, 60, 20, 20)], undefined, [10, 10, 110, 110]);
    assert.deepEqual(r.lines[0], { text: "mid", x: 60, y: 60 });
  });
});
