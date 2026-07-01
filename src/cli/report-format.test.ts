import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPriceHistory,
  formatCheapestStores,
  formatStoreCoverage,
  formatProteinPerDollar,
} from "./report-format";

test("price history shows min/max and a signed trend, and notes exclusions", () => {
  const lines = formatPriceHistory("chicken", {
    ingredientId: 7,
    trends: [{ unit: "lb", observations: 3, min: 2, max: 3, first: 2, latest: 3, delta: 1 }],
    excluded: { noUnit: 1, wholePackageFallback: 2 },
    totalObservations: 6,
  }).join("\n");

  assert.match(lines, /chicken \(ingredient #7\)/);
  assert.match(lines, /per lb: 3 obs/);
  assert.match(lines, /min \$2\.00 · max \$3\.00/);
  assert.match(lines, /\+\$1\.00/);
  assert.match(lines, /1 unitless, 2 whole-package/);
});

test("price history marks an undated trend as n/a", () => {
  const lines = formatPriceHistory("x", {
    ingredientId: 1,
    trends: [{ unit: "lb", observations: 1, min: 2, max: 2, first: null, latest: null, delta: null }],
    excluded: { noUnit: 0, wholePackageFallback: 0 },
    totalObservations: 1,
  }).join("\n");
  assert.match(lines, /trend: n\/a \(undated\)/);
});

test("cheapest store marks the winner with a check", () => {
  const lines = formatCheapestStores("chicken", {
    ingredientId: 3,
    byUnit: [
      {
        unit: "lb",
        ranking: [
          { storeId: 1, storeName: "Aldi", unit: "lb", unitPrice: 3, observedAt: null, currency: "USD" },
          { storeId: 2, storeName: "Kroger", unit: "lb", unitPrice: 4, observedAt: null, currency: "USD" },
        ],
      },
    ],
    excludedNoUnit: 0,
  }).join("\n");
  assert.match(lines, /✓ \$3\.00  Aldi/);
  assert.match(lines, /\$4\.00  Kroger/);
});

test("store coverage flags unconfirmed stores", () => {
  const lines = formatStoreCoverage([
    { storeId: 1, storeName: "Aldi", confirmed: true, observations: 5, distinctIngredients: 3, firstObservedAt: "2026-01-01", lastObservedAt: "2026-03-01" },
    { storeId: 2, storeName: "Mystery", confirmed: false, observations: 1, distinctIngredients: 1, firstObservedAt: null, lastObservedAt: null },
  ]).join("\n");
  assert.match(lines, /Aldi \[confirmed\]  5 obs/);
  assert.match(lines, /Mystery \[⚠ unconfirmed\]/);
});

test("protein-per-dollar lists computed rows and a sorted blocker tally", () => {
  const lines = formatProteinPerDollar({
    computed: [
      { ingredientId: 1, ingredientName: "chicken", storeName: "Aldi", dollarsPerGramProtein: 0.04, proteinGPerDollar: 25 },
    ],
    blockers: [
      { ingredientId: 2, ingredientName: "milk", reason: "cup needs density_g_per_ml", category: "missing density (volume unit)" },
      { ingredientId: 3, ingredientName: "salt", reason: "no confirmed food link", category: "no confirmed food link" },
      { ingredientId: 4, ingredientName: "pepper", reason: "no confirmed food link", category: "no confirmed food link" },
    ],
    blockerTally: { "no confirmed food link": 2, "missing density (volume unit)": 1 },
  }).join("\n");

  assert.match(lines, /25\.0 g protein\/\$/);
  assert.match(lines, /chicken @ Aldi/);
  // most-common blocker category listed first
  assert.match(lines, /2×  no confirmed food link[\s\S]*1×  missing density/);
});
