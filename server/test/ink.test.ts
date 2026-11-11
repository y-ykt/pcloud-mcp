// © 2026 Yasuhiko Yokote

/**
 * Tests for the ink distribution (`src/pdf/ink.ts`).
 *
 * **Stating the wrong location is worse than a guess.**
 * If the server says "there is content at the top left" and returns a blank image,
 * the receiver takes the empty area to mean that the page has no figure.
 * So **these tests check by pixels that the reported location is the painted location.**
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INK_GRID,
  INK_LIMITS,
  type InkGrid,
  inkFraction,
  inkMap,
  isBlank,
  measureInk,
  notableCells,
} from "../src/pdf/ink.ts";
import { REGION_LIMITS } from "../src/pdf/region.ts";
import { makeInkPdf, makeMarkedPdf } from "./fixtures.ts";

/** Measures page 1 of `makeMarkedPdf`. **The top-left quarter is black and the rest is white.** */
async function measureFirstPage(widthPt = 400, heightPt = 200): Promise<InkGrid> {
  return measure(makeMarkedPdf(widthPt, heightPt));
}

/** Measures page 1 of the given PDF. */
async function measure(pdf: Uint8Array): Promise<InkGrid> {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(pdf, "application/pdf");
  try {
    const page = doc.loadPage(0);
    try {
      return measureInk(mupdf, page);
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/** Compares fractions. The edge of the rendering can be off by 1 pixel, so a tolerance is allowed. */
const near = (actual: number, expected: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) < 0.03,
    `${what}: ${actual.toFixed(3)} (expected ${expected})`,
  );
};

// ---------------------------------------------------------------- assumptions about the grid

describe("INK_GRID", () => {
  it("**is divisible by every number of divisions that region accepts**", () => {
    // If this stops holding, inkFraction starts to throw
    for (let n = 1; n <= REGION_LIMITS.maxDivisions; n++) {
      assert.equal(INK_GRID % n, 0, `not divisible by ${n}`);
    }
  });
});

// ---------------------------------------------------------------- measurement

describe("measureInk - finds the painted location", () => {
  it("**only the top-left quarter is filled with ink**", async () => {
    const grid = await measureFirstPage();
    near(inkFraction(grid, 2, 2, 1), 1, "top left");
    near(inkFraction(grid, 2, 2, 2), 0, "top right");
    near(inkFraction(grid, 2, 2, 3), 0, "bottom left");
    near(inkFraction(grid, 2, 2, 4), 0, "bottom right");
  });

  it("is 1/4 over the whole page", async () => {
    near(inkFraction(await measureFirstPage(), 1, 1, 1), 0.25, "whole page");
  });

  it("**is consistent when divided into ninths**", async () => {
    const grid = await measureFirstPage();
    // The top-left ninth lies entirely inside the painted quarter
    near(inkFraction(grid, 3, 3, 1), 1, "3x3:1");
    // Only the top-left quarter of the center ninth overlaps the painted area
    near(inkFraction(grid, 3, 3, 5), 0.25, "3x3:5");
    near(inkFraction(grid, 3, 3, 9), 0, "3x3:9");
  });

  it("**when only the top-right ninth is painted, only that cell is filled**", async () => {
    // The top-left quarter is symmetric under transposition, so swapping rows and columns goes unnoticed.
    // **Paint an asymmetric location to check the counting order itself**
    const grid = await measure(makeInkPdf([2 / 3, 0, 1, 1 / 3]));
    for (let i = 1; i <= 9; i++) {
      near(inkFraction(grid, 3, 3, i), i === 3 ? 1 : 0, `3x3:${i}`);
    }
  });

  it("**the same holds for the bottom-left ninth**", async () => {
    const grid = await measure(makeInkPdf([0, 2 / 3, 1 / 3, 1]));
    for (let i = 1; i <= 9; i++) {
      near(inkFraction(grid, 3, 3, i), i === 7 ? 1 : 0, `3x3:${i}`);
    }
  });

  it("does not change on a page with a different aspect ratio", async () => {
    near(inkFraction(await measureFirstPage(200, 800), 2, 2, 1), 1, "portrait page");
  });
});

// ---------------------------------------------------------------- aggregation

describe("inkFraction - aggregation", () => {
  const grid: InkGrid = {
    n: INK_GRID,
    ink: new Array<number>(INK_GRID * INK_GRID).fill(0),
    total: new Array<number>(INK_GRID * INK_GRID).fill(100),
  };

  it("**rejects a number of divisions that does not divide the grid**", () => {
    // Silently returning a nearby value would state the wrong location
    assert.throws(() => inkFraction(grid, 5, 1, 1), /cannot be divided into/);
  });

  it("is 0 when there are no pixels", () => {
    const empty: InkGrid = { n: INK_GRID, ink: [], total: [] };
    assert.equal(inkFraction({ ...empty, total: new Array<number>(144).fill(0), ink: new Array<number>(144).fill(0) }, 2, 2, 1), 0);
  });
});

describe("inkMap and notableCells", () => {
  it("**lists cells in the same notation as region**", async () => {
    const map = inkMap(await measureFirstPage(), 2, 2);
    assert.deepEqual(Object.keys(map), ["2x2:1", "2x2:2", "2x2:3", "2x2:4"]);
    assert.equal(map["2x2:1"], 1);
  });

  it("lists only the cells with content, most ink first", () => {
    const cells = notableCells({ "3x3:1": 0.01, "3x3:5": 0.31, "3x3:6": 0.2 });
    assert.deepEqual(cells, ["3x3:5", "3x3:6"]);
  });

  it("**does not list faint cells** (an absolute lower bound alone gives no guidance)", () => {
    // In a measured case 7 of 9 cells exceeded 5%, so almost all of them were listed
    const cells = notableCells({
      "3x3:1": 0.01, "3x3:2": 0.03, "3x3:3": 0.06, "3x3:4": 0.09, "3x3:5": 0.23,
      "3x3:6": 0.13, "3x3:7": 0.06, "3x3:8": 0.06, "3x3:9": 0.07,
    });
    assert.deepEqual(cells, ["3x3:5", "3x3:6"]);
  });

  it("**caps the number of cells listed**", () => {
    const flat: Record<string, number> = {};
    for (let i = 1; i <= 9; i++) flat[`3x3:${i}`] = 0.3;
    assert.equal(notableCells(flat).length, INK_LIMITS.notableCount);
  });

  it("**is empty when no cell has content**", () => {
    assert.deepEqual(notableCells({ "2x2:1": 0, "2x2:2": 0.001 }), []);
  });
});

describe("isBlank", () => {
  it("inside and outside the threshold", () => {
    assert.equal(isBlank(0), true);
    assert.equal(isBlank(INK_LIMITS.blankBelow), true);
    assert.equal(isBlank(INK_LIMITS.blankBelow + 0.001), false);
  });
});
