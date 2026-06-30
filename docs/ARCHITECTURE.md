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

**The payoff is the emergent cross-module queries, not the modules.** The roadmap (§7) builds
module-by-module, but the reason the spine exists is the questions only it can answer — these are the
north-star demos to steer toward, each one a join no single-purpose app can do:

- **"What can I cook *right now*?"** — pantry/freezer stock ∩ recipe requirements → cookable recipes,
  ranked by *fewest missing ingredients* (and what to buy to unlock the next N).
- **"Cheapest way to cook this week's plan."** — plan → grocery list → `price_observations` per
  ingredient per store → cheapest basket (needs the store-identity spine, §14).
- **"Most protein per dollar I can actually stand to eat."** — `foods` macros + price, *filtered by the
  variety/enjoyment constraints* so it doesn't recommend gruel (§1 enjoyment goal).
- **"Use-it-or-lose-it."** — pantry `use_by` ∩ recipes that consume those items → suggested cooks.

Each becomes answerable the moment its inputs share the spine; none requires a new module, only the
links already being built. Listing them here so a slice can be judged by *which query it lights up*.

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
   `IngredientAlias`, so the system gets smarter over time. **This is the make-or-break subsystem** —
   and it is one instance of a more general primitive (see **§4.3**).
2. **Unit conversion** (cups ↔ grams ↔ "each"). Needs density + per-item weights. Lives in
   `packages/shared` as pure, tested functions. When conversion is impossible, the UI asks rather than
   guesses. **Make-or-break for nutrition and cost math, and almost entirely unbuilt** (`shared/units.ts`
   is currently just `normalizeName`). Design sketch:
   - **Three conversion classes, in order of reliability:** (a) *mass↔mass* and *volume↔volume* are
     pure ratios, always known; (b) *volume↔mass* needs `ingredient.density_g_per_ml`; (c) *count↔mass*
     ("2 cloves", "1 can") needs a per-each weight, which is **per-ingredient, not universal** — store
     it on the ingredient (e.g. `grams_per_each`, nullable).
   - **Density/per-each data is reference data → seed small, backfill later** (same triage as `foods`):
     ship a handful of common items, source the rest from USDA FDC portion data or accumulate from
     confirmed conversions over time.
   - **No-silent-guessing is the hard contract:** the function returns `grams | null`, never a
     fabricated number. A `null` propagates up as a `partial` rollup (§6) and, in the app, becomes an
     "what does 1 clove of garlic weigh?" prompt whose answer is *stored on the ingredient* — so the
     same gap is asked once, then never again (the §4.3 learning loop, applied to units).
   - Tagged-union result (`{ ok, grams }` | `{ ok: false, reason }`) over throwing, so callers must
     handle the gap. Pure + exhaustively tested, test-first.

### 4.3 One primitive under all of it: the resolution gate

The single most reusable idea in the system, currently implemented ad hoc per feature. **Ingredient
matching (§4.2 #1), nutrition food-linking (§6), store identity (§14), and cross-source dedup are not
four features — they are four instances of one primitive:** *resolve a messy token to a canonical
entity, stage the link as provisional, let a human confirm or merge, and feed every confirmation back
so the resolver gets smarter.*

```
  raw token ──▶ candidate generation ──▶ confidence score ──▶ gate ──▶ confirmed edge
  ("GV CHKN")   (alias/fuzzy/LLM/        (auto-accept high,    (§5.5   (writes an alias /
                 catalog lookup)          stage the rest)       review)  link that teaches
                                                                         the next lookup) ◀─┐
                                                                                            │
                            every confirmation widens what auto-resolves next time ─────────┘
```

Each instance varies only in three slots:
| Instance | token | candidate source | confirmed edge written |
|---|---|---|---|
| Ingredient match | recipe/receipt line text | `ingredient_aliases` → fuzzy → LLM | new `IngredientAlias` |
| Food link (§6) | a canonical ingredient | `foods` catalog (USDA FDC) | `ingredient.food_id` |
| Store identity (§14) | `receipts.store` free text | canonical `stores` → fuzzy | store alias |
| Unit gap (§4.2 #2) | "1 clove" on an ingredient | human answer | `grams_per_each` on the ingredient |

The **review gate (§5.5)** is already the shared *back half* (stage → confirm/merge). What's not yet
factored out is the *front half* (candidate generation + confidence + the alias/edge that closes the
learning loop). **Implication for sequencing:** when nutrition builds the food-link, build it against
this shape — a small `resolve(token, candidates) → {status, edge}` seam — rather than a bespoke
nutrition-only path, so store identity and auto ingredient-matching later drop in as the *same* seam
with different slots filled. (Deliberately *not* over-abstracting now: extract the seam when the
*second* instance lands, which is the food-link — that's the moment the duplication is real, not
hypothetical.)

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

### 5.4 Recipe capture (discovery slice)

The symmetric twin of receipt capture: photograph a recipe (often a page from a cookbook) into a
synced *recipe* inbox, then batch-process it from the laptop. Same skeleton as §5.1 — synced-folder
ingest, vision-LLM parser behind an interface, content-hash dedup, repository write, move-to-processed.

```
Phone camera ─▶ recipe inbox (synced folder) ─▶ RecipeParser (vision LLM) ─▶ structured recipes (1+ per page)
   ─▶ ingredient matching (alias → create), source='recipe'
   ─▶ write RecipeIngest (the image) + Recipe + RecipeIngredient rows
```

**One image, many recipes.** A photographed cookbook page routinely shows more than one recipe
(the first real test image had two side by side — "Minted Pineapple" and "Quick Tomato Mold"). So the
parser returns a `RecipePage` = a list of recipes, and persistence splits into a `recipe_ingests` row
(the image — the content hash + dedup live here, one per photo) and one `recipes` row per recipe on it.
This keeps the idempotency backstop (UNIQUE image hash) while letting a page fan out to N recipes.

**Why this slice is worth building now:** it's the first thing that feeds the ingredient spine from
the *recipe* side. Until now every canonical ingredient was born from a receipt line. Recipes write
to the **same** `ingredients` table, which is the real test of the spine — and which exposes how far
the exact-alias matcher is from converging recipe phrasing (`"boneless skinless chicken thighs"`)
with receipt phrasing (`"GV CHKN THGH"`). That gap is discovery output, not a regression (§12).

**Two design decisions specific to recipes:**

- **Shared spine, separate envelope.** Recipe lines resolve to the *same* canonical `ingredients` /
  `ingredient_aliases` as receipts (the spine is the whole point). But a recipe line is shaped
  differently from a receipt line — it has a `prep_note` ("diced") and an `optional` flag, and it has
  **no price**; a receipt line has price and no prep. So we deliberately do **not** force them through
  one `ParsedLineItem` type. They share ingredient resolution and split on everything else: a separate
  `RecipeParseResult` schema and separate `recipe` / `recipe_ingredients` tables. Premature unification
  here would couple two things that are only half-alike.
- **Ingredients-list-first (v1 scope).** The parser captures `title`, `source_note` (book / page),
  `servings`, and the **ingredient list** — not the step-by-step instructions. The ingredient list is
  what connects to the spine, grocery lists, and price/nutrition; steps are inert storage until there's
  a cooking UI. Crucially this loses nothing: as with receipts we keep the original image in
  `processed/` and store `raw_json`, so steps (or richer fields) can be re-parsed later without
  re-photographing. Adding a `steps` field is an additive schema change, not a rewrite.

The same seams persist into the real app: the synced folder → an upload endpoint, the CLI → a worker,
the `RecipeParser` and repository interfaces unchanged.

### 5.5 The review / confidence gate

The make-or-break risk (§4.2) is that messy, fragmented, or wrong data **hardens into the spine** as it
accumulates — and unlike an extraction gap (re-derivable from the retained image), a bad *identity*
decision is expensive to unwind later. The gate is the seam that keeps provisional data provisional.
Two mechanisms, both deliberately *flag, never drop*:

**1. Ingredient staging (the #5 concern).** A freshly-minted ingredient is created with
`status = 'unconfirmed'`. It still accrues aliases/prices/recipe links immediately (nothing is
blocked), but it's visibly provisional until a human acts. Two actions resolve it:
- `confirmIngredient(id)` — promote it to a trusted part of the spine.
- `mergeIngredient(fromId, intoId)` — fold a fragment into its real identity (e.g. `"SR FLOUR"` →
  `"self-raising flour"`), re-pointing every alias, line, and price observation, then deleting the
  source. **This is the concrete remedy for the exact-match fragmentation in §12** — until fuzzy
  matching lands (Phase 3), merge is how the spine de-fragments.

**2. Boundary validation (the #3 concern), normalize-or-flag.** At persist time each line is checked
(`shared/review.ts`, pure + tested): an empty name or a negative/non-finite quantity/price sets the
line's `needs_review` flag with a reason. The line is **still stored** — one odd line must not sink an
entire receipt — but an invalid identity is **not** promoted to a canonical ingredient, and a flagged
price is **not** promoted to a `price_observation` (a bad number must never become a cost "fact").
Receipts also get a cheap **total reconciliation**: if the line items sum to *more* than the printed
total (a double-count/misread — tax only makes the total larger) or *far below* it (likely missed
lines), the receipt is flagged. Advisory, not authoritative — discounts can cause benign overshoots.

**Surfacing it.** The ingest CLIs mark flagged lines inline (`⚠ review`); `npm run review` lists
unconfirmed ingredients, flagged lines, and unreconciled receipts, and performs `confirm` / `merge` /
`resolve-line` / `resolve-receipt`. A real review UI later calls the same repository methods. Full
fuzzy/embedding matching stays Phase 3; this gate is the human-in-the-loop scaffold it will eventually
feed.

---

## 6. Nutrition data model

**Decision (2026-06-30): nutrition is a *referenced* attribute, not an inline column.** An earlier
sketch put `nutrition_per_100g` directly on the `ingredient` row. That conflates two distinct
identities: *"chicken thigh, boneless skinless"* (my canonical spine entry) versus *"USDA FDC #331960,
chicken, broilers/fryers, thigh, meat only, raw"* (a reference food with its own facts). Nutrition is a
property of the **reference food**, surfaced on the ingredient through a **link** — and that link is a
human judgment, so it is gated exactly like ingredient and (coming) store identity.

Three pieces:

**`foods` — reference catalog (read-only, seeded).**
- `id`, `fdc_id` (stable external key into USDA FoodData Central), `description`, `source` (`usda_fdc` |
  `manual`), `nutrition_per_100g`.
- `nutrition_per_100g`: start with the **macro four** — `calories, protein_g, carbs_g, fat_g`; add
  `fiber_g, sugar_g, sodium_mg, …` and micros when there's a reason.
- This is **extraction, re-derivable** (§14 triage): seed a handful of common items now; backfill more
  via the stable `fdc_id` later without re-deciding any links.

**`ingredient.food_id` — the link (nullable FK), gated.**
- Resolving a canonical ingredient to its reference food is the **make-or-break identity decision** of
  this slice, symmetric to ingredient matching (§4.2 #1) and store identity (§14). It rides the **same
  review gate (§5.5)**: a new link persists as provisional and is promoted via `confirm` — "is this the
  right reference food for this ingredient?" is the same primitive as "is this the right canonical
  ingredient for this line?" An unresolved ingredient keeps `food_id = null` and simply has no macros
  yet — never a guessed match.

**Rollup — pure, deterministic, `null`-honest.**
The per-recipe / per-serving math (§5.3) lives in `shared/nutrition.ts`, TDD'd test-first like
`shared/review.ts`. The hard part is **not** the food data — it's `qty,unit → grams` (§4.2 #2): a line
of "1 cup" or "2 cloves" needs `density_g_per_ml` or a per-each weight we often lack. Per the
no-silent-guessing rule, an unconvertible line yields a **`null` macro and marks the recipe rollup
*partial*** (surfaced as `⚠ partial`) — never a fabricated number. Coverage improves as conversion
data fills in; the app never blocks on it.

Cost-per-nutrient (the optimization hook) is then a derived view, once price meets a confirmed link:
`PriceObservation.unit_price` + `foods.nutrition_per_100g` ⇒ `$ / g protein`, `$ / 100 kcal`, over time.
This is the bridge to the store-identity/price work — it wants *both* a food link and canonical stores,
which is the sequencing argument for doing nutrition first (§7 Phase 2, §11).

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

**Phase 2 — Nutrition** *(next slice — spec'd 2026-06-30, §6)*
- `foods` reference catalog (seed a handful of common USDA FDC items); gated `ingredient.food_id` link
  on the §5.5 review gate; pure `shared/nutrition.ts` rollup with `null`-honest `partial` handling.
- Per-recipe and per-serving macros surfaced in the `recipes` + `review` CLIs.
- **Chosen ahead of store-identity** despite store-identity being the other open identity decision
  (§14): nutrition has immediate user-visible payoff (macros on recipes already ingested) and
  establishes the reference-link+gate pattern that makes store-identity a second instance of the same
  shape. Store-identity has no payoff until the price/cost-per-nutrient views — which also want this
  link — exist. (§11, 2026-06-30.)

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
- **2026-06-29** — Discovery DB uses **better-sqlite3 behind a repository layer** with a tiny additive `schema_migrations` runner; Drizzle/full migration tooling is adopted when the server/app lands — the repository interface, not the ORM, is the Postgres-swap seam.
- **2026-06-29** — Receipt OCR uses **Claude vision + structured outputs** (`messages.parse` + `zodOutputFormat`) on `claude-opus-4-8`, behind the `ReceiptParser` interface; a `MockReceiptParser` lets the pipeline run with no API key.
- **2026-06-29** — Adopted **engineering conventions** (see `docs/CONVENTIONS.md`): green-`main` + feature branches, TDD for the deterministic core via `node:test`, evals (not unit tests) for the LLM parser, dependencies point inward. Pure price-derivation logic extracted to `shared/pricing.ts` and tested.
- **2026-06-29** — **Ingestion safety** (from a code review): `process-receipts` loads `.env` and the parser selection **fails loud** without a key (mock only via `process:mock`, never a silent fallback); **content-hash dedup** (UNIQUE `image_sha256` + a pre-parse `hasReceipt` check) makes re-runs idempotent and avoids re-billing the API on duplicates.
- **2026-06-29** — Stopped **fabricating** price-observation date/unit — a missing purchase date or unit is stored as `null`, not "today"/"each" (per `CONVENTIONS.md §5`).
- **2026-06-29** — **Recipe ingestion** added as the second discovery slice, mirroring receipts (synced inbox + batch CLI + vision LLM behind a `RecipeParser` interface + content-hash dedup). **Shared spine, separate envelope**: recipe lines resolve to the same canonical `ingredients`/`ingredient_aliases` but get their own `RecipeParseResult` schema and `recipe`/`recipe_ingredients` tables (recipe lines carry `prep_note`/`optional` and no price; receipt lines carry price and no prep — no shared `ParsedLineItem`). Scope is **ingredients-list-first**: capture title/source/servings/ingredients, not instructions; the original image + `raw_json` are kept so steps can be re-parsed later (additive, not a rewrite).
- **2026-06-29** — **One image → many recipes** (found on the first real cookbook photo, which had two recipes side by side): `RecipeParser` returns a `RecipePage` (list of recipes), and persistence splits into `recipe_ingests` (the image — UNIQUE content hash / dedup lives here) → many `recipes`. Preserves the idempotency backstop while a page fans out to N recipes. Validated end-to-end: both recipes landed, and an ingredient shared across the two ("salt") resolved to one canonical entry.
- **2026-06-29** — **Discovery-phase schema migration** (from a code review): `CREATE TABLE IF NOT EXISTS` never alters existing tables, so an older db silently lacked newer columns and would crash on insert. `Db` now runs a tiny migration runner on open, records applied migrations in `schema_migrations`, additively `ALTER TABLE ADD COLUMN` where safe (e.g. `receipts.image_sha256` + a UNIQUE index), and for structurally-incompatible old schemas (a pre-page `recipes` table with no `ingest_id`) **fails loud telling the user to `npm run db:reset`**. Full Drizzle-style migration tooling still deferred (when the server lands).
- **2026-06-29** — **Ingest hardening** (same review): (a) processed/quarantined files are **hash-prefixed** (`<sha12>-<name>`) so two different images sharing a basename (`IMG_0001.jpg`) can't overwrite each other — honoring "keep originals for re-parse"; (b) a parse that yields **zero recipes / zero line items is quarantined** to a `failed/` folder, not saved — saving an empty result would dedup the image as "done" and re-billing could never re-extract it.
- **2026-06-29** — **Review / confidence gate** (§5.5) built (closes review findings #3 + #5). New ingredients persist as `status='unconfirmed'` and are promoted via `confirmIngredient` or de-fragmented via `mergeIngredient` (the concrete remedy for exact-match fragmentation until Phase 3 fuzzy matching). Boundary validation **flags, never drops**: untrustworthy lines get a `needs_review` reason and are excluded from price observations, but still stored (one bad line can't sink a receipt). Invalid identities stay unlinked instead of minting garbage canonical ingredients. Receipts get a cheap **total reconciliation** (lines exceeding the total, or far below it, flag the receipt). Surfaced via `⚠ review` in the ingest CLIs and a `npm run review` CLI (list / confirm / merge / resolve-line / resolve-receipt). Validation logic is pure + tested in `shared/review.ts`.
- **2026-06-29** — **Baby-app hardening pass:** fresh SQLite databases now include `CHECK` constraints for hard invariants (review booleans, ingredient status, match confidence, positive recipe ingest counts, non-negative persisted price facts). The process scripts export callable `processReceipts` / `processRecipes` functions behind CLI main guards, enabling integration tests over temp inbox/processed/db paths without invoking the network or mutating real data.
- **2026-06-29** — **Guiding principle for "handle it now vs later":** because every ingest **retains the original image + `raw_json`**, almost any *extraction* gap (units, fractions, sub-sections, discounts) is re-derivable by re-parsing and can be safely deferred. What's *not* cheaply reversible is **identity and accumulated human judgment** (how lines resolve to the spine; confirmations) — so those get handled now (the gate), and the rest is logged as backlog (§14).
- **2026-06-30** — **Nutrition chosen as the next slice (§6, §7 Phase 2).** Nutrition is modeled as a
  *referenced* attribute, not an inline `ingredient` column: a read-only `foods` reference catalog
  (seeded from USDA FDC, keyed by `fdc_id`) + a **gated `ingredient.food_id` link** on the existing
  §5.5 review gate, + a pure `shared/nutrition.ts` rollup. Rationale split by the §14 triage rule — the
  *link* is accumulated judgment (handle now, gate it), the *food catalog* is re-derivable extraction
  (seed small, backfill later). The real risk is `qty,unit → grams` conversion (§4.2 #2), not the food
  data; unconvertible lines mark a recipe **`partial`** rather than fabricating macros (no-silent-
  guessing). **Sequenced ahead of store identity** (still open, §14): nutrition has immediate
  user-visible payoff and establishes the reference-link+gate pattern that makes store identity a second
  instance of the same shape — whereas store identity has no payoff until the cost-per-nutrient views,
  which themselves want this link, exist.
- **2026-06-30** — **Documented four latent design ideas that existed only in discussion**, to close the
  gap between how well *decisions* were recorded and how poorly some *generative* ideas were: (1) **§4.3
  the resolution gate** — ingredient-matching, food-linking, store-identity, and unit gaps are one
  primitive (token → candidates → confidence → gate → confirmed edge that teaches the next lookup);
  factor the seam out when the food-link (the second instance) lands, not before. (2) **§4.2 #2 expanded**
  into an actual conversion-engine sketch (three reliability classes, per-each weight on the ingredient,
  `grams | null` no-guess contract) — flagged that the "make-or-break" lib is still essentially unbuilt.
  (3) **§1 emergent-query north-stars** — the spine is justified by cross-module joins ("what can I cook
  now," cheapest-basket, protein-per-$ within variety), so slices can be judged by which query they light
  up. (4) **§12/§14 eval-harness gap** — `CONVENTIONS §2` specifies a parser eval; none exists, leaving
  the riskiest subsystem with no regression signal. No code; these steer the upcoming nutrition slice.

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
- **Recipe lines fragment the spine, and across sources too.** Recipe ingredients use the same
  exact-alias-or-create matcher (§5.4), so recipe phrasing rarely converges with receipt phrasing yet
  (`"boneless skinless chicken thighs"` ≠ `"GV CHKN THGH"`). Automatic convergence waits for
  fuzzy/embedding matching (§7 Phase 3); **in the meantime `mergeIngredient` (the review gate, §5.5)
  is the manual remedy** — fold fragments together by hand. Over-fragmentation is expected and is
  exactly the signal this slice exists to surface.
- **Recipe steps are not captured (ingredients-list-first).** v1 extracts title/source/servings/
  ingredients only. The original image and `raw_json` are retained, so instructions can be re-parsed
  later without re-photographing.
- **No parser eval harness yet — only the intention of one.** `CONVENTIONS.md §2` specifies a
  `fixtures/` set of real images + hand-checked extractions and a script that reports extraction diffs
  when the prompt/model changes. Neither the `fixtures/` set nor the runner exists. For the *riskiest*
  part of the system (the two vision parsers), there is currently no regression signal — a prompt tweak
  or model bump could silently degrade extraction and nothing would catch it. Cheap to start (we already
  retain every image + `raw_json`, so fixtures are free to collect); worth standing up before the
  parsers are trusted for anything cost- or macro-quantitative. Tracked in §14.

---

## 13. Code review findings (2026-06-29) & status

A review of the discovery slice surfaced five issues; status tracked here.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | `.env` documented but not loaded → `process` silently used the mock and saved canned data | **Fixed** — loads `.env`, fails loud without a key |
| 2 | High | Not idempotent; no image fingerprint → re-runs duplicate rows | **Fixed** — content-hash dedup + UNIQUE `image_sha256` |
| 4 | Medium | Fabricated facts (date→today, unit→"each") — contradicted `CONVENTIONS.md §5` | **Fixed** — stores `null` instead |
| 3 | Medium | Loose zod validation lets bad LLM output (empty/negative/odd) become facts | **Fixed** — §5.5 boundary validation (flag, don't drop; flagged prices never become observations) |
| 5 | Medium | Exact-alias-or-create hardens unconfirmed ingredients into the spine | **Fixed** — §5.5 staging (`status='unconfirmed'` + confirm/merge) |

Both #3 and #5 were resolved together by the **review / confidence gate (§5.5)** — boundary validation
flags untrustworthy lines (never dropping a whole receipt, never promoting a bad price to a fact), and
ingredient staging keeps new entries provisional until confirmed or merged.

---

## 14. Backlog — known recipe/receipt edge cases (deferred, mostly retro-fixable)

Surfaced while ingesting the first real images, kept here so they aren't forgotten. The triage rule is
the principle in the §11 log (2026-06-29): **we retain the original image + `raw_json` for every
ingest, so most _extraction_ gaps can be re-derived later by re-parsing** — those are safe to defer.
What gets pulled forward is anything touching **identity** (the spine) or **accumulated judgment**,
because that's expensive to unwind once data piles up.

**Next slice chosen — nutrition (§6, §7 Phase 2):**
- **Nutrition link is an identity decision → handled now; the food DB is extraction → deferred.**
  Resolving a canonical ingredient to a reference food (`ingredient.food_id`) is accumulated human
  judgment and rides the §5.5 gate; the `foods` catalog itself is re-derivable reference data, so only
  a small seed is built now and backfilled later via stable `fdc_id`. The pure rollup
  (`shared/nutrition.ts`) is `null`-honest: unconvertible units (the real risk, §4.2 #2) mark a recipe
  `partial` rather than fabricating macros. Sequenced **ahead of store identity** (which remains the
  other open decision below) for user-visible payoff + because it establishes the reference-link+gate
  pattern store-identity will reuse. (See §11 log entry 2026-06-30 in §6/§7.)

**Next identity decision (do before it accumulates):**
- **Store identity for receipts.** `receipts.store` is free text today — `WAL-MART #1234` / `Walmart` /
  `WM SUPERCENTER` will never group, which blocks "which store is cheapest." Needs a canonical *store*
  spine mirroring the ingredient spine (raw store text is retained, so retrofittable, but it's the same
  *class* of decision as the ingredient spine — worth doing deliberately and soon).

**Deferred — retro-fixable from the retained image/JSON:**

| Area | Edge case | Why it can wait |
|---|---|---|
| Matching | Fuzzy/embedding matching so `CHKN THGH` ≈ `chicken thighs` automatically | Algorithm over retained data; the §5.5 `merge` tool covers it manually until **Phase 3**. |
| Units | Heterogeneous units — `g`/`ml`/`tbsp`/`"1 can"`/`"to taste"`/`"dash"`; mixed like `1 lb 4½ oz` | Pure conversion functions over `raw_text`; prerequisite for nutrition & cost math (§4.2 #2). |
| Recipes | Sub-sections (`"For the sauce: …"`), ranges (`2–3 cloves`), `to taste` | Additive `section` field / range handling; re-parse when it matters. |
| Receipts | Discounts/coupons/multi-buy → recorded gross price ≠ net paid | Affects cost accuracy; re-derivable from the receipt image. (Reconciliation §5.5 already flags gross > total.) |
| Receipts | `unitPrice` falls back to `lineTotal` when quantity is absent (whole-package price as per-unit) | Fine for trend-spotting; revisit before serious cost-per-unit math. |
| Both | Cross-photo duplicate (same recipe/receipt re-shot → different hash, not deduped) | Content-hash can't catch it; title/line similarity is a later nicety. |
| Recipes | Steps/instructions not captured (ingredients-list-first) | Original image retained; re-parse when the cooking/preservation phase lands. |
| Quality | **Parser eval harness** (`fixtures/` + diff runner per `CONVENTIONS §2`) not built | Retained images + `raw_json` mean fixtures are free to backfill; stand up before the parsers are trusted for quantitative cost/macro math (§12). |
