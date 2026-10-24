# Manual test plan

The automated suite (`npm test`) checks the code paths deterministically with a scripted model. This plan checks the **whole product with a real AI model**: what a user actually sees on the board when tickets move to *In Testing*.

LLM output is non-deterministic, so when a result is unexpected, re-run that case once more before drawing conclusions.

## Before every case

- After changing `.env` or `apps/sample-app/.env.buggy`, **restart terminal 1** (`Ctrl+C`, then start it again). Both files are only read at startup.
- Check terminal 1's startup log before running a case: the `[app]` line `[sample-app] planted bugs ON: …` (or `no planted bugs`) must match the case's setup.
- Starting terminal 1 resets the board to the seed tickets (QA-101 to QA-104), and so does `npm run demo`. To reset by hand without restarting, use the board's reset button or `npm run jira:reset`.
- Planted bugs are set by one line in `apps/sample-app/.env.buggy`, e.g. `VITE_BUGS=empty-input,counter`. Order doesn't matter.

| Bug id | Breaks ticket | Effect |
|---|---|---|
| `empty-input` | QA-101 | Whitespace-only text is added as a todo |
| `filter-active` | QA-102 | "Active" also shows completed todos |
| `counter` | QA-103 | "items left" counts completed todos too |
| `error-style` | QA-104 | The error message is grey instead of red (only visible in a screenshot) |

---

## A. Verdicts: does the agent catch bugs, and only real ones?

### TC-01 · Correct app: no false failures
- **Setup:** terminal 1 `npm run dev` (no planted bugs)
- **Steps:** terminal 2 `npm run demo`
- **Expected:** QA-101 to QA-104 all **Done**, label ✅ QA passed, no bug tickets created. On QA-104 each criterion shows `👁️ Looked: … ✓` with the screenshot the agent judged.

### TC-02 · Only `empty-input`
- **Setup:** `VITE_BUGS=empty-input`, terminal 1 `npm run dev:buggy`
- **Steps:** `npm run demo`
- **Expected:** QA-101 **In Progress** (whitespace criterion failed, with expected vs actual and a screenshot); QA-102, QA-103 and QA-104 **Done**.

### TC-03 · Only `filter-active`
- **Setup:** `VITE_BUGS=filter-active`, `npm run dev:buggy`
- **Steps:** `npm run demo`
- **Expected:** QA-102 **In Progress** ("Active" criterion failed); QA-101, QA-103 and QA-104 **Done**.

### TC-04 · Only `counter`
- **Setup:** `VITE_BUGS=counter`, `npm run dev:buggy`
- **Steps:** `npm run demo`
- **Expected:** QA-103 **In Progress** (counter criteria failed); QA-101, QA-102 and QA-104 **Done**.
- **Note:** AC1 may still pass when the model tests it with only active todos, a setup in which this bug is invisible. The ticket still fails through AC2/AC3. See *Limitations* in the README.

### TC-05 · All bugs
- **Setup:** `VITE_BUGS=empty-input,filter-active,counter,error-style`, `npm run dev:buggy`
- **Steps:** `npm run demo`
- **Expected:** all four tickets **In Progress**, each with a result comment that names the failed criteria.

### TC-13 · Only `error-style` (criteria about appearance)
- **Setup:** `VITE_BUGS=error-style`, `npm run dev:buggy`
- **Steps:** `npm run demo -- QA-104`
- **Expected:** QA-104 **In Progress**. AC1 (red error text) fails with `👁️ Visual check` and a screenshot showing grey text; AC2 (red border) and AC3 (strike-through) pass with `👁️ Looked: … ✓` and the screenshot the agent judged. The terminal 1 log shows `look` steps for this ticket only.
- **Note:** the text snapshot is identical with and without this bug, so a pass on AC1 would mean the agent judged without really looking. Re-run once if that happens and note it.

### TC-14 · A model that can't read images
- **Setup:** `LLM_VISION=false` in `.env`, any `VITE_BUGS`, restart terminal 1. **Remove the line afterwards.**
- **Steps:** `npm run demo -- QA-104`
- **Expected:** QA-104 stays in **In Testing** as INCOMPLETE: its criteria are *blocked* with a note that they need a visual check. Nothing is guessed as pass or fail. (The model is told up front that it can't see images; this case checks that it follows that.)

What to look at in every result comment (A and B):
- ✅ criteria show `Checked: expected "…" ✓ on page`, i.e. the agent's planned expectation was confirmed by the page.
- ❌ criteria show expected vs actual, steps to reproduce and a screenshot.
- No ⚠️ "evidence could not be verified" or "changed its expected result" warnings, or, if there are, they point at a real problem worth noting.

---

## B. Bug tickets (`QA_BUG_TICKETS` in `.env`)

Use the TC-05 setup (all bugs) for each case.

### TC-06 · `QA_BUG_TICKETS=per-defect` (default)
- **Expected:** one Bug per underlying defect. Criteria broken by the same defect share a Bug, e.g. `[QA-103 AC1, AC3] …`, listing "The same defect also breaks" and a screenshot per criterion. The parent ticket's comment shows `Bugs filed: QA-1xx (AC1, AC3), …` and `Same defect as AC1.` on the grouped criteria. Bugs carry the label `🤖 found by AI`.
- **Note:** grouping is the agent's call; a defect occasionally filed as two Bugs is a duplicate, not a missed bug.

### TC-07 · `QA_BUG_TICKETS=per-criterion`
- **Expected:** one Bug per failed criterion (more Bugs than TC-06 when a defect breaks several criteria).

### TC-08 · `QA_BUG_TICKETS=off`
- **Expected:** no Bug tickets. Failed tickets still go to **In Progress** with the full result comment, and the comment has no "Bugs filed" line.

Every Bug's description should read like a hand-written report: criterion → expected/actual → steps to reproduce → evidence screenshot → Environment (app URL, model, run id).

---

## C. Setup, triggers and failure handling

### TC-09 · First run from a fresh clone (the reviewer's experience)
- **Steps:** clone the repo into a new folder, then follow only the README: `npm install` → `npm run setup` → `npm run dev` → `npm run demo`.
- **Expected:** no step needs knowledge outside the README; `npm run setup` ends with three ✓ from the model check; the demo completes.

### TC-10 · Misconfigured model
- **Steps:** (a) set `LLM_API_KEY` to an invalid value, restart terminal 1, move one ticket to *In Testing*. (b) Empty `LLM_PROVIDER`, restart, repeat. **Restore your real settings afterwards.**
- **Expected:** terminal 1 warns about the configuration at startup (b). The ticket **stays in In Testing** with label 💥 QA error and a comment that explains the problem (bad key / model not configured). It is never marked FAILED and no Bug is filed.

### TC-11 · Triggering from the board by hand
- **Steps:** `npm run jira:reset`, then on http://localhost:4000 drag QA-101 to *In Testing*. While it runs, drag QA-102 to *Done* and back to *To Do*. Then drag QA-101 out of *In Testing* and back in while it is still running.
- **Expected:** QA-101 shows 🤖 AI testing… and gets a result. Moving QA-102 between other statuses starts nothing. Re-entering *In Testing* while QA-101 is already running does not start a second run (terminal 1 logs `already queued`).

### TC-12 · Automated suite on this machine
- **Steps:** `npm test`
- **Expected:** all tests pass, including the two real-browser tests (they are skipped only when Chromium is not installed).
