import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizePriceHistory,
  cheapestStores,
  rankStoreCoverage,
  proteinPerDollar,
  categorizeBlocker,
  type PriceObservationRow,
  type StorePriceRow,
  type StoreCoverageRow,
  type ProteinPerDollarCandidate,
} from "./reports";

function obs(fields: Partial<PriceObservationRow> = {}): PriceObservationRow {
  return {
    storeId: fields.storeId ?? 1,
    storeName: fields.storeName ?? "Test Mart",
    storeConfirmed: fields.storeConfirmed ?? true,
    observedAt: fields.observedAt ?? null,
    unit: "unit" in fields ? fields.unit! : "lb",
    unitPrice: fields.unitPrice ?? 1,
    currency: fields.currency ?? "USD",
    wholePackageFallback: fields.wholePackageFallback ?? false,
  };
}

// ── price history ────────────────────────────────────────────────────────────

test("price history groups by unit and computes min/max/first/latest/delta", () => {
  const report = summarizePriceHistory(7, [
    obs({ unit: "lb", unitPrice: 2.0, observedAt: "2026-01-01" }),
    obs({ unit: "lb", unitPrice: 3.0, observedAt: "2026-03-01" }),
    obs({ unit: "lb", unitPrice: 2.5, observedAt: "2026-02-01" }),
    obs({ unit: "oz", unitPrice: 0.5, observedAt: "2026-01-01" }),
  ]);

  assert.equal(report.ingredientId, 7);
  assert.equal(report.trends.length, 2);
  const lb = report.trends.find((t) => t.unit === "lb")!;
  assert.equal(lb.observations, 3);
  assert.equal(lb.min, 2.0);
  assert.equal(lb.max, 3.0);
  assert.equal(lb.first, 2.0); // earliest by date
  assert.equal(lb.latest, 3.0); // latest by date, not by insertion order
  assert.equal(lb.delta, 1.0);
});

test("price history excludes fallback and unitless observations from trends", () => {
  const report = summarizePriceHistory(1, [
    obs({ unit: "lb", unitPrice: 2.0, observedAt: "2026-01-01" }),
    obs({ unit: null, unitPrice: 9.0 }),
    obs({ unit: "lb", unitPrice: 99.0, wholePackageFallback: true }),
  ]);

  assert.equal(report.totalObservations, 3);
  assert.equal(report.excluded.noUnit, 1);
  assert.equal(report.excluded.wholePackageFallback, 1);
  assert.equal(report.trends.length, 1);
  assert.equal(report.trends[0]!.observations, 1);
  assert.equal(report.trends[0]!.max, 2.0); // the 99.0 fallback never entered the trend
});

test("price history leaves first/latest/delta null when a unit group is undated", () => {
  const report = summarizePriceHistory(1, [obs({ unit: "lb", unitPrice: 2.0, observedAt: null })]);
  const lb = report.trends[0]!;
  assert.equal(lb.min, 2.0);
  assert.equal(lb.first, null);
  assert.equal(lb.latest, null);
  assert.equal(lb.delta, null);
});

// ── cheapest store ───────────────────────────────────────────────────────────

function sp(fields: Partial<StorePriceRow> = {}): StorePriceRow {
  return {
    storeId: fields.storeId ?? 1,
    storeName: fields.storeName ?? "A",
    unit: "unit" in fields ? fields.unit! : "lb",
    unitPrice: fields.unitPrice ?? 1,
    observedAt: fields.observedAt ?? null,
    currency: fields.currency ?? "USD",
  };
}

test("cheapest store ranks the latest price per store, ascending", () => {
  const report = cheapestStores(3, [
    sp({ storeId: 1, storeName: "A", unitPrice: 5.0, observedAt: "2026-01-01" }),
    sp({ storeId: 1, storeName: "A", unitPrice: 3.0, observedAt: "2026-05-01" }), // A's current price
    sp({ storeId: 2, storeName: "B", unitPrice: 4.0, observedAt: "2026-05-01" }),
  ]);

  assert.equal(report.byUnit.length, 1);
  const ranking = report.byUnit[0]!.ranking;
  assert.equal(ranking.length, 2);
  assert.equal(ranking[0]!.storeName, "A"); // 3.00 (latest) beats B's 4.00
  assert.equal(ranking[0]!.unitPrice, 3.0);
  assert.equal(ranking[1]!.storeName, "B");
});

test("cheapest store keeps units in separate rankings and excludes unitless", () => {
  const report = cheapestStores(3, [
    sp({ storeId: 1, storeName: "A", unit: "lb", unitPrice: 3.0, observedAt: "2026-01-01" }),
    sp({ storeId: 2, storeName: "B", unit: "oz", unitPrice: 0.2, observedAt: "2026-01-01" }),
    sp({ storeId: 3, storeName: "C", unit: null, unitPrice: 9.0, observedAt: "2026-01-01" }),
  ]);

  assert.equal(report.byUnit.length, 2); // lb and oz never ranked against each other
  assert.equal(report.excludedNoUnit, 1);
});

// ── store coverage ───────────────────────────────────────────────────────────

test("store coverage ranks by observation count desc", () => {
  const rows: StoreCoverageRow[] = [
    { storeId: 1, storeName: "A", confirmed: true, observations: 2, distinctIngredients: 2, firstObservedAt: null, lastObservedAt: null },
    { storeId: 2, storeName: "B", confirmed: false, observations: 9, distinctIngredients: 5, firstObservedAt: null, lastObservedAt: null },
  ];
  const ranked = rankStoreCoverage(rows);
  assert.equal(ranked[0]!.storeName, "B");
  assert.equal(ranked[1]!.storeName, "A");
});

// ── protein per dollar ───────────────────────────────────────────────────────

function cand(fields: Partial<ProteinPerDollarCandidate> = {}): ProteinPerDollarCandidate {
  return {
    ingredientId: fields.ingredientId ?? 1,
    ingredientName: fields.ingredientName ?? "chicken",
    hasConfirmedFoodLink: fields.hasConfirmedFoodLink ?? true,
    proteinGPer100g: fields.proteinGPer100g ?? 20,
    price: fields.price === undefined ? { unitPrice: 4, unit: "lb", storeName: "A" } : fields.price,
    densityGPerMl: fields.densityGPerMl ?? null,
    gramsPerEach: fields.gramsPerEach ?? null,
  };
}

test("protein-per-dollar computes $/g protein for a convertible mass-unit candidate", () => {
  // 1 lb = 453.59237 g; 20 g protein/100g → 90.72 g protein/lb; $4/lb → $0.0441/g protein
  const report = proteinPerDollar([cand()]);
  assert.equal(report.blockers.length, 0);
  assert.equal(report.computed.length, 1);
  const row = report.computed[0]!;
  assert.ok(Math.abs(row.dollarsPerGramProtein - 4 / (453.59237 * 0.2)) < 1e-9);
  assert.ok(Math.abs(row.proteinGPerDollar - 1 / row.dollarsPerGramProtein) < 1e-9);
});

test("protein-per-dollar tallies typed blockers by category", () => {
  const report = proteinPerDollar([
    cand({ ingredientId: 1, hasConfirmedFoodLink: false }),
    cand({ ingredientId: 2, price: null }),
    cand({ ingredientId: 3, price: { unitPrice: 2, unit: "cup", storeName: "A" } }), // needs density
    cand({ ingredientId: 4, price: { unitPrice: 2, unit: "clove", storeName: "A" } }), // needs each grams
    cand({ ingredientId: 5, price: { unitPrice: 2, unit: "sprig", storeName: "A" } }), // unconvertible
  ]);

  assert.equal(report.computed.length, 0);
  assert.equal(report.blockerTally["no confirmed food link"], 1);
  assert.equal(report.blockerTally["no confirmed store"], 1);
  assert.equal(report.blockerTally["missing density (volume unit)"], 1);
  assert.equal(report.blockerTally["missing grams-per-each"], 1);
  assert.equal(report.blockerTally["unconvertible unit"], 1);
});

test("protein-per-dollar ranks cheapest protein first and blocks zero-protein foods", () => {
  const report = proteinPerDollar([
    cand({ ingredientId: 1, ingredientName: "pricey", proteinGPer100g: 10, price: { unitPrice: 8, unit: "lb", storeName: "A" } }),
    cand({ ingredientId: 2, ingredientName: "cheap", proteinGPer100g: 30, price: { unitPrice: 2, unit: "lb", storeName: "A" } }),
    cand({ ingredientId: 3, ingredientName: "lettuce", proteinGPer100g: 0, price: { unitPrice: 2, unit: "lb", storeName: "A" } }),
  ]);
  assert.equal(report.computed.length, 2);
  assert.equal(report.computed[0]!.ingredientName, "cheap"); // best protein-per-dollar first
  assert.equal(report.blockerTally["food has no protein"], 1);
});

test("categorizeBlocker maps engine reasons to stable categories", () => {
  assert.equal(categorizeBlocker('cup needs density_g_per_ml'), "missing density (volume unit)");
  assert.equal(categorizeBlocker('clove needs grams_per_each'), "missing grams-per-each");
  assert.equal(categorizeBlocker('unconvertible unit "sprig"'), "unconvertible unit");
  assert.equal(categorizeBlocker("no confirmed store"), "no confirmed store");
});
