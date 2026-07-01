import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFoodsFromDirs } from "./import-foods";
import { Db } from "../db/db";

function bundleDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eatmodel-fdc-"));
}

const FOOD_CSV = `"fdc_id","data_type","description"
"111","sr_legacy_food","Kale, raw"
"222","sr_legacy_food","Quinoa, uncooked"`;

const FOOD_NUTRIENT_CSV = `"id","fdc_id","nutrient_id","amount"
"1","111","1008","49"
"2","111","1003","4.3"
"3","111","1005","8.8"
"4","111","1004","0.9"
"5","222","1008","368"
"6","222","1003","14.1"
"7","222","1005","64.2"
"8","222","1004","6.1"`;

function writeBundle(dir: string): void {
  fs.writeFileSync(path.join(dir, "food.csv"), FOOD_CSV);
  fs.writeFileSync(path.join(dir, "food_nutrient.csv"), FOOD_NUTRIENT_CSV);
}

test("importFoodsFromDirs reads a bundle dir and loads foods into the catalog", () => {
  const dir = bundleDir();
  writeBundle(dir);
  const db = new Db(":memory:");

  const summaries = importFoodsFromDirs([dir], db);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]!.parsed, 2);
  assert.equal(summaries[0]!.result.inserted, 2);

  const kale = db.listFoods("kale")[0]!;
  assert.equal(kale.source, "usda_fdc");
  assert.equal(kale.fdcId, "111");
  assert.equal(kale.nutrition.calories, 49);
  db.close();
});

test("importFoodsFromDirs fails loud when a required CSV is missing", () => {
  const dir = bundleDir(); // empty — no food.csv
  const db = new Db(":memory:");
  assert.throws(() => importFoodsFromDirs([dir], db), /missing .*food\.csv/);
  db.close();
});
