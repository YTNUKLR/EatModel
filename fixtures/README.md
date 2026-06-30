# Eval fixtures

Hand-checked ground truth for the **parser eval** (`npm run eval`). The LLM
parsers are non-deterministic, so they can't be unit-asserted; instead we score
a parse against a known-good extraction and watch recall / precision / field
accuracy when the prompt or model changes (`CONVENTIONS.md §2`,
`ARCHITECTURE.md §11`).

## Privacy

Real receipts and recipes are private. **Both the images and the
`*.expected.json` files are gitignored** — they never get committed. This folder
keeps only the structure + this README. The harness and its scoring logic are
unit-tested with synthetic data (`src/cli/eval-cli.test.ts`,
`src/shared/eval.test.ts`), so the test suite stays green with no fixtures
present.

## Layout

```
fixtures/receipts/
  IMG_0001.jpg            # the original receipt photo (any of jpg/jpeg/png/heic/…)
  IMG_0001.expected.json  # hand-checked extraction, validated against ReceiptParseResult
```

Pairing is by basename: `<name>.expected.json` is scored against `<name>.<img>`.

## Adding a fixture

1. Drop a receipt image into `fixtures/receipts/`.
2. Run `npm run eval` once and copy the parser's `raw_json` (or hand-write it)
   into `<name>.expected.json`, then **correct every field by eye** — this file
   is the ground truth, so it must be right, not just plausible.
3. Re-run `npm run eval`; the fixture should score clean. Commit nothing (it's
   gitignored) — the fixtures live only on your machine.

## Running

| Command | What it does |
|---|---|
| `npm run eval` | Score the **real** parser (needs `ANTHROPIC_API_KEY`) over `fixtures/receipts/`. Exits non-zero below threshold. |
| `npm run eval:mock` | Same harness with the canned mock parser — exercises the plumbing without an API key. |

Tunables (env): `EATMODEL_EVAL_FIXTURES` (dir, default `fixtures/receipts`),
`EATMODEL_EVAL_MIN` (pass threshold 0–1, default `0.9`).
