export interface TicketUnderTest {
  key: string;
  summary: string;
  description: string;
  /** Acceptance criteria in order; the agent refers to them as AC1, AC2... */
  criteria: string[];
  /** Where to start testing. */
  appUrl: string;
}

export type CriterionStatus = "pass" | "fail" | "blocked" | "not_tested";

export interface CriterionResult {
  id: string;
  text: string;
  status: CriterionStatus;
  /** Exact text from the page that backs the verdict. */
  observed?: string;
  expected?: string;
  actual?: string;
  stepsToReproduce?: string;
  notes?: string;
  /** Screenshot taken at the moment the verdict was recorded (path relative to the run dir). */
  screenshot?: string;
  /** false when the model's evidence could not be found on any page it saw. */
  grounded?: boolean;
}

export interface StepRecord {
  n: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Short outcome, e.g. 'clicked [e2] button "Add"' or an error. */
  outcome: string;
  url?: string;
  screenshot?: string;
  at: string;
}

export type RunVerdict = "passed" | "failed" | "incomplete" | "error";

export interface AgentReport {
  ticketKey: string;
  verdict: RunVerdict;
  summary: string;
  criteria: CriterionResult[];
  steps: StepRecord[];
  model: { provider: string; model: string };
  /** When a fallback chain is configured: every model used in order (the last one finished the run). */
  modelsUsed?: string[];
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  /** Console errors, uncaught exceptions and failed requests seen while testing. */
  pageIssues: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Directory holding screenshots and report.json. */
  runDir: string;
  error?: string;
}
