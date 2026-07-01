import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Db, type FoodImportResult } from "../db/db";
import { parseFdcFoods } from "../parser/fdc";

// Load .env only for EATMODEL_DB; this CLI never calls the network — the food
// data is a local bulk download (ARCHITECTURE §11 2026-07-01).
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

const USAGE = `Import USDA FoodData Central reference foods into the nutrition catalog.

  npm run import-foods -- <dir> [<dir> ...]

Each <dir> is an UNZIPPED FDC CSV bundle containing food.csv + food_nutrient.csv.
Download the bundles (public domain, no API key) and unzip them first:

  SR Legacy:  https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
  Foundation: https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_csv_2026-04-30.zip

Re-running is safe: rows are keyed by fdc_id (upsert), so imports refresh, never duplicate.`;

export interface DirImportSummary {
  dir: string;
  parsed: number;
  skipped: number;
  result: FoodImportResult;
}

/**
 * Read each unzipped FDC bundle directory, parse its food.csv + food_nutrient.csv,
 * and import the reference foods into `db`. Pure of argv/env so it's testable over
 * a temp dir + in-memory Db. Fails loud if a required CSV is missing.
 */
export function importFoodsFromDirs(dirs: string[], db: Db): DirImportSummary[] {
  return dirs.map((dir) => {
    const foodPath = path.join(dir, "food.csv");
    const nutrientPath = path.join(dir, "food_nutrient.csv");
    for (const p of [foodPath, nutrientPath]) {
      if (!fs.existsSync(p)) {
        throw new Error(`missing ${p} — is "${dir}" an unzipped FDC CSV bundle?`);
      }
    }
    const { foods, skipped } = parseFdcFoods(
      fs.readFileSync(foodPath, "utf8"),
      fs.readFileSync(nutrientPath, "utf8"),
    );
    const result = db.importFoods(foods);
    return { dir, parsed: foods.length, skipped: skipped.length, result };
  });
}

function main(): void {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const db = new Db(DB_PATH);
  try {
    const before = db.listFoods().length;
    const summaries = importFoodsFromDirs(dirs, db);

    let inserted = 0;
    let updated = 0;
    let skippedLinked = 0;
    let skippedDup = 0;
    for (const s of summaries) {
      console.log(
        `${s.dir}: parsed ${s.parsed}, skipped ${s.skipped} (incomplete macros) → ` +
          `+${s.result.inserted} new, ${s.result.updated} updated`,
      );
      inserted += s.result.inserted;
      updated += s.result.updated;
      skippedLinked += s.result.skippedLinkedCollision;
      skippedDup += s.result.skippedDuplicateDescription;
    }

    const after = db.listFoods().length;
    console.log(
      `\nCatalog: ${before} → ${after} foods  ` +
        `(+${inserted} new, ${updated} updated)`,
    );
    if (skippedLinked || skippedDup) {
      console.log(
        `Skipped on description collision: ${skippedLinked} linked-seed (kept), ` +
          `${skippedDup} duplicate.`,
      );
    }
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
