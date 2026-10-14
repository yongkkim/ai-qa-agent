import express from "express";
import { JIRA_BASE_URL, PORT, TRIGGER_STATUS } from "./env.js";
import { JiraClient } from "./jira.js";
import { RunQueue } from "./queue.js";
import { runQa } from "./runner.js";

interface StatusChange {
  field: string;
  fromString: string | null;
  toString: string | null;
}

interface JiraWebhook {
  webhookEvent?: string;
  issue?: { key?: string };
  changelog?: { items?: StatusChange[] };
}

const jira = new JiraClient();
const queue = new RunQueue((run) => runQa(run, jira));

const app = express();
app.use(express.json({ limit: "5mb" }));

/** Same endpoint shape a real Jira webhook would POST to. */
app.post("/webhooks/jira", (req, res) => {
  const payload = req.body as JiraWebhook;
  const key = payload.issue?.key;
  const statusChange = payload.changelog?.items?.find((i) => i.field === "status");

  if (payload.webhookEvent !== "jira:issue_updated" || !key || !statusChange) {
    return res.status(202).json({ ignored: true, reason: "not a status change" });
  }
  console.log(`[orchestrator] ${key}: "${statusChange.fromString}" -> "${statusChange.toString}"`);

  if (statusChange.toString?.toLowerCase() !== TRIGGER_STATUS.toLowerCase()) {
    return res.status(202).json({ ignored: true, reason: `status is not "${TRIGGER_STATUS}"` });
  }

  const { run, duplicate } = queue.enqueue(key);
  console.log(`[orchestrator] ${duplicate ? "already queued" : "queued"} run #${run.id} for ${key}`);
  res.status(202).json({ queued: !duplicate, run });
});

app.get("/runs", (_req, res) => res.json(queue.list()));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[orchestrator] listening on http://localhost:${PORT} (webhook: POST /webhooks/jira)`);
  console.log(`[orchestrator] Jira: ${JIRA_BASE_URL} · trigger status: "${TRIGGER_STATUS}"`);
});
