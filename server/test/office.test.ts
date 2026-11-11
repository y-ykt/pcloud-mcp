// © 2026 Yasuhiko Yokote

/**
 * Tests for the Office document to Markdown conversion (`src/office/`).
 *
 * **The documents used by the tests are built here**, so that no binary is kept in the repository.
 * `.docx`, `.xlsx` and `.pptx` are all XML inside a ZIP archive,
 * so they can be built with `fflate`, which is already a runtime dependency.
 */
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { describe, it } from "node:test";
import { docxToMarkdown, stripImages, tidyHtmlForTables } from "../src/office/docx.ts";
import { pptxToMarkdown, slidePaths } from "../src/office/pptx.ts";
import { OfficeError } from "../src/office/types.ts";
import { chooseRow, dateStyleIndexes, rowsToTable, serialToDate, xlsxToMarkdown } from "../src/office/xlsx.ts";
import { callTool, officeKind } from "../src/mcp/tools.ts";
import type { ToolResult } from "../src/mcp/protocol.ts";
import { PCloudClient } from "../src/pcloud/client.ts";
import { loadConfig } from "../src/config.ts";
import { setForbiddenNames } from "../src/guard/path.ts";
import { createHash } from "node:crypto";

const zip = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/**
 * Runs `read_file` once against a fake pCloud transport.
 *
 * It exists to check the whole path, including how the result is assembled
 * (summary sentence, notes, `structuredContent`).
 */
async function runDownload(
  bytes: Uint8Array,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const impl = ((input: string | URL) => {
    const s = String(input);
    if (s.includes("p.pcloud.com")) return Promise.resolve(new Response(bytes));
    const u = new URL(s);
    const body =
      u.pathname === "/stat"
        ? {
            result: 0,
            metadata: {
              name: "a.docx",
              isfolder: false,
              fileid: 1,
              size: bytes.byteLength,
              contenttype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            },
          }
        : u.pathname === "/getfilelink"
          ? { result: 0, hosts: ["p.pcloud.com"], path: "/x", size: bytes.byteLength, expires: "" }
          : { result: 0, sha1 };
    return Promise.resolve(new Response(JSON.stringify(body)));
  }) as unknown as typeof fetch;

  const client = new PCloudClient({
    apiHost: "https://api.pcloud.com",
    accessToken: "t",
    fetchImpl: impl,
  });
  const cfg = loadConfig({
    RESOURCE_URL: "https://x.example.com/mcp",
    COGNITO_ISSUER: "https://y.example.com",
    COGNITO_CLIENT_ID: "c",
  } as NodeJS.ProcessEnv);
  // The handler does this in the server. A path cannot be checked before the names are set
  setForbiddenNames(cfg.forbiddenNames);
  return callTool(client, cfg, "read_file", { path: "/a.docx", ...args });
}

// ---------------------------------------------------------------- .docx

const DOCX = zip({
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
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Business report</w:t></w:r></w:p>' +
    "<w:p><w:r><w:t>Sales are </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>up 12%</w:t></w:r><w:r><w:t>.</w:t></w:r></w:p>" +
    "<w:tbl>" +
    "<w:tr><w:tc><w:p><w:r><w:t>Category</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>" +
    "<w:tr><w:tc><w:p><w:r><w:t>Domestic</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1,234</w:t></w:r></w:p></w:tc></w:tr>" +
    "</w:tbl></w:body></w:document>",
});

describe("tidyHtmlForTables - table cleanup", () => {
  it("unwraps a paragraph inside a cell", () => {
    assert.match(tidyHtmlForTables("<table><tr><td><p>a</p></td></tr>"), /<th>a<\/th>/);
  });

  it("**promotes the first row to a header row**", () => {
    const out = tidyHtmlForTables("<table><tr><td>A</td></tr><tr><td>B</td></tr></table>");
    assert.match(out, /<thead><tr><th>A<\/th><\/tr><\/thead>/);
    assert.match(out, /<tr><td>B<\/td><\/tr>/, "the second row must not become a header");
  });
});

describe("stripImages - dropping images", () => {
  it("counts and removes them", () => {
    const r = stripImages('<p>a<img src=""/>b<img alt="figure" src="x"></p>');
    assert.equal(r.count, 2);
    assert.equal(r.html, "<p>ab</p>");
  });

  it("0 when there are none", () => {
    assert.deepEqual(stripImages("<p>a</p>"), { html: "<p>a</p>", count: 0 });
  });
});

describe("docxToMarkdown", () => {
  it("converts headings, emphasis and tables to Markdown", async () => {
    const r = await docxToMarkdown(DOCX);
    assert.match(r.markdown, /^# Business report$/m);
    assert.match(r.markdown, /\*\*up 12%\*\*/);
    assert.match(r.markdown, /^\| Category \| Amount \|$/m);
    assert.match(r.markdown, /^\| Domestic \| 1,234 \|$/m);
    assert.equal(r.kind, "Word document");
  });

  it("truncates over the limit and keeps the total character count", async () => {
    const r = await docxToMarkdown(DOCX, { maxChars: 1000 });
    const full = await docxToMarkdown(DOCX);
    assert.equal(r.fullChars, full.markdown.length);
  });

  it("something that is not a Word document gives OfficeError", async () => {
    await assert.rejects(
      docxToMarkdown(new TextEncoder().encode("This is not a Word document")),
      (e: unknown) => e instanceof OfficeError && e.reason === "cannot-open",
    );
  });
});

// ---------------------------------------------------------------- .xlsx

const XLSX = zip({
  "xl/workbook.xml":
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/><sheet name="Totals &amp; notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<si><t>Date</t></si><si><t>Description</t></si><si><r><t>Rent</t></r><r><t> (October)</t></r></si><si><t>power | gas</t></si></sst>",
  "xl/styles.xml":
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts><numFmt numFmtId="164" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/><numFmt numFmtId="165" formatCode="#,##0&quot;円&quot;"/></numFmts>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>',
  "xl/worksheets/sheet1.xml":
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="A2" s="1"><v>45566</v></c><c r="B2" t="s"><v>2</v></c></row>' +
    '<row r="3"><c r="A3" s="2"><v>45597</v></c><c r="B3" t="s"><v>3</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>Remarks</t></is></c><c r="C4" s="3"><v>1234</v></c></row>' +
    '<row r="5"><c r="A5" t="b"><v>1</v></c><c r="B5" t="e"><v>#DIV/0!</v></c></row>' +
    "</sheetData></worksheet>",
  "xl/worksheets/sheet2.xml":
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1"><v>99</v></c></row></sheetData></worksheet>',
});

describe("serialToDate - Excel serial numbers", () => {
  it("an ordinary date", () => {
    assert.equal(serialToDate(45566), "2024-10-01");
    assert.equal(serialToDate(45597), "2024-11-01");
  });

  it("includes the time when the value has one", () => {
    assert.equal(serialToDate(45566.5), "2024-10-01 12:00:00");
  });

  it("**is not off by one day before the leap-year bug either**", () => {
    assert.equal(serialToDate(1), "1900-01-01");
    assert.equal(serialToDate(59), "1900-02-28");
    assert.equal(serialToDate(61), "1900-03-01");
  });

  it("says so for the date that does not exist", () => {
    assert.match(serialToDate(60), /1900-02-29/);
  });
});

describe("dateStyleIndexes - cells displayed as dates", () => {
  const styles =
    '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/>' +
    '<numFmt numFmtId="165" formatCode="#,##0&quot;円&quot;"/></numFmts>' +
    '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/></cellXfs></styleSheet>';

  it("finds a built-in date format", () => {
    assert.ok(dateStyleIndexes(styles).has(1), "format 14 (date) was not found");
  });

  it("finds a custom date format too", () => {
    assert.ok(dateStyleIndexes(styles).has(2), "yyyy/mm/dd was not found");
  });

  it("**does not take a currency format for a date**", () => {
    assert.ok(!dateStyleIndexes(styles).has(3), '#,##0"円" was treated as a date');
  });

  it("the General format is not a date", () => {
    assert.ok(!dateStyleIndexes(styles).has(0));
  });

  it("does not fail when styles.xml is absent", () => {
    assert.equal(dateStyleIndexes(undefined).size, 0);
  });
});

describe("rowsToTable", () => {
  it("uses the first row as the header", () => {
    assert.equal(rowsToTable([["A", "B"], ["1", "2"]]), "| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("pads a short row with empty cells", () => {
    assert.match(rowsToTable([["A", "B"], ["1"]]), /\| 1 \|  \|/);
  });

  it("an empty sheet", () => {
    assert.match(rowsToTable([]), /\(empty sheet\)/);
  });
});

describe("xlsxToMarkdown", () => {
  it("makes a heading and a table for each sheet", async () => {
    const r = await xlsxToMarkdown(XLSX);
    assert.match(r.markdown, /^## Ledger$/m);
    assert.match(r.markdown, /^## Totals & notes$/m, "the character reference in the sheet name was not decoded");
    assert.match(r.kind, /2 sheet\(s\)/);
  });

  it("**renders both built-in and custom date formats as dates**", async () => {
    const r = await xlsxToMarkdown(XLSX);
    assert.match(r.markdown, /2024-10-01/);
    assert.match(r.markdown, /2024-11-01/);
  });

  it("returns a number that is not a date as is", async () => {
    const r = await xlsxToMarkdown(XLSX);
    assert.match(r.markdown, /1234/, "a number with a currency format became a date");
  });

  it("joins a string that is split into formatted runs", async () => {
    assert.match((await xlsxToMarkdown(XLSX)).markdown, /Rent \(October\)/);
  });

  it("**escapes `|`**", async () => {
    assert.match((await xlsxToMarkdown(XLSX)).markdown, /power \\\| gas/);
  });

  it("handles inline strings, booleans and errors", async () => {
    const md = (await xlsxToMarkdown(XLSX)).markdown;
    assert.match(md, /Remarks/);
    assert.match(md, /TRUE/);
    assert.match(md, /#DIV\/0!/);
  });

  it("something that is not an Excel workbook gives OfficeError", async () => {
    await assert.rejects(
      xlsxToMarkdown(zip({ "a.txt": "x" })),
      (e: unknown) => e instanceof OfficeError,
    );
  });
});

describe("chooseRow - where to place a control that spans rows", () => {
  const H = 190_500; // default row height (EMU)

  it("that row when it fits in a single row", () => {
    assert.deepEqual(chooseRow(5, 50_000, 5, 120_000), { row: 5, ambiguous: false });
  });

  it("**the upper row when most of it is in the upper row**", () => {
    // 90% in the upper row, 10% in the lower row
    assert.deepEqual(chooseRow(5, H * 0.1, 6, H * 0.1), { row: 5, ambiguous: false });
  });

  it("**the lower row when most of it is in the lower row**", () => {
    // 10% in the upper row, 90% in the lower row. Looking only at `<from>` would be off by one row
    assert.deepEqual(chooseRow(5, H * 0.9, 6, H * 0.9), { row: 6, ambiguous: false });
  });

  it("**marks it as ambiguous when it is split evenly**", () => {
    const r = chooseRow(5, H / 2, 6, H / 2);
    assert.equal(r.ambiguous, true);
  });

  it("the fully covered row when it spans three or more rows", () => {
    assert.deepEqual(chooseRow(5, 0, 8, 0), { row: 6, ambiguous: false });
  });

  it("does not break when `to` is before `from`", () => {
    assert.deepEqual(chooseRow(5, 0, 4, 0), { row: 5, ambiguous: false });
  });
});

describe("form controls (option buttons)", () => {
  /** An `.xlsx` with "YES / NO" option buttons. Only YES is selected. */
  const withControls = zip({
    "xl/workbook.xml":
      '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Questions" sheetId="1" r:id="rId1"/><sheet name="Blank" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    // YES / NO are in row 3 (r="3"). **Row 2 is absent, so the rows are read without the gap**
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Have you been abroad</t></is></c>' +
      '<c r="B3" t="inlineStr"><is><t>YES</t></is></c>' +
      '<c r="C3" t="inlineStr"><is><t>NO</t></is></c></row>' +
      "</sheetData>" +
      // Anchor positions count from 0 (row=2 is row 3 of the sheet)
      '<control shapeId="1" r:id="rIdY" name="Option Button 1">' +
      "<controlPr><anchor><from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff>" +
      "<xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></from></anchor></controlPr></control>" +
      '<control shapeId="2" r:id="rIdN" name="Option Button 2">' +
      "<controlPr><anchor><from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff>" +
      "<xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></from></anchor></controlPr></control>" +
      '<control shapeId="3" r:id="rIdG" name="Group Box 1">' +
      "<controlPr><anchor><from><xdr:col>0</xdr:col><xdr:row>2</xdr:row></from></anchor></controlPr></control>" +
      "</worksheet>",
    "xl/worksheets/sheet2.xml": '<?xml version="1.0"?><worksheet><sheetData/></worksheet>',
    "xl/worksheets/_rels/sheet1.xml.rels":
      '<?xml version="1.0"?><Relationships>' +
      '<Relationship Id="rIdY" Target="../ctrlProps/ctrlProp1.xml"/>' +
      '<Relationship Id="rIdN" Target="../ctrlProps/ctrlProp2.xml"/>' +
      '<Relationship Id="rIdG" Target="../ctrlProps/ctrlProp3.xml"/></Relationships>',
    "xl/ctrlProps/ctrlProp1.xml":
      '<?xml version="1.0"?><formControlPr objectType="Radio" checked="Checked" firstButton="1"/>',
    "xl/ctrlProps/ctrlProp2.xml": '<?xml version="1.0"?><formControlPr objectType="Radio"/>',
    "xl/ctrlProps/ctrlProp3.xml": '<?xml version="1.0"?><formControlPr objectType="GBox"/>',
  });

  it("**distinguishes the selected button from the unselected one**", async () => {
    const r = await xlsxToMarkdown(withControls);
    assert.match(r.markdown, /☑ YES/, "the selected state is not shown");
    assert.match(r.markdown, /☐ NO/, "the unselected state is not shown");
  });

  it("**places it in the correct row even when rows are missing**", async () => {
    // The sheet has only rows 1 and 3. The array index and the sheet row number differ
    const r = await xlsxToMarkdown(withControls);
    assert.ok(!/☑ Question/.test(r.markdown), "it was placed in row 1");
  });

  it("a group box has no state, so it is not placed", async () => {
    const r = await xlsxToMarkdown(withControls);
    assert.ok(!/☑ Have you been abroad|☐ Have you been abroad/.test(r.markdown));
  });

  it("puts the number of selected buttons in the kind", async () => {
    assert.match((await xlsxToMarkdown(withControls)).kind, /, 1 selected\)/);
  });

  it("**omits an empty sheet and reports that it was dropped**", async () => {
    const r = await xlsxToMarkdown(withControls);
    assert.ok(!r.markdown.includes("## Blank"), "the empty sheet was output");
    assert.ok(r.omitted.some((o) => o.includes("1 empty sheet(s)")));
  });

  it("nothing happens in a workbook without controls", async () => {
    const r = await xlsxToMarkdown(XLSX);
    assert.ok(!/☑|☐/.test(r.markdown));
    assert.ok(!/selected/.test(r.kind));
  });
});

// ---------------------------------------------------------------- .pptx

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';

const sp = (ph: string, paras: [number, string][]): string =>
  `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>` +
  paras
    .map(
      ([lvl, t]) =>
        `<a:p>${lvl > 0 ? `<a:pPr lvl="${lvl}"/>` : ""}<a:r><a:t>${t}</a:t></a:r></a:p>`,
    )
    .join("") +
  "</p:txBody></p:sp>";

const PPTX = zip({
  "ppt/presentation.xml":
    `<?xml version="1.0"?><p:presentation ${NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    '<p:sldIdLst><p:sldId id="256" r:id="rIdB"/><p:sldId id="257" r:id="rIdA"/></p:sldIdLst></p:presentation>',
  "ppt/_rels/presentation.xml.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdA" Target="slides/slide1.xml"/><Relationship Id="rIdB" Target="slides/slide2.xml"/></Relationships>',
  "ppt/slides/slide1.xml":
    `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>` +
    sp('<p:ph type="ctrTitle"/>', [[0, "Summary"]]) +
    sp("", [[0, "Three key points"]]) +
    "</p:spTree></p:cSld></p:sld>",
  "ppt/slides/slide2.xml":
    `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>` +
    sp('<p:ph type="title"/>', [[0, "Sales trend"]]) +
    sp("", [
      [0, "Domestic sales are steady"],
      [1, "The capital region leads"],
    ]) +
    '<p:pic><p:nvPicPr><p:cNvPr id="9" name="Figure"/></p:nvPicPr></p:pic>' +
    "<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Quarter</a:t></a:r></a:p></a:txBody></a:tc></a:tr>" +
    "<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>" +
    "</p:spTree></p:cSld></p:sld>",
  "ppt/slides/_rels/slide2.xml.rels":
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
  "ppt/notesSlides/notesSlide1.xml":
    `<?xml version="1.0"?><p:notes ${NS}><p:cSld><p:spTree><p:sp><p:txBody>` +
    "<a:p><a:r><a:t>Explain where the numbers come from</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>",
});

describe("slidePaths - slide order", () => {
  it("**follows the order in presentation.xml, not the file name order**", async () => {
    const { unzipSync } = await import("fflate");
    assert.deepEqual(slidePaths(unzipSync(PPTX)), [
      "ppt/slides/slide2.xml",
      "ppt/slides/slide1.xml",
    ]);
  });
});

describe("pptxToMarkdown", () => {
  it("turns titles into headings and keeps the order", async () => {
    const r = await pptxToMarkdown(PPTX);
    const heads = r.markdown.split("\n").filter((l) => l.startsWith("## "));
    assert.deepEqual(heads, ["## Sales trend", "## Summary"]);
  });

  it("keeps the bullet levels", async () => {
    const r = await pptxToMarkdown(PPTX);
    assert.match(r.markdown, /^- Domestic sales are steady$/m);
    assert.match(r.markdown, /^ {2}- The capital region leads$/m);
  });

  it("converts a table to Markdown", async () => {
    assert.match((await pptxToMarkdown(PPTX)).markdown, /^\| Quarter \|$/m);
  });

  it("counts and drops images", async () => {
    assert.ok((await pptxToMarkdown(PPTX)).omitted.some((o) => o.includes("1 image(s)")));
  });

  it("does not include speaker notes by default", async () => {
    const r = await pptxToMarkdown(PPTX);
    assert.ok(!r.markdown.includes("where the numbers come from"));
    assert.ok(r.omitted.some((o) => o.includes("speaker notes")));
  });

  it("**includes the notes when asked**", async () => {
    const r = await pptxToMarkdown(PPTX, { includeNotes: true });
    assert.match(r.markdown, /Speaker notes: Explain where the numbers come from/);
    assert.match(r.kind, /, 1 note\(s\)/);
  });

  it("no slides gives OfficeError", async () => {
    await assert.rejects(
      pptxToMarkdown(zip({ "a.txt": "x" })),
      (e: unknown) => e instanceof OfficeError && e.reason === "empty",
    );
  });
});

// ---------------------------------------------------------------- truncation note

describe("the note shown on truncation", () => {
  /** Builds a `.docx` whose Markdown is long enough to exceed the character limits used below. */
  const bigDocx = (paragraphs: number): Uint8Array =>
    zip({
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
        Array.from(
          { length: paragraphs },
          (_, i) => `<w:p><w:r><w:t>Paragraph ${i} ${"x".repeat(60)}</w:t></w:r></w:p>`,
        ).join("") +
        "</w:body></w:document>",
    });

  it("**gives the value needed to get the whole document**", async () => {
    const r = await docxToMarkdown(bigDocx(60), { maxChars: 1000 });
    assert.equal(r.truncated, true);
    const res = await runDownload(bigDocx(60), { max_chars: 1000 });
    const s = res.structuredContent as Record<string, unknown>;
    assert.match(String(s["note"]), new RegExp(`set max_chars to ${r.fullChars} or more`));
    assert.match((res.content[0] as { text: string }).text, new RegExp(`${r.fullChars} or more`));
  });

  it("**says so when the document is over the limit and cannot be returned whole**", async () => {
    // A document over the limit (120,000 characters)
    const res = await runDownload(bigDocx(2000), { max_chars: 1000 });
    const s = res.structuredContent as Record<string, unknown>;
    assert.match(String(s["note"]), /exceeds the limit of 120000 characters/);
    assert.match(String(s["note"]), /from pCloud by other means/);
  });

  it("shows no note when the document fits", async () => {
    const res = await runDownload(DOCX, {});
    const s = res.structuredContent as Record<string, unknown>;
    assert.equal(s["truncated"], false);
    assert.equal(s["note"], undefined);
  });
});

// ---------------------------------------------------------------- detection

describe("officeKind - format detection", () => {
  const OOXML = "application/vnd.openxmlformats-officedocument.";

  it("decides by contenttype", () => {
    assert.equal(officeKind("x", `${OOXML}wordprocessingml.document`), "docx");
    assert.equal(officeKind("x", `${OOXML}spreadsheetml.sheet`), "xlsx");
    assert.equal(officeKind("x", `${OOXML}presentationml.presentation`), "pptx");
  });

  it("**decides by extension when contenttype is unreliable**", () => {
    // pCloud sometimes returns application/octet-stream (observed in practice)
    assert.equal(officeKind("deck.pptx", "application/octet-stream"), "pptx");
    assert.equal(officeKind("book.XLSX", undefined), "xlsx");
  });

  it("reports the old binary formats as legacy", () => {
    assert.equal(officeKind("a.doc", undefined), "legacy");
    assert.equal(officeKind("a.xls", undefined), "legacy");
    assert.equal(officeKind("a.ppt", undefined), "legacy");
    assert.equal(officeKind("x", "application/msword"), "legacy");
  });

  it("undefined when it is not an Office document", () => {
    assert.equal(officeKind("a.pdf", "application/pdf"), undefined);
    assert.equal(officeKind("a.jpg", "image/jpeg"), undefined);
    assert.equal(officeKind("a.txt", "text/plain"), undefined);
  });

  it("**does not match an extension that only looks similar**", () => {
    assert.equal(officeKind("a.docs", undefined), undefined);
    assert.equal(officeKind("a.xlsxx", undefined), undefined);
  });
});
