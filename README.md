# Milestone POV Tool

Automated Pay or Vacate notice generation for Milestone Properties. Triggered by uploading an AppFolio unpaid charges PDF to a Slack channel — produces a fully populated, jurisdiction-compliant Google Doc notice within ~15 seconds.

## How It Works

1. A manager uploads an AppFolio "Unpaid Charges" PDF to **#delinq** in Slack
2. The app downloads and parses the PDF using Claude AI
3. The property is matched against the Google Sheets mapping to get jurisdiction, notice days, and template
4. City-specific compliance rules are applied (charge filtering, preflight checks)
5. A Google Doc is copied from the template and filled with tenant/charge data
6. The finished doc is read back and checked for a complete Declaration of Service
7. A confirmation is posted to #delinq tagging the property manager
8. The property manager receives a direct Slack DM with a link to the notice

## Stack

- **Next.js** (App Router) on Vercel — serverless API route
- **Claude API** (claude-opus-4-6) — PDF parsing and charge categorization
- **Google Sheets** — property mapping (jurisdiction, notice days, template Doc ID, owner info)
- **Google Drive + Docs API** — template copying and text replacement
- **Slack API** — event trigger, channel notification, manager DM
- **Supabase** — property manager directory

## Project Structure

```
app/
  api/slack/events/route.ts   — Main webhook handler (Slack → Claude → Google → Slack)
lib/
  slack-verify.ts             — Slack request signature verification
  claude.ts                   — PDF parsing via Claude API
  google.ts                   — Sheets lookup, Drive copy, Docs text replacement
  notice.ts                   — Charge filtering, totals calculation, placeholder map
  city-rules.ts               — Jurisdiction-specific compliance rules
  declaration.ts              — Declaration of Service verification on the finished doc
  declaration-template.ts     — The declaration page the template script appends
  supabase.ts                 — Property manager lookup
  declaration.test.ts         — Unit tests for the declaration check
  declaration-template.test.ts — Tests for the appended page and its index math
  state-gate.test.ts          — Tests for the Washington-only gate
  notice-pipeline.test.ts     — End-to-end test: parse → notice → verification
scripts/
  get-google-token.ts         — One-time Google OAuth refresh token helper
  add-declaration.ts          — Adds the declaration page to the templates
```

## Environment Variables

| Variable | Where to find it |
|---|---|
| `SLACK_BOT_TOKEN` | api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | api.slack.com/apps → Basic Information → Signing Secret |
| `SLACK_DELINQ_CHANNEL_ID` | Right-click #delinq in Slack → View channel details → bottom of panel |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_REFRESH_TOKEN` | Run `npx ts-node scripts/get-google-token.ts` |
| `GOOGLE_MAPPING_SHEET_ID` | The ID portion of the mapping spreadsheet URL |
| `SUPABASE_URL` | Supabase dashboard → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → Settings → API → service_role key |

Copy `.env.example` to `.env.local` and fill in all values.

## Google Sheets Mapping

The mapping sheet must have these columns (row 1 = headers):

| A | B | C | D | E | F | G | H | I | J | K |
|---|---|---|---|---|---|---|---|---|---|---|
| Building ID | Property Name | Address | City | State | Zip | Notice Days | Jurisdiction | Template Doc ID | Owner/Agent Name | Owner/Agent Address |

- **Notice Days** — sourced per-building from this sheet. CARES Act properties use 30.
- **Template Doc ID** — the ID portion of the Google Doc template URL.
- **Jurisdiction** — must match a city in `lib/city-rules.ts` (Seattle, Burien, SeaTac, Redmond, Renton, Bellevue, Des Moines, Issaquah). Unmatched jurisdictions fall back to statewide form.

## Google Doc Templates

Templates use `<<PLACEHOLDER>>` style tags. The following are replaced on each run:

| Placeholder | Value |
|---|---|
| `<<TENANT_NAME>>` | Tenant full name |
| `<<PREMISES_ADDRESS>>` | Tenant unit address |
| `<<PROPERTY_NAME>>` | Property name |
| `<<NOTICE_DAYS>>` | Notice period (from mapping sheet) |
| `<<JURISDICTION>>` | City/jurisdiction |
| `<<RENT_TOTAL>>` | Total rent charges |
| `<<UTIL_TOTAL>>` | Total utility charges |
| `<<OTHER_TOTAL>>` | Total other recurring charges |
| `<<LESS_PAYMENTS>>` | Total payments applied |
| `<<TOTAL_DUE>>` | Final amount due |
| `<<RENT_LINES>>` | Rent charge line items |
| `<<UTIL_LINES>>` | Utility charge line items |
| `<<OTHER_LINES>>` | Other charge line items |
| `<<PAYMENT_LINES>>` | Payment line items |
| `<<OWNER_NAME>>` | Owner/agent name |
| `<<OWNER_ADDRESS>>` | Owner/agent address |
| `<<CITY_OF_SIGNING>>` | City (from mapping sheet column D) |
| `14-DAY` | Replaced with `{noticeDays}-DAY` |
| `fourteen (14) days` | Replaced with written form, e.g. `thirty (30) days` |

## Declaration of Service Check

A notice is only servable if the manager can prove they served it, so every
generated notice must end with a completed Declaration of Service page.

**The generator never adds pages.** It copies a template and replaces
placeholders — nothing more. So the declaration is present only because the
template already carried it, and each jurisdiction has its own hand-maintained
template. A template that never had the page, or that loses it in a later edit,
would otherwise produce unservable notices silently.

After filling in each notice, `lib/declaration.ts` reads the document back and
confirms:

| Check | Fails when |
|---|---|
| Declaration present | The template has no Declaration of Service at all |
| It is the final page | Other content appears after the declaration |
| A page break precedes it | It would print on the same page as the notice body |
| It fits on one page | The form overflows — usually a template spacing problem |
| All fields present | Perjury clause, who was served, service methods, signature, printed name, city of signing |
| No leftover placeholders | A `<<TAG>>` survived because a replacement did not land |

Anything wrong posts a red-flag warning in **both** the #delinq message and the
manager's DM, naming the specific problem and telling them to fix the template
and regenerate. **The notice is still created and linked** — a failed check
never costs the manager the document, it just stops them printing a defective
one unnoticed.

If the read-back itself fails (a Docs API hiccup), the warning downgrades to
"verify the final page by hand" rather than losing the notice.

**One limitation worth knowing:** the Docs API only reports page breaks the
template author actually inserted — it does not report pagination caused by
content overflowing a page. So a template should separate its declaration with
a real page break rather than relying on the notice happening to fill the page.

## Adding the Declaration of Service to Templates

`scripts/add-declaration.ts` appends the declaration page to the notice
templates. It never edits a template in place — it copies each one, appends the
declaration to the copy, verifies the result with the same checker that runs on
every generated notice, and prints the links for review.

Requires **Node 22.18 or newer** — the script and the test suite run TypeScript
through Node directly, with no build step. Check with `node -v`.

```bash
npm run add-declaration -- --dry-run   # list what it would do, change nothing
npm run add-declaration                # make the copies
# open each printed link, check the last page
npm run add-declaration -- --promote   # repoint the mapping sheet at the copies
```

- Templates are discovered from column I of the mapping sheet, so the script
  stays correct as properties are added.
- A template that **already** has a declaration is skipped.
- Re-running does not create duplicate copies — an existing copy is left alone.
- `--promote` refuses to run if any copy failed verification.
- Uses the same Google credentials as the app (`.env.local`); no extra scopes.

`<<CITY_OF_SIGNING>>` is intentionally left in the appended page — the same
replacement that fills the notice body's signature block fills it at generation
time. That is why the script checks the declaration's *fields*, not its
placeholders: a leftover tag is a fault on a finished notice, not on a template.

**The appended page is not a pixel-for-pixel reproduction of the RHAWA form.**
It carries the same substance — the perjury certification, the four statutory
service methods, the mail method, and the signature block — but the layout
differs. If the exact RHAWA form is required, paste it into each template by
hand instead; the verification on every generated notice works either way.

## City Compliance Rules

Defined in `lib/city-rules.ts`. Key rules per jurisdiction:

| City | Late fees excluded | Special requirements |
|---|---|---|
| **Seattle** | Yes (+ NSF, notice, damage fees) | City eviction language, right-to-counsel language, month/year itemization |
| **Burien** | Yes | 16pt bold disclosure, rental license/inspection preflight |
| **SeaTac** | Yes | 16pt bold disclosure, renting guide / just-cause preflight |
| **Redmond** | Yes | 1.5% late fee cap noted |
| **Others** | Yes | Statewide form |

Each city's preflight checklist is posted in the Slack notification so managers know what to verify before serving.

## Adding a New Property

1. Add a row to the Google Sheets mapping with all 11 columns filled in
2. Make sure the Template Doc ID points to the correct jurisdiction template
3. Make sure the property name matches what AppFolio uses in the PDF header

No code changes needed.

## Slack App Requirements

**Bot Token Scopes:**
- `files:read`
- `chat:write`
- `channels:history`
- `users:read`
- `users:read.email`

**Event Subscriptions:**
- Request URL: `https://milestone-pov.vercel.app/api/slack/events`
- Bot event: `file_shared`

## Local Development

```bash
npm install
cp .env.example .env.local
# fill in .env.local

npm run dev
# Webhook available at http://localhost:3000/api/slack/events
# Use ngrok or similar to expose locally for Slack testing
```

### Checks

```bash
npm run lint         # ESLint
npm run type-check   # tsc --noEmit
npm test             # node --test (no external calls — all fixtures)
npm run build        # next build
```

All four run in CI on every push and pull request (`.github/workflows/ci.yml`).

The test suite covers the declaration check against the real RHAWA form text and
runs the full parse → notice → verification flow for every jurisdiction, with
Claude, Google, Slack and Supabase all stood in for by fixtures — so it is fast,
free and deterministic.

## Getting a Google Refresh Token (first-time setup)

Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env.local` first — both
are visible in Google Cloud Console under APIs & Services → Credentials. Then:

```bash
npm run get-google-token
```

Open the printed URL, authorize, and the script prints a `GOOGLE_REFRESH_TOKEN`
to add to `.env.local`.

**Note:** environment variables marked *Sensitive* in Vercel cannot be read back
out — `vercel env pull` writes `[SENSITIVE]` as a placeholder for them. If the
Google values come down that way, mint a fresh refresh token with the command
above rather than trying to recover the stored one.
