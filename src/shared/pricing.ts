import type { ParsedLineItem } from "./types";

/**
 * Compute the per-unit price for a parsed line. Explicit `unitPrice` wins;
 * otherwise derive it from `lineTotal / quantity`; if there's no usable
 * quantity, fall back to the line total; if nothing is priced, return null.
 *
 * Pure and side-effect-free so it can be unit-tested without a database —
 * the price spine is where a quiet bug would silently corrupt cost history,
 * so this logic lives apart from the persistence layer and is tested directly.
 */
export function deriveUnitPrice(
  line: Pick<ParsedLineItem, "quantity" | "unitPrice" | "lineTotal">,
): number | null {
  if (line.unitPrice != null) return line.unitPrice;
  if (line.lineTotal != null && line.quantity != null && line.quantity !== 0) {
    return line.lineTotal / line.quantity;
  }
  return line.lineTotal;
}
