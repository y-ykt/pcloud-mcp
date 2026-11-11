// © 2026 Yasuhiko Yokote

/**
 * Handle the specification for rendering only part of a page.
 *
 * **Why this is needed.**
 * One image has a limit on the size that can be received (by measurement), and
 * fitting a whole page within it lowers the resolution to about 90 dpi. Small numbers in a figure cannot be read.
 *
 * **If a budget of the same size is used for part of the page, the resolution can be raised by as much as the area shrinks.**
 * For 1/4 it is about 2 times, for 1/9 about 3 times (an estimate from the area).
 *
 * **This unit does not touch mupdf.** It holds only the rules for counting and for the overlap.
 */

import { PdfError } from "./errors.ts";

export const REGION_LIMITS = {
  /** Limit on the number of divisions, vertically and horizontally. Anything finer only increases the number of calls. */
  maxDivisions: 4,
  /**
   * Overlap given to each cut (as a fraction of the width and height of a cell).
   *
   * **It exists so that characters lying on a boundary are not lost.**
   * Without an overlap, a character cut in the middle of a line is halved in both cells,
   * and the receiving side cannot tell that it is "incomplete".
   * The overlap does not extend outside the page.
   */
  overlap: 0.04,
} as const;

/** The area to render, expressed as one of the cells that divide the page equally in both directions. */
export interface Region {
  /** Number of horizontal divisions. */
  cols: number;
  /** Number of vertical divisions. */
  rows: number;
  /** Cell number, counted from 1. **It runs from the top left to the right, and wraps to the next row at the right edge.** */
  index: number;
  /** Notation used in the response (`"full"` `"top-left"` `"3x3:5"`). */
  label: string;
}

/** The whole page. The value when `region` is omitted. */
export const FULL_REGION: Region = { cols: 1, rows: 1, index: 1, label: "full" };

/**
 * Named specifications. **They are only other names for cells.**
 *
 * To keep a single rule for counting, no name has a calculation of its own.
 */
const ALIASES: Record<string, { cols: number; rows: number }> = {
  top: { cols: 1, rows: 2 },
  bottom: { cols: 1, rows: 2 },
  left: { cols: 2, rows: 1 },
  right: { cols: 2, rows: 1 },
  "top-left": { cols: 2, rows: 2 },
  "top-right": { cols: 2, rows: 2 },
  "bottom-left": { cols: 2, rows: 2 },
  "bottom-right": { cols: 2, rows: 2 },
};

/** The cell number that a named specification refers to (used together with {@link ALIASES}). */
const ALIAS_INDEX: Record<string, number> = {
  top: 1,
  bottom: 2,
  left: 1,
  right: 2,
  "top-left": 1,
  "top-right": 2,
  "bottom-left": 3,
  "bottom-right": 4,
};

/** The wording used in the response. Used by {@link describeRegion}. */
const ALIAS_PHRASE: Record<string, string> = {
  top: "the top half",
  bottom: "the bottom half",
  left: "the left half",
  right: "the right half",
  "top-left": "the top-left quarter",
  "top-right": "the top-right quarter",
  "bottom-left": "the bottom-left quarter",
  "bottom-right": "the bottom-right quarter",
};

/** The listing of accepted names (used in the argument description and in the guidance on failure). */
export const REGION_NAMES = Object.keys(ALIASES);

/**
 * Parse a `region` specification.
 *
 * The accepted forms are `"full"`, a name (such as `"top-left"`) and a cell (`"3x3:5"`).
 * Upper case, underscores and spaces are tolerated.
 *
 * **It is never silently read as the whole page.** If the form is wrong, it fails and says how to correct it.
 */
export function parseRegion(spec: unknown): Region {
  if (spec === undefined || spec === null) return FULL_REGION;
  if (typeof spec !== "string") {
    throw new PdfError("Specify region as a string. Example: top-left or 3x3:5", "bad-region");
  }

  const key = spec.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (key === "" || key === "full") return FULL_REGION;

  const alias = ALIASES[key];
  if (alias !== undefined) {
    return { ...alias, index: ALIAS_INDEX[key] as number, label: key };
  }

  const m = /^(\d+)x(\d+):(\d+)$/.exec(key);
  if (m === null) {
    throw new PdfError(
      `The form of region is wrong: ${spec}. ` +
        `Specify it as full, ${REGION_NAMES.join(", ")}, or in the form 3x3:5.`,
      "bad-region",
    );
  }

  const cols = Number(m[1]);
  const rows = Number(m[2]);
  const index = Number(m[3]);
  const max = REGION_LIMITS.maxDivisions;
  if (cols < 1 || rows < 1 || cols > max || rows > max) {
    throw new PdfError(
      `The number of divisions is 1 to ${max} (requested: ${cols} horizontally x ${rows} vertically). ` +
        "To go finer than this, look at a coarse division first and then narrow it down.",
      "bad-region",
    );
  }
  if (index < 1 || index > cols * rows) {
    throw new PdfError(
      `The cell number is 1 to ${cols * rows} (requested: ${index}). ` +
        "Count from the top left to the right, and wrap to the next row at the right edge.",
      "bad-region",
    );
  }
  return { cols, rows, index, label: `${cols}x${rows}:${index}` };
}

/** A rectangle with the origin at the top left (`x0, y0, x1, y1`). The same order as the `Rect` of mupdf. */
export type Rect = [number, number, number, number];

/**
 * Cut the rectangle of a cell out of the rectangle of the page.
 *
 * **The overlap does not extend outside the page.**
 * A cell at an edge gets an overlap only on its inner cuts.
 */
export function regionRect(bounds: Rect, region: Region): Rect {
  const [x0, y0, x1, y1] = bounds;
  if (region.cols === 1 && region.rows === 1) return [x0, y0, x1, y1];

  const w = (x1 - x0) / region.cols;
  const h = (y1 - y0) / region.rows;
  const col = (region.index - 1) % region.cols;
  const row = Math.floor((region.index - 1) / region.cols);
  const ox = w * REGION_LIMITS.overlap;
  const oy = h * REGION_LIMITS.overlap;

  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  return [
    clamp(x0 + w * col - ox, x0, x1),
    clamp(y0 + h * row - oy, y0, y1),
    clamp(x0 + w * (col + 1) + ox, x0, x1),
    clamp(y0 + h * (row + 1) + oy, y0, y1),
  ];
}

/** State in words which part of the page was rendered. It goes into the response. */
export function describeRegion(region: Region): string {
  if (region.cols === 1 && region.rows === 1) return "the whole page";

  const col = (region.index - 1) % region.cols;
  const row = Math.floor((region.index - 1) / region.cols);
  const grid = `row ${row + 1}, column ${col + 1} of a grid of ${region.rows} rows by ${region.cols} columns`;
  const phrase = ALIAS_PHRASE[region.label];
  return phrase === undefined ? `${grid} (1/${region.cols * region.rows} of the page area)` : `${phrase} (${grid})`;
}
