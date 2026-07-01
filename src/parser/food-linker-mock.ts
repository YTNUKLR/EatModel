import type { FoodLinker, FoodLinkerInput, FoodLinkChoice } from "./food-linker";

/**
 * Deterministic linker: propose the top-ranked candidate, or abstain when the
 * shortlist is empty. Lets the whole `link-suggest` flow (candidate generation →
 * staged proposals → gate) run and be tested with no API key or cost. It trusts
 * the lexical ranking rather than disambiguating cuts/forms — that judgment is
 * what the real LLM linker adds.
 */
export class MockFoodLinker implements FoodLinker {
  readonly name = "mock";

  async choose(input: FoodLinkerInput): Promise<FoodLinkChoice> {
    const top = input.candidates[0];
    if (!top) return { foodId: null, reason: "mock: no candidates" };
    return { foodId: top.id, reason: "mock: top lexical candidate" };
  }
}
