import { quantityToGrams } from "./units";

export interface Macros {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

export interface NutritionLineInput {
  ingredientName: string;
  quantity: number | null;
  unit: string | null;
  optional?: boolean;
  food: Macros | null;
  foodLinkStatus?: "proposed" | "confirmed" | null;
  densityGPerMl?: number | null;
  gramsPerEach?: number | null;
}

export interface NutritionRollup {
  total: Macros | null;
  perServing: Macros | null;
  partial: boolean;
  reasons: string[];
  countedLines: number;
  /** Non-optional lines that couldn't be counted (no confirmed link / unconvertible). */
  missedLines: number;
  skippedOptionalLines: number;
}

function zeroMacros(): Macros {
  return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
}

function addMacros(a: Macros, b: Macros): Macros {
  return {
    calories: a.calories + b.calories,
    proteinG: a.proteinG + b.proteinG,
    carbsG: a.carbsG + b.carbsG,
    fatG: a.fatG + b.fatG,
  };
}

function scaleMacros(macros: Macros, factor: number): Macros {
  return {
    calories: macros.calories * factor,
    proteinG: macros.proteinG * factor,
    carbsG: macros.carbsG * factor,
    fatG: macros.fatG * factor,
  };
}

function missingFoodReason(line: NutritionLineInput): string {
  if (line.foodLinkStatus === "proposed") {
    return `${line.ingredientName}: food link awaiting confirmation`;
  }
  return `${line.ingredientName}: no confirmed food link`;
}

/**
 * Roll recipe ingredients into macro totals. The function is deliberately
 * `null`-honest: missing food links or unconvertible units mark the rollup
 * partial and explain why; they never produce fabricated calories.
 */
export function rollupRecipeNutrition(
  lines: NutritionLineInput[],
  servings: number | null,
): NutritionRollup {
  let total = zeroMacros();
  let countedLines = 0;
  let missedLines = 0;
  let skippedOptionalLines = 0;
  const reasons: string[] = [];

  for (const line of lines) {
    if (line.optional) {
      skippedOptionalLines++;
      continue;
    }

    if (line.food == null || line.foodLinkStatus !== "confirmed") {
      reasons.push(missingFoodReason(line));
      missedLines++;
      continue;
    }

    const converted = quantityToGrams(line.quantity, line.unit, {
      densityGPerMl: line.densityGPerMl,
      gramsPerEach: line.gramsPerEach,
    });
    if (converted.grams == null) {
      reasons.push(`${line.ingredientName}: ${converted.reason ?? "cannot convert to grams"}`);
      missedLines++;
      continue;
    }

    total = addMacros(total, scaleMacros(line.food, converted.grams / 100));
    countedLines++;
  }

  const knownTotal = countedLines > 0 ? total : null;
  let perServing: Macros | null = null;
  if (knownTotal != null) {
    if (servings != null && Number.isFinite(servings) && servings > 0) {
      perServing = scaleMacros(knownTotal, 1 / servings);
    } else {
      reasons.push("recipe: missing servings");
    }
  }

  return {
    total: knownTotal,
    perServing,
    partial: reasons.length > 0,
    reasons,
    countedLines,
    missedLines,
    skippedOptionalLines,
  };
}
