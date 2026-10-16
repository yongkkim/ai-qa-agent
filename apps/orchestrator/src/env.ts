import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
config({ path: resolve(REPO_ROOT, ".env") });

const env = process.env;
const bool = (v: string | undefined, dflt: boolean) => (v === undefined || v === "" ? dflt : /^(1|true|yes|on)$/i.test(v));
const num = (v: string | undefined, dflt: number) => (v && Number.isFinite(Number(v)) ? Number(v) : dflt);

export const PORT = num(env.ORCHESTRATOR_PORT, 4100);
/** Base URL other apps (and Jira comments) use to reach this service, e.g. for screenshot links. */
export const PUBLIC_URL = (env.ORCHESTRATOR_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

export const JIRA_BASE_URL = env.JIRA_BASE_URL ?? "http://localhost:4000";
/** Optional, for a real Jira Cloud site: Basic auth with email + API token. */
export const JIRA_EMAIL = env.JIRA_EMAIL;
export const JIRA_API_TOKEN = env.JIRA_API_TOKEN;

/** The status that triggers a QA run, and where tickets go afterwards. */
export const TRIGGER_STATUS = env.QA_TRIGGER_STATUS || "In Testing";
export const STATUS_ON_PASS = env.QA_STATUS_ON_PASS || "Done";
export const STATUS_ON_FAIL = env.QA_STATUS_ON_FAIL || "In Progress";
/**
 * How bug tickets are filed for failed criteria:
 *   per-defect    one bug per underlying defect (criteria the agent marks as the same defect are grouped)
 *   per-criterion one bug per failed acceptance criterion
 *   off           no bug tickets; failures are only reported on the original ticket
 * (QA_CREATE_BUG_TICKETS=false from older .env files still means "off".)
 */
export const BUG_TICKET_MODES = ["per-defect", "per-criterion", "off"] as const;
export type BugTicketMode = (typeof BUG_TICKET_MODES)[number];
export const BUG_TICKET_MODE: BugTicketMode = (() => {
  const raw = (env.QA_BUG_TICKETS ?? "").trim().toLowerCase();
  if (!raw) return bool(env.QA_CREATE_BUG_TICKETS, true) ? "per-defect" : "off";
  if ((BUG_TICKET_MODES as readonly string[]).includes(raw)) return raw as BugTicketMode;
  console.warn(`[orchestrator] QA_BUG_TICKETS="${raw}" is not one of ${BUG_TICKET_MODES.join(", ")}; using per-defect`);
  return "per-defect";
})();

/** Fallback when a ticket has no "Test URL:" line. */
export const APP_UNDER_TEST_URL = env.APP_UNDER_TEST_URL || "http://localhost:5173";
export const ARTIFACTS_DIR = resolve(REPO_ROOT, env.ARTIFACTS_DIR || "artifacts");

export const AGENT = {
  maxSteps: num(env.AGENT_MAX_STEPS, 60),
  timeoutMs: num(env.AGENT_TIMEOUT_SECONDS, 600) * 1000,
  headless: bool(env.AGENT_HEADLESS, true),
  slowMo: num(env.AGENT_SLOW_MO_MS, 0),
  stepScreenshots: bool(env.AGENT_STEP_SCREENSHOTS, true),
  browserChannel: env.AGENT_BROWSER_CHANNEL || undefined,
  browserPath: env.AGENT_BROWSER_PATH || undefined,
};
