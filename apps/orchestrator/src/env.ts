import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

export const PORT = Number(process.env.ORCHESTRATOR_PORT ?? 4100);
export const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? "http://localhost:4000";
/** Optional, for a real Jira Cloud site: Basic auth with email + API token. */
export const JIRA_EMAIL = process.env.JIRA_EMAIL;
export const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
/** The status that triggers a QA run. */
export const TRIGGER_STATUS = process.env.QA_TRIGGER_STATUS ?? "In Testing";
export const APP_UNDER_TEST_URL = process.env.APP_UNDER_TEST_URL ?? "http://localhost:5173";
