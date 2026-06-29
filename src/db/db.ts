import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeName } from "../shared/units";
import { deriveUnitPrice } from "../shared/pricing";
import type { ReceiptParseResult } from "../shared/types";
import type { RecipeParseResult, RecipePage } from "../shared/recipe-types";

/**
 * The "ingredient spine" plus receipt + price tables, on SQLite. This is the
 * repository layer: the rest of the app talks to these typed methods, never to
 * raw SQL. Swapping SQLite → Postgres later changes this file only.
 *
 * DDL is plain CREATE TABLE IF NOT EXISTS for the discovery phase (no migration
 * tooling yet — see ARCHITECTURE.md decision log).
 */
const DDL = `
CREATE TABLE IF NOT EXISTS ingredients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  category       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many spellings (recipe text, receipt text) resolve to one ingredient.
CREATE TABLE IF NOT EXISTS ingredient_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  alias_text    TEXT NOT NULL,
  normalized    TEXT NOT NULL UNIQUE,
  source        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT,
  purchased_at   TEXT,
  total          REAL,
  currency       TEXT,
  image_filename TEXT,
  image_sha256   TEXT UNIQUE,
  parser         TEXT,
  raw_json       TEXT,
  parsed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receipt_line_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id       INTEGER NOT NULL REFERENCES receipts(id),
  raw_text         TEXT,
  description      TEXT,
  quantity         REAL,
  unit             TEXT,
  unit_price       REAL,
  line_total       REAL,
  ingredient_id    INTEGER REFERENCES ingredients(id),
  match_confidence TEXT
);

-- The append-only price fact table. Everything cost-related builds on this.
CREATE TABLE IF NOT EXISTS price_observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id   INTEGER NOT NULL REFERENCES ingredients(id),
  store           TEXT,
  observed_at     TEXT,
  unit            TEXT,
  unit_price      REAL,
  currency        TEXT,
  source_line_id  INTEGER REFERENCES receipt_line_items(id)
);

-- One photographed page = one ingest. The image content hash lives here (UNIQUE),
-- so re-ingesting the same photo is blocked even though a page yields many recipes.
CREATE TABLE IF NOT EXISTS recipe_ingests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  image_filename TEXT,
  image_sha256   TEXT UNIQUE,
  parser         TEXT,
  recipe_count   INTEGER,
  raw_json       TEXT,
  parsed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ingest_id   INTEGER NOT NULL REFERENCES recipe_ingests(id),
  title       TEXT,
  source_note TEXT,
  servings    REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A recipe line resolves to the same canonical ingredient as receipts (shared
-- spine), but carries prep/optional and no price (separate envelope) — §5.4.
CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id        INTEGER NOT NULL REFERENCES recipes(id),
  raw_text         TEXT,
  ingredient_text  TEXT,
  quantity         REAL,
  unit             TEXT,
  prep_note        TEXT,
  optional         INTEGER,
  ingredient_id    INTEGER REFERENCES ingredients(id),
  match_confidence TEXT
);
`;

export type MatchConfidence = "alias" | "new";

export interface LineOutcome {
  description: string;
  ingredientId: number;
  confidence: MatchConfidence;
  unitPrice: number | null;
  unit: string | null;
  pricedObserved: boolean;
}

export interface SaveSummary {
  receiptId: number;
  lines: LineOutcome[];
  newIngredients: number;
  priceObservations: number;
}

export interface RecipeLineOutcome {
  ingredient: string;
  ingredientId: number;
  confidence: MatchConfidence;
  optional: boolean;
}

export interface SaveRecipeSummary {
  recipeId: number;
  title: string | null;
  lines: RecipeLineOutcome[];
  newIngredients: number;
}

export interface SaveRecipePageSummary {
  ingestId: number;
  recipes: SaveRecipeSummary[];
  /** New canonical ingredients minted across the whole page. */
  newIngredients: number;
}

export class Db {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(DDL); // creates any missing tables; never alters existing ones
    this.migrate(); // reconcile older dbs whose tables predate newer columns
  }

  private tableExists(table: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) !== undefined
    );
  }

  private columnExists(table: string, column: string): boolean {
    // PRAGMA can't be parameterized; table names here are internal literals.
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === column);
  }

  /**
   * Discovery-phase migration (no migration tooling yet — ARCHITECTURE.md
   * decision log). `CREATE TABLE IF NOT EXISTS` leaves pre-existing tables on
   * their old shape, so we reconcile here:
   *  - additive, recoverable changes → `ALTER TABLE ADD COLUMN` in place;
   *  - structural changes that can't be backfilled → fail loud and tell the
   *    user to `npm run db:reset` (a db created by an older EatModel).
   */
  private migrate(): void {
    // A pre-"recipe page" recipes table has no ingest_id. ingest_id is a NOT NULL
    // FK with no value to backfill onto existing rows — not additively fixable.
    if (this.tableExists("recipes") && !this.columnExists("recipes", "ingest_id")) {
      throw new Error(
        "this database was created by an older EatModel schema and can't be auto-migrated " +
          "(discovery phase has no migrations yet) — run `npm run db:reset` to recreate it.",
      );
    }

    // Added with the ingestion-safety work; recoverable on old receipt tables.
    // (ALTER can't add a column with UNIQUE, so add it plain + a UNIQUE index.)
    if (this.tableExists("receipts") && !this.columnExists("receipts", "image_sha256")) {
      this.db.exec("ALTER TABLE receipts ADD COLUMN image_sha256 TEXT");
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_image_sha256 ON receipts(image_sha256)",
      );
    }
  }

  /**
   * Resolve a product description to a canonical ingredient. Exact alias match
   * → existing ingredient ("alias"). Otherwise create a new ingredient + alias
   * ("new") so the catalog and price history accrue automatically. Every match
   * therefore teaches the system a new alias — the matcher gets smarter over time.
   */
  private matchIngredient(
    description: string,
    source: "receipt" | "recipe",
  ): { ingredientId: number; confidence: MatchConfidence } {
    const normalized = normalizeName(description);
    const existing = this.db
      .prepare("SELECT ingredient_id AS id FROM ingredient_aliases WHERE normalized = ?")
      .get(normalized) as { id: number } | undefined;
    if (existing) return { ingredientId: existing.id, confidence: "alias" };

    const ing = this.db
      .prepare("INSERT INTO ingredients (canonical_name) VALUES (?)")
      .run(description.trim());
    const ingredientId = Number(ing.lastInsertRowid);
    this.db
      .prepare(
        "INSERT INTO ingredient_aliases (ingredient_id, alias_text, normalized, source) VALUES (?, ?, ?, ?)",
      )
      .run(ingredientId, description.trim(), normalized, source);
    return { ingredientId, confidence: "new" };
  }

  /** True if a receipt with this image content hash has already been ingested. */
  hasReceipt(imageSha256: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM receipts WHERE image_sha256 = ? LIMIT 1").get(imageSha256) !==
      undefined
    );
  }

  /**
   * Persist a parsed receipt: the receipt row, each line item (matched to an
   * ingredient), and a price observation per priced line. Wrapped in one
   * transaction so a partial receipt never lands in the db.
   *
   * `imageSha256` is the content hash of the source image; the UNIQUE column is
   * a backstop against double ingestion (the CLI also checks `hasReceipt` first).
   */
  saveReceipt(
    parsed: ReceiptParseResult,
    imageFilename: string,
    parser: string,
    imageSha256: string | null = null,
  ): SaveSummary {
    const run = this.db.transaction((): SaveSummary => {
      const receiptId = Number(
        this.db
          .prepare(
            `INSERT INTO receipts (store, purchased_at, total, currency, image_filename, image_sha256, parser, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.store,
            parsed.purchasedAt,
            parsed.total,
            parsed.currency,
            imageFilename,
            imageSha256,
            parser,
            JSON.stringify(parsed),
          ).lastInsertRowid,
      );

      // Don't fabricate a purchase date — record what was read (possibly null).
      // The price itself is known; the *when* may not be. (CONVENTIONS.md §5)
      const observedAt = parsed.purchasedAt;
      const lines: LineOutcome[] = [];
      let newIngredients = 0;
      let priceObservations = 0;

      for (const line of parsed.lines) {
        const { ingredientId, confidence } = this.matchIngredient(line.description, "receipt");
        if (confidence === "new") newIngredients++;

        const lineId = Number(
          this.db
            .prepare(
              `INSERT INTO receipt_line_items
                 (receipt_id, raw_text, description, quantity, unit, unit_price, line_total, ingredient_id, match_confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              receiptId,
              line.rawText,
              line.description,
              line.quantity,
              line.unit,
              line.unitPrice,
              line.lineTotal,
              ingredientId,
              confidence,
            ).lastInsertRowid,
        );

        // Per-unit price: explicit if printed, else derived (see shared/pricing).
        // Don't fabricate a unit either — store what was read, null if absent.
        const unitPrice = deriveUnitPrice(line);
        const unit = line.unit;

        let pricedObserved = false;
        if (unitPrice != null) {
          this.db
            .prepare(
              `INSERT INTO price_observations
                 (ingredient_id, store, observed_at, unit, unit_price, currency, source_line_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(ingredientId, parsed.store, observedAt, unit, unitPrice, parsed.currency, lineId);
          priceObservations++;
          pricedObserved = true;
        }

        lines.push({
          description: line.description,
          ingredientId,
          confidence,
          unitPrice,
          unit,
          pricedObserved,
        });
      }

      return { receiptId, lines, newIngredients, priceObservations };
    });

    return run();
  }

  /** True if a page with this image content hash has already been ingested. */
  hasRecipe(imageSha256: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM recipe_ingests WHERE image_sha256 = ? LIMIT 1")
        .get(imageSha256) !== undefined
    );
  }

  /**
   * Persist every recipe read off one image. Writes one `recipe_ingests` row
   * (the image — content hash lives here, UNIQUE) and one `recipes` row per
   * recipe, each ingredient matched to the shared spine (source='recipe'). All
   * in one transaction, so a partial page never lands. No price observations —
   * recipes carry no prices (§5.4).
   *
   * The UNIQUE `image_sha256` on the ingest backstops double ingestion (the CLI
   * also checks `hasRecipe` first); a page with N recipes still hashes once.
   */
  saveRecipePage(
    page: RecipePage,
    imageFilename: string,
    parser: string,
    imageSha256: string | null = null,
  ): SaveRecipePageSummary {
    const run = this.db.transaction((): SaveRecipePageSummary => {
      const ingestId = Number(
        this.db
          .prepare(
            `INSERT INTO recipe_ingests (image_filename, image_sha256, parser, recipe_count, raw_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(imageFilename, imageSha256, parser, page.recipes.length, JSON.stringify(page))
          .lastInsertRowid,
      );

      const recipes: SaveRecipeSummary[] = [];
      let pageNewIngredients = 0;

      for (const recipe of page.recipes) {
        const recipeId = Number(
          this.db
            .prepare("INSERT INTO recipes (ingest_id, title, source_note, servings) VALUES (?, ?, ?, ?)")
            .run(ingestId, recipe.title, recipe.sourceNote, recipe.servings).lastInsertRowid,
        );

        const lines: RecipeLineOutcome[] = [];
        let newIngredients = 0;

        for (const line of recipe.ingredients) {
          const { ingredientId, confidence } = this.matchIngredient(line.ingredient, "recipe");
          if (confidence === "new") {
            newIngredients++;
            pageNewIngredients++;
          }

          this.db
            .prepare(
              `INSERT INTO recipe_ingredients
                 (recipe_id, raw_text, ingredient_text, quantity, unit, prep_note, optional, ingredient_id, match_confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              recipeId,
              line.rawText,
              line.ingredient,
              line.quantity,
              line.unit,
              line.prepNote,
              line.optional ? 1 : 0,
              ingredientId,
              confidence,
            );

          lines.push({
            ingredient: line.ingredient,
            ingredientId,
            confidence,
            optional: line.optional,
          });
        }

        recipes.push({ recipeId, title: recipe.title, lines, newIngredients });
      }

      return { ingestId, recipes, newIngredients: pageNewIngredients };
    });

    return run();
  }

  /**
   * Convenience wrapper for a single recipe — saves it as a one-recipe page and
   * returns that recipe's summary. Keeps single-recipe callers/tests simple.
   */
  saveRecipe(
    parsed: RecipeParseResult,
    imageFilename: string,
    parser: string,
    imageSha256: string | null = null,
  ): SaveRecipeSummary {
    const page = this.saveRecipePage({ recipes: [parsed] }, imageFilename, parser, imageSha256);
    const only = page.recipes[0];
    if (!only) throw new Error("saveRecipe: page produced no recipe");
    return only;
  }

  /** Quick counts for the end-of-run summary. */
  totals(): {
    ingredients: number;
    receipts: number;
    priceObservations: number;
    recipes: number;
  } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      ingredients: one("SELECT COUNT(*) AS n FROM ingredients"),
      receipts: one("SELECT COUNT(*) AS n FROM receipts"),
      priceObservations: one("SELECT COUNT(*) AS n FROM price_observations"),
      recipes: one("SELECT COUNT(*) AS n FROM recipes"),
    };
  }

  close(): void {
    this.db.close();
  }
}
