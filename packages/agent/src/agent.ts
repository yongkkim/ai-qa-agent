import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMProvider, Message, ToolCall } from "@ai-qa/llm";
import { formatSnapshot, StaleRefError, type BrowserDriver } from "./browser/driver.js";
import { criterionId, initialPrompt, NUDGE_USE_TOOLS, PAGE_MARKER, SYSTEM_PROMPT } from "./prompts.js";
import { AGENT_TOOLS } from "./tools.js";
import type { AgentReport, CriterionResult, CriterionStatus, RunVerdict, StepRecord, TicketUnderTest } from "./types.js";

export interface AgentOptions {
  llm: LLMProvider;
  browser: BrowserDriver;
  /** Where screenshots and report.json are written. */
  runDir: string;
  /** Max tool calls (browser actions + verdicts) before stopping. */
  maxSteps?: number;
  /** Wall-clock budget for the whole run. */
  timeoutMs?: number;
  maxTokens?: number;
  /** Save a screenshot after every browser action (verdict screenshots are always saved). */
  stepScreenshots?: boolean;
  log?: (line: string) => void;
}

const REF_TOOLS = new Set(["click", "type", "select_option"]);
const ACTION_TOOLS = new Set(["click", "type", "press_key", "select_option", "navigate", "reload"]);
/** How many times a verdict with unverifiable evidence is bounced back before being accepted (and flagged). */
const MAX_GROUNDING_REJECTIONS = 2;
/** How many times a PASS that the page contradicts is bounced back before it is downgraded to "blocked". */
const MAX_ORACLE_REJECTIONS = 2;

interface TestPlan {
  howToTest: string;
  expectedText: string;
  mustNotAppear?: string;
  /** Expectations the agent declared earlier and then replaced (shown to humans: changing the oracle after looking is suspicious). */
  previous: string[];
}

interface ExecResult {
  ok: boolean;
  outcome: string;
  /** Extra text for the model (e.g. remaining criteria). */
  detail?: string;
  /** Attach a fresh page snapshot to the tool result. */
  attachPage?: boolean;
  screenshot?: string;
}

/**
 * The QA agent: observe (page snapshot) → decide (LLM picks a tool) → act
 * (browser) → repeat, until every acceptance criterion has a verdict.
 * The model decides *what* to do; this loop enforces the guard rails:
 * step and time budgets, same-origin navigation, evidence grounding, and a
 * final verdict computed in code rather than taken from the model.
 */
export async function runAgent(ticket: TicketUnderTest, opts: AgentOptions): Promise<AgentReport> {
  const { llm, browser, runDir } = opts;
  const maxSteps = opts.maxSteps ?? 60;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const log = opts.log ?? (() => {});
  const startedAt = new Date();
  mkdirSync(runDir, { recursive: true });

  const criteria: CriterionResult[] = ticket.criteria.map((text, i) => ({ id: criterionId(i), text, status: "not_tested" }));
  const steps: StepRecord[] = [];
  const seenPages: string[] = [];
  const pageIssues: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, llmCalls: 0 };
  const groundingRejections = new Map<string, number>();
  const oracleRejections = new Map<string, number>();
  const plans = new Map<string, TestPlan>();
  const appOrigin = new URL(ticket.appUrl).origin;

  let summary = "";
  let finished = false;
  let finishAttempts = 0;
  let error: string | undefined;
  let lastPage = "";
  let snapshotsThisTurn = 0;

  const takeSnapshot = async () => {
    lastPage = formatSnapshot(await browser.snapshot());
    seenPages.push(lastPage);
    snapshotsThisTurn++;
    return lastPage;
  };
  const newIssues = () => {
    const fresh = browser.drainIssues().filter((i) => !pageIssues.includes(i));
    pageIssues.push(...fresh);
    return fresh;
  };
  /** Short label for an element, e.g. `[e2] button "Add"` (role + name, without value/state). */
  const describe = (ref: string) => {
    const line = lastPage.split("\n").find((l) => l.includes(`[${ref}]`))?.trim();
    return line ? line.replace(/\s+(value=|placeholder=|options=|href=|maxlength=|\().*$/, "") : `[${ref}]`;
  };
  const remaining = () => criteria.filter((c) => c.status === "not_tested").map((c) => c.id);

  async function execute(call: ToolCall, stepN: number): Promise<ExecResult> {
    const a = call.args;
    if (REF_TOOLS.has(call.name) && snapshotsThisTurn > 0) {
      return { ok: false, outcome: "skipped: page was re-read earlier in this turn, refs may have changed. Re-issue using the latest snapshot." };
    }
    switch (call.name) {
      case "click": {
        const ref = normRef(a.ref);
        const what = describe(ref);
        await browser.click(ref);
        return { ok: true, outcome: `clicked ${what}`, attachPage: true };
      }
      case "type": {
        const ref = normRef(a.ref);
        let text = String(a.text ?? "");
        const len = Number(a.repeat_to_length);
        if (Number.isInteger(len) && len > 0) text = (text || "a").repeat(Math.ceil(len / Math.max(1, (text || "a").length))).slice(0, len);
        const what = describe(ref);
        await browser.type(ref, text);
        if (a.submit === true) await browser.press("Enter");
        const shown = text.length > 40 ? `${JSON.stringify(text.slice(0, 40))}… (${text.length} chars)` : `${JSON.stringify(text)} (${text.length} chars)`;
        return { ok: true, outcome: `typed ${shown} into ${what}${a.submit === true ? " and pressed Enter" : ""}`, attachPage: true };
      }
      case "press_key": {
        const key = String(a.key ?? "");
        if (!key) return { ok: false, outcome: "key is required" };
        await browser.press(key);
        return { ok: true, outcome: `pressed ${key}`, attachPage: true };
      }
      case "select_option": {
        const ref = normRef(a.ref);
        await browser.selectOption(ref, String(a.value ?? ""));
        return { ok: true, outcome: `selected "${a.value}" in ${describe(ref)}`, attachPage: true };
      }
      case "navigate": {
        let url: URL;
        try {
          url = new URL(String(a.url ?? ""), ticket.appUrl);
        } catch {
          return { ok: false, outcome: `invalid URL: ${a.url}` };
        }
        if (url.origin !== appOrigin) return { ok: false, outcome: `refused: ${url.origin} is outside the app under test (${appOrigin})` };
        await browser.goto(url.href);
        return { ok: true, outcome: `opened ${url.href}`, attachPage: true };
      }
      case "reload":
        await browser.reload();
        return { ok: true, outcome: "reloaded the page", attachPage: true };
      case "plan_test":
        return planTest(a);
      case "record_result":
        return recordResult(a, stepN);
      case "finish": {
        const missing = remaining();
        if (missing.length && finishAttempts++ < 1) {
          return { ok: false, outcome: `not finished: no verdict yet for ${missing.join(", ")}. Test them, or record them as blocked with a reason.` };
        }
        finished = true;
        summary = String(a.summary ?? "").trim();
        return { ok: true, outcome: "session finished" };
      }
      default:
        return { ok: false, outcome: `unknown tool "${call.name}". Available: ${AGENT_TOOLS.map((t) => t.name).join(", ")}` };
    }
  }

  /** The test oracle: what the page must show if the feature works, declared BEFORE looking at the result. */
  function planTest(a: Record<string, unknown>): ExecResult {
    const target = findCriterion(criteria, a.criterion);
    if (!target) return { ok: false, outcome: `unknown criterion "${a.criterion}". Use one of ${criteria.map((c) => c.id).join(", ")}.` };
    const expectedText = String(a.expected_text ?? "").trim();
    if (expectedText.length < 2) return { ok: false, outcome: "expected_text is required: the exact text the page must show if the feature works." };
    const prev = plans.get(target.id);
    plans.set(target.id, {
      howToTest: String(a.how_to_test ?? "").trim(),
      expectedText,
      mustNotAppear: optStr(a.must_not_appear),
      previous: prev && prev.expectedText !== expectedText ? [...prev.previous, prev.expectedText] : (prev?.previous ?? []),
    });
    return {
      ok: true,
      outcome: `planned ${target.id}: expect ${JSON.stringify(expectedText)}${a.must_not_appear ? `, and NOT ${JSON.stringify(a.must_not_appear)}` : ""}`,
      detail: "Now set up the state and perform the steps. Record the verdict while the result is on screen.",
    };
  }

  async function recordResult(a: Record<string, unknown>, stepN: number): Promise<ExecResult> {
    const target = findCriterion(criteria, a.criterion);
    if (!target) return { ok: false, outcome: `unknown criterion "${a.criterion}". Use one of ${criteria.map((c) => c.id).join(", ")}.` };
    let status = String(a.status ?? "").toLowerCase() as CriterionStatus;
    if (!["pass", "fail", "blocked"].includes(status)) return { ok: false, outcome: `status must be pass, fail or blocked` };
    const plan = plans.get(target.id);
    if (!plan && status !== "blocked") {
      return { ok: false, outcome: `no test plan for ${target.id}. Call plan_test first (how you will test it and the exact text you expect), then test, then record.` };
    }
    const observed = String(a.observed_text ?? "").trim();

    // Evidence grounding: the quoted text must have actually been on a page the agent saw.
    const current = await takeSnapshot();
    let grounded = true;
    if (status !== "blocked") {
      grounded = isGrounded(observed, seenPages);
      if (!grounded) {
        const n = (groundingRejections.get(target.id) ?? 0) + 1;
        groundingRejections.set(target.id, n);
        if (n <= MAX_GROUNDING_REJECTIONS) {
          return {
            ok: false,
            outcome: `rejected: observed_text ${JSON.stringify(observed)} does not appear on any page you have seen. Copy the exact text from a snapshot (re-check the page if needed), then record the verdict again.`,
            attachPage: true,
          };
        }
      }
    }

    // Oracle check: a PASS must agree with the plan, checked by code against the page right now.
    // This stops the most dangerous LLM failure in QA: calling a visible bug a pass.
    let oracle: CriterionResult["oracle"];
    if (plan) {
      const expectedOnPage = isGrounded(plan.expectedText, [current]);
      const forbiddenOnPage = plan.mustNotAppear ? isGrounded(plan.mustNotAppear, [current]) : false;
      oracle = { expected: plan.expectedText, mustNotAppear: plan.mustNotAppear, held: expectedOnPage && !forbiddenOnPage, revised: plan.previous };
      if (status === "pass" && !oracle.held) {
        const n = (oracleRejections.get(target.id) ?? 0) + 1;
        oracleRejections.set(target.id, n);
        const why = !expectedOnPage
          ? `your planned expected text ${JSON.stringify(plan.expectedText)} is not on the page right now`
          : `${JSON.stringify(plan.mustNotAppear)} is on the page, but your plan said it must not be`;
        if (n <= MAX_ORACLE_REJECTIONS) {
          return {
            ok: false,
            outcome: `rejected PASS for ${target.id}: ${why}. Compare the page with your expectation. If the app really behaves differently from the acceptance criterion, record status "fail" with expected vs actual. If you have not performed the check yet, do it and record while the result is on screen.`,
            attachPage: true,
          };
        }
        // The model insists on a pass the page contradicts: never let that through as a pass.
        status = "blocked";
        a.notes = `Agent claimed PASS, but its own expected result (${why}) was not confirmed by the page. Needs human review.`;
      }
    }

    // Defect grouping: only accept a link to another criterion that already failed.
    let sameDefectAs: string | undefined;
    if (status === "fail" && optStr(a.same_defect_as)) {
      const other = findCriterion(criteria, a.same_defect_as);
      if (!other || other.id === target.id || other.status !== "fail") {
        return {
          ok: false,
          outcome: `same_defect_as must name an earlier criterion that was recorded as fail (got "${a.same_defect_as}"). Leave it empty for a separate defect.`,
        };
      }
      sameDefectAs = other.sameDefectAs ?? other.id; // point at the group's first criterion
    }

    const screenshot = `${target.id}.png`;
    await browser.screenshot(join(runDir, screenshot)).catch(() => {});
    Object.assign(target, {
      sameDefectAs,
      status,
      observed: observed || undefined,
      expected: optStr(a.expected) ?? plan?.expectedText,
      actual: optStr(a.actual),
      stepsToReproduce: optStr(a.steps_to_reproduce),
      notes: optStr(a.notes),
      howTested: plan?.howToTest || undefined,
      screenshot,
      grounded,
      oracle,
    });
    const left = remaining();
    return {
      ok: true,
      outcome: `recorded ${target.id} = ${status}${grounded ? "" : " (evidence unverified)"}`,
      detail: left.length ? `Still to verify: ${left.join(", ")}.` : "All criteria have a verdict. Call finish.",
      screenshot,
    };
  }

  try {
    log(`▶ ${ticket.key} "${ticket.summary}" with ${llm.provider}/${llm.model} · ${criteria.length} criteria`);
    await browser.goto(ticket.appUrl);
    const messages: Message[] = [{ role: "user", content: initialPrompt(ticket, await takeSnapshot()) }];
    newIssues();

    let stepN = 0;
    let nudges = 0;
    while (!finished) {
      if (stepN >= maxSteps) {
        summary ||= `Stopped: reached the step limit (${maxSteps}) before all criteria had a verdict.`;
        log(`■ step limit reached`);
        break;
      }
      if (Date.now() - startedAt.getTime() > timeoutMs) {
        summary ||= `Stopped: exceeded the time limit (${Math.round(timeoutMs / 1000)}s).`;
        log(`■ time limit reached`);
        break;
      }

      pruneOldSnapshots(messages);
      const res = await llm.chat({ system: SYSTEM_PROMPT, messages, tools: AGENT_TOOLS, maxTokens: opts.maxTokens ?? 8192 });
      usage.llmCalls++;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls.length ? res.toolCalls : undefined });
      if (res.text.trim()) log(`  💭 ${oneLine(res.text)}`);

      if (!res.toolCalls.length) {
        if (++nudges > 3) {
          summary ||= "Stopped: the model stopped calling tools.";
          break;
        }
        messages.push({ role: "user", content: NUDGE_USE_TOOLS });
        continue;
      }
      nudges = 0;
      snapshotsThisTurn = 0;

      for (const [i, call] of res.toolCalls.entries()) {
        if (finished || stepN >= maxSteps) {
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: "Not executed: the session has ended." });
          continue;
        }
        const n = ++stepN;
        let result: ExecResult;
        try {
          result = await execute(call, n);
        } catch (err) {
          const msg = err instanceof StaleRefError ? err.message : firstLine((err as Error).message);
          result = { ok: false, outcome: `error: ${msg}`, attachPage: true };
        }

        const isLast = i === res.toolCalls.length - 1;
        let content = `${result.ok ? "OK" : "Failed"}: ${result.outcome}`;
        if (result.detail) content += `\n${result.detail}`;
        const issues = ACTION_TOOLS.has(call.name) ? newIssues() : [];
        if (issues.length) content += `\nPage issues after this action:\n- ${issues.join("\n- ")}`;

        let stepShot: string | undefined = result.screenshot;
        if (ACTION_TOOLS.has(call.name) && result.ok && opts.stepScreenshots !== false) {
          stepShot = `step-${String(n).padStart(2, "0")}.png`;
          await browser.screenshot(join(runDir, stepShot)).catch(() => (stepShot = undefined));
        }
        // Only re-read the page after the last call in a batch: re-reading regenerates refs,
        // which would make later calls in the same batch point at the wrong elements.
        if (result.attachPage && isLast) content += PAGE_MARKER + (await takeSnapshot());

        steps.push({
          n,
          tool: call.name,
          args: call.args,
          ok: result.ok,
          outcome: result.outcome,
          url: lastPage.match(/^URL: (.*)$/m)?.[1],
          screenshot: stepShot,
          at: new Date().toISOString(),
        });
        log(`  ${result.ok ? "→" : "✗"} ${String(n).padStart(2)} ${call.name}: ${result.outcome}`);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      }
    }
  } catch (err) {
    error = (err as Error).message;
    log(`✗ run aborted: ${firstLine(error)}`);
  }

  const verdict: RunVerdict = error && criteria.every((c) => c.status === "not_tested") ? "error" : computeVerdict(criteria);
  const finishedAt = new Date();
  const report: AgentReport = {
    ticketKey: ticket.key,
    verdict,
    summary: summary || (error ? `Run aborted: ${firstLine(error)}` : ""),
    criteria,
    steps,
    model: { provider: llm.provider, model: llm.model },
    modelsUsed: (llm as { modelsUsed?: string[] }).modelsUsed,
    usage,
    pageIssues,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    runDir,
    error,
  };
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));
  log(`■ ${ticket.key}: ${verdict.toUpperCase()} (${steps.length} steps, ${usage.llmCalls} LLM calls)`);
  return report;
}

/** The run's verdict is computed from per-criterion results, never taken from the model's say-so. */
export function computeVerdict(criteria: CriterionResult[]): RunVerdict {
  if (criteria.some((c) => c.status === "fail")) return "failed";
  if (criteria.length > 0 && criteria.every((c) => c.status === "pass")) return "passed";
  return "incomplete";
}

/** True when `observed` (ignoring case, quotes, whitespace and [eN] refs) appears in any of the pages. */
export function isGrounded(observed: string, pages: string[]): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\[e\d+\]\s*/g, "")
      .replace(/["'“”‘’]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const o = norm(observed);
  if (o.length < 2) return false;
  // Whole-text match: "2 items left" must not match inside "12 items left".
  const escaped = o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
  return pages.some((p) => re.test(norm(p)));
}

/** Keeps only the newest page snapshot in the conversation to bound token usage. */
export function pruneOldSnapshots(messages: Message[]) {
  const withPage = messages
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => (m.role === "user" || m.role === "tool") && m.content.includes(PAGE_MARKER));
  for (const { m } of withPage.slice(0, -1)) {
    if (m.role === "user" || m.role === "tool") {
      m.content = m.content.slice(0, m.content.indexOf(PAGE_MARKER)) + "\n\n(older page snapshot omitted)";
    }
  }
}

function findCriterion(criteria: CriterionResult[], raw: unknown): CriterionResult | undefined {
  const m = String(raw ?? "").match(/(\d+)/);
  return m ? criteria[Number(m[1]) - 1] : undefined;
}

function normRef(raw: unknown): string {
  return String(raw ?? "").replace(/[[\]\s]/g, "").replace(/^ref=?/i, "");
}

function optStr(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s || undefined;
}

function oneLine(s: string, n = 160) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function firstLine(s: string) {
  return s.split("\n")[0].replace(/\u001b\[[0-9;]*m/g, "");
}
