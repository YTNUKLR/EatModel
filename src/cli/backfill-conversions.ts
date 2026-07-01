import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Db } from "../db/db";
import { parseFdcPortions, derivePortionHints, type FdcPortion } from "../parser/fdc-portions";

// Load .env only for EATMODEL_DB; this CLI never calls the network — portion data
// is a local bulk download (ARCHITECTURE §11 2026-07-01, Lever C).
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

const USAGE = `Backfill ingredient conversion hints (density / grams-per-each) from USDA FDC portion data.

  npm run backfill-conversions -- <dir> [<dir> ...]

Each <dir> is an UNZIPPED FDC CSV bundle containing food_portion.csv + measure_unit.csv
(the same bundles used by import-foods). Only confirmed food links are touched, and only a
hint that is still empty is filled — a hand-set density/each is never overwritten.`;

export interface BackfillSummary {
  considered: number;
  noPortionData: number;
  densitySet: number;
  gramsPerEachSet: number;
}

/** Read the portion files from each bundle dir and merge into one fdc_id → portions map. */
export function loadPortions(dirs: string[]): Map<string, FdcPortion[]> {
  const merged = new Map<string, FdcPortion[]>();
  for (const dir of dirs) {
    const portionPath = path.join(dir, "food_portion.csv");
    const measurePath = path.join(dir, "measure_unit.csv");
    for (const p of [portionPath, measurePath]) {
      if (!fs.existsSync(p)) throw new Error(`missing ${p} — is "${dir}" an unzipped FDC CSV bundle?`);
    }
    const map = parseFdcPortions(
      fs.readFileSync(portionPath, "utf8"),
      fs.readFileSync(measurePath, "utf8"),
    );
    for (const [fdcId, portions] of map) {
      const existing = merged.get(fdcId);
      if (existing) existing.push(...portions);
      else merged.set(fdcId, portions);
    }
  }
  return merged;
}

/**
 * For each confirmed-linked ingredient, derive hints from its food's portions and
 * fill only the ones still empty. Pure of argv/env so it's testable over an
 * in-memory Db.
 */
export function runBackfillConversions(db: Db, portionsByFdc: Map<string, FdcPortion[]>): BackfillSummary {
  const summary: BackfillSummary = { considered: 0, noPortionData: 0, densitySet: 0, gramsPerEachSet: 0 };

  for (const ref of db.confirmedLinkedFoodRefs()) {
    summary.considered++;
    const portions = portionsByFdc.get(ref.fdcId);
    if (!portions || portions.length === 0) {
      summary.noPortionData++;
      continue;
    }
    const hints = derivePortionHints(portions);
    if (ref.densityGPerMl == null && hints.densityGPerMl != null) {
      db.setIngredientDensity(ref.ingredientId, hints.densityGPerMl);
      summary.densitySet++;
    }
    if (ref.gramsPerEach == null && hints.gramsPerEach != null) {
      db.setIngredientGramsPerEach(ref.ingredientId, hints.gramsPerEach);
      summary.gramsPerEachSet++;
    }
  }
  return summary;
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
    const portions = loadPortions(dirs);
    const s = runBackfillConversions(db, portions);
    console.log(
      `Backfill from ${dirs.length} bundle(s): considered ${s.considered} confirmed-linked ingredient(s)`,
    );
    console.log(
      `  set density on ${s.densitySet}, grams-per-each on ${s.gramsPerEachSet}` +
        (s.noPortionData ? `; ${s.noPortionData} had no portion data (left as gaps)` : ""),
    );
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
