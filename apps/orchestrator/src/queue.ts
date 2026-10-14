export type RunState = "queued" | "running" | "passed" | "failed" | "incomplete" | "error";

export interface Run {
  id: number;
  issueKey: string;
  state: RunState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** e.g. QA-101-20261014-173012, also the artifacts folder name. */
  label?: string;
  summary?: string;
  reportUrl?: string;
}

/**
 * Serial job queue: one QA run at a time (one browser, predictable logs, no
 * parallel runs fighting over the same app state). A ticket that is already
 * queued or running is not queued again, so duplicate webhooks are harmless.
 */
export class RunQueue {
  private runs: Run[] = [];
  private nextId = 1;
  private draining: Promise<void> | null = null;

  constructor(private readonly worker: (run: Run) => Promise<void>) {}

  enqueue(issueKey: string): { run: Run; duplicate: boolean } {
    const existing = this.runs.find((r) => r.issueKey === issueKey && (r.state === "queued" || r.state === "running"));
    if (existing) return { run: existing, duplicate: true };
    const run: Run = { id: this.nextId++, issueKey, state: "queued", queuedAt: new Date().toISOString() };
    this.runs.push(run);
    this.draining ??= this.drain().finally(() => (this.draining = null));
    return { run, duplicate: false };
  }

  list(): Run[] {
    return [...this.runs].reverse();
  }

  /** Resolves when nothing is queued or running (used by tests and the demo). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain() {
    let next: Run | undefined;
    while ((next = this.runs.find((r) => r.state === "queued"))) {
      next.state = "running";
      next.startedAt = new Date().toISOString();
      try {
        await this.worker(next);
        if (next.state === "running") next.state = "passed";
      } catch (err) {
        next.state = "error";
        next.summary = (err as Error).message;
        console.error(`[orchestrator] run #${next.id} ${next.issueKey} crashed:`, err);
      }
      next.finishedAt = new Date().toISOString();
    }
  }
}
