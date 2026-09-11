import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { verifySlackRequest } from "@/lib/slack-verify";
import { parsePdfWithClaude } from "@/lib/claude";
import { lookupProperty, copyTemplate, replaceTextInDoc, fetchDocPages, docUrl } from "@/lib/google";
import { calculateTotals, formatCurrency, buildReplacements } from "@/lib/notice";
import { getRulesForJurisdiction } from "@/lib/city-rules";
import { verifyDeclarationOfService, declarationWarningText } from "@/lib/declaration";
import { lookupManager } from "@/lib/supabase";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function POST(req: Request) {
  const { valid, body } = await verifySlackRequest(req);
  if (!valid) return new Response("Unauthorized", { status: 401 });

  const payload = JSON.parse(body);

  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  if (payload.event?.type !== "file_shared") {
    return new Response("OK", { status: 200 });
  }

  const event = payload.event;
  const channelId = event.channel_id ?? event.channel;

  if (channelId !== process.env.SLACK_DELINQ_CHANNEL_ID) {
    return new Response("OK", { status: 200 });
  }

  waitUntil(processNotice(event.file_id, channelId));
  return new Response("OK", { status: 200 });
}

/**
 * Looks up a Slack user ID by email address.
 * Returns null if not found (so the rest of the flow still completes).
 */
async function getSlackUserId(email: string): Promise<string | null> {
  try {
    const res = await slack.users.lookupByEmail({ email });
    return res.user?.id ?? null;
  } catch {
    console.warn(`Could not find Slack user for ${email}`);
    return null;
  }
}

async function processNotice(fileId: string, channelId: string) {
  try {
    // --- Step 1: Get file info from Slack ---
    const fileInfo = await slack.files.info({ file: fileId });
    const file = fileInfo.file;

    if (!file) throw new Error("Could not retrieve file info from Slack");
    if (!file.mimetype?.includes("pdf")) {
      console.log(`Skipping non-PDF file: ${file.mimetype}`);
      return;
    }

    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) throw new Error("No download URL on file");

    // --- Step 2: Download the PDF ---
    const response = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);

    const buffer = await response.arrayBuffer();
    const sizeKb = buffer.byteLength / 1024;
    if (sizeKb < 5) throw new Error(`PDF too small (${sizeKb.toFixed(1)} KB) — may be empty`);

    const pdfBase64 = Buffer.from(buffer).toString("base64");

    // --- Step 3: Parse with Claude ---
    console.log(`Parsing PDF (${sizeKb.toFixed(0)} KB) with Claude...`);
    const parsed = await parsePdfWithClaude(pdfBase64);
    console.log(`Parsed: ${parsed.tenant_name} @ ${parsed.property}`);

    // --- Step 4: Look up property + manager in parallel ---
    const [propertyData, manager] = await Promise.all([
      lookupProperty(parsed.property, parsed.address),
      lookupManager(parsed.property),
    ]);
    console.log(`Matched: ${propertyData.jurisdiction}, ${propertyData.noticeDays} days`);
    console.log(`Manager: ${manager?.manager_name ?? "not found"}`);

    // --- Step 5: Resolve manager's Slack user ID ---
    const managerSlackId = manager
      ? await getSlackUserId(manager.manager_email)
      : null;

    // --- Step 6: Apply jurisdiction rules & calculate totals ---
    const rules = getRulesForJurisdiction(propertyData.jurisdiction);
    const totals = calculateTotals(parsed, rules);

    if (totals.totalDue < 0) {
      throw new Error(
        `Total due is negative ($${totals.totalDue.toFixed(2)}) — review charges before serving notice`
      );
    }

    // --- Step 7: Copy template & replace placeholders ---
    const docTitle = `Pay or Vacate — ${parsed.tenant_name} — ${new Date().toLocaleDateString("en-US")}`;
    const newDocId = await copyTemplate(propertyData.templateDocId, docTitle);
    const replacements = buildReplacements(parsed, totals, propertyData);
    await replaceTextInDoc(newDocId, replacements);
    console.log("Text replacements applied.");

    // --- Step 8: Verify the finished notice is complete ---
    // Notices are built by copying a per-jurisdiction Google Doc template, so a
    // template missing its Declaration of Service silently produces unservable
    // notices for every property pointed at it. Read the document back and say
    // so loudly rather than letting a manager discover it at the courthouse.
    let declarationWarning: string | null = null;
    try {
      const check = verifyDeclarationOfService(await fetchDocPages(newDocId));
      declarationWarning = declarationWarningText(check);
      console.log(
        check.ok
          ? "Declaration of Service verified."
          : `Declaration check failed: ${check.problems.join(" | ")}`
      );
    } catch (err) {
      // The notice itself was created successfully — a read-back failure must
      // downgrade to "verify by hand", never cost the manager the document.
      console.warn(
        "Declaration check could not run:",
        err instanceof Error ? err.message : String(err)
      );
      declarationWarning =
        ":warning: *Could not verify the Declaration of Service on this notice* — check the final page by hand before serving.";
    }

    // --- Step 9: Build channel notification ---
    const preflightList = rules.requiredPreflightChecks.map((c) => `• ${c}`).join("\n");
    const excludedWarning =
      totals.excludedCharges.length > 0
        ? `\n\n:warning: *${totals.excludedCharges.length} charge(s) excluded from demand* (${propertyData.jurisdiction} rules):\n` +
          totals.excludedCharges.map((e) => `• ${e.description}: ${formatCurrency(e.amount)} — ${e.reason}`).join("\n")
        : "";

    const managerLine = manager
      ? `*Manager:*\n${managerSlackId ? `<@${managerSlackId}>` : manager.manager_name} (${manager.manager_phone})`
      : null;

    await slack.chat.postMessage({
      channel: channelId,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:white_check_mark: *Pay or Vacate Notice Created*` },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Tenant:*\n${parsed.tenant_name}` },
            { type: "mrkdwn", text: `*Property:*\n${parsed.property}` },
            { type: "mrkdwn", text: `*Jurisdiction:*\n${propertyData.jurisdiction}` },
            { type: "mrkdwn", text: `*Notice Period:*\n${propertyData.noticeDays} days` },
            { type: "mrkdwn", text: `*Total Due:*\n${formatCurrency(totals.totalDue)}` },
            { type: "mrkdwn", text: `*Late Fees (excluded):*\n${formatCurrency(totals.lateFeeTotal)}` },
            ...(managerLine ? [{ type: "mrkdwn" as const, text: managerLine }] : []),
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:clipboard: *Required Preflight Checks — ${propertyData.jurisdiction}*\n${preflightList}${excludedWarning}`,
          },
        },
        ...(declarationWarning
          ? [
              {
                type: "section" as const,
                text: { type: "mrkdwn" as const, text: declarationWarning },
              },
            ]
          : []),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View Notice" },
              url: docUrl(newDocId),
              style: "primary",
            },
          ],
        },
      ],
    });

    // --- Step 10: DM the manager ---
    if (managerSlackId) {
      await slack.chat.postMessage({
        channel: managerSlackId,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:bell: *A Pay or Vacate notice has been generated for one of your properties.*`,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Tenant:*\n${parsed.tenant_name}` },
              { type: "mrkdwn", text: `*Property:*\n${parsed.property}` },
              { type: "mrkdwn", text: `*Address:*\n${parsed.address}` },
              { type: "mrkdwn", text: `*Total Due:*\n${formatCurrency(totals.totalDue)}` },
            ],
          },
          // The manager is the one who prints and serves this, so the warning
          // has to reach them directly — not only the channel.
          ...(declarationWarning
            ? [
                {
                  type: "section" as const,
                  text: { type: "mrkdwn" as const, text: declarationWarning },
                },
              ]
            : []),
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "View Notice" },
                url: docUrl(newDocId),
                style: "primary",
              },
            ],
          },
        ],
      });
      console.log(`DM sent to manager ${manager?.manager_name}`);
    } else if (manager) {
      console.warn(`Manager ${manager.manager_name} not found in Slack — DM skipped`);
    }

    console.log(`Notice complete for ${parsed.tenant_name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("processNotice error:", message);
    await slack.chat.postMessage({
      channel: channelId,
      text: `:x: *Pay or Vacate generation failed*\n\`\`\`${message}\`\`\``,
    });
  }
}
