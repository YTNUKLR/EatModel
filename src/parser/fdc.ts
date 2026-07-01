import type { Macros } from "../shared/nutrition";

/**
 * Pure parsing of USDA FoodData Central bulk CSVs into reference-food rows.
 *
 * Scope + rationale live in ARCHITECTURE §11 (2026-07-01) and §6. This module
 * has NO I/O: the CLI (`cli/import-foods.ts`) reads the unzipped CSV files off
 * disk and hands their text here, so the join + macro mapping stays a pure,
 * unit-testable function over strings (mirrors the shared/ pure-core split).
 *
 * We read the two files we need from an FDC bundle:
 *   - food.csv          → fdc_id, description   (one row per food)
 *   - food_nutrient.csv → fdc_id, nutrient_id, amount   (amounts are per 100 g,
 *                         the FDC basis, so they map straight onto *_per_100g)
 * Columns are read by HEADER NAME, never by position, so a layout change across
 * FDC releases doesn't silently mis-map a macro.
 */

// FDC nutrient ids for the macro-four. Energy prefers kcal (1008); Foundation
// rows that omit it carry Atwater energies instead (specific 2048, then general
// 2047). We never read energy-as-kilojoules (1062), which would be ~4.184× off.
const ENERGY_NUTRIENT_IDS = [1008, 2048, 2047];
const PROTEIN_NUTRIENT_ID = 1003;
const FAT_NUTRIENT_ID = 1004;
const CARB_NUTRIENT_ID = 1005;

// FDC bundles ship the *final* reference foods alongside thousands of
// intermediate rows (sample_food, market_acquisition, sub_sample_food, …) that
// share descriptions and sometimes carry partial nutrients. Only these two
// data_types are the catalog we want; everything else is provenance, not food.
const REFERENCE_DATA_TYPES = new Set(["foundation_food", "sr_legacy_food"]);

export interface FdcFood {
  fdcId: string;
  description: string;
  macros: Macros;
}

export interface FdcSkip {
  fdcId: string;
  description: string;
  reason: string;
}

export interface ParseFdcResult {
  foods: FdcFood[];
  /** Foods dropped rather than guessed at — an absent/negative macro is a gap, not a zero. */
  skipped: FdcSkip[];
}

/**
 * Minimal RFC-4180 reader: quoted fields, embedded commas/newlines, and ""
 * escapes. Returns rows of raw string cells. FDC ships fully-quoted CSVs, so a
 * naive `split(",")` would corrupt any description containing a comma.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // Strip a leading UTF-8 BOM so the first header isn't "﻿fdc_id".
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ",") {
      endField();
      i++;
    } else if (c === "\n") {
      endRow();
      i++;
    } else if (c === "\r") {
      i++; // swallow CR; the following LF (or EOF) ends the row
    } else {
      field += c;
      i++;
    }
  }
  // Flush a trailing row that wasn't newline-terminated.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Parse CSV text into records keyed by the (trimmed) header row. Blank lines are dropped. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length === 1 && cells[0] === "") continue; // stray blank line
    const rec: Record<string, string> = {};
    for (let c = 0; c < keys.length; c++) rec[keys[c]!] = cells[c] ?? "";
    records.push(rec);
  }
  return records;
}

function pickEnergy(nutrients: Map<number, number> | undefined): number | null {
  if (!nutrients) return null;
  for (const id of ENERGY_NUTRIENT_IDS) {
    const v = nutrients.get(id);
    if (v != null) return v;
  }
  return null;
}

/**
 * Join food.csv + food_nutrient.csv into reference foods carrying the macro-four.
 * A food missing any macro (or with a negative amount) is SKIPPED with a reason,
 * never zero-filled — no-silent-guessing (§6). Duplicate fdc_ids keep the first.
 */
export function parseFdcFoods(foodCsv: string, foodNutrientCsv: string): ParseFdcResult {
  // fdc_id → (nutrient_id → amount per 100 g). First amount per nutrient wins.
  const byFood = new Map<string, Map<number, number>>();
  for (const n of parseCsvRecords(foodNutrientCsv)) {
    const fdcId = n["fdc_id"]?.trim();
    if (!fdcId) continue;
    const nutrientId = Number(n["nutrient_id"]);
    const amount = Number(n["amount"]);
    if (!Number.isFinite(nutrientId) || !Number.isFinite(amount)) continue;
    let m = byFood.get(fdcId);
    if (!m) {
      m = new Map();
      byFood.set(fdcId, m);
    }
    if (!m.has(nutrientId)) m.set(nutrientId, amount);
  }

  const foods: FdcFood[] = [];
  const skipped: FdcSkip[] = [];
  const seen = new Set<string>();
  for (const f of parseCsvRecords(foodCsv)) {
    if (!REFERENCE_DATA_TYPES.has((f["data_type"] ?? "").trim())) continue; // skip intermediate rows
    const fdcId = f["fdc_id"]?.trim();
    const description = (f["description"] ?? "").trim();
    if (!fdcId || description === "") continue; // malformed food row
    if (seen.has(fdcId)) continue;
    seen.add(fdcId);

    const nutrients = byFood.get(fdcId);
    const values: [keyof Macros, number | null | undefined][] = [
      ["calories", pickEnergy(nutrients)],
      ["proteinG", nutrients?.get(PROTEIN_NUTRIENT_ID)],
      ["carbsG", nutrients?.get(CARB_NUTRIENT_ID)],
      ["fatG", nutrients?.get(FAT_NUTRIENT_ID)],
    ];
    const missing = values.filter(([, v]) => v == null).map(([k]) => k);
    const negative = values.filter(([, v]) => v != null && v < 0).map(([k]) => k);
    if (missing.length || negative.length) {
      const reasons = [
        missing.length ? `missing ${missing.join("/")}` : "",
        negative.length ? `negative ${negative.join("/")}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      skipped.push({ fdcId, description, reason: reasons });
      continue;
    }

    const macros = Object.fromEntries(values) as unknown as Macros;
    foods.push({ fdcId, description, macros });
  }

  return { foods, skipped };
}
