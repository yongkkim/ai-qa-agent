export type RunState = "queued" | "running" | "passed" | "failed" | "error";

export interface Run {
  id: number;
  issueKey: string;
  state: RunState;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
}

/**
 * Serial job queue: one QA run at a time (one browser, predictable logs, no
 * parallel runs fighting over the same app state). A ticket that is already
 * queued or running is not queued again, so duplicate webhooks are harmless.
 */
export class RunQueue {
  private runs: Run[] = [];
  private nextId = 1;
  private busy = false;

  constructor(private readonly worker: (run: Run) => Promise<void>) {}

  enqueue(issueKey: string): { run: Run; duplicate: boolean } {
    const existing = this.runs.find((r) => r.issueKey === issueKey && (r.state === "queued" || r.state === "running"));
    if (existing) return { run: existing, duplicate: true };
    const run: Run = { id: this.nextId++, issueKey, state: "queued", queuedAt: new Date().toISOString() };
    this.runs.push(run);
    void this.drain();
    return { run, duplicate: false };
  }

  list(): Run[] {
    return [...this.runs].reverse();
  }

  private async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      let next: Run | undefined;
      while ((next = this.runs.find((r) => r.state === "queued"))) {
        next.state = "running";
        next.startedAt = new Date().toISOString();
        try {
          await this.worker(next);
        } catch (err) {
          next.state = "error";
          next.summary = (err as Error).message;
          console.error(`[orchestrator] run #${next.id} ${next.issueKey} crashed:`, err);
        }
        next.finishedAt = new Date().toISOString();
      }
    } finally {
      this.busy = false;
    }
  }
}
