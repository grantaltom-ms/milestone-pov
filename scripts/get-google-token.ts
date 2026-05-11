/**
 * One-time script to get a Google OAuth refresh token.
 * Run: npx ts-node scripts/get-google-token.ts
 */

import { google } from "googleapis";
import * as http from "http";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your env first.");
  process.exit(1);
}

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/documents",
];

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = auth.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

console.log("\nOpen this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for authorization...\n");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:3000`);
  const code = url.searchParams.get("code");

  if (!code) {
    res.end("No code found.");
    return;
  }

  res.end("<h2>✅ Authorized! You can close this tab and return to the terminal.</h2>");
  server.close();

  const { tokens } = await auth.getToken(code);
  console.log("\n✅ Add this to your .env.local and Vercel environment variables:\n");
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
});

server.listen(3000);
