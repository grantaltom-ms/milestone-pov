# Milestone POV Tool

Automated Pay or Vacate notice generation for Milestone Properties. Triggered by uploading an AppFolio unpaid charges PDF to a Slack channel — produces a fully populated, jurisdiction-compliant Google Doc notice within ~15 seconds.

## How It Works

1. A manager uploads an AppFolio "Unpaid Charges" PDF to **#delinq** in Slack
2. The app downloads and parses the PDF using Claude AI
3. The property is matched against the Google Sheets mapping to get jurisdiction, notice days, and template
4. City-specific compliance rules are applied (charge filtering, preflight checks)
5. A Google Doc is copied from the template and filled with tenant/charge data
6. A confirmation is posted to #delinq tagging the property manager
7. The property manager receives a direct Slack DM with a link to the notice

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
  supabase.ts                 — Property manager lookup
scripts/
  get-google-token.ts         — One-time Google OAuth refresh token helper
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

## Getting a Google Refresh Token (first-time setup)

```bash
# Make sure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are in .env.local
npx ts-node scripts/get-google-token.ts
# Open the URL, authorize, paste the code back
# Add the printed GOOGLE_REFRESH_TOKEN to .env.local and Vercel env vars
```
