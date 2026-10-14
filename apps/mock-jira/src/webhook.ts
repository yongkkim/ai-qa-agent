import { WEBHOOK_URL } from "./env.js";
import type { WebhookPayload } from "./types.js";

/**
 * Fire-and-forget, like Jira: the transition succeeds even if the receiver is down.
 * Failures are logged so it's obvious when the orchestrator isn't running.
 */
export function sendWebhook(payload: WebhookPayload): void {
  if (!WEBHOOK_URL) return;
  fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "mock-jira-webhook" },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      console.log(`[mock-jira] webhook ${payload.webhookEvent} ${payload.issue.key} -> ${res.status}`);
    })
    .catch((err: Error) => {
      console.warn(`[mock-jira] webhook to ${WEBHOOK_URL} failed: ${err.message}`);
    });
}
