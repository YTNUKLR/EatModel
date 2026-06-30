import { test } from "node:test";
import assert from "node:assert/strict";
import { identityReviewReason, isSaneNumber, reviewLineReason, reconcileReceiptTotal } from "./review";

test("isSaneNumber accepts null and non-negative finite numbers, rejects the rest", () => {
  assert.equal(isSaneNumber(null), true); // unknown is fine
  assert.equal(isSaneNumber(0), true);
  assert.equal(isSaneNumber(2.49), true);
  assert.equal(isSaneNumber(-1), false);
  assert.equal(isSaneNumber(Number.NaN), false);
  assert.equal(isSaneNumber(Number.POSITIVE_INFINITY), false);
});

test("reviewLineReason passes a clean line", () => {
  assert.equal(reviewLineReason("Chicken thighs", [{ label: "unitPrice", value: 2.49 }]), null);
});

test("reviewLineReason flags an empty name", () => {
  const reason = reviewLineReason("   ", [{ label: "unitPrice", value: 2.49 }]);
  assert.match(reason ?? "", /empty name/);
});

test("identityReviewReason flags punctuation-only names", () => {
  assert.equal(identityReviewReason("Chicken thighs"), null);
  assert.match(identityReviewReason("!!!") ?? "", /searchable/);
  assert.match(reviewLineReason("!!!", [{ label: "unitPrice", value: 2.49 }]) ?? "", /searchable/);
});

test("reviewLineReason flags a negative price but reports all problems", () => {
  const reason = reviewLineReason("", [
    { label: "unitPrice", value: -2 },
    { label: "quantity", value: 1 },
  ]);
  assert.match(reason ?? "", /empty name/);
  assert.match(reason ?? "", /invalid unitPrice/);
});

test("reconcileReceiptTotal is silent when there's no total to check", () => {
  assert.equal(reconcileReceiptTotal(null, [1, 2, 3]), null);
});

test("reconcileReceiptTotal allows a normal tax gap (lines a bit under total)", () => {
  assert.equal(reconcileReceiptTotal(10.8, [3.74, 3.99, 2.29]), null); // sum 10.02 vs 10.80 (tax)
});

test("reconcileReceiptTotal flags line items exceeding the total", () => {
  const reason = reconcileReceiptTotal(5.0, [3.74, 3.99]);
  assert.match(reason ?? "", /exceed/);
});

test("reconcileReceiptTotal flags a drastic shortfall (missed lines)", () => {
  const reason = reconcileReceiptTotal(100, [3.74]);
  assert.match(reason ?? "", /below/);
});
