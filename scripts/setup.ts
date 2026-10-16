/**
 * `npm run setup` — interactive first-time setup:
 *   1. choose an AI provider / model and enter the API key → writes .env
 *   2. install Chromium for Playwright
 *   3. verify the model works (npm run llm:check)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = resolve(ROOT, ".env");
const EXAMPLE = resolve(ROOT, ".env.example");

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

interface Preset {
  id: string;
  /** Lighter model of the same provider to fall back to when the main one is overloaded. */
  fallback?: string;
  label: string;
  model: string;
  needsKey: boolean;
  keyUrl?: string;
  baseUrl?: string;
  askBaseUrl?: boolean;
}

const PRESETS: Preset[] = [
  { id: "gemini", label: "Google Gemini (free API key, recommended)", model: "gemini-3.8-flash", fallback: "gemini-3.5-flash-lite", needsKey: true, keyUrl: "https://aistudio.google.com/apikey" },
  { id: "openai", label: "OpenAI", model: "", needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic Claude", model: "claude-sonnet-5-5", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "ollama", label: "Ollama (local model, no key)", model: "qwen3", needsKey: false, baseUrl: "http://localhost:11434/v1" },
  { id: "openai-compatible", label: "Other OpenAI-compatible API (Groq, OpenRouter, LM Studio...)", model: "", needsKey: true, askBaseUrl: true },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let muted = false;
// Hide what's typed while entering the API key.
(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
  if (!muted || s.includes("\n")) process.stdout.write(muted ? "\n" : s);
};

function ask(question: string, dflt = ""): Promise<string> {
  return new Promise((res) => rl.question(`${question}${dflt ? dim(` [${dflt}]`) : ""}: `, (a) => res(a.trim() || dflt)));
}
async function askSecret(question: string): Promise<string> {
  process.stdout.write(`${question}: `);
  muted = true;
  const a = await new Promise<string>((res) => rl.question("", res));
  muted = false;
  return a.trim();
}
async function yes(question: string, dflt = true): Promise<boolean> {
  const a = (await ask(`${question} (${dflt ? "Y/n" : "y/N"})`)).toLowerCase();
  return a ? a.startsWith("y") : dflt;
}

/** Replace `KEY=...` on an uncommented line, or append it. */
function setVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(content) ? content.replace(re, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}

function run(cmd: string) {
  console.log(dim(`$ ${cmd}`));
  return spawnSync(cmd, { cwd: ROOT, stdio: "inherit", shell: true }).status === 0;
}

async function main() {
  console.log(`\n${bold("AI QA Agent setup")}\n`);
  let content = readFileSync(existsSync(ENV) ? ENV : EXAMPLE, "utf8");
  if (existsSync(ENV)) console.log(dim("Updating your existing .env\n"));

  console.log("Which AI model should the agent use?");
  PRESETS.forEach((p, i) => console.log(`  ${i + 1}) ${p.label}`));
  const choice = Number(await ask("Choose 1-5", "1"));
  const preset = PRESETS[(Number.isInteger(choice) && choice >= 1 && choice <= PRESETS.length ? choice : 1) - 1];

  let baseUrl = preset.baseUrl ?? "";
  if (preset.askBaseUrl) {
    while (!baseUrl) baseUrl = await ask("API base URL (e.g. https://api.groq.com/openai/v1)");
  }
  let model = "";
  while (!model) model = await ask("Model name", preset.model);

  let key = "";
  if (preset.needsKey) {
    if (preset.keyUrl) console.log(dim(`Get a key at ${preset.keyUrl}`));
    while (!key) key = await askSecret("Paste your API key (hidden)");
  }

  content = setVar(content, "LLM_PROVIDER", preset.id);
  content = setVar(content, "LLM_MODEL", model);
  content = setVar(content, "LLM_API_KEY", key);
  content = setVar(content, "LLM_BASE_URL", preset.id === "ollama" ? "" : baseUrl);
  content = setVar(content, "LLM_FALLBACK_MODELS", preset.fallback && preset.fallback !== model ? preset.fallback : "");

  const watch = await yes("Show the browser while the agent tests (recommended for demos)?", true);
  content = setVar(content, "AGENT_HEADLESS", watch ? "false" : "true");

  writeFileSync(ENV, content);
  console.log(green(`\n✓ Saved ${ENV}`) + dim(" (git-ignored)\n"));

  if (await yes("Install the Chromium browser the agent drives (one-time, ~150 MB)?", true)) {
    if (!run("npx playwright install chromium")) console.log("Chromium install failed; retry later with: npx playwright install chromium");
  }

  if (await yes("Check that the AI model works now?", true)) run("npm run llm:check");

  console.log(`\n${bold("Next:")}\n  npm run dev        start the sample app, mock Jira and orchestrator\n  npm run demo       (in a second terminal) send tickets to In Testing and watch the results\n`);
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
