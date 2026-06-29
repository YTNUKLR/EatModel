import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db";
import type { ParsedLineItem, ReceiptParseResult } from "../shared/types";
import type { RecipeIngredientLine, RecipeParseResult } from "../shared/recipe-types";

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

  assert.deepEqual(db.totals(), { receipts: 1, ingredients: 2, priceObservations: 2, recipes: 0 });
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
