import type { RecipePage } from "../shared/recipe-types";

/**
 * The swap point for recipe OCR — the twin of ReceiptParser. Today the only
 * real implementation is LLMRecipeParser (Claude vision); a different OCR
 * backend can implement this same interface later with no downstream changes.
 *
 * Returns a RecipePage (every recipe on the image), not a single recipe — a
 * photographed cookbook page often shows more than one.
 */
export interface RecipeParser {
  readonly name: string;
  /** Turn a recipe image on disk into the structured, validated recipes on it. */
  parse(imagePath: string): Promise<RecipePage>;
}
