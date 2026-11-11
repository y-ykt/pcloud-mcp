// © 2026 Yasuhiko Yokote

/**
 * Converts `.pptx` (PowerPoint) to Markdown.
 *
 * Opens the file with `fflate` and collects the text of each slide.
 *
 * | Part | What is taken |
 * |---|---|
 * | `ppt/presentation.xml` | **The slide order.** Not necessarily the order of the numbers in the file names |
 * | `ppt/_rels/presentation.xml.rels` | Mapping from the order to files |
 * | `ppt/slides/slideN.xml` | Title, body text, tables |
 * | `ppt/notesSlides/...` | Speaker notes |
 *
 * **The title is identified by the role of the shape.**
 * The shape that has `<p:ph type="title">` is the title of the slide.
 * Position and size are not used to decide.
 */
import {
  attr,
  cellText,
  collectElements,
  collectText,
  entryText,
  openZip,
} from "./ooxml.ts";
import {
  clampMaxChars,
  OFFICE_LIMITS,
  OfficeError,
  tidy,
  truncateMarkdown,
  type OfficeMarkdown,
} from "./types.ts";

/** Returns the slides in the order given by `presentation.xml`. */
export function slidePaths(zip: Record<string, Uint8Array>): string[] {
  const pres = entryText(zip, "ppt/presentation.xml");
  const rels = entryText(zip, "ppt/_rels/presentation.xml.rels");

  const target = new Map<string, string>();
  for (const r of collectElements(rels ?? "", "Relationship")) {
    const id = attr(r.attrs, "Id");
    const t = attr(r.attrs, "Target");
    if (id !== undefined && t !== undefined) target.set(id, t);
  }

  const out: string[] = [];
  for (const s of collectElements(pres ?? "", "sldId")) {
    // **`r:id` is looked up first.** `id` is the serial number of the slide, not a reference
    const rid = attr(s.attrs, "r:id") ?? attr(s.attrs, "id");
    const t = rid === undefined ? undefined : target.get(rid);
    if (t === undefined) continue;
    out.push(t.startsWith("/") ? t.slice(1) : t.startsWith("ppt/") ? t : `ppt/${t}`);
  }

  // Only when the order cannot be read, take the slides from the file names
  if (out.length === 0) {
    const names = Object.keys(zip).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    names.sort((a, b) => slideNumber(a) - slideNumber(b));
    return names;
  }
  return out;
}

function slideNumber(path: string): number {
  const m = /slide(\d+)\.xml$/.exec(path);
  return m === null ? 0 : Number(m[1]);
}

/** Returns the paragraphs of a text body, each as its text together with its level. Empty paragraphs are left out. */
function paragraphs(txBody: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const p of collectElements(txBody, "p")) {
    const pPr = collectElements(p.body, "pPr")[0];
    const level = Number(pPr === undefined ? 0 : (attr(pPr.attrs, "lvl") ?? 0));
    const text = collectText(p.body, "t").join("").trim();
    if (text !== "") out.push({ level: Number.isFinite(level) ? level : 0, text });
  }
  return out;
}

/** Converts the tables in a slide to Markdown. */
function tables(xml: string): string[] {
  const out: string[] = [];
  for (const tbl of collectElements(xml, "tbl")) {
    const rows = collectElements(tbl.body, "tr").map((tr) =>
      collectElements(tr.body, "tc").map((tc) => cellText(collectText(tc.body, "t").join(""))),
    );
    if (rows.length === 0) continue;
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
    const head = pad(rows[0]!);
    out.push(
      [
        `| ${head.join(" | ")} |`,
        `| ${head.map(() => "---").join(" | ")} |`,
        ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
      ].join("\n"),
    );
  }
  return out;
}

/** Converts one slide to Markdown. */
export function slideToMarkdown(xml: string, index: number): { md: string; images: number } {
  let title: string | undefined;
  const bullets: string[] = [];

  for (const sp of collectElements(xml, "sp")) {
    const isTitle = /<(?:\w+:)?ph\b[^>]*type="(?:title|ctrTitle)"/.test(sp.body);
    const txBody = collectElements(sp.body, "txBody")[0];
    if (txBody === undefined) continue;
    const paras = paragraphs(txBody.body);
    if (isTitle && title === undefined && paras.length > 0) {
      title = paras.map((p) => p.text).join(" ");
      continue;
    }
    for (const p of paras) {
      bullets.push(`${"  ".repeat(Math.min(p.level, 5))}- ${p.text}`);
    }
  }

  const parts = [`## ${title ?? `Slide ${index + 1}`}`];
  if (bullets.length > 0) parts.push(bullets.join("\n"));
  parts.push(...tables(xml));

  return { md: parts.join("\n\n"), images: collectElements(xml, "pic").length };
}

export interface PptxOptions {
  maxChars?: number;
  /** Include the speaker notes too. By default they are not included. */
  includeNotes?: boolean;
}

export async function pptxToMarkdown(
  input: Uint8Array,
  opts: PptxOptions = {},
): Promise<OfficeMarkdown> {
  if (input.byteLength > OFFICE_LIMITS.maxDocBytes) {
    throw new OfficeError(
      `The document is too large (${input.byteLength} bytes / limit ${OFFICE_LIMITS.maxDocBytes} bytes).`,
      "too-large",
    );
  }
  const maxChars = clampMaxChars(opts.maxChars);
  const zip = await openZip(input);
  const paths = slidePaths(zip);
  if (paths.length === 0) {
    throw new OfficeError("There are no slides", "empty");
  }

  const parts: string[] = [];
  let images = 0;
  let notes = 0;

  paths.forEach((path, i) => {
    const xml = entryText(zip, path);
    if (xml === undefined) return;
    const slide = slideToMarkdown(xml, i);
    images += slide.images;
    parts.push(slide.md);

    if (opts.includeNotes === true) {
      const rels = entryText(zip, path.replace(/slides\/(.+)$/, "slides/_rels/$1.rels"));
      const t = collectElements(rels ?? "", "Relationship")
        .map((r) => attr(r.attrs, "Target") ?? "")
        .find((x) => x.includes("notesSlide"));
      if (t !== undefined) {
        const notesXml = entryText(zip, `ppt/${t.replace(/^\.\.\//, "")}`);
        const text = collectText(notesXml ?? "", "t").join("").trim();
        if (text !== "") {
          parts.push(`> Speaker notes: ${text}`);
          notes++;
        }
      }
    }
  });

  const omitted: string[] = [];
  if (images > 0) omitted.push(`${images} image(s)`);
  if (opts.includeNotes !== true) omitted.push("speaker notes (can be fetched with include_notes)");

  const markdown = tidy(parts.join("\n\n"));
  const { text, truncated } = truncateMarkdown(markdown, maxChars);
  return {
    markdown: text,
    omitted,
    truncated,
    fullChars: markdown.length,
    kind: `PowerPoint (${paths.length} slide(s)${notes > 0 ? `, ${notes} note(s)` : ""})`,
  };
}
