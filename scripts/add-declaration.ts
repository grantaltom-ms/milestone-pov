/**
 * Appends a Declaration of Service page to the notice templates.
 *
 * None of the templates the mapping sheet points at carries one, so every
 * notice the tool generates is missing the page a manager needs to prove
 * service. This script fixes that at the source.
 *
 * It never edits a template in place. It copies each one, appends the
 * declaration to the copy, verifies the result with the same checker that runs
 * on every generated notice, and prints the links for review. Pointing the
 * mapping sheet at the reviewed copies is a separate, explicit step.
 *
 * Usage:
 *   node --env-file=.env.local scripts/add-declaration.ts
 *   node --env-file=.env.local scripts/add-declaration.ts --dry-run
 *   node --env-file=.env.local scripts/add-declaration.ts --promote
 *
 *   --dry-run   List the templates and what would happen. Changes nothing.
 *   --promote   After copying and verifying, repoint column I of the mapping
 *               sheet at the new copies. Refuses if any copy failed its check.
 *               Run this only once you have opened the copies and approved them.
 */
import { google } from "googleapis";
import { appendIndexFor, buildDeclarationRequests } from "../lib/declaration-template.ts";
import { extractPages, verifyDeclarationOfService } from "../lib/declaration.ts";

const SUFFIX = " — with Declaration of Service";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const PROMOTE = args.has("--promote");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name}.\n` +
        `Run this from the repo root with your local env file:\n` +
        `  node --env-file=.env.local scripts/add-declaration.ts`
    );
    process.exit(1);
  }
  return value;
}

function auth() {
  const client = new google.auth.OAuth2(
    requireEnv("GOOGLE_CLIENT_ID"),
    requireEnv("GOOGLE_CLIENT_SECRET")
  );
  client.setCredentials({ refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN") });
  return client;
}

interface TemplateUse {
  templateDocId: string;
  /** Property names that point at this template, for the report. */
  properties: string[];
  jurisdictions: Set<string>;
  /** Sheet row numbers (1-based, including the header) holding this ID. */
  rows: number[];
}

/** Reads the mapping sheet and groups properties by the template they use. */
async function readTemplateUse(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string
): Promise<TemplateUse[]> {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: "A:K",
  });

  const rows = response.data.values ?? [];
  const byTemplate = new Map<string, TemplateUse>();

  rows.slice(1).forEach((row, i) => {
    const templateDocId = (row[8] ?? "").trim(); // I
    if (!templateDocId) return;

    const entry: TemplateUse = byTemplate.get(templateDocId) ?? {
      templateDocId,
      properties: [],
      jurisdictions: new Set<string>(),
      rows: [],
    };
    entry.properties.push((row[1] ?? "(unnamed)").trim()); // B
    if (row[7]) entry.jurisdictions.add(String(row[7]).trim()); // H
    entry.rows.push(i + 2); // +1 for the header, +1 for 1-based rows
    byTemplate.set(templateDocId, entry);
  });

  return [...byTemplate.values()];
}

/** Returns the existing copy's ID if this template was already processed. */
async function findExistingCopy(
  drive: ReturnType<typeof google.drive>,
  title: string
): Promise<string | null> {
  const escaped = title.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `name = '${escaped}' and trashed = false`,
    fields: "files(id,name)",
    pageSize: 1,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function main() {
  const client = auth();
  const drive = google.drive({ version: "v3", auth: client });
  const docs = google.docs({ version: "v1", auth: client });
  const sheets = google.sheets({ version: "v4", auth: client });
  const sheetId = requireEnv("GOOGLE_MAPPING_SHEET_ID");

  const templates = await readTemplateUse(sheets, sheetId);
  console.log(
    `\n${templates.length} template(s) in use across ` +
      `${templates.reduce((n, t) => n + t.properties.length, 0)} properties.\n`
  );

  const results: Array<{
    originalTitle: string;
    copyId: string | null;
    ok: boolean;
    note: string;
    rows: number[];
  }> = [];

  for (const template of templates) {
    const meta = await drive.files.get({
      fileId: template.templateDocId,
      fields: "name",
    });
    const originalTitle = meta.data.name ?? template.templateDocId;
    const copyTitle = `${originalTitle}${SUFFIX}`;
    const where = [...template.jurisdictions].join(", ") || "unknown jurisdiction";

    console.log(`${originalTitle}`);
    console.log(`  ${where} — ${template.properties.length} propert${template.properties.length === 1 ? "y" : "ies"}`);
    console.log(`  ${template.properties.join(", ")}`);

    // Does it already have one? Then there is nothing to do.
    const before = await docs.documents.get({ documentId: template.templateDocId });
    const existing = verifyDeclarationOfService(extractPages(before.data));
    if (existing.present) {
      console.log(`  → already has a Declaration of Service, skipping\n`);
      results.push({
        originalTitle,
        copyId: null,
        ok: true,
        note: "already had one",
        rows: template.rows,
      });
      continue;
    }

    if (DRY_RUN) {
      console.log(`  → would copy to "${copyTitle}" and append the declaration\n`);
      results.push({
        originalTitle,
        copyId: null,
        ok: true,
        note: "dry run",
        rows: template.rows,
      });
      continue;
    }

    // Re-running must not litter the Drive with duplicate copies.
    const alreadyCopied = await findExistingCopy(drive, copyTitle);
    if (alreadyCopied) {
      console.log(`  → copy already exists, leaving it alone`);
      console.log(`     https://docs.google.com/document/d/${alreadyCopied}/edit\n`);
      results.push({
        originalTitle,
        copyId: alreadyCopied,
        ok: true,
        note: "copy already existed",
        rows: template.rows,
      });
      continue;
    }

    const copy = await drive.files.copy({
      fileId: template.templateDocId,
      requestBody: { name: copyTitle },
    });
    const copyId = copy.data.id;
    if (!copyId) throw new Error(`Drive returned no ID copying ${originalTitle}`);

    const fresh = await docs.documents.get({ documentId: copyId });
    await docs.documents.batchUpdate({
      documentId: copyId,
      requestBody: { requests: buildDeclarationRequests(appendIndexFor(fresh.data)) },
    });

    // Prove the work with the same checker that guards every generated notice.
    const after = await docs.documents.get({ documentId: copyId });
    const check = verifyDeclarationOfService(extractPages(after.data));

    // `<<CITY_OF_SIGNING>>` is *supposed* to still be there in a template — it
    // is filled in when a notice is generated — so placeholders are not a fault
    // here, unlike on a finished notice.
    const ok =
      check.present &&
      check.onFinalPage &&
      check.hasPageBreakBefore &&
      check.missingFields.length === 0;

    console.log(`  → ${ok ? "added and verified" : "ADDED BUT FAILED VERIFICATION"}`);
    if (!ok) for (const p of check.problems) console.log(`     ! ${p}`);
    console.log(`     https://docs.google.com/document/d/${copyId}/edit\n`);

    results.push({
      originalTitle,
      copyId,
      ok,
      note: ok ? "added" : check.problems.join("; "),
      rows: template.rows,
    });
  }

  const failed = results.filter((r) => !r.ok);

  console.log("─".repeat(60));
  if (DRY_RUN) {
    console.log("Dry run — nothing was changed.");
    return;
  }

  console.log(
    `${results.filter((r) => r.copyId && r.ok).length} copy/copies ready for review, ` +
      `${failed.length} problem(s).\n`
  );
  for (const r of results) {
    console.log(`  ${r.ok ? "ok " : "!! "} ${r.originalTitle} — ${r.note}`);
  }
  console.log("\nOpen each link above and check the last page before promoting.");

  if (!PROMOTE) {
    console.log(
      "\nWhen the copies look right, point the mapping sheet at them:\n" +
        "  node --env-file=.env.local scripts/add-declaration.ts --promote"
    );
    return;
  }

  if (failed.length > 0) {
    console.error("\nRefusing to promote — fix the failures above first.");
    process.exit(1);
  }

  const updates = results
    .filter((r) => r.copyId)
    .flatMap((r) => r.rows.map((row) => ({ range: `I${row}`, values: [[r.copyId!]] })));

  if (updates.length === 0) {
    console.log("\nNothing to promote.");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: "RAW", data: updates },
  });
  console.log(`\nPromoted — ${updates.length} sheet row(s) now point at the new templates.`);
}

main().catch((err) => {
  console.error("\nFailed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
