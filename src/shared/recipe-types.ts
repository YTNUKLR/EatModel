import { z } from "zod";

/**
 * The validated shape a RecipeParser must return — the contract between the
 * recipe OCR and everything downstream (ingredient matching, persistence).
 *
 * Deliberately NOT the same as ParsedLineItem (receipts): a recipe line has a
 * prep note and an optional flag and *no price*; a receipt line has a price and
 * no prep. They share the canonical ingredient spine, not their line shape.
 * (See ARCHITECTURE.md §5.4 — "shared spine, separate envelope".)
 *
 * Scope is ingredients-list-first: we capture the ingredient list, not the
 * step-by-step instructions. The original image + raw_json are retained, so
 * steps can be re-parsed later without re-photographing.
 *
 * Fields the model can't read are `null` rather than omitted — structured
 * outputs require every property, so "unknown" is expressed as null.
 */
export const RecipeIngredientLine = z.object({
  /** The ingredient line exactly as printed, e.g. "2 cloves garlic, minced". */
  rawText: z.string(),
  /** The cleaned ingredient name that resolves to the spine, e.g. "garlic". */
  ingredient: z.string(),
  quantity: z.number().nullable(),
  /** Unit for the quantity, e.g. "cup", "tbsp", "clove", "g". */
  unit: z.string().nullable(),
  /** Preparation note, e.g. "minced", "to taste", "room temperature". */
  prepNote: z.string().nullable(),
  /** True when the recipe marks the ingredient optional ("optional", "if desired"). */
  optional: z.boolean(),
});
export type RecipeIngredientLine = z.infer<typeof RecipeIngredientLine>;

export const RecipeParseResult = z.object({
  title: z.string().nullable(),
  /** Where it came from — book + page, site, etc., if visible, else null. */
  sourceNote: z.string().nullable(),
  /** Servings/yield the recipe states, as a number if legible, else null. */
  servings: z.number().nullable(),
  ingredients: z.array(RecipeIngredientLine),
});
export type RecipeParseResult = z.infer<typeof RecipeParseResult>;

/**
 * One photographed page can hold several recipes (cookbook spreads routinely do).
 * The parser returns *all* recipes it can read on the image; the image itself is
 * the dedup unit (one photo → one content hash → one ingest → many recipes).
 */
export const RecipePage = z.object({
  recipes: z.array(RecipeParseResult),
});
export type RecipePage = z.infer<typeof RecipePage>;
