import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { selectParser } from "./select-parser";
import { prepareImage } from "./prepare-image";
import { ReceiptParseResult } from "../shared/types";
import {
  scoreReceiptParse,
  summarizeReceiptEvals,
  type ReceiptEvalResult,
  type ReceiptEvalSummary,
} from "../shared/eval";
import type { ReceiptParser } from "../parser/types";

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"];

export interface ReceiptEvalRun {
  summary: ReceiptEvalSummary;
  perFixture: { name: string; result: ReceiptEvalResult }[];
  /** False if any tracked metric fell below the threshold — drives the exit code. */
  passed: boolean;
}

export interface RunReceiptEvalOptions {
  fixturesDir: string;
  parser: ReceiptParser;
  /** Minimum acceptable recall / precision / field accuracy (0–1). */
  threshold: number;
  log?: (line: string) => void;
}

/** Find the image that pairs with a `<name>.expected.json` fixture. */
function findImage(dir: string, base: string): string | null {
  for (const ext of IMAGE_EXTS) {
    const candidate = path.join(dir, base + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Run the parser over every fixture in `fixturesDir` and score each against its
 * hand-checked `*.expected.json`. Pure scoring lives in `shared/eval`; this
 * function owns the I/O (reading fixtures, invoking the parser) and the report.
 * Returns the run so callers (and tests) can assert on it without parsing stdout.
 */
export async function runReceiptEval(opts: RunReceiptEvalOptions): Promise<ReceiptEvalRun> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dir = opts.fixturesDir;

  if (!fs.existsSync(dir)) {
    throw new Error(`fixtures dir not found: ${dir} — create it and add <name>.jpg + <name>.expected.json pairs`);
  }

  const expectedFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".expected.json"))
    .sort();

  if (expectedFiles.length === 0) {
    throw new Error(
      `no fixtures in ${dir}/ — add a hand-checked <name>.expected.json next to each <name>.jpg ` +
        `(see fixtures/README.md). Real receipts are private and gitignored.`,
    );
  }

  const perFixture: { name: string; result: ReceiptEvalResult }[] = [];

  for (const file of expectedFiles) {
    const base = file.slice(0, -".expected.json".length);
    const image = findImage(dir, base);
    if (image == null) {
      throw new Error(`fixture ${file} has no sibling image (${base}.{jpg,png,…}) in ${dir}/`);
    }

    const expected = ReceiptParseResult.parse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));

    const prepared = prepareImage(image);
    let actual: ReceiptParseResult;
    try {
      actual = await opts.parser.parse(prepared.path);
    } finally {
      prepared.cleanup();
    }

    const result = scoreReceiptParse(expected, actual);
    perFixture.push({ name: base, result });

    const flags: string[] = [];
    if (result.missedLines > 0) flags.push(`${result.missedLines} missed`);
    if (result.hallucinatedLines > 0) flags.push(`${result.hallucinatedLines} hallucinated`);
    const fieldMiss = result.fieldChecksTotal - result.fieldChecksOk;
    if (fieldMiss > 0) flags.push(`${fieldMiss} field miss`);
    const tag = flags.length === 0 ? "clean" : flags.join(", ");
    log(
      `  ${base}: recall ${pct(result.lineRecall)} · precision ${pct(result.linePrecision)} · ` +
        `fields ${pct(result.fieldAccuracy)}  (${tag})`,
    );
    // Show the specific gaps so a regression is actionable, not just a number.
    for (const line of result.lines) {
      if (line.status === "missed") log(`      − missed:       ${line.rawText}`);
      if (line.status === "hallucinated") log(`      + hallucinated: ${line.rawText}`);
      for (const c of line.fieldChecks.filter((c) => !c.ok)) {
        log(`      ≠ ${line.rawText} · ${c.field}: expected ${c.expected} got ${c.actual}`);
      }
    }
    for (const c of result.header.filter((c) => !c.ok)) {
      log(`      ≠ header · ${c.field}: expected ${c.expected} got ${c.actual}`);
    }
  }

  const summary = summarizeReceiptEvals(perFixture.map((p) => p.result));
  const passed =
    summary.lineRecall >= opts.threshold &&
    summary.linePrecision >= opts.threshold &&
    summary.fieldAccuracy >= opts.threshold;

  log("");
  log(
    `parser "${opts.parser.name}" over ${summary.fixtures} fixture(s): ` +
      `recall ${pct(summary.lineRecall)} · precision ${pct(summary.linePrecision)} · ` +
      `field accuracy ${pct(summary.fieldAccuracy)}`,
  );
  log(
    `  lines: ${summary.matchedLines}/${summary.expectedLines} matched, ` +
      `${summary.missedLines} missed, ${summary.hallucinatedLines} hallucinated`,
  );
  log(passed ? `  PASS (threshold ${pct(opts.threshold)})` : `  FAIL — below threshold ${pct(opts.threshold)}`);

  return { summary, perFixture, passed };
}

function isMain(): boolean {
  return process.argv[1] != null && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
}

if (isMain()) {
  if (fs.existsSync(".env")) process.loadEnvFile(".env");
  const env = process.env;
  const fixturesDir = env.EATMODEL_EVAL_FIXTURES ?? "fixtures/receipts";
  const threshold = env.EATMODEL_EVAL_MIN != null ? Number(env.EATMODEL_EVAL_MIN) : 0.9;

  runReceiptEval({ fixturesDir, parser: selectParser(env), threshold })
    .then((run) => {
      if (!run.passed) process.exitCode = 1;
    })
    .catch((err) => {
      console.error((err as Error).message);
      process.exitCode = 1;
    });
}
