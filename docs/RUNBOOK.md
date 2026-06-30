# EatModel Runbook

Operational notes for the current discovery app: local CLI ingestion, SQLite, and human review.

## Prerequisites

- Node 22 or newer.
- Project dependencies installed with `npm install`.
- For real OCR, `.env` must contain `ANTHROPIC_API_KEY`.
- For mock/canned runs, no API key is needed.

```sh
cp .env.example .env
npm install
npm run check
```

## Important Paths

Defaults, unless overridden in `.env`:

| Purpose | Default |
|---|---|
| Receipt inbox | `receipts/inbox/` |
| Receipt processed originals | `receipts/processed/` |
| Receipt failed/quarantine | `receipts/failed/` |
| Recipe inbox | `recipes/inbox/` |
| Recipe processed originals | `recipes/processed/` |
| Recipe failed/quarantine | `recipes/failed/` |
| SQLite database | `data/eatmodel.db` |

The data directory and image queues are private local data and should not be committed.

## Receipt Ingestion

Verify plumbing with canned data:

```sh
npm run process:mock
```

Process real receipt photos:

```sh
npm run process
```

Behavior:

- The CLI creates the inbox/processed folders if missing.
- It reads supported images from the inbox.
- It content-hashes the original file before parsing.
- Already-seen image hashes are skipped without another model call.
- Successfully processed originals move to `processed/` as `<sha12>-<original-name>`.
- Images that parse to zero line items move to `failed/` and are not saved.

Supported direct formats are `.jpg`, `.jpeg`, `.png`, `.gif`, and `.webp`. HEIC/HEIF is converted to a temporary JPEG on macOS using `sips`; the original file remains the source of truth.

## Recipe Ingestion

Verify plumbing with canned data:

```sh
npm run recipes:mock
```

Process real recipe photos:

```sh
npm run recipes
```

Behavior mirrors receipts:

- One image may produce multiple recipes.
- The image hash deduplicates at the page/ingest level, not per recipe.
- Successfully processed originals move to `recipes/processed/`.
- Images with zero recipes, or any recipe with zero ingredient lines, move to `recipes/failed/` and are not saved.

Current recipe scope is ingredients-list-first: title/source/servings/ingredients are captured, but instructions are not.

## Review Workflow

After ingestion, run:

```sh
npm run review
```

This lists:

- Unconfirmed ingredients.
- Receipt/recipe lines flagged for review.
- Receipts whose line totals do not reconcile against the printed total.

Resolve ingredient identity:

```sh
npm run review -- confirm <ingredient-id>
npm run review -- merge <from-id> <into-id>
```

Use `confirm` when a new ingredient is a real canonical ingredient. Use `merge` when a fragment, abbreviation, or duplicate should be folded into another ingredient.

Resolve review flags after inspection:

```sh
npm run review -- resolve-line <receipt|recipe> <line-id>
npm run review -- resolve-receipt <receipt-id>
```

Resolving a flag removes it from the active review queue. The stored row and original parse JSON remain available for later audit or reparsing.

## Inspecting Data

Quick price-history query:

```sh
sqlite3 data/eatmodel.db "SELECT canonical_name, store, observed_at, unit_price, unit FROM price_observations JOIN ingredients ON ingredients.id = price_observations.ingredient_id ORDER BY observed_at;"
```

Quick pending-review counts:

```sh
sqlite3 data/eatmodel.db "SELECT COUNT(*) FROM ingredients WHERE status = 'unconfirmed';"
sqlite3 data/eatmodel.db "SELECT COUNT(*) FROM receipt_line_items WHERE needs_review = 1;"
sqlite3 data/eatmodel.db "SELECT COUNT(*) FROM recipe_ingredients WHERE needs_review = 1;"
sqlite3 data/eatmodel.db "SELECT COUNT(*) FROM receipts WHERE needs_review = 1;"
```

## Resetting Local Data

For discovery-phase throwaway data:

```sh
npm run db:reset
```

This removes the default SQLite database and WAL/shm sidecars. It does not remove inbox, processed, or failed images.

Use reset when:

- You intentionally want a clean local dataset.
- The app says an old schema cannot be auto-migrated.
- You used mock data and want to remove it before processing real receipts.

## Troubleshooting

**Real OCR fails immediately with missing key**

The real parsers are the default and fail loud without `ANTHROPIC_API_KEY`. Use `npm run process:mock` / `npm run recipes:mock` for no-key plumbing checks.

**No images are processed**

Check the configured inbox path, file extension, and whether the synced folder has finished downloading files locally.

**HEIC/HEIF fails**

Automatic conversion uses macOS `sips`. On non-macOS platforms, convert images to JPEG/PNG first or configure the phone camera for JPEG capture.

**An image was quarantined**

Look in the matching `failed/` folder. The image was not saved to the database, so it can be moved back to the inbox after the parser/prompt improves.

**The same-looking receipt was ingested twice**

Dedup is content-hash based. A re-shot image has different bytes and will not be considered the same receipt yet.

**The same store appears under many names**

Store identity is still free text. A store spine is the next identity decision before serious cross-store comparisons.
