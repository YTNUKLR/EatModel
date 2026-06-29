import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveUnitPrice } from "./pricing";

test("uses the explicit unit price when present", () => {
  assert.equal(deriveUnitPrice({ unitPrice: 2.49, quantity: 1.5, lineTotal: 3.74 }), 2.49);
});

test("derives unit price from lineTotal / quantity", () => {
  assert.equal(deriveUnitPrice({ unitPrice: null, quantity: 2, lineTotal: 8.5 }), 4.25);
});

test("falls back to lineTotal when there is no quantity", () => {
  assert.equal(deriveUnitPrice({ unitPrice: null, quantity: null, lineTotal: 4.29 }), 4.29);
});

test("avoids divide-by-zero and falls back to lineTotal", () => {
  assert.equal(deriveUnitPrice({ unitPrice: null, quantity: 0, lineTotal: 4.29 }), 4.29);
});

test("returns null when nothing is priced", () => {
  assert.equal(deriveUnitPrice({ unitPrice: null, quantity: null, lineTotal: null }), null);
});
