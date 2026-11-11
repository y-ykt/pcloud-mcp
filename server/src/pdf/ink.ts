// © 2026 Yasuhiko Yokote

/**
 * Measure where on a page the content is.
 *
 * **Why this is needed.**
 * `region` made it possible to return part of a page at a high resolution, but
 * **the response gave no way to know where the figures are.**
 * In a measurement (patent drawings of 21 pages, page 1), the top-left 1/9 was requested and
 * rendered at 300 dpi, and yet **that area was almost blank**.
 * The resolution was sufficient; there was nothing to read.
 *
 * So the page is rendered once at a low resolution, the fraction of ink is measured, and
 * **the response states which cells the content is concentrated in.**
 *
 * The measurement is made once, on a fine 12x12 grid.
 * **12 is divisible by each of 1, 2, 3 and 4**, so
 * any division that `region` uses can be answered by summing cells.
 */

export const INK_LIMITS = {
  /**
   * Resolution used to measure ink.
   *
   * **It can be coarse, because the purpose is to locate the content, not to read it.**
   * An A4 page becomes about 298x421 pixels, and the cost is negligible.
   */
  probeDpi: 36,
  /** A pixel brighter than this lightness counts as white (0 to 255). */
  whiteAbove: 240,
  /** At or below this fraction, the area is described as "almost blank". */
  blankBelow: 0.02,
  /** A cell below this fraction is not listed (absolute lower bound). */
  notableAbove: 0.05,
  /**
   * A cell is not listed if it is below this fraction of the densest cell.
   *
   * **The absolute lower bound alone does not make a useful guide.**
   * In a measurement (page 1 of the patent drawings), 7 of 9 cells exceeded 5%, and
   * **almost all of them were listed.** The difference in density narrows the list.
   */
  notableRelative: 0.5,
  /** Limit on the number of cells listed. **The more cells are listed, the less the guide is worth.** */
  notableCount: 4,
} as const;

/**
 * Number of divisions per side.
 *
 * **It must be divisible by every number of divisions that `region` accepts (1 to 4).**
 * When changing it, check that it stays consistent with `REGION_LIMITS.maxDivisions`.
 */
export const INK_GRID = 12;

/** Distribution of ink. Cells run from the top left to the right, and continue on the next row at the right edge. */
export interface InkGrid {
  /** Number of divisions per side ({@link INK_GRID}). */
  n: number;
  /** For each cell, the number of pixels counted as ink. */
  ink: number[];
  /** For each cell, the number of pixels. */
  total: number[];
}

/**
 * Render the page at a low resolution and measure the distribution of ink.
 *
 * **Cropping is not considered.** The difference caused by the overlap has no meaning when stating where the content is.
 */
export function measureInk(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
): InkGrid {
  const scale = INK_LIMITS.probeDpi / 72;
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceGray,
    false,
  );
  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getStride();
    const comps = pixmap.getNumberOfComponents();
    const px = pixmap.getPixels();

    const n = INK_GRID;
    const ink = new Array<number>(n * n).fill(0);
    const total = new Array<number>(n * n).fill(0);
    for (let y = 0; y < height; y++) {
      const cy = Math.min(Math.floor((y * n) / height), n - 1);
      for (let x = 0; x < width; x++) {
        const cx = Math.min(Math.floor((x * n) / width), n - 1);
        const at = cy * n + cx;
        total[at] = (total[at] as number) + 1;
        if ((px[y * stride + x * comps] as number) < INK_LIMITS.whiteAbove) {
          ink[at] = (ink[at] as number) + 1;
        }
      }
    }
    return { n, ink, total };
  } finally {
    pixmap.destroy();
  }
}

/**
 * Compute the fraction of ink in the given cell.
 *
 * @throws if the number of divisions does not divide {@link INK_GRID}
 */
export function inkFraction(grid: InkGrid, cols: number, rows: number, index: number): number {
  if (grid.n % cols !== 0 || grid.n % rows !== 0) {
    // **Do not silently return a nearby value.** Stating the wrong location is worse than not answering
    throw new Error(`The ink grid of ${grid.n} cannot be divided into ${cols}x${rows}.`);
  }
  const perCol = grid.n / cols;
  const perRow = grid.n / rows;
  const col = (index - 1) % cols;
  const row = Math.floor((index - 1) / cols);

  let ink = 0;
  let total = 0;
  for (let y = row * perRow; y < (row + 1) * perRow; y++) {
    for (let x = col * perCol; x < (col + 1) * perCol; x++) {
      ink += grid.ink[y * grid.n + x] as number;
      total += grid.total[y * grid.n + x] as number;
    }
  }
  return total === 0 ? 0 : ink / total;
}

/** List the fraction of ink for each division, in the same notation as `region`. */
export function inkMap(grid: InkGrid, cols: number, rows: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 1; i <= cols * rows; i++) {
    // It goes into the response, so round to 2 decimal places
    out[`${cols}x${rows}:${i}`] = Math.round(inkFraction(grid, cols, rows, i) * 100) / 100;
  }
  return out;
}

/**
 * List the cells where the content is concentrated, densest first.
 *
 * **The list is narrowed in 3 stages.**
 * The absolute lower bound (excludes blank cells), the fraction relative to the densest cell
 * (excludes faint cells), and the limit on the count (avoids listing too many).
 */
export function notableCells(map: Record<string, number>): string[] {
  const values = Object.values(map);
  const max = values.length === 0 ? 0 : Math.max(...values);
  const floor = Math.max(INK_LIMITS.notableAbove, max * INK_LIMITS.notableRelative);
  return Object.entries(map)
    .filter(([, v]) => v >= floor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, INK_LIMITS.notableCount)
    .map(([k]) => k);
}

/** Decide from the fraction of ink whether the area is "almost blank". */
export function isBlank(fraction: number): boolean {
  return fraction <= INK_LIMITS.blankBelow;
}
