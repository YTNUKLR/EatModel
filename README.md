# EatModel

EatModel is a household meal-prep operating system in its discovery phase. The long-term goal is to connect recipes, meal planning, grocery lists, pantry/freezer inventory, nutrition, and grocery price history through one shared ingredient model.

Today this repo is a local TypeScript CLI app for proving the hardest data flows:

- Receipt photos -> structured line items -> SQLite price history.
- Recipe photos -> structured ingredient lists -> SQLite recipe collection.
- Both flows resolve to one canonical ingredient spine.
- Receipt stores resolve to a canonical store spine for later cross-store price comparisons.
- Human review keeps questionable data provisional instead of silently trusting it.

There is no mobile app, server, auth, grocery-list UI, meal-plan UI, or pantry model yet. Nutrition exists as a local CLI/discovery slice: seeded reference foods, gated ingredient→food links, and partial-honest recipe macro rollups.

## Current Slice

```
phone photo -> synced inbox folder -> CLI parser -> SQLite

receipts/inbox/  -> process-receipts -> receipts + receipt_line_items + price_observations
recipes/inbox/   -> process-recipes  -> recipe_ingests + recipes + recipe_ingredients

both pipelines -> ingredients + ingredient_aliases
receipt stores -> stores + store_aliases
```

Capture is intentionally dumb: take photos on the phone and let Dropbox/iCloud/Drive sync them to an inbox folder. Processing happens later from the laptop. The synced folder is the queue.

## Docs

- [docs/RUNBOOK.md](docs/RUNBOOK.md): operate the current CLI app.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md): SQLite schema, relationships, invariants, null semantics.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): product/architecture rationale and decision log.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md): engineering conventions.
- [CLAUDE.md](CLAUDE.md): short orientation for AI agents working in this repo.

## Setup

Requires Node 22 or newer.

```sh
npm install
cp .env.example .env
npm run check
```

For real OCR, add `ANTHROPIC_API_KEY` to `.env`. Mock commands do not need a key.

## Commands

| Command | Purpose |
|---|---|
| `npm run process` | Process real receipt photos from `receipts/inbox/`. |
| `npm run process:mock` | Run receipt ingestion with canned parser output. |
| `npm run recipes` | Process real recipe photos from `recipes/inbox/`. |
| `npm run recipes:mock` | Run recipe ingestion with canned parser output. |
| `npm run review` | List unconfirmed ingredients, flagged lines, and unreconciled receipts. |
| `npm run review -- confirm <id>` | Mark an ingredient as trusted. |
| `npm run review -- merge <from> <into>` | Fold a duplicate/fragment ingredient into another. |
| `npm run review -- confirm-store <id>` | Mark a canonical store as trusted. |
| `npm run review -- merge-store <from> <into>` | Fold a duplicate/fragment store into another. |
| `npm run review -- resolve-line <receipt\|recipe> <line-id>` | Clear a reviewed line flag. |
| `npm run review -- resolve-receipt <id>` | Clear a reviewed receipt total warning. |
| `npm run review -- foods [query]` | Search seeded reference foods for nutrition linking. |
| `npm run review -- link-food <ingredient-id> <food-id>` | Propose an ingredient→food nutrition link. |
| `npm run review -- confirm-food <ingredient-id>` | Confirm a proposed nutrition link so rollups can use it. |
| `npm run review -- set-density <ingredient-id> <g-per-ml>` | Add a density hint for volume-to-grams conversion. |
| `npm run review -- set-each-grams <ingredient-id> <grams>` | Add an each-weight hint for clove/each conversion. |
| `npm run review -- nutrition [recipe-id]` | Show recipe macro rollups and partial reasons. |
| `npm run eval` | Score the receipt parser against `fixtures/receipts/` (recall/precision/field accuracy). |
| `npm run eval:mock` | Run the eval harness with the canned parser (no API key). |
| `npm run db:reset` | Remove the default local SQLite database and sidecars. |
| `npm run check` | Typecheck and run tests. |

## Quick Start

Verify the receipt pipeline without an API key:

```sh
npm run process:mock
npm run review
```

Verify the recipe pipeline without an API key:

```sh
npm run recipes:mock
npm run review
```

For real photos:

1. Put receipt images in `receipts/inbox/` or set `EATMODEL_INBOX`.
2. Put recipe images in `recipes/inbox/` or set `EATMODEL_RECIPE_INBOX`.
3. Set `ANTHROPIC_API_KEY` in `.env`.
4. Run `npm run process` or `npm run recipes`.
5. Run `npm run review` and confirm/merge/resolve what was flagged.

Processed originals move to the matching `processed/` folder as `<sha12>-<original-name>`. Failed parses move to the matching `failed/` folder and are not saved to the database.

## Data Safety

The current design is deliberately conservative:

- Re-ingesting the same exact image is idempotent via content hash.
- Original images are retained for future reparsing.
- Parser output is stored as `raw_json`.
- Missing facts are stored as `null`, not guessed.
- Bad line values are flagged, not dropped.
- Invalid ingredient identities stay unlinked instead of minting garbage canonical ingredients.
- Flagged prices never become `price_observations`.
- Raw receipt store text is retained even when a canonical store link is merged.
- Proposed nutrition links do not feed recipe macros until confirmed.
- Unconvertible recipe units produce partial nutrition, not fabricated grams.

SQLite data lands in `data/eatmodel.db`. Local data and image queues are gitignored.

## HEIC Notes

iPhone photos are often HEIC/HEIF, which Claude vision does not accept directly. On macOS, the CLI converts HEIC/HEIF to a temporary JPEG with `sips` and keeps the original. On other platforms, convert images first or configure the phone camera for JPEG capture.

## Inspect Data

Example price-history query:

```sh
sqlite3 data/eatmodel.db "SELECT ingredients.canonical_name, stores.canonical_name AS canonical_store, price_observations.store AS raw_store, observed_at, unit_price, unit FROM price_observations JOIN ingredients ON ingredients.id = price_observations.ingredient_id LEFT JOIN stores ON stores.id = price_observations.store_id ORDER BY observed_at;"
```

More inspection commands are in [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Layout

```
src/
  shared/   zod schemas, pricing, review checks, normalization, units, nutrition
  parser/   receipt/recipe parser interfaces plus LLM and mock implementations
  db/       SQLite repository and migration/constraint tests
  cli/      receipt/recipe processing, review commands, CLI integration tests
docs/
  ARCHITECTURE.md
  CONVENTIONS.md
  DATA_MODEL.md
  RUNBOOK.md
```

The folders mirror the likely future `packages/*` split. Keeping it as one TypeScript package avoids monorepo tooling during discovery.

## Known Gaps

- Store identity is exact-alias-or-create only; `Walmart`, `WAL-MART #1234`, and `WM SUPERCENTER` still need manual `merge-store` until fuzzy matching exists.
- Ingredient matching is exact normalized alias matching only.
- Unit conversion is intentionally narrow: mass units work; volume/each need density or grams-per-each hints.
- Recipe instructions are not captured yet.
- Content-hash dedup cannot catch re-shot duplicate receipts or recipes.
- Fresh databases have `CHECK` constraints, but existing SQLite tables are not rebuilt just to retrofit constraints.

The next useful slice is a small reporting/query layer over confirmed ingredients, stores, food links, and prices.
