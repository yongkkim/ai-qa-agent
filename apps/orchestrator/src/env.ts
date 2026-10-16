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
export const CREATE_BUG_TICKETS = bool(env.QA_CREATE_BUG_TICKETS, true);

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
