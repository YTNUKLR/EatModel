# EatModel — Architecture

> Status: Draft v1 · Date: 2026-06-29 · Owner: Scott
> Scope: personal + household use (a handful of trusted users sharing one plan/pantry)

---

## 0. Context & intent (the "why")

The human layer behind the architecture — captured so the *reasons* survive, not just the decisions.

**Who's building it:** Scott — comfortable coding; prefers to see the architecture and the
tradeoff reasoning written down *before* committing to a stack or writing code. So: decisions get
recorded with rationale (this doc + the decision log), and big forks stay explicitly open until
there's a reason to close them.

**The underlying goals, in the builder's own framing:**
- Cook *fewer times per week* — batch-cook, then preserve (freeze in bulk, vacuum seal).
- Plan grocery buying deliberately.
- Eat **interesting and delicious** food — not merely efficient/optimized food.
- Track grocery prices over time by photographing receipts.
- Optimize macros / nutrition **for cost**.
- Later, with outside data: choose **who to support** (good companies) and **what to avoid**
  (harmful chemicals / questionable practices).

**A core tension to design around:** "optimize macros for cost" pulls toward cheap, repetitive,
efficient eating; "interesting and delicious" pulls the opposite way. EatModel should **surface**
cost/nutrition tradeoffs to *inform* choices — not silently optimize meals down to the cheapest
gruel that hits a protein target. Enjoyment is a first-class goal, not a leftover. This is why the
roadmap puts recipes/variety first and treats optimization as a late, advisory layer.

**What I do *not* yet know** (genuine unknowns — see also §10):
- The priority *ranking* among cost / health / time-savings / enjoyment. I've assumed roughly
  co-equal; that assumption is unverified.
- Budget and the time available to build this.
- Household size and who else actually uses it.
- Dietary restrictions / preferences / cuisines you gravitate to.
- What you use today (paper, notes app, spreadsheets, another app) that this replaces.
- Which stores you shop, and whether comparing *across* stores matters early.

These gaps don't block Phase 0, but several of them shape priorities — worth filling before Phase 3+.

---

## 1. Vision

EatModel is a meal-prep operating system for a household. It connects six things that
are usually separate apps into one shared data core:

1. **Recipes** — a personal, growing collection
2. **Meal planning** — assign recipes to a week, scaled for *batch cooking* (cook 2×, eat 6×)
3. **Grocery list** — auto-generated from the plan, aggregated and de-duplicated
4. **Macros / nutrition** — per-recipe, per-meal, and per-day rollups
5. **Preservation / pantry** — what's batch-cooked, frozen, or vacuum-sealed, with "use by" dates
6. **Receipts & price history** — snap a photo in the store → structured line items → price-per-ingredient over time

The long-term payoff is the **cost + nutrition + sourcing** layer: "what gives me the most
protein per dollar," "where is the cheapest reliable source for X," and (later, with outside
data) "which companies are worth supporting / avoid certain chemicals."

### Why this is more than 6 small apps

The thing that makes EatModel valuable — and the thing most meal apps get wrong — is a single
**canonical ingredient identity**. A "boneless chicken thigh" must be the *same entity* whether it
appears in a recipe, on a grocery list, in the freezer, or on a receipt. That shared identity is
the spine of the system:

```
                         ┌──────────────┐
        Recipe lines ───▶│              │◀─── Grocery list items
                         │  INGREDIENT  │
   Receipt line items ──▶│  (canonical) │◀─── Pantry / freezer stock
                         │              │
                         └──────┬───────┘
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼               ▼
            Nutrition       Price history     Sourcing data
            (per 100g)      (per unit/time)   (later)
```

Get the spine right and nutrition, cost, and inventory all compose for free. Get it wrong and you
have six disconnected apps sharing a login.

---

## 2. Goals & non-goals

**Goals**
- Cook fewer times per week by planning around batch cooking + preservation.
- One-tap grocery list from a weekly plan.
- Capture grocery receipts from a phone *in the store* and build a price history with near-zero effort.
- See nutrition (macros first) per recipe/meal/day.
- Optimize for cost over time; lay groundwork for sourcing/ethics data later.

**Non-goals (for now)**
- Public multi-tenant SaaS. (Household-scale only — revisit if it grows.)
- A social/recipe-sharing network.
- Restaurant/calorie-counting-app territory (barcode scanning every snack). We track what we *cook*.
- Perfectly accurate USDA-grade nutrition on day one. "Good enough and improving" beats "blocked on perfect data."

---

## 3. Stack decision & tradeoffs

This section records *why* the stack is what it is, so the decision is revisitable rather than folklore.

### 3.1 Recommendation

```
Phone app:    Expo (React Native) + TypeScript
Backend:      TypeScript — Node (Hono or Express) OR Next.js API routes
Database:     SQLite for discovery → Postgres later (Drizzle makes the swap a dialect change)
ORM:          Drizzle (preferred) or Prisma
Receipts:     Vision LLM (Claude) behind a ReceiptParser interface
Auth:         Lightweight (household = a few users)
Shared types: one TypeScript package imported by app + server
Python:       deferred — one isolated service, only when optimization/ML earns it
```

**One language across app and server.** A `Recipe` type is defined once and used on both sides.
Fastest path to something usable in the store, with a clean door open to Python.

### 3.2 The three sub-decisions

**(a) Phone layer — Expo, not PWA or Flutter.**
The core requirement is "use it like a real app in the store when I get a receipt." A native shell
wins exactly that moment: fast camera, lives on the home screen, tolerant of spotty store wifi.
Flutter was rejected because it forces Dart and throws away all type sharing with the backend. A PWA
is the simplest option but camera/offline are second-class and "add to home screen" is clunky.

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **Expo (RN)** | All-TS, native camera, OTA updates, iOS+Android | Some native modules need config | **Chosen** |
| PWA (Next.js) | Simplest, instant deploy, no store | Camera/offline second-class | Fallback |
| Flutter | Great UI | Dart; no TS reuse | Rejected |

**(b) Backend language — TypeScript now, not Python.**
~95% of the backend is database-backed CRUD and aggregation, which TS does as well as Python. The
only parts with a genuine "Python is nicer" pull are:

- *Receipt OCR* — but we don't write OCR; we call a vision model and get JSON. Python advantage: **none.**
- *Nutrition-cost optimization* — small linear-programming problem at household scale; JS solvers
  (`javascript-lp-solver`, `glpk.js`) handle it. Python advantage: **marginal, only if it gets fancy.**
- *Future sourcing/ML analytics* — genuinely Python's turf (pandas, scikit-learn), but a *later*
  feature, not a foundation. Python advantage: **real, but deferred.**

Cost of adding Python *now*: two runtimes, two dependency systems, two deploy targets, a network hop,
and constant language context-switching — permanent overhead to buy capabilities not yet needed.

**(c) Keeping the Python door open.**
Put the special-but-rare jobs behind clean interfaces from day one so Python becomes a drop-in later:

- `ReceiptParser` — today `LLMReceiptParser` (calls Claude). Later, a Python OCR service implements the same interface.
- `Optimizer` — today a JS solver. Later, a Python OR-Tools microservice implements the same interface.

Nothing else changes when either is swapped. We get a one-language codebase now and surgical Python adoption later.

### 3.3 The honest counter-argument (when to choose differently)

If we *know* we want deep data-science nutrition/sourcing analytics **soon**, and Scott is personally
faster in Python for that work, starting with a **TS frontend + Python (FastAPI) backend** split is
defensible — you simply pay the two-runtime tax from day one in exchange for a first-class analytics
environment. The deciding question is timing: if heavy analytics is >2–3 months out, defer Python;
if it's the *next thing* after the MVP, consider starting split. **Current call: defer.**

### 3.4 Recommended repo shape (monorepo)

```
eatmodel/
├─ apps/
│  ├─ mobile/         # Expo app (React Native + TS)
│  └─ server/         # TS backend (Hono/Express or Next API)
├─ packages/
│  ├─ shared/         # shared types, zod schemas, units/conversion logic
│  └─ db/             # Drizzle schema + migrations + query helpers
├─ docs/
│  └─ ARCHITECTURE.md # this file
└─ ...
```
A monorepo (pnpm/turbo) lets `mobile` and `server` import `packages/shared` so types and validation
live in exactly one place.

---

## 4. Core data model (the ingredient spine)

This is the most important section. Names are indicative; exact columns evolve in migrations.

### 4.1 Entities

**Ingredient (canonical)** — the spine.
- `id`, `canonical_name` ("chicken thigh, boneless skinless")
- `category` (protein/produce/dairy/pantry/…)
- `default_unit` (g, ml, each)
- `density_g_per_ml` (nullable, for volume↔weight conversion)
- `nutrition_per_100g` (see Nutrition) — best-known reference values
- Links out to: aliases, nutrition, price history, sourcing (later)

**IngredientAlias** — many spellings → one ingredient.
- `id`, `ingredient_id`, `alias_text` ("boneless thighs", "chicken thigh fillet"), `source` (recipe | receipt | manual)
- This is how messy recipe text and messier receipt text both resolve to the canonical ingredient.

**Recipe**
- `id`, `title`, `source_url`/`source_note`, `servings_yield`, `instructions`, `tags[]`
- `batch_factor` hint (how well it scales / freezes)

**RecipeIngredient** (recipe line)
- `id`, `recipe_id`, `ingredient_id`, `quantity`, `unit`, `prep_note` ("diced"), `optional` (bool)

**MealPlan / PlanEntry**
- `MealPlan`: `id`, `household_id`, `week_start`
- `PlanEntry`: `id`, `plan_id`, `recipe_id`, `day`, `meal_slot`, `servings_target`, `cook_session_id?`
- A *cook session* groups entries cooked together in one batch.

**GroceryList / GroceryItem**
- Generated from a plan: aggregate all `RecipeIngredient × servings`, convert to a common unit per
  ingredient, subtract what pantry already has, group by store/category.

**PantryItem (inventory, incl. preservation)**
- `id`, `household_id`, `ingredient_id` *or* `prepared_recipe_id`, `quantity`, `unit`
- `state` (raw | cooked | frozen | vacuum_sealed)
- `stored_at`, `use_by`, `location` (fridge/freezer/shelf)
- Powers "what's in the freezer," "eat-by" alerts, and grocery-list subtraction.

**Receipt / ReceiptLineItem**
- `Receipt`: `id`, `household_id`, `store`, `purchased_at`, `total`, `image_ref`, `parse_status`
- `ReceiptLineItem`: `id`, `receipt_id`, `raw_text`, `quantity`, `unit`, `price`, `ingredient_id?` (after matching), `match_confidence`

**PriceObservation** — the price-history fact table.
- `id`, `ingredient_id`, `store`, `observed_at`, `unit`, `unit_price`, `source_receipt_line_id`
- Append-only. Everything cost-related (trends, best store, $/g protein) is built on this.

**Household / User** — light auth.
- `Household`: `id`, `name`. `User`: `id`, `household_id`, `email`, `role`.
- Almost every row is scoped by `household_id`.

### 4.2 The two hard problems

1. **Ingredient matching** (recipe text + receipt text → canonical ingredient). Strategy: exact alias
   match → fuzzy/embedding match → LLM fallback → human confirm. Every confirmed match writes a new
   `IngredientAlias`, so the system gets smarter over time. **This is the make-or-break subsystem.**
2. **Unit conversion** (cups ↔ grams ↔ "each"). Needs density + per-item weights. Lives in
   `packages/shared` as pure, tested functions. When conversion is impossible, the UI asks rather than guesses.

---

## 5. Key pipelines

### 5.1 Receipt capture (the novel part)
```
Phone camera ─▶ upload image ─▶ ReceiptParser (vision LLM) ─▶ structured line items
   ─▶ ingredient matching (alias → fuzzy → LLM → confirm)
   ─▶ write ReceiptLineItem + PriceObservation
   ─▶ optional: decrement grocery list / increment pantry
```
Design notes:
- `ReceiptParser` is an interface; v1 implementation calls a vision model and returns
  `{ store, date, total, lines: [{ rawText, qty, unit, price }] }` validated by a zod schema.
- Low-confidence matches go to a quick "is this X?" review queue rather than silently guessing.
- Store the original image (object storage) for re-parsing as the parser improves.

### 5.2 Plan → grocery list
```
Plan entries ─▶ explode recipes into line items ─▶ scale by servings_target
   ─▶ convert each ingredient to one unit ─▶ sum per ingredient
   ─▶ subtract pantry stock ─▶ group by category/store ─▶ GroceryList
```

### 5.3 Nutrition rollup
```
RecipeIngredient (qty,unit) ─▶ convert to grams ─▶ × nutrition_per_100g
   ─▶ sum per recipe ─▶ ÷ servings ─▶ per-serving macros
   ─▶ aggregate over plan ─▶ per-day / per-week macros
```
Nutrition reference data: seed from a public source (e.g. USDA FoodData Central) for common items;
allow manual override per ingredient. Accuracy improves incrementally; never block the app on it.

---

## 6. Nutrition data model

`nutrition_per_100g` (per ingredient, all per 100 g unless noted):
`calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, …` (extend later).
Start with the macro four (cal/protein/carb/fat); add micros when there's a reason.

Cost-per-nutrient (the optimization hook) is a derived view:
`PriceObservation.unit_price` + `nutrition_per_100g` ⇒ `$ / g protein`, `$ / 100 kcal`, etc., over time.

---

## 7. Phased roadmap

Each phase should be independently useful. Don't build all six modules at once.

> **Approach: discovery-first vertical slices.** Build the *thinnest* end-to-end skeleton of each
> piece to de-risk the mechanics, on disposable harnesses (CLI first) over permanent interfaces.
> The receipt→OCR→db slice goes first because it's the riskiest and most novel. SQLite during
> discovery; Drizzle keeps the Postgres migration a dialect change, not a rewrite.

**Phase 0 — Foundations + receipt discovery slice**
- Monorepo; Drizzle schema (SQLite) for the spine + receipt tables (Ingredient, Alias, Receipt,
  ReceiptLineItem, PriceObservation).
- Shared units/conversion library + zod schemas, with tests.
- **Discovery slice (decoupled ingest + processing) — no custom server:**
  - *Ingest = a synced folder* (Dropbox / iCloud / Drive). Phone shares the receipt photo into the
    folder; it syncs to the laptop. Capture is instant, offline-tolerant, and **zero code** — we
    reuse an existing best-in-class tool instead of building an upload server.
  - *`process-receipts` CLI* — run later from the laptop: drain the synced inbox folder →
    `ReceiptParser` (vision LLM) → `IngredientMatcher` → write to SQLite → move image to a
    `processed/` folder → print summary.
  - The **inbox folder is the queue**: ingest and processing stay fully decoupled (no shared db).
    The CLI owns SQLite.
  - Maps onto the real app later: the synced folder is swapped for an upload endpoint; the CLI
    becomes a background worker. The `ReceiptParser` / `IngredientMatcher` / repository seams persist.
- (Deferred to Phase 1+: Expo app shell + household auth.)

> **Build note:** the discovery slice ships as a *single TypeScript package* with clean internal
> module folders (`db/`, `parser/`, `matcher/`, `shared/`, `cli/`) that mirror the future
> `packages/*`. Promoting folders → workspace packages later is mechanical; a pnpm/turbo monorepo
> is deliberately deferred to avoid tooling friction during discovery. Not a rewrite — a promotion.

**Phase 1 — Recipes + grocery list (immediately useful)**
- Add/edit recipes; ingredient matching on recipe entry.
- Weekly plan; generate aggregated grocery list. *(No nutrition yet.)*

**Phase 2 — Nutrition**
- Seed reference nutrition; per-recipe and per-day macro rollups.

**Phase 3 — Receipts + price history (the differentiator)**
- Camera capture → `LLMReceiptParser` → line items → `PriceObservation`.
- Receipt-to-ingredient matching + review queue.
- First price trends + cost-per-nutrient views.

**Phase 4 — Preservation / pantry**
- Pantry & freezer inventory, states, use-by alerts, grocery-list subtraction, batch-cook sessions.

**Phase 5 — Cost & sourcing intelligence (long-term)**
- Optimization ("max protein/$ under constraints") behind the `Optimizer` interface — first JS,
  Python service if it grows.
- Integrate outside sourcing/ethics/chemical data once obtained.

---

## 8. Infrastructure (lightweight to start)

- **DB:** managed Postgres (Neon / Supabase / RDS). Supabase also bundles auth + object storage,
  which is convenient at household scale.
- **Object storage:** receipt images (Supabase Storage / S3).
- **Backend hosting:** a single small service (Fly.io / Railway / Render) or Next API on Vercel.
- **Mobile delivery:** Expo EAS builds + OTA updates.
- **Secrets:** vision-LLM API key server-side only — the phone never holds it; the app uploads the
  image to our server, which calls the parser.

---

## 9. Cross-cutting concerns

- **Validation:** zod schemas in `packages/shared`, shared by client and server.
- **Auth/scoping:** every query scoped by `household_id`; roles kept simple (owner/member).
- **Offline (later):** receipt capture should tolerate no-signal — queue the image locally and upload when back online.
- **Testing:** unit-test the pure cores hardest — unit conversion, list aggregation, nutrition math, ingredient matching.
- **Privacy:** receipts reveal a lot. Data stays in the household's own store; no third-party sharing.

---

## 10. Open questions / to decide later

- **Auth provider:** Supabase Auth vs Clerk vs roll-our-own-lite for a household.
- **Drizzle vs Prisma:** leaning Drizzle (lighter, SQL-first); Prisma if we want more batteries.
- **Backend shape:** standalone Hono service vs Next.js API routes (fewer moving parts if the
  "web companion" ever matters).
- **Nutrition source:** USDA FDC import scope — which fields, how many seed items.
- **Optimization depth:** how fancy does "macros per dollar" need to get? (Drives the JS-vs-Python timing.)
- **Sourcing data:** what external datasets exist for company/chemical info, and their licensing.

---

## 11. Decision log

- **2026-06-29** — Platform: native phone app via **Expo** (in-store receipt capture is the deciding use case).
- **2026-06-29** — Backend language: **TypeScript now**, Python deferred behind `ReceiptParser` / `Optimizer` interfaces.
- **2026-06-29** — Scope: **household** (light multi-user), not public SaaS.
- **2026-06-29** — Architecture centers on a **canonical ingredient spine** shared by recipes, grocery, pantry, and receipts.
- **2026-06-29** — **Discovery-first vertical slices** over disposable harnesses (CLI before app); receipt→OCR→db slice first.
- **2026-06-29** — **SQLite during discovery**, Postgres later; Drizzle keeps the swap to a dialect change, not a rewrite.
- **2026-06-29** — Receipt flow is **decoupled**: instant dumb upload (phone→inbox) + later batch CLI processing (laptop→SQLite); the inbox is the queue.
- **2026-06-29** — Ingest reuses a **synced folder (Dropbox/iCloud/Drive)** — no custom upload server built; reuse beats build for a solved problem.
- **2026-06-29** — Discovery ships as a **single TS package** with module folders mirroring future `packages/*`; monorepo tooling deferred.
- **2026-06-29** — Discovery DB uses **better-sqlite3 behind a repository layer** (no migration tooling yet); Drizzle adopted when the server/app lands — the repository interface, not the ORM, is the Postgres-swap seam.
- **2026-06-29** — Receipt OCR uses **Claude vision + structured outputs** (`messages.parse` + `zodOutputFormat`) on `claude-opus-4-8`, behind the `ReceiptParser` interface; a `MockReceiptParser` lets the pipeline run with no API key.
- **2026-06-29** — Adopted **engineering conventions** (see `docs/CONVENTIONS.md`): green-`main` + feature branches, TDD for the deterministic core via `node:test`, evals (not unit tests) for the LLM parser, dependencies point inward. Pure price-derivation logic extracted to `shared/pricing.ts` and tested.
- **2026-06-29** — **Ingestion safety** (from a code review): `process-receipts` loads `.env` and the parser selection **fails loud** without a key (mock only via `process:mock`, never a silent fallback); **content-hash dedup** (UNIQUE `image_sha256` + a pre-parse `hasReceipt` check) makes re-runs idempotent and avoids re-billing the API on duplicates.
- **2026-06-29** — Stopped **fabricating** price-observation date/unit — a missing purchase date or unit is stored as `null`, not "today"/"each" (per `CONVENTIONS.md §5`).

---

## 12. Known limitations of the current discovery slice

Deliberate simplifications in the first slice — recorded so they aren't mistaken for finished behavior.

- **Matching is exact-alias-or-create.** Every new normalized description spawns a new canonical
  ingredient. `"CHKN THGH"` and `"chicken thighs"` will **not** converge yet — fuzzy/embedding/LLM
  matching + a review queue is a later phase (§4.2, §7 Phase 3). Until then the ingredient list will
  over-fragment; that's expected.
- **`unitPrice` falls back to `lineTotal`** when a line has no quantity. So a whole-package price can be
  recorded as if per-unit. Fine for trend-spotting; revisit before serious cost-per-nutrient math.
- **Uncertain values are stored, not fabricated** *(fixed 2026-06-29)*. A missing purchase date or
  unit is recorded as `null` (not "today"/"each"); the price is still recorded when known. Reporting
  must handle null dates/units.
- **HEIC/HEIF is auto-converted on macOS only.** iPhone photos are often HEIC, which Claude vision
  rejects; the CLI converts them to a temporary JPEG via `sips` (keeping the original) before parsing.
  On non-macOS platforms HEIC fails per-file with a clear message — convert manually or capture JPEG.
- **No reporting yet.** Data accumulates in SQLite but there's no trend/price-history view — that's the
  next build (§7 Phase 3).

---

## 13. Code review findings (2026-06-29) & status

A review of the discovery slice surfaced five issues; status tracked here.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | `.env` documented but not loaded → `process` silently used the mock and saved canned data | **Fixed** — loads `.env`, fails loud without a key |
| 2 | High | Not idempotent; no image fingerprint → re-runs duplicate rows | **Fixed** — content-hash dedup + UNIQUE `image_sha256` |
| 4 | Medium | Fabricated facts (date→today, unit→"each") — contradicted `CONVENTIONS.md §5` | **Fixed** — stores `null` instead |
| 3 | Medium | Loose zod validation lets bad LLM output (empty/negative/odd) become facts | **Queued** — see below |
| 5 | Medium | Exact-alias-or-create hardens unconfirmed ingredients into the spine | **Queued** — see below |

**Queued — "boundary hardening + review staging" (next chunk):**
- **#3** tighten the *safe, universal* validations at the schema (`description.trim().min(1)`,
  non-negative finite prices/quantities) but do the rest as **normalize-or-quarantine at the DB
  boundary** — strict whole-object schema would reject an entire receipt over one odd line, so flag
  questionable lines for review instead of dropping the receipt or silently promoting them.
- **#5** add a lightweight review/`needs_review` gate so freshly-minted (`match_confidence = 'new'`)
  ingredients don't harden into the spine before a human confirms — full fuzzy matching stays Phase 3.
