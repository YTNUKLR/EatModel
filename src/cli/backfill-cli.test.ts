import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPortions, runBackfillConversions } from "./backfill-conversions";
import { Db } from "../db/db";
import type { RecipeParseResult } from "../shared/recipe-types";

function bundleDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eatmodel-portion-"));
}

// Garlic (fdc 999): a cup portion (density) and a clove portion (grams_per_each).
const MEASURE_CSV = `"id","name"\n"9999","undetermined"`;
const PORTION_CSV =
  `"id","fdc_id","amount","measure_unit_id","modifier","gram_weight"\n` +
  `"1","999","1","9999","cup","136"\n` +
  `"2","999","1","9999","clove","3"`;

function recipe(name: string): RecipeParseResult {
  return {
    title: "T",
    sourceNote: null,
    servings: 4,
    ingredients: [{ rawText: name, ingredient: name, quantity: 1, unit: "clove", prepNote: null, optional: false }],
  };
}

test("backfill sets density + grams_per_each on a confirmed-linked ingredient", () => {
  const dir = bundleDir();
  fs.writeFileSync(path.join(dir, "measure_unit.csv"), MEASURE_CSV);
  fs.writeFileSync(path.join(dir, "food_portion.csv"), PORTION_CSV);

  const db = new Db(":memory:");
  db.importFoods([{ fdcId: "999", description: "Garlic, raw", macros: { calories: 143, proteinG: 6, carbsG: 33, fatG: 0.5 } }]);
  const saved = db.saveRecipe(recipe("garlic"), "r.jpg", "mock");
  const ingId = saved.lines[0]!.ingredientId!;
  const garlicFood = db.listFoods("garlic").find((f) => f.fdcId === "999")!;
  db.proposeIngredientFoodLink(ingId, garlicFood.id);
  db.confirmIngredientFoodLink(ingId);

  const summary = runBackfillConversions(db, loadPortions([dir]));
  assert.equal(summary.considered, 1);
  assert.equal(summary.densitySet, 1);
  assert.equal(summary.gramsPerEachSet, 1);

  // The clove line now rolls up (was unconvertible before).
  const rows = db.recipeLineNutritionRows();
  assert.equal(rows[0]!.gramsPerEach, 3);
  assert.ok(rows[0]!.densityGPerMl! > 0);
  db.close();
});

test("backfill never overwrites a hand-set hint", () => {
  const dir = bundleDir();
  fs.writeFileSync(path.join(dir, "measure_unit.csv"), MEASURE_CSV);
  fs.writeFileSync(path.join(dir, "food_portion.csv"), PORTION_CSV);

  const db = new Db(":memory:");
  db.importFoods([{ fdcId: "999", description: "Garlic, raw", macros: { calories: 143, proteinG: 6, carbsG: 33, fatG: 0.5 } }]);
  const saved = db.saveRecipe(recipe("garlic"), "r.jpg", "mock");
  const ingId = saved.lines[0]!.ingredientId!;
  db.proposeIngredientFoodLink(ingId, db.listFoods("garlic").find((f) => f.fdcId === "999")!.id);
  db.confirmIngredientFoodLink(ingId);
  db.setIngredientGramsPerEach(ingId, 5); // human says a clove is 5 g

  const summary = runBackfillConversions(db, loadPortions([dir]));
  assert.equal(summary.gramsPerEachSet, 0); // not overwritten
  assert.equal(db.recipeLineNutritionRows()[0]!.gramsPerEach, 5);
  db.close();
});

test("loadPortions fails loud on a bundle missing the portion files", () => {
  const dir = bundleDir(); // empty
  assert.throws(() => loadPortions([dir]), /missing .*food_portion\.csv|measure_unit\.csv/);
});
