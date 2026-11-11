// © 2026 Yasuhiko Yokote

/**
 * Common types and limits for converting Office documents to Markdown.
 *
 * **Why they are converted.**
 * `.docx`, `.xlsx` and `.pptx` are all XML wrapped in a ZIP,
 * and the receiving side cannot unpack them when they are passed as bytes.
 * They cannot be read as text either. **As Markdown, the content gets through.**
 *
 * **Each conversion exists because the content does not get through unconverted,
 * and the response always states that a conversion took place.**
 */

export const OFFICE_LIMITS = {
  /** Default number of characters of Markdown returned. */
  defaultMaxChars: 40_000,
  /** Limit on the number of characters the caller can specify. */
  maxMaxChars: 120_000,
  minMaxChars: 1_000,
  /** Size of a document that is opened (bytes). */
  maxDocBytes: 32 * 1024 * 1024,
  /** Limit on the number of rows returned as a table (`.xlsx`). */
  maxRows: 500,
  /** Limit on the number of columns returned as a table (`.xlsx`). */
  maxColumns: 50,
} as const;

/** The reason a document cannot be converted. */
export class OfficeError extends Error {
  reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "OfficeError";
    this.reason = reason;
  }
}

export interface OfficeMarkdown {
  markdown: string;
  /**
   * What was dropped during the conversion. **Nothing is dropped silently.**
   * Examples: `"3 image(s)"`, `"the second sheet and after"`
   */
  omitted: string[];
  /** The text was cut at the character limit. */
  truncated: boolean;
  /** Number of characters before the cut. */
  fullChars: number;
  /** A word that tells a person the source format. Example: `"Word document"`. */
  kind: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Clamps the number of characters specified by the caller to the supported range. */
export function clampMaxChars(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return OFFICE_LIMITS.defaultMaxChars;
  return clamp(Math.round(v), OFFICE_LIMITS.minMaxChars, OFFICE_LIMITS.maxMaxChars);
}

/**
 * Cuts the text at the character limit.
 *
 * **A line is not cut in the middle.** If a table or heading is cut partway,
 * the reader cannot tell whether it is broken or was cut.
 */
export function truncateMarkdown(md: string, maxChars: number): { text: string; truncated: boolean } {
  if (md.length <= maxChars) return { text: md, truncated: false };
  const cut = md.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf("\n");
  // If one line is so long that no line break is found, cut as is
  return { text: lastBreak > maxChars / 2 ? cut.slice(0, lastBreak) : cut, truncated: true };
}

/** Normalizes runs of whitespace. Does not leave the many blank lines the conversion produces. */
export function tidy(md: string): string {
  return md.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
