/**
 * The swap point for ingredient → reference-food linking (ARCHITECTURE §11
 * 2026-07-01, Lever B). A FoodLinker is handed an ingredient and a *shortlist*
 * of candidate foods (already narrowed by the pure `rankFoodCandidates`) and
 * returns which one to propose — or abstains. It never writes: its choice is
 * staged as a `proposed` link through the §5.5 gate for a human to confirm.
 *
 * This is deliberately assisted, not automatic. The LLM is good at picking the
 * right cut/form from a shortlist ("dark meat, raw" vs "gravy, dry mix") but
 * must be allowed to say "none of these" — an abstain leaves the ingredient
 * unlinked rather than minting a wrong link (no-silent-guessing).
 */
export interface FoodLinkerInput {
  ingredientName: string;
  candidates: { id: number; description: string }[];
}

export interface FoodLinkChoice {
  /** A candidate id to propose, or null to abstain (no confident match). */
  foodId: number | null;
  reason: string;
}

export interface FoodLinker {
  readonly name: string;
  choose(input: FoodLinkerInput): Promise<FoodLinkChoice>;
}
