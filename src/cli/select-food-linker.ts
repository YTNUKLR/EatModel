import { LlmFoodLinker } from "../parser/food-linker-llm";
import { MockFoodLinker } from "../parser/food-linker-mock";
import type { FoodLinker } from "../parser/food-linker";

/**
 * Choose the food linker from the environment, failing loudly rather than
 * silently downgrading (mirrors selectRecipeParser). Default is the real LLM
 * linker; the mock is used only when explicitly requested
 * (`EATMODEL_FOOD_LINKER=mock`), so a missing API key can never quietly stage
 * canned proposals over a real run.
 */
export function selectFoodLinker(env: NodeJS.ProcessEnv = process.env): FoodLinker {
  const choice = env.EATMODEL_FOOD_LINKER ?? "llm";

  if (choice === "mock") return new MockFoodLinker();

  if (choice === "llm") {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — set it (e.g. in .env) to run the real food linker, " +
          "or use EATMODEL_FOOD_LINKER=mock for a deterministic top-candidate linker.",
      );
    }
    return new LlmFoodLinker({ apiKey: env.ANTHROPIC_API_KEY, model: env.EATMODEL_MODEL });
  }

  throw new Error(`unknown EATMODEL_FOOD_LINKER "${choice}" — use "llm" or "mock"`);
}
