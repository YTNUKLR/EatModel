import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeName } from "../shared/units";
import { deriveUnitPrice } from "../shared/pricing";
import type { ReceiptParseResult } from "../shared/types";
import type { RecipeParseResult } from "../shared/recipe-types";

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

CREATE TABLE IF NOT EXISTS recipes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT,
  source_note    TEXT,
  servings       REAL,
  image_filename TEXT,
  image_sha256   TEXT UNIQUE,
  parser         TEXT,
  raw_json       TEXT,
  parsed_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
  lines: RecipeLineOutcome[];
  newIngredients: number;
}

export class Db {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(DDL);
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

  /** True if a recipe with this image content hash has already been ingested. */
  hasRecipe(imageSha256: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM recipes WHERE image_sha256 = ? LIMIT 1").get(imageSha256) !==
      undefined
    );
  }

  /**
   * Persist a parsed recipe: the recipe row plus each ingredient line, matched
   * to a canonical ingredient on the shared spine (source='recipe'). One
   * transaction so a partial recipe never lands in the db. No price
   * observations — recipes carry no prices (§5.4).
   *
   * `imageSha256` is the content hash of the source image; the UNIQUE column is
   * a backstop against double ingestion (the CLI also checks `hasRecipe` first).
   */
  saveRecipe(
    parsed: RecipeParseResult,
    imageFilename: string,
    parser: string,
    imageSha256: string | null = null,
  ): SaveRecipeSummary {
    const run = this.db.transaction((): SaveRecipeSummary => {
      const recipeId = Number(
        this.db
          .prepare(
            `INSERT INTO recipes (title, source_note, servings, image_filename, image_sha256, parser, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.title,
            parsed.sourceNote,
            parsed.servings,
            imageFilename,
            imageSha256,
            parser,
            JSON.stringify(parsed),
          ).lastInsertRowid,
      );

      const lines: RecipeLineOutcome[] = [];
      let newIngredients = 0;

      for (const line of parsed.ingredients) {
        const { ingredientId, confidence } = this.matchIngredient(line.ingredient, "recipe");
        if (confidence === "new") newIngredients++;

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

      return { recipeId, lines, newIngredients };
    });

    return run();
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
