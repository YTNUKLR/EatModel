import fs from "node:fs";
import path from "node:path";
import { Db, type SaveSummary } from "../db/db";
import { LLMReceiptParser } from "../parser/llm";
import { MockReceiptParser } from "../parser/mock";
import { prepareImage } from "./prepare-image";
import type { ReceiptParser } from "../parser/types";
import type { ReceiptParseResult } from "../shared/types";

const INBOX = process.env.EATMODEL_INBOX ?? "receipts/inbox";
const PROCESSED = process.env.EATMODEL_PROCESSED ?? "receipts/processed";
const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

// Formats the parser reads directly, plus HEIC/HEIF which we convert first.
const PARSEABLE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const CONVERTIBLE_EXTS = new Set([".heic", ".heif"]);
const INGEST_EXTS = new Set([...PARSEABLE_EXTS, ...CONVERTIBLE_EXTS]);

function pickParser(): ReceiptParser {
  const choice = process.env.EATMODEL_PARSER ?? (process.env.ANTHROPIC_API_KEY ? "llm" : "mock");
  if (choice === "mock") return new MockReceiptParser();
  return new LLMReceiptParser({ model: process.env.EATMODEL_MODEL });
}

function money(n: number | null, currency: string): string {
  return n == null ? "—" : `${currency} ${n.toFixed(2)}`;
}

function printReceipt(
  file: string,
  parsed: ReceiptParseResult,
  summary: SaveSummary,
  converted: boolean,
): void {
  const where = parsed.store ?? "(unknown store)";
  const when = parsed.purchasedAt ?? "(no date)";
  const note = converted ? "  [converted HEIC→JPEG]" : "";
  console.log(`✓ ${file}${note}  →  ${where} · ${when} · total ${money(parsed.total, parsed.currency)}`);
  for (const line of summary.lines) {
    const tag = line.confidence === "new" ? "＋new" : " alias";
    const price = line.pricedObserved ? `${money(line.unitPrice, parsed.currency)}/${line.unit}` : "no price";
    console.log(`    [${tag}] ${line.description}  ·  ${price}`);
  }
  console.log(
    `    saved receipt #${summary.receiptId}: ${summary.lines.length} line(s), ` +
      `${summary.newIngredients} new ingredient(s), ${summary.priceObservations} price observation(s)\n`,
  );
}

async function main(): Promise<void> {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(PROCESSED, { recursive: true });

  const entries = fs.readdirSync(INBOX);
  const images = entries.filter((f) => INGEST_EXTS.has(path.extname(f).toLowerCase()));

  if (images.length === 0) {
    console.log(`No images in ${INBOX}/ — drop receipt photos there (or point EATMODEL_INBOX at your synced folder) and re-run.`);
    return;
  }

  const parser = pickParser();
  const db = new Db(DB_PATH);
  console.log(`parser: ${parser.name}  ·  db: ${DB_PATH}  ·  ${images.length} image(s)\n`);

  let ok = 0;
  for (const file of images) {
    const full = path.join(INBOX, file);
    let prepared: ReturnType<typeof prepareImage> | undefined;
    try {
      prepared = prepareImage(full); // HEIC→temp JPEG; original is untouched
      const parsed = await parser.parse(prepared.path);
      const summary = db.saveReceipt(parsed, file, parser.name);
      printReceipt(file, parsed, summary, prepared.converted);
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
    `Done. ${ok}/${images.length} processed.  ` +
      `DB now holds ${t.receipts} receipt(s), ${t.ingredients} ingredient(s), ${t.priceObservations} price observation(s).`,
  );
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
