/**
 * Pure, testable helpers shared across the app. Today: just name normalization
 * for ingredient matching plus the conservative unit conversion needed for
 * nutrition rollups. Conversion returns `null` with a reason when it would need
 * an ingredient-specific fact we do not have.
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

export interface GramConversionContext {
  /** Ingredient-specific density, needed for volume units like cups/tbsp. */
  densityGPerMl?: number | null;
  /** Ingredient-specific each weight, needed for each-ish units like cloves. */
  gramsPerEach?: number | null;
}

export interface GramConversion {
  grams: number | null;
  reason: string | null;
}

const MASS_TO_GRAMS: Record<string, number> = {
  g: 1,
  gram: 1,
  grams: 1,
  kg: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
};

const VOLUME_TO_ML: Record<string, number> = {
  ml: 1,
  milliliter: 1,
  milliliters: 1,
  l: 1000,
  liter: 1000,
  liters: 1000,
  tsp: 4.92892159375,
  teaspoon: 4.92892159375,
  teaspoons: 4.92892159375,
  tbsp: 14.78676478125,
  tablespoon: 14.78676478125,
  tablespoons: 14.78676478125,
  cup: 236.5882365,
  cups: 236.5882365,
};

const EACH_UNITS = new Set(["each", "ea", "item", "items", "clove", "cloves"]);

function cleanUnit(unit: string): string {
  return unit.toLowerCase().replace(/\./g, "").trim();
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/**
 * Convert a parsed recipe quantity to grams when the conversion is trustworthy.
 * Mass units are direct. Volume and each units require ingredient-specific
 * facts. Unknowns stay unknown; callers surface the reason instead of guessing.
 */
export function quantityToGrams(
  quantity: number | null,
  unit: string | null,
  context: GramConversionContext = {},
): GramConversion {
  if (quantity == null) return { grams: null, reason: "missing quantity" };
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { grams: null, reason: `invalid quantity (${quantity})` };
  }
  if (unit == null || unit.trim() === "") return { grams: null, reason: "missing unit" };

  const normalizedUnit = cleanUnit(unit);
  const massFactor = MASS_TO_GRAMS[normalizedUnit];
  if (massFactor != null) return { grams: quantity * massFactor, reason: null };

  const volumeFactor = VOLUME_TO_ML[normalizedUnit];
  if (volumeFactor != null) {
    if (!isPositiveFinite(context.densityGPerMl)) {
      return { grams: null, reason: `${normalizedUnit} needs density_g_per_ml` };
    }
    return { grams: quantity * volumeFactor * context.densityGPerMl, reason: null };
  }

  if (EACH_UNITS.has(normalizedUnit)) {
    if (!isPositiveFinite(context.gramsPerEach)) {
      return { grams: null, reason: `${normalizedUnit} needs grams_per_each` };
    }
    return { grams: quantity * context.gramsPerEach, reason: null };
  }

  return { grams: null, reason: `unconvertible unit "${unit}"` };
}
