import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Db } from "./db";

// Migration needs a real file (two connections must see the same db), so each
// test gets a throwaway temp path.
function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eatmodel-migrate-"));
  return path.join(dir, "old.db");
}

test("adds image_sha256 to a pre-ingestion-safety receipts table", () => {
  const file = tmpDbPath();
  // An old receipts table, before the content-hash column existed.
  const raw = new Database(file);
  raw.exec(`CREATE TABLE receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store TEXT, purchased_at TEXT, total REAL, currency TEXT,
    image_filename TEXT, parser TEXT, raw_json TEXT,
    parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  raw.prepare("INSERT INTO receipts (store) VALUES ('Old Mart')").run();
  raw.close();

  // Opening through Db should migrate the column in, not crash.
  const db = new Db(file);
  const summary = db.saveReceipt(
    { store: "New Mart", purchasedAt: null, total: null, currency: "USD", lines: [] },
    "x.jpg",
    "mock",
    "freshhash",
  );
  assert.ok(summary.receiptId > 0);
  assert.equal(db.hasReceipt("freshhash"), true); // the migrated column is queryable
  db.close();

  const migrated = new Database(file);
  const migrations = migrated
    .prepare("SELECT name FROM schema_migrations ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(
    migrations.map((m) => m.name),
    ["001_receipt_image_hash", "002_review_gate_columns", "003_foods_nutrition", "004_store_identity"],
  );
  assert.equal((migrated.prepare("SELECT COUNT(*) AS n FROM stores").get() as { n: number }).n, 2);
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) AS n FROM receipts WHERE store_id IS NOT NULL").get() as { n: number }).n,
    2,
  );
  migrated.close();
});

test("refuses to open a pre-recipe-page database and points to db:reset", () => {
  const file = tmpDbPath();
  // An old recipes table from the first recipe slice — no ingest_id column.
  const raw = new Database(file);
  raw.exec(`CREATE TABLE recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, source_note TEXT, servings REAL,
    image_filename TEXT, image_sha256 TEXT UNIQUE, parser TEXT, raw_json TEXT,
    parsed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  raw.close();

  assert.throws(() => new Db(file), /db:reset/);
});

test("fresh databases record migrations and enforce hard invariants", () => {
  const file = tmpDbPath();
  const db = new Db(file);
  db.close();

  const raw = new Database(file);
  raw.pragma("foreign_keys = ON");

  const migrations = raw
    .prepare("SELECT name FROM schema_migrations ORDER BY name")
    .all() as { name: string }[];
  assert.deepEqual(
    migrations.map((m) => m.name),
    ["001_receipt_image_hash", "002_review_gate_columns", "003_foods_nutrition", "004_store_identity"],
  );

  assert.throws(
    () => raw.prepare("INSERT INTO ingredients (canonical_name, status) VALUES ('Salt', 'bogus')").run(),
    /CHECK/,
  );
  assert.throws(
    () => raw.prepare("INSERT INTO receipts (needs_review) VALUES (7)").run(),
    /CHECK/,
  );
  assert.throws(
    () => raw.prepare("INSERT INTO stores (canonical_name, status) VALUES ('Test', 'bogus')").run(),
    /CHECK/,
  );

  const receiptId = Number(raw.prepare("INSERT INTO receipts (store) VALUES ('Test')").run().lastInsertRowid);
  assert.throws(
    () =>
      raw
        .prepare("INSERT INTO receipts (store, store_match_confidence) VALUES ('Test', 'guess')")
        .run(),
    /CHECK/,
  );
  assert.throws(
    () =>
      raw
        .prepare("INSERT INTO receipt_line_items (receipt_id, match_confidence) VALUES (?, 'guess')")
        .run(receiptId),
    /CHECK/,
  );
  assert.throws(
    () => raw.prepare("INSERT INTO recipe_ingests (recipe_count) VALUES (0)").run(),
    /CHECK/,
  );

  const ingredientId = Number(
    raw.prepare("INSERT INTO ingredients (canonical_name) VALUES ('Salt')").run().lastInsertRowid,
  );
  assert.throws(
    () =>
      raw
        .prepare("INSERT INTO price_observations (ingredient_id, unit_price) VALUES (?, -1)")
        .run(ingredientId),
    /CHECK/,
  );
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO foods
             (description, source, calories_per_100g, protein_g_per_100g, carbs_g_per_100g, fat_g_per_100g)
           VALUES ('Bad food', 'manual', -1, 0, 0, 0)`,
        )
        .run(),
    /CHECK/,
  );
  assert.throws(
    () =>
      raw
        .prepare("INSERT INTO ingredients (canonical_name, food_link_status) VALUES ('Bad link', 'confirmed')")
        .run(),
    /CHECK/,
  );

  raw.close();
});
