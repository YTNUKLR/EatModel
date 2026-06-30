import fs from "node:fs";
import { Db } from "../db/db";

// Load .env for EATMODEL_DB if set; this CLI never calls the network.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

const USAGE = `Review gate — inspect and resolve what the ingest flagged.

  npm run review                  list unconfirmed ingredients + flagged lines + unreconciled receipts
  npm run review -- confirm <id>  mark ingredient <id> as confirmed (trusted spine)
  npm run review -- merge <from> <into>
                                  fold ingredient <from> into <into> (de-fragment the spine)
  npm run review -- resolve-line <receipt|recipe> <line-id>
                                  clear a flagged line after human review
  npm run review -- resolve-receipt <id>
                                  clear a receipt total warning after human review
`;

function list(db: Db): void {
  const ingredients = db.listUnconfirmedIngredients();
  const lines = db.listLinesNeedingReview();
  const receipts = db.listReceiptsNeedingReview();

  console.log(`Unconfirmed ingredients (${ingredients.length}):`);
  if (ingredients.length === 0) console.log("  (none)");
  for (const i of ingredients) {
    console.log(`  #${i.id}  ${i.canonicalName}  (${i.aliases} alias${i.aliases === 1 ? "" : "es"})`);
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

  if (ingredients.length || lines.length || receipts.length) {
    console.log(
      `\nResolve with:  npm run review -- confirm <id>   |   npm run review -- merge <from> <into>` +
        `   |   npm run review -- resolve-line <receipt|recipe> <line-id>` +
        `   |   npm run review -- resolve-receipt <id>`,
    );
  }
}

function intArg(value: string | undefined, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`expected an integer ${name}, got "${value ?? ""}"`);
  return n;
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
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main();
