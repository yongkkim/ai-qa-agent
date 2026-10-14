/**
 * `npm run llm:check` — verifies the configured model end to end:
 *   1. the .env settings are valid
 *   2. the API key works (a plain chat request)
 *   3. the model can call tools (the agent depends on this)
 */
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider, readLLMConfig } from "./factory.js";
import { LLMConfigError } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

async function main() {
  console.log("\nChecking LLM configuration…\n");
  let cfg;
  try {
    cfg = readLLMConfig();
  } catch (err) {
    bad((err as Error).message);
    process.exit(1);
  }
  ok(`provider=${cfg.provider} model=${cfg.model}${cfg.baseUrl ? ` baseUrl=${cfg.baseUrl}` : ""} toolMode=${cfg.toolMode}`);
  const llm = createProvider(cfg);

  const t0 = Date.now();
  const hello = await llm.chat({
    system: "You are a connectivity check. Follow instructions exactly.",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    maxTokens: 2048,
  });
  ok(`API key works — model replied "${hello.text.trim().slice(0, 40)}" in ${Date.now() - t0} ms`);

  const t1 = Date.now();
  const tool = await llm.chat({
    system: "You are a connectivity check. Always use the provided tool.",
    messages: [{ role: "user", content: "Click the element with ref e7 by calling the click tool." }],
    tools: [
      {
        name: "click",
        description: "Click an element on the page.",
        parameters: { type: "object", properties: { ref: { type: "string", description: "Element ref like e3" } }, required: ["ref"] },
      },
    ],
    maxTokens: 2048,
  });
  const call = tool.toolCalls[0];
  if (call?.name === "click" && String(call.args.ref) === "e7") {
    ok(`tool calling works — got click({ref: "e7"}) in ${Date.now() - t1} ms`);
  } else {
    bad(`tool calling did not work as expected (got ${call ? `${call.name}(${JSON.stringify(call.args)})` : `text: "${tool.text.slice(0, 80)}"`}).`);
    console.log("    If this model has no native tool calling, try LLM_TOOL_MODE=json in .env.");
    process.exit(1);
  }
  console.log("\nAll good — the agent can use this model.\n");
}

main().catch((err) => {
  bad(err instanceof LLMConfigError ? err.message : `Request failed: ${(err as Error).message}`);
  process.exit(1);
});
