import { join } from "node:path";
import { extractAcceptanceCriteria, runAgent, type AgentReport, type BrowserDriver } from "@ai-qa/agent";
import { LLMConfigError, type LLMProvider } from "@ai-qa/llm";
import type { JiraClient } from "./jira.js";
import type { Run } from "./queue.js";
import { formatBugDescription, formatResultComment, groupFailures } from "./report.js";
import type { BugTicketMode } from "./env.js";

export const LABELS = {
  running: "ai-qa-running",
  passed: "ai-qa-passed",
  failed: "ai-qa-failed",
  incomplete: "ai-qa-incomplete",
  error: "ai-qa-error",
} as const;
const ALL_LABELS = Object.values(LABELS);

export interface RunnerDeps {
  jira: JiraClient;
  /** Builds the LLM from config; may throw LLMConfigError. */
  createLLM: () => LLMProvider;
  createBrowser: () => Promise<BrowserDriver>;
  artifactsDir: string;
  /** Public URL prefix that serves artifactsDir (for screenshot links in comments). */
  artifactsUrl: string;
  defaultAppUrl: string;
  statusOnPass: string;
  statusOnFail: string;
  /** per-defect | per-criterion | off (see QA_BUG_TICKETS). */
  bugTicketMode: BugTicketMode;
  agent: { maxSteps: number; timeoutMs: number; stepScreenshots: boolean };
  log?: (line: string) => void;
}

/** "Test URL: http://..." in the description wins; otherwise the configured app URL. */
export function findTestUrl(description: string, fallback: string): string {
  return description.match(/^\s*(?:test|app)\s*url\s*:\s*(\S+)/im)?.[1] ?? fallback;
}

function runLabelFor(key: string, at = new Date()) {
  const ts = at.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  return `${key}-${ts}`;
}

/** Runs QA for one ticket and reports back to Jira: comment, labels, transition, bug tickets. */
export function createRunner(deps: RunnerDeps) {
  const log = deps.log ?? ((l: string) => console.log(`[orchestrator] ${l}`));

  return async function runQa(run: Run): Promise<void> {
    const { jira } = deps;
    const issue = await jira.getIssue(run.issueKey);
    const key = issue.key;
    const setOutcomeLabel = (label: string) => jira.updateLabels(key, { remove: ALL_LABELS.filter((l) => l !== label), add: [label] });

    const criteria = extractAcceptanceCriteria(issue.fields.description);
    if (!criteria.length) {
      await jira.addComment(
        key,
        `🤖 **AI QA could not start:** no acceptance criteria found.\nAdd a numbered list under an \`Acceptance Criteria:\` heading in the description, then move the ticket to In Testing again.`,
      );
      await setOutcomeLabel(LABELS.incomplete);
      run.state = "error";
      run.summary = "no acceptance criteria";
      return;
    }

    let llm: LLMProvider;
    try {
      llm = deps.createLLM();
    } catch (err) {
      const msg = err instanceof LLMConfigError ? err.message : (err as Error).message;
      await jira.addComment(key, `🤖 **AI QA could not start:** the AI model is not configured.\n${msg}`);
      await setOutcomeLabel(LABELS.error);
      run.state = "error";
      run.summary = msg;
      log(`${key}: ${msg}`);
      return;
    }

    const appUrl = findTestUrl(issue.fields.description, deps.defaultAppUrl);
    const runLabel = runLabelFor(key);
    run.label = runLabel;
    const runDir = join(deps.artifactsDir, runLabel);
    const artifactsUrl = `${deps.artifactsUrl}/${runLabel}`;

    await setOutcomeLabel(LABELS.running);
    await jira.addComment(
      key,
      `🤖 **AI QA run started** with \`${llm.provider}/${llm.model}\` — testing ${criteria.length} acceptance criteria against ${appUrl}. Results will be posted here.`,
    );

    let report: AgentReport;
    let browser: BrowserDriver | undefined;
    try {
      browser = await deps.createBrowser();
      report = await runAgent(
        { key, summary: issue.fields.summary, description: issue.fields.description, criteria, appUrl },
        { llm, browser, runDir, ...deps.agent, log: (l) => log(`[${key}] ${l}`) },
      );
    } catch (err) {
      // Browser failed to launch etc. (runAgent itself never throws for LLM/page errors).
      const msg = (err as Error).message;
      await jira.addComment(key, `🤖 **AI QA run failed to start:** \`${msg.split("\n")[0]}\``);
      await setOutcomeLabel(LABELS.error);
      run.state = "error";
      run.summary = msg;
      return;
    } finally {
      await browser?.close();
    }

    // File bug tickets: by default one per underlying defect, so each can be fixed and tracked on its own
    // without duplicates when one defect breaks several criteria.
    const bugKeys: string[] = [];
    if (report.verdict === "failed") {
      for (const group of groupFailures(report.criteria, deps.bugTicketMode)) {
        const [first] = group;
        const ids = group.map((c) => c.id).join(", ");
        try {
          const bug = await jira.createIssue({
            summary: `[${key} ${ids}] ${first.actual ? truncate(first.actual, 90) : `Fails: ${truncate(first.text, 90)}`}`,
            description: formatBugDescription(key, group, report, artifactsUrl, { appUrl, runLabel }),
            issuetype: "Bug",
            labels: ["found-by-ai-qa", `parent-${key}`],
          });
          bugKeys.push(`${bug.key} (${ids})`);
        } catch (err) {
          log(`${key}: could not create bug ticket: ${(err as Error).message}`);
        }
      }
    }

    await jira.addComment(key, formatResultComment(report, runLabel, artifactsUrl, bugKeys));
    await setOutcomeLabel(LABELS[report.verdict]);

    const target = report.verdict === "passed" ? deps.statusOnPass : report.verdict === "failed" ? deps.statusOnFail : undefined;
    if (target) {
      await jira.transitionTo(key, target).catch((err) => log(`${key}: could not move to "${target}": ${(err as Error).message}`));
    }

    run.state = report.verdict === "passed" ? "passed" : report.verdict === "failed" ? "failed" : report.verdict === "error" ? "error" : "incomplete";
    run.summary = `${report.criteria.filter((c) => c.status === "pass").length}/${report.criteria.length} criteria passed${bugKeys.length ? `, bugs: ${bugKeys.join(", ")}` : ""}`;
    run.reportUrl = `${artifactsUrl}/report.json`;
  };
}

function truncate(s: string, n: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
