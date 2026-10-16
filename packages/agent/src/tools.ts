import type { ToolDefinition } from "@ai-qa/llm";

const ref = { type: "string" as const, description: 'Element ref from the latest snapshot, e.g. "e4" (without brackets).' };

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "click",
    description: "Click an element (button, link, checkbox...).",
    parameters: { type: "object", properties: { ref }, required: ["ref"] },
  },
  {
    name: "type",
    description:
      "Clear a text field and type into it like a user. Set submit=true to press Enter afterwards. Set repeat_to_length to repeat `text` until it is exactly that many characters long (use this for length limits).",
    parameters: {
      type: "object",
      properties: {
        ref,
        text: { type: "string", description: "Text to type. May be empty or whitespace to test validation." },
        submit: { type: "boolean", description: "Press Enter after typing." },
        repeat_to_length: { type: "integer", description: "Optional exact length of the typed text." },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "press_key",
    description: 'Press a keyboard key on the focused element, e.g. "Enter", "Tab", "Escape", "Backspace".',
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "select_option",
    description: "Choose an option in a dropdown (combobox) by its visible label.",
    parameters: { type: "object", properties: { ref, value: { type: "string" } }, required: ["ref", "value"] },
  },
  {
    name: "navigate",
    description: "Open a URL inside the app under test.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "reload",
    description: "Reload the current page (e.g. to check that data persists).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "plan_test",
    description:
      "Before testing a criterion, declare how you will test it and the exact text the page must show if the feature works (the test oracle). " +
      "Choose a setup where a broken implementation would show something different from a working one. A PASS is only accepted if the page shows expected_text when you record it.",
    parameters: {
      type: "object",
      properties: {
        criterion: { type: "string", description: 'Criterion id, e.g. "AC3".' },
        how_to_test: { type: "string", description: "Setup and steps, e.g. 'Add 3 todos, complete 1, read the footer'." },
        expected_text: { type: "string", description: 'Exact text that must be on the page if it works, e.g. "2 items left" or "Todo cannot be empty."' },
        must_not_appear: { type: "string", description: "Optional text that must NOT be on the page if it works (e.g. a todo that should have been removed)." },
      },
      required: ["criterion", "how_to_test", "expected_text"],
    },
  },
  {
    name: "record_result",
    description:
      "Record your verdict for one acceptance criterion, with evidence, while the result is still on screen. Requires plan_test first. A screenshot is captured automatically.",
    parameters: {
      type: "object",
      properties: {
        criterion: { type: "string", description: 'Criterion id, e.g. "AC3".' },
        status: { type: "string", enum: ["pass", "fail", "blocked"] },
        observed_text: { type: "string", description: "Exact text copied from a page snapshot that supports the verdict." },
        expected: { type: "string", description: "What the AC says should happen." },
        actual: { type: "string", description: "What actually happened." },
        steps_to_reproduce: { type: "string", description: "Short numbered steps (required for fail)." },
        notes: { type: "string", description: "Anything else worth knowing (required for blocked)." },
        same_defect_as: {
          type: "string",
          description:
            'For a fail caused by the same underlying defect as an earlier failed criterion (the same wrong behaviour), that criterion\'s id, e.g. "AC1". Leave empty for a new, separate defect.',
        },
      },
      required: ["criterion", "status", "observed_text"],
    },
  },
  {
    name: "finish",
    description: "End the test session once every criterion has a verdict.",
    parameters: { type: "object", properties: { summary: { type: "string", description: "Two or three sentence summary." } }, required: ["summary"] },
  },
];
