/**
 * The Claude model that reads AppFolio "Unpaid Charges" PDFs for pay-or-vacate
 * notices. Kept in one place so a model upgrade is a one-line change. Use an
 * alias, never a dated id (e.g. "-20250514"): dated ids get retired and notice
 * generation stops working.
 */
export const CLAUDE_MODEL = "claude-sonnet-5-5";
