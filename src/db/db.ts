import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeName } from "../shared/units";
import { deriveUnitPrice } from "../shared/pricing";
import {
  identityReviewReason,
  isSaneNumber,
  reviewLineReason,
  reconcileReceiptTotal,
} from "../shared/review";
import {
  rollupRecipeNutrition,
  type Macros,
  type NutritionRollup,
} from "../shared/nutrition";
import type { ReceiptParseResult } from "../shared/types";
import type { RecipeParseResult, RecipePage } from "../shared/recipe-types";

/**
 * The "ingredient spine" plus receipt + price tables, on SQLite. This is the
 * repository layer: the rest of the app talks to these typed methods, never to
 * raw SQL. Swapping SQLite → Postgres later changes this file only.
 *
 * DDL is plain CREATE TABLE IF NOT EXISTS plus a tiny idempotent migration
 * runner for the discovery phase (see ARCHITECTURE.md decision log).
 */
const FOOD_SEEDS: {
  fdcId: string | null;
  description: string;
  source: "manual" | "usda_fdc";
  macros: Macros;
}[] = [
  {
    fdcId: null,
    description: "Chicken thighs, boneless skinless, raw",
    source: "manual",
    macros: { calories: 143, proteinG: 19.7, carbsG: 0, fatG: 6.7 },
  },
  {
    fdcId: null,
    description: "Spinach, raw",
    source: "manual",
    macros: { calories: 23, proteinG: 2.9, carbsG: 3.6, fatG: 0.4 },
  },
  {
    fdcId: null,
    description: "Garlic, raw",
    source: "manual",
    macros: { calories: 149, proteinG: 6.4, carbsG: 33.1, fatG: 0.5 },
  },
  {
    fdcId: null,
    description: "Brown rice, dry",
    source: "manual",
    macros: { calories: 370, proteinG: 7.9, carbsG: 77.2, fatG: 2.9 },
  },
  {
    fdcId: null,
    description: "Butter, salted",
    source: "manual",
    macros: { calories: 717, proteinG: 0.9, carbsG: 0.1, fatG: 81.1 },
  },
  {
    fdcId: null,
    description: "Olive oil",
    source: "manual",
    macros: { calories: 884, proteinG: 0, carbsG: 0, fatG: 100 },
  },
  {
    fdcId: null,
    description: "Salt, table",
    source: "manual",
    macros: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  },
  {
    fdcId: null,
    description: "Sugar, granulated",
    source: "manual",
    macros: { calories: 387, proteinG: 0, carbsG: 100, fatG: 0 },
  },
  {
    fdcId: null,
    description: "Red pepper flakes",
    source: "manual",
    macros: { calories: 318, proteinG: 12, carbsG: 57, fatG: 17 },
  },
];

const DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many raw receipt store spellings resolve to one canonical store.
CREATE TABLE IF NOT EXISTS store_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id   INTEGER NOT NULL REFERENCES stores(id),
  alias_text TEXT NOT NULL,
  normalized TEXT NOT NULL UNIQUE,
  source     TEXT CHECK (source IS NULL OR source IN ('receipt', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reference nutrition catalog. foods are facts about reference foods, not
-- canonical household ingredients. Ingredients link here through a gated status.
CREATE TABLE IF NOT EXISTS foods (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  fdc_id              TEXT UNIQUE,
  description         TEXT NOT NULL UNIQUE,
  source              TEXT NOT NULL CHECK (source IN ('usda_fdc', 'manual')),
  calories_per_100g   REAL NOT NULL CHECK (calories_per_100g >= 0),
  protein_g_per_100g  REAL NOT NULL CHECK (protein_g_per_100g >= 0),
  carbs_g_per_100g    REAL NOT NULL CHECK (carbs_g_per_100g >= 0),
  fat_g_per_100g      REAL NOT NULL CHECK (fat_g_per_100g >= 0),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ingredients (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  category       TEXT,
  default_unit   TEXT,
  density_g_per_ml REAL CHECK (density_g_per_ml IS NULL OR density_g_per_ml > 0),
  grams_per_each REAL CHECK (grams_per_each IS NULL OR grams_per_each > 0),
  food_id        INTEGER REFERENCES foods(id),
  food_link_status TEXT CHECK (food_link_status IS NULL OR food_link_status IN ('proposed', 'confirmed')),
  -- Review gate: a freshly-minted ingredient is 'unconfirmed' until a human
  -- confirms (or merges) it, so unreviewed matches don't harden into the spine.
  status         TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (food_id IS NULL AND food_link_status IS NULL) OR
    (food_id IS NOT NULL AND food_link_status IN ('proposed', 'confirmed'))
  )
);

-- Many spellings (recipe text, receipt text) resolve to one ingredient.
CREATE TABLE IF NOT EXISTS ingredient_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  alias_text    TEXT NOT NULL,
  normalized    TEXT NOT NULL UNIQUE,
  source        TEXT CHECK (source IS NULL OR source IN ('receipt', 'recipe', 'manual')),
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
  store_id       INTEGER REFERENCES stores(id),
  store_match_confidence TEXT CHECK (store_match_confidence IS NULL OR store_match_confidence IN ('alias', 'new', 'unmatched')),
  parser         TEXT,
  raw_json       TEXT,
  -- Set when line items don't reconcile against the printed total (see review).
  needs_review   INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  review_reason  TEXT,
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
  match_confidence TEXT CHECK (match_confidence IN ('alias', 'new', 'unmatched')),
  -- Flagged (not dropped) when a value is untrustworthy — empty name, negative price, etc.
  needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  review_reason    TEXT
);

-- The append-only price fact table. Everything cost-related builds on this.
CREATE TABLE IF NOT EXISTS price_observations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id   INTEGER NOT NULL REFERENCES ingredients(id),
  store           TEXT,
  store_id         INTEGER REFERENCES stores(id),
  observed_at     TEXT,
  unit            TEXT,
  unit_price      REAL NOT NULL CHECK (unit_price >= 0),
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
  recipe_count   INTEGER CHECK (recipe_count > 0),
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
  optional         INTEGER NOT NULL CHECK (optional IN (0, 1)),
  ingredient_id    INTEGER REFERENCES ingredients(id),
  match_confidence TEXT CHECK (match_confidence IN ('alias', 'new', 'unmatched')),
  -- Flagged (not dropped) when a value is untrustworthy — empty name, negative qty.
  needs_review     INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0, 1)),
  review_reason    TEXT
);
`;

export type MatchConfidence = "alias" | "new";

export interface LineOutcome {
  description: string;
  ingredientId: number | null;
  confidence: MatchConfidence | "unmatched";
  unitPrice: number | null;
  unit: string | null;
  pricedObserved: boolean;
  needsReview: boolean;
}

export interface SaveSummary {
  receiptId: number;
  storeId: number | null;
  storeConfidence: MatchConfidence | "unmatched";
  lines: LineOutcome[];
  newStores: number;
  newIngredients: number;
  priceObservations: number;
  /** True if the receipt's line items didn't reconcile against the total. */
  needsReview: boolean;
  reviewReason: string | null;
}

export interface RecipeLineOutcome {
  ingredient: string;
  ingredientId: number | null;
  confidence: MatchConfidence | "unmatched";
  optional: boolean;
  needsReview: boolean;
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

/** An ingredient awaiting human confirmation (review gate). */
export interface UnconfirmedIngredient {
  id: number;
  canonicalName: string;
  aliases: number;
}

/** A flagged line surfaced by the review CLI. */
export interface ReviewLine {
  source: "receipt" | "recipe";
  lineId: number;
  description: string;
  reason: string;
}

/** A receipt whose totals didn't reconcile. */
export interface ReviewReceipt {
  id: number;
  store: string | null;
  reason: string;
}

export interface UnconfirmedStore {
  id: number;
  canonicalName: string;
  aliases: number;
  receipts: number;
}

export interface Food {
  id: number;
  fdcId: string | null;
  description: string;
  source: "manual" | "usda_fdc";
  nutrition: Macros;
}

export interface ProposedFoodLink {
  ingredientId: number;
  ingredientName: string;
  foodId: number;
  foodDescription: string;
}

export interface IngredientMissingFoodLink {
  id: number;
  canonicalName: string;
}

export interface RecipeNutritionSummary {
  recipeId: number;
  title: string | null;
  servings: number | null;
  nutrition: NutritionRollup;
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

  private applyMigration(name: string, run: () => void): void {
    const applied =
      this.db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name) !== undefined;
    if (applied) return;

    this.db.transaction(() => {
      run();
      this.db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
    })();
  }

  /**
   * Discovery-phase migrations. `CREATE TABLE IF NOT EXISTS` leaves pre-existing
   * tables on their old shape, so we reconcile here:
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
          "by the discovery migration runner — run `npm run db:reset` to recreate it.",
      );
    }

    this.applyMigration("001_receipt_image_hash", () => {
      // Added with the ingestion-safety work; recoverable on old receipt tables.
      // (ALTER can't add a column with UNIQUE, so add it plain + a UNIQUE index.)
      if (this.tableExists("receipts") && !this.columnExists("receipts", "image_sha256")) {
        this.db.exec("ALTER TABLE receipts ADD COLUMN image_sha256 TEXT");
      }
      this.db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_image_sha256 ON receipts(image_sha256)",
      );
    });

    this.applyMigration("002_review_gate_columns", () => {
      // Review-gate columns. ALTER ADD COLUMN with a DEFAULT backfills existing
      // rows safely (pre-gate ingredients become 'unconfirmed', which is correct —
      // they were never reviewed).
      const reviewColumns: [string, string, string][] = [
        ["ingredients", "status", "TEXT NOT NULL DEFAULT 'unconfirmed'"],
        ["receipts", "needs_review", "INTEGER NOT NULL DEFAULT 0"],
        ["receipts", "review_reason", "TEXT"],
        ["receipt_line_items", "needs_review", "INTEGER NOT NULL DEFAULT 0"],
        ["receipt_line_items", "review_reason", "TEXT"],
        ["recipe_ingredients", "needs_review", "INTEGER NOT NULL DEFAULT 0"],
        ["recipe_ingredients", "review_reason", "TEXT"],
      ];
      for (const [table, column, decl] of reviewColumns) {
        if (this.tableExists(table) && !this.columnExists(table, column)) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
        }
      }
    });

    this.applyMigration("003_foods_nutrition", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS foods (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          fdc_id              TEXT UNIQUE,
          description         TEXT NOT NULL UNIQUE,
          source              TEXT NOT NULL CHECK (source IN ('usda_fdc', 'manual')),
          calories_per_100g   REAL NOT NULL CHECK (calories_per_100g >= 0),
          protein_g_per_100g  REAL NOT NULL CHECK (protein_g_per_100g >= 0),
          carbs_g_per_100g    REAL NOT NULL CHECK (carbs_g_per_100g >= 0),
          fat_g_per_100g      REAL NOT NULL CHECK (fat_g_per_100g >= 0),
          created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const nutritionColumns: [string, string][] = [
        ["default_unit", "TEXT"],
        ["density_g_per_ml", "REAL CHECK (density_g_per_ml IS NULL OR density_g_per_ml > 0)"],
        ["grams_per_each", "REAL CHECK (grams_per_each IS NULL OR grams_per_each > 0)"],
        ["food_id", "INTEGER REFERENCES foods(id)"],
        [
          "food_link_status",
          "TEXT CHECK (food_link_status IS NULL OR food_link_status IN ('proposed', 'confirmed'))",
        ],
      ];
      for (const [column, decl] of nutritionColumns) {
        if (this.tableExists("ingredients") && !this.columnExists("ingredients", column)) {
          this.db.exec(`ALTER TABLE ingredients ADD COLUMN ${column} ${decl}`);
        }
      }
    });

    this.applyMigration("004_store_identity", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS stores (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          canonical_name TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed')),
          created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS store_aliases (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          store_id   INTEGER NOT NULL REFERENCES stores(id),
          alias_text TEXT NOT NULL,
          normalized TEXT NOT NULL UNIQUE,
          source     TEXT CHECK (source IS NULL OR source IN ('receipt', 'manual')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const receiptColumns: [string, string][] = [
        ["store_id", "INTEGER REFERENCES stores(id)"],
        [
          "store_match_confidence",
          "TEXT CHECK (store_match_confidence IS NULL OR store_match_confidence IN ('alias', 'new', 'unmatched'))",
        ],
      ];
      for (const [column, decl] of receiptColumns) {
        if (this.tableExists("receipts") && !this.columnExists("receipts", column)) {
          this.db.exec(`ALTER TABLE receipts ADD COLUMN ${column} ${decl}`);
        }
      }
      if (this.tableExists("price_observations") && !this.columnExists("price_observations", "store_id")) {
        this.db.exec("ALTER TABLE price_observations ADD COLUMN store_id INTEGER REFERENCES stores(id)");
      }
    });

    this.backfillStoreLinks();
    this.seedFoods();
  }

  private backfillStoreLinks(): void {
    if (!this.tableExists("receipts") || !this.columnExists("receipts", "store_id")) return;
    if (!this.tableExists("price_observations") || !this.columnExists("price_observations", "store_id")) {
      return;
    }

    const stores = this.db
      .prepare(
        `SELECT DISTINCT store
         FROM receipts
         WHERE store_id IS NULL
           AND store_match_confidence IS NULL
           AND store IS NOT NULL
           AND trim(store) <> ''
         ORDER BY store`,
      )
      .all() as { store: string }[];

    this.db.transaction(() => {
      for (const row of stores) {
        const match = this.matchStore(row.store);
        this.db
          .prepare(
            `UPDATE receipts
             SET store_id = ?, store_match_confidence = ?
             WHERE store_id IS NULL AND store = ?`,
          )
          .run(match.storeId, match.confidence, row.store);
      }

      this.db.exec(`
        UPDATE price_observations
        SET store_id = (
          SELECT receipts.store_id
          FROM receipt_line_items
          JOIN receipts ON receipts.id = receipt_line_items.receipt_id
          WHERE receipt_line_items.id = price_observations.source_line_id
        )
        WHERE store_id IS NULL;
      `);
    })();
  }

  private seedFoods(): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO foods
         (fdc_id, description, source, calories_per_100g, protein_g_per_100g, carbs_g_per_100g, fat_g_per_100g)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const food of FOOD_SEEDS) {
      insert.run(
        food.fdcId,
        food.description,
        food.source,
        food.macros.calories,
        food.macros.proteinG,
        food.macros.carbsG,
        food.macros.fatG,
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

  /**
   * Resolve parsed receipt store text to a canonical store. Raw text remains on
   * receipts/price observations; the store_id is the canonical spine. New stores
   * start unconfirmed and can later be confirmed or merged.
   */
  private matchStore(store: string | null): { storeId: number | null; confidence: MatchConfidence | "unmatched" } {
    if (store == null || store.trim() === "" || normalizeName(store) === "") {
      return { storeId: null, confidence: "unmatched" };
    }
    const normalized = normalizeName(store);
    const existing = this.db
      .prepare("SELECT store_id AS id FROM store_aliases WHERE normalized = ?")
      .get(normalized) as { id: number } | undefined;
    if (existing) return { storeId: existing.id, confidence: "alias" };

    const inserted = this.db
      .prepare("INSERT INTO stores (canonical_name) VALUES (?)")
      .run(store.trim());
    const storeId = Number(inserted.lastInsertRowid);
    this.db
      .prepare(
        "INSERT INTO store_aliases (store_id, alias_text, normalized, source) VALUES (?, ?, ?, 'receipt')",
      )
      .run(storeId, store.trim(), normalized);
    return { storeId, confidence: "new" };
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
      const storeMatch = this.matchStore(parsed.store);
      const receiptId = Number(
        this.db
          .prepare(
            `INSERT INTO receipts
               (store, purchased_at, total, currency, image_filename, image_sha256, store_id, store_match_confidence, parser, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.store,
            parsed.purchasedAt,
            parsed.total,
            parsed.currency,
            imageFilename,
            imageSha256,
            storeMatch.storeId,
            storeMatch.confidence,
            parser,
            JSON.stringify(parsed),
          ).lastInsertRowid,
      );

      // Don't fabricate a purchase date — record what was read (possibly null).
      // The price itself is known; the *when* may not be. (CONVENTIONS.md §5)
      const observedAt = parsed.purchasedAt;
      const lines: LineOutcome[] = [];
      const validLineTotals: number[] = [];
      let newIngredients = 0;
      let priceObservations = 0;

      for (const line of parsed.lines) {
        // Flag (don't drop) lines with untrustworthy values — §5.5.
        const reason = reviewLineReason(line.description, [
          { label: "quantity", value: line.quantity },
          { label: "unitPrice", value: line.unitPrice },
          { label: "lineTotal", value: line.lineTotal },
        ]);
        const invalidIdentity = identityReviewReason(line.description) != null;
        let ingredientId: number | null = null;
        let confidence: MatchConfidence | "unmatched" = "unmatched";
        if (!invalidIdentity) {
          const match = this.matchIngredient(line.description, "receipt");
          ingredientId = match.ingredientId;
          confidence = match.confidence;
          if (confidence === "new") newIngredients++;
        }

        const lineId = Number(
          this.db
            .prepare(
              `INSERT INTO receipt_line_items
                 (receipt_id, raw_text, description, quantity, unit, unit_price, line_total, ingredient_id, match_confidence, needs_review, review_reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              reason ? 1 : 0,
              reason,
            ).lastInsertRowid,
        );

        // Per-unit price: explicit if printed, else derived (see shared/pricing).
        // Don't fabricate a unit either — store what was read, null if absent.
        const unitPrice = deriveUnitPrice(line);
        const unit = line.unit;

        // Only record a price observation from a sane, non-flagged price — a
        // bad price must never become a "fact" downstream cost math trusts.
        let pricedObserved = false;
        if (ingredientId != null && unitPrice != null && isSaneNumber(unitPrice) && !reason) {
          this.db
            .prepare(
              `INSERT INTO price_observations
                 (ingredient_id, store, store_id, observed_at, unit, unit_price, currency, source_line_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              ingredientId,
              parsed.store,
              storeMatch.storeId,
              observedAt,
              unit,
              unitPrice,
              parsed.currency,
              lineId,
            );
          priceObservations++;
          pricedObserved = true;
        }

        if (line.lineTotal != null && isSaneNumber(line.lineTotal)) {
          validLineTotals.push(line.lineTotal);
        }

        lines.push({
          description: line.description,
          ingredientId,
          confidence,
          unitPrice,
          unit,
          pricedObserved,
          needsReview: reason != null,
        });
      }

      // Receipt-level sanity: do the line items reconcile against the total?
      const reviewReason = reconcileReceiptTotal(parsed.total, validLineTotals);
      if (reviewReason) {
        this.db
          .prepare("UPDATE receipts SET needs_review = 1, review_reason = ? WHERE id = ?")
          .run(reviewReason, receiptId);
      }

      return {
        receiptId,
        storeId: storeMatch.storeId,
        storeConfidence: storeMatch.confidence,
        lines,
        newStores: storeMatch.confidence === "new" ? 1 : 0,
        newIngredients,
        priceObservations,
        needsReview: reviewReason != null,
        reviewReason,
      };
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
    if (page.recipes.length === 0) {
      throw new Error("saveRecipePage: page has no recipes");
    }
    if (page.recipes.some((recipe) => recipe.ingredients.length === 0)) {
      throw new Error("saveRecipePage: recipe has no ingredients");
    }

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
          // Flag (don't drop) lines with untrustworthy values — §5.5.
          const reason = reviewLineReason(line.ingredient, [
            { label: "quantity", value: line.quantity },
          ]);
          const invalidIdentity = identityReviewReason(line.ingredient) != null;
          let ingredientId: number | null = null;
          let confidence: MatchConfidence | "unmatched" = "unmatched";
          if (!invalidIdentity) {
            const match = this.matchIngredient(line.ingredient, "recipe");
            ingredientId = match.ingredientId;
            confidence = match.confidence;
            if (confidence === "new") {
              newIngredients++;
              pageNewIngredients++;
            }
          }

          this.db
            .prepare(
              `INSERT INTO recipe_ingredients
                 (recipe_id, raw_text, ingredient_text, quantity, unit, prep_note, optional, ingredient_id, match_confidence, needs_review, review_reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
              reason ? 1 : 0,
              reason,
            );

          lines.push({
            ingredient: line.ingredient,
            ingredientId,
            confidence,
            optional: line.optional,
            needsReview: reason != null,
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

  // --- Review gate (§5.5) -------------------------------------------------

  /** Ingredients still awaiting human confirmation, newest first. */
  listUnconfirmedIngredients(): UnconfirmedIngredient[] {
    return this.db
      .prepare(
        `SELECT i.id AS id, i.canonical_name AS canonicalName,
                (SELECT COUNT(*) FROM ingredient_aliases a WHERE a.ingredient_id = i.id) AS aliases
         FROM ingredients i
         WHERE i.status = 'unconfirmed'
         ORDER BY i.id DESC`,
      )
      .all() as UnconfirmedIngredient[];
  }

  /** Stores still awaiting human confirmation, newest first. */
  listUnconfirmedStores(): UnconfirmedStore[] {
    return this.db
      .prepare(
        `SELECT s.id AS id, s.canonical_name AS canonicalName,
                (SELECT COUNT(*) FROM store_aliases a WHERE a.store_id = s.id) AS aliases,
                (SELECT COUNT(*) FROM receipts r WHERE r.store_id = s.id) AS receipts
         FROM stores s
         WHERE s.status = 'unconfirmed'
         ORDER BY s.id DESC`,
      )
      .all() as UnconfirmedStore[];
  }

  /** Flagged receipt + recipe lines, for the review CLI. */
  listLinesNeedingReview(): ReviewLine[] {
    const receipt = this.db
      .prepare(
        `SELECT id AS lineId, description, review_reason AS reason
         FROM receipt_line_items WHERE needs_review = 1 ORDER BY id`,
      )
      .all() as { lineId: number; description: string | null; reason: string }[];
    const recipe = this.db
      .prepare(
        `SELECT id AS lineId, ingredient_text AS description, review_reason AS reason
         FROM recipe_ingredients WHERE needs_review = 1 ORDER BY id`,
      )
      .all() as { lineId: number; description: string | null; reason: string }[];
    return [
      ...receipt.map((r) => ({ source: "receipt" as const, ...r, description: r.description ?? "" })),
      ...recipe.map((r) => ({ source: "recipe" as const, ...r, description: r.description ?? "" })),
    ];
  }

  /** Receipts whose line items didn't reconcile against the total. */
  listReceiptsNeedingReview(): ReviewReceipt[] {
    return this.db
      .prepare(
        `SELECT id, store, review_reason AS reason
         FROM receipts WHERE needs_review = 1 ORDER BY id`,
      )
      .all() as ReviewReceipt[];
  }

  /** Confirm an ingredient — it's now a trusted part of the spine. */
  confirmIngredient(id: number): void {
    const res = this.db.prepare("UPDATE ingredients SET status = 'confirmed' WHERE id = ?").run(id);
    if (res.changes === 0) throw new Error(`no ingredient with id ${id}`);
  }

  /** Confirm a store — it's now trusted for canonical price comparisons. */
  confirmStore(id: number): void {
    const res = this.db.prepare("UPDATE stores SET status = 'confirmed' WHERE id = ?").run(id);
    if (res.changes === 0) throw new Error(`no store with id ${id}`);
  }

  /** Seeded/manual reference foods available for nutrition links. */
  listFoods(query: string | null = null): Food[] {
    const rows = (
      query == null || query.trim() === ""
        ? this.db
            .prepare(
              `SELECT id, fdc_id AS fdcId, description, source,
                      calories_per_100g AS calories, protein_g_per_100g AS proteinG,
                      carbs_g_per_100g AS carbsG, fat_g_per_100g AS fatG
               FROM foods ORDER BY description`,
            )
            .all()
        : this.db
            .prepare(
              `SELECT id, fdc_id AS fdcId, description, source,
                      calories_per_100g AS calories, protein_g_per_100g AS proteinG,
                      carbs_g_per_100g AS carbsG, fat_g_per_100g AS fatG
               FROM foods
               WHERE lower(description) LIKE ?
               ORDER BY description`,
            )
            .all(`%${query.toLowerCase()}%`)
    ) as (Omit<Food, "nutrition"> & Macros)[];

    return rows.map((r) => ({
      id: r.id,
      fdcId: r.fdcId,
      description: r.description,
      source: r.source,
      nutrition: {
        calories: r.calories,
        proteinG: r.proteinG,
        carbsG: r.carbsG,
        fatG: r.fatG,
      },
    }));
  }

  /** Propose an ingredient → reference food link. It is not trusted until confirmed. */
  proposeIngredientFoodLink(ingredientId: number, foodId: number): void {
    const foodExists = this.db.prepare("SELECT 1 FROM foods WHERE id = ?").get(foodId) !== undefined;
    if (!foodExists) throw new Error(`no food with id ${foodId}`);
    const res = this.db
      .prepare("UPDATE ingredients SET food_id = ?, food_link_status = 'proposed' WHERE id = ?")
      .run(foodId, ingredientId);
    if (res.changes === 0) throw new Error(`no ingredient with id ${ingredientId}`);
  }

  /** Promote a proposed ingredient → food link so nutrition rollups can use it. */
  confirmIngredientFoodLink(ingredientId: number): void {
    const row = this.db
      .prepare("SELECT food_id AS foodId FROM ingredients WHERE id = ?")
      .get(ingredientId) as { foodId: number | null } | undefined;
    if (!row) throw new Error(`no ingredient with id ${ingredientId}`);
    if (row.foodId == null) throw new Error(`ingredient ${ingredientId} has no food link to confirm`);
    this.db
      .prepare("UPDATE ingredients SET food_link_status = 'confirmed' WHERE id = ?")
      .run(ingredientId);
  }

  /** Remove a mistaken food link without touching aliases/receipt/recipe history. */
  unlinkIngredientFood(ingredientId: number): void {
    const res = this.db
      .prepare("UPDATE ingredients SET food_id = NULL, food_link_status = NULL WHERE id = ?")
      .run(ingredientId);
    if (res.changes === 0) throw new Error(`no ingredient with id ${ingredientId}`);
  }

  setIngredientDensity(ingredientId: number, densityGPerMl: number): void {
    if (!Number.isFinite(densityGPerMl) || densityGPerMl <= 0) {
      throw new Error(`density_g_per_ml must be positive, got ${densityGPerMl}`);
    }
    const res = this.db
      .prepare("UPDATE ingredients SET density_g_per_ml = ? WHERE id = ?")
      .run(densityGPerMl, ingredientId);
    if (res.changes === 0) throw new Error(`no ingredient with id ${ingredientId}`);
  }

  setIngredientGramsPerEach(ingredientId: number, gramsPerEach: number): void {
    if (!Number.isFinite(gramsPerEach) || gramsPerEach <= 0) {
      throw new Error(`grams_per_each must be positive, got ${gramsPerEach}`);
    }
    const res = this.db
      .prepare("UPDATE ingredients SET grams_per_each = ? WHERE id = ?")
      .run(gramsPerEach, ingredientId);
    if (res.changes === 0) throw new Error(`no ingredient with id ${ingredientId}`);
  }

  listProposedFoodLinks(): ProposedFoodLink[] {
    return this.db
      .prepare(
        `SELECT i.id AS ingredientId, i.canonical_name AS ingredientName,
                f.id AS foodId, f.description AS foodDescription
         FROM ingredients i
         JOIN foods f ON f.id = i.food_id
         WHERE i.food_link_status = 'proposed'
         ORDER BY i.id`,
      )
      .all() as ProposedFoodLink[];
  }

  listIngredientsMissingFoodLink(): IngredientMissingFoodLink[] {
    return this.db
      .prepare(
        `SELECT id, canonical_name AS canonicalName
         FROM ingredients
         WHERE status = 'confirmed' AND food_id IS NULL
         ORDER BY canonical_name`,
      )
      .all() as IngredientMissingFoodLink[];
  }

  recipeNutrition(recipeId: number): RecipeNutritionSummary {
    const recipe = this.db
      .prepare("SELECT id AS recipeId, title, servings FROM recipes WHERE id = ?")
      .get(recipeId) as { recipeId: number; title: string | null; servings: number | null } | undefined;
    if (!recipe) throw new Error(`no recipe with id ${recipeId}`);

    const rows = this.db
      .prepare(
        `SELECT ri.ingredient_text AS ingredientText, ri.quantity, ri.unit, ri.optional,
                i.canonical_name AS canonicalName,
                i.density_g_per_ml AS densityGPerMl,
                i.grams_per_each AS gramsPerEach,
                i.food_link_status AS foodLinkStatus,
                f.calories_per_100g AS calories,
                f.protein_g_per_100g AS proteinG,
                f.carbs_g_per_100g AS carbsG,
                f.fat_g_per_100g AS fatG
         FROM recipe_ingredients ri
         LEFT JOIN ingredients i ON i.id = ri.ingredient_id
         LEFT JOIN foods f ON f.id = i.food_id
         WHERE ri.recipe_id = ?
         ORDER BY ri.id`,
      )
      .all(recipeId) as {
      ingredientText: string | null;
      quantity: number | null;
      unit: string | null;
      optional: 0 | 1;
      canonicalName: string | null;
      densityGPerMl: number | null;
      gramsPerEach: number | null;
      foodLinkStatus: "proposed" | "confirmed" | null;
      calories: number | null;
      proteinG: number | null;
      carbsG: number | null;
      fatG: number | null;
    }[];

    const nutrition = rollupRecipeNutrition(
      rows.map((r) => {
        const confirmedFood =
          r.foodLinkStatus === "confirmed" &&
          r.calories != null &&
          r.proteinG != null &&
          r.carbsG != null &&
          r.fatG != null
            ? {
                calories: r.calories,
                proteinG: r.proteinG,
                carbsG: r.carbsG,
                fatG: r.fatG,
              }
            : null;
        return {
          ingredientName: r.canonicalName ?? r.ingredientText ?? "(unknown ingredient)",
          quantity: r.quantity,
          unit: r.unit,
          optional: r.optional === 1,
          food: confirmedFood,
          foodLinkStatus: r.foodLinkStatus,
          densityGPerMl: r.densityGPerMl,
          gramsPerEach: r.gramsPerEach,
        };
      }),
      recipe.servings,
    );

    return { ...recipe, nutrition };
  }

  listRecipeNutrition(): RecipeNutritionSummary[] {
    const recipes = this.db
      .prepare("SELECT id AS recipeId FROM recipes ORDER BY id")
      .all() as { recipeId: number }[];
    return recipes.map((r) => this.recipeNutrition(r.recipeId));
  }

  /** Mark a flagged line as reviewed. The original reason stays in raw data/history. */
  resolveLineReview(source: "receipt" | "recipe", lineId: number): void {
    const table = source === "receipt" ? "receipt_line_items" : "recipe_ingredients";
    const exists = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(lineId) !== undefined;
    if (!exists) throw new Error(`no ${source} line with id ${lineId}`);
    this.db.prepare(`UPDATE ${table} SET needs_review = 0 WHERE id = ?`).run(lineId);
  }

  /** Mark an unreconciled receipt as reviewed. */
  resolveReceiptReview(id: number): void {
    const exists = this.db.prepare("SELECT 1 FROM receipts WHERE id = ?").get(id) !== undefined;
    if (!exists) throw new Error(`no receipt with id ${id}`);
    this.db.prepare("UPDATE receipts SET needs_review = 0 WHERE id = ?").run(id);
  }

  /**
   * Merge a duplicate/fragment ingredient into another — the remedy for spine
   * fragmentation (e.g. fold "SR FLOUR" into "self-raising flour"). Re-points
   * every alias, line, and price observation from `fromId` to `intoId`, then
   * deletes the now-empty source. One transaction.
   */
  mergeIngredient(fromId: number, intoId: number): void {
    if (fromId === intoId) throw new Error("cannot merge an ingredient into itself");
    const exists = (id: number) =>
      this.db.prepare("SELECT 1 FROM ingredients WHERE id = ?").get(id) !== undefined;
    this.db.transaction(() => {
      if (!exists(fromId)) throw new Error(`no ingredient with id ${fromId}`);
      if (!exists(intoId)) throw new Error(`no ingredient with id ${intoId}`);
      const facts = (id: number) =>
        this.db
          .prepare(
            `SELECT food_id AS foodId, food_link_status AS foodLinkStatus,
                    default_unit AS defaultUnit, density_g_per_ml AS densityGPerMl,
                    grams_per_each AS gramsPerEach
             FROM ingredients WHERE id = ?`,
          )
          .get(id) as {
          foodId: number | null;
          foodLinkStatus: "proposed" | "confirmed" | null;
          defaultUnit: string | null;
          densityGPerMl: number | null;
          gramsPerEach: number | null;
        };
      const fromFacts = facts(fromId);
      const intoFacts = facts(intoId);

      // Preserve accumulated nutrition/conversion judgment when the kept
      // ingredient lacks it. If both sides have a value, the kept ingredient wins.
      if (intoFacts.foodId == null && fromFacts.foodId != null) {
        this.db
          .prepare("UPDATE ingredients SET food_id = ?, food_link_status = ? WHERE id = ?")
          .run(fromFacts.foodId, fromFacts.foodLinkStatus, intoId);
      }
      if (intoFacts.defaultUnit == null && fromFacts.defaultUnit != null) {
        this.db
          .prepare("UPDATE ingredients SET default_unit = ? WHERE id = ?")
          .run(fromFacts.defaultUnit, intoId);
      }
      if (intoFacts.densityGPerMl == null && fromFacts.densityGPerMl != null) {
        this.db
          .prepare("UPDATE ingredients SET density_g_per_ml = ? WHERE id = ?")
          .run(fromFacts.densityGPerMl, intoId);
      }
      if (intoFacts.gramsPerEach == null && fromFacts.gramsPerEach != null) {
        this.db
          .prepare("UPDATE ingredients SET grams_per_each = ? WHERE id = ?")
          .run(fromFacts.gramsPerEach, intoId);
      }

      for (const table of [
        "ingredient_aliases",
        "receipt_line_items",
        "recipe_ingredients",
        "price_observations",
      ]) {
        this.db
          .prepare(`UPDATE ${table} SET ingredient_id = ? WHERE ingredient_id = ?`)
          .run(intoId, fromId);
      }
      this.db.prepare("DELETE FROM ingredients WHERE id = ?").run(fromId);
    })();
  }

  /**
   * Merge a duplicate/fragment store into another. Raw receipt.store text stays
   * unchanged; canonical store_id links and aliases move to the kept store.
   */
  mergeStore(fromId: number, intoId: number): void {
    if (fromId === intoId) throw new Error("cannot merge a store into itself");
    const exists = (id: number) =>
      this.db.prepare("SELECT 1 FROM stores WHERE id = ?").get(id) !== undefined;
    this.db.transaction(() => {
      if (!exists(fromId)) throw new Error(`no store with id ${fromId}`);
      if (!exists(intoId)) throw new Error(`no store with id ${intoId}`);
      for (const table of ["store_aliases", "receipts", "price_observations"]) {
        this.db
          .prepare(`UPDATE ${table} SET store_id = ? WHERE store_id = ?`)
          .run(intoId, fromId);
      }
      this.db.prepare("DELETE FROM stores WHERE id = ?").run(fromId);
    })();
  }

  /** Quick counts for the end-of-run summary. */
  totals(): {
    ingredients: number;
    receipts: number;
    priceObservations: number;
    recipes: number;
    stores: number;
  } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      ingredients: one("SELECT COUNT(*) AS n FROM ingredients"),
      receipts: one("SELECT COUNT(*) AS n FROM receipts"),
      priceObservations: one("SELECT COUNT(*) AS n FROM price_observations"),
      recipes: one("SELECT COUNT(*) AS n FROM recipes"),
      stores: one("SELECT COUNT(*) AS n FROM stores"),
    };
  }

  close(): void {
    this.db.close();
  }
}
