// © 2026 Yasuhiko Yokote

/**
 * Extract, from the text layer of a PDF, the text contained in the rendered area.
 *
 * **It does not replace the image. Both are returned.**
 * The layout and lines of a figure can only be known from the image, but **reference signs and labels can be passed accurately as text.**
 *
 * **Why this is needed.**
 * In a measurement (patent drawings of 21 pages, page 1), the receiving side returned an answer
 * that mentioned a "server device", a "terminal device" and "2-digit reference signs (10, 11, 12)".
 * **None of them exists in the document.** It was text made up to match the usual format of such drawings.
 * The text layer of the same page has **9 distinct 3-digit reference signs from 100 to 180**, and
 * extracting them mechanically leaves no room for made-up text.
 *
 * A scanned PDF has no text layer. **That fact is returned too.**
 * If an empty result is returned silently, the receiving side mistakes it for "a page with no text".
 */

import type { Rect } from "./region.ts";

export const TEXT_LIMITS = {
  /** Limit on the number of characters returned. In a measurement, 1 page of these drawings had 283 characters. */
  maxChars: 8_000,
  /**
   * The fraction of overlap at which a line counts as "contained in this area".
   *
   * A line that lies across a single cut has at least one half of its area in one of the two cells,
   * so it is listed in at least one of them. The 4% overlap between cells widens that margin.
   */
  minOverlap: 0.5,
} as const;

/**
 * One line and its position.
 *
 * The position is a **percentage with the top left of the page as 0,0 and the bottom right as 100,100**.
 * Cells (3x3) were too coarse to tell apart the names of 2 adjacent devices (measured).
 * **The page is the reference, not the area.** The same scale applies even when region changes.
 */
export interface TextLine {
  text: string;
  /** Position from the left (0 to 100). */
  x: number;
  /** Position from the top (0 to 100). */
  y: number;
}

export interface PageText {
  /** Whether there is a text layer. **False for a scanned PDF.** Also false when {@link failed} is true. */
  hasTextLayer: boolean;
  /**
   * Whether the extraction itself failed.
   * **When true, `hasTextLayer` says nothing about the page:** the page may well have text.
   */
  failed: boolean;
  /** Lines contained in the rendered area. Kept in the content order of the PDF. */
  lines: TextLine[];
  /** Total number of characters in {@link lines}. */
  chars: number;
  /** Whether the limit was reached and the rest was cut off. */
  truncated: boolean;
  /** Number of lines on the whole page (before narrowing to the area). */
  totalLines: number;
}

/** A rectangle returned by mupdf (in points, origin at the top left). */
interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Decide whether a line is contained in the area.
 *
 * **The decision uses the area of the overlap.** Testing whether the center is inside is too loose.
 * Even when the center is inside, only 1/4 of the area may be in the image
 * (when the line is half inside both vertically and horizontally).
 *
 * **Only lines with at least one half of their area inside are taken.**
 * A line that lies in 2 cells only (across a single cut) has at least one half in one of them,
 * so it does not disappear from every cell.
 * A line spread over 3 or more cells (across a corner where 4 cells meet, or longer than 2 cells)
 * can be below one half in every cell, and then no cell lists it.
 */
export function overlapsRegion(box: BBox, rect: Rect): boolean {
  const [x0, y0, x1, y1] = rect;
  const w = Math.max(Math.min(box.x + box.w, x1) - Math.max(box.x, x0), 0);
  const h = Math.max(Math.min(box.y + box.h, y1) - Math.max(box.y, y0), 0);
  const area = box.w * box.h;
  // A line with no area (such as an empty string) is decided by whether its point is inside
  if (!(area > 0)) {
    return box.x >= x0 && box.x <= x1 && box.y >= y0 && box.y <= y1;
  }
  return (w * h) / area >= TEXT_LIMITS.minOverlap;
}

/** Extract pairs of line and position from the JSON of the structured text. */
export function linesFromJson(json: unknown): { text: string; bbox: BBox }[] {
  const blocks = (json as { blocks?: unknown[] } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];

  const out: { text: string; bbox: BBox }[] = [];
  for (const block of blocks) {
    if (block === null || typeof block !== "object") continue;
    const lines = (block as { lines?: unknown[] }).lines;
    if (!Array.isArray(lines)) continue;
    for (const line of lines) {
      const l = line as { text?: unknown; bbox?: unknown };
      const text = typeof l.text === "string" ? l.text.trim() : "";
      if (text === "") continue;
      const b = l.bbox as Partial<BBox> | undefined;
      out.push({
        text,
        bbox: {
          x: typeof b?.x === "number" ? b.x : 0,
          y: typeof b?.y === "number" ? b.y : 0,
          w: typeof b?.w === "number" ? b.w : 0,
          h: typeof b?.h === "number" ? b.h : 0,
        },
      });
    }
  }
  return out;
}

/**
 * Narrow the lines to the area and take them up to the limit.
 *
 * **They are not sorted.** They are returned in the content order of the PDF.
 * These drawings are placed rotated by 90 degrees, and sorting by coordinates gives an unnatural order.
 */
export function selectLines(
  all: { text: string; bbox: BBox }[],
  rect: Rect | undefined,
  page: Rect,
): PageText {
  const within = rect === undefined ? all : all.filter((l) => overlapsRegion(l.bbox, rect));

  const [px0, py0, px1, py1] = page;
  const pct = (v: number, origin: number, span: number): number =>
    span > 0 ? Math.min(Math.max(Math.round(((v - origin) / span) * 100), 0), 100) : 0;

  const lines: TextLine[] = [];
  let chars = 0;
  let truncated = false;
  for (const l of within) {
    if (chars + l.text.length > TEXT_LIMITS.maxChars) {
      truncated = true;
      break;
    }
    // The position is given by the center of the line
    lines.push({
      text: l.text,
      x: pct(l.bbox.x + l.bbox.w / 2, px0, px1 - px0),
      y: pct(l.bbox.y + l.bbox.h / 2, py0, py1 - py0),
    });
    chars += l.text.length;
  }
  return { hasTextLayer: all.length > 0, failed: false, lines, chars, truncated, totalLines: all.length };
}

/**
 * Extract, from the text layer of the page, the text contained in the area.
 *
 * @param rect the area (in points). The whole page when omitted
 */
export function extractPageText(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
  rect?: Rect,
): PageText {
  let parsed: unknown;
  let structured: import("mupdf").StructuredText | undefined;
  try {
    structured = page.toStructuredText("preserve-whitespace");
    parsed = JSON.parse(structured.asJSON());
  } catch {
    // A failure to extract is not the same as "no text layer": the page may have text that could
    // not be read. `failed` tells the two apart, so that the caller does not report a scanned page.
    // The page is still rendered; only its text is missing
    return { hasTextLayer: false, failed: true, lines: [], chars: 0, truncated: false, totalLines: 0 };
  } finally {
    structured?.destroy();
  }
  return selectLines(linesFromJson(parsed), rect, page.getBounds() as Rect);
}
