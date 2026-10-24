import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProvider,
  FallbackProvider,
  LLMRequestError,
  JsonToolCallingProvider,
  LLMConfigError,
  parseToolCall,
  readLLMConfig,
  ScriptedProvider,
} from "../src/index.js";

describe("readLLMConfig", () => {
  it("explains what is missing", () => {
    assert.throws(() => readLLMConfig({}), (e: Error) => e instanceof LLMConfigError && /LLM_PROVIDER is not set.*npm run setup/.test(e.message));
    assert.throws(() => readLLMConfig({ LLM_PROVIDER: "gpt" }), /not supported/);
    assert.throws(() => readLLMConfig({ LLM_PROVIDER: "gemini" }), /LLM_API_KEY is empty/);
    assert.throws(() => readLLMConfig({ LLM_PROVIDER: "openai", LLM_API_KEY: "k" }), /LLM_MODEL is required/);
    assert.throws(() => readLLMConfig({ LLM_PROVIDER: "openai-compatible", LLM_MODEL: "m" }), /LLM_BASE_URL is required/);
  });

  it("applies defaults and provider-specific key variables", () => {
    const gemini = readLLMConfig({ LLM_PROVIDER: "Gemini", GEMINI_API_KEY: "g" });
    assert.equal(gemini.provider, "gemini");
    assert.equal(gemini.apiKey, "g");
    assert.ok(gemini.model.startsWith("gemini-"));

    const ollama = readLLMConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "qwen3" });
    assert.equal(ollama.baseUrl, "http://localhost:11434/v1");
    assert.equal(ollama.apiKey, undefined, "local models need no key");
  });

  it("wraps the provider for JSON tool mode", () => {
    const p = createProvider(readLLMConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "tiny", LLM_TOOL_MODE: "json" }));
    assert.ok(p instanceof JsonToolCallingProvider);
    assert.equal(p.provider, "ollama+json-tools");
  });
});

describe("LLM_VISION", () => {
  it("defaults to true for hosted multimodal providers and false for local or compatible ones", () => {
    assert.equal(readLLMConfig({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k" }).vision, true);
    assert.equal(readLLMConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "tiny" }).vision, false);
    assert.equal(readLLMConfig({ LLM_PROVIDER: "ollama", LLM_MODEL: "llava", LLM_VISION: "true" }).vision, true);
    assert.equal(createProvider(readLLMConfig({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k", LLM_VISION: "false" })).vision, false);
    assert.throws(() => readLLMConfig({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k", LLM_VISION: "maybe" }), /LLM_VISION/);
  });
});

describe("fallback models", () => {
  it("builds a fallback chain from LLM_FALLBACK_MODELS (skipping the main model)", () => {
    const cfg = readLLMConfig({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k", LLM_MODEL: "big", LLM_FALLBACK_MODELS: "small, big ,tiny", LLM_MAX_RETRIES: "2" });
    assert.deepEqual(cfg.fallbackModels, ["small", "tiny"]);
    assert.equal(cfg.maxRetries, 2);
    const p = createProvider(cfg);
    assert.ok(p instanceof FallbackProvider);
    assert.equal(p.model, "big");
    assert.throws(() => readLLMConfig({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k", LLM_MAX_RETRIES: "lots" }), /LLM_MAX_RETRIES/);
  });

  const failing = (model: string, err: Error) => ({ provider: "fake", model, chat: async () => Promise.reject(err) });

  it("switches to the next model when one is overloaded, and stays there", async () => {
    const backup = new ScriptedProvider([{ text: "from backup" }, { text: "still backup" }]);
    const switches: string[] = [];
    const p = new FallbackProvider([failing("big", new LLMRequestError("[fake] HTTP 503", 503, true)), backup], (from, to) =>
      switches.push(`${from.model}->${to.model}`),
    );
    const req = { system: "s", messages: [{ role: "user" as const, content: "x" }] };
    assert.equal((await p.chat(req)).text, "from backup");
    assert.equal((await p.chat(req)).text, "still backup");
    assert.deepEqual(switches, ["big->scripted"]);
    assert.deepEqual(p.modelsUsed, ["big", "scripted"]);
  });

  it("does not hide errors a human must fix (e.g. a bad key)", async () => {
    const backup = new ScriptedProvider([{ text: "never" }]);
    const p = new FallbackProvider([failing("big", new LLMRequestError("[fake] HTTP 401", 401, false)), backup], () => {});
    await assert.rejects(p.chat({ system: "s", messages: [{ role: "user", content: "x" }] }), /401/);
    assert.equal(backup.requests.length, 0);
  });

  it("gives up with the last error when every model is unavailable", async () => {
    const p = new FallbackProvider(
      [failing("a", new LLMRequestError("[fake] HTTP 503 a", 503, true)), failing("b", new LLMRequestError("[fake] HTTP 503 b", 503, true))],
      () => {},
    );
    await assert.rejects(p.chat({ system: "s", messages: [{ role: "user", content: "x" }] }), /503 b/);
  });
});

describe("JSON tool-calling fallback", () => {
  it("parses a tool call out of chatty text and code fences", () => {
    assert.deepEqual(parseToolCall('Sure!\n```json\n{"tool": "click", "args": {"ref": "e3"}}\n```'), { tool: "click", args: { ref: "e3" } });
    assert.deepEqual(parseToolCall('{"name":"type","arguments":{"text":"a } b"}}'), { tool: "type", args: { text: "a } b" } });
    assert.equal(parseToolCall("no json here"), null);
  });

  it("turns a model's JSON reply into a normal tool call and replays history as text", async () => {
    const inner = new ScriptedProvider([{ text: 'I will click. {"tool":"click","args":{"ref":"e1"}}' }]);
    const p = new JsonToolCallingProvider(inner);
    const res = await p.chat({
      system: "sys",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "reload", args: {} }] },
        { role: "tool", toolCallId: "1", name: "reload", content: "OK" },
      ],
      tools: [{ name: "click", description: "Click", parameters: { type: "object", properties: { ref: { type: "string" } } } }],
    });
    assert.equal(res.toolCalls[0].name, "click");
    assert.deepEqual(res.toolCalls[0].args, { ref: "e1" });
    const sent = inner.requests[0];
    assert.match(sent.system, /reply with ONLY one JSON object/);
    assert.equal(sent.tools, undefined);
    assert.deepEqual(sent.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.match(sent.messages[2].role === "user" ? sent.messages[2].content : "", /Result of reload/);
  });
});
