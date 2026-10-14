import type { ChatRequest, ChatResponse, LLMProvider, Message, ToolCall } from "./types.js";

/**
 * Fallback for models without native tool calling (many small local models).
 * Tools are described in the system prompt, the model answers with a JSON
 * object, and we parse it back into a normal ToolCall. The agent can't tell
 * the difference. Enable with LLM_TOOL_MODE=json.
 */
export class JsonToolCallingProvider implements LLMProvider {
  readonly provider: string;
  readonly model: string;
  private counter = 0;

  constructor(private readonly inner: LLMProvider) {
    this.provider = `${inner.provider}+json-tools`;
    this.model = inner.model;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!req.tools?.length) return this.inner.chat(req);

    const toolDocs = req.tools
      .map((t) => `- ${t.name}: ${t.description}\n  args schema: ${JSON.stringify(t.parameters)}`)
      .join("\n");
    const system = `${req.system}

## How to call tools
You cannot call functions directly. To use a tool, reply with ONLY one JSON object and nothing else:
{"tool": "<tool name>", "args": { ... }}
Call exactly one tool per reply. Available tools:
${toolDocs}`;

    const res = await this.inner.chat({ system, messages: flatten(req.messages), maxTokens: req.maxTokens });
    const call = parseToolCall(res.text);
    if (!call) return res;
    const toolCall: ToolCall = { id: `json-${++this.counter}`, name: call.tool, args: call.args };
    return { ...res, text: "", toolCalls: [toolCall] };
  }
}

/** Rewrites tool-call history as plain text turns. */
function flatten(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const c = m.toolCalls[0];
      out.push({ role: "assistant", content: JSON.stringify({ tool: c.name, args: c.args }) });
    } else if (m.role === "tool") {
      out.push({ role: "user", content: `Result of ${m.name}:\n${m.content}` });
    } else out.push(m);
  }
  // Merge consecutive user turns (some servers require alternation).
  return out.reduce<Message[]>((acc, m) => {
    const last = acc[acc.length - 1];
    if (last && last.role === "user" && m.role === "user") last.content += `\n\n${m.content}`;
    else acc.push({ ...m });
    return acc;
  }, []);
}

/** Finds the first {"tool": ..., "args": ...} object in free text, tolerating ```json fences and chatter around it. */
export function parseToolCall(text: string): { tool: string; args: Record<string, unknown> } | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          const tool = obj.tool ?? obj.name ?? obj.function;
          if (typeof tool === "string") {
            const args = obj.args ?? obj.arguments ?? obj.parameters ?? {};
            return { tool, args: typeof args === "object" && args ? args : {} };
          }
        } catch {
          /* not JSON, keep scanning */
        }
        break;
      }
    }
  }
  return null;
}
