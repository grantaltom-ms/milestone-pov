/**
 * Pins the model that reads tenant ledgers for pay-or-vacate notices, and runs
 * the real PDF parser against a local fake Claude API (free, no real tenant
 * data) to prove every request sends that model.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MODEL } from "./model.ts";

const ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("Claude model", () => {
  test("is Sonnet 5.5", () => {
    assert.equal(CLAUDE_MODEL, "claude-sonnet-5-5");
  });

  test("is an alias, not a dated id that will eventually be retired", () => {
    assert.doesNotMatch(CLAUDE_MODEL, /-\d{8}$/);
  });

  test("lib/model.ts is the only file that names a model", () => {
    const offenders = ["app", "lib"]
      .flatMap((d) => sourceFiles(join(ROOT, d)))
      .filter((f) => !f.endsWith(join("lib", "model.ts")) && !f.endsWith(".test.ts"))
      .filter((f) => /["'`]claude-(opus|sonnet|haiku)[^"'`]*["'`]/.test(readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });
});

describe("parsePdfWithClaude against a fake Claude API", () => {
  const seen: { model: string; hasPdf: boolean }[] = [];
  let server: Server;
  let parsePdfWithClaude: (pdf: string) => Promise<{ tenant_name: string; rent_charges: unknown[] }>;

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const hasPdf = parsed.messages[0].content.some((c: { type: string }) => c.type === "document");
        seen.push({ model: parsed.model, hasPdf });
        const notice = {
          tenant_name: `Tenant ${seen.length}`,
          property: "Castle",
          address: "2132 2nd Avenue #406, Seattle, WA 98121",
          rent_charges: [{ description: "Rental Charges - September 2026", amount: 1850, date: "2026-09-01", category: "monthly_rent" }],
          utility_charges: [],
          recurring_fees: [],
          payments: [],
          late_fees: [],
        };
        // The second reply wraps the JSON in a code fence, which the parser must strip.
        const text = seen.length === 2 ? "```json\n" + JSON.stringify(notice) + "\n```" : JSON.stringify(notice);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: `msg_${seen.length}`, type: "message", role: "assistant", model: parsed.model,
          content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Imported only now: the Claude client is built when the module loads.
    ({ parsePdfWithClaude } = await import("./claude.ts"));
  });

  after(() => server.close());

  test("parses three ledgers in a row, sending Sonnet 5.5 every time", async () => {
    for (let i = 1; i <= 3; i++) {
      const notice = await parsePdfWithClaude(Buffer.from(`%PDF fake ledger ${i}`).toString("base64"));
      assert.equal(notice.tenant_name, `Tenant ${i}`);
      assert.equal(notice.rent_charges.length, 1);
    }
    assert.equal(seen.length, 3);
    for (const call of seen) {
      assert.equal(call.model, "claude-sonnet-5-5");
      assert.equal(call.hasPdf, true);
    }
  });
});
