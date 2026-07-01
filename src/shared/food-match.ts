import { normalizeName } from "./units";

/**
 * Pure lexical candidate generation for ingredient → reference-food linking
 * (ARCHITECTURE §11 2026-07-01, Lever B). This narrows the ~8k-food catalog to a
 * short, ranked shortlist for a human — or the LLM `FoodLinker` — to choose from.
 * It deliberately does NOT decide the link: it optimizes for *recall* (get the
 * right food into the top ~10), leaving the *judgment* to the gated step.
 *
 * FDC descriptions are verbose and specific ("Chicken, broilers or fryers, dark
 * meat, meat and skin, raw") while recipe ingredients are terse ("chicken"), so
 * scoring rewards a food that *contains* the ingredient's words (coverage),
 * tie-breaks toward tighter descriptions (precision), and nudges toward the raw
 * form a recipe would use over prepared/canned/branded entries.
 */

export interface FoodLite {
  id: number;
  description: string;
}

export interface FoodCandidate {
  id: number;
  description: string;
  score: number;
}

// Connective/noise words that carry no matching signal — dropped from both sides
// so "meat and skin" doesn't reward on "and". Includes a few FDC boilerplate tokens.
const STOPWORDS = new Set([
  "and", "or", "with", "of", "the", "a", "an", "in", "for", "to", "from", "made",
  "includes", "food", "foods", "usda", "program", "distribution", "all", "type",
]);

// Signals that a food is the plain/raw form a recipe assumes (small bump)…
const RAW_MARKERS = ["raw", "uncooked"];
// …or a prepared/branded/derived form less likely to be the intended base (small
// penalty). Includes the mix/soup/gravy/powder entries that otherwise outrank a
// plain base food on their shorter descriptions.
const PREPARED_MARKERS = [
  "cooked", "canned", "prepared", "sauce", "restaurant", "baby food",
  "fast food", "frozen meal", "with added", "soup", "gravy", "mix",
  "powder", "cereal", "cereals", "snacks", "infant", "formula", "cookies",
];

/** Light singular-stemming so "onion" matches "Onions" (recall) without a stemmer dep. */
function stem(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return token.slice(0, -3) + "y";
  if (token.endsWith("oes") && token.length > 4) return token.slice(0, -2); // tomatoes→tomato
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  return normalizeName(text)
    .split(" ")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

function markerHits(normalized: string, markers: string[]): number {
  return markers.reduce((n, m) => (normalized.includes(m) ? n + 1 : n), 0);
}

/**
 * Rank foods by lexical fit to an ingredient name. Returns up to `limit`
 * candidates with a positive score (at least one shared meaningful token),
 * best first. Empty when nothing overlaps — an honest "no lexical candidate"
 * that the caller surfaces rather than forcing a bad guess.
 */
export function rankFoodCandidates(
  ingredientName: string,
  foods: FoodLite[],
  limit = 10,
): FoodCandidate[] {
  const ingTokens = new Set(tokenize(ingredientName));
  if (ingTokens.size === 0) return [];

  const scored: FoodCandidate[] = [];
  for (const food of foods) {
    const foodTokens = tokenize(food.description);
    if (foodTokens.length === 0) continue;
    const foodSet = new Set(foodTokens);

    let shared = 0;
    for (const t of ingTokens) if (foodSet.has(t)) shared++;
    if (shared === 0) continue;

    const coverage = shared / ingTokens.size; // how much of the ingredient the food explains
    const precision = shared / foodSet.size; // how little extra the food carries
    const normalized = normalizeName(food.description);
    const rawBonus = markerHits(normalized, RAW_MARKERS) > 0 ? 0.05 : 0;
    const preparedPenalty = markerHits(normalized, PREPARED_MARKERS) * 0.03;

    // Coverage dominates (recall); precision + raw/prepared bias break ties.
    const score = coverage + precision * 0.25 + rawBonus - preparedPenalty;
    scored.push({ id: food.id, description: food.description, score });
  }

  scored.sort((a, b) => b.score - a.score || a.description.length - b.description.length);
  return scored.slice(0, limit);
}
