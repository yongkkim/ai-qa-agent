import type { Db, Issue, StatusName } from "./types.js";
import { STATUSES } from "./workflow.js";

const APP_URL = process.env.APP_UNDER_TEST_URL ?? "http://localhost:5173";

function issue(
  n: number,
  summary: string,
  status: StatusName,
  description: string,
  extra: Partial<Issue["fields"]> = {},
): Issue {
  const now = new Date().toISOString();
  return {
    id: String(10000 + n),
    key: `QA-${n}`,
    fields: {
      summary,
      description: description.trim(),
      issuetype: { name: "Story" },
      status: STATUSES[status],
      priority: { name: "Medium" },
      labels: ["todo-app"],
      created: now,
      updated: now,
      comment: { comments: [], total: 0 },
      ...extra,
    },
  };
}

export function seedDb(): Db {
  return {
    nextIssueNumber: 105,
    nextId: 1,
    issues: [
      issue(
        100,
        "Set up Todo app skeleton",
        "Done",
        `
Initial Vite + React project with an empty todo list page.

Test URL: ${APP_URL}
`,
        { issuetype: { name: "Task" }, priority: { name: "Low" } },
      ),
      issue(
        101,
        "Add a todo with input validation",
        "In Progress",
        `
As a user, I want to add todos so that I can track what I need to do.

Test URL: ${APP_URL}

Acceptance Criteria:
1. Typing text into the "New todo" input and clicking "Add" adds the todo to the list.
2. Pressing Enter in the input also adds the todo.
3. After a todo is added, the input is cleared.
4. Leading and trailing spaces are trimmed from the saved todo text.
5. Submitting an empty or whitespace-only value does NOT add a todo and shows the error "Todo cannot be empty."
6. Text longer than 80 characters is rejected with an error message.
`,
        { priority: { name: "High" } },
      ),
      issue(
        102,
        "Filter todos by All / Active / Completed",
        "In Progress",
        `
As a user, I want to filter my todos so that I can focus on what is left.

Test URL: ${APP_URL}

Acceptance Criteria:
1. There are three filter buttons: "All", "Active" and "Completed". "All" is selected by default.
2. "All" shows every todo.
3. "Active" shows only todos that are not completed.
4. "Completed" shows only completed todos.
5. The selected filter is visually highlighted (aria-pressed="true").
6. When a filter has no matching todos, the message "Nothing here yet." is shown.
`,
      ),
      issue(
        103,
        "Items-left counter and Clear completed",
        "To Do",
        `
As a user, I want to see how many todos are left and remove finished ones in one click.

Test URL: ${APP_URL}

Acceptance Criteria:
1. The footer shows "<N> items left", where N is the number of NOT completed todos.
2. Use the singular form "1 item left" when exactly one todo is active.
3. Completing or un-completing a todo updates the counter immediately.
4. A "Clear completed (<M>)" button appears only when at least one todo is completed, where M is the number of completed todos.
5. Clicking "Clear completed" removes all completed todos and keeps the active ones.
`,
      ),
      issue(
        104,
        "Visual feedback for errors and completed todos",
        "To Do",
        `
As a user, I want errors and finished todos to be obvious at a glance.

Test URL: ${APP_URL}

Acceptance Criteria:
1. When an empty or whitespace-only todo is submitted, the error message "Todo cannot be empty." is shown in red text.
2. While that error is shown, the input field has a red border.
3. The text of a completed todo is shown struck through (a line through the text).
`,
      ),
    ],
  };
}
