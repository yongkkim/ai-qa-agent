import { createMockJira } from "./app.js";
import { DATA_FILE, PORT, PUBLIC_DIR, WEBHOOK_URL } from "./env.js";

const app = createMockJira({ dataFile: DATA_FILE, webhookUrl: WEBHOOK_URL, publicDir: PUBLIC_DIR });

app.listen(PORT, () => {
  console.log(`[mock-jira] board + API on http://localhost:${PORT}`);
  console.log(`[mock-jira] webhooks -> ${WEBHOOK_URL}`);
});
