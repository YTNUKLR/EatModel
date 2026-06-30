import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupRecipeNutrition, type Macros } from "./nutrition";

const chicken: Macros = { calories: 143, proteinG: 19.7, carbsG: 0, fatG: 6.7 };
const spinach: Macros = { calories: 23, proteinG: 2.9, carbsG: 3.6, fatG: 0.4 };
const garlic: Macros = { calories: 149, proteinG: 6.4, carbsG: 33.1, fatG: 0.5 };

test("rolls confirmed linked mass ingredients into total and per-serving macros", () => {
  const result = rollupRecipeNutrition(
    [
      {
        ingredientName: "Chicken thighs",
        quantity: 1,
        unit: "lb",
        food: chicken,
        foodLinkStatus: "confirmed",
      },
      {
        ingredientName: "Spinach",
        quantity: 5,
        unit: "oz",
        food: spinach,
        foodLinkStatus: "confirmed",
      },
    ],
    4,
  );

  assert.equal(result.partial, false);
  assert.equal(result.countedLines, 2);
  assert.ok(result.total);
  assert.ok(result.perServing);
  assert.equal(Math.round(result.total.calories), 681);
  assert.equal(Math.round(result.perServing.proteinG), 23);
});

test("marks missing food links and proposed links partial instead of counting them", () => {
  const result = rollupRecipeNutrition(
    [
      {
        ingredientName: "Chicken thighs",
        quantity: 1,
        unit: "lb",
        food: chicken,
        foodLinkStatus: "confirmed",
      },
      {
        ingredientName: "Garlic",
        quantity: 2,
        unit: "cloves",
        food: garlic,
        foodLinkStatus: "proposed",
      },
      {
        ingredientName: "Mystery sauce",
        quantity: 2,
        unit: "tbsp",
        food: null,
        foodLinkStatus: null,
      },
    ],
    4,
  );

  assert.equal(result.partial, true);
  assert.equal(result.countedLines, 1);
  // Two non-optional lines couldn't be counted; this is the denominator the CLI
  // shows so a partial per-serving number isn't read as authoritative.
  assert.equal(result.missedLines, 2);
  assert.match(result.reasons.join("\n"), /Garlic: food link awaiting confirmation/);
  assert.match(result.reasons.join("\n"), /Mystery sauce: no confirmed food link/);
});

test("missing servings alone does not count as a missed line", () => {
  const result = rollupRecipeNutrition(
    [
      {
        ingredientName: "Chicken thighs",
        quantity: 100,
        unit: "g",
        food: chicken,
        foodLinkStatus: "confirmed",
      },
    ],
    null,
  );

  // Every line counted; only the recipe-level servings gap is missing.
  assert.equal(result.countedLines, 1);
  assert.equal(result.missedLines, 0);
  assert.equal(result.partial, true);
});

test("marks unconvertible quantities partial and keeps known macro totals", () => {
  const result = rollupRecipeNutrition(
    [
      {
        ingredientName: "Chicken thighs",
        quantity: 1,
        unit: "lb",
        food: chicken,
        foodLinkStatus: "confirmed",
      },
      {
        ingredientName: "Garlic",
        quantity: 2,
        unit: "cloves",
        food: garlic,
        foodLinkStatus: "confirmed",
      },
    ],
    4,
  );

  assert.equal(result.partial, true);
  assert.equal(result.countedLines, 1);
  assert.ok(result.total);
  assert.match(result.reasons.join("\n"), /Garlic: cloves needs grams_per_each/);
});

test("uses ingredient conversion hints and skips optional lines", () => {
  const result = rollupRecipeNutrition(
    [
      {
        ingredientName: "Garlic",
        quantity: 2,
        unit: "cloves",
        food: garlic,
        foodLinkStatus: "confirmed",
        gramsPerEach: 3,
      },
      {
        ingredientName: "Red pepper flakes",
        quantity: null,
        unit: null,
        optional: true,
        food: { calories: 318, proteinG: 12, carbsG: 57, fatG: 17 },
        foodLinkStatus: "confirmed",
      },
    ],
    2,
  );

  assert.equal(result.partial, false);
  assert.equal(result.countedLines, 1);
  assert.equal(result.skippedOptionalLines, 1);
  assert.equal(Math.round(result.total?.calories ?? 0), 9);
});

test("requires servings before per-serving macros are reported", () => {
  const result = rollupRecipeNutrition(
    [
      {
        ingredientName: "Chicken thighs",
        quantity: 100,
        unit: "g",
        food: chicken,
        foodLinkStatus: "confirmed",
      },
    ],
    null,
  );

  assert.equal(result.partial, true);
  assert.equal(result.perServing, null);
  assert.match(result.reasons.join("\n"), /missing servings/);
});
