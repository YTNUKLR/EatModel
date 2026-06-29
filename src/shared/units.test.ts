import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName } from "./units";

test("lowercases and collapses whitespace", () => {
  assert.equal(normalizeName("  Organic   BABY Spinach "), "organic baby spinach");
});

test("strips punctuation", () => {
  assert.equal(normalizeName("Chicken Thighs, b/l s/l!"), "chicken thighs b l s l");
});

test("folds accents instead of splitting them", () => {
  // Caught a real bug first time through: NFKD turns ñ into n + combining mark,
  // and stripping the mark to a space split "jalapeño" into "jalapen o".
  assert.equal(normalizeName("Jalapeño"), "jalapeno");
});

test("makes punctuation/spacing variants converge to the same key", () => {
  assert.equal(normalizeName("Brown Rice (2lb)"), normalizeName("brown   rice 2lb"));
});
