// © 2026 Yasuhiko Yokote

/**
 * Failures that arise when handling a PDF.
 *
 * **Kept apart from `render.ts`.**
 * `region.ts` is meant to be a unit of pure functions only, but `render.ts` uses `region.ts`.
 * Placing the exception type in either one would create a circular reference, so it is a unit of its own.
 */

/** The reason a PDF cannot be rendered. The tool turns it into a response for the user. */
export class PdfError extends Error {
  reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "PdfError";
    this.reason = reason;
  }
}
