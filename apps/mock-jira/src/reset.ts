import "./env.js";
import { resetDb } from "./store.js";

const db = resetDb();
console.log(`[mock-jira] reset: ${db.issues.length} seed issues written`);
