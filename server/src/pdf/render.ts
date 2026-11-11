// © 2026 Yasuhiko Yokote

/**
 * Render a PDF into one image per page.
 *
 * **Why images.**
 * Measurement showed that the bytes of a PDF cannot be passed to Claude as they are.
 * Extracting the text is another way, but the figures and tables in the PDF are lost.
 * With an image, what is visible on the page is passed as it is.
 *
 * `mupdf` is used here, in `ink.ts` and `text.ts` (which receive the loaded module from here),
 * and in `image/downscale.ts`.
 * **It is loaded when this is called.** This keeps calls to other tools such as `list`
 * from loading the WebAssembly.
 */

import { pickEncoding } from "../image/encode.ts";
import { PdfError } from "./errors.ts";
import { type InkGrid, measureInk } from "./ink.ts";
import { extractPageText, type PageText } from "./text.ts";
import { FULL_REGION, type Rect, type Region, regionRect } from "./region.ts";

// Callers can still import it from `render.ts` as before
export { PdfError };

/** Absolute limits that the implementation allows for rendering. */
export const PDF_LIMITS = {
  /** Number of pages rendered in one call. */
  maxPagesPerCall: 10,
  minDpi: 72,
  maxDpi: 300,
  defaultDpi: 150,
  /**
   * The default when `region` is given and `dpi` is omitted.
   *
   * **The automatic adjustment only lowers the value.**
   * Rendering only part of a page is done to raise the resolution, but
   * starting from 150, the same as for the whole page, stops at 150 and leaves the freed budget unused.
   * **Start from the limit and let it be lowered until the result fits.**
   */
  defaultRegionDpi: 300,
  /** Size of the PDF to open (bytes). */
  maxPdfBytes: 32 * 1024 * 1024,
  /**
   * The limit for one page (bytes).
   *
   * **When it is exceeded, the dpi is lowered and the page is rendered again.**
   * In measurements, pages of patent drawings were 137 to 169 KiB at 150 dpi and 69 to 87 KiB at 100 dpi.
   *
   * **It is constant regardless of the number of pages** (the measurements are recorded at {@link pageBudget}).
   * If one image is too large, that one image does not arrive.
   */
  maxPageBytes: 96 * 1024,
  /**
   * Total size of the images placed in one response (bytes).
   *
   * **What constrains this is not the 6 MB of Lambda.**
   * A large response uses up the capacity of the conversation, and **later calls no longer go through** (measured).
   * The value fits 2 to 3 pages in practice. When details are needed, narrow `pages` to 1 page.
   */
  maxTotalBytes: 256 * 1024,
  /**
   * Long edge of one image (pixels).
   *
   * **Anything beyond this is downscaled by the receiving side, so sending it gains nothing.**
   * In a measurement, rendering a 1/4 cell at 300 dpi gave a long edge of 1825 pixels.
   *
   * **The value at which downscaling starts has not been verified.**
   * Some descriptions give 1568, and others give 2576 for newer models.
   * **The smaller one is used.** Avoiding transfer that is discarded takes priority over details that are missed.
   */
  maxEdgePixels: 1568,
  /** Quality when encoding as JPEG. */
  quality: 80,
} as const;

/**
 * Parse a page specification.
 *
 * The accepted forms are `"1"` `"1-3"` `"1-3,7"` `"2, 5-6"`. Page numbers count from 1.
 * Duplicates are removed and the pages are sorted in ascending order.
 *
 * **Nothing is silently cut off.**
 * A page out of range or a count over the limit fails, with a note on how to correct it.
 */
export function parsePages(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim();
  if (trimmed === "") {
    throw new PdfError("pages is empty. Example: 1 or 1-3,7", "empty-spec");
  }

  const wanted = new Set<number>();
  for (const raw of trimmed.split(",")) {
    const part = raw.trim();
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (m === null) {
      throw new PdfError(
        `The form of pages is wrong: ${part}. Use the form 1 or 1-3, separated by commas.`,
        "bad-spec",
      );
    }
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1) {
      throw new PdfError("Page numbers count from 1.", "out-of-range");
    }
    if (to > pageCount) {
      throw new PdfError(
        `This PDF has only ${pageCount} pages (requested: ${part}).`,
        "out-of-range",
      );
    }
    if (to < from) {
      throw new PdfError(`The range is reversed: ${part}.`, "bad-spec");
    }
    for (let p = from; p <= to; p++) wanted.add(p);
  }

  const pages = [...wanted].sort((a, b) => a - b);
  if (pages.length > PDF_LIMITS.maxPagesPerCall) {
    throw new PdfError(
      `At most ${PDF_LIMITS.maxPagesPerCall} pages can be rendered at once ` +
        `(requested: ${pages.length} pages). Split the call.`,
      "too-many-pages",
    );
  }
  return pages;
}

/** Clamp the given dpi to the range that can be handled. */
export function clampDpi(dpi: unknown): number {
  if (typeof dpi !== "number" || !Number.isFinite(dpi)) return PDF_LIMITS.defaultDpi;
  return Math.min(Math.max(Math.round(dpi), PDF_LIMITS.minDpi), PDF_LIMITS.maxDpi);
}

export interface RenderedPage {
  /** Page number, counted from 1. */
  page: number;
  /** **The resolution actually used.** It can be lower than requested. */
  dpi: number;
  bytes: Uint8Array;
  /** Output format (decided by {@link pickEncoding}). */
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /**
   * Distribution of ink over **the whole page**, not over the cropped area.
   *
   * Used to show in the response where the content is.
   * In a measurement, there was a case where the top-left 1/9 was rendered at 300 dpi and was blank.
   */
  ink: InkGrid;
  /**
   * **The text that appears in the rendered area** (taken from the text layer of the PDF).
   *
   * It does not replace the image. The layout of a figure can only be known from the image, but
   * **reference signs and labels are more accurate here.**
   */
  text: PageText;
}

/** Specifies how to render. **Every field can be omitted.** */
export interface RenderOptions {
  /** The area to render. The whole page ({@link FULL_REGION}) when omitted. */
  region?: Region;
  /** Limit on the total of the returned images. The default is {@link PDF_LIMITS.maxTotalBytes}. */
  maxBytes?: number;
  /** Limit for one image. The default is decided by {@link pageBudget}. */
  maxPageBytes?: number;
}

export interface RenderResult {
  pageCount: number;
  /** The rendered pages. Empty when `pages` was not given. */
  rendered: RenderedPage[];
  /** The total size reached the limit, and the rest was not rendered. */
  truncated: boolean;
  /** Pages not rendered because of the size limit (ascending). */
  skipped: number[];
  /** Total bytes of the returned images. */
  totalBytes: number;
  /** **Pages rendered at a lower resolution than requested** (ascending). */
  reduced: number[];
  /**
   * **Pages whose resolution was held down by the limit on the long edge** (ascending).
   *
   * The reason differs from `reduced`. Here it is not the size budget but
   * **the number of pixels beyond which the receiving side downscales**.
   */
  edgeCapped: number[];
}

/**
 * Decide the size allotted to one page.
 *
 * **It is constant regardless of the number of pages.**
 *
 * Measurement showed that what constrains this is not the size of the whole response but **the size of one image**.
 *
 * | base64 of one image | Result |
 * |---|---|
 * | 43,876 | arrived |
 * | about 144,000 (when 8 images were sent together) | arrived |
 * | 216,520 | did not arrive |
 * | 308,796 | did not arrive |
 *
 * **If the budget is widened when only 1 page is requested, that one image no longer arrives.**
 * 96 KiB is 131,072 characters in base64, which is within the sizes that have arrived.
 */
export function pageBudget(_pageCount: number, _maxTotal: number): number {
  return PDF_LIMITS.maxPageBytes;
}

/**
 * Estimate the resolution to try next.
 *
 * **Lowering by 20% each time is too coarse a step.**
 * For example, starting from 160 dpi gives `160 -> 128 -> 102 -> 82`, which
 * **passes over the largest value that fits (around 96) and falls to 82.**
 * By measurement, 96 dpi was 94 KiB and 82 dpi was 84 KiB, so 10 KiB was discarded for nothing.
 *
 * The rendered size is roughly proportional to the number of pixels, and the number of pixels is
 * proportional to the square of the resolution.
 * From that, **the resolution that fits within the limit is estimated directly.**
 * The compression ratio varies with the content, so the estimate is set slightly low (times 0.97) to prevent overshooting.
 */
export function nextDpi(currentDpi: number, currentBytes: number, budget: number): number {
  if (currentBytes <= 0) return PDF_LIMITS.minDpi;
  const estimated = Math.floor(currentDpi * Math.sqrt(budget / currentBytes) * 0.97);
  // Always lower it. If it stops going down, the loop does not end
  const capped = Math.min(estimated, currentDpi - 1);
  return Math.max(capped, PDF_LIMITS.minDpi);
}

/** Limit on the number of times the estimate is repeated. **Finer steps beyond this gain nothing.** */
export const MAX_DPI_ATTEMPTS = 4;

/**
 * The usage of the budget below which raising the resolution again is considered worthwhile.
 *
 * The adjustment by {@link nextDpi} **only goes downward and stops as soon as the result fits.**
 * Measured (a scanned document of 2 pages, limit 96 KiB):
 *
 * | Area | Value chosen | Largest that fits |
 * |---|---|---|
 * | 1/4 | 105 dpi / 67,831 B | 126 dpi / 97,269 B |
 * | 1/9 | 155 dpi / 72,494 B | 181 dpi / 97,879 B |
 * | 1/16 | 207 dpi / 72,524 B | 237 dpi / 98,275 B |
 *
 * **It ended having used only 69 to 74% of the budget.**
 */
export const UPWARD_THRESHOLD = 0.8;

/**
 * Estimate the resolution to raise to when budget is left over.
 *
 * The estimate is the same as {@link nextDpi}, but **the direction is opposite, and it does not exceed the requested value.**
 * Rendering higher than requested would return something that was not asked for.
 */
export function higherDpi(
  currentDpi: number,
  currentBytes: number,
  budget: number,
  ceiling: number,
): number {
  if (currentBytes <= 0) return ceiling;
  const estimated = Math.floor(currentDpi * Math.sqrt(budget / currentBytes) * 0.97);
  return Math.min(Math.max(estimated, currentDpi + 1), ceiling);
}

/**
 * Compute the resolution that fits within the limit on the long edge ({@link PDF_LIMITS.maxEdgePixels}).
 *
 * @param widthPt   width of the area to render (points)
 * @param heightPt  height of the area to render (points)
 * @param requested the requested resolution. **The result never exceeds it**
 */
export function edgeCappedDpi(widthPt: number, heightPt: number, requested: number): number {
  const longEdge = Math.max(widthPt, heightPt);
  if (!(longEdge > 0)) return requested;
  const cap = Math.floor((72 * PDF_LIMITS.maxEdgePixels) / longEdge);
  // Keep the lower bound. Being downscaled is better than being too coarse to read
  return Math.max(Math.min(requested, cap), PDF_LIMITS.minDpi);
}

/**
 * Render only the given area of a page.
 *
 * **`page.toPixmap` has no way to crop.**
 * So the destination `Pixmap` is created with the size of the area, and the whole page is drawn into it.
 * mupdf does not draw outside the `Pixmap`, so this works as cropping.
 *
 * Setting the area to `FULL_REGION` gives the whole page, so **one code path is enough.**
 */
function renderRegion(
  mupdf: typeof import("mupdf"),
  page: import("mupdf").Page,
  dpi: number,
  region: Region,
): import("mupdf").Pixmap {
  const scale = dpi / 72;
  const matrix = mupdf.Matrix.scale(scale, scale);
  // Move the outline of the page into the pixel coordinates after rendering, then divide it
  const deviceRect = mupdf.Rect.transform(page.getBounds(), matrix);
  const [x0, y0, x1, y1] = regionRect(deviceRect as Rect, region);
  // Round to pixel boundaries. **Expand outward so that the 1 pixel at the edge is not lost**
  const left = Math.floor(x0);
  const top = Math.floor(y0);
  const bbox: Rect = [
    left,
    top,
    Math.max(Math.ceil(x1), left + 1),
    Math.max(Math.ceil(y1), top + 1),
  ];

  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
  try {
    // There is no transparency, so fill the background with white first
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    try {
      page.run(device, matrix);
      device.close();
    } finally {
      device.destroy();
    }
  } catch (e) {
    pixmap.destroy();
    throw e;
  }
  return pixmap;
}

/**
 * Open a PDF and, if needed, render pages.
 *
 * @param bytes    the bytes of the PDF. **The caller must already have verified their integrity**
 * @param spec     page specification. If `undefined`, the PDF is only opened and the page count and so on are returned
 * @param dpi      resolution. The page is scaled by its ratio to 72
 * @param options  the area and the size limits
 */
export async function renderPdf(
  bytes: Uint8Array,
  spec: string | undefined,
  dpi: number,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const region = options.region ?? FULL_REGION;
  const maxBytes = options.maxBytes ?? PDF_LIMITS.maxTotalBytes;

  if (bytes.byteLength > PDF_LIMITS.maxPdfBytes) {
    throw new PdfError(
      `The PDF is too large (${bytes.byteLength} bytes / limit ${PDF_LIMITS.maxPdfBytes} bytes).`,
      "pdf-too-large",
    );
  }

  const mupdf = await import("mupdf");

  let doc: import("mupdf").Document;
  try {
    doc = mupdf.Document.openDocument(bytes, "application/pdf");
  } catch (e) {
    throw new PdfError(
      `Could not open it as a PDF: ${e instanceof Error ? e.message : "unknown cause"}`,
      "not-a-pdf",
    );
  }

  try {
    if (doc.needsPassword()) {
      throw new PdfError(
        "This PDF is protected by a password. This connector cannot open it.",
        "password-protected",
      );
    }

    const pageCount = doc.countPages();
    if (spec === undefined) {
      return {
        pageCount,
        rendered: [],
        truncated: false,
        skipped: [],
        totalBytes: 0,
        reduced: [],
        edgeCapped: [],
      };
    }

    const wanted = parsePages(spec, pageCount);
    const perPage = options.maxPageBytes ?? pageBudget(wanted.length, maxBytes);

    const rendered: RenderedPage[] = [];
    const skipped: number[] = [];
    const reduced: number[] = [];
    const edgeCapped: number[] = [];
    let totalBytes = 0;

    for (const p of wanted) {
      // After the limit is reached, the rest is not rendered and is recorded as "pages not returned"
      if (totalBytes >= maxBytes) {
        skipped.push(p);
        continue;
      }

      const page = doc.loadPage(p - 1); // mupdf page numbers start at 0
      try {
        // **The location of the content does not depend on the area, so measure once per page**
        const ink = measureInk(mupdf, page);

        const renderAt = (atDpi: number): RenderedPage => {
          const pixmap = renderRegion(mupdf, page, atDpi, region);
          try {
            // **JPEG is chosen only when it is sufficiently smaller** (the reason is recorded at `pickEncoding`).
            // Simply choosing the smaller one would make text unreadable in line art for a saving of 7%
            const enc = pickEncoding(pixmap.asPNG(), pixmap.asJPEG(PDF_LIMITS.quality));
            return {
              page: p,
              dpi: atDpi,
              bytes: enc.bytes,
              mimeType: enc.mimeType,
              width: pixmap.getWidth(),
              height: pixmap.getHeight(),
              ink,
              text,
            };
          } finally {
            pixmap.destroy();
          }
        };

        // **Do not exceed the number of pixels beyond which the receiving side downscales.**
        // Sending the excess only gets it discarded, and adds no detail
        const [rx0, ry0, rx1, ry1] = regionRect(page.getBounds() as Rect, region);
        const requested = edgeCappedDpi(rx1 - rx0, ry1 - ry0, Math.round(dpi));
        // The text is narrowed to the area. **Listing text that is not in the image causes mix-ups**
        const text = extractPageText(mupdf, page, [rx0, ry0, rx1, ry1]);
        if (requested < Math.round(dpi)) edgeCapped.push(p);
        // **Lower the resolution until the page fits within the limit for one page.**
        // If it does not fit even at the lower bound, use that result (return it coarse rather than unreadable)
        let chosen: RenderedPage | undefined;
        let at = requested;
        for (let attempt = 0; attempt < MAX_DPI_ATTEMPTS; attempt++) {
          chosen = renderAt(at);
          if (chosen.bytes.byteLength <= perPage) break;
          if (at <= PDF_LIMITS.minDpi) break;
          at = nextDpi(at, chosen.bytes.byteLength, perPage);
        }
        if (chosen === undefined) continue;

        // **The downward adjustment stops as soon as the result fits, and left 26 to 31% of the budget unused** (measurements at `UPWARD_THRESHOLD`).
        // If budget is left over, raise the resolution again by 1 step only. If that does not fit, go back to the previous result
        if (chosen.dpi < requested && chosen.bytes.byteLength <= perPage * UPWARD_THRESHOLD) {
          const up = higherDpi(chosen.dpi, chosen.bytes.byteLength, perPage, requested);
          if (up > chosen.dpi) {
            const candidate = renderAt(up);
            if (candidate.bytes.byteLength <= perPage) chosen = candidate;
          }
        }

        // Even if 1 page alone exceeds the total limit, the first page is always returned
        if (rendered.length > 0 && totalBytes + chosen.bytes.byteLength > maxBytes) {
          skipped.push(p);
          continue;
        }
        // **Pages held down by the limit on the long edge are not counted in `reduced`.** Different reasons are not mixed
        if (chosen.dpi < requested) reduced.push(p);
        rendered.push(chosen);
        totalBytes += chosen.bytes.byteLength;
      } finally {
        page.destroy();
      }
    }

    return {
      pageCount,
      rendered,
      truncated: skipped.length > 0,
      skipped,
      totalBytes,
      reduced,
      edgeCapped,
    };
  } finally {
    doc.destroy();
  }
}
