/**
 * Runs inside the page and turns the DOM into a compact, accessibility-style
 * text snapshot, one line per meaningful element:
 *
 *   heading "Todos"
 *   [e1] textbox "New todo" value="" placeholder="What needs to be done?"
 *   [e2] button "Add"
 *   list "Todo list":
 *     listitem:
 *       [e6] checkbox "Buy milk" (checked)
 *       [e7] button "Delete "Buy milk""
 *   text "1 item left"
 *
 * Interactive elements get a ref ([e1]...) stored as a data-qa-ref attribute,
 * which the driver uses to click/type. This is what the LLM "sees"; it works
 * with text-only models (no vision needed) and is far cheaper than screenshots.
 *
 * Kept as a plain JS string (not a TS function) so it can be evaluated as-is
 * in the browser and in jsdom tests, with no bundler helpers leaking in.
 */
export const SNAPSHOT_SCRIPT = String.raw`(() => {
  const MAX_LINES = 400;
  const MAX_TEXT = 160;
  const INTERACTIVE_ROLES = new Set(["button","link","checkbox","radio","switch","tab","menuitem","menuitemcheckbox","option","textbox","searchbox","combobox","slider","spinbutton"]);
  const CONTAINERS = { UL: "list", OL: "list", LI: "listitem", NAV: "navigation", FORM: "form", DIALOG: "dialog", TABLE: "table", TR: "row" };
  const CONTAINER_ROLES = new Set(["list","listitem","navigation","form","dialog","alertdialog","table","row","tablist","menu","listbox","group","radiogroup"]);
  const SKIP_TAGS = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE","SVG","IFRAME","HEAD","META","LINK"]);
  const INLINE_TAGS = new Set(["B","I","EM","STRONG","SPAN","CODE","SMALL","MARK","SUB","SUP","ABBR","TIME","S","U","BR","KBD","Q","CITE","LABEL"]);
  const INTERACTIVE_SELECTOR = "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=textbox],[role=combobox],[role=slider],[contenteditable=true]";

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const clip = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "…" : s);
  const q = (s) => '"' + clip(clean(s)) + '"';

  function isVisible(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href") ? "link" : null;
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "search") return "searchbox";
      return "textbox";
    }
    if (/^H[1-6]$/.test(t)) return "heading";
    if (el.isContentEditable && el.getAttribute("contenteditable") === "true") return "textbox";
    return CONTAINERS[t] || null;
  }

  function nameOf(el) {
    const label = el.getAttribute("aria-label");
    if (label && clean(label)) return clean(label);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const txt = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ""; }).join(" ");
      if (clean(txt)) return clean(txt);
    }
    if (el.labels && el.labels.length) {
      const txt = Array.from(el.labels).map((l) => l.textContent).join(" ");
      if (clean(txt)) return clean(txt);
    }
    if (el.tagName === "INPUT" && /^(submit|button|reset)$/i.test(el.type || "")) return clean(el.value);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      return clean(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "");
    }
    const txt = typeof el.innerText === "string" ? el.innerText : el.textContent;
    return clean(txt) || clean(el.getAttribute("title") || "");
  }

  function statesOf(el, role) {
    const st = [];
    const aria = (a) => el.getAttribute(a);
    if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox") {
      const checked = "checked" in el && el.tagName === "INPUT" ? el.checked : aria("aria-checked") === "true";
      st.push(checked ? "checked" : "unchecked");
    }
    if (aria("aria-pressed") === "true") st.push("pressed");
    if (aria("aria-pressed") === "false") st.push("not pressed");
    if (aria("aria-expanded")) st.push(aria("aria-expanded") === "true" ? "expanded" : "collapsed");
    if (aria("aria-selected") === "true") st.push("selected");
    if (aria("aria-current") && aria("aria-current") !== "false") st.push("current");
    if (el.disabled || aria("aria-disabled") === "true") st.push("disabled");
    if (aria("aria-invalid") === "true") st.push("invalid");
    if (el.required || aria("aria-required") === "true") st.push("required");
    if (document.activeElement === el) st.push("focused");
    return st;
  }

  for (const old of document.querySelectorAll("[data-qa-ref]")) old.removeAttribute("data-qa-ref");

  const lines = [];
  let refCount = 0;
  const emit = (depth, s) => { if (lines.length < MAX_LINES) lines.push("  ".repeat(depth) + s); };

  function interactiveLine(el, role) {
    const ref = "e" + (++refCount);
    el.setAttribute("data-qa-ref", ref);
    let s = "[" + ref + "] " + role;
    const name = nameOf(el);
    if (name) s += " " + q(name);
    if (role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "slider") {
      const v = String("value" in el ? el.value : el.textContent);
      // Keep whitespace exact here: "   " vs "" matters when testing validation.
      s += " value=" + JSON.stringify(v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + "…" : v) + (v.length > 20 ? " (" + v.length + " chars)" : "");
      const ph = el.getAttribute("placeholder");
      if (ph && clean(ph) !== name) s += " placeholder=" + q(ph);
      const max = el.getAttribute("maxlength");
      if (max) s += " maxlength=" + max;
    }
    if (role === "combobox" && el.tagName === "SELECT") {
      const opts = Array.from(el.options).map((o) => clean(o.textContent) + (o.selected ? "*" : ""));
      s += " options=[" + opts.join(", ") + "]";
    }
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href) s += " href=" + q(href);
    }
    const st = statesOf(el, role);
    if (st.length) s += " (" + st.join(", ") + ")";
    return s;
  }

  function textLine(el, role, text) {
    if (role === "heading") return "heading " + q(text) + " [level " + el.tagName.slice(1) + "]";
    if (role === "alert" || role === "status") return role + " " + q(text);
    return "text " + q(text);
  }

  function walk(el, depth, suppressText) {
    if (lines.length >= MAX_LINES) return;
    if (el.nodeType !== 1 || SKIP_TAGS.has(el.tagName.toUpperCase())) return;
    if (!isVisible(el)) return;

    const role = roleOf(el);

    if (role && INTERACTIVE_ROLES.has(role)) {
      emit(depth, interactiveLine(el, role));
      // Text inside a control is already part of its name; only look for nested controls.
      for (const child of el.children) walk(child, depth + 1, true);
      return;
    }

    // A <label> tied to a control: its text is the control's name, so don't repeat it.
    if (el.tagName === "LABEL" && el.control) {
      for (const child of el.children) walk(child, depth, true);
      return;
    }

    if (!suppressText) {
      const hasInteractive = !!el.querySelector(INTERACTIVE_SELECTOR);
      const allInline = Array.from(el.children).every((c) => INLINE_TAGS.has(c.tagName));
      // Leaf-ish block (e.g. <p>2 <b>items</b> left</p>): emit its whole text as one line.
      if (!hasInteractive && allInline && !(role && CONTAINER_ROLES.has(role))) {
        const txt = clean(typeof el.innerText === "string" ? el.innerText : el.textContent);
        if (txt) emit(depth, textLine(el, role, txt));
        return;
      }
    }

    let childDepth = depth;
    if (role && CONTAINER_ROLES.has(role)) {
      const label = el.getAttribute("aria-label");
      emit(depth, role + (label ? " " + q(label) : "") + ":");
      childDepth = depth + 1;
    }

    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const txt = clean(node.textContent);
        if (txt && !suppressText) emit(childDepth, textLine(el, role, txt));
      } else {
        walk(node, childDepth, suppressText);
      }
    }
  }

  if (document.body) walk(document.body, 0, false);
  if (lines.length >= MAX_LINES) lines.push("… (snapshot truncated)");
  return { text: lines.join("\n"), refCount };
})()`;
