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
