import fs from "node:fs";
import { Db } from "../db/db";
import { formatMacros, formatRecipeNutrition } from "./nutrition-format";

// Load .env for EATMODEL_DB if set; this CLI never calls the network.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

const USAGE = `Review gate — inspect and resolve what the ingest flagged.

  npm run review                  list unconfirmed ingredients + flagged lines + unreconciled receipts
  npm run review -- confirm <id>  mark ingredient <id> as confirmed (trusted spine)
  npm run review -- merge <from> <into>
                                  fold ingredient <from> into <into> (de-fragment the spine)
  npm run review -- delete-recipe <id>
                                  delete a mis-captured recipe + the ingredients it orphans
  npm run review -- set-source <recipe-id> <source text...>
                                  record a recipe's source citation (book/page); omit text to clear
  npm run review -- confirm-store <id>
                                  mark store <id> as confirmed
  npm run review -- merge-store <from> <into>
                                  fold store <from> into <into>
  npm run review -- resolve-line <receipt|recipe> <line-id>
                                  clear a flagged line after human review
  npm run review -- resolve-receipt <id>
                                  clear a receipt total warning after human review
  npm run review -- foods [query] list seeded reference foods, optionally filtered
  npm run review -- link-food <ingredient-id> <food-id>
                                  propose a food link for an ingredient
  npm run review -- confirm-food <ingredient-id>
                                  confirm an ingredient's proposed food link
  npm run review -- unlink-food <ingredient-id>
                                  remove an ingredient's food link
  npm run review -- set-density <ingredient-id> <g-per-ml>
                                  set density for volume→grams conversion
  npm run review -- set-each-grams <ingredient-id> <grams>
                                  set grams-per-each for clove/each conversion
  npm run review -- nutrition [recipe-id]
                                  show recipe macro rollups and partial reasons
`;

function list(db: Db): void {
  const ingredients = db.listUnconfirmedIngredients();
  const stores = db.listUnconfirmedStores();
  const lines = db.listLinesNeedingReview();
  const receipts = db.listReceiptsNeedingReview();
  const proposedFoodLinks = db.listProposedFoodLinks();
  const missingFoodLinks = db.listIngredientsMissingFoodLink();

  console.log(`Unconfirmed ingredients (${ingredients.length}):`);
  if (ingredients.length === 0) console.log("  (none)");
  for (const i of ingredients) {
    console.log(`  #${i.id}  ${i.canonicalName}  (${i.aliases} alias${i.aliases === 1 ? "" : "es"})`);
  }

  console.log(`\nUnconfirmed stores (${stores.length}):`);
  if (stores.length === 0) console.log("  (none)");
  for (const s of stores) {
    console.log(
      `  #${s.id}  ${s.canonicalName}` +
        `  (${s.aliases} alias${s.aliases === 1 ? "" : "es"}, ${s.receipts} receipt${s.receipts === 1 ? "" : "s"})`,
    );
  }

  console.log(`\nLines flagged for review (${lines.length}):`);
  if (lines.length === 0) console.log("  (none)");
  for (const l of lines) {
    console.log(`  [${l.source}] line #${l.lineId}  "${l.description}"  — ${l.reason}`);
  }

  console.log(`\nReceipts that didn't reconcile (${receipts.length}):`);
  if (receipts.length === 0) console.log("  (none)");
  for (const r of receipts) {
    console.log(`  receipt #${r.id}  ${r.store ?? "(unknown store)"}  — ${r.reason}`);
  }

  console.log(`\nFood links awaiting confirmation (${proposedFoodLinks.length}):`);
  if (proposedFoodLinks.length === 0) console.log("  (none)");
  for (const link of proposedFoodLinks) {
    console.log(
      `  ingredient #${link.ingredientId}  ${link.ingredientName}` +
        `  ->  food #${link.foodId}  ${link.foodDescription}`,
    );
  }

  console.log(`\nConfirmed ingredients missing food link (${missingFoodLinks.length}):`);
  if (missingFoodLinks.length === 0) console.log("  (none)");
  for (const i of missingFoodLinks) {
    console.log(`  #${i.id}  ${i.canonicalName}`);
  }

  if (
    ingredients.length ||
    stores.length ||
    lines.length ||
    receipts.length ||
    proposedFoodLinks.length ||
    missingFoodLinks.length
  ) {
    console.log(
      `\nResolve with:  npm run review -- confirm <id>   |   npm run review -- merge <from> <into>` +
        `\nStores:       npm run review -- confirm-store <id>   |   npm run review -- merge-store <from> <into>` +
        `   |   npm run review -- resolve-line <receipt|recipe> <line-id>` +
        `   |   npm run review -- resolve-receipt <id>` +
        `\nFood links:    npm run review -- foods <query>   |   npm run review -- link-food <ingredient-id> <food-id>` +
        `   |   npm run review -- confirm-food <ingredient-id>`,
    );
  }
}

function intArg(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`expected an integer ${name}, got "${value ?? ""}"`);
  return n;
}

function numberArg(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number ${name}, got "${value ?? ""}"`);
  return n;
}

function listFoods(db: Db, query: string | null): void {
  const foods = db.listFoods(query);
  console.log(`Reference foods (${foods.length}):`);
  if (foods.length === 0) console.log("  (none)");
  for (const food of foods) {
    console.log(
      `  #${food.id}  ${food.description}` +
        `  [${food.source}]  ${formatMacros(food.nutrition)} / 100g`,
    );
  }
}

function printNutrition(db: Db, recipeId: number | null): void {
  const summaries = recipeId == null ? db.listRecipeNutrition() : [db.recipeNutrition(recipeId)];
  if (summaries.length === 0) {
    console.log("No recipes yet.");
    return;
  }
  for (const summary of summaries) {
    for (const line of formatRecipeNutrition(summary)) console.log(line);
    console.log("");
  }
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const db = new Db(DB_PATH);
  try {
    if (!cmd) {
      list(db);
    } else if (cmd === "confirm") {
      const id = intArg(rest[0], "ingredient id");
      db.confirmIngredient(id);
      console.log(`✓ confirmed ingredient #${id}`);
    } else if (cmd === "merge") {
      const from = intArg(rest[0], "<from> id");
      const into = intArg(rest[1], "<into> id");
      db.mergeIngredient(from, into);
      console.log(`✓ merged ingredient #${from} into #${into}`);
    } else if (cmd === "delete-recipe") {
      const id = intArg(rest[0], "recipe id");
      const summary = db.deleteRecipe(id);
      const title = summary.title ?? "(untitled recipe)";
      console.log(`✓ deleted recipe #${id}  ${title}`);
      if (summary.deletedIngredientIds.length) {
        console.log(
          `  removed ${summary.deletedIngredientIds.length} orphaned ingredient(s): ` +
            summary.deletedIngredientIds.map((i) => `#${i}`).join(", "),
        );
      }
      if (summary.deletedIngest) console.log(`  removed the now-empty image ingest`);
    } else if (cmd === "set-source") {
      const id = intArg(rest[0], "recipe id");
      const source = rest.slice(1).join(" ").trim();
      db.setRecipeSource(id, source === "" ? null : source);
      console.log(
        source === "" ? `✓ cleared source of recipe #${id}` : `✓ set source of recipe #${id}: ${source}`,
      );
    } else if (cmd === "confirm-store") {
      const id = intArg(rest[0], "store id");
      db.confirmStore(id);
      console.log(`✓ confirmed store #${id}`);
    } else if (cmd === "merge-store") {
      const from = intArg(rest[0], "<from> id");
      const into = intArg(rest[1], "<into> id");
      db.mergeStore(from, into);
      console.log(`✓ merged store #${from} into #${into}`);
    } else if (cmd === "resolve-line") {
      const source = rest[0];
      if (source !== "receipt" && source !== "recipe") {
        throw new Error(`expected line source "receipt" or "recipe", got "${source ?? ""}"`);
      }
      const lineId = intArg(rest[1], "line id");
      db.resolveLineReview(source, lineId);
      console.log(`✓ resolved ${source} line #${lineId}`);
    } else if (cmd === "resolve-receipt") {
      const id = intArg(rest[0], "receipt id");
      db.resolveReceiptReview(id);
      console.log(`✓ resolved receipt #${id}`);
    } else if (cmd === "foods") {
      listFoods(db, rest.length ? rest.join(" ") : null);
    } else if (cmd === "link-food") {
      const ingredientId = intArg(rest[0], "ingredient id");
      const foodId = intArg(rest[1], "food id");
      db.proposeIngredientFoodLink(ingredientId, foodId);
      console.log(`✓ proposed food #${foodId} for ingredient #${ingredientId}`);
    } else if (cmd === "confirm-food") {
      const ingredientId = intArg(rest[0], "ingredient id");
      db.confirmIngredientFoodLink(ingredientId);
      console.log(`✓ confirmed food link for ingredient #${ingredientId}`);
    } else if (cmd === "unlink-food") {
      const ingredientId = intArg(rest[0], "ingredient id");
      db.unlinkIngredientFood(ingredientId);
      console.log(`✓ removed food link from ingredient #${ingredientId}`);
    } else if (cmd === "set-density") {
      const ingredientId = intArg(rest[0], "ingredient id");
      const density = numberArg(rest[1], "g-per-ml");
      db.setIngredientDensity(ingredientId, density);
      console.log(`✓ set density_g_per_ml=${density} for ingredient #${ingredientId}`);
    } else if (cmd === "set-each-grams") {
      const ingredientId = intArg(rest[0], "ingredient id");
      const grams = numberArg(rest[1], "grams");
      db.setIngredientGramsPerEach(ingredientId, grams);
      console.log(`✓ set grams_per_each=${grams} for ingredient #${ingredientId}`);
    } else if (cmd === "nutrition") {
      const recipeId = rest[0] == null ? null : intArg(rest[0], "recipe id");
      printNutrition(db, recipeId);
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
