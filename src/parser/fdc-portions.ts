import { normalizeName, volumeMlPerUnit, isEachUnit } from "../shared/units";
import { parseCsvRecords } from "./fdc";

/**
 * Pure derivation of ingredient conversion hints from USDA FDC portion data
 * (ARCHITECTURE §11 2026-07-01, Lever C). No I/O — the CLI reads the unzipped
 * `food_portion.csv` + `measure_unit.csv` and hands their text here.
 *
 * A portion row says "`amount` of some measure of this food weighs `gram_weight`
 * grams" (e.g. "1 cup = 240 g", "1 clove = 3 g"). We invert the volume ones into
 * a density and the each ones into a per-item weight — the exact hints
 * `quantityToGrams` needs. Reality wrinkle: SR Legacy leaves `measure_unit_id`
 * as 9999 ("undetermined") and names the unit in the free-text `modifier`, so we
 * scan `measure-unit-name + modifier` for a unit token rather than trusting the id.
 */

export interface FdcPortion {
  amount: number;
  /** Resolved measure-unit name (may be "undetermined"); the real unit is often in `modifier`. */
  unitName: string;
  modifier: string;
  gramWeight: number;
}

export interface ConversionHints {
  densityGPerMl: number | null;
  gramsPerEach: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Parse the two portion files into a map of `fdc_id → portions`. `measure_unit.csv`
 * is small (id → name); `food_portion.csv` is the bulk. Rows missing a usable
 * amount/gram weight are dropped.
 */
export function parseFdcPortions(
  foodPortionCsv: string,
  measureUnitCsv: string,
): Map<string, FdcPortion[]> {
  const unitName = new Map<string, string>();
  for (const u of parseCsvRecords(measureUnitCsv)) {
    if (u["id"]) unitName.set(u["id"].trim(), (u["name"] ?? "").trim());
  }

  const byFood = new Map<string, FdcPortion[]>();
  for (const p of parseCsvRecords(foodPortionCsv)) {
    const fdcId = p["fdc_id"]?.trim();
    if (!fdcId) continue;
    const amount = Number(p["amount"]);
    const gramWeight = Number(p["gram_weight"]);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(gramWeight) || gramWeight <= 0) {
      continue;
    }
    const portion: FdcPortion = {
      amount,
      unitName: unitName.get((p["measure_unit_id"] ?? "").trim()) ?? "",
      modifier: p["modifier"] ?? "",
      gramWeight,
    };
    const list = byFood.get(fdcId);
    if (list) list.push(portion);
    else byFood.set(fdcId, [portion]);
  }
  return byFood;
}

/**
 * Derive {density, gramsPerEach} from a food's portions. Density from volume
 * portions (median, robust to "cup, chopped" vs "cup, sliced"); grams_per_each
 * only from portions naming a recipe each-unit (clove/each/item). Nothing
 * derivable → nulls (never a guessed hint).
 */
export function derivePortionHints(portions: FdcPortion[]): ConversionHints {
  const densities: number[] = [];
  const eaches: number[] = [];

  for (const p of portions) {
    // The unit may be the measure-unit name or a word inside the modifier.
    const tokens = normalizeName(`${p.unitName} ${p.modifier}`).split(" ").filter(Boolean);

    const volumeToken = tokens.find((t) => volumeMlPerUnit(t) != null);
    if (volumeToken) {
      densities.push(p.gramWeight / (p.amount * volumeMlPerUnit(volumeToken)!));
      continue;
    }
    const eachToken = tokens.find((t) => isEachUnit(t));
    if (eachToken) eaches.push(p.gramWeight / p.amount);
  }

  return { densityGPerMl: median(densities), gramsPerEach: median(eaches) };
}
