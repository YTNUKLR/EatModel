import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFdcPortions, derivePortionHints, type FdcPortion } from "./fdc-portions";

const p = (fields: Partial<FdcPortion>): FdcPortion => ({
  amount: fields.amount ?? 1,
  unitName: fields.unitName ?? "",
  modifier: fields.modifier ?? "",
  gramWeight: fields.gramWeight ?? 0,
});

test("derives density from a volume portion (unit in the modifier)", () => {
  // 1 cup flour = 125 g → 125 / 236.588 ≈ 0.528 g/ml
  const hints = derivePortionHints([p({ modifier: "cup", gramWeight: 125 })]);
  assert.ok(Math.abs(hints.densityGPerMl! - 125 / 236.5882365) < 1e-6);
  assert.equal(hints.gramsPerEach, null);
});

test("medians multiple volume portions, robust to a packed/sliced outlier", () => {
  // chopped: cup 160 & tbsp 10 → ~0.676; sliced: cup 115 → ~0.486. median = 0.676
  const hints = derivePortionHints([
    p({ modifier: "cup, chopped", gramWeight: 160 }),
    p({ modifier: "cup, sliced", gramWeight: 115 }),
    p({ modifier: "tbsp chopped", gramWeight: 10 }),
  ]);
  assert.ok(Math.abs(hints.densityGPerMl! - 160 / 236.5882365) < 1e-6);
});

test("derives grams_per_each only from a recipe each-unit (clove), honoring amount", () => {
  const hints = derivePortionHints([
    p({ modifier: "clove", gramWeight: 3 }),
    p({ amount: 3, modifier: "cloves", gramWeight: 9 }), // 9/3 = 3
    p({ modifier: "cup", gramWeight: 136 }),
  ]);
  assert.equal(hints.gramsPerEach, 3);
  assert.ok(hints.densityGPerMl! > 0); // cup portion still gives density
});

test("does not harvest non-recipe units (medium/large/slice) as grams_per_each", () => {
  const hints = derivePortionHints([
    p({ modifier: "large", gramWeight: 150 }),
    p({ modifier: "medium (2-1/2 dia)", gramWeight: 110 }),
    p({ modifier: "slice, large", gramWeight: 38 }),
  ]);
  assert.equal(hints.gramsPerEach, null);
  assert.equal(hints.densityGPerMl, null);
});

test("parseFdcPortions joins measure_unit names and drops unusable rows", () => {
  const measure = `"id","name"\n"1000","cup"\n"9999","undetermined"`;
  const portions =
    `"id","fdc_id","amount","measure_unit_id","modifier","gram_weight"\n` +
    `"1","411","1","1000","","136"\n` + // 1 cup via measure_unit_id
    `"2","411","1","9999","clove","3"\n` + // clove via modifier
    `"3","411","0","9999","bad","0"`; // dropped: zero amount/weight
  const map = parseFdcPortions(portions, measure);
  const list = map.get("411")!;
  assert.equal(list.length, 2);
  const hints = derivePortionHints(list);
  assert.ok(Math.abs(hints.densityGPerMl! - 136 / 236.5882365) < 1e-6);
  assert.equal(hints.gramsPerEach, 3);
});
