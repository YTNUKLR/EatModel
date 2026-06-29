import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Db, type SaveSummary } from "../db/db";
import { selectParser } from "./select-parser";
import { prepareImage } from "./prepare-image";
import { processedName } from "./processed-name";
import type { ReceiptParseResult } from "../shared/types";

// Load .env (Node 22+) so ANTHROPIC_API_KEY etc. are available with no extra
// tooling. Without this, a filled-in .env would be ignored entirely.
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const INBOX = process.env.EATMODEL_INBOX ?? "receipts/inbox";
const PROCESSED = process.env.EATMODEL_PROCESSED ?? "receipts/processed";
const FAILED = process.env.EATMODEL_FAILED ?? "receipts/failed";
const DB_PATH = process.env.EATMODEL_DB ?? "data/eatmodel.db";

// Formats the parser reads directly, plus HEIC/HEIF which we convert first.
const PARSEABLE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const CONVERTIBLE_EXTS = new Set([".heic", ".heif"]);
const INGEST_EXTS = new Set([...PARSEABLE_EXTS, ...CONVERTIBLE_EXTS]);

function money(n: number | null, currency: string): string {
  return n == null ? "—" : `${currency} ${n.toFixed(2)}`;
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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
    const price = line.pricedObserved
      ? `${money(line.unitPrice, parsed.currency)}${line.unit ? `/${line.unit}` : ""}`
      : "no price";
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

  const images = fs
    .readdirSync(INBOX)
    .filter((f) => INGEST_EXTS.has(path.extname(f).toLowerCase()));

  if (images.length === 0) {
    console.log(`No images in ${INBOX}/ — drop receipt photos there (or point EATMODEL_INBOX at your synced folder) and re-run.`);
    return;
  }

  const parser = selectParser(process.env); // throws (fail loud) if llm is chosen with no key
  const db = new Db(DB_PATH);
  console.log(`parser: ${parser.name}  ·  db: ${DB_PATH}  ·  ${images.length} image(s)\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of images) {
    const full = path.join(INBOX, file);
    let prepared: ReturnType<typeof prepareImage> | undefined;
    try {
      // Content-hash dedup: skip (and don't re-call the API) if already ingested.
      const hash = sha256(full);
      const dest = processedName(hash, file); // hash-prefixed so same-named images don't clobber
      if (db.hasReceipt(hash)) {
        console.log(`↷ ${file}: already ingested — skipping\n`);
        fs.renameSync(full, path.join(PROCESSED, dest));
        skipped++;
        continue;
      }

      prepared = prepareImage(full); // HEIC→temp JPEG; original is untouched
      const parsed = await parser.parse(prepared.path);

      // No line items found → quarantine, don't save. Saving an empty receipt
      // would dedup the image as "done" so it could never be re-extracted.
      if (parsed.lines.length === 0) {
        fs.mkdirSync(FAILED, { recursive: true });
        fs.renameSync(full, path.join(FAILED, dest));
        console.warn(`⚠ ${file}: no line items found — moved to ${FAILED}/ for review (not saved)\n`);
        failed++;
        continue;
      }

      const summary = db.saveReceipt(parsed, file, parser.name, hash);
      printReceipt(file, parsed, summary, prepared.converted);
      fs.renameSync(full, path.join(PROCESSED, dest)); // drain the inbox; keep the original
      ok++;
    } catch (err) {
      console.error(`✗ ${file}: ${(err as Error).message}\n`);
    } finally {
      prepared?.cleanup();
    }
  }

  const t = db.totals();
  const extra = [
    skipped ? `${skipped} skipped (duplicate)` : "",
    failed ? `${failed} quarantined (no line items)` : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `Done. ${ok} processed${extra ? `, ${extra}` : ""}.  ` +
      `DB now holds ${t.receipts} receipt(s), ${t.ingredients} ingredient(s), ${t.priceObservations} price observation(s).`,
  );
  db.close();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
