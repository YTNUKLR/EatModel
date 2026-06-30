import type { Macros } from "../shared/nutrition";
import type { RecipeNutritionSummary } from "../db/db";

function oneDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

export function formatMacros(macros: Macros): string {
  return (
    `${Math.round(macros.calories)} kcal` +
    ` · P ${oneDecimal(macros.proteinG)}g` +
    ` · C ${oneDecimal(macros.carbsG)}g` +
    ` · F ${oneDecimal(macros.fatG)}g`
  );
}

export function formatRecipeNutrition(summary: RecipeNutritionSummary): string[] {
  const title = summary.title ?? "(untitled recipe)";
  const { total, perServing, countedLines, missedLines } = summary.nutrition;
  const marker = summary.nutrition.partial ? "⚠ partial" : "complete";
  const lines = [`recipe #${summary.recipeId}  ${title}  —  nutrition ${marker}`];

  // When some lines were skipped, the total/per-serving are floors, not the real
  // figure — annotate them so the number isn't read as authoritative.
  const coverage =
    missedLines > 0 ? `  (partial — ${countedLines} of ${countedLines + missedLines} lines counted)` : "";

  if (total == null) {
    lines.push("  total: unknown (no confirmed, convertible macro lines yet)");
  } else {
    lines.push(`  total: ${formatMacros(total)}${coverage}`);
    if (perServing != null) {
      lines.push(`  per serving: ${formatMacros(perServing)}${coverage}`);
    }
  }

  const reasons = summary.nutrition.reasons;
  for (const reason of reasons.slice(0, 4)) lines.push(`  - ${reason}`);
  if (reasons.length > 4) lines.push(`  - ...and ${reasons.length - 4} more gap(s)`);
  return lines;
}
