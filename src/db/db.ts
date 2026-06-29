import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeName } from "../shared/units";
import { deriveUnitPrice } from "../shared/pricing";
import { isSaneNumber, reviewLineReason, reconcileReceiptTotal } from "../shared/review";
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
  -- Review gate: a freshly-minted ingredient is 'unconfirmed' until a human
  -- confirms (or merges) it, so unreviewed matches don't harden into the spine.
  status         TEXT NOT NULL DEFAULT 'unconfirmed',
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
  -- Set when line items don't reconcile against the printed total (see review).
  needs_review   INTEGER NOT NULL DEFAULT 0,
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
  match_confidence TEXT,
  -- Flagged (not dropped) when a value is untrustworthy — empty name, negative price, etc.
  needs_review     INTEGER NOT NULL DEFAULT 0,
  review_reason    TEXT
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
  match_confidence TEXT,
  -- Flagged (not dropped) when a value is untrustworthy — empty name, negative qty.
  needs_review     INTEGER NOT NULL DEFAULT 0,
  review_reason    TEXT
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
  needsReview: boolean;
}

export interface SaveSummary {
  receiptId: number;
  lines: LineOutcome[];
  newIngredients: number;
  priceObservations: number;
  /** True if the receipt's line items didn't reconcile against the total. */
  needsReview: boolean;
  reviewReason: string | null;
}

export interface RecipeLineOutcome {
  ingredient: string;
  ingredientId: number;
  confidence: MatchConfidence;
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
      const validLineTotals: number[] = [];
      let newIngredients = 0;
      let priceObservations = 0;

      for (const line of parsed.lines) {
        const { ingredientId, confidence } = this.matchIngredient(line.description, "receipt");
        if (confidence === "new") newIngredients++;

        // Flag (don't drop) lines with untrustworthy values — §5.5.
        const reason = reviewLineReason(line.description, [
          { label: "quantity", value: line.quantity },
          { label: "unitPrice", value: line.unitPrice },
          { label: "lineTotal", value: line.lineTotal },
        ]);

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
        if (unitPrice != null && isSaneNumber(unitPrice) && !reason) {
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
        lines,
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

          // Flag (don't drop) lines with untrustworthy values — §5.5.
          const reason = reviewLineReason(line.ingredient, [
            { label: "quantity", value: line.quantity },
          ]);

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
