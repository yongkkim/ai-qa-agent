import { postJson } from "../http.js";
import type { ChatRequest, ChatResponse, LLMProvider, Message, ToolCall } from "../types.js";

interface OAToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OAMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OAToolCall[];
  tool_call_id?: string;
}
interface OAResponse {
  choices?: { message?: OAMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAIOptions {
  apiKey?: string;
  model: string;
  /** Any OpenAI-compatible server: OpenAI, Ollama (http://localhost:11434/v1), LM Studio, Groq, OpenRouter, vLLM... */
  baseUrl?: string;
  /** Label used in logs and reports. */
  providerName?: string;
}

/**
 * OpenAI Chat Completions format. Because so many servers speak this
 * dialect, this one adapter covers OpenAI, Ollama, LM Studio, Groq,
 * OpenRouter, Together, vLLM and more.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly provider: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(opts: OpenAIOptions) {
    this.provider = opts.providerName ?? "openai";
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const isOpenAI = this.baseUrl.includes("api.openai.com");
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toMessages(req.system, req.messages),
      // OpenAI's newer models only accept max_completion_tokens; most compatible servers still use max_tokens.
      [isOpenAI ? "max_completion_tokens" : "max_tokens"]: req.maxTokens ?? 4096,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const data = await postJson<OAResponse>({
      url: `${this.baseUrl}/chat/completions`,
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      body,
      provider: this.provider,
    });

    const choice = data.choices?.[0];
    const msg = choice?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      args: parseArgs(c.function.arguments),
    }));
    return {
      text: msg?.content ?? "",
      toolCalls,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      stopReason: choice?.finish_reason,
    };
  }
}

function toMessages(system: string, messages: Message[]): OAMessage[] {
  const out: OAMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
    } else out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return { __invalid_json: raw };
  }
}
