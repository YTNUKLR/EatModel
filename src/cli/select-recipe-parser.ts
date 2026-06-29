import { LLMRecipeParser } from "../parser/recipe-llm";
import { MockRecipeParser } from "../parser/recipe-mock";
import type { RecipeParser } from "../parser/recipe-types";

/**
 * Choose the recipe parser from the environment, **failing loudly rather than
 * silently downgrading** (the twin of selectParser). Default is the real LLM
 * parser; the mock is used only when explicitly requested
 * (`EATMODEL_RECIPE_PARSER=mock` / `npm run recipes:mock`), so a missing API key
 * can never quietly save canned demo data over a real run.
 */
export function selectRecipeParser(env: NodeJS.ProcessEnv = process.env): RecipeParser {
  const choice = env.EATMODEL_RECIPE_PARSER ?? "llm";

  if (choice === "mock") return new MockRecipeParser();

  if (choice === "llm") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — set it (e.g. in .env) to run the real recipe OCR, " +
          "or use `npm run recipes:mock` for canned demo data.",
      );
    }
    return new LLMRecipeParser({ apiKey: env.ANTHROPIC_API_KEY, model: env.EATMODEL_MODEL });
  }

  throw new Error(`unknown EATMODEL_RECIPE_PARSER "${choice}" — use "llm" or "mock"`);
}
