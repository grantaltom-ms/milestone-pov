/**
 * The Declaration of Service page that `scripts/add-declaration.ts` appends to
 * a notice template, expressed as Google Docs API requests.
 *
 * The wording follows the Washington service-of-notice requirements the RHAWA
 * form is built around: who served, whom, when, where, with what, and by which
 * method, certified under penalty of perjury. It is kept as data here rather
 * than inline in the script so the exact page that gets written can be checked
 * by the same verifier that runs on every generated notice.
 */
import type { docs_v1 } from "googleapis";

type BlockStyle = "heading" | "body" | "option" | "footnote";

interface Block {
  text: string;
  style?: BlockStyle;
}

/** A blank line. */
const GAP: Block = { text: "" };

const UNDERLINE_SHORT = "_".repeat(28);
const UNDERLINE_LONG = "_".repeat(52);

export const DECLARATION_BLOCKS: Block[] = [
  { text: "DECLARATION OF SERVICE", style: "heading" },
  GAP,
  {
    text:
      "I certify (or declare) under penalty of perjury under the laws of the State of " +
      "Washington that the following is true and correct:",
  },
  GAP,
  { text: "1. I am over eighteen years of age and competent to testify as to the matters herein." },
  GAP,
  { text: "2. On the ______ day of ______________, 20____ at ________ AM / PM," },
  GAP,
  { text: `I served (list resident(s) name(s)) ${UNDERLINE_LONG}` },
  GAP,
  { text: `at the premises (address) ${UNDERLINE_LONG}` },
  GAP,
  { text: `with (name of notice(s) served) ${UNDERLINE_LONG}` },
  GAP,
  { text: "by (check one):" },
  GAP,
  {
    text:
      "☐  personally serving the document to each resident by placing in his / her / their hand.",
    style: "option",
  },
  {
    text:
      "☐  personally serving the document to each resident by placing in his / her / their hand " +
      "and also depositing _____ copy(ies) through the mail addressed to each tenant at the place " +
      "where the premises are situated having first attempted personal service on the parties " +
      "(one copy for each occupant plus one extra addressed to “all other occupants”).",
    style: "option",
  },
  {
    text:
      "☐  leaving the document with a person of suitable age and discretion and also depositing " +
      "_____ copy(ies) through the mail addressed to each tenant at the place where the premises " +
      "are situated having first attempted personal service on the parties (one copy for each " +
      "occupant plus one extra addressed to “all other occupants”).",
    style: "option",
  },
  {
    text:
      "☐  posting _____ copy(ies) of the documents conspicuously on the premises and also " +
      "depositing _____ copy(ies) through the mail addressed to each tenant at the place where " +
      "the premises are situated having first attempted personal service on the parties (one copy " +
      "for each occupant plus one extra addressed to “all other occupants”).",
    style: "option",
  },
  GAP,
  { text: `Method of USPS pre-paid mail used: ${UNDERLINE_SHORT}` },
  GAP,
  { text: "DATED this ______ day of ______________, 20____." },
  GAP,
  { text: `Signature: ${UNDERLINE_LONG}` },
  GAP,
  { text: `Printed Name: ${UNDERLINE_LONG}` },
  GAP,
  // Filled in at generation time by the same replacement that fills the notice
  // body's signature block — replaceAllText updates every occurrence.
  { text: "City of Signing: <<CITY_OF_SIGNING>>" },
  GAP,
  {
    text:
      "*This form may not be appropriate for use with certain tenancies (ie: mobile homes, " +
      "Section 8, etc). Consultation with legal counsel prior to use of this form is recommended.",
    style: "footnote",
  },
];

/**
 * The index to append at: one before the end of the body, because a document's
 * final newline cannot be written past.
 */
export function appendIndexFor(doc: {
  body?: { content?: Array<{ endIndex?: number | null }> | null } | null;
}): number {
  const content = doc.body?.content ?? [];
  const end = content.length ? (content[content.length - 1]?.endIndex ?? 1) : 1;
  return Math.max(1, end - 1);
}

/** The declaration as plain text, exactly as it will read in the document. */
export function declarationText(blocks: Block[] = DECLARATION_BLOCKS): string {
  return blocks.map((b) => b.text).join("\n") + "\n";
}

/**
 * Builds the Docs API requests that append the declaration as a new final page
 * starting at `insertIndex`.
 *
 * Requests are applied in order and each one's indices refer to the document as
 * the previous requests left it, so the page break and text go in first and the
 * styling ranges that follow are computed against the post-insert document.
 */
export function buildDeclarationRequests(
  insertIndex: number,
  blocks: Block[] = DECLARATION_BLOCKS
): docs_v1.Schema$Request[] {
  const requests: docs_v1.Schema$Request[] = [
    { insertPageBreak: { location: { index: insertIndex } } },
  ];

  // The page break occupies one index, so the text lands just after it.
  const textStart = insertIndex + 1;
  requests.push({
    insertText: { location: { index: textStart }, text: declarationText(blocks) },
  });

  let offset = textStart;
  for (const block of blocks) {
    const start = offset;
    const end = start + block.text.length;
    offset = end + 1; // +1 for the newline that terminates the paragraph

    // A blank line has no range to style.
    if (block.text.length === 0) continue;

    if (block.style === "heading") {
      requests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end },
          textStyle: { bold: true, fontSize: { magnitude: 14, unit: "PT" } },
          fields: "bold,fontSize",
        },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: { alignment: "CENTER" },
          fields: "alignment",
        },
      });
    } else if (block.style === "footnote") {
      requests.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: end },
          textStyle: { italic: true, fontSize: { magnitude: 8, unit: "PT" } },
          fields: "italic,fontSize",
        },
      });
    } else if (block.style === "option") {
      // Hanging indent keeps the wrapped lines clear of the checkbox.
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: {
            indentStart: { magnitude: 18, unit: "PT" },
            indentFirstLine: { magnitude: 0, unit: "PT" },
            spaceBelow: { magnitude: 6, unit: "PT" },
          },
          fields: "indentStart,indentFirstLine,spaceBelow",
        },
      });
    }
  }

  return requests;
}
