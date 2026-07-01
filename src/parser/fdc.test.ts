import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsvRows, parseCsvRecords, parseFdcFoods } from "./fdc";

test("parseCsvRows handles quoting, embedded commas/newlines, and escapes", () => {
  const csv = '"a","b","c"\r\n"1","x, y","line\none"\n"2","q""q",""';
  assert.deepEqual(parseCsvRows(csv), [
    ["a", "b", "c"],
    ["1", "x, y", "line\none"],
    ["2", 'q"q', ""],
  ]);
});

test("parseCsvRecords keys by header and drops blank lines", () => {
  const csv = 'fdc_id,description\n\n111,"Spinach, raw"\n';
  assert.deepEqual(parseCsvRecords(csv), [{ fdc_id: "111", description: "Spinach, raw" }]);
});

const FOOD_CSV = `"fdc_id","data_type","description","food_category_id","publication_date"
"111","sr_legacy_food","Spinach, raw","11","2019-04-01"
"222","sr_legacy_food","Olive oil","04","2019-04-01"`;

// Note: nutrient_id 1062 (energy in kJ) is present for 111 and must be ignored
// in favor of 1008 (kcal). 222 has no 1008 — only Atwater 2048 — to exercise the fallback.
const FOOD_NUTRIENT_CSV = `"id","fdc_id","nutrient_id","amount"
"1","111","1008","23"
"2","111","1062","96"
"3","111","1003","2.9"
"4","111","1005","3.6"
"5","111","1004","0.4"
"6","222","2048","884"
"7","222","1003","0"
"8","222","1005","0"
"9","222","1004","100"`;

test("parseFdcFoods joins food+nutrient rows into the macro-four per 100 g", () => {
  const { foods, skipped } = parseFdcFoods(FOOD_CSV, FOOD_NUTRIENT_CSV);
  assert.equal(skipped.length, 0);
  const spinach = foods.find((f) => f.fdcId === "111")!;
  assert.deepEqual(spinach, {
    fdcId: "111",
    description: "Spinach, raw",
    macros: { calories: 23, proteinG: 2.9, carbsG: 3.6, fatG: 0.4 },
  });
});

test("energy falls back to Atwater (2048) when kcal (1008) is absent, never kJ (1062)", () => {
  const { foods } = parseFdcFoods(FOOD_CSV, FOOD_NUTRIENT_CSV);
  const oil = foods.find((f) => f.fdcId === "222")!;
  assert.equal(oil.macros.calories, 884); // Atwater, not the 96 kJ that 111 carried
});

test("a food missing a macro is skipped with a reason, not zero-filled", () => {
  const food = `"fdc_id","data_type","description"\n"999","sr_legacy_food","Mystery powder"`;
  const nutrient = `"id","fdc_id","nutrient_id","amount"\n"1","999","1008","100"\n"2","999","1003","5"`;
  const { foods, skipped } = parseFdcFoods(food, nutrient);
  assert.equal(foods.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.fdcId, "999");
  assert.match(skipped[0]!.reason, /missing .*carbs.*fat|missing .*fat.*carbs|carbs|fat/);
});

test("only final reference rows are kept; intermediate FDC data_types are dropped", () => {
  // A sample_food row sharing a description with the real foundation_food row must
  // not shadow it (FDC bundles carry both). Both here have full macros.
  const food =
    `"fdc_id","data_type","description"\n` +
    `"500","sample_food","Almonds, raw"\n` +
    `"501","foundation_food","Almonds, raw"`;
  const nutrient =
    `"id","fdc_id","nutrient_id","amount"\n` +
    `"1","500","1008","999"\n"2","500","1003","1"\n"3","500","1005","1"\n"4","500","1004","1"\n` +
    `"5","501","1008","579"\n"6","501","1003","21.2"\n"7","501","1005","21.6"\n"8","501","1004","49.9"`;
  const { foods } = parseFdcFoods(food, nutrient);
  assert.equal(foods.length, 1);
  assert.equal(foods[0]!.fdcId, "501");
  assert.equal(foods[0]!.macros.calories, 579);
});

test("zero-calorie / zero-macro foods are kept (0 is a fact, absence is a gap)", () => {
  const food = `"fdc_id","data_type","description"\n"7","sr_legacy_food","Salt, table"`;
  const nutrient =
    `"id","fdc_id","nutrient_id","amount"\n"1","7","1008","0"\n"2","7","1003","0"\n` +
    `"3","7","1005","0"\n"4","7","1004","0"`;
  const { foods, skipped } = parseFdcFoods(food, nutrient);
  assert.equal(skipped.length, 0);
  assert.deepEqual(foods[0]!.macros, { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 });
});
