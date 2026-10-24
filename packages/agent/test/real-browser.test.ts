/**
 * The same agent loop in a REAL Chromium via Playwright, against the built
 * sample app served over HTTP. Runs wherever Chromium is available
 * (`npx playwright install chromium`, AGENT_BROWSER_CHANNEL=chrome, or
 * AGENT_BROWSER_PATH); skipped otherwise so CI without browsers stays green.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { ScriptedProvider, type ScriptStep } from "@ai-qa/llm";
import { runAgent } from "../src/agent.js";
import { PlaywrightDriver } from "../src/browser/playwright.js";
import { buildSampleApp } from "./support/sample-app.js";
import { addTodo, onPage, plan, ref } from "./support/script-helpers.js";

const launchOpts = { channel: process.env.AGENT_BROWSER_CHANNEL || undefined, executablePath: process.env.AGENT_BROWSER_PATH || undefined };
let available = false;
const servers: Record<string, { url: string; server: Server }> = {};

function serve(dir: string): Promise<{ url: string; server: Server }> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = createServer((req, res) => {
    const path = normalize(join(dir, (req.url ?? "/").split("?")[0]));
    const file = path.startsWith(dir) && existsSync(path) && extname(path) ? path : join(dir, "index.html");
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server })));
}

before(async () => {
  try {
    await (await PlaywrightDriver.launch(launchOpts)).close();
    available = true;
  } catch {
    available = false;
    return;
  }
  for (const mode of ["normal", "buggy"] as const) servers[mode] = await serve((await buildSampleApp(mode)).dir);
});
after(() => Object.values(servers).forEach((s) => s.server.close()));

const counterAndWhitespace: ScriptStep[] = [
  plan("AC1", "1 item left"),
  addTodo("Buy milk"),
  addTodo("Walk dog"),
  onPage("click", (p) => ({ ref: ref(p, 'checkbox "Buy milk"') })),
  onPage("record_result", (p) =>
    p.includes('text "1 item left"')
      ? { criterion: "AC1", status: "pass", observed_text: "1 item left" }
      : { criterion: "AC1", status: "fail", observed_text: "2 items left", expected: "1 item left", actual: "2 items left" },
  ),
  plan("AC2", "Todo cannot be empty."),
  addTodo("   "),
  onPage("record_result", (p) =>
    p.includes('alert "Todo cannot be empty."')
      ? { criterion: "AC2", status: "pass", observed_text: "Todo cannot be empty." }
      : { criterion: "AC2", status: "fail", observed_text: "3 items left", expected: "rejected", actual: "blank todo added" },
  ),
  { tool: "finish", args: { summary: "done" } },
];

async function runIn(mode: "normal" | "buggy") {
  const browser = await PlaywrightDriver.launch(launchOpts);
  try {
    const runDir = mkdtempSync(join(tmpdir(), "ai-qa-real-"));
    return await runAgent(
      { key: "QA-R", summary: "real browser", description: "", criteria: ["Counter counts active todos", "Whitespace-only input is rejected"], appUrl: servers[mode].url },
      { llm: new ScriptedProvider(counterAndWhitespace), browser, runDir },
    );
  } finally {
    await browser.close();
  }
}

describe("agent in a real Chromium", () => {
  it("passes on the correct app", async (t) => {
    if (!available) return t.skip("Chromium not installed (npx playwright install chromium)");
    const report = await runIn("normal");
    assert.equal(report.verdict, "passed");
    assert.deepEqual(report.pageIssues, []);
    assert.ok(existsSync(join(report.runDir, "AC1.png")), "real screenshot saved");
  });

  it("catches both planted bugs on the buggy app", async (t) => {
    if (!available) return t.skip("Chromium not installed (npx playwright install chromium)");
    const report = await runIn("buggy");
    assert.equal(report.verdict, "failed");
    assert.deepEqual(report.criteria.map((c) => c.status), ["fail", "fail"]);
  });

  it("look sends a real PNG of the window to the model", async (t) => {
    if (!available) return t.skip("Chromium not installed (npx playwright install chromium)");
    const browser = await PlaywrightDriver.launch(launchOpts);
    try {
      let image: { mimeType: string; data: string } | undefined;
      const llm = new ScriptedProvider([
        { tool: "look", args: {} },
        (req) => {
          const last = req.messages.at(-1);
          image = last?.role === "tool" ? last.images?.[0] : undefined;
          return { tool: "finish", args: { summary: "done" } };
        },
        { tool: "finish", args: { summary: "done" } },
      ]);
      const runDir = mkdtempSync(join(tmpdir(), "ai-qa-real-"));
      await runAgent({ key: "QA-R", summary: "look", description: "", criteria: ["Looks right"], appUrl: servers.normal.url }, { llm, browser, runDir });
      assert.equal(image?.mimeType, "image/png");
      assert.equal(Buffer.from(image!.data, "base64").subarray(1, 4).toString(), "PNG");
      assert.ok(existsSync(join(runDir, "look-01.png")));
    } finally {
      await browser.close();
    }
  });
});
