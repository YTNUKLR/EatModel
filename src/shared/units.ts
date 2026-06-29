/**
 * Pure, testable helpers shared across the app. Today: just name normalization
 * for ingredient matching. Unit conversion (cups↔grams↔each) lands here later.
 */

/**
 * Collapse a product description to a stable key for alias matching:
 * lowercase, fold accents, strip punctuation, squeeze whitespace. "Organic Baby
 * Spinach!" and "organic baby spinach" both map to "organic baby spinach".
 *
 * NFKD splits accented letters into base + combining mark; we then drop the
 * combining marks so "jalapeño" folds to "jalapeno" (rather than splitting into
 * two words), before stripping the remaining punctuation.
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // remove combining marks: é→e, not "e ́"
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
