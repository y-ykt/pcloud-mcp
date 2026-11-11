// © 2026 Yasuhiko Yokote

/**
 * Tests for the OOXML reading helpers (`src/office/ooxml.ts`) and
 * the shared conversion code (`src/office/types.ts`).
 *
 * **The focus is on matching element names and attribute names.**
 * Loose matching does not fail; it returns **a plausible but wrong result**,
 * which is hard to notice. Two defects were caused that way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attr,
  cellText,
  collectElements,
  collectText,
  columnIndex,
  decodeXml,
} from "../src/office/ooxml.ts";
import { clampMaxChars, OFFICE_LIMITS, tidy, truncateMarkdown } from "../src/office/types.ts";

describe("decodeXml - character references", () => {
  it("named references", () => {
    assert.equal(decodeXml("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"), `a & b <c> "d" 'e'`);
  });

  it("decimal references", () => {
    assert.equal(decodeXml("&#26085;&#26412;"), "日本");
  });

  it("hexadecimal references", () => {
    assert.equal(decodeXml("&#x65E5;&#x672C;"), "日本");
  });

  it("leaves an unknown reference as is", () => {
    assert.equal(decodeXml("&nbsp;"), "&nbsp;");
  });
});

describe("collectText - element content", () => {
  it("matches with or without a prefix", () => {
    assert.deepEqual(collectText("<a:t>a</a:t><t>b</t>", "t"), ["a", "b"]);
  });

  it("collects an empty element as an empty string", () => {
    assert.deepEqual(collectText("<t/><t>a</t>", "t"), ["", "a"]);
  });

  it("collects an element that has attributes", () => {
    assert.deepEqual(collectText('<t xml:space="preserve"> a </t>', "t"), [" a "]);
  });

  it("decodes character references in the content", () => {
    assert.deepEqual(collectText("<t>a &amp; b</t>", "t"), ["a & b"]);
  });

  it("**does not collect an element whose name only partly matches**", () => {
    // A search for <t> must not match <tbl>
    assert.deepEqual(collectText("<tbl>table</tbl><t>body</t>", "t"), ["body"]);
  });
});

describe("collectElements - whole elements", () => {
  it("returns the attributes and the body separately", () => {
    const els = collectElements('<c r="A1" t="s"><v>3</v></c>', "c");
    assert.equal(els.length, 1);
    assert.equal(attr(els[0]!.attrs, "r"), "A1");
    assert.equal(els[0]!.body, "<v>3</v>");
  });

  it("collects an empty element too", () => {
    const els = collectElements('<sldId id="256" r:id="rIdB"/>', "sldId");
    assert.equal(els.length, 1);
    assert.equal(els[0]!.body, "");
  });

  it("**does not collect `<p:pic>` as `p`**", () => {
    // Matching with `\b` hits `<p:pic>` and then
    // runs past the closing tag into the content that follows (an error observed in practice)
    const xml = "<p:pic><p:nvPicPr/></p:pic><a:p><a:t>body</a:t></a:p>";
    const els = collectElements(xml, "p");
    assert.equal(els.length, 1, "collected too many elements");
    assert.equal(els[0]!.body, "<a:t>body</a:t>");
  });

  it("collects repeated elements of the same name in document order", () => {
    const els = collectElements("<row><c>1</c></row><row><c>2</c></row>", "row");
    assert.deepEqual(
      els.map((e) => e.body),
      ["<c>1</c>", "<c>2</c>"],
    );
  });
});

describe("attr - reading an attribute", () => {
  it("an ordinary attribute", () => {
    assert.equal(attr(' name="Ledger" sheetId="1"', "name"), "Ledger");
  });

  it("decodes character references", () => {
    assert.equal(attr(' name="Totals &amp; notes"', "name"), "Totals & notes");
  });

  it("**a lookup of `id` does not match `r:id`**", () => {
    // Confusing the two changes the slide order (an error observed in practice)
    const attrs = ' id="256" r:id="rIdB"';
    assert.equal(attr(attrs, "id"), "256");
    assert.equal(attr(attrs, "r:id"), "rIdB");
  });

  it("does not match an attribute whose name only partly matches", () => {
    assert.equal(attr(' sheetId="1"', "id"), undefined);
  });

  it("**does not match a prefixed attribute by its unprefixed name**", () => {
    // Matching with `\b` hits `r:id`, because there is a boundary between `:` and `i`.
    // That makes a relationship ID be taken for a plain ID
    assert.equal(attr(' r:id="rId1"', "id"), undefined);
    assert.equal(attr(' r:embed="rId9"', "embed"), undefined);
  });

  it("undefined when absent", () => {
    assert.equal(attr(' a="1"', "b"), undefined);
  });
});

describe("cellText - making text safe for a table cell", () => {
  it("**escapes `|`**", () => {
    assert.equal(cellText("power | gas"), "power \\| gas");
  });

  it("replaces a line break with a space", () => {
    assert.equal(cellText("top\nbottom"), "top bottom");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(cellText("  value  "), "value");
  });
});

describe("columnIndex - column letters", () => {
  it("one letter", () => {
    assert.equal(columnIndex("A1"), 0);
    assert.equal(columnIndex("Z9"), 25);
  });

  it("two letters", () => {
    assert.equal(columnIndex("AA1"), 26);
    assert.equal(columnIndex("AZ1"), 51);
    assert.equal(columnIndex("BA1"), 52);
  });

  it("negative when there is no letter", () => {
    assert.ok(columnIndex("") < 0);
  });
});

describe("truncateMarkdown - truncation", () => {
  const md = Array.from({ length: 50 }, (_, i) => `## Section ${i}\n\nbody${"x".repeat(20)}`).join("\n\n");

  it("leaves text that fits untouched", () => {
    assert.deepEqual(truncateMarkdown("short", 100), { text: "short", truncated: false });
  });

  it("truncates text over the limit", () => {
    const r = truncateMarkdown(md, 500);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 500);
  });

  it("**does not cut in the middle of a line**", () => {
    const r = truncateMarkdown(md, 500);
    assert.ok(md.startsWith(r.text), "not a prefix of the original");
    assert.ok(!r.text.endsWith("x"), `cut in the middle of a line: ${JSON.stringify(r.text.slice(-10))}`);
  });

  it("cuts as is when a single line is too long", () => {
    const long = "x".repeat(1000);
    const r = truncateMarkdown(long, 100);
    assert.equal(r.text.length, 100);
    assert.equal(r.truncated, true);
  });
});

describe("clampMaxChars - the character count setting", () => {
  it("keeps a value within the range", () => assert.equal(clampMaxChars(50_000), 50_000));
  it("clamps to the lower limit", () => assert.equal(clampMaxChars(40), OFFICE_LIMITS.minMaxChars));
  it("clamps to the upper limit", () => assert.equal(clampMaxChars(999_999), OFFICE_LIMITS.maxMaxChars));
  it("uses the default when the value is not a number", () => {
    for (const v of [undefined, null, "1000", NaN]) {
      assert.equal(clampMaxChars(v), OFFICE_LIMITS.defaultMaxChars);
    }
  });
});

describe("tidy - whitespace cleanup", () => {
  it("collapses three or more line breaks into two", () => {
    assert.equal(tidy("a\n\n\n\n\nb"), "a\n\nb");
  });

  it("removes trailing whitespace on a line", () => {
    assert.equal(tidy("a   \nb"), "a\nb");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(tidy("\n\n  a  \n\n"), "a");
  });
});
