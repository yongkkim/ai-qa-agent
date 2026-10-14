import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JsdomDriver } from "./support/jsdom-driver.js";
import { buildSampleApp } from "./support/sample-app.js";
import { ref } from "./support/script-helpers.js";

describe("page snapshot (what the model sees)", () => {
  it("describes the sample app with roles, names, states and refs", async () => {
    const d = new JsdomDriver(await buildSampleApp("normal"));
    await d.goto("http://localhost:5173/");
    const { text, title } = await d.snapshot();
    assert.equal(title, "Todo App");
    assert.match(text, /^heading "Todos" \[level 1\]$/m);
    assert.match(text, /\[e1\] textbox "New todo" value="" placeholder="What needs to be done\?"/);
    assert.match(text, /\[e\d+\] button "All" \(pressed\)/);
    assert.match(text, /\[e\d+\] button "Active" \(not pressed\)/);
    assert.match(text, /text "Nothing here yet\."/);
    assert.match(text, /text "0 items left"/);
    // The visually-hidden <label> is the textbox's name, not a separate line.
    assert.doesNotMatch(text, /^text "New todo"$/m);
  });

  it("shows list items, checkbox state and the alert after interactions", async () => {
    const d = new JsdomDriver(await buildSampleApp("normal"));
    await d.goto("http://localhost:5173/");
    let page = (await d.snapshot()).text;
    await d.type(ref(page, 'textbox "New todo"'), "Buy milk");
    await d.press("Enter");
    page = (await d.snapshot()).text;
    await d.click(ref(page, 'checkbox "Buy milk"'));
    page = (await d.snapshot()).text;
    assert.match(page, /list "Todo list":\n {2}listitem:\n {4}\[e\d+\] checkbox "Buy milk" \(checked/);
    assert.match(page, /\[e\d+\] button "Clear completed \(1\)"/);

    await d.type(ref(page, 'textbox "New todo"'), "   ");
    await d.press("Enter");
    page = (await d.snapshot()).text;
    assert.match(page, /alert "Todo cannot be empty\."/);
    // Whitespace in a field's value is preserved, so the model can tell "   " from "".
    assert.match(page, /textbox "New todo" value="   "/);
    assert.match(page, /\(invalid, focused\)|\(invalid\)/);
  });

  it("regenerates refs on every snapshot and drops stale ones", async () => {
    const d = new JsdomDriver(await buildSampleApp("normal"));
    await d.goto("http://localhost:5173/");
    await d.snapshot();
    await d.snapshot();
    const refs = d["w"].document.querySelectorAll("[data-qa-ref]");
    const ids = Array.from(refs as ArrayLike<Element>).map((e) => e.getAttribute("data-qa-ref"));
    assert.equal(new Set(ids).size, ids.length, "refs are unique");
    assert.equal(ids[0], "e1", "numbering restarts");
  });

  it("keeps data across reloads like a browser (localStorage)", async () => {
    const d = new JsdomDriver(await buildSampleApp("normal"));
    await d.goto("http://localhost:5173/");
    const page = (await d.snapshot()).text;
    await d.type(ref(page, 'textbox "New todo"'), "Persist me");
    await d.press("Enter");
    await d.reload();
    assert.match((await d.snapshot()).text, /checkbox "Persist me"/);
  });
});
