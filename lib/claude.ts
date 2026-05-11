import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ChargeCategory =
  | "monthly_rent"
  | "utilities"
  | "parking"
  | "storage"
  | "move_in_installment"
  | "covid_repayment_installment"
  | "other_recurring_periodic_lease_charge"
  | "late_fee"
  | "attorney_fee"
  | "notice_fee"
  | "service_fee"
  | "nsf_fee"
  | "damage_charge"
  | "deposit"
  | "one_time_fee"
  | "payment";

export interface Charge {
  description: string;
  amount: number;
  date?: string | null;
  category: ChargeCategory;
}

export interface ParsedNotice {
  tenant_name: string;
  property: string;
  address: string;
  rent_charges: Charge[];
  utility_charges: Charge[];
  recurring_fees: Charge[];
  payments: Charge[];
  late_fees: Charge[];
}

export async function parsePdfWithClaude(
  pdfBase64: string
): Promise<ParsedNotice> {
  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfBase64,
            },
          },
          {
            type: "text",
            text: `This is an AppFolio "Unpaid Charges" report. Parse it and return ONLY valid JSON with no markdown, no code fences, no explanation.

Return exactly this structure:
{
  "tenant_name": "Full name of the tenant (from the tenant section, e.g. 'Daniel B. Baral')",
  "property": "Property name from the property section — NOT the LLC/company name at the top of the page (e.g. 'Castle', not 'Castle LLC')",
  "address": "Tenant's full unit address including unit number, city, state, zip (e.g. '2132 2nd Avenue #406, Seattle, WA 98121')",
  "rent_charges": [{"description": "string", "amount": 0.00, "date": "YYYY-MM-DD", "category": "monthly_rent"}],
  "utility_charges": [{"description": "string", "amount": 0.00, "date": "YYYY-MM-DD", "category": "utilities"}],
  "recurring_fees": [{"description": "string", "amount": 0.00, "date": "YYYY-MM-DD or null", "category": "<see categories below>"}],
  "payments": [{"description": "string", "amount": 0.00, "date": "YYYY-MM-DD", "category": "payment"}],
  "late_fees": [{"description": "string", "amount": 0.00, "date": "YYYY-MM-DD", "category": "late_fee"}]
}

AppFolio-specific parsing rules:
- The charge table has columns: Date, Description, Charges, Payments, Balance
- PAYMENTS appear inline in the Payments column on the same row as a charge — extract any non-zero Payments column values as separate entries in the payments array, using the same date and a description like "Payment applied to [charge description]"
- "Rental Charges - [Month Year]" → rent_charges, category: monthly_rent
- "Building Utility Charge - [Month Year]" → utility_charges, category: utilities
- "Late Fees - Late Fee for [Month Year]" → late_fees, category: late_fee
- Parking, storage, and other recurring lease charges → recurring_fees with the appropriate category
- NSF fees, notice fees, damage charges, deposits → recurring_fees with the correct category below

Valid categories for recurring_fees:
  parking, storage, move_in_installment, covid_repayment_installment,
  other_recurring_periodic_lease_charge, nsf_fee, damage_charge,
  deposit, one_time_fee, notice_fee, service_fee, attorney_fee

General rules:
- All amounts must be positive numbers (not strings)
- Do NOT include the summary totals row at the bottom — only individual line items
- If a category has no items, return an empty array []
- Return ONLY the JSON object, nothing else`,
          },
        ],
      },
    ],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text.trim() : "";

  // Strip any accidental markdown fences
  const clean = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");

  try {
    return JSON.parse(clean) as ParsedNotice;
  } catch {
    throw new Error(`Claude returned unparseable JSON: ${clean.slice(0, 200)}`);
  }
}
