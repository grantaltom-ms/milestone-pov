import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractPages,
  verifyDeclarationOfService,
  declarationWarningText,
  type DocLike,
  type DocStructuralElement,
} from "./declaration.ts";

/* ------------------------------------------------------------------ *
 * Fixtures — real text from the RHAWA Declaration of Service form and
 * a representative notice body, so the checks are exercised against
 * what the templates actually contain.
 * ------------------------------------------------------------------ */

const DECLARATION = `DECLARATION OF SERVICE
I certify (or declare) under penalty of perjury under the laws of the State of Washington that the following is true and correct:
1. I am over eighteen years of age and competent to testify as to the matters herein.
2. On the ____ day of ____________, 20__ at _____ AM _____ PM,
I served (list resident(s) name(s)) _______________________________
at the premises (address) _________________________________________
with (name of notice(s) served) ___________________________________
by (check one):
personally serving the document to each resident by placing in his / her / their hand.
leaving the document with a person of suitable age and discretion and also depositing ___ copy(ies) through the mail addressed to each tenant at the place where the premises are situated.
posting ___ copy(ies) of the documents conspicuously on the premises and also depositing ___ copy(ies) through the mail.
Method of USPS pre-paid mail used: ________________
DATED this ____ day of ____________, 20__.
Signature: ________________________________
Printed Name: _____________________________
City of Signing: Seattle`;

const NOTICE_BODY = `14-DAY NOTICE TO PAY OR VACATE
TO: Daniel B. Baral AND ALL OTHER OCCUPANTS
PREMISES: 2132 2nd Avenue #406, Seattle, WA 98121
You are hereby notified that rent is now past due and owing in the amount shown below.
Rent charges: $2,400.00
Utility charges: $185.00
TOTAL DUE: $2,585.00
You have fourteen (14) days after service of this notice to pay the amount due or vacate the premises.
Milestone Properties LLC, Agent for Owner`;

/** Turns text into Docs-API paragraphs, optionally shredded into the many
 *  small text runs that Google Docs really returns for a single sentence. */
function paragraphs(text: string, splitRuns = false): DocStructuralElement[] {
  return text.split("\n").map((line) => ({
    paragraph: {
      elements: splitRuns
        ? chunk(line + "\n", 7).map((c) => ({ textRun: { content: c } }))
        : [{ textRun: { content: line + "\n" } }],
    },
  }));
}

function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [s];
}

type Break = "pageBreak" | "pageBreakBefore" | "sectionBreak" | "none";

/** Builds a document from page texts joined by a given break mechanism. */
function buildDoc(
  pages: string[],
  breakKind: Break = "pageBreak",
  splitRuns = false
): DocLike {
  const content: DocStructuralElement[] = [
    // Every real Google Doc opens with a section break.
    { sectionBreak: { sectionStyle: { sectionType: "CONTINUOUS" } } },
  ];

  pages.forEach((text, i) => {
    if (i > 0) {
      if (breakKind === "pageBreak") {
        content.push({ paragraph: { elements: [{ pageBreak: {} }] } });
      } else if (breakKind === "sectionBreak") {
        content.push({ sectionBreak: { sectionStyle: { sectionType: "NEXT_PAGE" } } });
      }
    }
    const paras = paragraphs(text, splitRuns);
    if (i > 0 && breakKind === "pageBreakBefore" && paras[0].paragraph) {
      paras[0].paragraph.paragraphStyle = { pageBreakBefore: true };
    }
    content.push(...paras);
  });

  return { body: { content } };
}

const check = (pages: string[], kind: Break = "pageBreak", splitRuns = false) =>
  verifyDeclarationOfService(extractPages(buildDoc(pages, kind, splitRuns)));

/* ------------------------------------------------------------------ *
 * extractPages
 * ------------------------------------------------------------------ */

describe("extractPages", () => {
  test("splits on an explicit page break", () => {
    const pages = extractPages(buildDoc(["Page one text", "Page two text"]));
    assert.equal(pages.length, 2);
    assert.match(pages[0], /Page one/);
    assert.match(pages[1], /Page two/);
  });

  test("splits on a pageBreakBefore paragraph style", () => {
    const pages = extractPages(buildDoc(["First", "Second"], "pageBreakBefore"));
    assert.equal(pages.length, 2);
  });

  test("splits on a NEXT_PAGE section break", () => {
    const pages = extractPages(buildDoc(["First", "Second"], "sectionBreak"));
    assert.equal(pages.length, 2);
  });

  test("does not emit a leading blank page for the document's opening section break", () => {
    const pages = extractPages(buildDoc(["Only page"]));
    assert.equal(pages.length, 1);
  });

  test("reads text inside tables", () => {
    const doc: DocLike = {
      body: {
        content: [
          {
            table: {
              tableRows: [
                { tableCells: [{ content: paragraphs("Inside a table cell") }] },
              ],
            },
          },
        ],
      },
    };
    assert.match(extractPages(doc)[0], /Inside a table cell/);
  });

  test("tolerates an empty or malformed document", () => {
    assert.deepEqual(extractPages({}), [""]);
    assert.deepEqual(extractPages({ body: { content: null } }), [""]);
    assert.deepEqual(extractPages({ body: { content: [{}] } }), [""]);
  });
});

/* ------------------------------------------------------------------ *
 * The happy path
 * ------------------------------------------------------------------ */

describe("a correctly built notice", () => {
  test("passes when the declaration is a complete final page", () => {
    const result = check([NOTICE_BODY, DECLARATION]);
    assert.equal(result.ok, true, result.problems.join(" | "));
    assert.equal(result.present, true);
    assert.equal(result.onFinalPage, true);
    assert.equal(result.hasPageBreakBefore, true);
    assert.deepEqual(result.missingFields, []);
    assert.deepEqual(result.problems, []);
  });

  test("passes when Google splits the text into many small runs", () => {
    // Docs returns a sentence as a dozen textRun fragments; concatenation has
    // to happen before matching or every check would fail on a real document.
    const result = check([NOTICE_BODY, DECLARATION], "pageBreak", true);
    assert.equal(result.ok, true, result.problems.join(" | "));
  });

  test("passes with curly quotes, en dashes and non-breaking spaces", () => {
    const typographic = DECLARATION.replace(/'/g, "’")
      .replace(/-/g, "–")
      .replace(/ /g, " ");
    const result = check([NOTICE_BODY, typographic]);
    assert.equal(result.ok, true, result.problems.join(" | "));
  });

  test("passes regardless of heading capitalisation", () => {
    const result = check([NOTICE_BODY, DECLARATION.replace("DECLARATION OF SERVICE", "Declaration of Service")]);
    assert.equal(result.ok, true, result.problems.join(" | "));
  });

  test("passes for a multi-page notice body", () => {
    const result = check([NOTICE_BODY, "Seattle required eviction language, continued.", DECLARATION]);
    assert.equal(result.ok, true, result.problems.join(" | "));
    assert.equal(result.pageCount, 3);
  });

  test("emits no Slack warning when everything is in order", () => {
    assert.equal(declarationWarningText(check([NOTICE_BODY, DECLARATION])), null);
  });
});

/* ------------------------------------------------------------------ *
 * The failures this exists to catch
 * ------------------------------------------------------------------ */

describe("a template missing the declaration", () => {
  const result = check([NOTICE_BODY]);

  test("is reported as absent", () => {
    assert.equal(result.present, false);
    assert.equal(result.ok, false);
  });

  test("says plainly that the template is the problem", () => {
    assert.match(result.problems[0], /No Declaration of Service found/);
    assert.match(result.problems[0], /template/);
  });

  test("produces a do-not-serve Slack warning", () => {
    const warning = declarationWarningText(result);
    assert.ok(warning);
    assert.match(warning, /do not serve/i);
    assert.match(warning, /regenerate/i);
  });
});

describe("a declaration in the wrong place", () => {
  test("is caught when content follows it", () => {
    const result = check([NOTICE_BODY, DECLARATION, "Addendum: additional charges detail."]);
    assert.equal(result.present, true);
    assert.equal(result.onFinalPage, false);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /not the last page/);
  });

  test("is caught when no page break separates it from the notice", () => {
    const result = check([`${NOTICE_BODY}\n${DECLARATION}`]);
    assert.equal(result.present, true);
    assert.equal(result.hasPageBreakBefore, false);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(" "), /no page break before it/);
  });

  test("flags a declaration that overflows onto a second page", () => {
    const firstHalf = DECLARATION.split("\n").slice(0, 9).join("\n");
    const secondHalf = DECLARATION.split("\n").slice(9).join("\n");
    const result = check([NOTICE_BODY, firstHalf, secondHalf]);
    // Still last — the overflow is the form itself, not other content.
    assert.equal(result.onFinalPage, true);
    assert.equal(result.spansMultiplePages, true);
    assert.deepEqual(result.missingFields, []);
    assert.match(result.problems.join(" "), /runs onto more than one page/);
  });
});

describe("a gutted declaration", () => {
  test("names each missing field", () => {
    const stripped = DECLARATION.split("\n")
      .filter((l) => !/^Signature:|^City of Signing:/.test(l))
      .join("\n");
    const result = check([NOTICE_BODY, stripped]);
    assert.equal(result.present, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingFields, ["Signature line", "City of signing line"]);
    assert.match(result.problems.join(" "), /incomplete/);
  });

  test("catches a heading with no form beneath it", () => {
    const result = check([NOTICE_BODY, "DECLARATION OF SERVICE"]);
    assert.equal(result.present, true);
    assert.equal(result.ok, false);
    assert.equal(result.missingFields.length, 6);
  });
});

describe("placeholders that never got filled in", () => {
  test("are reported with their tag names", () => {
    const broken = DECLARATION.replace("Seattle", "<<CITY_OF_SIGNING>>");
    const result = check([NOTICE_BODY.replace("Daniel B. Baral", "<<TENANT_NAME>>"), broken]);
    assert.equal(result.ok, false);
    assert.deepEqual(result.unreplacedPlaceholders.sort(), [
      "<<CITY_OF_SIGNING>>",
      "<<TENANT_NAME>>",
    ]);
    assert.match(result.problems.join(" "), /never filled in/);
  });

  test("are deduplicated when a tag repeats", () => {
    const result = check([`${NOTICE_BODY} <<TENANT_NAME>> <<TENANT_NAME>>`, DECLARATION]);
    assert.deepEqual(result.unreplacedPlaceholders, ["<<TENANT_NAME>>"]);
  });

  test("do not fire on a clean notice", () => {
    assert.deepEqual(check([NOTICE_BODY, DECLARATION]).unreplacedPlaceholders, []);
  });
});
