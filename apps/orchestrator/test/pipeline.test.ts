/**
 * End-to-end pipeline test, no network or API key needed:
 *   mock Jira (real HTTP) → status-change webhook → orchestrator queue →
 *   agent (scripted model + real sample app in jsdom) → comment, labels,
 *   transition and bug tickets written back to mock Jira.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMConfigError, ScriptedProvider, type LLMProvider, type ScriptStep } from "@ai-qa/llm";
import { createMockJira } from "../../mock-jira/src/app.js";
import { JsdomDriver } from "../../../packages/agent/test/support/jsdom-driver.js";
import { buildSampleApp } from "../../../packages/agent/test/support/sample-app.js";
import { addTodo, onPage, plan } from "../../../packages/agent/test/support/script-helpers.js";
import { createOrchestratorApp } from "../src/app.js";
import { JiraClient } from "../src/jira.js";
import { RunQueue } from "../src/queue.js";
import { createRunner, LABELS } from "../src/runner.js";

const tmp = mkdtempSync(join(tmpdir(), "ai-qa-pipeline-"));
const servers: Server[] = [];
const listen = (app: { listen: (port: number, cb: () => void) => Server }) =>
  new Promise<string>((resolve) => {
    const s = app.listen(0, () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servers.push(s);
  });

let jiraUrl = "";
let jira: JiraClient;
let queue: RunQueue;
/** Swapped per test: which app build the "browser" opens and which model answers. */
let appMode: "normal" | "buggy" = "normal";
let makeLLM: () => LLMProvider;
let bugMode: "per-defect" | "per-criterion" | "off" = "per-defect";

/** A scripted tester for the "whitespace-only todo is rejected" criterion. Decides from what the page shows. */
const emptyInputTester = () =>
  new ScriptedProvider([
    plan("AC1", "Todo cannot be empty."),
    addTodo("   "),
    onPage("record_result", (page) =>
      page.includes('alert "Todo cannot be empty."')
        ? { criterion: "AC1", status: "pass", observed_text: "Todo cannot be empty." }
        : {
            criterion: "AC1",
            status: "fail",
            observed_text: "1 item left",
            expected: "Whitespace-only input is rejected with an error",
            actual: "A blank todo was added to the list",
            steps_to_reproduce: "1. Type three spaces into New todo 2. Press Enter",
          },
    ),
    { tool: "finish", args: { summary: "Checked whitespace validation." } },
  ] satisfies ScriptStep[]);

before(async () => {
  // Orchestrator first, so mock Jira knows where to send webhooks.
  let orchestratorUrl = "";
  const runnerJira = () => jira;
  queue = new RunQueue((run) =>
    createRunner({
      jira: runnerJira(),
      createLLM: () => makeLLM(),
      createBrowser: async () => new JsdomDriver(await buildSampleApp(appMode)),
      artifactsDir: join(tmp, "artifacts"),
      artifactsUrl: `${orchestratorUrl}/artifacts`,
      defaultAppUrl: "http://localhost:5173/",
      statusOnPass: "Done",
      statusOnFail: "In Progress",
      get bugTicketMode() {
        return bugMode;
      },
      agent: { maxSteps: 20, timeoutMs: 60_000, stepScreenshots: false },
      log: () => {},
    })(run),
  );
  orchestratorUrl = await listen(createOrchestratorApp({ queue, triggerStatus: "In Testing", log: () => {} }));
  jiraUrl = await listen(createMockJira({ dataFile: join(tmp, "db.json"), webhookUrl: `${orchestratorUrl}/webhooks/jira` }));
  jira = new JiraClient(jiraUrl);
  await buildSampleApp("normal");
  await buildSampleApp("buggy");
});

after(() => servers.forEach((s) => s.close()));

async function createTicket(): Promise<string> {
  const { key } = await jira.createIssue({
    summary: "Reject whitespace-only todos",
    issuetype: "Story",
    description: "Test URL: http://localhost:5173/\n\nAcceptance Criteria:\n1. Submitting a whitespace-only value does NOT add a todo and shows the error \"Todo cannot be empty.\"",
  });
  return key;
}

/** Waits until the webhook has been received and the run has finished. */
async function waitForRun(key: string) {
  for (let i = 0; i < 200; i++) {
    const run = queue.list().find((r) => r.issueKey === key);
    if (run && run.state !== "queued" && run.state !== "running") return run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run for ${key} did not finish`);
}

const issue = async (key: string) => (await (await fetch(`${jiraUrl}/rest/api/3/issue/${key}`)).json()) as any;

describe("In Testing → AI QA → results on the ticket", () => {
  it("passes a working feature and moves the ticket to Done", async () => {
    appMode = "normal";
    makeLLM = emptyInputTester;
    const key = await createTicket();
    await jira.transitionTo(key, "In Testing");
    const run = await waitForRun(key);

    assert.equal(run.state, "passed");
    const i = await issue(key);
    assert.equal(i.fields.status.name, "Done");
    assert.deepEqual(i.fields.labels, [LABELS.passed]);
    const bodies = i.fields.comment.comments.map((c: any) => c.body);
    assert.match(bodies[0], /AI QA run started.*scripted\/scripted/);
    assert.match(bodies[1], /AI QA result: ✅ PASSED/);
    assert.match(bodies[1], /Checked: expected `Todo cannot be empty.` ✓ on page/);
    assert.ok(i.fields.comment.comments.every((c: any) => c.author.displayName === "AI QA Agent"));
  });

  it("catches the planted bug: fails the ticket, files a bug, sends it back to In Progress", async () => {
    appMode = "buggy";
    makeLLM = emptyInputTester;
    const key = await createTicket();
    await jira.transitionTo(key, "In Testing");
    const run = await waitForRun(key);

    assert.equal(run.state, "failed");
    const i = await issue(key);
    assert.equal(i.fields.status.name, "In Progress");
    assert.deepEqual(i.fields.labels, [LABELS.failed]);
    const result = i.fields.comment.comments.at(-1).body as string;
    assert.match(result, /AI QA result: ❌ FAILED/);
    assert.match(result, /Actual: A blank todo was added/);
    assert.match(result, /!\[AC1 screenshot\]\(.*\/AC1\.png\)/);

    const bugKey = result.match(/Bugs filed:\*\* (QA-\d+)/)?.[1];
    assert.ok(bugKey, "a bug ticket is linked in the comment");
    const bug = await issue(bugKey);
    assert.equal(bug.fields.issuetype.name, "Bug");
    assert.ok(bug.fields.labels.includes(`parent-${key}`));
    assert.match(bug.fields.description, /\*\*Steps to reproduce:\*\*\n1\. Type three spaces/);
    // Evidence comes right after the steps; the model that made the call is listed under Environment.
    assert.match(bug.fields.description, /\*\*Evidence:\*\*\n!\[AC1 screenshot\]/);
    assert.match(bug.fields.description, /\*\*Environment\*\*\nApp: http:\/\/localhost:5173\/\nTested by: AI QA agent, model `scripted\/scripted`/);
    assert.ok(existsSync(join(tmp, "artifacts", run.label!, "report.json")), "report.json saved");
  });

  it("explains a missing model configuration on the ticket instead of crashing", async () => {
    makeLLM = () => {
      throw new LLMConfigError("LLM_API_KEY is empty, but provider \"gemini\" needs an API key.");
    };
    const key = await createTicket();
    await jira.transitionTo(key, "In Testing");
    const run = await waitForRun(key);

    assert.equal(run.state, "error");
    const i = await issue(key);
    assert.equal(i.fields.status.name, "In Testing", "ticket stays put for a human");
    assert.deepEqual(i.fields.labels, [LABELS.error]);
    assert.match(i.fields.comment.comments.at(-1).body, /AI model is not configured.*\nLLM_API_KEY is empty/);
  });

  it("only reacts to the trigger status", async () => {
    const key = await createTicket();
    await jira.transitionTo(key, "In Progress");
    await jira.transitionTo(key, "Done");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(queue.list().filter((r) => r.issueKey === key).length, 0);
  });
});

describe("bug tickets: one per defect, per criterion, or none", () => {
  /** A tester that fails three criteria: AC2 is the same defect as AC1, AC3 is a different one. */
  const threeFailures = () =>
    new ScriptedProvider([
      plan("AC1", "1 item left"),
      { tool: "record_result", args: { criterion: "AC1", status: "fail", observed_text: "0 items left", expected: "1 item left", actual: "0 items left" } },
      plan("AC2", "1 item left"),
      { tool: "record_result", args: { criterion: "AC2", status: "fail", observed_text: "0 items left", same_defect_as: "AC1", expected: "1 item left", actual: "0 items left" } },
      plan("AC3", "Clear completed (1)"),
      { tool: "record_result", args: { criterion: "AC3", status: "fail", observed_text: "Nothing here yet.", expected: "button shown", actual: "no button" } },
      { tool: "finish", args: { summary: "three failures, two defects" } },
    ] satisfies ScriptStep[]);

  async function runWith(mode: typeof bugMode) {
    appMode = "normal";
    makeLLM = threeFailures;
    bugMode = mode;
    const { key } = await jira.createIssue({
      summary: "Counter",
      issuetype: "Story",
      description: "Acceptance Criteria:\n1. Counter A\n2. Counter B\n3. Clear button",
    });
    await jira.transitionTo(key, "In Testing");
    await waitForRun(key);
    const search = (await (await fetch(`${jiraUrl}/rest/api/3/search?jql=${encodeURIComponent(`labels = parent-${key}`)}`)).json()) as any;
    const parent = await issue(key);
    return { key, bugs: search.issues as any[], parent };
  }

  it("per-defect (default): criteria with the same defect share one bug", async () => {
    const { key, bugs, parent } = await runWith("per-defect");
    assert.equal(bugs.length, 2);
    const grouped = bugs.find((b) => b.fields.summary.startsWith(`[${key} AC1, AC2]`));
    assert.ok(grouped, "AC1 and AC2 are filed together");
    assert.match(grouped.fields.description, /The same defect also breaks:\*\*\n- \*\*AC2\*\* Counter B/);
    assert.ok(bugs.some((b) => b.fields.summary.startsWith(`[${key} AC3]`)));
    const result = parent.fields.comment.comments.at(-1).body as string;
    assert.match(result, /Same defect as AC1\./);
    assert.match(result, /Bugs filed:\*\* QA-\d+ \(AC1, AC2\), QA-\d+ \(AC3\)/);
  });

  it("per-criterion: one bug per failed criterion", async () => {
    const { bugs } = await runWith("per-criterion");
    assert.equal(bugs.length, 3);
  });

  it("off: no bug tickets, but the ticket still fails and goes back to In Progress", async () => {
    const { bugs, parent } = await runWith("off");
    assert.equal(bugs.length, 0);
    assert.equal(parent.fields.status.name, "In Progress");
    assert.doesNotMatch(parent.fields.comment.comments.at(-1).body, /Bugs filed/);
  });
});
