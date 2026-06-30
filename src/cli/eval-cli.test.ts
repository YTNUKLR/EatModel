import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReceiptEval } from "./eval-receipts";
import { MockReceiptParser } from "../parser/mock";
import type { ReceiptParseResult } from "../shared/types";

// The exact canned output MockReceiptParser returns for any image.
const MOCK_OUTPUT: ReceiptParseResult = {
  store: "Demo Market",
  purchasedAt: "2026-06-28",
  total: 12.02,
  currency: "USD",
  lines: [
    { rawText: "GV CHKN THGH 2.49", description: "Chicken thighs, boneless skinless", quantity: 1.5, unit: "lb", unitPrice: 2.49, lineTotal: 3.74 },
    { rawText: "ORG SPINACH 3.99", description: "Organic baby spinach", quantity: 1, unit: "each", unitPrice: 3.99, lineTotal: 3.99 },
    { rawText: "BROWN RICE 2LB 4.29", description: "Brown rice", quantity: 1, unit: "bag", unitPrice: 4.29, lineTotal: 4.29 },
  ],
};

function fixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eatmodel-eval-"));
}

function writeFixture(dir: string, name: string, expected: ReceiptParseResult): void {
  fs.writeFileSync(path.join(dir, `${name}.expected.json`), JSON.stringify(expected));
  fs.writeFileSync(path.join(dir, `${name}.jpg`), "placeholder"); // mock ignores image content
}

test("a fixture matching the parser output scores a clean pass", async () => {
  const dir = fixtureDir();
  writeFixture(dir, "match", MOCK_OUTPUT);

  const run = await runReceiptEval({
    fixturesDir: dir,
    parser: new MockReceiptParser(),
    threshold: 1,
    log: () => {},
  });

  assert.equal(run.passed, true);
  assert.equal(run.summary.lineRecall, 1);
  assert.equal(run.summary.linePrecision, 1);
  assert.equal(run.summary.fieldAccuracy, 1);
  assert.equal(run.summary.missedLines, 0);
  assert.equal(run.summary.hallucinatedLines, 0);
});

test("a drifted fixture surfaces the field miss and the missed line, and fails the gate", async () => {
  const dir = fixtureDir();
  // Expect a price the parser won't produce, plus a line it never emits.
  const drifted: ReceiptParseResult = {
    ...MOCK_OUTPUT,
    lines: [
      { ...MOCK_OUTPUT.lines[0]!, unitPrice: 2.6 }, // > 0.005 off → field miss
      MOCK_OUTPUT.lines[1]!,
      MOCK_OUTPUT.lines[2]!,
      { rawText: "DOZEN EGGS 4.00", description: "Eggs", quantity: 1, unit: "dozen", unitPrice: 4.0, lineTotal: 4.0 },
    ],
  };
  writeFixture(dir, "drift", drifted);

  const run = await runReceiptEval({
    fixturesDir: dir,
    parser: new MockReceiptParser(),
    threshold: 1,
    log: () => {},
  });

  assert.equal(run.passed, false);
  assert.equal(run.summary.missedLines, 1); // the eggs line the parser didn't return
  assert.equal(run.summary.matchedLines, 3);
  assert.ok(run.summary.fieldAccuracy < 1); // the chicken price drift
  const chicken = run.perFixture[0]?.result.lines.find((l) => l.rawText.includes("CHKN"));
  assert.equal(chicken?.fieldChecks.find((c) => c.field === "unitPrice")?.ok, false);
});

test("an empty fixtures dir fails loudly instead of reporting a vacuous pass", async () => {
  const dir = fixtureDir();
  await assert.rejects(
    () => runReceiptEval({ fixturesDir: dir, parser: new MockReceiptParser(), threshold: 0.9, log: () => {} }),
    /no fixtures/,
  );
});
