/**
 * The Washington-only gate. Column E of the mapping sheet decides whether a
 * notice may be generated at all — a Washington form served in another state
 * is an invalid notice, not a cosmetic mismatch.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkServiceableState } from "./city-rules.ts";

describe("Washington properties", () => {
  for (const state of ["WA", "wa", " WA ", "Washington", "washington"]) {
    test(`"${state}" generates normally`, () => {
      const result = checkServiceableState(state, "Castle");
      assert.equal(result.serviceable, true);
      assert.equal(result.reason, undefined);
    });
  }
});

describe("out-of-state properties", () => {
  test("blocks the real San Francisco row from the mapping sheet", () => {
    // BLD-001, 1255 Kearny St — the row that prompted this gate.
    const result = checkServiceableState("CA", "1255 Kearny St");
    assert.equal(result.serviceable, false);
    assert.match(result.reason!, /1255 Kearny St/);
    assert.match(result.reason!, /not Washington/);
    assert.match(result.reason!, /no notice was generated/);
  });

  test("names the actual state in the explanation", () => {
    const result = checkServiceableState("OR", "Somewhere Apartments");
    assert.equal(result.serviceable, false);
    assert.match(result.reason!, /in OR, not Washington/);
    assert.match(result.reason!, /under OR law/);
  });
});

describe("a missing state", () => {
  for (const blank of ["", "   "]) {
    test(`${JSON.stringify(blank)} is treated as unknown, not as Washington`, () => {
      const result = checkServiceableState(blank, "New Building");
      assert.equal(result.serviceable, false);
      assert.match(result.reason!, /No state is set/);
      assert.match(result.reason!, /column E/);
    });
  }

  test("handles a missing column without throwing", () => {
    // lookupProperty yields "" for a short row; this must not crash the run.
    const result = checkServiceableState(undefined as unknown as string, "Short Row");
    assert.equal(result.serviceable, false);
    assert.match(result.reason!, /No state is set/);
  });
});
