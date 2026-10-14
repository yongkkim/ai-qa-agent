# AI QA Agent

An AI agent that does the manual QA pass for you: when a Jira ticket moves to **In Testing**, the agent reads the ticket's acceptance criteria, opens the web app in a real browser, explores and verifies each criterion itself, and reports the verdict (with evidence) back on the ticket.

- **No pre-written test scripts.** The agent decides what to click and type by observing the page, the way a human tester would. (Playwright is only used as the agent's "hands" to drive the browser.)
- **Model-agnostic.** Plug in whichever LLM you have: OpenAI, Anthropic, or any OpenAI-compatible endpoint (Ollama, LM Studio, Groq...).
- **Jira-shaped.** Ships with a mock Jira whose REST API and webhooks follow Jira Cloud's shapes, so the orchestrator can later point at a real site.

> Status: **Day 1 of 3 — trigger loop complete.** The AI browser agent lands next. See [Roadmap](#roadmap).

## How it works

```
 ┌──────────────┐  drag ticket to     ┌──────────────┐   webhook            ┌──────────────┐
 │  Mock Jira   │  "In Testing"  ───► │  Mock Jira   │ ───────────────────► │ Orchestrator │
 │  board (UI)  │                     │   REST API   │  jira:issue_updated  │  (queue)     │
 └──────────────┘                     └──────▲───────┘                      └──────┬───────┘
                                             │ comment + status                    │ run
                                             │ (verdict, evidence)          ┌──────▼───────┐
                                             └──────────────────────────────┤  AI QA agent │
                                                                            │  LLM + browser├──► Sample app
                                                                            └──────────────┘    (under test)
```

| Piece | Path | What it does |
|---|---|---|
| Sample app | `apps/sample-app` | The web app under test: a small React Todo app with **intentionally planted, toggleable bugs** so the agent can prove it catches regressions. |
| Mock Jira | `apps/mock-jira` | Kanban board UI + a subset of the Jira Cloud REST v3 API (search, issue, transitions, comments, create) + Jira-style webhooks on status change. |
| Orchestrator | `apps/orchestrator` | Receives the webhook, queues one run per ticket (deduped, serial), fetches the ticket, runs the agent, writes results back to Jira. |
| Agent | `packages/agent` | _(Day 2)_ LLM provider adapters + the observe → decide → act browser loop. |

## Quick start

Requirements: Node.js 20+.

```bash
git clone https://github.com/yongkkim/ai-qa-agent.git
cd ai-qa-agent
npm install
cp .env.example .env        # optional for now; every value has a default (Windows cmd: copy .env.example .env)
npm run dev                 # starts sample app, mock Jira and orchestrator
```

| URL | |
|---|---|
| http://localhost:4000 | Mock Jira board |
| http://localhost:5173 | Sample app (the app under test) |
| http://localhost:4100/runs | Orchestrator run history (JSON) |

Then on the board, drag **QA-101** into **In Testing**. Within a couple of seconds the orchestrator picks it up and the agent's comment appears on the ticket.

### Planted bugs

`npm run dev:buggy` starts the sample app with bugs switched on (see `apps/sample-app/.env.buggy` and `src/bugs.ts`):

| Bug id | Ticket | Effect |
|---|---|---|
| `empty-input` | QA-101 | Whitespace-only text is accepted as a todo |
| `filter-active` | QA-102 | The "Active" filter also shows completed todos |
| `counter` | QA-103 | "items left" counts all todos instead of active ones |

The bugs are never shown in the UI (only logged to the browser console), so the agent can't read the answer off the page.

### Other scripts

```bash
npm run jira:reset   # restore the seed tickets
npm run typecheck    # type-check every workspace
```

## Design notes

- **Mock Jira mirrors real Jira** where it matters to the integration: issue JSON shape, `GET /rest/api/3/search?jql=`, transitions by id (looked up by target status name, as a real client must), comments, and a `jira:issue_updated` webhook carrying a `changelog` with the status change. Simplification: descriptions and comments are plain text/markdown rather than Atlassian Document Format.
- **One run at a time, deduped.** Duplicate webhooks for a ticket that is already queued or running are ignored, so re-dragging a card doesn't stack runs.
- **Acceptance criteria are the test oracle.** The agent tests against the numbered list under "Acceptance Criteria" in the ticket, and reports a verdict per criterion.

## Roadmap

- [x] **Day 1** — Monorepo, sample app with planted bugs, mock Jira (API, board, webhooks), orchestrator trigger loop
- [ ] **Day 2** — Model-agnostic LLM layer; AI browser agent (accessibility-tree observation, tool-based actions, step limits)
- [ ] **Day 3** — Per-criterion verdicts with screenshot evidence, ticket transitions (Done / back to In Progress), bug tickets on failure, hardening
- [ ] **Day 4 (stretch)** — HTML run report, export the agent's steps as a replayable Playwright test, demo video
