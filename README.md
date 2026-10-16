# AI QA Agent

An AI agent that does the manual QA pass for you. When a Jira ticket moves to **In Testing**, the agent reads the ticket's acceptance criteria, opens the web app in a real browser, works out how to test each criterion, clicks and types its way through the app, and posts a verdict per criterion back on the ticket with evidence. If something fails, it files a bug and sends the ticket back to the developer.

- **No pre-written test scripts.** There is no Cypress/Playwright spec per feature. The model looks at the page and decides every action itself, the way a human tester would. Playwright is only its hands.
- **Bring your own model.** Gemini, OpenAI, Anthropic, a local Ollama model, or any OpenAI-compatible API. Switch with one line in `.env`.
- **Built to be trusted, not just demoed.** Verdicts must quote text that was really on the page, the final result is computed in code (not taken from the model), and every run leaves screenshots and a JSON report.
- **Jira-shaped.** Ships with a mock Jira whose REST API and webhooks follow Jira Cloud's shapes, so no Jira account is needed to try it.

## What it looks like

```
QA-101  Add a todo with input validation          →  drag to "In Testing"

🤖 AI QA result: ❌ FAILED · 5/6 passed, 1 failed
Model gemini/gemini-3.8-flash · 24 steps · 26 LLM calls · 1m 48s

✅ AC1 Typing text into the "New todo" input and clicking "Add" adds the todo to the list.
    Evidence: Buy milk
✅ AC2 Pressing Enter in the input also adds the todo.
...
❌ AC5 Submitting an empty or whitespace-only value does NOT add a todo and shows the error "Todo cannot be empty."
    Expected: No todo is added and "Todo cannot be empty." is shown
    Actual: A blank todo was added and no error appeared
    Steps to reproduce: 1. Type three spaces in "New todo" 2. Press Enter
    [screenshot]

Bugs filed: QA-104                     → ticket moved back to "In Progress"
```
<sub>Illustrative output; real wording comes from the model.</sub>

## How it works

```
 ┌────────────┐  card moved to    ┌────────────┐  jira:issue_updated   ┌──────────────┐
 │ Mock Jira  │  "In Testing" ──► │ Mock Jira  │ ────── webhook ─────► │ Orchestrator │
 │ board (UI) │                   │  REST API  │                       │ (run queue)  │
 └────────────┘                   └─────▲──────┘                       └──────┬───────┘
                                        │ comment · labels · transition       │
                                        │ bug tickets                         ▼
                                        │                         ┌──────────────────────┐
                                        └─────────────────────────┤      AI QA agent     │
                                                                  │                      │
                                         ┌──────── observe ───────┤  page snapshot       │
                    ┌──────────────┐     │                        │        ▼             │
                    │  Web app     │◄────┤                        │  LLM decides (tools) │◄──► any LLM
                    │ (under test) │     │                        │        ▼             │
                    └──────────────┘     └──────── act ───────────┤  browser action      │
                                          (real Chromium)         └──────────────────────┘
```

1. **Trigger.** Moving a card to *In Testing* makes mock Jira POST a Jira-format webhook to the orchestrator. Only that status triggers a run; duplicate webhooks are ignored; runs execute one at a time.
2. **Plan.** The orchestrator fetches the ticket, extracts the numbered list under *Acceptance Criteria*, and finds the app URL (`Test URL:` line in the ticket, or `APP_UNDER_TEST_URL`).
3. **Test.** The agent loops: **observe** the page → **decide** the next tool call with the LLM → **act** in a real browser → observe the result. It records a verdict per criterion as it goes.
4. **Report.** The result comment, `ai-qa-*` labels, a status transition (pass → *Done*, fail → *In Progress*) and one bug ticket per failed criterion are written back through the Jira API.

### What the model sees

Instead of screenshots, the agent gives the model a compact, accessibility-style snapshot of the page. It works with text-only models, costs a fraction of image input, and gives every control a stable handle:

```
heading "Todos" [level 1]
form:
  [e1] textbox "New todo" value="   " placeholder="What needs to be done?" (invalid, focused)
  [e2] button "Add"
alert "Todo cannot be empty."
navigation "Filter todos":
  [e3] button "All" (pressed)
  [e4] button "Active" (not pressed)
list "Todo list":
  listitem:
    [e6] checkbox "Buy milk" (checked)
    [e7] button "Delete "Buy milk""
text "1 item left"
[e10] button "Clear completed (1)"
```

The model acts through a small tool set: `click(ref)`, `type(ref, text, submit?, repeat_to_length?)`, `press_key`, `select_option`, `navigate`, `reload`, `record_result`, `finish`. Screenshots are still captured, as evidence for humans.

### Guard rails (why you can trust a verdict)

| Risk with an LLM tester | What the agent does about it |
|---|---|
| Says "pass" without checking | `record_result` must quote `observed_text` that appeared on a page the agent actually saw. Unverifiable evidence is rejected and the model must re-check; if it insists, the verdict is kept but flagged for a human. |
| The model's summary is optimistic | The run verdict is computed in code from per-criterion results: any fail → FAILED, all pass → PASSED, otherwise INCOMPLETE. |
| Skips criteria | `finish` is refused while criteria have no verdict; leftovers are reported as *not tested* and the ticket stays in *In Testing* for a human. |
| The AI provider is down or overloaded | Retries with backoff, then switches to a fallback model; if all fail, the ticket is marked NOT TESTED (never FAILED) and left for a human. |
| Loops forever / runs up a bill | Step limit (`AGENT_MAX_STEPS`) and time limit (`AGENT_TIMEOUT_SECONDS`) per run; token usage is reported. |
| Miscounts characters for length limits | `type(..., repeat_to_length: 81)` produces exact-length input. |
| Clicks stale elements | Refs are regenerated each snapshot; a stale ref is a recoverable tool error, and batched actions are cut off once the page has been re-read. |
| Wanders off | `navigate` is restricted to the app's origin. |
| Misses errors a human would notice | Console errors, uncaught exceptions and failed requests are collected and reported. |
| Starts from a dirty state | Every run uses a fresh browser context (clean cookies and localStorage). |

## Quick start

Requirements: **Node.js 20+**.

```bash
git clone https://github.com/yongkkim/ai-qa-agent.git
cd ai-qa-agent
npm install
npm run setup        # pick a model, paste an API key, install Chromium, check the model works
```

Then, in two terminals:

```bash
npm run dev          # terminal 1: sample app, mock Jira and orchestrator (watch the agent's log here)
npm run demo         # terminal 2: sends QA-101..103 to "In Testing" and prints the verdicts
```

Or do it by hand: open the board at **http://localhost:4000** and drag a card into **In Testing**. With `AGENT_HEADLESS=false` (the default from setup) a browser window opens and you can watch the agent work.

To watch it catch bugs, start the app with planted bugs instead:

```bash
npm run dev:buggy
```

| URL | |
|---|---|
| http://localhost:4000 | Mock Jira board |
| http://localhost:5173 | Sample app (the app under test) |
| http://localhost:4100/runs | Run history (JSON) |
| http://localhost:4100/artifacts/ | Screenshots and `report.json` per run |

## Choosing a model

Everything model-related lives in `.env` (created by `npm run setup`, or copy `.env.example`). The file is git-ignored, so keys never get committed.

| Provider | `.env` | Notes |
|---|---|---|
| Google Gemini | `LLM_PROVIDER=gemini`<br>`LLM_MODEL=gemini-3.8-flash`<br>`LLM_API_KEY=...` | Free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A Gemini app subscription does not include API access; the key is separate. If the free tier rejects a model (HTTP 429, quota 0), try `gemini-3.5-flash-lite`. |
| OpenAI | `LLM_PROVIDER=openai`<br>`LLM_MODEL=<model id>`<br>`LLM_API_KEY=sk-...` | Any chat model with tool calling. |
| Anthropic | `LLM_PROVIDER=anthropic`<br>`LLM_MODEL=claude-sonnet-5-5`<br>`LLM_API_KEY=sk-ant-...` | |
| Ollama (local) | `LLM_PROVIDER=ollama`<br>`LLM_MODEL=qwen3` | No key, runs on your machine. Small models may need `LLM_TOOL_MODE=json`. |
| Anything OpenAI-compatible | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=https://api.groq.com/openai/v1`<br>`LLM_MODEL=...`<br>`LLM_API_KEY=...` | Groq, OpenRouter, Together, LM Studio, vLLM... |

Check a configuration before running the agent:

```bash
npm run llm:check
#   ✓ provider=gemini model=gemini-3.8-flash toolMode=native
#   ✓ API key works — model replied "OK" in 812 ms
#   ✓ tool calling works — got click({ref: "e7"}) in 954 ms
```

**Adding a provider** means implementing one method, `chat({ system, messages, tools }) → { text, toolCalls, usage }`, in `packages/llm/src/providers/` and registering it in `factory.ts`. The agent never sees provider-specific formats. Models without native tool calling are handled by `LLM_TOOL_MODE=json`, which describes the tools in the prompt and parses a JSON reply back into a tool call.

**When the model is busy.** Hosted models sometimes answer `HTTP 503 (overloaded)` or `429 (rate limit)`, especially on free tiers. Each request is retried with exponential backoff (`LLM_MAX_RETRIES`, default 5 ≈ 1 minute). If the model is still unavailable, the agent switches to the next model in `LLM_FALLBACK_MODELS` and keeps going (the comment shows e.g. `gemini-3.8-flash → gemini-3.5-flash-lite`). If every model is down, the ticket is marked **NOT TESTED**, stays in *In Testing*, and the comment says plainly that this is an AI-provider problem, not a product failure, so a developer is never sent a false bug.

If misconfigured, the orchestrator warns at startup, and a triggered ticket gets a comment explaining exactly what to fix instead of failing silently.

## The sample app and its planted bugs

`apps/sample-app` is a small React Todo app built for this project, with three feature tickets on the board:

| Ticket | Feature | Planted bug (`npm run dev:buggy`) |
|---|---|---|
| QA-101 | Add a todo with input validation | `empty-input`: whitespace-only text is accepted |
| QA-102 | Filter All / Active / Completed | `filter-active`: "Active" also shows completed todos (off by default; add it to `VITE_BUGS` in `apps/sample-app/.env.buggy`) |
| QA-103 | Items-left counter and Clear completed | `counter`: completed todos are counted as "left" |

Bugs are toggled with an env var and never shown in the UI, so the agent cannot read the answer off the page.

**Testing your own app:** put `Test URL: https://your-app` and an `Acceptance Criteria:` numbered list in a ticket (create one on the board via the API, or edit `apps/mock-jira/src/seed.ts`), then move it to *In Testing*.

## Tests

```bash
npm test
```

40 tests, no API key or network needed. A scripted fake model stands in for the LLM, so the agent loop is deterministic:

- **Full pipeline**: real mock Jira over HTTP → webhook → orchestrator → agent testing the **real built sample app** (in jsdom) → comment, labels, transition and bug ticket asserted on the ticket. Both outcomes are covered: the same scripted tester passes the correct build and catches the bug in the buggy build.
- **Real browser**: the same agent in real Chromium via Playwright, against the built app over HTTP. Runs whenever Chromium is installed, otherwise skipped.
- **Guard rails**: evidence grounding, early-finish refusal, step limit, origin restriction, stale refs, model errors.
- **Model adapters**: request/response mapping for Gemini (including thought signatures), OpenAI-compatible and Anthropic, retries, error messages, JSON tool fallback, config validation.
- **Page snapshot**: roles, names, states, whitespace in values, ref regeneration, persistence across reloads.

## Project structure

```
apps/
  sample-app/      React app under test, with toggleable planted bugs
  mock-jira/       Jira REST v3 subset + kanban board + webhooks (JSON file storage)
  orchestrator/    webhook receiver, run queue, Jira reporting (comment, labels, transitions, bugs)
packages/
  llm/             provider-agnostic chat + tool-calling layer and adapters
  agent/           page snapshot, Playwright driver, observe→decide→act loop, guard rails
scripts/           setup wizard, demo, test runner
```

## Configuration reference

All settings are in `.env.example` with comments. The main ones:

| Variable | Default | |
|---|---|---|
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_BASE_URL` | | Which model (see above) |
| `LLM_TOOL_MODE` | `native` | `json` for models without tool calling |
| `LLM_FALLBACK_MODELS` | | Same-provider models to switch to when the main one is overloaded |
| `LLM_MAX_RETRIES` | `5` | Retries per request on 429/5xx/network errors |
| `AGENT_HEADLESS` | `true` (`.env.example` sets `false`) | Show the browser while testing |
| `AGENT_SLOW_MO_MS` | `0` | Slow actions down for watching |
| `AGENT_MAX_STEPS` / `AGENT_TIMEOUT_SECONDS` | `40` / `600` | Per-run limits |
| `AGENT_BROWSER_CHANNEL` / `AGENT_BROWSER_PATH` | | Use installed Chrome/Edge or a specific Chromium instead of Playwright's |
| `QA_TRIGGER_STATUS` | `In Testing` | Status that starts a run |
| `QA_STATUS_ON_PASS` / `QA_STATUS_ON_FAIL` | `Done` / `In Progress` | Where tickets go afterwards |
| `QA_CREATE_BUG_TICKETS` | `true` | One bug per failed criterion |
| `JIRA_BASE_URL` (+ `JIRA_EMAIL`, `JIRA_API_TOKEN`) | `http://localhost:4000` | Point at a real Jira site |

## Using a real Jira

The orchestrator talks to Jira only through `apps/orchestrator/src/jira.ts`, which uses real Jira Cloud REST v3 endpoints (issue, transitions looked up by name, comments, labels, create issue) with Basic auth. To connect a real site: set `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`, register a Jira webhook for *issue updated* pointing at `POST /webhooks/jira`, and convert comment/description bodies to Atlassian Document Format (the mock accepts markdown; that conversion is the main missing piece).

## Limitations and next steps

- **LLMs are non-deterministic.** The same ticket can take different paths on different runs. The guard rails bound how wrong a run can be, but a flagged or INCOMPLETE result still needs a human. Stronger models make fewer mistakes; small local models struggle with long flows.
- **Snapshot coverage.** The accessibility snapshot covers standard HTML controls and ARIA roles. Canvas-heavy UIs, iframes and visual-only checks (layout, colours) would need a vision model; the provider interface can be extended with image input.
- **One run at a time.** Fine for a demo; a team setup would run browser workers in parallel.
- **Next:** export a passing run as a replayable Playwright test (turning exploratory AI runs into regression tests), an HTML run report with the step timeline, and vision input for visual criteria.
