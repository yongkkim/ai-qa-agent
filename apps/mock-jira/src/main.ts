import { createMockJira } from "./app.js";
import { DATA_FILE, KEEP_DATA, PORT, PUBLIC_DIR, WEBHOOK_URL } from "./env.js";
import { JsonStore } from "./store.js";

// Every start shows the same board (the seed tickets), like pressing "Reset board".
if (!KEEP_DATA) new JsonStore(DATA_FILE).reset();

const app = createMockJira({ dataFile: DATA_FILE, webhookUrl: WEBHOOK_URL, publicDir: PUBLIC_DIR });

app.listen(PORT, () => {
  console.log(`[mock-jira] board + API on http://localhost:${PORT}`);
  console.log(`[mock-jira] webhooks -> ${WEBHOOK_URL}`);
  console.log(`[mock-jira] ${KEEP_DATA ? "kept the board from the last session (MOCK_JIRA_KEEP_DATA=true)" : "board reset to the seed tickets"}`);
});
