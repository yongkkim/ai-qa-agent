import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from "./types.js";

export type ScriptStep =
  | { tool: string; args?: Record<string, unknown> }
  | { text: string }
  | ((req: ChatRequest) => ScriptStep);

/**
 * A fake model that replays a fixed script. Used by the test suite so the
 * agent loop can be tested deterministically, without an API key or network.
 */
export class ScriptedProvider implements LLMProvider {
  readonly provider = "scripted";
  readonly model = "scripted";
  readonly requests: ChatRequest[] = [];
  private i = 0;

  constructor(private readonly script: ScriptStep[]) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(req));
    let step: ScriptStep = this.script[this.i++] ?? { text: "(script exhausted)" };
    while (typeof step === "function") step = step(req);
    const usage = { inputTokens: 10, outputTokens: 5 };
    if ("text" in step) return { text: step.text, toolCalls: [], usage };
    const call: ToolCall = { id: `call-${this.i}`, name: step.tool, args: step.args ?? {} };
    return { text: "", toolCalls: [call], usage };
  }
}
