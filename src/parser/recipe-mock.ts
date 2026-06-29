import path from "node:path";
import type { RecipePage } from "../shared/recipe-types";
import type { RecipeParser } from "./recipe-types";

/**
 * Returns a canned page of two recipes regardless of the image. Lets the whole
 * pipeline (matching → SQLite) run with no API key or cost, so the plumbing —
 * including the multi-recipe-per-image path — can be verified before pointing
 * real recipe photos at the LLM parser. The two recipes share "Garlic" to
 * exercise spine reuse across recipes on one page.
 */
export class MockRecipeParser implements RecipeParser {
  readonly name = "mock";

  async parse(imagePath: string): Promise<RecipePage> {
    void path.basename(imagePath); // image content is ignored in mock mode
    return {
      recipes: [
        {
          title: "Weeknight chicken thighs with spinach",
          sourceNote: "Demo Cookbook, p. 142",
          servings: 4,
          ingredients: [
            {
              rawText: "1.5 lb boneless skinless chicken thighs",
              ingredient: "Chicken thighs, boneless skinless",
              quantity: 1.5,
              unit: "lb",
              prepNote: null,
              optional: false,
            },
            {
              rawText: "5 oz baby spinach",
              ingredient: "Organic baby spinach",
              quantity: 5,
              unit: "oz",
              prepNote: null,
              optional: false,
            },
            {
              rawText: "2 cloves garlic, minced",
              ingredient: "Garlic",
              quantity: 2,
              unit: "clove",
              prepNote: "minced",
              optional: false,
            },
            {
              rawText: "Red pepper flakes, to taste (optional)",
              ingredient: "Red pepper flakes",
              quantity: null,
              unit: null,
              prepNote: "to taste",
              optional: true,
            },
          ],
        },
        {
          title: "Garlic butter rice",
          sourceNote: "Demo Cookbook, p. 143",
          servings: 4,
          ingredients: [
            {
              rawText: "1 cup brown rice",
              ingredient: "Brown rice",
              quantity: 1,
              unit: "cup",
              prepNote: null,
              optional: false,
            },
            {
              rawText: "3 cloves garlic, minced",
              ingredient: "Garlic",
              quantity: 3,
              unit: "clove",
              prepNote: "minced",
              optional: false,
            },
            {
              rawText: "2 tbsp butter",
              ingredient: "Butter",
              quantity: 2,
              unit: "tbsp",
              prepNote: null,
              optional: false,
            },
          ],
        },
      ],
    };
  }
}
