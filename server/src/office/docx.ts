// © 2026 Yasuhiko Yokote

/**
 * Converts `.docx` (Word) to Markdown.
 *
 * The steps are **docx -> HTML -> Markdown**.
 * `mammoth` turns the docx structure into HTML, and `turndown` turns the HTML into Markdown.
 * The docx is not interpreted by this server's own code, because the rules for
 * lists, tables, footnotes and style inheritance are too involved to handle.
 *
 * **Images are dropped.**
 * By default they are embedded in the HTML as base64 data URIs,
 * but that makes the Markdown huge, and it does not reach the receiving side anyway.
 * **The fact that they were dropped is recorded in `omitted`.**
 */
import {
  clampMaxChars,
  OFFICE_LIMITS,
  OfficeError,
  tidy,
  truncateMarkdown,
  type OfficeMarkdown,
} from "./types.ts";

/**
 * Mapping table for picking up the headings of the Japanese edition of Word.
 *
 * By default `mammoth` maps by style ID (`Heading1`), but
 * in a Japanese environment **the style name is sometimes `見出し 1`.**
 * If they are not picked up, the whole document becomes a sequence of plain paragraphs.
 */
const STYLE_MAP = [
  "p[style-name='見出し 1'] => h1:fresh",
  "p[style-name='見出し 2'] => h2:fresh",
  "p[style-name='見出し 3'] => h3:fresh",
  "p[style-name='見出し 4'] => h4:fresh",
  "p[style-name='見出し 5'] => h5:fresh",
  "p[style-name='表題'] => h1:fresh",
  "p[style-name='副題'] => h2:fresh",
];

/**
 * Adjusts the HTML produced by `mammoth` into a form that can be converted to Markdown.
 *
 * Only two things are changed.
 *   - **Paragraphs inside cells are unwrapped.** Left as `<td><p>x</p></td>`,
 *     blank lines enter the table and the Markdown table breaks
 *   - **The first row is promoted to a header row.** A Markdown table requires a header row,
 *     but Word tables often do not mark one explicitly
 */
export function tidyHtmlForTables(html: string): string {
  return html
    .replace(/(<t[dh]>)\s*<p>([\s\S]*?)<\/p>\s*(<\/t[dh]>)/g, "$1$2$3")
    .replace(
      /<table>\s*<tr>([\s\S]*?)<\/tr>/g,
      (_m, row: string) =>
        `<table><thead><tr>${row.replace(/<td>/g, "<th>").replace(/<\/td>/g, "</th>")}</tr></thead>`,
    );
}

/** Removes `<img>` elements and returns how many were dropped. */
export function stripImages(html: string): { html: string; count: number } {
  let count = 0;
  const out = html.replace(/<img\b[^>]*>/g, () => {
    count++;
    return "";
  });
  return { html: out, count };
}

export interface DocxOptions {
  maxChars?: number;
}

export async function docxToMarkdown(
  input: Uint8Array,
  opts: DocxOptions = {},
): Promise<OfficeMarkdown> {
  if (input.byteLength > OFFICE_LIMITS.maxDocBytes) {
    throw new OfficeError(
      `The document is too large (${input.byteLength} bytes / limit ${OFFICE_LIMITS.maxDocBytes} bytes).`,
      "too-large",
    );
  }
  const maxChars = clampMaxChars(opts.maxChars);

  const mammoth = (await import("mammoth")).default;
  const TurndownService = (await import("turndown")).default;
  const { gfm } = await import("turndown-plugin-gfm");

  let html: string;
  let warnings: number;
  try {
    // **The image content is not read.** The function passed to `imgElement`
    // does not call `readAsBase64String`, so the bytes are never extracted
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(input) },
      {
        styleMap: STYLE_MAP,
        // Produces an `<img>` with an empty `src`. **The content is not read.** Removed below
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
      },
    );
    html = result.value;
    warnings = result.messages.length;
  } catch (e) {
    throw new OfficeError(
      `Could not open as a Word document: ${e instanceof Error ? e.message : "unknown cause"}`,
      "cannot-open",
    );
  }

  const stripped = stripImages(html);
  const service = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  service.use(gfm);
  const markdown = tidy(service.turndown(tidyHtmlForTables(stripped.html)));

  const omitted: string[] = [];
  if (stripped.count > 0) omitted.push(`${stripped.count} image(s)`);
  if (warnings > 0) omitted.push(`${warnings} formatting item(s) that could not be converted`);

  const { text, truncated } = truncateMarkdown(markdown, maxChars);
  return {
    markdown: text,
    omitted,
    truncated,
    fullChars: markdown.length,
    kind: "Word document",
  };
}
