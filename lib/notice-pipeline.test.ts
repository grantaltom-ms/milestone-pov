/**
 * End-to-end test of the flow the app exists for: an AppFolio parse becomes a
 * filled-in notice that carries a complete Declaration of Service.
 *
 * Everything here is the real production code — charge filtering, jurisdiction
 * rules, placeholder building, page extraction, declaration verification. Only
 * the network boundaries are stood in for: Claude's parse is a fixture, and the
 * Google Docs copy-and-replace is simulated locally, so the suite is fast,
 * free and deterministic.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ParsedNotice } from "./claude.ts";
import { calculateTotals, buildReplacements, formatCurrency } from "./notice.ts";
import { getRulesForJurisdiction, cityRules } from "./city-rules.ts";
import { extractPages, verifyDeclarationOfService, type DocStructuralElement } from "./declaration.ts";

/* ---------------- Template fixtures ---------------- */

const TEMPLATE_BODY = `<<NOTICE_DAYS>>-DAY NOTICE TO PAY OR VACATE
TO: <<TENANT_NAME>> AND ALL OTHER OCCUPANTS
PREMISES: <<PREMISES_ADDRESS>>
PROPERTY: <<PROPERTY_NAME>> (<<JURISDICTION>>)
Rent: <<RENT_TOTAL>>
<<RENT_LINES>>
Utilities: <<UTIL_TOTAL>>
<<UTIL_LINES>>
Other: <<OTHER_TOTAL>>
<<OTHER_LINES>>
Less payments: <<LESS_PAYMENTS>>
<<PAYMENT_LINES>>
TOTAL DUE: <<TOTAL_DUE>>
You have fourteen (14) days after service of this notice to pay or vacate.
<<OWNER_NAME>>
<<OWNER_ADDRESS>>`;

const TEMPLATE_DECLARATION = `DECLARATION OF SERVICE
I certify (or declare) under penalty of perjury under the laws of the State of Washington that the following is true and correct:
1. I am over eighteen years of age and competent to testify as to the matters herein.
2. On the ____ day of ____________, 20__ at _____ AM _____ PM,
I served (list resident(s) name(s)) _______________________________
at the premises (address) _________________________________________
with (name of notice(s) served) ___________________________________
by (check one):
personally serving the document to each resident by placing in his / her / their hand.
leaving the document with a person of suitable age and discretion and also depositing ___ copy(ies) through the mail.
posting ___ copy(ies) of the documents conspicuously on the premises.
Method of USPS pre-paid mail used: ________________
DATED this ____ day of ____________, 20__.
Signature: ________________________________
Printed Name: _____________________________
City of Signing: <<CITY_OF_SIGNING>>`;

/** A template as the generator sees it: one Google Doc, declaration last. */
const goodTemplate = () => [TEMPLATE_BODY, TEMPLATE_DECLARATION];
/** The failure mode this whole feature exists to catch. */
const templateWithoutDeclaration = () => [TEMPLATE_BODY];

/* ---------------- Simulated Google Docs ---------------- */

/** Mirrors the Docs API `replaceAllText` batch the app sends. */
function simulateReplaceAllText(pages: string[], replacements: Record<string, string>): string[] {
  return pages.map((page) =>
    Object.entries(replacements).reduce(
      (text, [find, value]) => text.split(find).join(value),
      page
    )
  );
}

/** Mirrors the `documents.get` shape the app reads back. */
function asDocument(pages: string[]) {
  const content: DocStructuralElement[] = [
    { sectionBreak: { sectionStyle: { sectionType: "CONTINUOUS" } } },
  ];
  pages.forEach((page, i) => {
    if (i > 0) content.push({ paragraph: { elements: [{ pageBreak: {} }] } });
    for (const line of page.split("\n"))
      content.push({ paragraph: { elements: [{ textRun: { content: line + "\n" } }] } });
  });
  return { body: { content } };
}

/* ---------------- Tenant fixtures ---------------- */

function tenant(overrides: Partial<ParsedNotice> = {}): ParsedNotice {
  return {
    tenant_name: "Daniel B. Baral",
    property: "Castle",
    address: "2132 2nd Avenue #406, Seattle, WA 98121",
    rent_charges: [
      { description: "Rental Charges - March 2026", amount: 2400, date: "2026-03-01", category: "monthly_rent" },
    ],
    utility_charges: [
      { description: "Building Utility Charge - March 2026", amount: 185, date: "2026-03-01", category: "utilities" },
    ],
    recurring_fees: [
      { description: "Parking - March 2026", amount: 150, date: "2026-03-01", category: "parking" },
      { description: "NSF Fee", amount: 35, date: "2026-03-05", category: "nsf_fee" },
    ],
    payments: [
      { description: "Payment applied to Rental Charges", amount: 500, date: "2026-03-10", category: "payment" },
    ],
    late_fees: [
      { description: "Late Fees - Late Fee for March 2026", amount: 100, date: "2026-03-06", category: "late_fee" },
    ],
    ...overrides,
  };
}

const PROPERTY = {
  noticeDays: "14",
  city: "Seattle",
  ownerName: "Milestone Properties LLC",
  ownerAddress: "1000 4th Ave, Seattle, WA 98104",
};

/** Runs the real pipeline end to end and hands back the finished notice. */
function generateNotice(
  parsed: ParsedNotice,
  jurisdiction: string,
  templatePages: string[],
  propertyOverrides: Partial<typeof PROPERTY> = {}
) {
  const property = { ...PROPERTY, ...propertyOverrides, jurisdiction };
  const rules = getRulesForJurisdiction(jurisdiction);
  const totals = calculateTotals(parsed, rules);
  const replacements = buildReplacements(parsed, totals, property);
  const filled = simulateReplaceAllText(templatePages, replacements);
  const pages = extractPages(asDocument(filled));
  return { totals, pages, check: verifyDeclarationOfService(pages), text: filled.join("\n") };
}

/* ---------------- Tests ---------------- */

describe("the core flow: AppFolio parse to servable notice", () => {
  test("produces a complete notice with the declaration as its final page", () => {
    const { check, totals, text } = generateNotice(tenant(), "Seattle", goodTemplate());

    assert.equal(check.ok, true, check.problems.join(" | "));
    assert.equal(check.onFinalPage, true);
    assert.equal(check.hasPageBreakBefore, true);
    assert.deepEqual(check.unreplacedPlaceholders, []);

    // Seattle excludes late fees and NSF fees from the demand:
    // 2400 rent + 185 utilities + 150 parking - 500 paid = 2235.
    assert.equal(totals.totalDue, 2235);
    assert.match(text, /TOTAL DUE: \$2,235\.00/);
    assert.match(text, /Daniel B\. Baral/);
    assert.doesNotMatch(text, /<</, "no placeholder should survive");
  });

  test("catches a template that is missing the declaration", () => {
    const { check } = generateNotice(tenant(), "Seattle", templateWithoutDeclaration());

    assert.equal(check.present, false);
    assert.equal(check.ok, false);
    assert.match(check.problems[0], /No Declaration of Service found/);
  });

  test("carries the signing city through onto the declaration", () => {
    const { text } = generateNotice(tenant(), "Burien", goodTemplate(), { city: "Burien" });
    assert.match(text, /City of Signing: Burien/);
  });

  test("rewrites the notice period everywhere, including the title", () => {
    const { text } = generateNotice(tenant(), "Seattle", goodTemplate(), { noticeDays: "30" });
    assert.match(text, /30-DAY NOTICE TO PAY OR VACATE/);
    assert.match(text, /thirty \(30\) days/);
    assert.doesNotMatch(text, /fourteen \(14\)/);
  });
});

describe("every jurisdiction template", () => {
  // The trailing entry has no rules of its own and must fall back to statewide.
  const jurisdictions = [...Object.keys(cityRules), "Kirkland"];

  for (const jurisdiction of jurisdictions) {
    test(`${jurisdiction}: a good template passes`, () => {
      const { check } = generateNotice(tenant(), jurisdiction, goodTemplate());
      assert.equal(check.ok, true, check.problems.join(" | "));
    });

    test(`${jurisdiction}: a template missing the declaration is caught`, () => {
      const { check } = generateNotice(tenant(), jurisdiction, templateWithoutDeclaration());
      assert.equal(check.ok, false);
      assert.equal(check.present, false);
    });
  }

  test("every jurisdiction excludes late fees from the demand", () => {
    for (const jurisdiction of Object.keys(cityRules)) {
      const { totals } = generateNotice(tenant(), jurisdiction, goodTemplate());
      assert.equal(totals.lateFeeTotal, 100, `${jurisdiction} should track late fees`);
      assert.ok(
        totals.totalDue < 2400 + 185 + 150 + 100,
        `${jurisdiction} must not bill late fees in the demand`
      );
    }
  });
});

describe("repeated real-world use", () => {
  test("a batch of tenants each generate an independent, correct notice", () => {
    // Guards against state leaking between runs — the class of bug that only
    // shows up after the tool has been used a few dozen times in one session.
    const batch = Array.from({ length: 25 }, (_, i) =>
      tenant({
        tenant_name: `Tenant ${i}`,
        address: `${100 + i} Main St #${i}, Seattle, WA 98101`,
        rent_charges: [
          { description: `Rental Charges - March 2026`, amount: 1000 + i * 10, date: "2026-03-01", category: "monthly_rent" },
        ],
        utility_charges: [],
        recurring_fees: [],
        payments: [],
        late_fees: [],
      })
    );

    const seenTotals = new Set<string>();
    for (const [i, parsed] of batch.entries()) {
      const { check, totals, text } = generateNotice(parsed, "Seattle", goodTemplate());
      assert.equal(check.ok, true, `tenant ${i}: ${check.problems.join(" | ")}`);
      assert.equal(totals.totalDue, 1000 + i * 10);
      assert.match(text, new RegExp(`Tenant ${i}\\b`));
      assert.doesNotMatch(text, /<</, `tenant ${i}: placeholders left unfilled`);
      seenTotals.add(formatCurrency(totals.totalDue));
    }
    assert.equal(seenTotals.size, 25, "each notice must carry its own total");
  });

  test("a tenant with no charges at all still produces a verifiable notice", () => {
    const empty = tenant({
      rent_charges: [], utility_charges: [], recurring_fees: [], payments: [], late_fees: [],
    });
    const { check, totals, text } = generateNotice(empty, "Seattle", goodTemplate());
    assert.equal(check.ok, true, check.problems.join(" | "));
    assert.equal(totals.totalDue, 0);
    assert.match(text, /None/, "empty charge groups render as 'None', not a blank");
  });

  test("a template edited to drop the declaration is caught on the very next notice", () => {
    // The regression this feature is for: a template that worked yesterday.
    assert.equal(generateNotice(tenant(), "Seattle", goodTemplate()).check.ok, true);
    assert.equal(generateNotice(tenant(), "Seattle", templateWithoutDeclaration()).check.ok, false);
  });
});
