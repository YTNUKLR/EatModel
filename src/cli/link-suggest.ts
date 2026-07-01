import { Db } from "../db/db";
import { rankFoodCandidates } from "../shared/food-match";
import type { FoodLinker } from "../parser/food-linker";

/**
 * Assisted food-linking (ARCHITECTURE §11 2026-07-01, Lever B). For each
 * unlinked ingredient: narrow the catalog with the pure ranker, let the linker
 * pick or abstain, and stage the pick as a *proposed* link through the §5.5 gate
 * — never a confirmed one. A human still confirms via `review -- confirm-food`.
 * The linker abstaining, or no lexical candidate at all, leaves the ingredient
 * unlinked (no forced guess).
 */

const SHORTLIST_SIZE = 12;

export interface LinkSuggestion {
  ingredientId: number;
  ingredientName: string;
  foodId: number | null;
  foodDescription: string | null;
  candidateCount: number;
  reason: string;
}

export interface LinkSuggestSummary {
  proposed: LinkSuggestion[];
  abstained: LinkSuggestion[];
  noCandidates: LinkSuggestion[];
}

export async function runLinkSuggest(
  db: Db,
  linker: FoodLinker,
  opts: { ingredientId?: number } = {},
): Promise<LinkSuggestSummary> {
  const foods = db.listFoods().map((f) => ({ id: f.id, description: f.description }));
  const targets = db.ingredientsToLink(opts.ingredientId);

  const summary: LinkSuggestSummary = { proposed: [], abstained: [], noCandidates: [] };

  for (const target of targets) {
    const shortlist = rankFoodCandidates(target.canonicalName, foods, SHORTLIST_SIZE);
    const base = {
      ingredientId: target.id,
      ingredientName: target.canonicalName,
      candidateCount: shortlist.length,
    };

    if (shortlist.length === 0) {
      summary.noCandidates.push({
        ...base,
        foodId: null,
        foodDescription: null,
        reason: "no lexical candidate in the catalog",
      });
      continue;
    }

    const choice = await linker.choose({
      ingredientName: target.canonicalName,
      candidates: shortlist.map((c) => ({ id: c.id, description: c.description })),
    });

    if (choice.foodId == null) {
      summary.abstained.push({ ...base, foodId: null, foodDescription: null, reason: choice.reason });
      continue;
    }

    db.proposeIngredientFoodLink(target.id, choice.foodId);
    const description = foods.find((f) => f.id === choice.foodId)?.description ?? null;
    summary.proposed.push({ ...base, foodId: choice.foodId, foodDescription: description, reason: choice.reason });
  }

  return summary;
}

export function formatLinkSuggest(summary: LinkSuggestSummary): string[] {
  const out = [
    `Link suggestions — ${summary.proposed.length} proposed, ` +
      `${summary.abstained.length} abstained, ${summary.noCandidates.length} no-candidate`,
  ];
  if (summary.proposed.length > 0) {
    out.push("", "  proposed (confirm with `review -- confirm-food <ingredient-id>`):");
    for (const s of summary.proposed) {
      out.push(
        `    #${s.ingredientId}  ${s.ingredientName}  →  #${s.foodId}  ${s.foodDescription}`,
      );
    }
  }
  if (summary.abstained.length > 0) {
    out.push("", "  abstained (left unlinked — no confident match):");
    for (const s of summary.abstained) out.push(`    #${s.ingredientId}  ${s.ingredientName}  (${s.reason})`);
  }
  if (summary.noCandidates.length > 0) {
    out.push("", "  no catalog candidate (import more foods, or link by hand):");
    for (const s of summary.noCandidates) out.push(`    #${s.ingredientId}  ${s.ingredientName}`);
  }
  if (summary.proposed.length > 0) {
    out.push("", "Review the proposals above, then confirm the good ones. Nothing is trusted until confirmed.");
  }
  return out;
}
