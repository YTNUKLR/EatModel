import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreReceiptParse, summarizeReceiptEvals } from "./eval";
import type { ReceiptParseResult } from "./types";

function receipt(overrides: Partial<ReceiptParseResult> = {}): ReceiptParseResult {
  return {
    store: "Demo Market",
    purchasedAt: "2026-06-28",
    total: 7.73,
    currency: "USD",
    lines: [
      {
        rawText: "GV CHKN THGH 2.49",
        description: "Chicken thighs, boneless skinless",
        quantity: 1.5,
        unit: "lb",
        unitPrice: 2.49,
        lineTotal: 3.74,
      },
      {
        rawText: "ORG SPINACH 3.99",
        description: "Organic baby spinach",
        quantity: 1,
        unit: "each",
        unitPrice: 3.99,
        lineTotal: 3.99,
      },
    ],
    ...overrides,
  };
}

test("a perfect parse scores full recall, precision, and field accuracy", () => {
  const r = scoreReceiptParse(receipt(), receipt());
  assert.equal(r.missedLines, 0);
  assert.equal(r.hallucinatedLines, 0);
  assert.equal(r.matchedLines, 2);
  assert.equal(r.lineRecall, 1);
  assert.equal(r.linePrecision, 1);
  assert.equal(r.fieldAccuracy, 1);
  assert.ok(r.header.every((c) => c.ok));
});

test("matching tolerates casing/spacing/punctuation noise in the line text", () => {
  const actual = receipt();
  actual.lines[0]!.rawText = "  gv  chkn-thgh   2.49 ";
  const r = scoreReceiptParse(receipt(), actual);
  assert.equal(r.matchedLines, 2);
  assert.equal(r.missedLines, 0);
});

test("a line the model dropped is counted as missed (recall falls)", () => {
  const actual = receipt();
  actual.lines = [actual.lines[0]!]; // dropped the spinach line
  const r = scoreReceiptParse(receipt(), actual);
  assert.equal(r.missedLines, 1);
  assert.equal(r.matchedLines, 1);
  assert.equal(r.lineRecall, 0.5);
  assert.equal(r.linePrecision, 1);
  assert.ok(r.lines.some((l) => l.status === "missed"));
});

test("a line the model invented is counted as hallucinated (precision falls)", () => {
  const actual = receipt();
  actual.lines.push({
    rawText: "MYSTERY ITEM 9.99",
    description: "Mystery item",
    quantity: 1,
    unit: "each",
    unitPrice: 9.99,
    lineTotal: 9.99,
  });
  const r = scoreReceiptParse(receipt(), actual);
  assert.equal(r.hallucinatedLines, 1);
  assert.equal(r.matchedLines, 2);
  assert.equal(r.linePrecision, 2 / 3);
  assert.equal(r.lineRecall, 1);
  assert.ok(r.lines.some((l) => l.status === "hallucinated"));
});

test("a wrong price on a matched line is a field miss, not a line miss", () => {
  const actual = receipt();
  actual.lines[0]!.unitPrice = 24.9; // decimal slip
  const r = scoreReceiptParse(receipt(), actual);
  assert.equal(r.matchedLines, 2);
  assert.equal(r.missedLines, 0);
  assert.ok(r.fieldAccuracy < 1);
  const line = r.lines.find((l) => l.rawText.includes("CHKN"));
  const priceCheck = line?.fieldChecks.find((c) => c.field === "unitPrice");
  assert.equal(priceCheck?.ok, false);
});

test("money compares within a cent epsilon; header total mismatch is flagged", () => {
  const within = scoreReceiptParse(receipt(), receipt({ total: 7.7300001 }));
  assert.ok(within.header.find((c) => c.field === "total")?.ok);

  const off = scoreReceiptParse(receipt(), receipt({ total: 8.0 }));
  assert.equal(off.header.find((c) => c.field === "total")?.ok, false);
});

test("null on both sides is a match, not a mismatch", () => {
  const expected = receipt({ purchasedAt: null, total: null });
  const actual = receipt({ purchasedAt: null, total: null });
  const r = scoreReceiptParse(expected, actual);
  assert.ok(r.header.find((c) => c.field === "purchasedAt")?.ok);
  assert.ok(r.header.find((c) => c.field === "total")?.ok);
});

test("summarize aggregates recall/precision across fixtures", () => {
  const perfect = scoreReceiptParse(receipt(), receipt());
  const droppedActual = receipt();
  droppedActual.lines = [droppedActual.lines[0]!];
  const missedOne = scoreReceiptParse(receipt(), droppedActual);

  const summary = summarizeReceiptEvals([perfect, missedOne]);
  assert.equal(summary.fixtures, 2);
  assert.equal(summary.expectedLines, 4);
  assert.equal(summary.matchedLines, 3);
  assert.equal(summary.missedLines, 1);
  assert.equal(summary.lineRecall, 0.75);
});
