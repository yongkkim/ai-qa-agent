import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, type ChatRequest, type Message, type ToolDefinition } from "../src/index.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: any;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace fetch with a fake that records the request and returns `responses` in order. */
function mockFetch(...responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return calls;
}

const clickTool: ToolDefinition = {
  name: "click",
  description: "Click",
  parameters: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
};
const reloadTool: ToolDefinition = { name: "reload", description: "Reload", parameters: { type: "object", properties: {} } };

/** A conversation containing a previous tool call and its result. */
const history: Message[] = [
  { role: "user", content: "Test AC1" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "click", args: { ref: "e2" }, meta: { thoughtSignature: "sig-abc", signedBy: "gemini-test" } }] },
  { role: "tool", toolCallId: "c1", name: "click", content: "OK: clicked" },
];
const req: ChatRequest = { system: "You are QA", messages: history, tools: [clickTool, reloadTool] };

describe("GeminiProvider", () => {
  it("maps messages, tools and thought signatures to the Gemini format", async () => {
    const calls = mockFetch({
      json: {
        candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "click", args: { ref: "e5" } }, thoughtSignature: "sig-xyz" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 7 },
      },
    });
    const res = await new GeminiProvider({ apiKey: "k", model: "gemini-test" }).chat(req);

    const { url, headers, body } = calls[0];
    assert.match(url, /models\/gemini-test:generateContent$/);
    assert.equal(headers["x-goog-api-key"], "k");
    assert.equal(body.systemInstruction.parts[0].text, "You are QA");
    assert.deepEqual(body.contents.map((c: any) => c.role), ["user", "model", "user"]);
    // The thought signature from the previous turn is sent back.
    assert.equal(body.contents[1].parts[0].thoughtSignature, "sig-abc");
    assert.deepEqual(body.contents[2].parts[0].functionResponse, { name: "click", response: { result: "OK: clicked" } });
    const decls = body.tools[0].functionDeclarations;
    assert.equal(decls[0].parameters.type, "OBJECT");
    assert.equal(decls[0].parameters.properties.ref.type, "STRING");
    assert.equal(decls[1].parameters, undefined, "no-arg tools omit parameters");

    assert.equal(res.toolCalls[0].name, "click");
    assert.deepEqual(res.toolCalls[0].args, { ref: "e5" });
    assert.equal(res.toolCalls[0].meta?.thoughtSignature, "sig-xyz");
    assert.deepEqual(res.usage, { inputTokens: 120, outputTokens: 7 });
  });

  it("uses a placeholder signature for calls another model or provider made (after a fallback)", async () => {
    const calls = mockFetch({ json: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] } });
    const foreign: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "click", args: {}, meta: { thoughtSignature: "sig-other", signedBy: "gemini-big" } }] },
      { role: "tool", toolCallId: "a", name: "click", content: "OK" },
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "reload", args: {} }] },
      { role: "tool", toolCallId: "b", name: "reload", content: "OK" },
    ];
    await new GeminiProvider({ apiKey: "k", model: "gemini-small" }).chat({ system: "s", messages: foreign });
    const modelTurns = calls[0].body.contents.filter((c: any) => c.role === "model");
    assert.deepEqual(
      modelTurns.map((c: any) => c.parts[0].thoughtSignature),
      ["skip_thought_signature_validator", "skip_thought_signature_validator"],
    );
  });

  it("ignores thought parts in the text", async () => {
    mockFetch({ json: { candidates: [{ content: { role: "model", parts: [{ text: "thinking...", thought: true }, { text: "OK" }] } }] } });
    const res = await new GeminiProvider({ apiKey: "k", model: "m" }).chat({ system: "s", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "OK");
  });
});

describe("OpenAICompatibleProvider", () => {
  it("maps to Chat Completions and parses tool calls", async () => {
    const calls = mockFetch({
      json: {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "t9", type: "function", function: { name: "click", arguments: '{"ref":"e3"}' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 50, completion_tokens: 4 },
      },
    });
    const res = await new OpenAICompatibleProvider({ apiKey: "sk", model: "gpt-test" }).chat(req);
    const { url, headers, body } = calls[0];
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(headers.Authorization, "Bearer sk");
    assert.equal(body.max_completion_tokens, 4096);
    assert.deepEqual(body.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"ref":"e2"}');
    assert.equal(body.messages[3].tool_call_id, "c1");
    assert.equal(body.tools[0].type, "function");
    assert.deepEqual(res.toolCalls, [{ id: "t9", name: "click", args: { ref: "e3" } }]);
  });

  it("works keyless against a local server such as Ollama", async () => {
    const calls = mockFetch({ json: { choices: [{ message: { role: "assistant", content: "hi" } }] } });
    const p = new OpenAICompatibleProvider({ model: "qwen3", baseUrl: "http://localhost:11434/v1/", providerName: "ollama" });
    const res = await p.chat({ system: "s", messages: [{ role: "user", content: "hi" }] });
    assert.equal(calls[0].url, "http://localhost:11434/v1/chat/completions");
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].body.max_tokens, 4096);
    assert.equal(res.text, "hi");
    assert.equal(p.provider, "ollama");
  });
});

describe("AnthropicProvider", () => {
  it("maps to the Messages API with tool_use / tool_result blocks", async () => {
    const calls = mockFetch({
      json: {
        content: [
          { type: "text", text: "Clicking Add." },
          { type: "tool_use", id: "tu1", name: "click", input: { ref: "e2" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 80, output_tokens: 12 },
      },
    });
    const res = await new AnthropicProvider({ apiKey: "ak", model: "claude-test" }).chat(req);
    const { url, headers, body } = calls[0];
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(headers["x-api-key"], "ak");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(body.system, "You are QA");
    assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
    assert.equal(body.messages[1].content[0].type, "tool_use");
    assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "c1", content: "OK: clicked" });
    assert.equal(body.tools[0].input_schema.type, "object");
    assert.equal(res.text, "Clicking Add.");
    assert.deepEqual(res.toolCalls, [{ id: "tu1", name: "click", args: { ref: "e2" } }]);
  });
});

describe("HTTP handling", () => {
  it("retries rate limits, then succeeds", async () => {
    const calls = mockFetch(
      { status: 429, json: { error: "slow down" }, headers: { "retry-after": "0.01" } },
      { json: { choices: [{ message: { role: "assistant", content: "ok" } }] } },
    );
    const res = await new OpenAICompatibleProvider({ apiKey: "k", model: "m" }).chat({ system: "s", messages: [{ role: "user", content: "x" }] });
    assert.equal(calls.length, 2);
    assert.equal(res.text, "ok");
  });

  it("explains an overloaded provider (503) after retrying", async () => {
    const calls = mockFetch({ status: 503, json: { error: { message: "high demand" } }, headers: { "retry-after": "0.01" } });
    await assert.rejects(
      new GeminiProvider({ apiKey: "k", model: "m", retries: 2 }).chat({ system: "s", messages: [{ role: "user", content: "x" }] }),
      (e: any) => e.retryable === true && e.status === 503 && /overloaded or temporarily unavailable.*\(after 3 attempts\)/.test(e.message),
    );
    assert.equal(calls.length, 3);
  });

  it("explains auth errors without retrying", async () => {
    const calls = mockFetch({ status: 401, json: { error: "bad key" } });
    await assert.rejects(
      new AnthropicProvider({ apiKey: "bad", model: "m" }).chat({ system: "s", messages: [{ role: "user", content: "x" }] }),
      /HTTP 401: the API key is missing, invalid/,
    );
    assert.equal(calls.length, 1);
  });
});
