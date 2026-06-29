import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "./db";
import type { ParsedLineItem, ReceiptParseResult } from "../shared/types";

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

  assert.deepEqual(db.totals(), { receipts: 1, ingredients: 2, priceObservations: 2 });
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
