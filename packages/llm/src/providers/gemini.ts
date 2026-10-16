import { postJson } from "../http.js";
import type { ChatRequest, ChatResponse, JsonSchema, LLMProvider, Message, ToolCall } from "../types.js";

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
  thoughtSignature?: string;
  thought?: boolean;
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export interface GeminiOptions {
  /** Retries on 429/5xx/network errors (default ~1 minute of backoff). */
  retries?: number;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/** Google Gemini via the Generative Language REST API (the same key you get from aistudio.google.com). */
export class GeminiProvider implements LLMProvider {
  readonly provider = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retries?: number;

  constructor(opts: GeminiOptions) {
    this.model = opts.model;
    this.retries = opts.retries;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toContents(req.messages, this.model),
      generationConfig: { maxOutputTokens: req.maxTokens ?? 4096 },
    };
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            // Gemini rejects OBJECT schemas with no properties, so no-arg tools omit `parameters`.
            ...(Object.keys(t.parameters.properties ?? {}).length ? { parameters: toGeminiSchema(t.parameters) } : {}),
          })),
        },
      ];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    const data = await postJson<GeminiResponse>({
      url: `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      headers: { "x-goog-api-key": this.apiKey },
      body,
      provider: this.provider,
      retries: this.retries,
    });

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const toolCalls: ToolCall[] = [];
    let text = "";
    parts.forEach((p, i) => {
      if (p.functionCall) {
        toolCalls.push({
          id: p.functionCall.id ?? `gemini-${Date.now()}-${i}`,
          name: p.functionCall.name,
          args: p.functionCall.args ?? {},
          // Remember which model signed it: signatures are only valid for the model that produced them.
          // (Parallel calls carry a signature only on the first part, so record the model either way.)
          meta: { signedBy: this.model, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) },
        });
      } else if (p.text && !p.thought) {
        text += p.text;
      }
    });

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      stopReason: candidate?.finishReason ?? data.promptFeedback?.blockReason,
    };
  }
}

/**
 * Placeholder Google documents for function calls the current model did not produce itself
 * (e.g. after falling back from another model mid-run). Without any signature Gemini 3 rejects
 * the request with HTTP 400.
 */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";

function toContents(messages: Message[], model: string): GeminiContent[] {
  const out: GeminiContent[] = [];
  const push = (role: GeminiContent["role"], part: GeminiPart) => {
    const last = out[out.length - 1];
    // Gemini wants turns to alternate; merge consecutive parts of the same role (e.g. several tool results).
    if (last && last.role === role) last.parts.push(part);
    else out.push({ role, parts: [part] });
  };

  for (const m of messages) {
    if (m.role === "user") push("user", { text: m.content });
    else if (m.role === "assistant") {
      if (m.content) push("model", { text: m.content });
      for (const c of m.toolCalls ?? []) {
        const part: GeminiPart = { functionCall: { name: c.name, args: c.args } };
        // Thought signatures must be echoed back or Gemini 3 rejects the follow-up request.
        if (c.meta?.signedBy === model) {
          if (typeof c.meta.thoughtSignature === "string") part.thoughtSignature = c.meta.thoughtSignature;
        } else {
          part.thoughtSignature = SKIP_SIGNATURE; // produced by another model or provider
        }
        push("model", part);
      }
      if (!m.content && !m.toolCalls?.length) push("model", { text: "(no response)" });
    } else {
      push("user", { functionResponse: { name: m.name, response: { result: m.content } } });
    }
  }
  return out;
}

/** Gemini's Schema uses upper-case OpenAPI type names. */
function toGeminiSchema(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: s.type.toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.required?.length) out.required = s.required;
  return out;
}
