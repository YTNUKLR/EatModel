import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { Db, type SaveSummary } from "../db/db";
import { selectParser } from "./select-parser";
import { prepareImage } from "./prepare-image";
import { processedName } from "./processed-name";
import type { ReceiptParseResult } from "../shared/types";

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
    const tag =
      line.confidence === "new" ? "＋new" : line.confidence === "alias" ? " alias" : " no match";
    const price = line.pricedObserved
      ? `${money(line.unitPrice, parsed.currency)}${line.unit ? `/${line.unit}` : ""}`
      : "no price";
    const flag = line.needsReview ? "  ⚠ review" : "";
    console.log(`    [${tag}] ${line.description}  ·  ${price}${flag}`);
  }
  const reviewNote = summary.needsReview ? `  ⚠ needs review: ${summary.reviewReason}` : "";
  console.log(
    `    saved receipt #${summary.receiptId}: ${summary.lines.length} line(s), ` +
      `${summary.newIngredients} new ingredient(s), ${summary.priceObservations} price observation(s)${reviewNote}\n`,
  );
}

export async function processReceipts(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const inbox = env.EATMODEL_INBOX ?? "receipts/inbox";
  const processed = env.EATMODEL_PROCESSED ?? "receipts/processed";
  const failedDir = env.EATMODEL_FAILED ?? "receipts/failed";
  const dbPath = env.EATMODEL_DB ?? "data/eatmodel.db";

  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(processed, { recursive: true });

  const images = fs
    .readdirSync(inbox)
    .filter((f) => INGEST_EXTS.has(path.extname(f).toLowerCase()));

  if (images.length === 0) {
    console.log(`No images in ${inbox}/ — drop receipt photos there (or point EATMODEL_INBOX at your synced folder) and re-run.`);
    return;
  }

  const parser = selectParser(env); // throws (fail loud) if llm is chosen with no key
  const db = new Db(dbPath);
  console.log(`parser: ${parser.name}  ·  db: ${dbPath}  ·  ${images.length} image(s)\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of images) {
    const full = path.join(inbox, file);
    let prepared: ReturnType<typeof prepareImage> | undefined;
    try {
      // Content-hash dedup: skip (and don't re-call the API) if already ingested.
      const hash = sha256(full);
      const dest = processedName(hash, file); // hash-prefixed so same-named images don't clobber
      if (db.hasReceipt(hash)) {
        console.log(`↷ ${file}: already ingested — skipping\n`);
        fs.renameSync(full, path.join(processed, dest));
        skipped++;
        continue;
      }

      prepared = prepareImage(full); // HEIC→temp JPEG; original is untouched
      const parsed = await parser.parse(prepared.path);

      // No line items found → quarantine, don't save. Saving an empty receipt
      // would dedup the image as "done" so it could never be re-extracted.
      if (parsed.lines.length === 0) {
        fs.mkdirSync(failedDir, { recursive: true });
        fs.renameSync(full, path.join(failedDir, dest));
        console.warn(`⚠ ${file}: no line items found — moved to ${failedDir}/ for review (not saved)\n`);
        failed++;
        continue;
      }

      const summary = db.saveReceipt(parsed, file, parser.name, hash);
      printReceipt(file, parsed, summary, prepared.converted);
      fs.renameSync(full, path.join(processed, dest)); // drain the inbox; keep the original
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

function isMain(): boolean {
  return process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
  // Load .env (Node 22+) so ANTHROPIC_API_KEY etc. are available with no extra
  // tooling. Without this, a filled-in .env would be ignored entirely.
  if (fs.existsSync(".env")) process.loadEnvFile(".env");

  processReceipts().catch((err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
