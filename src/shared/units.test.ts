import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, quantityToGrams } from "./units";

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

test("converts common mass units to grams", () => {
  assert.equal(quantityToGrams(2, "kg").grams, 2000);
  assert.equal(quantityToGrams(1, "lb").grams, 453.59237);
  assert.equal(quantityToGrams(5, "oz").grams, 141.747615625);
});

test("converts volume only with ingredient density", () => {
  assert.deepEqual(quantityToGrams(1, "cup"), {
    grams: null,
    reason: "cup needs density_g_per_ml",
  });
  const converted = quantityToGrams(1, "cup", { densityGPerMl: 0.85 }).grams;
  assert.ok(converted != null);
  assert.ok(Math.abs(converted - 201.100001025) < 0.000001);
});

test("converts each-like units only with per-each weight", () => {
  assert.deepEqual(quantityToGrams(2, "cloves"), {
    grams: null,
    reason: "cloves needs grams_per_each",
  });
  assert.equal(quantityToGrams(2, "cloves", { gramsPerEach: 3 }).grams, 6);
});

test("refuses missing or unknown conversion inputs", () => {
  assert.deepEqual(quantityToGrams(null, "g"), { grams: null, reason: "missing quantity" });
  assert.deepEqual(quantityToGrams(1, null), { grams: null, reason: "missing unit" });
  assert.deepEqual(quantityToGrams(1, "dash"), {
    grams: null,
    reason: 'unconvertible unit "dash"',
  });
});
