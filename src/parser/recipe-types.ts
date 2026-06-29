import type { RecipeParseResult } from "../shared/recipe-types";

/**
 * The swap point for recipe OCR — the twin of ReceiptParser. Today the only
 * real implementation is LLMRecipeParser (Claude vision); a different OCR
 * backend can implement this same interface later with no downstream changes.
 */
export interface RecipeParser {
  readonly name: string;
  /** Turn a recipe image on disk into a structured, validated recipe. */
  parse(imagePath: string): Promise<RecipeParseResult>;
}
