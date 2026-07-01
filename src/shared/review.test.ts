import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identityReviewReason,
  isSaneNumber,
  reviewLineReason,
  reconcileReceiptTotal,
  planRecipeDeletion,
  type IngredientDeletionUsage,
} from "./review";

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

// ── planRecipeDeletion ─────────────────────────────────────────────────────

function usage(fields: Partial<IngredientDeletionUsage> = {}): IngredientDeletionUsage {
  return {
    ingredientId: fields.ingredientId ?? 1,
    confirmed: fields.confirmed ?? false,
    otherRecipeRefs: fields.otherRecipeRefs ?? 0,
    receiptRefs: fields.receiptRefs ?? 0,
    priceObsRefs: fields.priceObsRefs ?? 0,
  };
}

test("planRecipeDeletion orphans an unconfirmed ingredient nothing else references", () => {
  const plan = planRecipeDeletion([usage({ ingredientId: 55 })], 0);
  assert.deepEqual(plan.orphanIngredientIds, [55]);
});

test("planRecipeDeletion keeps ingredients still used by other recipes", () => {
  const plan = planRecipeDeletion([usage({ ingredientId: 17, otherRecipeRefs: 1 })], 0);
  assert.deepEqual(plan.orphanIngredientIds, []);
});

test("planRecipeDeletion keeps ingredients referenced by receipts or price facts", () => {
  const plan = planRecipeDeletion(
    [usage({ ingredientId: 2, receiptRefs: 1 }), usage({ ingredientId: 3, priceObsRefs: 4 })],
    0,
  );
  assert.deepEqual(plan.orphanIngredientIds, []);
});

test("planRecipeDeletion never deletes a confirmed ingredient, even when orphaned", () => {
  // Confirmation is accumulated human judgment — it outlives the recipe that
  // introduced the ingredient.
  const plan = planRecipeDeletion([usage({ ingredientId: 9, confirmed: true })], 0);
  assert.deepEqual(plan.orphanIngredientIds, []);
});

test("planRecipeDeletion deletes the ingest only when no other recipe shares the image", () => {
  assert.equal(planRecipeDeletion([], 0).deleteIngest, true);
  assert.equal(planRecipeDeletion([], 1).deleteIngest, false);
});

test("planRecipeDeletion sorts a mixed set into orphans and survivors", () => {
  const plan = planRecipeDeletion(
    [
      usage({ ingredientId: 55 }), // orphan
      usage({ ingredientId: 17, otherRecipeRefs: 2 }), // shared
      usage({ ingredientId: 56 }), // orphan
      usage({ ingredientId: 9, confirmed: true }), // confirmed, kept
    ],
    2,
  );
  assert.deepEqual(plan.orphanIngredientIds, [55, 56]);
  assert.equal(plan.deleteIngest, false);
});
