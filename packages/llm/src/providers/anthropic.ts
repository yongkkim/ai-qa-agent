import { postJson } from "../http.js";
import type { ChatRequest, ChatResponse, LLMProvider, Message, ToolCall } from "../types.js";

type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
type Block =
  | { type: "text"; text: string }
  | ImageBlock
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | ({ type: "text"; text: string } | ImageBlock)[] };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}
interface AnthropicResponse {
  content?: Block[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicOptions {
  /** Retries on 429/5xx/network errors (default ~1 minute of backoff). */
  retries?: number;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** The model reads images (Claude models are multimodal; default true). */
  vision?: boolean;
}

/** Anthropic Claude via the Messages API. */
export class AnthropicProvider implements LLMProvider {
  readonly provider = "anthropic";
  readonly model: string;
  readonly vision: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retries?: number;

  constructor(opts: AnthropicOptions) {
    this.model = opts.model;
    this.vision = opts.vision ?? true;
    this.retries = opts.retries;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      messages: toMessages(req.messages),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    const data = await postJson<AnthropicResponse>({
      url: `${this.baseUrl}/messages`,
      headers: { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      body,
      provider: this.provider,
      retries: this.retries,
    });

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const b of data.content ?? []) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
    }
    return {
      text,
      toolCalls,
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 },
      stopReason: data.stop_reason,
    };
  }
}

const imageBlock = (img: { mimeType: string; data: string }): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: img.mimeType, data: img.data },
});

function toMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], block: Block) => {
    const last = out[out.length - 1];
    // Tool results go in a user turn; consecutive results are merged into one turn.
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === "user") {
      push("user", { type: "text", text: m.content });
      for (const img of m.images ?? []) push("user", imageBlock(img));
    }
    else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (!m.content && !m.toolCalls?.length) push("assistant", { type: "text", text: "(no response)" });
    } else {
      const content = m.images?.length ? [{ type: "text" as const, text: m.content }, ...m.images.map(imageBlock)] : m.content;
      push("user", { type: "tool_result", tool_use_id: m.toolCallId, content });
    }
  }
  return out;
}
