/**
 * The Claude model that reads AppFolio "Unpaid Charges" PDFs for pay-or-vacate
 * notices. Kept in one place so a model upgrade is a one-line change. Use an
 * alias, never a dated id (e.g. "-20250514"): dated ids get retired and notice
 * generation stops working.
 */
export const CLAUDE_MODEL = "claude-sonnet-5-5";

/**
 * Sonnet 5.5 thinks by default, and max_tokens covers thinking PLUS the answer.
 * Added on top of the answer budget so thinking can't crowd out the parsed
 * ledger JSON. It is a ceiling, not a charge.
 */
export const THINKING_HEADROOM_TOKENS = 4000;

/**
 * The text of a Claude reply. Sonnet 5.5 replies can START with a thinking
 * block, so reading content[0] by position finds no text and every PDF fails
 * to parse. Always read replies through this instead.
 */
export function responseText(response: { content?: Array<{ type: string; text?: string }> }): string {
  return (response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}
