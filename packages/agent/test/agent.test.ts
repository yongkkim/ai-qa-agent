import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedProvider, type Message, type ScriptStep } from "@ai-qa/llm";
import { buildDefectReview, computeVerdict, isGrounded, pruneOldSnapshots, runAgent } from "../src/agent.js";
import { PAGE_MARKER } from "../src/prompts.js";
import type { TicketUnderTest } from "../src/types.js";
import { JsdomDriver } from "./support/jsdom-driver.js";
import { buildSampleApp } from "./support/sample-app.js";
import { addTodo, lastToolResult, onPage, plan, ref } from "./support/script-helpers.js";

const APP_URL = "http://localhost:5173/";
const runDir = () => mkdtempSync(join(tmpdir(), "ai-qa-run-"));

function ticket(criteria: string[]): TicketUnderTest {
  return { key: "QA-T", summary: "Test ticket", description: "Test", criteria, appUrl: APP_URL };
}

async function run(mode: "normal" | "buggy", criteria: string[], script: ScriptStep[], extra: { maxSteps?: number } = {}) {
  const browser = new JsdomDriver(await buildSampleApp(mode));
  const llm = new ScriptedProvider(script);
  const report = await runAgent(ticket(criteria), { llm, browser, runDir: runDir(), maxSteps: extra.maxSteps ?? 20 });
  return { report, llm, browser };
}

/**
 * A scripted "tester" for the empty-input rule. Like a real model it decides
 * pass/fail from what the page shows, so the same script must pass on the
 * normal build and fail on the buggy one.
 */
const emptyInputScript: ScriptStep[] = [
  plan("AC1", "Todo cannot be empty."),
  addTodo("   "),
  onPage("record_result", (page) =>
    page.includes('alert "Todo cannot be empty."')
      ? { criterion: "AC1", status: "pass", observed_text: "Todo cannot be empty." }
      : {
          criterion: "AC1",
          status: "fail",
          observed_text: "1 item left",
          expected: "No todo is added and the error is shown",
          actual: "A blank todo was added",
          steps_to_reproduce: "1. Type three spaces 2. Press Enter",
        },
  ),
  { tool: "finish", args: { summary: "done" } },
];
const EMPTY_INPUT_AC = 'Submitting a whitespace-only value does NOT add a todo and shows the error "Todo cannot be empty."';

describe("agent loop against the real sample app", () => {
  it("passes the empty-input criterion on the normal build", async () => {
    const { report } = await run("normal", [EMPTY_INPUT_AC], emptyInputScript);
    assert.equal(report.verdict, "passed");
    assert.equal(report.criteria[0].status, "pass");
    assert.equal(report.criteria[0].grounded, true);
  });

  it("catches the planted empty-input bug on the buggy build", async () => {
    const { report } = await run("buggy", [EMPTY_INPUT_AC], emptyInputScript);
    assert.equal(report.verdict, "failed");
    const c = report.criteria[0];
    assert.equal(c.status, "fail");
    assert.equal(c.observed, "1 item left");
    assert.equal(c.actual, "A blank todo was added");
    assert.ok(existsSync(join(report.runDir, c.screenshot!)), "verdict screenshot saved");
    const saved = JSON.parse(readFileSync(join(report.runDir, "report.json"), "utf8"));
    assert.equal(saved.verdict, "failed");
  });

  it("catches the planted counter bug (counts completed todos)", async () => {
    const script: ScriptStep[] = [
      plan("AC1", "1 item left"),
      addTodo("Buy milk"),
      addTodo("Walk dog"),
      onPage("click", (p) => ({ ref: ref(p, 'checkbox "Buy milk"') })),
      onPage("record_result", (p) =>
        p.includes('text "1 item left"')
          ? { criterion: "AC1", status: "pass", observed_text: "1 item left" }
          : { criterion: "AC1", status: "fail", observed_text: "2 items left", expected: "1 item left", actual: "2 items left" },
      ),
      { tool: "finish", args: { summary: "done" } },
    ];
    const ac = 'The footer shows "<N> items left", where N is the number of NOT completed todos.';
    assert.equal((await run("normal", [ac], script)).report.verdict, "passed");
    assert.equal((await run("buggy", [ac], script)).report.verdict, "failed");
  });

  it("types text of an exact length with repeat_to_length", async () => {
    const script: ScriptStep[] = [
      plan("AC1", "Todo must be 80 characters or fewer."),
      onPage("type", (p) => ({ ref: ref(p, 'textbox "New todo"'), text: "a", repeat_to_length: 81, submit: true })),
      onPage("record_result", () => ({ criterion: "AC1", status: "pass", observed_text: "Todo must be 80 characters or fewer." })),
      { tool: "finish", args: { summary: "done" } },
    ];
    const { report } = await run("normal", ["Text longer than 80 characters is rejected"], script);
    assert.match(report.steps[1].outcome, /\(81 chars\)/);
    assert.equal(report.verdict, "passed");
  });
});

describe("guard rails", () => {
  it("rejects a verdict whose evidence never appeared on the page, then accepts a grounded one", async () => {
    let rejection = "";
    const script: ScriptStep[] = [
      plan("AC1", "Nothing here yet."),
      { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Everything works perfectly" } },
      (req) => {
        rejection = lastToolResult(req);
        return { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Nothing here yet." } };
      },
      { tool: "finish", args: { summary: "done" } },
    ];
    const { report } = await run("normal", ["Empty state message is shown"], script);
    assert.match(rejection, /rejected: observed_text .* does not appear/);
    assert.equal(report.verdict, "passed");
    assert.equal(report.criteria[0].grounded, true);
  });

  it("accepts but flags evidence that stays ungrounded after repeated rejections", async () => {
    const bogus = { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "made up text" } };
    const { report } = await run("normal", ["Anything"], [plan("AC1", "Nothing here yet."), bogus, bogus, bogus, { tool: "finish", args: { summary: "x" } }]);
    assert.equal(report.criteria[0].status, "pass");
    assert.equal(report.criteria[0].grounded, false);
  });

  it("bounces an early finish once, then ends with the remaining criteria marked not tested", async () => {
    let bounce = "";
    const script: ScriptStep[] = [
      plan("AC1", "Nothing here yet."),
      { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Nothing here yet." } },
      { tool: "finish", args: { summary: "first try" } },
      (req) => {
        bounce = lastToolResult(req);
        return { tool: "finish", args: { summary: "second try" } };
      },
    ];
    const { report } = await run("normal", ["One", "Two"], script);
    assert.match(bounce, /no verdict yet for AC2/);
    assert.equal(report.criteria[1].status, "not_tested");
    assert.equal(report.verdict, "incomplete");
    assert.equal(report.summary, "second try");
  });

  it("stops at the step limit", async () => {
    const { report } = await run("normal", ["One"], Array(10).fill({ tool: "reload" }), { maxSteps: 3 });
    assert.equal(report.steps.length, 3);
    assert.equal(report.verdict, "incomplete");
    assert.match(report.summary, /step limit/);
  });

  it("refuses to navigate outside the app under test", async () => {
    const { report } = await run("normal", ["One"], [{ tool: "navigate", args: { url: "https://example.com" } }, { tool: "finish", args: { summary: "x" } }]);
    assert.equal(report.steps[0].ok, false);
    assert.match(report.steps[0].outcome, /outside the app under test/);
  });

  it("reports a stale ref as a tool error and keeps going", async () => {
    let result = "";
    const script: ScriptStep[] = [
      { tool: "click", args: { ref: "e999" } },
      (req) => {
        result = lastToolResult(req);
        return { tool: "finish", args: { summary: "x" } };
      },
    ];
    await run("normal", ["One"], script);
    assert.match(result, /No element with ref \[e999\]/);
    assert.ok(result.includes(PAGE_MARKER), "a fresh snapshot is attached after an error");
  });

  it("nudges a model that answers without calling tools", async () => {
    const finish = { tool: "finish", args: { summary: "x" } };
    const { llm, report } = await run("normal", ["One"], [{ text: "Let me think..." }, finish, finish]);
    const nudge = llm.requests[1].messages.at(-1);
    assert.equal(nudge?.role, "user");
    assert.equal(report.summary, "x");
  });

  it("records an LLM failure as an error verdict instead of throwing", async () => {
    const browser = new JsdomDriver(await buildSampleApp("normal"));
    const llm = new ScriptedProvider([]);
    llm.chat = async () => {
      throw new Error("HTTP 401: invalid key");
    };
    const report = await runAgent(ticket(["One"]), { llm, browser, runDir: runDir() });
    assert.equal(report.verdict, "error");
    assert.match(report.error!, /401/);
  });
});

describe("test oracle (plan_test): a PASS must match what the page shows", () => {
  const COUNTER_AC = "Completing a todo updates the counter immediately.";
  // A lazy model: completes the only todo, sees the counter did NOT change, and calls it a pass anyway.
  const lazy = (passAttempts: number, thenFail: boolean): ScriptStep[] => [
    plan("AC1", "0 items left"),
    addTodo("Buy milk"),
    onPage("click", (p) => ({ ref: ref(p, 'checkbox "Buy milk"') })),
    ...Array(passAttempts).fill({ tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "1 item left" } }),
    ...(thenFail
      ? [{ tool: "record_result", args: { criterion: "AC1", status: "fail", observed_text: "1 item left", expected: "0 items left", actual: "1 item left" } }]
      : []),
    { tool: "finish", args: { summary: "done" } },
  ];

  it("rejects a PASS the page contradicts, so the model records the real bug", async () => {
    let rejection = "";
    const script = lazy(1, true);
    const fail = script[4];
    script[4] = (req) => {
      rejection = lastToolResult(req);
      return fail;
    };
    const { report } = await run("buggy", [COUNTER_AC], script);
    assert.match(rejection, /rejected PASS for AC1: your planned expected text "0 items left" is not on the page/);
    assert.equal(report.verdict, "failed");
    assert.equal(report.criteria[0].oracle?.held, false);
  });

  it("never lets an insisted, contradicted PASS through: it becomes 'blocked' for a human", async () => {
    const { report } = await run("buggy", [COUNTER_AC], lazy(3, false));
    const c = report.criteria[0];
    assert.equal(c.status, "blocked");
    assert.match(c.notes!, /claimed PASS.*Needs human review/);
    assert.equal(report.verdict, "incomplete");
  });

  it("accepts the same PASS on the correct app, where the page confirms the plan", async () => {
    const { report } = await run("normal", [COUNTER_AC], lazy(1, false).map((s) =>
      typeof s !== "function" && "tool" in s && s.tool === "record_result" ? { ...s, args: { ...s.args, observed_text: "0 items left" } } : s,
    ));
    assert.equal(report.verdict, "passed");
    assert.equal(report.criteria[0].oracle?.held, true);
  });

  it("checks must_not_appear (e.g. an item a filter should hide)", async () => {
    const ac = '"Active" shows only todos that are not completed.';
    const script = (applyFilter: boolean): ScriptStep[] => [
      plan("AC1", "Walk dog", "Buy milk"),
      addTodo("Buy milk"),
      addTodo("Walk dog"),
      onPage("click", (p) => ({ ref: ref(p, 'checkbox "Buy milk"') })),
      ...(applyFilter ? [onPage("click", (p) => ({ ref: ref(p, 'button "Active"') }))] : []),
      { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Walk dog" } },
      { tool: "finish", args: { summary: "x" } },
      { tool: "finish", args: { summary: "x" } },
    ];
    // Filter applied: the completed todo is hidden, so the pass stands.
    assert.equal((await run("normal", [ac], script(true))).report.criteria[0].status, "pass");
    // Forgot to filter: "Buy milk" is still visible, so the pass is refused.
    const { llm } = await run("normal", [ac], script(false));
    const refusal = llm.requests.map((r) => (r.messages.at(-1)?.role === "tool" ? r.messages.at(-1)!.content : "")).find((c) => c.includes("rejected PASS"));
    assert.match(refusal ?? "", /"Buy milk" is on the page, but your plan said it must not be/);
  });

  it("requires a plan before any pass/fail verdict, and tracks changed expectations", async () => {
    let noPlan = "";
    const script: ScriptStep[] = [
      { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Nothing here yet." } },
      (req) => {
        noPlan = lastToolResult(req);
        return plan("AC1", "Something else") as ScriptStep;
      },
      plan("AC1", "Nothing here yet."),
      { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Nothing here yet." } },
      { tool: "finish", args: { summary: "x" } },
    ];
    const { report } = await run("normal", ["Empty state"], script);
    assert.match(noPlan, /no test plan for AC1\. Call plan_test first/);
    assert.deepEqual(report.criteria[0].oracle?.revised, ["Something else"]);
  });
});

describe("same_defect_as (one bug per defect)", () => {
  it("links a failure to an earlier failed criterion, and points chains at the first one", async () => {
    const fail = (criterion: string, same?: string): ScriptStep => ({
      tool: "record_result",
      args: { criterion, status: "fail", observed_text: "0 items left", ...(same ? { same_defect_as: same } : {}) },
    });
    let refused = "";
    const script: ScriptStep[] = [
      plan("AC1", "1 item left"),
      plan("AC2", "1 item left"),
      plan("AC3", "1 item left"),
      fail("AC2", "AC1"), // AC1 has not failed yet: refused
      (req) => {
        refused = lastToolResult(req);
        return fail("AC1");
      },
      fail("AC2", "AC1"),
      fail("AC3", "AC2"), // chained: should point at AC1
      { tool: "finish", args: { summary: "x" } },
    ];
    const { report } = await run("normal", ["A", "B", "C"], script);
    assert.match(refused, /same_defect_as must name an earlier criterion that was recorded as fail/);
    assert.deepEqual(report.criteria.map((c) => c.sameDefectAs), [undefined, "AC1", "AC1"]);
  });
});

describe("defect review before finishing", () => {
  const ACS = ['The footer shows "<N> items left", where N is the number of NOT completed todos.', 'Use the singular form "1 item left" when exactly one todo is active.'];
  // What Gemini actually did in a real run on the counter bug: AC1 "passed" with two active todos
  // (a setup in which the bug is invisible), then AC2 exposed the bug.
  const realRun: ScriptStep[] = [
    { tool: "plan_test", args: { criterion: "AC1", how_to_test: "Add two todos and check the footer", expected_text: "2 items left" } },
    addTodo("Buy milk"),
    addTodo("Walk dog"),
    { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "2 items left" } },
    plan("AC2", "1 item left"),
    onPage("click", (p) => ({ ref: ref(p, 'checkbox "Buy milk"') })),
    { tool: "record_result", args: { criterion: "AC2", status: "fail", observed_text: "2 items left", expected: "1 item left", actual: "2 items left" } },
  ];

  it("sends the agent back to re-test a pass that could not have revealed the defect it found", async () => {
    let review = "";
    const script: ScriptStep[] = [
      ...realRun,
      { tool: "finish", args: { summary: "first try" } },
      (req) => {
        review = lastToolResult(req);
        return { tool: "plan_test", args: { criterion: "AC1", how_to_test: "2 todos, 1 completed", expected_text: "1 item left" } };
      },
      { tool: "record_result", args: { criterion: "AC1", status: "fail", observed_text: "2 items left", expected: "1 item left", actual: "2 items left", same_defect_as: "AC2" } },
      { tool: "finish", args: { summary: "done" } },
    ];
    const { report } = await run("buggy", ACS, script);
    assert.match(review, /review your passes/);
    assert.match(review, /Defects found:\n- AC2: expected 1 item left; actual 2 items left/);
    assert.match(review, /- AC1 .*checked by "Add two todos and check the footer", expected "2 items left"/);
    const ac1 = report.criteria[0];
    assert.equal(ac1.status, "fail");
    assert.equal(ac1.retested, true);
    assert.deepEqual(ac1.oracle?.revised, [], "a re-test is not flagged as a suspicious change of expectation");
    assert.equal(ac1.sameDefectAs, "AC2");
    assert.equal(report.verdict, "failed");
  });

  it("pushes back once when the re-test just repeats the check that already passed", async () => {
    // What happened in a real run: asked to re-test AC1, the model planned the same weak check again.
    let pushback = "";
    const script: ScriptStep[] = [
      ...realRun,
      { tool: "finish", args: { summary: "first try" } },
      { tool: "plan_test", args: { criterion: "AC1", how_to_test: "Add 2 todos, ensure both are active", expected_text: "2 items left" } },
      (req) => {
        pushback = lastToolResult(req);
        return { tool: "plan_test", args: { criterion: "AC1", how_to_test: "2 todos, 1 completed", expected_text: "1 item left" } };
      },
      { tool: "record_result", args: { criterion: "AC1", status: "fail", observed_text: "2 items left", expected: "1 item left", actual: "2 items left", same_defect_as: "AC2" } },
      { tool: "finish", args: { summary: "done" } },
    ];
    const { report } = await run("buggy", ACS, script);
    assert.match(pushback, /same result as the check that already passed/);
    assert.equal(report.criteria[0].status, "fail");
    assert.equal(report.criteria[0].retested, true);
  });

  it("accepts the same expected text on the second try (a different setup can give the same text)", async () => {
    const same = { tool: "plan_test", args: { criterion: "AC1", how_to_test: "3 todos, 1 completed", expected_text: "2 items left" } };
    const script: ScriptStep[] = [
      ...realRun,
      { tool: "finish", args: { summary: "first try" } },
      same,
      same,
      (req) => {
        assert.match(lastToolResult(req), /planned AC1/);
        return { tool: "finish", args: { summary: "done" } };
      },
    ];
    const { report } = await run("buggy", ACS, script);
    assert.equal(report.criteria[0].retested, true);
  });

  it("asks only once, and keeps passes the agent confirms", async () => {
    const { report } = await run("buggy", ACS, [...realRun, { tool: "finish", args: { summary: "a" } }, { tool: "finish", args: { summary: "b" } }]);
    assert.equal(report.summary, "b");
    assert.equal(report.criteria[0].status, "pass");
    assert.equal(report.criteria[0].retested, undefined);
  });

  it("has nothing to review when there are no failures or no passes", () => {
    const c = (id: string, status: "pass" | "fail") => ({ id, text: id, status });
    assert.equal(buildDefectReview([c("AC1", "pass"), c("AC2", "pass")]), undefined);
    assert.equal(buildDefectReview([c("AC1", "fail"), c("AC2", "fail")]), undefined);
    assert.ok(buildDefectReview([c("AC1", "pass"), c("AC2", "fail")]));
  });
});

describe("helpers", () => {
  it("isGrounded ignores case, quotes, whitespace and refs", () => {
    const page = 'list "Todo list":\n  [e6] checkbox "Buy milk" (checked)\ntext "1 item left"';
    assert.ok(isGrounded("1 item left", [page]));
    assert.ok(isGrounded('"1  ITEM left"', [page]));
    assert.ok(isGrounded('checkbox "Buy milk" (checked)', [page]));
    assert.ok(!isGrounded("2 items left", [page]));
    assert.ok(!isGrounded("", [page]));
    assert.ok(!isGrounded("2 items left", ['text "12 items left"']), "whole-text match only");
  });

  it("computeVerdict: any fail fails, all pass passes, otherwise incomplete", () => {
    const c = (status: "pass" | "fail" | "blocked" | "not_tested") => ({ id: "x", text: "x", status });
    assert.equal(computeVerdict([c("pass"), c("pass")]), "passed");
    assert.equal(computeVerdict([c("pass"), c("fail"), c("blocked")]), "failed");
    assert.equal(computeVerdict([c("pass"), c("blocked")]), "incomplete");
    assert.equal(computeVerdict([]), "incomplete");
  });

  it("pruneOldSnapshots keeps only the newest page", () => {
    const messages = [
      { role: "user" as const, content: `intro${PAGE_MARKER}page 1` },
      { role: "tool" as const, toolCallId: "1", name: "click", content: `OK${PAGE_MARKER}page 2` },
      { role: "tool" as const, toolCallId: "2", name: "click", content: `OK${PAGE_MARKER}page 3` },
    ];
    pruneOldSnapshots(messages);
    assert.ok(!messages[0].content.includes("page 1"));
    assert.ok(!messages[1].content.includes("page 2"));
    assert.ok(messages[2].content.endsWith("page 3"));
  });
});

describe("visual criteria (the look tool)", () => {
  const RED = ['When a whitespace-only todo is submitted, the error message "Todo cannot be empty." is shown in red text.'];
  const visualPlan: ScriptStep = {
    tool: "plan_test",
    args: { criterion: "AC1", how_to_test: "submit spaces, look at the error", expected_text: "Todo cannot be empty.", expected_look: "the error text is red" },
  };
  const pass = { tool: "record_result", args: { criterion: "AC1", status: "pass", observed_text: "Todo cannot be empty." } };

  it("won't accept a verdict about appearance until the agent has looked, then sends the screenshot to the model", async () => {
    let refusal = "";
    let sawImage = false;
    const script: ScriptStep[] = [
      visualPlan,
      addTodo("   "),
      pass,
      (req) => {
        refusal = lastToolResult(req);
        return { tool: "look", args: { what: "colour of the error" } };
      },
      (req) => {
        const last = req.messages.at(-1);
        sawImage = last?.role === "tool" && last.images?.[0]?.mimeType === "image/png";
        return pass;
      },
      { tool: "finish", args: { summary: "done" } },
    ];
    const { report, browser } = await run("normal", RED, script);
    assert.match(refusal, /is about appearance .* Call look/);
    assert.ok(sawImage, "the screenshot reached the model");
    assert.equal(browser.captures, 1);
    const ac1 = report.criteria[0];
    assert.equal(ac1.status, "pass");
    assert.deepEqual(ac1.visual, { expected: "the error text is red", screenshot: "look-04.png" });
    assert.ok(existsSync(join(report.runDir, "look-04.png")));
  });

  it("a look taken before the plan doesn't count (it shows the page before the setup)", async () => {
    let refusal = "";
    const script: ScriptStep[] = [
      { tool: "look", args: {} },
      visualPlan,
      addTodo("   "),
      pass,
      (req) => {
        refusal = lastToolResult(req);
        return { tool: "finish", args: { summary: "x" } };
      },
      { tool: "finish", args: { summary: "y" } },
    ];
    await run("normal", RED, script);
    assert.match(refusal, /Call look to see the result first/);
  });

  it("with a text-only model, look explains itself and the criterion can be recorded as blocked", async () => {
    let lookResult = "";
    const script: ScriptStep[] = [
      visualPlan,
      { tool: "look", args: {} },
      (req) => {
        lookResult = lastToolResult(req);
        return { tool: "record_result", args: { criterion: "AC1", status: "blocked", observed_text: "", notes: "needs a visual check" } };
      },
      { tool: "finish", args: { summary: "done" } },
    ];
    const browser = new JsdomDriver(await buildSampleApp("normal"));
    const llm = new ScriptedProvider(script, { vision: false });
    const report = await runAgent(ticket(RED), { llm, browser, runDir: runDir(), maxSteps: 20 });
    assert.match(lookResult, /cannot read images .* blocked/);
    assert.match(llm.requests[0].system, /This model cannot see images/, "a text-only model is told up front");
    assert.equal(browser.captures, 0, "no screenshot is taken for a model that can't see it");
    assert.equal(report.criteria[0].status, "blocked");
  });

  it("keeps only the newest screenshot in the conversation", () => {
    const img = { mimeType: "image/png" as const, data: "x" };
    const messages: Message[] = [
      { role: "tool", toolCallId: "a", name: "look", content: "first", images: [img] },
      { role: "tool", toolCallId: "b", name: "look", content: "second", images: [img] },
    ];
    pruneOldSnapshots(messages);
    assert.equal((messages[0] as { images?: unknown }).images, undefined);
    assert.match(messages[0].content, /older screenshot omitted/);
    assert.equal((messages[1] as { images?: unknown[] }).images?.length, 1);
  });
});
