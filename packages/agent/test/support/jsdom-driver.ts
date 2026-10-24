import { JSDOM, VirtualConsole } from "jsdom";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StaleRefError, type BrowserDriver, type PageSnapshot } from "../../src/browser/driver.js";
import { SNAPSHOT_SCRIPT } from "../../src/browser/snapshot-script.js";
import type { BuiltApp } from "./sample-app.js";

const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * A BrowserDriver backed by jsdom, running the real built sample app.
 * Lets the full agent loop be tested in CI without Chromium. It mimics a
 * user closely enough for React (native value setter + input events, form
 * submit on Enter), and keeps localStorage across reloads like a browser.
 */
export class JsdomDriver implements BrowserDriver {
  private dom?: JSDOM;
  private storage: Record<string, string> = {};
  private issues: string[] = [];
  readonly screenshots: string[] = [];

  constructor(private readonly app: BuiltApp) {}

  private get w(): any {
    if (!this.dom) throw new Error("no page loaded");
    return this.dom.window;
  }

  private async load(url: string) {
    this.saveStorage();
    this.dom?.window.close();
    const vc = new VirtualConsole();
    vc.on("error", (...a: unknown[]) => this.issues.push(`console.error: ${a.join(" ")}`));
    vc.on("jsdomError", (e: Error) => this.issues.push(`uncaught exception: ${e.message}`));
    this.dom = new JSDOM(
      `<!doctype html><html><head><title>Todo App</title><style>${this.app.css}</style></head><body><div id="root"></div></body></html>`,
      { url, runScripts: "outside-only", virtualConsole: vc, pretendToBeVisual: true },
    );
    const w = this.w;
    w.crypto.randomUUID ??= () => Math.random().toString(36).slice(2);
    for (const [k, v] of Object.entries(this.storage)) w.localStorage.setItem(k, v);
    w.eval(this.app.js);
    await tick();
  }

  private saveStorage() {
    if (!this.dom) return;
    const ls = this.dom.window.localStorage;
    this.storage = {};
    for (let i = 0; i < ls.length; i++) this.storage[ls.key(i)!] = ls.getItem(ls.key(i)!)!;
  }

  private el(ref: string): any {
    const found = this.w.document.querySelector(`[data-qa-ref="${ref}"]`);
    if (!found) throw new StaleRefError(ref);
    return found;
  }

  async goto(url: string) {
    await this.load(url);
  }

  async reload() {
    await this.load(this.w.location.href);
  }

  async snapshot(): Promise<PageSnapshot> {
    const { text } = this.w.eval(SNAPSHOT_SCRIPT) as { text: string };
    return { url: this.w.location.href, title: this.w.document.title, text };
  }

  async click(ref: string) {
    const el = this.el(ref);
    el.focus?.();
    el.click();
    await tick();
  }

  async type(ref: string, text: string) {
    const el = this.el(ref);
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? this.w.HTMLTextAreaElement.prototype : this.w.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
    el.dispatchEvent(new this.w.Event("input", { bubbles: true }));
    await tick();
  }

  async press(key: string) {
    const active = this.w.document.activeElement;
    active?.dispatchEvent(new this.w.KeyboardEvent("keydown", { key, bubbles: true }));
    if (key === "Enter" && active?.form) active.form.requestSubmit();
    await tick();
  }

  async selectOption(ref: string, value: string) {
    const el = this.el(ref);
    const opt = Array.from(el.options as ArrayLike<any>).find((o) => o.textContent.trim() === value || o.value === value);
    if (!opt) throw new Error(`no option "${value}"`);
    el.value = opt.value;
    el.dispatchEvent(new this.w.Event("change", { bubbles: true }));
    await tick();
  }

  /** jsdom cannot render pixels: a 1×1 PNG stands in for the screenshot the model would see. */
  async capture() {
    this.captures++;
    return Buffer.from(TINY_PNG, "base64");
  }
  captures = 0;

  async screenshot(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fake screenshot");
    this.screenshots.push(path);
  }

  drainIssues() {
    const out = this.issues;
    this.issues = [];
    return out;
  }

  async close() {
    this.dom?.window.close();
  }
}

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
