# EatModel Data Model

Current SQLite schema for the discovery app. The authoritative DDL lives in `src/db/db.ts`; this document explains the intent and invariants.

## Shape

```
schema_migrations

ingredients
  -> ingredient_aliases
  -> receipt_line_items
  -> recipe_ingredients
  -> price_observations

receipts
  -> receipt_line_items
      -> price_observations

recipe_ingests
  -> recipes
      -> recipe_ingredients
```

The central concept is the ingredient spine: receipts and recipes both resolve their text lines to the same `ingredients` table.

## Tables

### `schema_migrations`

Records lightweight discovery-phase migrations that have been applied.

- `name` is the migration identifier.
- `applied_at` records when it was applied.

This is intentionally small. Full migration tooling is deferred until the server/app shape settles.

### `ingredients`

Canonical ingredient identities.

Important columns:

- `canonical_name`: human-readable ingredient name.
- `status`: `unconfirmed` or `confirmed`.

New ingredients start as `unconfirmed`. Human review promotes them with `npm run review -- confirm <id>`, or merges fragments with `npm run review -- merge <from> <into>`.

### `ingredient_aliases`

Many raw or cleaned names can point to one ingredient.

Important columns:

- `ingredient_id`: target canonical ingredient.
- `alias_text`: observed text.
- `normalized`: normalized lookup key, unique.
- `source`: `receipt`, `recipe`, or `manual`.

Exact normalized alias match is the current matcher. Fuzzy/embedding matching is intentionally deferred.

### `receipts`

One parsed receipt image.

Important columns:

- `store`: free text from the parser. Store identity is not canonicalized yet.
- `purchased_at`: parsed purchase date, or `null` if unknown.
- `total`: printed receipt total, or `null` if unknown.
- `image_filename`: original filename at ingestion time.
- `image_sha256`: content hash used for idempotency.
- `raw_json`: parser output as stored JSON.
- `needs_review` / `review_reason`: receipt-level reconciliation warning.

Receipt totals are advisory checks. Discounts, coupons, and parser gaps can create false positives, so warnings are reviewed rather than rejected.

### `receipt_line_items`

Line items extracted from receipts.

Important columns:

- `receipt_id`: parent receipt.
- `raw_text`: text as printed.
- `description`: cleaned product name from the parser.
- `quantity`, `unit`, `unit_price`, `line_total`: parsed numeric details, nullable when unknown.
- `ingredient_id`: canonical ingredient, nullable if identity is not safe to match.
- `match_confidence`: `alias`, `new`, or `unmatched`.
- `needs_review` / `review_reason`: line-level data quality flag.

Bad parser output is stored, not dropped. Invalid identities stay unlinked instead of creating garbage ingredients.

### `price_observations`

Append-only price facts derived from trusted receipt lines.

Important columns:

- `ingredient_id`: required canonical ingredient.
- `store`: copied from receipt free text.
- `observed_at`: receipt purchase date, or `null`.
- `unit`, `unit_price`, `currency`: observed price details.
- `source_line_id`: receipt line that produced the fact.

A price observation is created only when the line has a matched ingredient, a sane nonnegative derived price, and no review reason. Flagged prices never become facts.

### `recipe_ingests`

One photographed recipe page/card/spread.

Important columns:

- `image_filename`: original filename at ingestion time.
- `image_sha256`: content hash used for idempotency.
- `recipe_count`: number of recipes found on the image.
- `raw_json`: parser output as stored JSON.

One image may produce many recipes. The image is the dedup unit.

### `recipes`

One recipe found on a recipe ingest.

Important columns:

- `ingest_id`: parent image ingest.
- `title`: parsed title, nullable.
- `source_note`: book/page/site note, nullable.
- `servings`: parsed serving count, nullable.

Current scope excludes instructions/steps. Original images and raw JSON are retained so this can be reparsed later.

### `recipe_ingredients`

Ingredient lines extracted from recipes.

Important columns:

- `recipe_id`: parent recipe.
- `raw_text`: text as printed.
- `ingredient_text`: cleaned ingredient name from the parser.
- `quantity`, `unit`, `prep_note`, `optional`: parsed recipe-line details.
- `ingredient_id`: canonical ingredient, nullable if identity is not safe to match.
- `match_confidence`: `alias`, `new`, or `unmatched`.
- `needs_review` / `review_reason`: line-level data quality flag.

Recipe lines never create price observations.

## Invariants

Fresh databases enforce lightweight `CHECK` constraints for invariants that should never be false:

- Ingredient status is `unconfirmed` or `confirmed`.
- Review flags are booleans: `0` or `1`.
- Match confidence is `alias`, `new`, or `unmatched`.
- Recipe ingest count is positive.
- Recipe ingredient `optional` is boolean.
- Persisted price observations have nonnegative unit prices.

Existing databases opened through additive migrations are not rebuilt just to retrofit constraints. SQLite cannot add `CHECK` constraints to existing tables without table rebuilds, so constraints are strongest on fresh databases.

## Null Semantics

`null` means unknown or not parsed, not a guessed default.

Examples:

- Unknown purchase date: `receipts.purchased_at = null`.
- Unknown unit: `receipt_line_items.unit = null`.
- Unknown recipe servings: `recipes.servings = null`.
- Invalid identity: line row is stored with `ingredient_id = null` and `match_confidence = 'unmatched'`.

The app should prefer `null` plus review flags over fabricated values.

## Review Semantics

There are three kinds of review state:

- Ingredient identity: `ingredients.status = 'unconfirmed'`.
- Line quality: `receipt_line_items.needs_review` / `recipe_ingredients.needs_review`.
- Receipt reconciliation: `receipts.needs_review`.

Review commands:

```sh
npm run review
npm run review -- confirm <ingredient-id>
npm run review -- merge <from-id> <into-id>
npm run review -- resolve-line <receipt|recipe> <line-id>
npm run review -- resolve-receipt <receipt-id>
```

Resolving a review flag clears the active queue flag. It does not delete the row or the original raw JSON.

## Migration Policy

During discovery:

- Additive schema changes are handled by the repository's lightweight migration runner.
- Migrations are recorded in `schema_migrations`.
- Structurally incompatible old schemas fail loud and ask for `npm run db:reset`.
- Full migration tooling is deferred until the app/server boundary is clearer.

This policy is acceptable while local data is disposable. Once real data matters, schema migrations should become first-class and reversible/tested against representative fixtures.

## Known Gaps

- Store identity is free text and will fragment cross-store comparisons.
- Ingredient matching is exact alias matching only.
- Unit conversion is not modeled yet.
- Recipe instructions are not captured.
- Content-hash dedup cannot catch re-shot duplicate receipts/recipes.
