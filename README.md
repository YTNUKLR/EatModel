# EatModel

A household meal-prep operating system: recipes, planning, grocery lists, macros, preservation,
and **receipt-driven grocery price tracking**. Full design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

This repo currently contains the **first discovery slice**: snap a receipt photo → (later) it
syncs to your laptop via a Dropbox/iCloud folder → a CLI turns it into structured line items via
Claude vision → and writes a price history into SQLite. Capture and processing are decoupled; the
folder is the queue.

## Flow

```
phone photo ──▶ synced inbox folder ──▶ process-receipts CLI
                                          ├─ ReceiptParser (Claude vision)  → structured line items
                                          ├─ ingredient matching            → canonical "spine"
                                          └─ SQLite                         → receipts + price history
```

## Setup

Requires Node ≥ 22.

```sh
npm install
cp .env.example .env        # then add your ANTHROPIC_API_KEY for real OCR
```

## Run

**Verify the plumbing with no API key (mock parser, canned data):**

```sh
npm run process:mock
```

**Process real receipt photos:** drop `.jpg`/`.png` images into `receipts/inbox/` (or point
`EATMODEL_INBOX` at your synced Dropbox folder), set `ANTHROPIC_API_KEY`, then:

```sh
npm run process
```

Processed images move to `receipts/processed/`; data lands in `data/eatmodel.db`. Re-run anytime —
the inbox is drained each pass. `npm run db:reset` clears the database.

> iPhone photos are often HEIC, which Claude vision doesn't accept directly. On **macOS** the CLI
> auto-converts HEIC/HEIF to a temporary JPEG (via the built-in `sips`) before parsing, and keeps the
> original file. On other platforms, convert first (or set the iPhone camera to **Settings ▸ Camera ▸
> Formats ▸ "Most Compatible"** to capture JPEG).

## Inspect the data

```sh
sqlite3 data/eatmodel.db "SELECT canonical_name, store, observed_at, unit_price, unit FROM price_observations JOIN ingredients ON ingredients.id = price_observations.ingredient_id ORDER BY observed_at;"
```

## Layout

```
src/
  shared/   types (zod schemas) + unit/name normalization — the shared contract
  parser/   ReceiptParser interface + LLMReceiptParser (Claude vision) + MockReceiptParser
  db/       SQLite repository: the ingredient spine + receipt & price tables
  cli/      process-receipts — drains the inbox, parses, matches, persists
```

These folders mirror the future `packages/*`; see the build note in `docs/ARCHITECTURE.md`.
