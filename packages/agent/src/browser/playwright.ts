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
    page.on("console", (msg) => {
      if (msg.type() === "error") this.issues.push(`console.error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => this.issues.push(`uncaught exception: ${err.message}`));
    page.on("requestfailed", (req) => this.issues.push(`request failed: ${req.method()} ${req.url()} (${req.failure()?.errorText})`));
    page.on("response", (res) => {
      if (res.status() >= 400) this.issues.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
    });
  }

  static async launch(opts: PlaywrightOptions = {}): Promise<PlaywrightDriver> {
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: opts.headless ?? true, slowMo: opts.slowMo });
    } catch (err) {
      const msg = (err as Error).message;
      if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
        throw new Error("Chromium for Playwright is not installed. Run: npx playwright install chromium\n" + msg.split("\n")[0]);
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

  async screenshot(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    await this.page.screenshot({ path, fullPage: true });
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
