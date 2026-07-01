import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db";
import { proteinPerDollar } from "../shared/reports";
import type { ParsedLineItem, ReceiptParseResult } from "../shared/types";
import type { RecipeIngredientLine, RecipeParseResult, RecipePage } from "../shared/recipe-types";

// Each test gets its own in-memory database, so they're fully isolated and
// leave nothing on disk. Db's methods are synchronous (better-sqlite3).
function freshDb(): Db {
  return new Db(":memory:");
}

function line(description: string, fields: Partial<ParsedLineItem> = {}): ParsedLineItem {
  return {
    rawText: fields.rawText ?? description,
    description,
    quantity: fields.quantity ?? null,
    unit: fields.unit ?? null,
    unitPrice: fields.unitPrice ?? null,
    lineTotal: fields.lineTotal ?? null,
  };
}

function receipt(lines: ParsedLineItem[], store = "Test Mart"): ReceiptParseResult {
  return { store, purchasedAt: "2026-06-20", total: null, currency: "USD", lines };
}

function ingredientLine(
  ingredient: string,
  fields: Partial<RecipeIngredientLine> = {},
): RecipeIngredientLine {
  return {
    rawText: fields.rawText ?? ingredient,
    ingredient,
    quantity: fields.quantity ?? null,
    unit: fields.unit ?? null,
    prepNote: fields.prepNote ?? null,
    optional: fields.optional ?? false,
  };
}

function recipe(ingredients: RecipeIngredientLine[], title = "Test Recipe"): RecipeParseResult {
  return { title, sourceNote: "Test Book p.1", servings: 4, ingredients };
}

function page(recipes: RecipeParseResult[]): RecipePage {
  return { recipes };
}

test("persists a receipt and reports per-line outcomes", () => {
  const db = freshDb();
  const summary = db.saveReceipt(
    receipt([
      line("Chicken thighs", { unitPrice: 2.49 }),
      line("Spinach", { unitPrice: 3.99 }),
    ]),
    "a.jpg",
    "mock",
  );

  assert.ok(summary.receiptId > 0);
  assert.equal(summary.lines.length, 2);
  assert.equal(summary.newIngredients, 2);
  assert.equal(summary.priceObservations, 2);
  assert.equal(summary.lines[0]?.confidence, "new");

  assert.deepEqual(db.totals(), {
    receipts: 1,
    ingredients: 2,
    priceObservations: 2,
    recipes: 0,
    stores: 1,
  });
  db.close();
});

test("reuses ingredients across receipts instead of duplicating them", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.49 })]), "1.jpg", "mock");
  const second = db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.59 })]), "2.jpg", "mock");

  assert.equal(second.newIngredients, 0);
  assert.equal(second.lines[0]?.confidence, "alias");

  const totals = db.totals();
  assert.equal(totals.ingredients, 1); // one canonical ingredient, not two
  assert.equal(totals.receipts, 2);
  assert.equal(totals.priceObservations, 2); // but price history accrues
  db.close();
});

test("alias matching ignores case, spacing, and punctuation", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Chicken Thighs", { unitPrice: 2.49 })]), "1.jpg", "mock");
  const second = db.saveReceipt(receipt([line("  chicken   thighs! ", { unitPrice: 2.49 })]), "2.jpg", "mock");

  assert.equal(second.lines[0]?.confidence, "alias");
  assert.equal(db.totals().ingredients, 1);
  db.close();
});

test("derives a unit price from line total ÷ quantity when none is printed", () => {
  const db = freshDb();
  const summary = db.saveReceipt(
    receipt([line("Bananas", { quantity: 2, lineTotal: 8.5 })]), // no unitPrice
    "a.jpg",
    "mock",
  );

  assert.equal(summary.lines[0]?.unitPrice, 4.25);
  assert.equal(summary.lines[0]?.pricedObserved, true);
  assert.equal(summary.priceObservations, 1);
  db.close();
});

test("tracks ingested image hashes for idempotency", () => {
  const db = freshDb();
  assert.equal(db.hasReceipt("abc123"), false);
  db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.49 })]), "a.jpg", "mock", "abc123");
  assert.equal(db.hasReceipt("abc123"), true);
  assert.equal(db.hasReceipt("other"), false);
  db.close();
});

test("the unique image hash backstops double ingestion", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Spinach", { unitPrice: 3.99 })]), "a.jpg", "mock", "dup");
  assert.throws(() =>
    db.saveReceipt(receipt([line("Spinach", { unitPrice: 3.99 })]), "a.jpg", "mock", "dup"),
  );
  db.close();
});

test("does not fabricate a unit when the receipt omits it", () => {
  const db = freshDb();
  const summary = db.saveReceipt(
    receipt([line("Loose item", { unitPrice: 1.0 })]), // unit omitted
    "a.jpg",
    "mock",
  );
  assert.equal(summary.lines[0]?.unit, null); // not "each"
  assert.equal(summary.lines[0]?.pricedObserved, true);
  db.close();
});

test("records the line but no price observation when nothing is priced", () => {
  const db = freshDb();
  const summary = db.saveReceipt(receipt([line("Mystery item")]), "a.jpg", "mock");

  assert.equal(summary.lines.length, 1); // line is still saved...
  assert.equal(summary.lines[0]?.pricedObserved, false);
  assert.equal(summary.priceObservations, 0); // ...with no price observation

  const totals = db.totals();
  assert.equal(totals.ingredients, 1); // ingredient still created
  assert.equal(totals.priceObservations, 0);
  db.close();
});

// --- Recipes -------------------------------------------------------------

test("persists a recipe and reports per-line outcomes", () => {
  const db = freshDb();
  const summary = db.saveRecipe(
    recipe([
      ingredientLine("Chicken thighs", { quantity: 1.5, unit: "lb" }),
      ingredientLine("Garlic", { quantity: 2, unit: "clove", prepNote: "minced" }),
      ingredientLine("Red pepper flakes", { optional: true }),
    ]),
    "r.jpg",
    "mock",
  );

  assert.ok(summary.recipeId > 0);
  assert.equal(summary.lines.length, 3);
  assert.equal(summary.newIngredients, 3);
  assert.equal(summary.lines[0]?.confidence, "new");
  assert.equal(summary.lines[2]?.optional, true);

  const totals = db.totals();
  assert.equal(totals.recipes, 1);
  assert.equal(totals.ingredients, 3);
  assert.equal(totals.priceObservations, 0); // recipes never create price facts
  db.close();
});

test("recipe ingredients resolve to the shared spine, not a parallel one", () => {
  const db = freshDb();
  // An ingredient first seen on a receipt...
  db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.49 })]), "a.jpg", "mock");
  // ...is matched (not duplicated) when it later appears in a recipe.
  const r = db.saveRecipe(recipe([ingredientLine("Chicken thighs", { quantity: 1, unit: "lb" })]), "r.jpg", "mock");

  assert.equal(r.lines[0]?.confidence, "alias");
  assert.equal(r.newIngredients, 0);
  assert.equal(db.totals().ingredients, 1); // one canonical ingredient across both sources
  db.close();
});

test("recipe alias matching ignores case, spacing, and punctuation", () => {
  const db = freshDb();
  db.saveRecipe(recipe([ingredientLine("Garlic")]), "1.jpg", "mock");
  const second = db.saveRecipe(recipe([ingredientLine("  GARLIC! ")]), "2.jpg", "mock");

  assert.equal(second.lines[0]?.confidence, "alias");
  assert.equal(db.totals().ingredients, 1);
  db.close();
});

test("tracks ingested recipe image hashes for idempotency", () => {
  const db = freshDb();
  assert.equal(db.hasRecipe("rhash"), false);
  db.saveRecipe(recipe([ingredientLine("Garlic")]), "r.jpg", "mock", "rhash");
  assert.equal(db.hasRecipe("rhash"), true);
  assert.equal(db.hasRecipe("other"), false);
  db.close();
});

test("the unique recipe image hash backstops double ingestion", () => {
  const db = freshDb();
  db.saveRecipe(recipe([ingredientLine("Garlic")]), "r.jpg", "mock", "dup");
  assert.throws(() => db.saveRecipe(recipe([ingredientLine("Garlic")]), "r.jpg", "mock", "dup"));
  db.close();
});

test("one image yields multiple recipes under a single ingest", () => {
  const db = freshDb();
  const summary = db.saveRecipePage(
    page([
      recipe([ingredientLine("Chicken thighs"), ingredientLine("Garlic")], "Chicken dish"),
      recipe([ingredientLine("Brown rice"), ingredientLine("Garlic")], "Rice dish"),
    ]),
    "spread.jpg",
    "mock",
    "pagehash",
  );

  assert.equal(summary.recipes.length, 2);
  assert.equal(summary.recipes[0]?.title, "Chicken dish");
  assert.equal(summary.recipes[1]?.title, "Rice dish");

  const totals = db.totals();
  assert.equal(totals.recipes, 2); // two recipe rows...
  // ...but Garlic is shared across both recipes → 3 canonical ingredients, not 4.
  assert.equal(totals.ingredients, 3);
  assert.equal(summary.newIngredients, 3); // unique new ingredients across the page
  // The second recipe's Garlic resolved to the first's alias.
  assert.equal(summary.recipes[1]?.lines.find((l) => l.ingredient === "Garlic")?.confidence, "alias");
  db.close();
});

test("a whole multi-recipe page dedups on the one image hash", () => {
  const db = freshDb();
  const spread = page([recipe([ingredientLine("Garlic")]), recipe([ingredientLine("Basil")])]);
  assert.equal(db.hasRecipe("h"), false);
  db.saveRecipePage(spread, "spread.jpg", "mock", "h");
  assert.equal(db.hasRecipe("h"), true); // the image (not each recipe) is the dedup unit
  assert.throws(() => db.saveRecipePage(spread, "spread.jpg", "mock", "h"));
  db.close();
});

test("refuses to save a recipe page with an empty recipe", () => {
  const db = freshDb();
  assert.throws(
    () => db.saveRecipePage(page([recipe([], "Empty recipe")]), "bad.jpg", "mock", "bad"),
    /no ingredients/,
  );
  assert.equal(db.hasRecipe("bad"), false);
  assert.equal(db.totals().recipes, 0);
  db.close();
});

// --- Review gate ---------------------------------------------------------

test("new ingredients start unconfirmed and confirm() promotes them", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.49 })]), "a.jpg", "mock");

  const before = db.listUnconfirmedIngredients();
  assert.equal(before.length, 1);
  assert.equal(before[0]?.canonicalName, "Chicken thighs");

  db.confirmIngredient(before[0]!.id);
  assert.equal(db.listUnconfirmedIngredients().length, 0); // no longer pending
  db.close();
});

test("a flagged line is stored but never becomes a price observation", () => {
  const db = freshDb();
  // Empty description and a negative price — both untrustworthy.
  const summary = db.saveReceipt(
    receipt([line("", { unitPrice: -2 })]),
    "a.jpg",
    "mock",
  );

  assert.equal(summary.lines[0]?.needsReview, true);
  assert.equal(summary.lines[0]?.ingredientId, null);
  assert.equal(summary.lines[0]?.confidence, "unmatched");
  assert.equal(summary.lines[0]?.pricedObserved, false); // not trusted as a fact
  assert.equal(summary.priceObservations, 0);
  assert.equal(db.totals().ingredients, 0); // a bad identity never hardens into the spine
  assert.equal(db.totals().priceObservations, 0);

  const flagged = db.listLinesNeedingReview();
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]?.source, "receipt");
  db.close();
});

test("a valid identity with a bad number is flagged but still attached to the spine", () => {
  const db = freshDb();
  const summary = db.saveReceipt(
    receipt([line("Spinach", { unitPrice: -2 })]),
    "a.jpg",
    "mock",
  );

  assert.equal(summary.lines[0]?.needsReview, true);
  assert.ok(summary.lines[0]?.ingredientId);
  assert.equal(summary.lines[0]?.confidence, "new");
  assert.equal(summary.lines[0]?.pricedObserved, false);
  assert.equal(db.totals().ingredients, 1);
  assert.equal(db.totals().priceObservations, 0);
  db.close();
});

test("a recipe line with an invalid identity is stored without creating an ingredient", () => {
  const db = freshDb();
  const summary = db.saveRecipe(
    recipe([ingredientLine("!!!")]),
    "bad.jpg",
    "mock",
  );

  assert.equal(summary.lines[0]?.needsReview, true);
  assert.equal(summary.lines[0]?.ingredientId, null);
  assert.equal(summary.lines[0]?.confidence, "unmatched");
  assert.equal(db.totals().ingredients, 0);
  assert.equal(db.listLinesNeedingReview()[0]?.source, "recipe");
  db.close();
});

test("a receipt whose lines exceed the total is flagged for review", () => {
  const db = freshDb();
  const r: ReceiptParseResult = {
    store: "Test Mart",
    purchasedAt: "2026-06-20",
    total: 5.0,
    currency: "USD",
    lines: [line("A", { lineTotal: 3.74 }), line("B", { lineTotal: 3.99 })], // sum 7.73 > 5.00
  };
  const summary = db.saveReceipt(r, "a.jpg", "mock");

  assert.equal(summary.needsReview, true);
  assert.match(summary.reviewReason ?? "", /exceed/);
  assert.equal(db.listReceiptsNeedingReview().length, 1);
  db.close();
});

test("reviewed line and receipt flags can be resolved", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("", { unitPrice: -2 })]), "line.jpg", "mock");
  const lineReview = db.listLinesNeedingReview()[0];
  assert.ok(lineReview);

  db.resolveLineReview(lineReview.source, lineReview.lineId);
  assert.equal(db.listLinesNeedingReview().length, 0);

  db.saveReceipt(
    {
      store: "Test Mart",
      purchasedAt: "2026-06-20",
      total: 5,
      currency: "USD",
      lines: [line("A", { lineTotal: 6 })],
    },
    "receipt.jpg",
    "mock",
  );
  const receiptReview = db.listReceiptsNeedingReview()[0];
  assert.ok(receiptReview);

  db.resolveReceiptReview(receiptReview.id);
  assert.equal(db.listReceiptsNeedingReview().length, 0);
  db.close();
});

test("receipt stores start unconfirmed and exact aliases reuse the same store", () => {
  const db = freshDb();
  const first = db.saveReceipt(
    receipt([line("Chicken thighs", { unitPrice: 2.49 })], "Demo Market"),
    "a.jpg",
    "mock",
  );
  const second = db.saveReceipt(
    receipt([line("Spinach", { unitPrice: 3.99 })], "  demo market! "),
    "b.jpg",
    "mock",
  );

  assert.equal(first.storeConfidence, "new");
  assert.equal(first.newStores, 1);
  assert.ok(first.storeId);
  assert.equal(second.storeConfidence, "alias");
  assert.equal(second.newStores, 0);
  assert.equal(second.storeId, first.storeId);
  assert.equal(db.totals().stores, 1);

  const [store] = db.listUnconfirmedStores();
  assert.equal(store?.canonicalName, "Demo Market");
  assert.equal(store?.aliases, 1);
  assert.equal(store?.receipts, 2);
  db.confirmStore(store!.id);
  assert.equal(db.listUnconfirmedStores().length, 0);
  db.close();
});

test("null or invalid store text stays unmatched instead of minting a store", () => {
  const db = freshDb();
  const summary = db.saveReceipt(
    { ...receipt([line("Spinach", { unitPrice: 3.99 })]), store: null },
    "a.jpg",
    "mock",
  );

  assert.equal(summary.storeId, null);
  assert.equal(summary.storeConfidence, "unmatched");
  assert.equal(summary.newStores, 0);
  assert.equal(db.totals().stores, 0);
  db.close();
});

test("merge folds a fragment store into another while preserving receipt links", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.49 })], "Walmart"), "a.jpg", "mock");
  db.saveReceipt(receipt([line("Chicken thigh", { unitPrice: 2.59 })], "WAL-MART #1234"), "b.jpg", "mock");
  assert.equal(db.totals().stores, 2);

  const [frag, keep] = db.listUnconfirmedStores(); // newest first: WAL-MART #1234, Walmart
  db.mergeStore(frag!.id, keep!.id);

  const totals = db.totals();
  assert.equal(totals.stores, 1);
  assert.equal(totals.priceObservations, 2);
  const [remaining] = db.listUnconfirmedStores();
  assert.equal(remaining?.canonicalName, "Walmart");
  assert.equal(remaining?.aliases, 2);
  assert.equal(remaining?.receipts, 2);
  db.close();
});

test("store merge rejects self-merge and unknown ids", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Salt", { unitPrice: 1 })], "Test Mart"), "a.jpg", "mock");
  const [only] = db.listUnconfirmedStores();
  assert.throws(() => db.mergeStore(only!.id, only!.id), /itself/);
  assert.throws(() => db.mergeStore(only!.id, 9999), /no store/);
  db.close();
});

test("merge folds a fragment ingredient into another, preserving price history", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Chicken thighs", { unitPrice: 2.49 })]), "a.jpg", "mock");
  db.saveReceipt(receipt([line("Chicken thigh", { unitPrice: 2.59 })]), "b.jpg", "mock");
  assert.equal(db.totals().ingredients, 2); // fragmented: didn't converge on exact match

  const [frag, keep] = db.listUnconfirmedIngredients(); // newest first: "Chicken thigh", "Chicken thighs"
  db.mergeIngredient(frag!.id, keep!.id);

  const totals = db.totals();
  assert.equal(totals.ingredients, 1); // de-fragmented
  assert.equal(totals.priceObservations, 2); // both observations survive under the kept ingredient
  db.close();
});

test("merge rejects self-merge and unknown ids", () => {
  const db = freshDb();
  db.saveReceipt(receipt([line("Salt", { unitPrice: 1 })]), "a.jpg", "mock");
  const [only] = db.listUnconfirmedIngredients();
  assert.throws(() => db.mergeIngredient(only!.id, only!.id), /itself/);
  assert.throws(() => db.mergeIngredient(only!.id, 9999), /no ingredient/);
  db.close();
});

// --- delete-recipe -------------------------------------------------------

test("delete-recipe removes the recipe, orphaned ingredients, and empty ingest", () => {
  const db = freshDb();
  // One image, two recipes sharing "Garlic"; the second also has "Basil".
  const summary = db.saveRecipePage(
    page([
      recipe([ingredientLine("Garlic"), ingredientLine("Oregano")], "Keep"),
      recipe([ingredientLine("Garlic"), ingredientLine("Basil")], "Junk"),
    ]),
    "spread.jpg",
    "mock",
    "h",
  );
  assert.equal(db.totals().ingredients, 3); // Garlic (shared), Oregano, Basil
  const junk = summary.recipes[1]!;

  const result = db.deleteRecipe(junk.recipeId);

  assert.equal(result.deletedIngest, false); // sibling recipe still on the image
  const totals = db.totals();
  assert.equal(totals.recipes, 1); // only "Keep" survives
  // Basil was unique to the junk recipe → orphaned and removed; Garlic is shared → kept.
  assert.equal(totals.ingredients, 2); // Garlic + Oregano
  assert.deepEqual(
    result.deletedIngredientIds.length,
    1,
    "exactly one orphan (Basil) removed",
  );
  assert.ok(!db.listUnconfirmedIngredients().some((i) => i.canonicalName === "Basil"));
  assert.ok(db.listUnconfirmedIngredients().some((i) => i.canonicalName === "Garlic"));
  db.close();
});

test("delete-recipe drops the ingest when it was the image's last recipe", () => {
  const db = freshDb();
  const s = db.saveRecipe(recipe([ingredientLine("Nutmeg")]), "solo.jpg", "mock", "solo");
  assert.equal(db.hasRecipe("solo"), true);

  const result = db.deleteRecipe(s.recipeId);

  assert.equal(result.deletedIngest, true);
  assert.equal(db.hasRecipe("solo"), false); // ingest gone → image could be re-ingested
  assert.equal(db.totals().recipes, 0);
  assert.equal(db.totals().ingredients, 0); // Nutmeg orphaned and removed
  db.close();
});

test("delete-recipe preserves a confirmed ingredient even when it orphans", () => {
  const db = freshDb();
  const s = db.saveRecipe(recipe([ingredientLine("Saffron")]), "r.jpg", "mock", "r");
  const saffronId = s.lines[0]!.ingredientId!;
  db.confirmIngredient(saffronId); // human judgment: keep it in the spine

  const result = db.deleteRecipe(s.recipeId);

  assert.deepEqual(result.deletedIngredientIds, []); // confirmed → not deleted
  assert.equal(db.totals().recipes, 0);
  assert.equal(db.totals().ingredients, 1); // Saffron survives, now unused
  db.close();
});

test("delete-recipe rejects an unknown recipe id", () => {
  const db = freshDb();
  assert.throws(() => db.deleteRecipe(9999), /no recipe/);
  db.close();
});

// --- Nutrition ----------------------------------------------------------

test("fresh databases seed a small reference food catalog", () => {
  const db = freshDb();
  const foods = db.listFoods();

  assert.ok(foods.length >= 5);
  assert.ok(foods.some((f) => f.description === "Chicken thighs, boneless skinless, raw"));
  assert.ok(db.listFoods("spinach").some((f) => f.description === "Spinach, raw"));
  db.close();
});

test("food links are proposed first and only confirmed links feed nutrition", () => {
  const db = freshDb();
  const recipeSummary = db.saveRecipe(
    recipe([ingredientLine("Chicken thighs", { quantity: 1, unit: "lb" })]),
    "r.jpg",
    "mock",
  );
  const ingredientId = recipeSummary.lines[0]!.ingredientId!;
  const chickenFood = db.listFoods("chicken")[0]!;

  db.proposeIngredientFoodLink(ingredientId, chickenFood.id);
  assert.equal(db.listProposedFoodLinks().length, 1);

  const proposed = db.recipeNutrition(recipeSummary.recipeId);
  assert.equal(proposed.nutrition.partial, true);
  assert.equal(proposed.nutrition.total, null);
  assert.match(proposed.nutrition.reasons.join("\n"), /awaiting confirmation/);

  db.confirmIngredientFoodLink(ingredientId);
  assert.equal(db.listProposedFoodLinks().length, 0);
  const confirmed = db.recipeNutrition(recipeSummary.recipeId);
  assert.equal(confirmed.nutrition.partial, false);
  assert.equal(Math.round(confirmed.nutrition.total?.calories ?? 0), 649);
  assert.equal(Math.round(confirmed.nutrition.perServing?.calories ?? 0), 162);
  db.close();
});

test("review can list confirmed ingredients that still need food links", () => {
  const db = freshDb();
  db.saveRecipe(recipe([ingredientLine("Chicken thighs")]), "r.jpg", "mock");
  const [ingredient] = db.listUnconfirmedIngredients();

  assert.equal(db.listIngredientsMissingFoodLink().length, 0);
  db.confirmIngredient(ingredient!.id);

  const missing = db.listIngredientsMissingFoodLink();
  assert.equal(missing.length, 1);
  assert.equal(missing[0]?.canonicalName, "Chicken thighs");
  db.close();
});

test("recipe nutrition reports partial conversion gaps and uses per-each hints", () => {
  const db = freshDb();
  const recipeSummary = db.saveRecipe(
    recipe([ingredientLine("Garlic", { quantity: 2, unit: "cloves" })]),
    "r.jpg",
    "mock",
  );
  const ingredientId = recipeSummary.lines[0]!.ingredientId!;
  const garlicFood = db.listFoods("garlic")[0]!;
  db.proposeIngredientFoodLink(ingredientId, garlicFood.id);
  db.confirmIngredientFoodLink(ingredientId);

  const before = db.recipeNutrition(recipeSummary.recipeId);
  assert.equal(before.nutrition.partial, true);
  assert.match(before.nutrition.reasons.join("\n"), /cloves needs grams_per_each/);

  db.setIngredientGramsPerEach(ingredientId, 3);
  const after = db.recipeNutrition(recipeSummary.recipeId);
  assert.equal(after.nutrition.partial, false);
  assert.equal(Math.round(after.nutrition.total?.calories ?? 0), 9);
  db.close();
});

test("merge preserves food links and conversion hints when the kept ingredient lacks them", () => {
  const db = freshDb();
  db.saveRecipe(recipe([ingredientLine("Garlic", { quantity: 2, unit: "cloves" })]), "a.jpg", "mock");
  db.saveRecipe(recipe([ingredientLine("Garlic cloves", { quantity: 2, unit: "cloves" })]), "b.jpg", "mock");

  const [from, into] = db.listUnconfirmedIngredients(); // newest first: Garlic cloves, Garlic
  const garlicFood = db.listFoods("garlic")[0]!;
  db.proposeIngredientFoodLink(from!.id, garlicFood.id);
  db.confirmIngredientFoodLink(from!.id);
  db.setIngredientGramsPerEach(from!.id, 3);

  db.mergeIngredient(from!.id, into!.id);

  const nutrition = db.recipeNutrition(2);
  assert.equal(nutrition.nutrition.partial, false);
  assert.equal(Math.round(nutrition.nutrition.total?.calories ?? 0), 9);
  db.close();
});
