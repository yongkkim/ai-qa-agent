import type { JiraClient, JiraIssue } from "./jira.js";
import type { Run } from "./queue.js";

/**
 * Runs QA for one ticket. Day 1: proves the trigger loop end to end
 * (webhook -> fetch ticket -> report back to Jira). Day 2 replaces the body
 * with the AI browser agent from packages/agent.
 */
export async function runQa(run: Run, jira: JiraClient): Promise<void> {
  const issue: JiraIssue = await jira.getIssue(run.issueKey);
  console.log(`[orchestrator] run #${run.id}: ${issue.key} "${issue.fields.summary}"`);

  const criteria = extractAcceptanceCriteria(issue.fields.description);
  console.log(`[orchestrator] found ${criteria.length} acceptance criteria`);

  await jira.addComment(
    issue.key,
    [
      `🤖 **AI QA run #${run.id} picked up this ticket.**`,
      `Found ${criteria.length} acceptance criteria to verify.`,
      "",
      "_(Agent not wired in yet: Day 1 checks the trigger loop only.)_",
    ].join("\n"),
  );

  run.state = "passed";
  run.summary = `trigger loop ok, ${criteria.length} criteria found`;
}

/** Pulls the numbered list under an "Acceptance Criteria" heading out of a ticket description. */
export function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(#+\s*)?acceptance criteria\s*:?\s*$/i.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/);
    if (m) out.push(m[1]);
    else if (line.trim() && out.length) break; // next section
  }
  return out;
}
