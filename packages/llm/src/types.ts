/**
 * The one interface the agent talks to. Every provider adapter translates
 * this neutral shape to and from its own wire format, so the agent never
 * knows (or cares) which model is behind it.
 */

/** JSON-Schema subset that every provider understands (object/string/number/integer/boolean/array/enum). */
export interface JsonSchema {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Opaque provider data that must be sent back verbatim (e.g. Gemini thought signatures). */
  meta?: Record<string, unknown>;
}

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Why generation stopped, as reported by the provider (for debugging). */
  stopReason?: string;
}

export interface LLMProvider {
  /** e.g. "gemini", "openai", "anthropic", "ollama" */
  readonly provider: string;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

/** Thrown for problems the user can fix (missing key, wrong model name...). The message is meant to be shown as-is. */
export class LLMConfigError extends Error {
  override name = "LLMConfigError";
}

export class LLMRequestError extends Error {
  override name = "LLMRequestError";
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}
