import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAcceptanceCriteria } from "../src/criteria.js";

describe("extractAcceptanceCriteria", () => {
  it("reads a numbered list under the heading and stops at the next section", () => {
    const desc = "Story text\n\nAcceptance Criteria:\n1. First\n2) Second\n\nNotes:\nnot a criterion";
    assert.deepEqual(extractAcceptanceCriteria(desc), ["First", "Second"]);
  });

  it("supports markdown headings, bullets and AC-prefixed items", () => {
    assert.deepEqual(extractAcceptanceCriteria("## Acceptance criteria\n- One\n* Two"), ["One", "Two"]);
    assert.deepEqual(extractAcceptanceCriteria("**Acceptance Criteria**\nAC1: One\nAC2 - Two"), ["One", "Two"]);
  });

  it("returns nothing when there is no criteria section", () => {
    assert.deepEqual(extractAcceptanceCriteria("Just a description\n1. a step"), []);
  });
});
