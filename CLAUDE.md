# CLAUDE.md — agent orientation for EatModel

Fast orientation for an AI agent working in this repo. Authoritative detail lives in:
**`docs/ARCHITECTURE.md`** (design + decision log — source of truth) · **`docs/CONVENTIONS.md`**
(how we work) · **`README.md`** (how to run).

## What this is

A household-scale meal-prep operating system built around one **canonical ingredient spine** shared by
recipes, grocery, pantry, and receipts. All-TypeScript, greenfield, in the **discovery phase**: a single
package whose folders (`shared/ parser/ db/ cli/`) mirror future `packages/*`. SQLite behind a repository
layer (Postgres/Drizzle deferred). Python deferred behind interfaces.

## Current state (as of 2026-06-29)

Two photo-ingest slices are live, both feeding the same SQLite spine via the `db/` repository:

- **Receipts** — photo → Claude vision (`ReceiptParser`) → line items + append-only `price_observations`.
- **Recipes** — photo → Claude vision (`RecipeParser`) → ingredient lists. **Ingredients-list-first**
  (no instructions captured yet). **One image can hold many recipes** → a `recipe_ingests` row (the image)
  → many `recipes`.
- **Review / confidence gate (§5.5)** — new ingredients persist as `status='unconfirmed'`; untrustworthy
  lines are **flagged, not dropped** (and never become price facts); receipt totals are reconciled.
  Resolve via `npm run review` (`list` / `confirm` / `merge` / `delete-recipe` / `set-source` /
  `resolve-line` / `resolve-receipt`; food links: `foods` / `link-food` / `confirm-food` /
  `link-suggest` / `set-density` / `set-each-grams`; stores: `confirm-store` / `merge-store`).
- **Nutrition spine (§6)** — gated `ingredient.food_id` link to a `foods` catalog; pure `shared/nutrition.ts`
  rollup (`null`-honest, `⚠ partial`). Catalog seeded, then grown via **USDA FDC import**
  (`npm run import-foods -- <unzipped-bundle-dir>`). **Assisted linking**: `review -- link-suggest` (lexical
  shortlist → LLM picks or abstains → gated proposal). Coverage: `npm run report -- coverage`.
- **Store-identity spine (§14)** — `stores`/`store_aliases`, `receipts.store_id`; `confirm-store`/`merge-store`.

**Next up:** the systematic-nutrition-coverage three-lever plan (ARCHITECTURE §11 2026-07-01) is **built**
(coverage dashboard + assisted linker + portion backfill); remaining polish = a FoodLinker eval harness and
a `not-nutrition-relevant` per-line resolution. Then **apply it all to the real db** (still 9 seeds / 0 links —
every demo ran on a scratch copy) and **ingest a real receipt** (db is recipe-only, so the price/cost half is dark).

## Run

| Command | What it does |
|---|---|
| `npm run process` / `process:mock` | Ingest receipt photos from `receipts/inbox/` (real OCR / canned mock) |
| `npm run recipes` / `recipes:mock` | Ingest recipe photos from `recipes/inbox/` |
| `npm run review [-- <cmd>]` | Inspect/resolve flagged data + manage food/store links (see current-state above; `link-suggest` needs a key, or `EATMODEL_FOOD_LINKER=mock`) |
| `npm run import-foods -- <dir>` | Load a USDA FDC bulk CSV bundle (unzipped) into the `foods` catalog |
| `npm run backfill-conversions -- <dir>` | Derive density / grams-per-each on confirmed links from FDC portion data |
| `npm run report [-- coverage \| macros \| price \| cheapest \| stores \| protein-per-dollar]` | Read-only reports over the spine |
| `npm run check` | **Typecheck + tests — must be green before merging to `main`** |
| `npm run db:reset` | Drop `data/eatmodel.db` (use if a db predates a schema change) |

## Must-know conventions (full list: `docs/CONVENTIONS.md`)

- **`main` is always green. Branch per change** (`feat/ fix/ docs/ chore/ refactor/`); never commit to
  `main` directly; **merge only when `npm run check` passes**. End commits with the `Co-Authored-By` trailer.
- **TDD the pure core** (`shared/`) test-first with `node:test`. **LLM parsers are evals, not unit tests**
  (their output is non-deterministic) — assert their plumbing, eval their accuracy on real fixtures.
- **Dependencies point inward**: `shared/` imports no I/O; `parser/ db/ cli/` depend on it. Interface +
  `Mock…` at every swap point (`ReceiptParser`, `RecipeParser`, the repository).
- **Validate at boundaries, no silent guessing** — record gaps (`null`, `needs_review`), don't fabricate.
- **Record non-obvious decisions in `ARCHITECTURE.md` §11**, in the same branch that makes them.
- **Triage rule for "now vs later":** every ingest retains the **original image + `raw_json`**, so any
  *extraction* gap (units, steps, discounts, sub-sections) is re-derivable by re-parsing — defer those.
  What's *not* cheaply reversible is **identity + accumulated judgment** (how lines resolve to the spine,
  human confirmations) — handle that now. (`ARCHITECTURE.md` §14)

## Gotchas

- **Real OCR needs `ANTHROPIC_API_KEY` in `.env`** (model `claude-opus-4-8`). The CLIs **fail loud** without
  it — the mock is reachable *only* via the `:mock` scripts, never as a silent fallback. `.env` is gitignored.
- **HEIC/HEIF auto-convert is macOS-only** (via `sips`); other platforms must supply JPEG/PNG.
- **Old-schema dbs:** `Db` runs a tiny additive migration runner on open; if it can't reconcile it throws
  and tells you to `npm run db:reset` (full migration tooling is deferred).
- **Privacy:** `data/` and all inbox/processed/failed images are private and **gitignored** — never commit
  or sync them.
- **Don't mutate the user's real `data/eatmodel.db` for demos** (e.g. `review -- confirm/merge`) — use a
  scratch db via `EATMODEL_DB=...`.
