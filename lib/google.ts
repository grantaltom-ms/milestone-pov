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

  const normalise = (s: string) => s.toLowerCase().trim();
  const propNorm = normalise(propertyName);
  const addrNorm = normalise(address);

  const match = dataRows.find((row) => {
    const rowName = normalise(row[1] ?? "");           // B: Property Name
    const rowAddr = normalise(row[2] ?? "");           // C: Address
    const rowCity = normalise(row[3] ?? "");           // D: City
    const rowFull = `${rowAddr}, ${rowCity}`.trim();   // combined for address matching

    return (
      rowName === propNorm ||
      propNorm.includes(rowName) ||
      rowName.includes(propNorm) ||
      addrNorm.includes(rowAddr) ||
      rowFull === addrNorm ||
      addrNorm.includes(rowCity)
    );
  });

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
