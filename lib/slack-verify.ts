import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies that a request genuinely came from Slack by checking the
 * HMAC-SHA256 signature against our signing secret.
 */
export async function verifySlackRequest(req: Request): Promise<{
  valid: boolean;
  body: string;
}> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");

  if (!timestamp || !signature) {
    return { valid: false, body: "" };
  }

  // Reject requests older than 5 minutes (replay attack prevention)
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
  if (age > 300) {
    return { valid: false, body: "" };
  }

  const body = await req.text();
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const expectedSig = `v0=${hmac.digest("hex")}`;

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);

  if (sigBuffer.length !== expectedBuffer.length) {
    return { valid: false, body };
  }

  const valid = timingSafeEqual(sigBuffer, expectedBuffer);
  return { valid, body };
}
