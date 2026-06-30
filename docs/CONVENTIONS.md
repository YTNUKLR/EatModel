# EatModel — Engineering Conventions

> Status: Draft v1 · Date: 2026-06-29
> How we work on EatModel. Calibrated to the **current stage**: greenfield, household-scale,
> discovery. Each practice is tagged **[now]** (adopt today) or **[later]** (has a trigger; don't
> pay for it yet). Revisit as the project grows — process should track the stakes, not exceed them.

The guiding principle: **keep `main` always working, keep the deterministic core tested and pure,
and keep decisions written down.** Everything below serves those three.

---

## 1. Git workflow

- **`main` is always green** — it typechecks and all tests pass. Never commit broken code to `main`. **[now]**
- **Branch per change.** No direct commits to `main`. Name by intent: **[now]**
  - `feat/…` new capability · `fix/…` bug · `docs/…` docs only · `chore/…` tooling/deps · `refactor/…` no behavior change
- **Small, focused commits** with an imperative subject ("Add receipt price derivation"). Explain the
  *why* in the body when it isn't obvious. End commit messages with the configured `Co-Authored-By` trailer. **[now]**
- **Self-review the diff before merging** to `main` (even solo). A branch + a read-through of your own
  diff catches more than you'd think, and makes `/code-review` usable on a tight, reviewable change. **[now]**
- **Merge to `main` only when `npm run check` is green.** **[now]**
- When a branch changes a decision recorded in `ARCHITECTURE.md`, **update the decision log in the same branch.** **[now]**
- **CI** (run `check` on push) once there's a Git remote. **[later]**

> First step for the repo: make the initial commit of the scaffold on `main`, then do all further
> work on branches. Branching only becomes meaningful once `main` has a base commit.

## 2. Testing — TDD where it pays, evals where it doesn't

We split the codebase into two halves and test them differently. Don't apply one strategy to both.

**Deterministic core — test-first (true TDD). [now]**
Pure logic with no I/O: name normalization, unit conversion, price derivation, list aggregation,
matching rules. These are cheap to test, and a quiet bug here silently corrupts the ingredient
spine (the thing the whole app depends on). **Write the failing test first, then the code.**
- Runner: Node's built-in `node:test` + `node:assert/strict` — zero dependencies.
- Tests live next to the code: `foo.ts` → `foo.test.ts`.
- This already paid off: the first `normalizeName` test caught a real accent-folding bug
  (`"jalapeño"` was splitting into two words) before it could pollute matching.

**Side-effectful adapters — behavior tests against a temp store. [now]**
The db repository gets tested against a throwaway SQLite file (or `:memory:`), asserting behavior:
alias reuse doesn't duplicate ingredients, price observations accrue, a failed line rolls back.

**The LLM parser — an eval, not a unit test. [built — receipts]**
`LLMReceiptParser` output isn't deterministic, so it can't be unit-asserted. It's an eval instead:
- **Fixtures** live in `fixtures/receipts/` as `<name>.<img>` + `<name>.expected.json` (hand-checked)
  pairs. Real receipts are private, so **both images and expected JSON are gitignored** (`fixtures/README.md`).
- **`npm run eval`** runs the real parser over them; **`npm run eval:mock`** runs the same harness with
  the canned parser (no key). It reports per-fixture and aggregate **recall** (real lines captured),
  **precision** (lines not invented), and **field accuracy** (right values on matched lines), prints the
  specific gaps, and exits non-zero below `EATMODEL_EVAL_MIN` (default 0.9).
- **Same pure/IO split as the rest of the codebase:** scoring is pure + TDD'd in `shared/eval.ts`
  (line-level vs field-level misses kept distinct); the harness `cli/eval-receipts.ts` owns the parser
  call and is plumbing-tested with the mock over a temp dir — so the suite stays green with no fixtures present.
- Run it whenever the prompt or model changes. Pin the model id; we keep `raw_json` + the original
  images, so any regression is reproducible. *(Recipe eval is the symmetric follow-up — not yet built.)*

**Gates. [now]** `npm test` runs the suite; `npm run check` = typecheck + tests. Green before merge.
Coverage thresholds / mutation testing: **[later]**.

## 3. Architecture & code

- **Dependencies point inward.** The pure core (`shared/`) imports nothing with I/O; the adapters
  (`parser/`, `db/`, `cli/`) depend on the core, never the reverse. **[now]**
- **Interface at every swap point we've named** — `ReceiptParser` today, `Optimizer` and the
  repository later. Program to the interface, and keep a `Mock…` implementation for tests + offline runs. **[now]**
- **Push logic out of side-effecting code into pure functions.** Example: price-per-unit math lives in
  `shared/pricing.ts` (pure, tested), not inline in the db write path. Do this by default. **[now]**
- **Validate at boundaries, trust within.** zod-validate external/untrusted data (parser output now,
  API input later); after that, rely on the types. **[now]**
- **No silent guessing or truncation.** When data is missing (a price absent, a unit that can't
  convert), record the gap — don't fabricate a value. Surface it for review instead. **[now]**

## 4. Formatting & linting

- **Recommended: Biome** (one fast binary: format + lint, near-zero config) over ESLint + Prettier for
  a project this size. **Decision pending** — adopt before the code grows much. **[now]**
- Whatever we pick runs inside `npm run check`, and ideally a lightweight pre-commit hook (e.g. lefthook). **[now/later]**

## 5. Secrets & data hygiene

- **Never commit secrets.** `.env` is gitignored; `.env.example` documents the required keys. **[now]**
- **Receipts and the price db are private and revealing.** Keep `data/` and the receipt images local;
  don't sync the database into anything shared; back it up separately. **[now]**
- **Keep original receipt images** (we move them to `processed/`, never delete) so parses can be
  re-run as the prompt improves. **[now]**
- **Cost awareness.** The LLM parser costs a few cents per receipt — fine at household volume. If we
  ever batch-reprocess, log token usage so cost is visible. **[later]**

## 6. Decisions

- **Record non-obvious decisions, with rationale, in `ARCHITECTURE.md` §11 decision log, dated.**
  Folklore rots; the log is the source of truth for *why* things are the way they are. **[now]**

## 7. Explicitly deferred (don't build yet)

Monorepo tooling · Drizzle/migrations · multi-user auth · CI · coverage gates · release/versioning ·
pre-commit hooks. Each has a trigger noted in `ARCHITECTURE.md`; adopt when the trigger fires, not before.
