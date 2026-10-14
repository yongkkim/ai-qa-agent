/**
 * Intentionally planted bugs, toggled with the VITE_BUGS env var
 * (comma-separated). They exist so the AI QA agent can prove it catches
 * real regressions, not just confirm happy paths.
 *
 *  - empty-input   (QA-101) whitespace-only text is accepted as a todo
 *  - filter-active (QA-102) the "Active" filter also shows completed todos
 *  - counter       (QA-103) "items left" counts every todo, not just active ones
 */
export type BugId = "empty-input" | "filter-active" | "counter";

const enabled = new Set(
  String(import.meta.env.VITE_BUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const hasBug = (id: BugId): boolean => enabled.has(id);
export const enabledBugs = (): string[] => [...enabled];
