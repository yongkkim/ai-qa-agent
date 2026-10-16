/**
 * `npm run demo` — the whole flow from one command (with `npm run dev` running):
 * resets the board, moves each ticket to In Testing exactly like a person
 * dragging a card, waits for the AI QA agent, and prints its verdicts.
 *
 *   npm run demo                 # QA-101, QA-102, QA-103
 *   npm run demo -- QA-101       # just one ticket
 *   npm run demo -- --no-reset   # keep the current board
 */
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

const JIRA = process.env.JIRA_BASE_URL ?? `http://localhost:${process.env.MOCK_JIRA_PORT ?? 4000}`;
const ORCH = (process.env.ORCHESTRATOR_PUBLIC_URL ?? `http://localhost:${process.env.ORCHESTRATOR_PORT ?? 4100}`).replace(/\/$/, "");
const APP = process.env.APP_UNDER_TEST_URL ?? "http://localhost:5173";
const TRIGGER = process.env.QA_TRIGGER_STATUS ?? "In Testing";
const PER_TICKET_TIMEOUT_MS = 15 * 60_000;

const args = process.argv.slice(2);
const reset = !args.includes("--no-reset");
const keys = args.filter((a) => !a.startsWith("--"));
if (!keys.length) keys.push("QA-101", "QA-102", "QA-103");

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

interface Run {
  id: number;
  issueKey: string;
  state: string;
  queuedAt: string;
  summary?: string;
  reportUrl?: string;
}

async function up(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function jira<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${JIRA}/rest/api/3${path}`, { ...init, headers: { "Content-Type": "application/json", "X-Actor": "Demo script" } });
  if (!res.ok) throw new Error(`Jira ${path} -> ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function moveTo(key: string, status: string) {
  const { transitions } = await jira<{ transitions: { id: string; to: { name: string } }[] }>(`/issue/${key}/transitions`);
  const t = transitions.find((x) => x.to.name.toLowerCase() === status.toLowerCase());
  if (!t) return; // already there
  await jira(`/issue/${key}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) });
}

async function waitForRun(key: string, since: number): Promise<Run> {
  const started = Date.now();
  let last = "";
  for (;;) {
    const runs = (await (await fetch(`${ORCH}/runs`)).json()) as Run[];
    const run = runs.find((r) => r.issueKey === key && Date.parse(r.queuedAt) >= since - 1000);
    const state = run?.state ?? "waiting for webhook";
    if (state !== last) {
      process.stdout.write(`\n   ${c.dim("…")} ${state}`);
      last = state;
    } else process.stdout.write(c.dim("."));
    if (run && !["queued", "running"].includes(run.state)) {
      process.stdout.write("\n");
      return run;
    }
    if (Date.now() - started > PER_TICKET_TIMEOUT_MS) throw new Error(`timed out waiting for ${key}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function printComment(body: string) {
  for (const line of body.split("\n")) {
    if (line.trim().startsWith("![")) continue; // screenshots: open the board to see them
    const plain = line.replace(/\*\*/g, "").replace(/`/g, "");
    console.log(`   ${plain}`);
  }
}

async function main() {
  console.log(`\n${c.bold("AI QA Agent demo")}\n`);
  const checks: [string, string, string][] = [
    ["Sample app", APP, "npm run dev"],
    ["Mock Jira", `${JIRA}/api/board`, "npm run dev"],
    ["Orchestrator", `${ORCH}/health`, "npm run dev"],
  ];
  let ok = true;
  for (const [name, url] of checks) {
    const alive = await up(url);
    console.log(`  ${alive ? c.green("✓") : c.red("✗")} ${name} ${c.dim(url)}`);
    ok &&= alive;
  }
  if (!ok) {
    console.log(`\nStart everything first in another terminal:\n  ${c.bold("npm run dev")}         (correct app)\n  ${c.bold("npm run dev:buggy")}   (app with planted bugs)\n`);
    process.exit(1);
  }

  if (reset) {
    await fetch(`${JIRA}/api/reset`, { method: "POST" });
    console.log(`  ${c.green("✓")} Board reset to the seed tickets`);
  }
  console.log(`\nBoard: ${c.bold(JIRA)}   ·   step-by-step agent log: the ${c.bold("orchestrator")} terminal\n`);

  const results: { key: string; run: Run }[] = [];
  for (const key of keys) {
    const issue = await jira<{ fields: { summary: string } }>(`/issue/${key}`);
    console.log(`${c.bold(key)} ${issue.fields.summary}`);
    const since = Date.now();
    console.log(`   → moving to "${TRIGGER}" (this fires the Jira webhook)`);
    await moveTo(key, TRIGGER);
    const run = await waitForRun(key, since);
    const after = await jira<{ fields: { status: { name: string }; comment: { comments: { body: string }[] } } }>(`/issue/${key}`);
    const last = after.fields.comment.comments.at(-1);
    if (last) printComment(last.body);
    console.log(`   Ticket is now: ${c.bold(after.fields.status.name)}\n`);
    results.push({ key, run });
  }

  console.log(c.bold("Summary"));
  for (const { key, run } of results) {
    const color = run.state === "passed" ? c.green : run.state === "failed" ? c.red : c.yellow;
    console.log(`  ${key}  ${color(run.state.toUpperCase().padEnd(10))} ${run.summary ?? ""}`);
    if (run.reportUrl) console.log(`         ${c.dim(run.reportUrl)}`);
  }
  if (results.some(({ run }) => run.state === "error" || run.state === "incomplete")) {
    console.log(c.dim("\n  ERROR / INCOMPLETE means the agent could not finish testing (e.g. the AI model was overloaded),\n  not that the feature is broken. Those tickets stay in In Testing; the comment on the ticket says why."));
  }
  console.log(`\nOpen ${JIRA} to see comments, screenshots and any bug tickets the agent filed.\n`);
}

main().catch((err) => {
  console.error(c.red(`\n${(err as Error).message}`));
  process.exit(1);
});
