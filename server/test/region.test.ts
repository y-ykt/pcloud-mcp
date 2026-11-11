// © 2026 Yasuhiko Yokote

/**
 * Tests for the render region specification (`src/pdf/region.ts`).
 *
 * **These tests check the counting order and the overlap.**
 * If either is wrong, rendering itself still succeeds,
 * and the error shows only as "a different location was returned" or "text on the boundary is missing".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PdfError } from "../src/pdf/errors.ts";
import {
  describeRegion,
  FULL_REGION,
  parseRegion,
  type Rect,
  REGION_LIMITS,
  regionRect,
} from "../src/pdf/region.ts";

/** A 100x100 page. Cell boundaries are integers, which makes counting easy. */
const PAGE: Rect = [0, 0, 100, 100];

// ---------------------------------------------------------------- parsing

describe("parseRegion - omitted and whole page", () => {
  it("is the whole page when omitted", () => {
    assert.deepEqual(parseRegion(undefined), FULL_REGION);
    assert.deepEqual(parseRegion(null), FULL_REGION);
  });

  it("full and the empty string are also the whole page", () => {
    assert.deepEqual(parseRegion("full"), FULL_REGION);
    assert.deepEqual(parseRegion("  "), FULL_REGION);
  });
});

describe("parseRegion - named regions", () => {
  it("**the four corners point to the correct cells**", () => {
    // Count from the top left to the right, and wrap at the right edge
    assert.deepEqual(parseRegion("top-left"), { cols: 2, rows: 2, index: 1, label: "top-left" });
    assert.deepEqual(parseRegion("top-right"), { cols: 2, rows: 2, index: 2, label: "top-right" });
    assert.deepEqual(parseRegion("bottom-left"), {
      cols: 2,
      rows: 2,
      index: 3,
      label: "bottom-left",
    });
    assert.deepEqual(parseRegion("bottom-right"), {
      cols: 2,
      rows: 2,
      index: 4,
      label: "bottom-right",
    });
  });

  it("top and bottom split into 2 rows, left and right into 2 columns", () => {
    assert.deepEqual(parseRegion("top"), { cols: 1, rows: 2, index: 1, label: "top" });
    assert.deepEqual(parseRegion("bottom"), { cols: 1, rows: 2, index: 2, label: "bottom" });
    assert.deepEqual(parseRegion("left"), { cols: 2, rows: 1, index: 1, label: "left" });
    assert.deepEqual(parseRegion("right"), { cols: 2, rows: 1, index: 2, label: "right" });
  });

  it("normalizes uppercase, underscores and spaces", () => {
    assert.equal(parseRegion(" TOP_LEFT ").label, "top-left");
    assert.equal(parseRegion("Top Left").label, "top-left");
  });
});

describe("parseRegion - grid cells", () => {
  it("3x3:5 is the center", () => {
    assert.deepEqual(parseRegion("3x3:5"), { cols: 3, rows: 3, index: 5, label: "3x3:5" });
  });

  it("columns and rows may differ", () => {
    assert.deepEqual(parseRegion("2x4:7"), { cols: 2, rows: 4, index: 7, label: "2x4:7" });
  });
});

describe("parseRegion - rejections", () => {
  const rejects = (spec: unknown, why: RegExp): void => {
    assert.throws(
      () => parseRegion(spec),
      (e: unknown) => e instanceof PdfError && why.test(e.message),
      `${String(spec)} was accepted`,
    );
  };

  it("rejects a wrong form", () => {
    rejects("upper left", /The form of region is wrong/);
    rejects("3x3", /The form of region is wrong/);
    rejects("1/4", /The form of region is wrong/);
  });

  it("rejects a value that is not a string", () => {
    rejects(4, /Specify region as a string/);
  });

  it("**rejects more divisions than the limit**", () => {
    const over = REGION_LIMITS.maxDivisions + 1;
    rejects(`${over}x1:1`, /The number of divisions is/);
    rejects(`1x${over}:1`, /The number of divisions is/);
    rejects("0x2:1", /The number of divisions is/);
  });

  it("**rejects a cell number that is out of range**", () => {
    rejects("2x2:0", /The cell number is/);
    rejects("2x2:5", /The cell number is/);
  });

  it("accepts the limit itself", () => {
    const max = REGION_LIMITS.maxDivisions;
    assert.equal(parseRegion(`${max}x${max}:${max * max}`).index, max * max);
  });
});

// ---------------------------------------------------------------- rectangle

describe("regionRect", () => {
  it("the whole page is the page rectangle itself", () => {
    assert.deepEqual(regionRect(PAGE, FULL_REGION), PAGE);
  });

  it("**the top-left quarter does not extend outward**", () => {
    // The top and the left are page edges, so no overlap is added there
    const o = 50 * REGION_LIMITS.overlap;
    assert.deepEqual(regionRect(PAGE, parseRegion("top-left")), [0, 0, 50 + o, 50 + o]);
  });

  it("the bottom-right quarter gets overlap only on the inner sides", () => {
    const o = 50 * REGION_LIMITS.overlap;
    assert.deepEqual(regionRect(PAGE, parseRegion("bottom-right")), [50 - o, 50 - o, 100, 100]);
  });

  it("**the center cell gets overlap on all four sides**", () => {
    const o = (100 / 3) * REGION_LIMITS.overlap;
    const [x0, y0, x1, y1] = regionRect(PAGE, parseRegion("3x3:5"));
    assert.ok(Math.abs(x0 - (100 / 3 - o)) < 1e-9, `x0=${x0}`);
    assert.ok(Math.abs(y0 - (100 / 3 - o)) < 1e-9, `y0=${y0}`);
    assert.ok(Math.abs(x1 - (200 / 3 + o)) < 1e-9, `x1=${x1}`);
    assert.ok(Math.abs(y1 - (200 / 3 + o)) < 1e-9, `y1=${y1}`);
  });

  it("is correct on a page whose origin is not 0", () => {
    // Some PDFs have a mediabox whose origin is shifted
    const shifted: Rect = [10, 20, 110, 120];
    const o = 50 * REGION_LIMITS.overlap;
    assert.deepEqual(regionRect(shifted, parseRegion("top-left")), [10, 20, 60 + o, 70 + o]);
  });

  it("**adjacent cells always overlap** (text on the boundary is not lost)", () => {
    for (const [a, b] of [
      ["3x3:1", "3x3:2"],
      ["3x3:2", "3x3:3"],
      ["3x3:1", "3x3:4"],
      ["3x3:5", "3x3:8"],
    ] as const) {
      const ra = regionRect(PAGE, parseRegion(a));
      const rb = regionRect(PAGE, parseRegion(b));
      // x must overlap for cells side by side, y for cells one above the other
      const overlapX = Math.min(ra[2], rb[2]) - Math.max(ra[0], rb[0]);
      const overlapY = Math.min(ra[3], rb[3]) - Math.max(ra[1], rb[1]);
      assert.ok(overlapX > 0 && overlapY > 0, `${a} and ${b} do not overlap`);
    }
  });

  it("**all cells together cover the whole page** (nothing is left out)", () => {
    for (const { cols, rows } of [
      { cols: 2, rows: 2 },
      { cols: 3, rows: 3 },
      { cols: 2, rows: 4 },
    ]) {
      // Check every boundary to confirm that the edge of each row and column meets its neighbor
      for (let n = 1; n <= cols * rows; n++) {
        const r = regionRect(PAGE, parseRegion(`${cols}x${rows}:${n}`));
        const col = (n - 1) % cols;
        const row = Math.floor((n - 1) / cols);
        // The area of the cell without the overlap must always be included
        assert.ok(r[0] <= (100 / cols) * col + 1e-9, `${cols}x${rows}:${n} is missing its left part`);
        assert.ok(r[2] >= (100 / cols) * (col + 1) - 1e-9, `${cols}x${rows}:${n} is missing its right part`);
        assert.ok(r[1] <= (100 / rows) * row + 1e-9, `${cols}x${rows}:${n} is missing its top part`);
        assert.ok(r[3] >= (100 / rows) * (row + 1) - 1e-9, `${cols}x${rows}:${n} is missing its bottom part`);
      }
    }
  });
});

// ---------------------------------------------------------------- description

describe("describeRegion", () => {
  it("says so for the whole page", () => {
    assert.equal(describeRegion(FULL_REGION), "the whole page");
  });

  it("a named region adds the position in words", () => {
    assert.match(describeRegion(parseRegion("top-left")), /the top-left quarter/);
    assert.match(describeRegion(parseRegion("bottom")), /the bottom half/);
  });

  it("**a grid cell is described by its recounted row and column**", () => {
    // Returning only the number would hide a receiver's mistake in the counting order
    assert.match(describeRegion(parseRegion("3x3:5")), /row 2, column 2/);
    assert.match(describeRegion(parseRegion("3x3:5")), /1\/9/);
  });
});
