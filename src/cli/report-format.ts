import type {
  PriceHistoryReport,
  CheapestStoreReport,
  StoreCoverageRow,
  ProteinPerDollarReport,
  NutritionCoverageReport,
} from "../shared/reports";
import type { PricedIngredient } from "../db/db";

/**
 * Pure rendering for the report CLI (ARCHITECTURE §15). No SQL, no math beyond
 * display rounding — every figure arrives already computed by shared/reports.ts.
 * Returns string[] (like nutrition-format) so it's trivially testable.
 */

function money(n: number, currency: string | null): string {
  const sym = currency === "USD" || currency == null ? "$" : `${currency} `;
  return `${sym}${n.toFixed(2)}`;
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

export function formatPriceHistory(
  ingredientName: string,
  report: PriceHistoryReport,
): string[] {
  const out = [`Price history — ${ingredientName} (ingredient #${report.ingredientId})`];
  if (report.trends.length === 0) {
    out.push("  (no comparable priced observations yet)");
  }
  for (const t of report.trends) {
    const trend =
      t.delta == null
        ? "trend: n/a (undated)"
        : `first ${money(t.first!, null)} → latest ${money(t.latest!, null)} (${signed(t.delta)})`;
    out.push(
      `  per ${t.unit}: ${t.observations} obs · ` +
        `min ${money(t.min, null)} · max ${money(t.max, null)} · ${trend}`,
    );
  }
  const ex = report.excluded;
  if (ex.noUnit > 0 || ex.wholePackageFallback > 0) {
    out.push(
      `  excluded from trends: ${ex.noUnit} unitless, ` +
        `${ex.wholePackageFallback} whole-package (no per-unit price)`,
    );
  }
  return out;
}

export function formatCheapestStores(
  ingredientName: string,
  report: CheapestStoreReport,
): string[] {
  const out = [`Cheapest store — ${ingredientName} (ingredient #${report.ingredientId})`];
  if (report.byUnit.length === 0) {
    out.push("  (no confirmed-store prices with a comparable unit yet)");
  }
  for (const { unit, ranking } of report.byUnit) {
    out.push(`  per ${unit}:`);
    ranking.forEach((r, i) => {
      const marker = i === 0 ? "✓" : " ";
      out.push(`    ${marker} ${money(r.unitPrice, r.currency)}  ${r.storeName}`);
    });
  }
  if (report.excludedNoUnit > 0) {
    out.push(`  (${report.excludedNoUnit} store price(s) excluded — unknown unit)`);
  }
  return out;
}

export function formatStoreCoverage(rows: StoreCoverageRow[]): string[] {
  const out = ["Store price-data coverage"];
  if (rows.length === 0) out.push("  (no stores yet)");
  for (const r of rows) {
    const status = r.confirmed ? "confirmed" : "⚠ unconfirmed";
    const span =
      r.firstObservedAt && r.lastObservedAt
        ? `${r.firstObservedAt}…${r.lastObservedAt}`
        : "no dates";
    out.push(
      `  ${r.storeName} [${status}]  ${r.observations} obs · ` +
        `${r.distinctIngredients} ingredient(s) · ${span}`,
    );
  }
  return out;
}

export function formatProteinPerDollar(report: ProteinPerDollarReport): string[] {
  const out = ["Protein per dollar (diagnostic — §15.3)"];
  if (report.computed.length === 0) {
    out.push("  computable rows: none yet");
  } else {
    out.push("  best protein value first:");
    for (const r of report.computed) {
      out.push(
        `    ${r.proteinGPerDollar.toFixed(1)} g protein/$  ` +
          `(${money(r.dollarsPerGramProtein, null)}/g)  ${r.ingredientName} @ ${r.storeName}`,
      );
    }
  }

  const categories = Object.keys(report.blockerTally).sort(
    (a, b) => report.blockerTally[b]! - report.blockerTally[a]!,
  );
  if (categories.length > 0) {
    out.push(`  blocked (${report.blockers.length}) — what's limiting the answer:`);
    for (const c of categories) out.push(`    ${report.blockerTally[c]}×  ${c}`);
  }
  return out;
}

export function formatDashboard(
  totals: { ingredients: number; receipts: number; priceObservations: number; recipes: number; stores: number },
  priced: PricedIngredient[],
  coverage: StoreCoverageRow[],
): string[] {
  const out = [
    "EatModel reports (read-only)",
    "",
    `spine: ${totals.ingredients} ingredients · ${totals.receipts} receipts · ` +
      `${totals.priceObservations} price obs · ${totals.stores} stores · ${totals.recipes} recipes`,
    "",
  ];
  out.push(...formatStoreCoverage(coverage));
  out.push("");
  out.push("Priced ingredients (use the id with `price` / `cheapest`):");
  if (priced.length === 0) out.push("  (none yet — ingest some receipts)");
  for (const p of priced.slice(0, 15)) {
    out.push(`  #${p.id}  ${p.canonicalName}  (${p.observations} obs)`);
  }
  if (priced.length > 15) out.push(`  ...and ${priced.length - 15} more`);
  out.push("");
  out.push("Commands: report -- price <id> | cheapest <id> | stores | macros [id] | protein-per-dollar");
  return out;
}

export function formatNutritionCoverage(report: NutritionCoverageReport): string[] {
  const out = [
    `Nutrition coverage — ${report.recipeCount} recipes: ` +
      `${report.complete} complete, ${report.partial} partial`,
  ];
  if (report.recipeCount === 0) {
    out.push("  (no recipes yet)");
    return out;
  }

  const blockedTotal = report.blockedLines.noFoodLink + report.blockedLines.unconvertible;
  out.push(
    `  lines: ${report.countedLines} counted · ` +
      `${report.blockedLines.noFoodLink} need a food link · ` +
      `${report.blockedLines.unconvertible} need a conversion`,
  );
  if (report.linkableToComplete > 0) {
    out.push(
      `  ${report.linkableToComplete} partial recipe(s) would complete by linking alone (best case)`,
    );
  }

  const worst = report.recipes.filter((r) => !r.complete).slice(0, 8);
  if (worst.length > 0) {
    out.push("", "  recipes needing the most work:");
    for (const r of worst) {
      out.push(
        `    #${r.recipeId}  ${r.title ?? "(untitled)"}  —  ` +
          `${r.counted}/${r.total} lines counted (${r.blocked} blocked)` +
          (r.linkableToComplete ? "  ·  links only" : ""),
      );
    }
  }

  if (report.topUnlinked.length > 0) {
    out.push("", "  link these ingredients next (most recipe lines unblocked first):");
    for (const i of report.topUnlinked) {
      out.push(
        `    #${i.ingredientId}  ${i.ingredientName}  —  ` +
          `${i.blockedLines} line(s) · ${i.recipes} recipe(s)`,
      );
    }
    out.push("    → propose a link:  npm run review -- foods <query>  then  link-food <ing-id> <food-id>");
  } else if (blockedTotal === 0) {
    out.push("  ✓ every non-optional line is counted");
  }
  return out;
}
