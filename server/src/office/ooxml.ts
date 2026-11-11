// © 2026 Yasuhiko Yokote

/**
 * Minimal helpers for reading OOXML (`.xlsx`, `.pptx`).
 *
 * **Why the format is interpreted here.**
 * Of the existing packages that handle `.xlsx`, the one on npm (SheetJS)
 * **has a vulnerability with no fixed version**, and the others bring in close to 80 dependencies.
 * The content of `.xlsx` and `.pptx`, limited to what is needed, is simple XML, and
 * **opening it with `fflate` (no dependencies, 832 KB) and reading it is enough.**
 *
 * Only `.docx` is not interpreted here. Lists, footnotes and style inheritance are involved,
 * and leaving them to `mammoth` is more reliable (`docx.ts`).
 *
 * **The XML is not parsed strictly here.**
 * The input is limited to the regular XML written by Excel and PowerPoint,
 * and all that is needed is to collect the content of elements in order.
 */
import { OfficeError } from "./types.ts";

/** Opens a ZIP and returns its entries keyed by name. */
export async function openZip(input: Uint8Array): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import("fflate");
  try {
    return unzipSync(input);
  } catch (e) {
    throw new OfficeError(
      `Could not open as an archive: ${e instanceof Error ? e.message : "unknown cause"}`,
      "cannot-open",
    );
  }
}

/** Returns a ZIP entry as a string, or `undefined` if it does not exist. */
export function entryText(zip: Record<string, Uint8Array>, name: string): string | undefined {
  const bytes = zip[name];
  return bytes === undefined ? undefined : new TextDecoder("utf-8").decode(bytes);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decodes XML character references. */
export function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const n = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    if (body.startsWith("#")) {
      const n = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

/**
 * Returns the content of the given element, in order of appearance.
 *
 * The namespace prefix does not matter (`t` matches both `<a:t>` and `<t>`).
 * An empty element (`<t/>`) is returned as an empty string.
 *
 * **The element name must be followed by whitespace, `/` or `>`.**
 * `\b` is not enough: it matches `<p:pic>` as `p` and
 * runs past the closing tag into the content that follows (an error confirmed by measurement).
 */
export function collectText(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?=[\\s/>])[^>]*?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    out.push(decodeXml(m[1] ?? ""));
  }
  return out;
}

/**
 * Returns the given element, with its attributes, in order of appearance.
 *
 * @returns an array of `{ attrs: attribute part of the start tag, body: content }`
 */
export function collectElements(
  xml: string,
  tag: string,
): { attrs: string; body: string }[] {
  const re = new RegExp(
    `<(?:\\w+:)?${tag}(?=[\\s/>])([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`,
    "g",
  );
  const out: { attrs: string; body: string }[] = [];
  for (const m of xml.matchAll(re)) {
    out.push({ attrs: m[1] ?? "", body: m[2] ?? "" });
  }
  return out;
}

/**
 * Looks up one attribute in the attribute part of a start tag.
 *
 * **The attribute name must be preceded by whitespace or the start of the string.**
 * `\b` is not enough: a lookup of `id` matches `r:id`
 * (because there is a word boundary between `:` and `i`).
 * This error, confirmed by measurement, caused the slide order to be read wrongly.
 */
export function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[:.]/g, "\\$&")}="([^"]*)"`).exec(attrs);
  return m === null ? undefined : decodeXml(m[1]!);
}

/**
 * Makes a value safe to use as a cell of a Markdown table.
 *
 * `|` separates cells, so it is escaped. A line break breaks the table, so it is replaced with one space.
 */
export function cellText(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** `A` -> 0, `Z` -> 25, `AA` -> 26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}
