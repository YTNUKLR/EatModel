import { normalizeName } from "./units";

/**
 * Pure boundary-validation logic for the review gate. These decide whether a
 * line or receipt should be *flagged for review* — never whether to drop it.
 * Keeping them pure (no db, no I/O) makes them unit-testable and the single
 * place the "what looks untrustworthy" rules live.
 *
 * Philosophy (ARCHITECTURE.md §5.5): normalize-or-flag, don't reject. One odd
 * line should not sink an entire receipt; it should land with a `needs_review`
 * marker so a human can look, while everything trustworthy flows through.
 */

/** A number is acceptable if it's absent (unknown) or finite and non-negative. */
export function isSaneNumber(value: number | null): boolean {
  return value == null || (Number.isFinite(value) && value >= 0);
}

/** Returns a reason the text cannot safely resolve to an ingredient identity. */
export function identityReviewReason(text: string): string | null {
  if (text.trim() === "") return "empty name";
  if (normalizeName(text) === "") return "name has no searchable characters";
  return null;
}

/**
 * Returns a human-readable reason a line should be reviewed, or null if it's
 * fine. `text` is the product/ingredient name; `numbers` are the numeric fields
 * with labels for the message.
 */
export function reviewLineReason(
  text: string,
  numbers: { label: string; value: number | null }[],
): string | null {
  const reasons: string[] = [];
  const identityReason = identityReviewReason(text);
  if (identityReason) reasons.push(identityReason);
  for (const { label, value } of numbers) {
    if (!isSaneNumber(value)) reasons.push(`invalid ${label} (${value})`);
  }
  return reasons.length ? reasons.join("; ") : null;
}

// Line items can't legitimately exceed the order total (tax only makes the total
// larger), so an overshoot means a double-count or a misread total. A sum far
// below the total suggests missed lines — but tax/fees make some gap normal, so
// we only flag a drastic shortfall. Discounts can cause benign overshoots; this
// is advisory (a review flag), not a hard rejection.
const RECONCILE_TOLERANCE = 0.01;
const RECONCILE_LOW_RATIO = 0.5;

/** Returns a reason the receipt should be reviewed, or null if it reconciles. */
export function reconcileReceiptTotal(total: number | null, lineTotals: number[]): string | null {
  if (total == null) return null; // nothing to reconcile against
  const sum = lineTotals.reduce((acc, n) => acc + n, 0);
  if (sum > total + RECONCILE_TOLERANCE) {
    return `line items (${sum.toFixed(2)}) exceed receipt total (${total.toFixed(2)})`;
  }
  if (sum > 0 && sum < total * RECONCILE_LOW_RATIO) {
    return `line items (${sum.toFixed(2)}) far below receipt total (${total.toFixed(2)}) — possible missed lines`;
  }
  return null;
}

/**
 * Deleting a mis-captured recipe (e.g. a partial re-photo) must also clean up
 * what it leaves dangling — but only what nothing else depends on. This is the
 * pure decision half; the db half just executes the returned plan.
 *
 * Reference counts are what would REMAIN after the recipe's own lines are gone:
 * `otherRecipeRefs` excludes the recipe being deleted. An ingredient is an
 * orphan iff no other recipe, receipt, or price fact still references it.
 *
 * A *confirmed* ingredient is never deleted, even when orphaned: confirmation is
 * accumulated human judgment about the spine (ARCHITECTURE.md §5.5), not a
 * byproduct of one recipe, so it must outlive the recipe that introduced it.
 */
export interface IngredientDeletionUsage {
  ingredientId: number;
  confirmed: boolean;
  /** recipe_ingredients rows in recipes *other than* the one being deleted. */
  otherRecipeRefs: number;
  receiptRefs: number;
  priceObsRefs: number;
}

export interface RecipeDeletionPlan {
  /** Unconfirmed ingredients (and their aliases) safe to delete. */
  orphanIngredientIds: number[];
  /** True when this was the last recipe on its image, so the ingest goes too. */
  deleteIngest: boolean;
}

export function planRecipeDeletion(
  ingredients: IngredientDeletionUsage[],
  otherRecipesInIngest: number,
): RecipeDeletionPlan {
  const orphanIngredientIds = ingredients
    .filter(
      (i) =>
        !i.confirmed && i.otherRecipeRefs === 0 && i.receiptRefs === 0 && i.priceObsRefs === 0,
    )
    .map((i) => i.ingredientId);
  return { orphanIngredientIds, deleteIngest: otherRecipesInIngest === 0 };
}
