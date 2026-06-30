# EatModel

A household meal-prep operating system: recipes, planning, grocery lists, macros, preservation,
and **receipt-driven grocery price tracking**. Full design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Useful docs:

- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — how to operate the current CLI app.
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) — SQLite schema, relationships, and invariants.
- [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) — engineering conventions for this repo.

This repo currently contains the first **discovery slices** — two symmetric capture pipelines that
both feed one canonical "ingredient spine":

1. **Receipts** → structured line items → SQLite price history.
2. **Recipes** → structured ingredient list → SQLite recipe collection.

In both: snap a photo → (later) it syncs to your laptop via a Dropbox/iCloud folder → a CLI turns it
into structured data via Claude vision → and writes to SQLite. Capture and processing are decoupled;
the folder is the queue.

## Flow

```
phone photo ──▶ synced inbox folder ──▶ process-receipts CLI
                                          ├─ ReceiptParser (Claude vision)  → structured line items
                                          ├─ ingredient matching            → canonical "spine" ◀──┐
                                          └─ SQLite                         → receipts + price history │
                                                                                                      │ shared
phone photo ──▶ synced inbox folder ──▶ process-recipes CLI                                           │ spine
                                          ├─ RecipeParser (Claude vision)   → structured ingredients  │
                                          ├─ ingredient matching            → canonical "spine" ◀─────┘
                                          └─ SQLite                         → recipes + ingredients
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

**Recipes** work the same way — photograph a recipe (e.g. a cookbook page) into `recipes/inbox/`
(or `EATMODEL_RECIPE_INBOX`), then:

```sh
npm run recipes        # real OCR (needs ANTHROPIC_API_KEY)
npm run recipes:mock   # canned recipe, no key/cost — verify the plumbing
```

v1 captures the **ingredient list** (title, source, servings, ingredients), not the step-by-step
instructions — the original image is kept so steps can be re-parsed later. A single photo can hold
**multiple recipes** (e.g. a cookbook spread); each is saved separately under one image "ingest".
Recipe ingredients resolve to the *same* canonical ingredients as receipts.

Processed images move to the matching `processed/` folder; data lands in `data/eatmodel.db`. Re-run
anytime — each inbox is drained per pass, and re-ingesting the same photo is a no-op (content-hash
dedup). `npm run db:reset` clears the database.

## Review what was ingested

New ingredients land as **unconfirmed**, and any untrustworthy line (empty name, negative price) or a
receipt whose items don't reconcile against its total is **flagged** rather than silently trusted
(see `docs/ARCHITECTURE.md` §5.5). Inspect and resolve:

```sh
npm run review                       # list unconfirmed ingredients, flagged lines, unreconciled receipts
npm run review -- confirm <id>       # mark an ingredient trusted
npm run review -- merge <from> <into>  # fold a duplicate/abbreviation into its real ingredient
npm run review -- resolve-line <receipt|recipe> <line-id>
npm run review -- resolve-receipt <id>
```

`merge` is how you de-fragment the spine by hand (e.g. fold `CHKN THGH` into `chicken thighs`) until
automatic fuzzy matching arrives.

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
  shared/   types (zod schemas) + unit/name normalization — the shared contracts
  parser/   ReceiptParser + RecipeParser interfaces, each with an LLM (Claude vision) + Mock impl
  db/       SQLite repository: the shared ingredient spine + receipt/price and recipe tables
  cli/      process-receipts / process-recipes — drain an inbox, parse, match, persist
```

These folders mirror the future `packages/*`; see the build note in `docs/ARCHITECTURE.md`.
