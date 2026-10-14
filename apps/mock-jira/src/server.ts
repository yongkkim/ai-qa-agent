import express, { type Request, type Response } from "express";
import { PORT, PUBLIC_DIR, WEBHOOK_URL } from "./env.js";
import { loadDb, resetDb, saveDb } from "./store.js";
import { sendWebhook } from "./webhook.js";
import { STATUS_ORDER, TRANSITIONS, transitionsFrom } from "./workflow.js";
import type { Comment, Db, Issue } from "./types.js";

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR));

let db: Db = loadDb();
const persist = () => saveDb(db);

/** Real Jira derives the actor from auth; here clients may send X-Actor (the agent sends "AI QA Agent"). */
const actorOf = (req: Request) => ({ displayName: String(req.header("x-actor") ?? "You") });

function findIssue(keyOrId: string): Issue | undefined {
  return db.issues.find((i) => i.key === keyOrId || i.id === keyOrId);
}

function notFound(res: Response, key: string) {
  return res.status(404).json({ errorMessages: [`Issue does not exist or you do not have permission to see it: ${key}`] });
}

/**
 * Very small JQL subset: clauses joined by AND, each `field = "value"` or `field = value`.
 * Supported fields: status, issuetype, project, labels. Anything else is ignored.
 */
function matchesJql(issue: Issue, jql: string): boolean {
  const clauses = jql.split(/\s+AND\s+/i).map((c) => c.trim()).filter(Boolean);
  return clauses.every((clause) => {
    const m = clause.match(/^(\w+)\s*=\s*"?([^"]+?)"?$/i);
    if (!m) return true;
    const [, field, value] = m;
    const v = value.toLowerCase();
    switch (field.toLowerCase()) {
      case "status":
        return issue.fields.status.name.toLowerCase() === v;
      case "issuetype":
        return issue.fields.issuetype.name.toLowerCase() === v;
      case "project":
        return issue.key.toLowerCase().startsWith(`${v}-`);
      case "labels":
        return issue.fields.labels.map((l) => l.toLowerCase()).includes(v);
      default:
        return true;
    }
  });
}

function search(req: Request, res: Response) {
  const jql = String(req.query.jql ?? req.body?.jql ?? "");
  const issues = jql ? db.issues.filter((i) => matchesJql(i, jql)) : db.issues;
  res.json({ startAt: 0, maxResults: issues.length, total: issues.length, issues });
}

// ---------------- Jira-shaped REST API ----------------

app.get("/rest/api/3/search", search);
app.get("/rest/api/3/search/jql", search);
app.post("/rest/api/3/search/jql", search);

app.get("/rest/api/3/issue/:key", (req, res) => {
  const issue = findIssue(req.params.key);
  return issue ? res.json(issue) : notFound(res, req.params.key);
});

app.post("/rest/api/3/issue", (req, res) => {
  const f = req.body?.fields ?? {};
  if (!f.summary) return res.status(400).json({ errors: { summary: "You must specify a summary of the issue." } });
  const n = db.nextIssueNumber++;
  const now = new Date().toISOString();
  const issue: Issue = {
    id: String(10000 + n),
    key: `QA-${n}`,
    fields: {
      summary: String(f.summary),
      description: String(f.description ?? ""),
      issuetype: { name: f.issuetype?.name ?? "Task" },
      status: TRANSITIONS[0].to,
      priority: { name: f.priority?.name ?? "Medium" },
      labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
      created: now,
      updated: now,
      comment: { comments: [], total: 0 },
    },
  };
  db.issues.push(issue);
  persist();
  sendWebhook({ timestamp: Date.now(), webhookEvent: "jira:issue_created", user: actorOf(req), issue });
  res.status(201).json({ id: issue.id, key: issue.key, self: `/rest/api/3/issue/${issue.id}` });
});

app.get("/rest/api/3/issue/:key/transitions", (req, res) => {
  const issue = findIssue(req.params.key);
  if (!issue) return notFound(res, req.params.key);
  res.json({ transitions: transitionsFrom(issue.fields.status.name) });
});

app.post("/rest/api/3/issue/:key/transitions", (req, res) => {
  const issue = findIssue(req.params.key);
  if (!issue) return notFound(res, req.params.key);
  const transition = TRANSITIONS.find((t) => t.id === String(req.body?.transition?.id));
  if (!transition) return res.status(400).json({ errorMessages: ["Transition id is not valid for this issue."] });

  const from = issue.fields.status;
  if (from.name === transition.to.name) return res.status(204).end();

  issue.fields.status = transition.to;
  issue.fields.updated = new Date().toISOString();
  persist();

  sendWebhook({
    timestamp: Date.now(),
    webhookEvent: "jira:issue_updated",
    issue_event_type_name: "issue_generic",
    user: actorOf(req),
    issue,
    changelog: {
      id: String(db.nextId++),
      items: [
        { field: "status", fieldtype: "jira", from: from.id, fromString: from.name, to: transition.to.id, toString: transition.to.name },
      ],
    },
  });
  persist();
  res.status(204).end();
});

app.get("/rest/api/3/issue/:key/comment", (req, res) => {
  const issue = findIssue(req.params.key);
  if (!issue) return notFound(res, req.params.key);
  const { comments } = issue.fields.comment;
  res.json({ startAt: 0, maxResults: comments.length, total: comments.length, comments });
});

app.post("/rest/api/3/issue/:key/comment", (req, res) => {
  const issue = findIssue(req.params.key);
  if (!issue) return notFound(res, req.params.key);
  const body = req.body?.body;
  if (typeof body !== "string" || !body.trim()) return res.status(400).json({ errors: { comment: "Comment body can not be empty!" } });
  const comment: Comment = { id: String(db.nextId++), author: actorOf(req), body, created: new Date().toISOString() };
  issue.fields.comment.comments.push(comment);
  issue.fields.comment.total = issue.fields.comment.comments.length;
  issue.fields.updated = comment.created;
  persist();
  res.status(201).json(comment);
});

// ---------------- Demo helpers (not part of Jira's API) ----------------

app.get("/api/board", (_req, res) => {
  res.json({ columns: STATUS_ORDER, transitions: TRANSITIONS, issues: db.issues });
});

app.post("/api/reset", (_req, res) => {
  db = resetDb();
  res.json({ ok: true, issues: db.issues.length });
});

app.listen(PORT, () => {
  console.log(`[mock-jira] board + API on http://localhost:${PORT}`);
  console.log(`[mock-jira] webhooks -> ${WEBHOOK_URL}`);
});
