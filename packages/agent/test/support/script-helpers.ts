import type { ChatRequest, ScriptStep } from "@ai-qa/llm";
import { PAGE_MARKER } from "../../src/prompts.js";

/** The newest page snapshot the model was shown in this request. */
export function latestPage(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if ((m.role === "user" || m.role === "tool") && m.content.includes(PAGE_MARKER)) {
      return m.content.slice(m.content.indexOf(PAGE_MARKER) + PAGE_MARKER.length);
    }
  }
  throw new Error("no page snapshot in request");
}

/** The last tool result text the model received. */
export function lastToolResult(req: ChatRequest): string {
  const m = [...req.messages].reverse().find((x) => x.role === "tool");
  return m?.role === "tool" ? m.content : "";
}

/** Ref of the first element whose snapshot line matches, e.g. ref(page, 'textbox "New todo"'). */
export function ref(page: string, linePattern: string | RegExp): string {
  const re = typeof linePattern === "string" ? new RegExp(`\\[(e\\d+)\\] ${escape(linePattern)}`) : linePattern;
  const m = page.match(re);
  if (!m) throw new Error(`no element matching ${re} in:\n${page}`);
  return m[1];
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A tool step whose args are computed from the latest page the model saw. */
export function onPage(tool: string, args: (page: string, req: ChatRequest) => Record<string, unknown>): ScriptStep {
  return (req) => ({ tool, args: args(latestPage(req), req) });
}

export const addTodo = (text: string): ScriptStep =>
  onPage("type", (p) => ({ ref: ref(p, 'textbox "New todo"'), text, submit: true }));

/** plan_test step: declare the oracle for a criterion. */
export const plan = (criterion: string, expected_text: string, must_not_appear?: string): ScriptStep => ({
  tool: "plan_test",
  args: { criterion, how_to_test: "scripted", expected_text, ...(must_not_appear ? { must_not_appear } : {}) },
});
