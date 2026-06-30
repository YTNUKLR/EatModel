/**
 * Pure scoring for the parser eval (CONVENTIONS §2). The LLM parsers are
 * non-deterministic, so they can't be unit-asserted; instead we score a parse
 * against a hand-checked expected extraction and report the diff. This module
 * is the deterministic, testable half — the I/O harness (`cli/eval-*`) runs the
 * real parser over fixture images and feeds the results here.
 *
 * Two failure modes matter and are kept distinct:
 *   - line-level: a real line was *missed*, or a line was *hallucinated*
 *     (these move recall / precision);
 *   - field-level: a matched line carried a wrong value, e.g. a price slip
 *     (this moves field accuracy).
 * Conflating them hides regressions, so they're scored separately.
 */
import { normalizeName } from "./units";
import type { ReceiptParseResult, ParsedLineItem } from "./types";

const MONEY_EPSILON = 0.005; // within half a cent counts as equal
const QTY_EPSILON = 1e-6;

export interface FieldCheck {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
  ok: boolean;
}

export interface LineDiff {
  rawText: string;
  status: "matched" | "missed" | "hallucinated";
  /** Per-field checks, populated only for matched lines. */
  fieldChecks: FieldCheck[];
}

export interface ReceiptEvalResult {
  header: FieldCheck[];
  lines: LineDiff[];
  expectedLines: number;
  actualLines: number;
  matchedLines: number;
  missedLines: number;
  hallucinatedLines: number;
  fieldChecksTotal: number;
  fieldChecksOk: number;
  /** matched / expected — did we capture the real lines? */
  lineRecall: number;
  /** matched / actual — did we avoid inventing lines? */
  linePrecision: number;
  /** ok field checks / total field checks across matched lines + header. */
  fieldAccuracy: number;
}

export interface ReceiptEvalSummary {
  fixtures: number;
  expectedLines: number;
  actualLines: number;
  matchedLines: number;
  missedLines: number;
  hallucinatedLines: number;
  fieldChecksTotal: number;
  fieldChecksOk: number;
  lineRecall: number;
  linePrecision: number;
  fieldAccuracy: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function numbersEqual(a: number | null, b: number | null, epsilon: number): boolean {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= epsilon;
}

function stringsEqual(a: string | null, b: string | null): boolean {
  const na = a == null ? "" : normalizeName(a);
  const nb = b == null ? "" : normalizeName(b);
  return na === nb;
}

function check(
  field: string,
  expected: string | number | null,
  actual: string | number | null,
  ok: boolean,
): FieldCheck {
  return { field, expected, actual, ok };
}

/** A stable key for matching expected ↔ actual lines despite transcription noise. */
function lineKey(line: ParsedLineItem): string {
  return normalizeName(line.rawText);
}

function lineFieldChecks(expected: ParsedLineItem, actual: ParsedLineItem): FieldCheck[] {
  return [
    check("description", expected.description, actual.description, stringsEqual(expected.description, actual.description)),
    check("quantity", expected.quantity, actual.quantity, numbersEqual(expected.quantity, actual.quantity, QTY_EPSILON)),
    check("unit", expected.unit, actual.unit, stringsEqual(expected.unit, actual.unit)),
    check("unitPrice", expected.unitPrice, actual.unitPrice, numbersEqual(expected.unitPrice, actual.unitPrice, MONEY_EPSILON)),
    check("lineTotal", expected.lineTotal, actual.lineTotal, numbersEqual(expected.lineTotal, actual.lineTotal, MONEY_EPSILON)),
  ];
}

/**
 * Score one parsed receipt against its hand-checked expected extraction. Lines
 * are matched one-to-one on normalized rawText (falling back to normalized
 * description) so transcription noise doesn't read as a missed line.
 */
export function scoreReceiptParse(
  expected: ReceiptParseResult,
  actual: ReceiptParseResult,
): ReceiptEvalResult {
  const header: FieldCheck[] = [
    check("store", expected.store, actual.store, stringsEqual(expected.store, actual.store)),
    check("purchasedAt", expected.purchasedAt, actual.purchasedAt, (expected.purchasedAt ?? null) === (actual.purchasedAt ?? null)),
    check("total", expected.total, actual.total, numbersEqual(expected.total, actual.total, MONEY_EPSILON)),
    check("currency", expected.currency, actual.currency, stringsEqual(expected.currency, actual.currency)),
  ];

  const unconsumed = actual.lines.map((line) => ({ line, taken: false }));
  const lines: LineDiff[] = [];
  let matchedLines = 0;
  const matchedFieldChecks: FieldCheck[] = [];

  for (const exp of expected.lines) {
    const byRaw = unconsumed.find((c) => !c.taken && lineKey(c.line) === lineKey(exp));
    const slot =
      byRaw ?? unconsumed.find((c) => !c.taken && stringsEqual(c.line.description, exp.description));
    if (slot) {
      slot.taken = true;
      matchedLines++;
      const fieldChecks = lineFieldChecks(exp, slot.line);
      matchedFieldChecks.push(...fieldChecks);
      lines.push({ rawText: exp.rawText, status: "matched", fieldChecks });
    } else {
      lines.push({ rawText: exp.rawText, status: "missed", fieldChecks: [] });
    }
  }

  for (const c of unconsumed) {
    if (!c.taken) lines.push({ rawText: c.line.rawText, status: "hallucinated", fieldChecks: [] });
  }

  const missedLines = expected.lines.length - matchedLines;
  const hallucinatedLines = actual.lines.length - matchedLines;

  const allFieldChecks = [...header, ...matchedFieldChecks];
  const fieldChecksOk = allFieldChecks.filter((c) => c.ok).length;

  return {
    header,
    lines,
    expectedLines: expected.lines.length,
    actualLines: actual.lines.length,
    matchedLines,
    missedLines,
    hallucinatedLines,
    fieldChecksTotal: allFieldChecks.length,
    fieldChecksOk,
    lineRecall: ratio(matchedLines, expected.lines.length),
    linePrecision: ratio(matchedLines, actual.lines.length),
    fieldAccuracy: ratio(fieldChecksOk, allFieldChecks.length),
  };
}

/** Aggregate per-fixture results into one regression-trackable scoreboard. */
export function summarizeReceiptEvals(results: ReceiptEvalResult[]): ReceiptEvalSummary {
  const sum = (pick: (r: ReceiptEvalResult) => number) => results.reduce((a, r) => a + pick(r), 0);

  const expectedLines = sum((r) => r.expectedLines);
  const actualLines = sum((r) => r.actualLines);
  const matchedLines = sum((r) => r.matchedLines);
  const fieldChecksTotal = sum((r) => r.fieldChecksTotal);
  const fieldChecksOk = sum((r) => r.fieldChecksOk);

  return {
    fixtures: results.length,
    expectedLines,
    actualLines,
    matchedLines,
    missedLines: sum((r) => r.missedLines),
    hallucinatedLines: sum((r) => r.hallucinatedLines),
    fieldChecksTotal,
    fieldChecksOk,
    lineRecall: ratio(matchedLines, expectedLines),
    linePrecision: ratio(matchedLines, actualLines),
    fieldAccuracy: ratio(fieldChecksOk, fieldChecksTotal),
  };
}
