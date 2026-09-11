/**
 * The page this module writes goes into legal documents, so these tests check
 * two things: that the declaration it produces satisfies the same verifier that
 * guards every generated notice, and that its index arithmetic is exact — an
 * off-by-one in a Docs API range styles the wrong text or corrupts the doc.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DECLARATION_BLOCKS,
  declarationText,
  buildDeclarationRequests,
  appendIndexFor,
} from "./declaration-template.ts";
import {
  extractPages,
  verifyDeclarationOfService,
  type DocStructuralElement,
} from "./declaration.ts";

const NOTICE_BODY = `30-DAY NOTICE TO PAY RENT OR VACATE THE PREMISES
To Resident Name(s): <<TENANT_NAME>>
Premises Address: <<PREMISES_ADDRESS>>
TOTAL AMOUNT DUE: <<TOTAL_DUE>>
Owner/Agent Signature:   Date:   City of Signing: <<CITY_OF_SIGNING>>`;

/** Builds the document this script would produce: body, page break, declaration. */
function resultingDocument() {
  const content: DocStructuralElement[] = [
    { sectionBreak: { sectionStyle: { sectionType: "CONTINUOUS" } } },
  ];
  for (const line of NOTICE_BODY.split("\n"))
    content.push({ paragraph: { elements: [{ textRun: { content: line + "\n" } }] } });
  content.push({ paragraph: { elements: [{ pageBreak: {} }] } });
  for (const line of declarationText().split("\n"))
    content.push({ paragraph: { elements: [{ textRun: { content: line + "\n" } }] } });
  return { body: { content } };
}

describe("the declaration this script writes", () => {
  const check = verifyDeclarationOfService(extractPages(resultingDocument()));

  test("satisfies the verifier that guards every generated notice", () => {
    assert.equal(check.present, true);
    assert.equal(check.onFinalPage, true);
    assert.equal(check.hasPageBreakBefore, true);
    assert.deepEqual(check.missingFields, []);
  });

  test("does not spill onto a second page", () => {
    assert.equal(check.spansMultiplePages, false);
  });

  test("leaves <<CITY_OF_SIGNING>> for the generator to fill in", () => {
    // Expected in a template — the notice run replaces it. It is only a fault
    // on a finished notice, which is why the script checks fields, not this.
    assert.ok(check.unreplacedPlaceholders.includes("<<CITY_OF_SIGNING>>"));
    assert.match(declarationText(), /City of Signing: <<CITY_OF_SIGNING>>/);
  });

  test("carries all four statutory service methods", () => {
    const text = declarationText();
    assert.match(text, /personally serving the document/);
    assert.match(text, /person of suitable age and discretion/);
    assert.match(text, /posting _+ copy\(ies\)/);
    assert.match(text, /Method of USPS pre-paid mail used/);
    assert.equal((text.match(/☐/g) ?? []).length, 4, "four checkboxes");
  });

  test("certifies under penalty of perjury under Washington law", () => {
    assert.match(
      declarationText(),
      /penalty of perjury under the laws of the State of Washington/
    );
  });
});

describe("index arithmetic", () => {
  const START = 1234;
  const requests = buildDeclarationRequests(START);

  test("breaks the page before writing anything", () => {
    assert.equal(requests[0].insertPageBreak?.location?.index, START);
  });

  test("writes the text immediately after the page break", () => {
    assert.equal(requests[1].insertText?.location?.index, START + 1);
    assert.equal(requests[1].insertText?.text, declarationText());
  });

  test("every styled range slices back to exactly the text it styles", () => {
    // The strongest check available: map each range back through the inserted
    // string and confirm it lands on the block it is meant to style.
    const textStart = START + 1;
    const text = declarationText();
    const styled = DECLARATION_BLOCKS.filter((b) => b.style && b.text.length > 0);
    assert.ok(styled.length > 0);

    const ranges = requests
      .slice(2)
      .map((r) => r.updateTextStyle?.range ?? r.updateParagraphStyle?.range)
      .filter((r): r is { startIndex: number; endIndex: number } => !!r);

    for (const range of ranges) {
      const slice = text.slice(range.startIndex - textStart, range.endIndex - textStart);
      const block = styled.find((b) => b.text === slice);
      assert.ok(block, `range [${range.startIndex},${range.endIndex}) sliced to unexpected text: ${JSON.stringify(slice.slice(0, 60))}`);
    }
  });

  test("no range escapes the inserted text", () => {
    const textStart = START + 1;
    const textEnd = textStart + declarationText().length;
    for (const r of requests.slice(2)) {
      const range = r.updateTextStyle?.range ?? r.updateParagraphStyle?.range;
      if (!range) continue;
      assert.ok(range.startIndex! >= textStart, "starts at or after the text");
      assert.ok(range.endIndex! <= textEnd, "ends at or before the text");
      assert.ok(range.endIndex! > range.startIndex!, "is non-empty");
    }
  });

  test("styles nothing for blank lines", () => {
    const blanks = DECLARATION_BLOCKS.filter((b) => b.text.length === 0).length;
    assert.ok(blanks > 0, "fixture has blank lines to ignore");
    const styled = DECLARATION_BLOCKS.filter((b) => b.style && b.text.length > 0).length;
    // Heading emits two requests (text style + alignment); the rest emit one.
    const headings = DECLARATION_BLOCKS.filter((b) => b.style === "heading").length;
    assert.equal(requests.length - 2, styled + headings);
  });

  test("holds up at the start of an empty document", () => {
    const atOne = buildDeclarationRequests(1);
    assert.equal(atOne[0].insertPageBreak?.location?.index, 1);
    assert.equal(atOne[1].insertText?.location?.index, 2);
  });
});

describe("appendIndexFor", () => {
  test("returns one before the body's end", () => {
    assert.equal(appendIndexFor({ body: { content: [{ endIndex: 500 }] } }), 499);
  });

  test("uses the last element, not the first", () => {
    assert.equal(
      appendIndexFor({ body: { content: [{ endIndex: 10 }, { endIndex: 820 }] } }),
      819
    );
  });

  test("never returns an index before the start of a document", () => {
    assert.equal(appendIndexFor({}), 1);
    assert.equal(appendIndexFor({ body: { content: [] } }), 1);
    assert.equal(appendIndexFor({ body: { content: [{ endIndex: 1 }] } }), 1);
    assert.equal(appendIndexFor({ body: { content: [{ endIndex: null }] } }), 1);
  });
});
