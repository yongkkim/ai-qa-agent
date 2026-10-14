import type { Status, StatusName, Transition } from "./types.js";

export const STATUSES: Record<StatusName, Status> = {
  "To Do": { id: "1", name: "To Do", statusCategory: { key: "new", name: "To Do" } },
  "In Progress": { id: "3", name: "In Progress", statusCategory: { key: "indeterminate", name: "In Progress" } },
  "In Testing": { id: "10001", name: "In Testing", statusCategory: { key: "indeterminate", name: "In Progress" } },
  Done: { id: "10002", name: "Done", statusCategory: { key: "done", name: "Done" } },
};

export const STATUS_ORDER: StatusName[] = ["To Do", "In Progress", "In Testing", "Done"];

/** A global workflow: any status can move to any other status, like a simple Jira team-managed board. */
export const TRANSITIONS: Transition[] = [
  { id: "11", name: "To Do", to: STATUSES["To Do"] },
  { id: "21", name: "In Progress", to: STATUSES["In Progress"] },
  { id: "31", name: "Ready for Testing", to: STATUSES["In Testing"] },
  { id: "41", name: "Done", to: STATUSES["Done"] },
];

export function transitionsFrom(current: StatusName): Transition[] {
  return TRANSITIONS.filter((t) => t.to.name !== current);
}
