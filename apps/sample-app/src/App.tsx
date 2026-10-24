import { FormEvent, useEffect, useMemo, useState } from "react";
import { enabledBugs, hasBug } from "./bugs";

type Todo = { id: string; text: string; done: boolean };
type Filter = "all" | "active" | "completed";

const STORAGE_KEY = "sample-app.todos";
const MAX_LENGTH = 80;

// Deliberately NOT shown in the UI, so the QA agent can't "read the answer" off the page.
if (enabledBugs().length > 0) console.info(`[sample-app] planted bugs: ${enabledBugs().join(", ")}`);

function loadTodos(): Todo[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Todo[]) : [];
  } catch {
    return [];
  }
}

export function App() {
  const [todos, setTodos] = useState<Todo[]>(loadTodos);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch {
      /* storage unavailable: keep working in memory */
    }
  }, [todos]);

  // ---- QA-101: add a todo with validation ----
  function addTodo(e: FormEvent) {
    e.preventDefault();
    // BUG(empty-input): skips trimming, so "   " passes the emptiness check.
    const value = hasBug("empty-input") ? text : text.trim();
    if (value.length === 0) {
      setError("Todo cannot be empty.");
      return;
    }
    if (value.length > MAX_LENGTH) {
      setError(`Todo must be ${MAX_LENGTH} characters or fewer.`);
      return;
    }
    setTodos((prev) => [...prev, { id: crypto.randomUUID(), text: value, done: false }]);
    setText("");
    setError(null);
  }

  const toggle = (id: string) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const remove = (id: string) => setTodos((prev) => prev.filter((t) => t.id !== id));

  // ---- QA-102: filters ----
  const visible = useMemo(() => {
    switch (filter) {
      case "active":
        // BUG(filter-active): forgets to exclude completed todos.
        return hasBug("filter-active") ? todos : todos.filter((t) => !t.done);
      case "completed":
        return todos.filter((t) => t.done);
      default:
        return todos;
    }
  }, [todos, filter]);

  // ---- QA-103: items-left counter + clear completed ----
  // BUG(counter): counts every todo instead of only the active ones.
  const itemsLeft = hasBug("counter") ? todos.length : todos.filter((t) => !t.done).length;
  const completedCount = todos.filter((t) => t.done).length;
  const clearCompleted = () => setTodos((prev) => prev.filter((t) => !t.done));

  return (
    <main className="app">
      <h1>Todos</h1>

      <form className="add" onSubmit={addTodo} noValidate>
        <label htmlFor="new-todo" className="sr-only">
          New todo
        </label>
        <input
          id="new-todo"
          placeholder="What needs to be done?"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "todo-error" : undefined}
          autoComplete="off"
        />
        <button type="submit">Add</button>
      </form>
      {error && (
        // BUG(error-style): renders the error in the muted grey used for secondary text instead of red.
        <p id="todo-error" role="alert" className={hasBug("error-style") ? "error error-muted" : "error"}>
          {error}
        </p>
      )}

      <nav className="filters" aria-label="Filter todos">
        {(["all", "active", "completed"] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            className={filter === f ? "selected" : ""}
            onClick={() => setFilter(f)}
          >
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </nav>

      {visible.length === 0 ? (
        <p className="empty">Nothing here yet.</p>
      ) : (
        <ul className="todo-list" aria-label="Todo list">
          {visible.map((t) => (
            <li key={t.id} className={t.done ? "done" : ""}>
              <label>
                <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} />
                <span className="text">{t.text}</span>
              </label>
              <button type="button" className="delete" aria-label={`Delete "${t.text}"`} onClick={() => remove(t.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="footer">
        <p aria-live="polite" data-testid="items-left">
          {itemsLeft} {itemsLeft === 1 ? "item" : "items"} left
        </p>
        {completedCount > 0 && (
          <button type="button" onClick={clearCompleted}>
            Clear completed ({completedCount})
          </button>
        )}
      </footer>
    </main>
  );
}
