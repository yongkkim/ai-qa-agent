import { PlaywrightDriver } from "@ai-qa/agent";
import { createProviderFromEnv, readLLMConfig } from "@ai-qa/llm";
import { createOrchestratorApp } from "./app.js";
import {
  AGENT,
  APP_UNDER_TEST_URL,
  ARTIFACTS_DIR,
  CREATE_BUG_TICKETS,
  JIRA_BASE_URL,
  PORT,
  PUBLIC_URL,
  STATUS_ON_FAIL,
  STATUS_ON_PASS,
  TRIGGER_STATUS,
} from "./env.js";
import { JiraClient } from "./jira.js";
import { RunQueue } from "./queue.js";
import { createRunner } from "./runner.js";

const jira = new JiraClient(JIRA_BASE_URL);
const runner = createRunner({
  jira,
  createLLM: () => createProviderFromEnv(),
  createBrowser: () => PlaywrightDriver.launch({ headless: AGENT.headless, slowMo: AGENT.slowMo }),
  artifactsDir: ARTIFACTS_DIR,
  artifactsUrl: `${PUBLIC_URL}/artifacts`,
  defaultAppUrl: APP_UNDER_TEST_URL,
  statusOnPass: STATUS_ON_PASS,
  statusOnFail: STATUS_ON_FAIL,
  createBugTickets: CREATE_BUG_TICKETS,
  agent: { maxSteps: AGENT.maxSteps, timeoutMs: AGENT.timeoutMs, stepScreenshots: AGENT.stepScreenshots },
});
const queue = new RunQueue(runner);
const app = createOrchestratorApp({ queue, triggerStatus: TRIGGER_STATUS, artifactsDir: ARTIFACTS_DIR });

app.listen(PORT, () => {
  console.log(`[orchestrator] listening on ${PUBLIC_URL} (webhook: POST /webhooks/jira)`);
  console.log(`[orchestrator] Jira: ${JIRA_BASE_URL} · trigger status: "${TRIGGER_STATUS}"`);
  // Surface config problems at startup instead of on the first ticket.
  try {
    const cfg = readLLMConfig();
    console.log(`[orchestrator] AI model: ${cfg.provider}/${cfg.model}${AGENT.headless ? "" : " · browser visible"}`);
  } catch (err) {
    console.warn(`\n[orchestrator] ⚠️  AI model not configured: ${(err as Error).message}\n`);
  }
});
