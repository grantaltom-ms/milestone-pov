import type { ParsedNotice, Charge } from "./claude";
import type { CityRules } from "./city-rules";

export interface NoticeTotals {
  rentTotal: number;
  utilityTotal: number;
  recurringTotal: number;
  paymentTotal: number;
  lateFeeTotal: number;
  totalDue: number;
  excludedCharges: Array<{ description: string; amount: number; reason: string }>;
}

const DAYS_TO_WORDS: Record<string, string> = {
  "3":   "three",
  "10":  "ten",
  "14":  "fourteen",
  "20":  "twenty",
  "30":  "thirty",
  "60":  "sixty",
  "90":  "ninety",
  "120": "one hundred twenty",
};

/**
 * Converts a notice days number string to its written form for use in
 * document body text, e.g. "30" → "thirty (30)".
 */
function noticeDaysText(days: string): string {
  const word = DAYS_TO_WORDS[days.trim()];
  return word ? `${word} (${days})` : days;
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}

function sum(arr: Charge[]): number {
  return arr.reduce((acc, c) => acc + c.amount, 0);
}

/**
 * Applies city rules to filter out disallowed charges and calculate
 * the compliant demand total.
 */
export function calculateTotals(
  parsed: ParsedNotice,
  rules: CityRules
): NoticeTotals {
  const excluded: Array<{ description: string; amount: number; reason: string }> = [];

  const disallowed = new Set([
    ...(rules.disallowedDemandCategories ?? []),
    ...(rules.excludeLateFeesFromDemand ? ["late_fee"] : []),
  ]);

  function filter(charges: Charge[], groupLabel: string): Charge[] {
    return charges.filter((c) => {
      if (disallowed.has(c.category)) {
        excluded.push({
          description: c.description,
          amount: c.amount,
          reason: `${c.category} not allowed in demand (${groupLabel})`,
        });
        return false;
      }
      return true;
    });
  }

  const allowedRent = filter(parsed.rent_charges, "rent");
  const allowedUtilities = filter(parsed.utility_charges, "utilities");
  const allowedRecurring = filter(parsed.recurring_fees, "recurring");
  // Late fees are always tracked separately but excluded from demand if required
  const lateFees = parsed.late_fees;

  const rentTotal = sum(allowedRent);
  const utilityTotal = sum(allowedUtilities);
  const recurringTotal = sum(allowedRecurring);
  const paymentTotal = sum(parsed.payments);
  const lateFeeTotal = sum(lateFees);

  const totalDue = rentTotal + utilityTotal + recurringTotal - paymentTotal;

  return {
    rentTotal,
    utilityTotal,
    recurringTotal,
    paymentTotal,
    lateFeeTotal,
    totalDue,
    excludedCharges: excluded,
  };
}

/**
 * Builds the placeholder → value replacement map for the Google Doc template.
 */
export function buildReplacements(
  parsed: ParsedNotice,
  totals: NoticeTotals,
  property: { noticeDays: string; jurisdiction: string; city: string; ownerName: string; ownerAddress: string }
): Record<string, string> {
  function chargeLines(charges: Charge[]): string {
    return charges
      .map((c) => {
        const dateStr = c.date ? ` (${c.date})` : "";
        return `${c.description}${dateStr}: ${formatCurrency(c.amount)}`;
      })
      .join("\n") || "None";
  }

  const allowedRecurring = parsed.recurring_fees.filter(
    (c) => !totals.excludedCharges.some((e) => e.description === c.description)
  );

  return {
    // Tenant & property
    "<<TENANT_NAME>>":      parsed.tenant_name,
    "<<PREMISES_ADDRESS>>": parsed.address,
    "<<PROPERTY_NAME>>":    parsed.property,
    "<<NOTICE_DAYS>>":      property.noticeDays,
    "<<JURISDICTION>>":     property.jurisdiction,

    // Replace hardcoded "14" instances in the template title and body text
    "14-DAY":               `${property.noticeDays}-DAY`,
    "fourteen (14) days":   `${noticeDaysText(property.noticeDays)} days`,

    // Totals — matched to template placeholder names
    "<<RENT_TOTAL>>":   formatCurrency(totals.rentTotal),
    "<<UTIL_TOTAL>>":   formatCurrency(totals.utilityTotal),
    "<<OTHER_TOTAL>>":  formatCurrency(totals.recurringTotal),
    "<<LESS_PAYMENTS>>": formatCurrency(totals.paymentTotal),
    "<<TOTAL_DUE>>":    formatCurrency(totals.totalDue),

    // Line items — matched to template placeholder names
    "<<RENT_LINES>>":    chargeLines(parsed.rent_charges),
    "<<UTIL_LINES>>":    chargeLines(parsed.utility_charges),
    "<<OTHER_LINES>>":   chargeLines(allowedRecurring),
    "<<PAYMENT_LINES>>": chargeLines(parsed.payments),

    // Owner & signing info — from mapping sheet columns J, K, D
    "<<OWNER_NAME>>":     property.ownerName,
    "<<OWNER_ADDRESS>>":  property.ownerAddress,
    "<<CITY_OF_SIGNING>>": property.city,
  };
}
