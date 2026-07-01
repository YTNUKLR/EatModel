import fs from "node:fs";
import { Db } from "../db/db";
import {
  summarizePriceHistory,
  cheapestStores,
  rankStoreCoverage,
  proteinPerDollar,
} from "../shared/reports";
import {
  formatPriceHistory,
  formatCheapestStores,
  formatStoreCoverage,
  formatProteinPerDollar,
  formatDashboard,
} from "./report-format";
import { formatRecipeNutrition } from "./nutrition-format";

// Read-only reporting over the spine. Loads .env only for EATMODEL_DB; this CLI
// never writes and never calls the network.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

const USAGE = `Reports — read-only views over the ingredient/price/nutrition spine.

  npm run report                       dashboard: coverage + priced ingredients
  npm run report -- price <id>         price history for a canonical ingredient
  npm run report -- cheapest <id>      cheapest confirmed store for an ingredient
  npm run report -- stores             per-store price-data coverage
  npm run report -- macros [recipe-id] recipe macro rollups (all, or one)
  npm run report -- protein-per-dollar cost-per-nutrient diagnostic + blockers
`;

function requireIngredient(db: Db, raw: string | undefined): { id: number; canonicalName: string } {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id)) {
    console.error("expected an ingredient id (an integer). See `npm run report`.");
    process.exit(1);
  }
  const ingredient = db.getIngredient(id);
  if (!ingredient) {
    console.error(`no ingredient with id ${id}. See "npm run report" for priced ids.`);
    process.exit(1);
  }
  return ingredient;
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const db = new Db(DB_PATH);
  try {
    switch (command) {
      case undefined:
      case "dashboard": {
        const lines = formatDashboard(
          db.totals(),
          db.listPricedIngredients(),
          rankStoreCoverage(db.storeCoverageRows()),
        );
        console.log(lines.join("\n"));
        break;
      }
      case "price": {
        const ing = requireIngredient(db, rest[0]);
        const report = summarizePriceHistory(ing.id, db.priceHistoryRows(ing.id));
        console.log(formatPriceHistory(ing.canonicalName, report).join("\n"));
        break;
      }
      case "cheapest": {
        const ing = requireIngredient(db, rest[0]);
        const report = cheapestStores(ing.id, db.confirmedStorePriceRows(ing.id));
        console.log(formatCheapestStores(ing.canonicalName, report).join("\n"));
        break;
      }
      case "stores": {
        console.log(formatStoreCoverage(rankStoreCoverage(db.storeCoverageRows())).join("\n"));
        break;
      }
      case "macros": {
        const summaries =
          rest[0] != null ? [db.recipeNutrition(Number(rest[0]))] : db.listRecipeNutrition();
        if (summaries.length === 0) {
          console.log("No recipes yet.");
          break;
        }
        const ranked = [...summaries].sort(
          (a, b) => (b.nutrition.perServing?.proteinG ?? -1) - (a.nutrition.perServing?.proteinG ?? -1),
        );
        console.log(ranked.map((s) => formatRecipeNutrition(s).join("\n")).join("\n\n"));
        break;
      }
      case "protein-per-dollar": {
        const report = proteinPerDollar(db.proteinPerDollarCandidates());
        console.log(formatProteinPerDollar(report).join("\n"));
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = command ? 1 : 0;
    }
  } finally {
    db.close();
  }
}

main();
