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
Model gemini/gemini-3.5-flash-lite · 24 steps · 26 LLM calls · 1m 48s

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
4. **Report.** The result comment, `ai-qa-*` labels, a status transition (pass → *Done*, fail → *In Progress*) and bug tickets (one per defect by default) are written back through the Jira API.

### What the model sees

Instead of screenshots, the agent gives the model a compact, accessibility-style snapshot of the page. It costs a fraction of image input, states facts a screenshot only implies (a checkbox is `checked`, a value is three spaces), gives every control a stable handle, and is text that code can check the model's evidence against. It also works with text-only models. Screenshots are added only for criteria about appearance (see below).

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

The model acts through a small tool set: `plan_test`, `click(ref)`, `type(ref, text, submit?, repeat_to_length?)`, `press_key`, `select_option`, `navigate`, `reload`, `look`, `record_result`, `finish`. For every criterion it must call `plan_test` first: how it will test, and the exact text the page must show if the feature works (the test oracle), written before it looks at the result. Screenshots are still captured, as evidence for humans.

### Criteria about appearance (the `look` tool)

The snapshot shows text, roles and states, but not colours, borders, strike-through or layout. So the agent works in a hybrid way: it **always acts through the snapshot**, and for a criterion about appearance it plans an `expected_look` (e.g. "the error text is red") and calls `look`, which sends a screenshot of the window to the model. Screenshots are sent only on demand, so a run stays cheap, and only the newest one is kept in the conversation.

- A visual verdict is refused until the agent has looked **after** planning (i.e. at the result, not at the page before the setup).
- The comment marks it as `👁️ Looked: … (the model's judgment from a screenshot)` and shows that screenshot, because appearance can't be verified in code the way text can.
- Text-only models (`LLM_VISION=false`, the default for local and other compatible models) get an explanation from `look` and record such criteria as *blocked*, never a guess.

QA-104 exists to show this: its planted bug (`error-style`) renders the error message grey instead of red. The text and roles are identical, so the snapshot cannot tell the difference; only `look` can.

### Guard rails (why you can trust a verdict)

| Risk with an LLM tester | What the agent does about it |
|---|---|
| Sees a bug and still says "pass" (found in a real run: the counter didn't change and the model passed it anyway) | The expected result is declared up front with `plan_test`. When the model records PASS, the code checks the current page for that expected text (and for any `must_not_appear` text). A contradicted PASS is rejected; if the model insists, it becomes *blocked* for a human, never a pass. |
| Passes a criterion with a weak setup, then finds the defect elsewhere (found in a real run: AC1 'passed' with no completed todos; AC2 then exposed the counter bug) | Before finishing, the agent is sent back once with a **defect review**: what failed, and how each pass was checked. It re-tests any pass whose setup could not have revealed those defects. Re-tested criteria are marked 🔁 in the comment. A re-test that just repeats the check that already passed (same expected text) is pushed back once, because that happened in a real run too. |
| Tests only the trivial case (e.g. a counter with nothing completed, where a wrong formula still gives the right number) | The prompt asks for setups where a broken implementation would show something different from a working one (mixed states, before/after values, limits, items that should be hidden). |
| Judges appearance from the text snapshot (which has no colours) | A criterion planned with `expected_look` can't be recorded until the agent has called `look` after planning; text-only models must mark it *blocked*. Visual verdicts are labelled as the model's judgment and come with the screenshot. |
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
npm run demo         # terminal 2: sends QA-101..104 to "In Testing" and prints the verdicts
```

Or do it by hand: open the board at **http://localhost:4000** and drag a card into **In Testing**. With `AGENT_HEADLESS=false` (the default from setup) a browser window opens and you can watch the agent work.

To watch it catch bugs, start the app with planted bugs instead:

```bash
npm run dev:buggy
```

> **For your testing convenience, the mock Jira board is reset every time you run `npm run dev` or `npm run dev:buggy`:** every run starts from the same seed tickets (QA-100 *Done*, QA-101/102 *In Progress*, QA-103 *To Do*). Restarting also clears the previous run's comments and bug tickets, so check results before you restart. To reset without restarting, use the board's reset button (or `npm run jira:reset`); to keep the board between restarts, set `MOCK_JIRA_KEEP_DATA=true` in `.env`.

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
| Google Gemini | `LLM_PROVIDER=gemini`<br>`LLM_MODEL=gemini-3.5-flash-lite`<br>`LLM_API_KEY=...` | Free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). A Gemini app subscription does not include API access; the key is separate. The default is `gemini-3.5-flash-lite`, with `gemini-3.6-flash` as fallback, because newer flash models were often overloaded (HTTP 503) on the free tier. A stronger model designs sharper tests (see Limitations), so set a bigger one in `LLM_MODEL` if it is available to you. |
| OpenAI | `LLM_PROVIDER=openai`<br>`LLM_MODEL=<model id>`<br>`LLM_API_KEY=sk-...` | Any chat model with tool calling. |
| Anthropic | `LLM_PROVIDER=anthropic`<br>`LLM_MODEL=claude-sonnet-5-5`<br>`LLM_API_KEY=sk-ant-...` | |
| Ollama (local) | `LLM_PROVIDER=ollama`<br>`LLM_MODEL=qwen3` | No key, runs on your machine. Small models may need `LLM_TOOL_MODE=json`. |
| Anything OpenAI-compatible | `LLM_PROVIDER=openai-compatible`<br>`LLM_BASE_URL=https://api.groq.com/openai/v1`<br>`LLM_MODEL=...`<br>`LLM_API_KEY=...` | Groq, OpenRouter, Together, LM Studio, vLLM... |

Check a configuration before running the agent:

```bash
npm run llm:check
#   ✓ provider=gemini model=gemini-3.5-flash-lite toolMode=native vision=true fallback=gemini-3.6-flash
#   ✓ API key works — model replied "OK" in 812 ms
#   ✓ tool calling works — got click({ref: "e7"}) in 954 ms
```

**Adding a provider** means implementing one method, `chat({ system, messages, tools }) → { text, toolCalls, usage }`, in `packages/llm/src/providers/` and registering it in `factory.ts`. The agent never sees provider-specific formats. Models without native tool calling are handled by `LLM_TOOL_MODE=json`, which describes the tools in the prompt and parses a JSON reply back into a tool call.

**When the model is busy.** Hosted models sometimes answer `HTTP 503 (overloaded)` or `429 (rate limit)`, especially on free tiers. Each request is retried with exponential backoff (`LLM_MAX_RETRIES`, default 5 ≈ 1 minute). If the model is still unavailable, the agent switches to the next model in `LLM_FALLBACK_MODELS` and keeps going (the comment shows e.g. `gemini-3.5-flash-lite → gemini-3.6-flash`). If every model is down, the ticket is marked **NOT TESTED**, stays in *In Testing*, and the comment says plainly that this is an AI-provider problem, not a product failure, so a developer is never sent a false bug.

If misconfigured, the orchestrator warns at startup, and a triggered ticket gets a comment explaining exactly what to fix instead of failing silently.

## The sample app and its planted bugs

`apps/sample-app` is a small React Todo app built for this project, with four feature tickets on the board:

| Ticket | Feature | Planted bug (`npm run dev:buggy`) |
|---|---|---|
| QA-101 | Add a todo with input validation | `empty-input`: whitespace-only text is accepted (off by default; add it to `VITE_BUGS` in `apps/sample-app/.env.buggy`) |
| QA-102 | Filter All / Active / Completed | `filter-active`: "Active" also shows completed todos |
| QA-103 | Items-left counter and Clear completed | `counter`: completed todos are counted as "left" |
| QA-104 | Visual feedback (red error, red border, strike-through) | `error-style`: the error message is grey instead of red. Only a screenshot shows it (see *Criteria about appearance*) |

Bugs are toggled with an env var and never shown in the UI, so the agent cannot read the answer off the page.

**Testing your own app:** put `Test URL: https://your-app` and an `Acceptance Criteria:` numbered list in a ticket (create one on the board via the API, or edit `apps/mock-jira/src/seed.ts`), then move it to *In Testing*.

## Tests

```bash
npm test
```

About 70 tests, no API key or network needed. A scripted fake model stands in for the LLM, so the agent loop is deterministic:

- **Full pipeline**: real mock Jira over HTTP → webhook → orchestrator → agent testing the **real built sample app** (in jsdom) → comment, labels, transition and bug ticket asserted on the ticket. Both outcomes are covered: the same scripted tester passes the correct build and catches the bug in the buggy build.
- **Real browser**: the same agent in real Chromium via Playwright, against the built app over HTTP. Runs whenever Chromium is installed, otherwise skipped.
- **Guard rails**: test oracle, evidence grounding, defect review, early-finish refusal, step limit, origin restriction, stale refs, model errors, and the visual rules (no visual verdict without a fresh `look`; text-only models can't look).
- **Model adapters**: request/response mapping for Gemini (including thought signatures), OpenAI-compatible and Anthropic, how each sends a screenshot, retries, error messages, JSON tool fallback, config validation.
- **Page snapshot**: roles, names, states, whitespace in values, ref regeneration, persistence across reloads.

**Manual test plan:** [TESTING.md](TESTING.md) covers the end-to-end checks with a real model (no-bug run, each planted bug, bug-ticket modes, fresh-clone setup, misconfiguration, manual triggers, visual checks).

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
| `LLM_VISION` | `true` for Gemini, OpenAI, Anthropic; `false` otherwise | Whether the model can read screenshots (the `look` tool for criteria about appearance) |
| `LLM_FALLBACK_MODELS` | | Same-provider models to switch to when the main one is overloaded |
| `LLM_MAX_RETRIES` | `5` | Retries per request on 429/5xx/network errors |
| `AGENT_HEADLESS` | `true` (`.env.example` sets `false`) | Show the browser while testing |
| `AGENT_SLOW_MO_MS` | `0` | Slow actions down for watching |
| `AGENT_MAX_STEPS` / `AGENT_TIMEOUT_SECONDS` | `60` / `600` | Per-run limits |
| `AGENT_BROWSER_CHANNEL` / `AGENT_BROWSER_PATH` | | Use installed Chrome/Edge or a specific Chromium instead of Playwright's |
| `QA_TRIGGER_STATUS` | `In Testing` | Status that starts a run |
| `QA_STATUS_ON_PASS` / `QA_STATUS_ON_FAIL` | `Done` / `In Progress` | Where tickets go afterwards |
| `QA_BUG_TICKETS` | `per-defect` | `per-defect`: one bug per underlying defect · `per-criterion`: one bug per failed criterion · `off`: no bug tickets |
| `MOCK_JIRA_KEEP_DATA` | `false` | The mock board resets to the seed tickets on every start; `true` keeps the last session's board |
| `JIRA_BASE_URL` (+ `JIRA_EMAIL`, `JIRA_API_TOKEN`) | `http://localhost:4000` | Point at a real Jira site |

## Using a real Jira

The orchestrator talks to Jira only through `apps/orchestrator/src/jira.ts`, which uses real Jira Cloud REST v3 endpoints (issue, transitions looked up by name, comments, labels, create issue) with Basic auth. To connect a real site: set `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`, register a Jira webhook for *issue updated* pointing at `POST /webhooks/jira`, and convert comment/description bodies to Atlassian Document Format (the mock accepts markdown; that conversion is the main missing piece).

## Limitations and next steps

- **LLMs are non-deterministic.** The same ticket can take different paths on different runs. The guard rails bound how wrong a run can be, but a flagged or INCOMPLETE result still needs a human. Stronger models make fewer mistakes; small local models struggle with long flows.
- **A weak test that finds nothing is still the main residual risk.** The guard rails cover three failure modes, each with its own layer:

  | Failure mode | Covered by |
  |---|---|
  | The model calls a visible bug a pass | Test oracle: the expected result is declared up front and checked by code against the page |
  | A pass was checked too weakly, and the defect showed up in another criterion | Defect review before finishing: passes are re-examined against the defects found |
  | A pass was checked too weakly and **no** criterion failed | Not covered yet (see the design below) |

  In the last case nothing points back at the weak test, so a false pass can still slip through, for example a counter checked only while every item is active, where a wrong formula gives the right number.

  Observed in real runs (counter bug, `gemini-3.5-flash-lite`): the defect review is optional by design, and the model sometimes keeps a weak pass (AC1 "passed" with two active todos while AC2 and AC3 failed). The ticket still fails correctly, since the same defect is reported through AC2/AC3; only AC1's line is too optimistic. **Tried and reverted:** making the re-test mandatory. The model then *looked for* failures and produced a false one: AC5 ("Clear completed keeps active todos") was failed with an invented cause, though the app's Clear completed is correct. A false failure costs more than an optimistic pass inside an already-failing ticket (a wrong bug for a developer to chase, and less trust in every result), so the review stays a prompt, not an obligation. The fix belongs in the plan itself (the design below), not in pressure to re-test.

  The uncovered case happens too: in some runs with all three bugs planted, the agent passed **all** of QA-103 by testing the counter only with active todos, so the counter bug slipped through and the ticket went to *Done*. The same setup caught it in other runs. Treat a single run as a sample, not a guarantee: stronger models choose discriminating setups more consistently, and the design below is the planned fix.
- **Snapshot coverage.** The accessibility snapshot covers standard HTML controls and ARIA roles; iframes and canvas-drawn UIs are not in it. Appearance is checked with `look`, but that verdict is the model's judgment from a screenshot, not a code-verified fact like the text oracle, and it is only as good as the model's eyesight. Pixel-exact checks against a design (spacing, exact colours) would be better served by visual regression testing (`toHaveScreenshot`) alongside the agent.
- **One run at a time.** Fine for a demo; a team setup would run browser workers in parallel.

### Next: make every test prove it can fail (designed, not built yet)

Borrowing the idea behind mutation testing, which judges a test by whether it fails when the code is broken: `plan_test` would also require

- `likely_bug`: a plausible way this feature could be implemented wrong, and
- `if_broken_shows`: what the page would show in that case, with the planned setup.

If `if_broken_shows` equals `expected_text`, the setup cannot tell a working feature from a broken one, and **the code rejects the plan** before any testing: *"working and broken give the same result; choose a setup where they differ."* For the counter example, "2 todos, read the footer" (working: `2 items left`, broken: `2 items left`) is rejected; "3 todos, 1 completed" (`2 items left` vs `3 items left`) is accepted. The Jira comment would then show what each pass was able to catch, e.g. `Would catch: counts completed todos too (would show "3 items left")`, so a reviewer can judge test strength at a glance.

Why it is deferred: it closes the gap in the table above for any app, and costs no human effort (the model writes it, code checks it). But it adds work to every plan, and on small free-tier models that means more rejected plans, more steps and a higher risk of hitting the step limit. It should be measured against the current version before it becomes the default. Its limit is the same as mutation testing's: it only guards against the bugs the model thinks of.

### Other next steps

- Export a passing run as a replayable Playwright test, turning exploratory AI runs into regression tests.
- An HTML run report with the step timeline and screenshots.
- Skip a model for a few minutes after it returns 503 (circuit breaker), instead of retrying it on every ticket.
- Pixel-level visual regression (`toHaveScreenshot`) for designs that must match exactly, next to the model's `look` judgments.
