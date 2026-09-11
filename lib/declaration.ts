/**
 * Verifies that a generated Pay or Vacate notice actually carries a complete
 * Declaration of Service as its final page.
 *
 * The generator builds a notice by copying a Google Doc template and replacing
 * placeholders — it never adds pages. So the declaration is present only when
 * the template already carried it, and every jurisdiction has its own
 * hand-maintained template. Reading the finished document back is the only way
 * to know: a template that never had the page, or that loses it in a later
 * edit, otherwise stays invisible until a manager needs to prove service.
 */

// Minimal structural view of a Google Docs `documents.get` response. The real
// `docs_v1.Schema$Document` satisfies this shape, so the API result can be
// passed straight in while tests build small plain-object fixtures.
export interface DocTextRun { content?: string | null }
export interface DocParagraphElement {
  textRun?: DocTextRun | null;
  pageBreak?: unknown | null;
}
export interface DocParagraph {
  elements?: DocParagraphElement[] | null;
  paragraphStyle?: { pageBreakBefore?: boolean | null } | null;
}
export interface DocStructuralElement {
  paragraph?: DocParagraph | null;
  table?: { tableRows?: Array<{ tableCells?: Array<{ content?: DocStructuralElement[] | null }> | null }> | null } | null;
  tableOfContents?: { content?: DocStructuralElement[] | null } | null;
  sectionBreak?: { sectionStyle?: { sectionType?: string | null } | null } | null;
}
export interface DocLike {
  body?: { content?: DocStructuralElement[] | null } | null;
}

/**
 * Fields that make a Declaration of Service usable. Each entry is satisfied by
 * ANY of its patterns, so a template that words a line slightly differently
 * from the RHAWA original still passes — we are checking that the substance is
 * there, not that the template is a byte-for-byte copy.
 */
const REQUIRED_FIELDS: Array<{ label: string; patterns: string[] }> = [
  { label: "Perjury certification", patterns: ["penalty of perjury"] },
  { label: "Statement of who was served", patterns: ["i served", "i certify that i served"] },
  {
    label: "Service method options",
    patterns: ["personally serving", "person of suitable age", "posting"],
  },
  { label: "Signature line", patterns: ["signature"] },
  { label: "Printed name line", patterns: ["printed name"] },
  { label: "City of signing line", patterns: ["city of signing"] },
];

const DECLARATION_HEADING = "declaration of service";

/** Any `<<PLACEHOLDER>>` tag left behind by a failed text replacement. */
const PLACEHOLDER_PATTERN = /<<[^<>\n]{1,60}>>/g;

/**
 * Folds away the formatting differences that would otherwise cause false
 * alarms — curly quotes, non-breaking spaces, en/em dashes, line wrapping —
 * so matching is about wording, not typography.
 */
function normalise(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[\s ​]+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * Splits a Google Doc's body into page-delimited chunks of text.
 *
 * Only breaks the author put in the document are visible to us — an explicit
 * page break, a paragraph styled to start a page, or a next-page section
 * break. Pagination caused purely by content overflowing a page is decided by
 * the renderer and is not reported by the Docs API, which is why a template
 * should separate its declaration with a real page break rather than relying
 * on the notice happening to fill the page.
 */
export function extractPages(doc: DocLike): string[] {
  const pages: string[] = [""];
  let sawContent = false;

  const append = (text: string) => {
    pages[pages.length - 1] += text;
    if (text.trim()) sawContent = true;
  };

  // Guarded so a break before any content does not produce a leading blank
  // page — notably the section break every Google Doc opens with.
  const startNewPage = () => {
    if (sawContent) pages.push("");
  };

  const walk = (elements: DocStructuralElement[] | null | undefined): void => {
    for (const el of elements ?? []) {
      if (el.sectionBreak) {
        if (el.sectionBreak.sectionStyle?.sectionType === "NEXT_PAGE") startNewPage();
        continue;
      }
      if (el.tableOfContents) {
        walk(el.tableOfContents.content);
        continue;
      }
      if (el.table) {
        for (const row of el.table.tableRows ?? [])
          for (const cell of row.tableCells ?? []) walk(cell.content);
        continue;
      }

      const paragraph = el.paragraph;
      if (!paragraph) continue;

      if (paragraph.paragraphStyle?.pageBreakBefore) startNewPage();

      for (const pe of paragraph.elements ?? []) {
        // A page break is its own element inside a paragraph, so text that
        // follows it in the same paragraph belongs to the next page.
        if (pe.pageBreak) {
          startNewPage();
          continue;
        }
        if (pe.textRun?.content) append(pe.textRun.content);
      }
    }
  };

  walk(doc.body?.content);
  return pages;
}

export interface DeclarationCheck {
  /** A Declaration of Service was found somewhere in the document. */
  present: boolean;
  /** Nothing but the declaration itself appears after it. */
  onFinalPage: boolean;
  /** A page break separates the declaration from the notice body. */
  hasPageBreakBefore: boolean;
  /** The declaration runs past one page — usually a template formatting slip. */
  spansMultiplePages: boolean;
  /** Required declaration fields that could not be found. */
  missingFields: string[];
  /** `<<TAGS>>` still in the document because a replacement did not land. */
  unreplacedPlaceholders: string[];
  pageCount: number;
  /** True when the notice is safe to print as-is. */
  ok: boolean;
  /** Plain-English description of everything wrong, for the manager. */
  problems: string[];
}

/** True when a page looks like a continuation of the declaration form. */
function looksLikeDeclarationContinuation(page: string): boolean {
  return REQUIRED_FIELDS.some((f) => f.patterns.some((p) => page.includes(p)));
}

/**
 * Checks a generated notice's pages for a complete, correctly placed
 * Declaration of Service.
 */
export function verifyDeclarationOfService(pages: string[]): DeclarationCheck {
  const normPages = pages.map(normalise);
  const contentPages = normPages
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => text.length > 0);

  const problems: string[] = [];

  const unreplacedPlaceholders = [
    ...new Set(pages.join("\n").match(PLACEHOLDER_PATTERN) ?? []),
  ];

  const declIdx = normPages.findIndex((p) => p.includes(DECLARATION_HEADING));
  const present = declIdx >= 0;

  if (!present) {
    if (unreplacedPlaceholders.length > 0) {
      problems.push(
        `${unreplacedPlaceholders.length} placeholder tag(s) were never filled in: ${unreplacedPlaceholders.join(", ")}`
      );
    }
    problems.unshift(
      "No Declaration of Service found anywhere in this notice — the template it was built from is missing that page."
    );
    return {
      present: false,
      onFinalPage: false,
      hasPageBreakBefore: false,
      spansMultiplePages: false,
      missingFields: REQUIRED_FIELDS.map((f) => f.label),
      unreplacedPlaceholders,
      pageCount: contentPages.length,
      ok: false,
      problems,
    };
  }

  // Pages after the declaration that are not just the form continuing.
  const trailing = contentPages.filter(({ i }) => i > declIdx);
  const trailingNonDeclaration = trailing.filter(
    ({ text }) => !looksLikeDeclarationContinuation(text)
  );

  const onFinalPage = trailingNonDeclaration.length === 0;
  const spansMultiplePages = trailing.length > 0;
  const hasPageBreakBefore = declIdx > 0;

  // Field checks span the declaration through the end of the document so a
  // form that legitimately runs onto a second page is not reported as gutted.
  const declarationText = normPages.slice(declIdx).join(" ");
  const missingFields = REQUIRED_FIELDS.filter(
    (f) => !f.patterns.some((p) => declarationText.includes(p))
  ).map((f) => f.label);

  if (!onFinalPage) {
    problems.push(
      `The Declaration of Service is not the last page — ${trailingNonDeclaration.length} page(s) of other content follow it.`
    );
  }
  if (!hasPageBreakBefore) {
    problems.push(
      "The Declaration of Service has no page break before it — it will print on the same page as the notice instead of as its own final page."
    );
  }
  if (spansMultiplePages && onFinalPage) {
    problems.push(
      "The Declaration of Service runs onto more than one page — check the template's spacing so it prints as a single page."
    );
  }
  if (missingFields.length > 0) {
    problems.push(
      `The Declaration of Service is incomplete — missing: ${missingFields.join(", ")}.`
    );
  }
  if (unreplacedPlaceholders.length > 0) {
    problems.push(
      `${unreplacedPlaceholders.length} placeholder tag(s) were never filled in: ${unreplacedPlaceholders.join(", ")}`
    );
  }

  return {
    present,
    onFinalPage,
    hasPageBreakBefore,
    spansMultiplePages,
    missingFields,
    unreplacedPlaceholders,
    pageCount: contentPages.length,
    ok: problems.length === 0,
    problems,
  };
}

/**
 * Slack-ready warning text, or null when the notice passed and there is
 * nothing the manager needs to act on.
 */
export function declarationWarningText(check: DeclarationCheck): string | null {
  if (check.ok) return null;

  const heading = check.present
    ? ":rotating_light: *Check this notice before serving it*"
    : ":rotating_light: *This notice has NO Declaration of Service — do not serve it as-is*";

  return [
    heading,
    ...check.problems.map((p) => `• ${p}`),
    "",
    "_Fix the jurisdiction's Google Doc template, then regenerate. Every notice built from that template has the same problem._",
  ].join("\n");
}
