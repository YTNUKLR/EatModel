import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Db, type SaveRecipePageSummary } from "../db/db";
import { selectRecipeParser } from "./select-recipe-parser";
import { prepareImage } from "./prepare-image";
import type { RecipePage } from "../shared/recipe-types";

// Load .env (Node 22+) so ANTHROPIC_API_KEY etc. are available with no extra
// tooling. Without this, a filled-in .env would be ignored entirely.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const INBOX = process.env.EATMODEL_RECIPE_INBOX ?? "recipes/inbox";
const PROCESSED = process.env.EATMODEL_RECIPE_PROCESSED ?? "recipes/processed";
const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

// Formats the parser reads directly, plus HEIC/HEIF which we convert first.
const PARSEABLE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const CONVERTIBLE_EXTS = new Set([".heic", ".heif"]);
const INGEST_EXTS = new Set([...PARSEABLE_EXTS, ...CONVERTIBLE_EXTS]);

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function printPage(
  file: string,
  page: RecipePage,
  summary: SaveRecipePageSummary,
  converted: boolean,
): void {
  const note = converted ? "  [converted HEIC→JPEG]" : "";
  const n = summary.recipes.length;
  console.log(`✓ ${file}${note}  →  ${n} recipe(s)`);
  summary.recipes.forEach((r, i) => {
    const parsed = page.recipes[i];
    const title = r.title ?? "(untitled recipe)";
    const src = parsed?.sourceNote ? ` · ${parsed.sourceNote}` : "";
    const serves = parsed?.servings != null ? ` · serves ${parsed.servings}` : "";
    console.log(`    • ${title}${src}${serves}  —  recipe #${r.recipeId}`);
    for (const line of r.lines) {
      const tag = line.confidence === "new" ? "＋new" : " alias";
      const opt = line.optional ? "  (optional)" : "";
      console.log(`        [${tag}] ${line.ingredient}${opt}`);
    }
  });
  console.log(`    ${summary.newIngredients} new ingredient(s) across the page\n`);
}

async function main(): Promise<void> {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(PROCESSED, { recursive: true });

  const images = fs
    .readdirSync(INBOX)
    .filter((f) => INGEST_EXTS.has(path.extname(f).toLowerCase()));

  if (images.length === 0) {
    console.log(`No images in ${INBOX}/ — drop recipe photos there (or point EATMODEL_RECIPE_INBOX at your synced folder) and re-run.`);
    return;
  }

  const parser = selectRecipeParser(process.env); // throws (fail loud) if llm is chosen with no key
  const db = new Db(DB_PATH);
  console.log(`parser: ${parser.name}  ·  db: ${DB_PATH}  ·  ${images.length} image(s)\n`);

  let ok = 0;
  let skipped = 0;
  for (const file of images) {
    const full = path.join(INBOX, file);
    let prepared: ReturnType<typeof prepareImage> | undefined;
    try {
      // Content-hash dedup: skip (and don't re-call the API) if already ingested.
      const hash = sha256(full);
      if (db.hasRecipe(hash)) {
        console.log(`↷ ${file}: already ingested — skipping\n`);
        fs.renameSync(full, path.join(PROCESSED, file));
        skipped++;
        continue;
      }

      prepared = prepareImage(full); // HEIC→temp JPEG; original is untouched
      const page = await parser.parse(prepared.path);
      const summary = db.saveRecipePage(page, file, parser.name, hash);
      printPage(file, page, summary, prepared.converted);
      fs.renameSync(full, path.join(PROCESSED, file)); // drain the inbox; keep the original
      ok++;
    } catch (err) {
      console.error(`✗ ${file}: ${(err as Error).message}\n`);
    } finally {
      prepared?.cleanup();
    }
  }

  const t = db.totals();
  console.log(
    `Done. ${ok} processed${skipped ? `, ${skipped} skipped (duplicate)` : ""}.  ` +
      `DB now holds ${t.recipes} recipe(s), ${t.ingredients} ingredient(s).`,
  );
  db.close();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
