import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// Load the repo-root .env (optional; every value has a default).
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

export const PORT = Number(process.env.MOCK_JIRA_PORT ?? 4000);
export const WEBHOOK_URL = process.env.JIRA_WEBHOOK_URL ?? "http://localhost:4100/webhooks/jira";
export const DATA_FILE = resolve(here, "../data/db.json");
export const PUBLIC_DIR = resolve(here, "../public");
