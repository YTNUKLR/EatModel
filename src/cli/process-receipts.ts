import fs from "node:fs";
import path from "node:path";
import { Db, type SaveSummary } from "../db/db";
import { LLMReceiptParser } from "../parser/llm";
import { MockReceiptParser } from "../parser/mock";
import type { ReceiptParser } from "../parser/types";
import type { ReceiptParseResult } from "../shared/types";

const INBOX = process.env.EATMODEL_INBOX ?? "receipts/inbox";
const PROCESSED = process.env.EATMODEL_PROCESSED ?? "receipts/processed";
const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function pickParser(): ReceiptParser {
  const choice = process.env.EATMODEL_PARSER ?? (process.env.ANTHROPIC_API_KEY ? "llm" : "mock");
  if (choice === "mock") return new MockReceiptParser();
  return new LLMReceiptParser({ model: process.env.EATMODEL_MODEL });
}

function money(n: number | null, currency: string): string {
  return n == null ? "—" : `${currency} ${n.toFixed(2)}`;
}

function printReceipt(file: string, parsed: ReceiptParseResult, summary: SaveSummary): void {
  const where = parsed.store ?? "(unknown store)";
  const when = parsed.purchasedAt ?? "(no date)";
  console.log(`✓ ${file}  →  ${where} · ${when} · total ${money(parsed.total, parsed.currency)}`);
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
  const images = entries.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  const heic = entries.filter((f) => /\.(heic|heif)$/i.test(f));

  if (heic.length) {
    console.warn(
      `⚠ Skipping ${heic.length} HEIC/HEIF file(s) — Claude vision needs JPEG/PNG.\n` +
        `  Fix on iPhone: Settings ▸ Camera ▸ Formats ▸ "Most Compatible".\n` +
        `  Files: ${heic.join(", ")}\n`,
    );
  }

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
    try {
      const parsed = await parser.parse(full);
      const summary = db.saveReceipt(parsed, file, parser.name);
      printReceipt(file, parsed, summary);
      fs.renameSync(full, path.join(PROCESSED, file)); // drain the inbox
      ok++;
    } catch (err) {
      console.error(`✗ ${file}: ${(err as Error).message}\n`);
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
