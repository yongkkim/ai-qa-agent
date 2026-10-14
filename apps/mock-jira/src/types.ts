/**
 * A deliberately small subset of the Jira Cloud REST v3 issue shape.
 * Field names match Jira so the orchestrator's client can later point at a
 * real Jira site. Simplification: `description` and comment `body` are plain
 * text / markdown instead of Atlassian Document Format (ADF).
 */

export type StatusName = "To Do" | "In Progress" | "In Testing" | "Done";

export interface Status {
  id: string;
  name: StatusName;
  statusCategory: { key: "new" | "indeterminate" | "done"; name: string };
}

export interface Comment {
  id: string;
  author: { displayName: string };
  body: string;
  created: string;
}

export interface Issue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: string;
    issuetype: { name: "Story" | "Bug" | "Task" };
    status: Status;
    priority: { name: "High" | "Medium" | "Low" };
    labels: string[];
    created: string;
    updated: string;
    comment: { comments: Comment[]; total: number };
  };
}

export interface Transition {
  id: string;
  name: string;
  to: Status;
}

export interface Db {
  nextIssueNumber: number;
  nextId: number;
  issues: Issue[];
}

export interface ChangelogItem {
  field: string;
  fieldtype: "jira";
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface WebhookPayload {
  timestamp: number;
  webhookEvent: "jira:issue_created" | "jira:issue_updated";
  issue_event_type_name?: string;
  user: { displayName: string };
  issue: Issue;
  changelog?: { id: string; items: ChangelogItem[] };
}
