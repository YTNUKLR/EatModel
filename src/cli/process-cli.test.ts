import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { processReceipts } from "./process-receipts";
import { processRecipes } from "./process-recipes";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eatmodel-cli-"));
}

function shortHash(contents: string): string {
  return crypto.createHash("sha256").update(contents).digest("hex").slice(0, 12);
}

async function withQuietConsole(run: () => Promise<void>): Promise<void> {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    await run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

test("receipt CLI drains the inbox, stores data, and hash-prefixes processed files", async () => {
  const root = tmpRoot();
  const inbox = path.join(root, "receipts", "inbox");
  const processed = path.join(root, "receipts", "processed");
  const failed = path.join(root, "receipts", "failed");
  const dbPath = path.join(root, "data", "eatmodel.db");
  fs.mkdirSync(inbox, { recursive: true });

  fs.writeFileSync(path.join(inbox, "IMG_0001.jpg"), "first image");
  await withQuietConsole(() => processReceipts({
    EATMODEL_PARSER: "mock",
    EATMODEL_INBOX: inbox,
    EATMODEL_PROCESSED: processed,
    EATMODEL_FAILED: failed,
    EATMODEL_DB: dbPath,
  }));

  assert.deepEqual(fs.readdirSync(inbox), []);
  assert.deepEqual(fs.readdirSync(processed), [`${shortHash("first image")}-IMG_0001.jpg`]);

  // Same basename, different content: should not overwrite the first original.
  fs.writeFileSync(path.join(inbox, "IMG_0001.jpg"), "second image");
  await withQuietConsole(() => processReceipts({
    EATMODEL_PARSER: "mock",
    EATMODEL_INBOX: inbox,
    EATMODEL_PROCESSED: processed,
    EATMODEL_FAILED: failed,
    EATMODEL_DB: dbPath,
  }));

  assert.deepEqual(fs.readdirSync(processed).sort(), [
    `${shortHash("first image")}-IMG_0001.jpg`,
    `${shortHash("second image")}-IMG_0001.jpg`,
  ].sort());

  const raw = new Database(dbPath);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n, 2);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM ingredients").get() as { n: number }).n, 3);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM price_observations").get() as { n: number }).n, 6);
  raw.close();
});

test("recipe CLI drains one image into one ingest and multiple recipes", async () => {
  const root = tmpRoot();
  const inbox = path.join(root, "recipes", "inbox");
  const processed = path.join(root, "recipes", "processed");
  const failed = path.join(root, "recipes", "failed");
  const dbPath = path.join(root, "data", "eatmodel.db");
  fs.mkdirSync(inbox, { recursive: true });

  fs.writeFileSync(path.join(inbox, "spread.jpg"), "recipe spread");
  await withQuietConsole(() => processRecipes({
    EATMODEL_RECIPE_PARSER: "mock",
    EATMODEL_RECIPE_INBOX: inbox,
    EATMODEL_RECIPE_PROCESSED: processed,
    EATMODEL_RECIPE_FAILED: failed,
    EATMODEL_DB: dbPath,
  }));

  assert.deepEqual(fs.readdirSync(inbox), []);
  assert.deepEqual(fs.readdirSync(processed), [`${shortHash("recipe spread")}-spread.jpg`]);

  const raw = new Database(dbPath);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM recipe_ingests").get() as { n: number }).n, 1);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM recipes").get() as { n: number }).n, 2);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM recipe_ingredients").get() as { n: number }).n, 7);
  raw.close();
});
