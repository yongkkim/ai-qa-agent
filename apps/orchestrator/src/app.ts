import express from "express";
import type { RunQueue } from "./queue.js";

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

export interface OrchestratorAppOptions {
  queue: RunQueue;
  triggerStatus: string;
  /** Serve run artifacts (screenshots, report.json) at /artifacts. */
  artifactsDir?: string;
  log?: (line: string) => void;
}

export function createOrchestratorApp({ queue, triggerStatus, artifactsDir, log = console.log }: OrchestratorAppOptions) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  // The board (another origin) reads /runs to show live status.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });
  if (artifactsDir) app.use("/artifacts", express.static(artifactsDir));

  /** Same endpoint shape a real Jira webhook would POST to. */
  app.post("/webhooks/jira", (req, res) => {
    const payload = req.body as JiraWebhook;
    const key = payload.issue?.key;
    const statusChange = payload.changelog?.items?.find((i) => i.field === "status");

    if (payload.webhookEvent !== "jira:issue_updated" || !key || !statusChange) {
      return res.status(202).json({ ignored: true, reason: "not a status change" });
    }
    log(`[orchestrator] ${key}: "${statusChange.fromString}" -> "${statusChange.toString}"`);

    if (statusChange.toString?.toLowerCase() !== triggerStatus.toLowerCase()) {
      return res.status(202).json({ ignored: true, reason: `status is not "${triggerStatus}"` });
    }

    const { run, duplicate } = queue.enqueue(key);
    log(`[orchestrator] ${duplicate ? "already queued" : "queued"} run #${run.id} for ${key}`);
    res.status(202).json({ queued: !duplicate, run });
  });

  app.get("/runs", (_req, res) => res.json(queue.list()));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  return app;
}
