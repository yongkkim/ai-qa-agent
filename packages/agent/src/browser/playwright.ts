import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StaleRefError, type BrowserDriver, type PageSnapshot } from "./driver.js";
import { SNAPSHOT_SCRIPT } from "./snapshot-script.js";

export interface PlaywrightOptions {
  headless?: boolean;
  /** Slow every action down (ms) so a human can follow along. */
  slowMo?: number;
  viewport?: { width: number; height: number };
  /** Use an existing Chromium/Chrome binary instead of Playwright's download. */
  executablePath?: string;
  /** e.g. "chrome" or "msedge" to drive the locally installed browser. */
  channel?: string;
}

/**
 * Real Chromium via Playwright. Playwright is only the agent's hands here:
 * it executes whatever the model decides; there are no scripted test steps.
 * Every run gets a fresh browser context (clean cookies + localStorage).
 */
export class PlaywrightDriver implements BrowserDriver {
  private issues: string[] = [];

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {
    // Browsers request /favicon.ico on their own; a missing one is not an app bug.
    const noise = (url: string) => /\/favicon\.ico(\?|$)/.test(url);
    page.on("console", (msg) => {
      if (msg.type() === "error" && !noise(msg.location().url)) this.issues.push(`console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => this.issues.push(`uncaught exception: ${err.message}`));
    page.on("requestfailed", (req) => this.issues.push(`request failed: ${req.method()} ${req.url()} (${req.failure()?.errorText})`));
    page.on("response", (res) => {
      if (res.status() >= 400 && !noise(res.url())) this.issues.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
    });
  }

  static async launch(opts: PlaywrightOptions = {}): Promise<PlaywrightDriver> {
    let browser: Browser;
    try {
      browser = await chromium.launch({
        headless: opts.headless ?? true,
        slowMo: opts.slowMo,
        executablePath: opts.executablePath || undefined,
        channel: opts.channel || undefined,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
        throw new Error(
          "Chromium for Playwright is not installed. Run: npx playwright install chromium " +
            "(or set AGENT_BROWSER_CHANNEL=chrome to use your installed Chrome)\n" +
            msg.split("\n")[0],
        );
      }
      throw err;
    }
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    return new PlaywrightDriver(browser, context, page);
  }

  private locate(ref: string) {
    if (!/^e\d+$/.test(ref)) throw new StaleRefError(ref);
    return this.page.locator(`[data-qa-ref="${ref}"]`);
  }

  private async existing(ref: string) {
    const loc = this.locate(ref);
    if ((await loc.count()) === 0) throw new StaleRefError(ref);
    return loc.first();
  }

  /** Let the page react (re-render, navigation, network) before the next snapshot. */
  private async settle() {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    await this.page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => {});
    await this.page.waitForTimeout(150);
  }

  async goto(url: string) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await this.settle();
  }

  async reload() {
    await this.page.reload({ waitUntil: "domcontentloaded" });
    await this.settle();
  }

  async snapshot(): Promise<PageSnapshot> {
    const result = (await this.page.evaluate(SNAPSHOT_SCRIPT)) as { text: string };
    return { url: this.page.url(), title: await this.page.title(), text: result.text };
  }

  async click(ref: string) {
    await (await this.existing(ref)).click();
    await this.settle();
  }

  async type(ref: string, text: string) {
    const el = await this.existing(ref);
    await el.fill("");
    // pressSequentially fires real key events (fill() would skip them), like a human typing.
    if (text.length <= 200) await el.pressSequentially(text, { delay: 5 });
    else await el.fill(text);
    await this.settle();
  }

  async press(key: string) {
    await this.page.keyboard.press(key);
    await this.settle();
  }

  async selectOption(ref: string, value: string) {
    const el = await this.existing(ref);
    await el.selectOption({ label: value }).catch(() => el.selectOption(value));
    await this.settle();
  }

  async screenshot(path: string, opts: { showText?: string } = {}) {
    mkdirSync(dirname(path), { recursive: true });
    if (opts.showText) {
      await this.page
        .getByText(opts.showText)
        .first()
        .scrollIntoViewIfNeeded({ timeout: 1000 })
        .catch(() => {});
    }
    await this.page.screenshot({ path });
  }

  async capture() {
    return this.page.screenshot({ type: "png" });
  }

  drainIssues(): string[] {
    const out = this.issues;
    this.issues = [];
    return out;
  }

  async close() {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}
