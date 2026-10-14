import { JIRA_API_TOKEN, JIRA_BASE_URL, JIRA_EMAIL } from "./env.js";

/** The subset of Jira's issue shape the orchestrator relies on. */
export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: string;
    issuetype: { name: string };
    status: { name: string };
    labels: string[];
  };
}

interface Transition {
  id: string;
  name: string;
  to: { name: string };
}

/**
 * Minimal Jira REST v3 client. Works against the mock out of the box; pointing
 * JIRA_BASE_URL at https://<site>.atlassian.net and setting JIRA_EMAIL +
 * JIRA_API_TOKEN is the path to a real site (real Jira would additionally
 * need description/comment bodies converted to ADF).
 */
export class JiraClient {
  constructor(
    private readonly baseUrl = JIRA_BASE_URL,
    private readonly actor = "AI QA Agent",
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Actor": this.actor,
    };
    if (JIRA_EMAIL && JIRA_API_TOKEN) {
      headers.Authorization = `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")}`;
    }
    const res = await fetch(`${this.baseUrl}/rest/api/3${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new Error(`Jira ${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  getIssue(key: string) {
    return this.request<JiraIssue>(`/issue/${encodeURIComponent(key)}`);
  }

  addComment(key: string, body: string) {
    return this.request(`/issue/${encodeURIComponent(key)}/comment`, { method: "POST", body: JSON.stringify({ body }) });
  }

  /** Move an issue to a status by name, looking up the transition id like a real Jira client must. */
  async transitionTo(key: string, statusName: string) {
    const { transitions } = await this.request<{ transitions: Transition[] }>(`/issue/${encodeURIComponent(key)}/transitions`);
    const t = transitions.find((x) => x.to.name.toLowerCase() === statusName.toLowerCase());
    if (!t) throw new Error(`No transition from ${key} to "${statusName}"`);
    await this.request(`/issue/${encodeURIComponent(key)}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) });
  }

  createIssue(fields: { summary: string; description: string; issuetype: string; labels?: string[] }) {
    return this.request<{ id: string; key: string }>(`/issue`, {
      method: "POST",
      body: JSON.stringify({
        fields: { summary: fields.summary, description: fields.description, issuetype: { name: fields.issuetype }, labels: fields.labels ?? [] },
      }),
    });
  }
}
