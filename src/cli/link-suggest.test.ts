import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../db/db";
import { runLinkSuggest } from "./link-suggest";
import { MockFoodLinker } from "../parser/food-linker-mock";
import type { RecipeParseResult } from "../shared/recipe-types";

function recipe(names: string[]): RecipeParseResult {
  return {
    title: "T",
    sourceNote: null,
    servings: 4,
    ingredients: names.map((ingredient) => ({
      rawText: ingredient,
      ingredient,
      quantity: 1,
      unit: "lb",
      prepNote: null,
      optional: false,
    })),
  };
}

test("link-suggest stages proposals (not confirmations) for unlinked ingredients", async () => {
  const db = new Db(":memory:");
  db.saveRecipe(recipe(["Garlic", "Spinach"]), "r.jpg", "mock");

  const summary = await runLinkSuggest(db, new MockFoodLinker());

  // Both resolve to seeded foods via the lexical ranker + mock top-pick.
  assert.ok(summary.proposed.length >= 2);
  const garlic = summary.proposed.find((p) => p.ingredientName === "Garlic")!;
  assert.match(garlic.foodDescription ?? "", /Garlic/);

  // Proposed, not confirmed: it shows in the awaiting-confirmation queue and does
  // NOT yet feed nutrition until a human confirms.
  assert.equal(db.listProposedFoodLinks().length, summary.proposed.length);
  assert.equal(db.listIngredientsMissingFoodLink().length, 0); // (none are 'confirmed' yet either)
  db.close();
});

test("link-suggest reports ingredients with no catalog candidate instead of guessing", async () => {
  const db = new Db(":memory:");
  db.saveRecipe(recipe(["Saffron threads"]), "r.jpg", "mock");

  const summary = await runLinkSuggest(db, new MockFoodLinker());
  assert.equal(summary.proposed.length, 0);
  assert.equal(summary.noCandidates.length, 1);
  assert.equal(summary.noCandidates[0]!.ingredientName, "Saffron threads");
  db.close();
});

test("link-suggest can target a single ingredient by id", async () => {
  const db = new Db(":memory:");
  const saved = db.saveRecipe(recipe(["Garlic", "Spinach"]), "r.jpg", "mock");
  const garlicId = saved.lines[0]!.ingredientId!;

  const summary = await runLinkSuggest(db, new MockFoodLinker(), { ingredientId: garlicId });
  assert.equal(summary.proposed.length + summary.abstained.length + summary.noCandidates.length, 1);
  assert.equal(summary.proposed[0]!.ingredientId, garlicId);
  db.close();
});
