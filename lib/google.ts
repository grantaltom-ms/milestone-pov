import { google } from "googleapis";

function getAuthClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

export interface PropertyRecord {
  noticeDays: string;
  jurisdiction: string;
  templateDocId: string;
  city: string;
  ownerName: string;
  ownerAddress: string;
}

/**
 * Looks up a property in the mapping Google Sheet.
 *
 * Expected sheet columns (row 1 = headers):
 *   A: Building ID
 *   B: Property Name
 *   C: Address
 *   D: City
 *   E: State
 *   F: Zip
 *   G: Notice Days
 *   H: Jurisdiction
 *   I: Template Doc ID
 *   J: Owner/Agent Name
 *   K: Owner/Agent Address
 */
export async function lookupProperty(
  propertyName: string,
  address: string
): Promise<PropertyRecord> {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_MAPPING_SHEET_ID,
    range: "A:K",
  });

  const rows = response.data.values ?? [];
  // Skip header row
  const dataRows = rows.slice(1);

  // Normalise: lowercase, strip punctuation, collapse whitespace. This makes
  // matching robust to differences like "U.W. Pacific" vs "UW Pacific" and
  // stray double spaces between the PDF header and the sheet entry.
  const normalise = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const propNorm = normalise(propertyName);
  const addrNorm = normalise(address);
  const propTokens = propNorm.split(" ").filter(Boolean);

  /**
   * True when two property names agree from their first token onward — i.e.
   * one is a leading token-prefix of the other ("UW Pacific" vs "UW Pacific
   * Apartments"). We anchor on the leading token because a property's most
   * distinctive identifier comes first, so this refuses to match a row that
   * only shares a TRAILING word ("Pacific Apartments" vs "UW Pacific
   * Apartments"), which a different building can easily collide on.
   */
  const isLeadingPrefix = (a: string[], b: string[]): boolean => {
    const n = Math.min(a.length, b.length);
    if (n === 0) return false;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  /**
   * Score a row against the parsed property. Higher = better. 0 = no match.
   *
   * We deliberately rank exact / strong matches above weak substring matches,
   * and we do NOT match on city alone — many properties share a city, so a
   * city-only match would return whichever such property happens to appear
   * first in the sheet (the original bug: a Seattle tenant address matched the
   * first Seattle row instead of its own property's row).
   */
  function scoreRow(row: string[]): number {
    const rowName = normalise(row[1] ?? "");   // B: Property Name
    const rowAddr = normalise(row[2] ?? "");   // C: Address
    const rowCity = normalise(row[3] ?? "");   // D: City
    const rowFull = normalise(`${row[2] ?? ""} ${row[3] ?? ""}`);

    if (!rowName && !rowAddr) return 0;

    // Tier 4 — exact property-name match (strongest signal).
    if (rowName && rowName === propNorm) return 400 + rowName.length;

    // Tier 3 — exact full address (street + city) match.
    if (rowFull && rowFull === addrNorm) return 300 + rowFull.length;

    // Tier 2 — strong property-name match: one name is a leading token-prefix
    // of the other. Anchoring on the leading token (rather than a raw,
    // position-agnostic substring) is what keeps a longer trailing fragment of
    // a DIFFERENT property from hijacking the match — e.g. parsing "UW Pacific
    // Apartments" must still resolve to the "UW Pacific" row, not a separate
    // "Pacific Apartments" building whose name scored higher purely on length.
    // We reward deeper prefix agreement so the most specific row still wins.
    const rowTokens = rowName.split(" ").filter(Boolean);
    if (rowName.length >= 4 && propNorm.length >= 4 &&
        isLeadingPrefix(propTokens, rowTokens)) {
      return 200 + Math.min(propTokens.length, rowTokens.length);
    }

    // Tier 1 — the tenant's address contains the row's street address.
    // Require a reasonably specific street string to avoid false hits.
    if (rowAddr.length >= 6 && addrNorm.includes(rowAddr))
      return 100 + rowAddr.length;

    return 0;
  }

  let match: string[] | undefined;
  let bestScore = 0;
  for (const row of dataRows) {
    const score = scoreRow(row);
    if (score > bestScore) {
      bestScore = score;
      match = row;
    }
  }

  if (!match) {
    throw new Error(
      `Property not found in mapping sheet: "${propertyName}" / "${address}"`
    );
  }

  const noticeDays    = match[6] ?? "";   // G
  const jurisdiction  = match[7] ?? "";   // H
  const templateDocId = match[8] ?? "";   // I
  const ownerName     = match[9] ?? "";   // J
  const ownerAddress  = match[10] ?? "";  // K
  const city          = match[3] ?? "";   // D

  if (!templateDocId) {
    throw new Error(
      `No template Doc ID found for property "${propertyName}". Check the mapping sheet.`
    );
  }

  return { noticeDays, jurisdiction, templateDocId, city, ownerName, ownerAddress };
}

/**
 * Copies a Google Doc template and returns the new document's ID.
 */
export async function copyTemplate(
  templateDocId: string,
  title: string
): Promise<string> {
  const auth = getAuthClient();
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.copy({
    fileId: templateDocId,
    requestBody: { name: title },
  });

  const newId = response.data.id;
  if (!newId) throw new Error("Google Drive copy returned no file ID");
  return newId;
}

/**
 * Performs batch text replacement in a Google Doc using the Docs API.
 */
export async function replaceTextInDoc(
  docId: string,
  replacements: Record<string, string>
): Promise<void> {
  const auth = getAuthClient();
  const docs = google.docs({ version: "v1", auth });

  const requests = Object.entries(replacements).map(
    ([placeholder, value]) => ({
      replaceAllText: {
        containsText: { text: placeholder, matchCase: true },
        replaceText: value,
      },
    })
  );

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests },
  });
}

/**
 * Returns a direct URL to view the document in Google Drive.
 */
export function docUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}
