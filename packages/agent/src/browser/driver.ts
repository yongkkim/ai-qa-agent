/** What the agent needs from a browser. The real one is Playwright; tests use a fake. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Accessibility-style text, one element per line, interactive elements tagged [eN]. */
  text: string;
}

export interface BrowserDriver {
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  click(ref: string): Promise<void>;
  /** Clear the field, then type. */
  type(ref: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  selectOption(ref: string, value: string): Promise<void>;
  /**
   * Save a screenshot. fullPage captures below the fold too, but in Chromium it briefly resizes the
   * page when it is taller than the window, which shows as a jump in a visible browser.
   */
  screenshot(path: string, opts?: { fullPage?: boolean }): Promise<void>;
  /** Console errors, uncaught exceptions and failed requests since the last call. */
  drainIssues(): string[];
  close(): Promise<void>;
}

/** The element ref the model used no longer exists (page changed). The message is shown to the model. */
export class StaleRefError extends Error {
  constructor(ref: string) {
    super(`No element with ref [${ref}] on the current page. Refs change when the page updates; use a ref from the latest snapshot.`);
  }
}

export function formatSnapshot(s: PageSnapshot): string {
  return `URL: ${s.url}\nTitle: ${s.title}\n\n${s.text || "(page has no visible content)"}`;
}
