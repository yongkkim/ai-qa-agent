import type { AgentReport, CriterionResult } from "@ai-qa/agent";

const ICON: Record<CriterionResult["status"], string> = { pass: "✅", fail: "❌", blocked: "⚠️", not_tested: "⏭️" };
const VERDICT: Record<AgentReport["verdict"], string> = {
  passed: "✅ PASSED",
  failed: "❌ FAILED",
  incomplete: "⚠️ INCOMPLETE (needs a human)",
  error: "💥 NOT TESTED (the agent hit an error)",
};

/** True when the run died because the AI provider was unreachable/overloaded, not because of the product. */
export function isProviderOutage(report: AgentReport): boolean {
  return !!report.error && /^\[[\w+.-]+\] (HTTP (429|5\d\d)|could not reach)/.test(report.error);
}

export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function counts(report: AgentReport) {
  const n = (s: CriterionResult["status"]) => report.criteria.filter((c) => c.status === s).length;
  const parts = [`${n("pass")}/${report.criteria.length} passed`];
  if (n("fail")) parts.push(`${n("fail")} failed`);
  if (n("blocked")) parts.push(`${n("blocked")} blocked`);
  if (n("not_tested")) parts.push(`${n("not_tested")} not tested`);
  return parts.join(", ");
}

/**
 * The Jira comment posted after a run. Markdown subset (the mock board renders
 * **bold**, `code` and images). Real Jira would need this converted to ADF.
 */
export function formatResultComment(report: AgentReport, runLabel: string, artifactsUrl: string, bugKeys: string[] = []): string {
  const lines: string[] = [];
  lines.push(`🤖 **AI QA result: ${VERDICT[report.verdict]}** · ${counts(report)}`);
  lines.push(
    `Model \`${modelLabel(report)}\` · ${report.steps.length} steps · ${report.usage.llmCalls} LLM calls · ${duration(report.durationMs)} · run \`${runLabel}\``,
  );
  if (isProviderOutage(report)) {
    lines.push(
      "",
      "⚠️ **This is not a product failure.** The AI model was unavailable (overloaded or rate-limited), so the remaining criteria could not be tested. " +
        "The ticket stays in In Testing. Move it out and back to In Testing to retry later, or set `LLM_FALLBACK_MODELS` in .env so the agent can switch to another model.",
    );
  }
  lines.push("");

  for (const c of report.criteria) {
    lines.push(`${ICON[c.status]} **${c.id}** ${c.text}`);
    if (c.status === "pass") {
      if (c.oracle?.held) lines.push(`    Checked: expected \`${c.oracle.expected}\` ✓ on page${c.howTested ? ` (${c.howTested})` : ""}`);
      else if (c.observed) lines.push(`    Evidence: \`${c.observed}\``);
    }
    if (c.oracle?.revised.length) {
      lines.push(`    ⚠️ The agent changed its expected result during the test (was: ${c.oracle.revised.map((r) => `\`${r}\``).join(", ")}); worth a human look.`);
    }
    if (c.status === "fail") {
      if (c.expected) lines.push(`    Expected: ${c.expected}`);
      if (c.actual) lines.push(`    Actual: ${c.actual}`);
      if (c.observed) lines.push(`    Observed on page: \`${c.observed}\``);
      if (c.stepsToReproduce) lines.push(`    Steps to reproduce: ${c.stepsToReproduce.replace(/\n+/g, " ")}`);
    }
    if (c.notes && c.status !== "pass") lines.push(`    Notes: ${c.notes}`);
    if (c.grounded === false) lines.push(`    ⚠️ The agent's evidence could not be verified on the page; please double-check this one.`);
    if ((c.status === "fail" || c.status === "blocked") && c.screenshot) lines.push(`    ![${c.id} screenshot](${artifactsUrl}/${c.screenshot})`);
  }

  if (report.summary) lines.push("", `**Summary:** ${report.summary}`);
  if (report.pageIssues.length) {
    lines.push("", `**Page issues seen while testing:**`);
    for (const i of report.pageIssues.slice(0, 5)) lines.push(`- \`${i}\``);
  }
  if (bugKeys.length) lines.push("", `**Bugs filed:** ${bugKeys.join(", ")}`);
  if (report.error) lines.push("", `**Error:** \`${report.error.split("\n")[0]}\``);
  lines.push("", `Full report: ${artifactsUrl}/report.json`);
  return lines.join("\n");
}

/** "gemini/gemini-3.6-flash → gemini-3.5-flash-lite" when a fallback happened, else just the model. */
export function modelLabel(report: AgentReport): string {
  const models = report.modelsUsed && report.modelsUsed.length > 1 ? report.modelsUsed.join(" → ") : report.model.model;
  return `${report.model.provider}/${models}`;
}

/**
 * Bug ticket body, laid out like a hand-written bug report: what's wrong, how to reproduce it,
 * the evidence, and finally the environment (including which AI model made the call).
 */
export function formatBugDescription(
  parentKey: string,
  c: CriterionResult,
  report: AgentReport,
  artifactsUrl: string,
  env: { appUrl?: string; runLabel?: string } = {},
): string {
  const lines = [
    `Found by the AI QA agent while testing ${parentKey}.`,
    "",
    `**Acceptance criterion (${c.id}):** ${c.text}`,
    "",
    `**Expected:** ${c.expected ?? "(see criterion)"}`,
    `**Actual:** ${c.actual ?? "(see evidence)"}`,
    c.observed ? `**Observed on page:** \`${c.observed}\`` : "",
    "",
    "**Steps to reproduce:**",
    c.stepsToReproduce ?? "(not provided — see the run report)",
    "",
  ];
  if (c.screenshot) lines.push("**Evidence:**", `![${c.id} screenshot](${artifactsUrl}/${c.screenshot})`, "");
  lines.push(
    "**Environment**",
    ...(env.appUrl ? [`App: ${env.appUrl}`] : []),
    `Tested by: AI QA agent, model \`${modelLabel(report)}\``,
    ...(env.runLabel ? [`Run: \`${env.runLabel}\``] : []),
    `Run report: ${artifactsUrl}/report.json`,
  );
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}
