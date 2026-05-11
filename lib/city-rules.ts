export type LateFeeCapRule =
  | { type: "flat"; amount: number; period: string }
  | { type: "percentOfMonthlyRent"; percent: number };

export interface CityRules {
  // noticeDays is intentionally NOT stored here.
  // It is sourced per-building from column G of the mapping sheet,
  // because federal law (CARES Act) and individual lease agreements
  // can require longer notice periods than the city default.
  requiresCityEvictionLanguage?: boolean;
  requiresRightToCounselLanguage?: boolean;
  requiresCityPayOrVacateDisclosure?: boolean;
  disclosureFontSizePt?: number;
  disclosureBold?: boolean;
  cityDisclosureTextMustBeAttorneyEditable?: boolean;
  lateFeeCap?: LateFeeCapRule;
  prohibitNoticePreparationFees?: boolean;
  prohibitNoticeServiceFees?: boolean;
  prohibitOtherLatePaymentFees?: boolean;
  excludeLateFeesFromDemand?: boolean;
  requiresMonthYearForEachCharge?: boolean;
  allowedDemandCategories?: string[];
  disallowedDemandCategories?: string[];
  requiredPreflightChecks: string[];
}

export const cityRules: Record<string, CityRules> = {
  Seattle: {

    requiresCityEvictionLanguage: true,
    requiresRightToCounselLanguage: true,
    requiresMonthYearForEachCharge: true,
    lateFeeCap: { type: "flat", amount: 10, period: "month" },
    prohibitNoticePreparationFees: true,
    prohibitNoticeServiceFees: true,
    excludeLateFeesFromDemand: true,
    allowedDemandCategories: [
      "monthly_rent",
      "utilities",
      "parking",
      "storage",
      "move_in_installment",
      "covid_repayment_installment",
      "other_recurring_periodic_lease_charge",
    ],
    disallowedDemandCategories: [
      "late_fee",
      "attorney_fee",
      "notice_fee",
      "service_fee",
      "nsf_fee",
      "damage_charge",
      "deposit",
      "one_time_fee",
    ],
    requiredPreflightChecks: [
      "Seattle city eviction language included in template",
      "Right-to-legal-counsel language included in template",
      "No late fees, notice fees, or NSF fees included in demand",
      "Personal-service attempt workflow reviewed",
      "Each charge itemized with month and year",
    ],
  },

  Burien: {

    requiresCityPayOrVacateDisclosure: true,
    disclosureFontSizePt: 16,
    disclosureBold: true,
    lateFeeCap: { type: "flat", amount: 10, period: "month" },
    prohibitOtherLatePaymentFees: true,
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      "Burien 16-point bold disclosure included in template",
      "Rental housing business license compliance confirmed",
      "Rental inspection compliance confirmed (if applicable)",
      "Tenant information packet compliance confirmed",
    ],
  },

  SeaTac: {

    requiresCityPayOrVacateDisclosure: true,
    disclosureFontSizePt: 16,
    disclosureBold: true,
    excludeLateFeesFromDemand: true,
    cityDisclosureTextMustBeAttorneyEditable: true,
    requiredPreflightChecks: [
      "SeaTac 16-point bold disclosure included in template",
      "Renting in SeaTac Guide compliance confirmed",
      "Fixed-income due-date accommodation checked",
      "Just-cause basis confirmed",
    ],
  },

  Redmond: {

    requiresCityPayOrVacateDisclosure: false,
    lateFeeCap: { type: "percentOfMonthlyRent", percent: 1.5 },
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      "No Redmond-specific pay-or-vacate disclosure found — statewide form used",
      "Late fees excluded from demand",
    ],
  },

  Renton: {

    requiresCityPayOrVacateDisclosure: false,
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      "No Renton-specific pay-or-vacate disclosure found — statewide form used",
      "Rental registration/inspection compliance reviewed (if applicable)",
    ],
  },

  "Des Moines": {

    requiresCityPayOrVacateDisclosure: false,
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      "No Des Moines-specific pay-or-vacate disclosure found — statewide form used",
    ],
  },

  Bellevue: {

    requiresCityPayOrVacateDisclosure: false,
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      "No Bellevue-specific pay-or-vacate disclosure found — statewide form used",
    ],
  },

  Issaquah: {

    requiresCityPayOrVacateDisclosure: false,
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      "No Issaquah-specific pay-or-vacate disclosure found — statewide form used",
      "Rent-increase rules handled separately — not part of pay-or-vacate notice",
    ],
  },
};

/**
 * Looks up city rules by jurisdiction string (case-insensitive, partial match).
 * Falls back to a safe default if the jurisdiction isn't in the table.
 */
export function getRulesForJurisdiction(jurisdiction: string): CityRules {
  const normalised = jurisdiction.trim().toLowerCase();

  const match = Object.entries(cityRules).find(([city]) =>
    normalised.includes(city.toLowerCase())
  );

  if (match) return match[1];

  // Safe statewide fallback
  return {
    excludeLateFeesFromDemand: true,
    requiredPreflightChecks: [
      `No city-specific rules found for "${jurisdiction}" — statewide form used`,
      "Verify with counsel before serving",
    ],
  };
}
