// © 2026 Yasuhiko Yokote

/**
 * Converts `.xlsx` (Excel) to Markdown tables.
 *
 * Opens the file with `fflate` and reads only the parts that are needed.
 *
 * | Part | What is taken |
 * |---|---|
 * | `xl/workbook.xml` | Sheet names and order |
 * | `xl/_rels/workbook.xml.rels` | Mapping from sheet names to files |
 * | `xl/sharedStrings.xml` | The strings themselves (a cell holds only an index) |
 * | `xl/styles.xml` | **Identifying the cells displayed as dates** |
 * | `xl/worksheets/sheetN.xml` | Cell values, positions of form controls |
 * | `xl/ctrlProps/ctrlPropN.xml` | **State of option buttons** (not written in the cells) |
 *
 * **Dates are not returned as raw numbers.**
 * Excel stores a date as the number of days since 1899-12-30,
 * and the displayed date is determined by the format. Returned without looking at the format, numbers such as `45678` appear, and
 * **the reader cannot tell what they mean.**
 */
import {
  attr,
  cellText,
  collectElements,
  collectText,
  columnIndex,
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

/**
 * Built-in date and time format numbers.
 *
 * Excel reserves these numbers, and no definition for them appears in `styles.xml`.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a format string represents a date or time. */
function looksLikeDateFormat(code: string): boolean {
  // Remove color specifications and string literals before looking
  const bare = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "");
  return /[ymdhs]/i.test(bare) && !/^[^ymdhs]*$/i.test(bare);
}

/** Collects the style indexes of cells that use a format displayed as a date. */
export function dateStyleIndexes(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (stylesXml === undefined) return out;

  // Custom-defined formats that represent a date
  const custom = new Set<number>();
  for (const f of collectElements(stylesXml, "numFmt")) {
    const id = Number(attr(f.attrs, "numFmtId"));
    const code = attr(f.attrs, "formatCode") ?? "";
    if (Number.isFinite(id) && looksLikeDateFormat(code)) custom.add(id);
  }

  // The position within cellXfs is the number that s="..." of a cell refers to
  const cellXfs = collectElements(stylesXml, "cellXfs")[0];
  if (cellXfs === undefined) return out;
  collectElements(cellXfs.body, "xf").forEach((xf, i) => {
    const id = Number(attr(xf.attrs, "numFmtId"));
    if (BUILTIN_DATE_FORMATS.has(id) || custom.has(id)) out.add(i);
  });
  return out;
}

/**
 * Converts an Excel serial number to a date.
 *
 * **Spreadsheets have inherited the error of treating 1900 as a leap year.**
 * Serial 60 refers to 1900-02-29, which does not exist, and serials before it are off by one day.
 * For that reason, **serials below 60 are counted from an epoch shifted by one day.**
 *
 * Dates in this range hardly ever appear in practice, but
 * **silently returning a date that is off by one day is worse than returning none.**
 */
export function serialToDate(serial: number): string {
  if (serial >= 60 && serial < 61) return "1900-02-29 (a date that exists only in Excel)";
  // Below 60 is the range before the leap-year error takes effect
  const epoch = serial < 60 ? 25568 : 25569;
  const ms = Math.round((serial - epoch) * 86400 * 1000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const iso = d.toISOString();
  // A date without a time is returned as the date only
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

interface Sheet {
  name: string;
  path: string;
}

/** Lists the sheet names and the locations of the corresponding files. */
function sheetList(zip: Record<string, Uint8Array>): Sheet[] {
  const wb = entryText(zip, "xl/workbook.xml");
  const rels = entryText(zip, "xl/_rels/workbook.xml.rels");
  if (wb === undefined) {
    throw new OfficeError("Could not read the structure of the Excel workbook", "cannot-open");
  }

  const target = new Map<string, string>();
  for (const r of collectElements(rels ?? "", "Relationship")) {
    const id = attr(r.attrs, "Id");
    const t = attr(r.attrs, "Target");
    if (id !== undefined && t !== undefined) target.set(id, t);
  }

  const out: Sheet[] = [];
  for (const s of collectElements(wb, "sheet")) {
    const name = attr(s.attrs, "name") ?? `Sheet ${out.length + 1}`;
    // **`r:id` is looked up first.** `id` holds a number with a different meaning
    const rid = attr(s.attrs, "r:id") ?? attr(s.attrs, "id");
    const t = rid === undefined ? undefined : target.get(rid);
    // The target can be relative or absolute
    const path =
      t === undefined
        ? `xl/worksheets/sheet${out.length + 1}.xml`
        : t.startsWith("/")
          ? t.slice(1)
          : t.startsWith("xl/")
            ? t
            : `xl/${t}`;
    out.push({ name, path });
  }
  return out;
}

export interface SheetRead {
  rows: string[][];
  /**
   * The row number of each row on the sheet, counted from 1.
   *
   * **Empty rows are skipped when reading, so array indexes and sheet row numbers do not match.**
   * Needed to place form controls, which are specified by their anchor position.
   */
  rowNumbers: number[];
  moreRows: boolean;
  moreColumns: boolean;
}

/** Reads one sheet into rows of cells. */
export function readSheet(
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
  maxRows: number,
  maxColumns: number,
): SheetRead {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let moreRows = false;
  let moreColumns = false;

  const sheetData = collectElements(xml, "sheetData")[0];
  if (sheetData === undefined) return { rows, rowNumbers, moreRows, moreColumns };

  for (const row of collectElements(sheetData.body, "row")) {
    if (rows.length >= maxRows) {
      moreRows = true;
      break;
    }
    const cells: string[] = [];
    for (const c of collectElements(row.body, "c")) {
      const at = columnIndex(attr(c.attrs, "r") ?? "");
      const idx = at >= 0 ? at : cells.length;
      if (idx >= maxColumns) {
        moreColumns = true;
        continue;
      }
      while (cells.length <= idx) cells.push("");
      cells[idx] = readCell(c.attrs, c.body, shared, dateStyles);
    }
    const n = Number(attr(row.attrs, "r"));
    rowNumbers.push(Number.isFinite(n) && n > 0 ? n : rows.length + 1);
    rows.push(cells);
  }
  return { rows, rowNumbers, moreRows, moreColumns };
}

/** Converts the value of one cell to a string. */
function readCell(attrs: string, body: string, shared: string[], dateStyles: Set<number>): string {
  const type = attr(attrs, "t") ?? "n";
  if (type === "inlineStr") {
    return cellText(collectText(body, "t").join(""));
  }
  const raw = collectText(body, "v")[0];
  if (raw === undefined) return "";

  switch (type) {
    case "s": {
      const i = Number(raw);
      return cellText(shared[i] ?? "");
    }
    case "b":
      return raw === "1" ? "TRUE" : "FALSE";
    case "e":
      return cellText(raw);
    case "str":
      return cellText(raw);
    default: {
      const styleIndex = Number(attr(attrs, "s") ?? "-1");
      const n = Number(raw);
      if (Number.isFinite(n) && dateStyles.has(styleIndex)) return serialToDate(n);
      return cellText(raw);
    }
  }
}

/**
 * State of a form control (option button or checkbox).
 *
 * **The selection state is not a cell value.**
 * A choice such as "YES / NO" is sometimes held only in the control, not in a cell, and
 * reading only the cells gives **a listing that does not show which one was chosen** (measured).
 */
export interface FormControl {
  /** Row on the sheet (counted from 1). */
  row: number;
  /** Column on the sheet (counted from 0). */
  column: number;
  checked: boolean;
  /** **Split almost evenly between the upper and lower rows, so the row could not be decided.** */
  ambiguous: boolean;
}

/**
 * Default row height (EMU). Equivalent to 20 px.
 *
 * **The actual height can differ per row, but here only the upper and lower overlaps are compared**,
 * so as long as both are compared on the same scale the choice does not change.
 */
const ROW_HEIGHT_EMU = 190_500;

/**
 * Decides, from the anchor position, the row in which the mark is placed.
 *
 * A control is sometimes placed across rows (measured: 28 out of 500).
 * **Looking only at `<from>` always gives the upper row, and controls that sit mostly in the lower row are off by one row.**
 *
 * @returns the row counted from 0, and whether it could not be decided
 */
export function chooseRow(
  fromRow: number,
  fromOff: number,
  toRow: number,
  toOff: number,
): { row: number; ambiguous: boolean } {
  if (toRow <= fromRow) return { row: fromRow, ambiguous: false };
  // When it spans three or more rows, the rows in between are fully covered. Take the first of them
  if (toRow - fromRow >= 2) return { row: fromRow + 1, ambiguous: false };

  const upper = Math.max(ROW_HEIGHT_EMU - fromOff, 0);
  const lower = Math.max(toOff, 0);
  const total = upper + lower;
  // If the difference is less than 10 percent, neither row can be chosen
  const ambiguous = total > 0 && Math.abs(upper - lower) / total < 0.1;
  return { row: lower > upper ? toRow : fromRow, ambiguous };
}

/** Resolves a relative target to a location inside the archive. */
function resolveTarget(fromPath: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const dir = fromPath.slice(0, fromPath.lastIndexOf("/"));
  const parts = dir.split("/");
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Reads the form controls of one sheet.
 *
 * Steps:
 *   1. Take the reference ID and the anchor position (row, column) from `<control>` in the sheet
 *   2. Look up `ctrlPropN.xml` from the reference ID in `sheetN.xml.rels`
 *   3. Read `objectType` and `checked` in `ctrlPropN.xml`
 *
 * **Group boxes (`GBox`) have no state, so they are excluded.**
 */
export function readControls(
  zip: Record<string, Uint8Array>,
  sheetPath: string,
  sheetXml: string,
): FormControl[] {
  const relsPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
  const rels = entryText(zip, relsPath);
  if (rels === undefined) return [];

  const target = new Map<string, string>();
  for (const r of collectElements(rels, "Relationship")) {
    const id = attr(r.attrs, "Id");
    const tg = attr(r.attrs, "Target");
    if (id !== undefined && tg !== undefined) target.set(id, resolveTarget(sheetPath, tg));
  }

  const out: FormControl[] = [];
  for (const c of collectElements(sheetXml, "control")) {
    const rid = attr(c.attrs, "r:id") ?? attr(c.attrs, "id");
    const path = rid === undefined ? undefined : target.get(rid);
    if (path === undefined) continue;
    const props = entryText(zip, path);
    if (props === undefined) continue;

    const kind = attr(props, "objectType") ?? "";
    // Only option buttons and checkboxes have a state
    if (kind !== "Radio" && kind !== "CheckBox") continue;

    // The anchor position is in `<from>` and `<to>`. Match the element name exactly so that it is not confused with `<colOff>`
    const from = collectElements(c.body, "from")[0];
    if (from === undefined) continue;
    const col = Number(collectText(from.body, "col")[0]);
    const fromRow = Number(collectText(from.body, "row")[0]);
    if (!Number.isFinite(col) || !Number.isFinite(fromRow)) continue;

    const to = collectElements(c.body, "to")[0];
    const fromOff = Number(collectText(from.body, "rowOff")[0] ?? 0);
    const toRow = to === undefined ? fromRow : Number(collectText(to.body, "row")[0]);
    const toOff = to === undefined ? 0 : Number(collectText(to.body, "rowOff")[0] ?? 0);

    const picked = chooseRow(
      fromRow,
      Number.isFinite(fromOff) ? fromOff : 0,
      Number.isFinite(toRow) ? toRow : fromRow,
      Number.isFinite(toOff) ? toOff : 0,
    );
    out.push({
      row: picked.row + 1,
      column: col,
      checked: attr(props, "checked") === "Checked",
      ambiguous: picked.ambiguous,
    });
  }
  return out;
}

/**
 * Writes the selection state into the cells of the table.
 *
 * Prefixes the cell at the anchor position with `☑` or `☐`.
 * If the cell says "YES" it becomes `☑ YES`, and **which one was chosen can be read.**
 *
 * @returns the number that could not be placed (the row was outside the range that was read)
 */
export function applyControls(
  rows: string[][],
  rowNumbers: number[],
  controls: FormControl[],
  maxColumns: number,
): number {
  const indexOf = new Map<number, number>();
  rowNumbers.forEach((n, i) => indexOf.set(n, i));

  let unplaced = 0;
  for (const c of controls) {
    const i = indexOf.get(c.row);
    if (i === undefined || c.column >= maxColumns) {
      unplaced++;
      continue;
    }
    const cells = rows[i]!;
    while (cells.length <= c.column) cells.push("");
    const mark = c.checked ? "☑" : "☐";
    const cur = cells[c.column]!;
    cells[c.column] = cur === "" ? mark : `${mark} ${cur}`;
  }
  return unplaced;
}

/** Converts rows to a Markdown table. **The first row is treated as the header.** */
export function rowsToTable(rows: string[][]): string {
  if (rows.length === 0) return "(empty sheet)";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => r[i] ?? "");
  const head = pad(rows[0]!);
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`),
  ];
  return lines.join("\n");
}

export interface XlsxOptions {
  maxChars?: number;
}

export async function xlsxToMarkdown(
  input: Uint8Array,
  opts: XlsxOptions = {},
): Promise<OfficeMarkdown> {
  if (input.byteLength > OFFICE_LIMITS.maxDocBytes) {
    throw new OfficeError(
      `The document is too large (${input.byteLength} bytes / limit ${OFFICE_LIMITS.maxDocBytes} bytes).`,
      "too-large",
    );
  }
  const maxChars = clampMaxChars(opts.maxChars);
  const zip = await openZip(input);

  const sharedXml = entryText(zip, "xl/sharedStrings.xml");
  // A string with formatting has several <t> inside <si>. Join them into one value
  const shared = collectElements(sharedXml ?? "", "si").map((si) =>
    collectText(si.body, "t").join(""),
  );
  const dateStyles = dateStyleIndexes(entryText(zip, "xl/styles.xml"));
  const sheets = sheetList(zip);
  if (sheets.length === 0) {
    throw new OfficeError("There are no sheets", "empty");
  }

  const omitted: string[] = [];
  const parts: string[] = [];
  let empty = 0;
  let unplaced = 0;
  let checkedTotal = 0;
  let ambiguous = 0;
  for (const s of sheets) {
    const xml = entryText(zip, s.path);
    if (xml === undefined) {
      omitted.push(`sheet "${s.name}" (could not be read)`);
      continue;
    }
    const { rows, rowNumbers, moreRows, moreColumns } = readSheet(
      xml,
      shared,
      dateStyles,
      OFFICE_LIMITS.maxRows,
      OFFICE_LIMITS.maxColumns,
    );
    // **An empty sheet is omitted together with its heading.** It carries no information for the reader
    if (rows.length === 0) {
      empty++;
      continue;
    }
    // Write the state of option buttons and checkboxes into the cells.
    // **Without this, "YES" and "NO" are only listed and which one was chosen cannot be told**
    const controls = readControls(zip, s.path, xml);
    if (controls.length > 0) {
      checkedTotal += controls.filter((c) => c.checked).length;
      ambiguous += controls.filter((c) => c.ambiguous).length;
      unplaced += applyControls(rows, rowNumbers, controls, OFFICE_LIMITS.maxColumns);
    }

    if (moreRows) omitted.push(`sheet "${s.name}" after row ${OFFICE_LIMITS.maxRows}`);
    if (moreColumns) omitted.push(`sheet "${s.name}" after column ${OFFICE_LIMITS.maxColumns}`);
    parts.push(`## ${s.name}\n\n${rowsToTable(rows)}`);
  }
  if (empty > 0) omitted.push(`${empty} empty sheet(s)`);
  if (unplaced > 0) omitted.push(`${unplaced} option button(s) or checkbox(es) that could not be placed in the table`);
  // **What could not be decided is not silently assigned to one side**
  if (ambiguous > 0) {
    omitted.push(`${ambiguous} option button(s) or checkbox(es) placed on a row boundary whose row could not be decided`);
  }

  const markdown = tidy(parts.join("\n\n"));
  const { text, truncated } = truncateMarkdown(markdown, maxChars);
  return {
    markdown: text,
    omitted,
    truncated,
    fullChars: markdown.length,
    kind:
      `Excel workbook (${sheets.length} sheet(s)` +
      (checkedTotal > 0 ? `, ${checkedTotal} selected` : "") +
      ")",
  };
}
