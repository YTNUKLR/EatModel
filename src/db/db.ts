import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { normalizeName } from "../shared/units";
import { deriveUnitPrice } from "../shared/pricing";
import type { ReceiptParseResult } from "../shared/types";

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
  private matchIngredient(description: string): { ingredientId: number; confidence: MatchConfidence } {
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
        "INSERT INTO ingredient_aliases (ingredient_id, alias_text, normalized, source) VALUES (?, ?, ?, 'receipt')",
      )
      .run(ingredientId, description.trim(), normalized);
    return { ingredientId, confidence: "new" };
  }

  /**
   * Persist a parsed receipt: the receipt row, each line item (matched to an
   * ingredient), and a price observation per priced line. Wrapped in one
   * transaction so a partial receipt never lands in the db.
   */
  saveReceipt(parsed: ReceiptParseResult, imageFilename: string, parser: string): SaveSummary {
    const run = this.db.transaction((): SaveSummary => {
      const receiptId = Number(
        this.db
          .prepare(
            `INSERT INTO receipts (store, purchased_at, total, currency, image_filename, parser, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            parsed.store,
            parsed.purchasedAt,
            parsed.total,
            parsed.currency,
            imageFilename,
            parser,
            JSON.stringify(parsed),
          ).lastInsertRowid,
      );

      const observedAt = parsed.purchasedAt ?? new Date().toISOString().slice(0, 10);
      const lines: LineOutcome[] = [];
      let newIngredients = 0;
      let priceObservations = 0;

      for (const line of parsed.lines) {
        const { ingredientId, confidence } = this.matchIngredient(line.description);
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
        const unitPrice = deriveUnitPrice(line);
        const unit = line.unit ?? "each";

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

  /** Quick counts for the end-of-run summary. */
  totals(): { ingredients: number; receipts: number; priceObservations: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      ingredients: one("SELECT COUNT(*) AS n FROM ingredients"),
      receipts: one("SELECT COUNT(*) AS n FROM receipts"),
      priceObservations: one("SELECT COUNT(*) AS n FROM price_observations"),
    };
  }

  close(): void {
    this.db.close();
  }
}
