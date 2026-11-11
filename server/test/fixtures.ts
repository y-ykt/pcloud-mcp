// © 2026 Yasuhiko Yokote

/**
 * Builds the files used in the tests (used from `*.test.ts`).
 *
 * **No binary file is kept in the repository.**
 * PDF, PNG and OOXML can all be built in code,
 * and that lets each test vary the content.
 *
 * This file is not a test itself (`npm test` runs only `*.test.ts`).
 */
import { crc32, deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";

/** Builds a ZIP from pairs of name and content. */
export const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

// ---------------------------------------------------------------- PNG

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(8 + data.length, crc32(body));
  return out;
}

/**
 * A GIF of 1x1 pixel (black), built from the GIF89a format.
 *
 * Header, logical screen (1x1, a global color table of 2 colors), the color table,
 * one image descriptor, and the pixel as LZW codes of 3 bits: clear, color 0, end.
 */
export function makeGif(): Uint8Array {
  return new Uint8Array([
    ...Buffer.from("GIF89a"),
    1, 0, 1, 0, // width and height, little-endian
    0x80, 0, 0, // a global color table with 2 entries; background index; aspect ratio
    0, 0, 0, 255, 255, 255, // the color table: black, white
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, // image descriptor: position 0,0, size 1x1, no local table
    2, // LZW minimum code size
    2, 0x44, 0x01, // a data block of 2 bytes: the codes 4 (clear), 0, 5 (end), least significant bit first
    0, // end of the data blocks
    0x3b, // trailer
  ]);
}

/**
 * A lossless WebP of 1x1 pixel (black), built from the WebP lossless bitstream format.
 *
 * After the signature byte come 14 bits each of width-1 and height-1, the alpha flag and the version.
 * Then "no transform", "no color cache" and "no meta prefix codes" (1 bit each), and
 * 5 prefix codes that each hold a single symbol (4 bits each), so the pixel itself takes no bits.
 * **`dwebp` decodes these bytes as a 1x1 lossless image** (checked when this was written).
 */
export function makeWebp(): Uint8Array {
  const bitstream = [0x2f, 0, 0, 0, 0, 0x88, 0x88, 0x08];
  const body = [...Buffer.from("WEBPVP8L"), bitstream.length, 0, 0, 0, ...bitstream];
  return new Uint8Array([...Buffer.from("RIFF"), body.length, 0, 0, 0, ...body]);
}

/**
 * The header of a WebP of `width` x `height` in the extended format. **A header only, not an image.**
 *
 * Enough for the code under test, which reads the size of a WebP from its header and never decodes it.
 */
export function makeWebpHeader(width: number, height: number): Uint8Array {
  const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  const payload = [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const body = [...Buffer.from("WEBPVP8X"), payload.length, 0, 0, 0, ...payload];
  return new Uint8Array([...Buffer.from("RIFF"), body.length, 0, 0, 0, ...body]);
}

/**
 * A PNG of `width` x `height`, solid black unless `noisy`.
 *
 * When `noisy` is true, the values vary from pixel to pixel. **Compression then stops working,
 * so it can be used for tests that hit the size limit.**
 */
export function makePng(width: number, height: number, noisy = false): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type
    for (let x = 0; x < width; x++) {
      if (noisy) {
        // No regular pattern. No random numbers either (to keep the tests reproducible)
        raw[o++] = (x * 7 + y * 13) % 251;
        raw[o++] = (x * 29 + y * 3) % 253;
        raw[o++] = (x * 17 + y * 31) % 247;
      } else {
        o += 3; // all 0 (solid black)
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- PDF

/** A PDF with the given number of empty pages. The cross-reference table is correct too. */
export function makePdf(pageCount: number, widthPt = 200, heightPt = 100): Uint8Array {
  const pageIds = Array.from({ length: pageCount }, (_, i) => 3 + i);
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...pageIds.map(() => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] >>`),
  ]);
}

/**
 * A one-page PDF in which **only the top-left quarter is filled with black**.
 *
 * Used to check the position of a crop.
 * PDF coordinates count from the bottom up, so **rendering still succeeds when top and bottom are swapped.**
 * Reading the pixels of the filled area reveals such a swap.
 */
export function makeMarkedPdf(widthPt = 400, heightPt = 200): Uint8Array {
  // The origin is the bottom-left corner. The top half is the larger y
  const stream = `0 g 0 ${heightPt / 2} ${widthPt / 2} ${heightPt / 2} re f\n`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ]);
}

/**
 * A one-page PDF in which **only the given fractional rectangle is filled with black**.
 *
 * The rectangle is given as fractions from the top-left corner (`u0, v0, u1, v1`, each from 0 to 1).
 * **A symmetric fill such as the top-left quarter does not reveal a mix-up of rows and columns.**
 * Used to fill an asymmetric area.
 */
export function makeInkPdf(
  rect: [number, number, number, number],
  widthPt = 360,
  heightPt = 240,
): Uint8Array {
  const [u0, v0, u1, v1] = rect;
  // The PDF origin is the bottom-left corner. Convert fractions from the top edge into coordinates from the bottom edge
  const x = u0 * widthPt;
  const y = (1 - v1) * heightPt;
  const w = (u1 - u0) * widthPt;
  const h = (v1 - v0) * heightPt;
  const stream = `0 g ${x} ${y} ${w} ${h} re f\n`;
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ]);
}

/**
 * A one-page PDF **with a text layer**.
 *
 * Positions are given in PDF coordinates (origin at the bottom-left corner, in points).
 * Used to test what is written as text, which a rendered image does not show.
 */
export function makeTextPdf(
  items: [text: string, x: number, y: number][],
  widthPt = 200,
  heightPt = 200,
): Uint8Array {
  const stream =
    "BT /F1 12 Tf\n" +
    items.map(([t, x, y]) => `1 0 0 1 ${x} ${y} Tm (${t}) Tj`).join("\n") +
    "\nET\n";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] ` +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]);
}

/** Assembles a PDF with a cross-reference table from indirect objects listed in number order. */
function assemblePdf(objects: string[]): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

// ---------------------------------------------------------------- OOXML

/** A minimal `.docx` that has paragraphs only. */
export function makeDocx(paragraphs: string[]): Uint8Array {
  return zipOf({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml":
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join("") +
      "</w:body></w:document>",
  });
}

/** A minimal `.xlsx` that has one sheet only. */
export function makeXlsx(rows: string[][]): Uint8Array {
  const col = (i: number) => String.fromCharCode(65 + i);
  return zipOf({
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      rows
        .map(
          (r, y) =>
            `<row r="${y + 1}">` +
            r
              .map((v, x) => `<c r="${col(x)}${y + 1}" t="inlineStr"><is><t>${v}</t></is></c>`)
              .join("") +
            "</row>",
        )
        .join("") +
      "</sheetData></worksheet>",
  });
}
