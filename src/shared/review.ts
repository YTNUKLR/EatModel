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
