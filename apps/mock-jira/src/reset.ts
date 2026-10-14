import { DATA_FILE } from "./env.js";
import { JsonStore } from "./store.js";

const db = new JsonStore(DATA_FILE).reset();
console.log(`[mock-jira] reset: ${db.issues.length} seed issues written`);
