import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentReport } from "@ai-qa/agent";
import { formatBugDescription, formatResultComment, isProviderOutage } from "../src/report.js";

const base: AgentReport = {
  ticketKey: "QA-1",
  verdict: "error",
  summary: "",
  criteria: [{ id: "AC1", text: "Something works", status: "not_tested" }],
  steps: [],
  model: { provider: "gemini", model: "gemini-small" },
  usage: { inputTokens: 0, outputTokens: 0, llmCalls: 1 },
  pageIssues: [],
  startedAt: "",
  finishedAt: "",
  durationMs: 1000,
  runDir: "",
};

describe("result comment", () => {
  it("says clearly that a provider outage is not a product failure", () => {
    const report = { ...base, error: "[gemini] HTTP 503: the provider is overloaded (after 6 attempts)\n{...}" };
    assert.ok(isProviderOutage(report));
    const body = formatResultComment(report, "QA-1-x", "http://x/artifacts/QA-1-x");
    assert.match(body, /NOT TESTED/);
    assert.match(body, /This is not a product failure/);
    assert.match(body, /LLM_FALLBACK_MODELS/);
  });

  it("does not blame the provider for other errors", () => {
    const report = { ...base, error: "Chromium is not installed" };
    assert.ok(!isProviderOutage(report));
    assert.doesNotMatch(formatResultComment(report, "r", "u"), /not a product failure/);
  });

  it("shows every model used when a fallback happened", () => {
    const report: AgentReport = { ...base, verdict: "passed", modelsUsed: ["gemini-big", "gemini-small"] };
    assert.match(formatResultComment(report, "r", "u"), /`gemini\/gemini-big → gemini-small`/);
    const c = { id: "AC1", text: "x", status: "fail" as const, screenshot: "AC1.png" };
    assert.match(formatBugDescription("QA-1", c, report, "u"), /Tested by: AI QA agent, model `gemini\/gemini-big → gemini-small`/);
  });
});
