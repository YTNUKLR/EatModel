import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Formats Claude vision can't read directly and that we convert first. */
const CONVERTIBLE = new Set([".heic", ".heif"]);

/** Pure: does this filename need conversion before the parser can read it? */
export function needsConversion(filename: string): boolean {
  return CONVERTIBLE.has(path.extname(filename).toLowerCase());
}

export interface PreparedImage {
  /** A path the ReceiptParser can read (JPEG/PNG/…). */
  path: string;
  /** True if a temporary converted copy was produced. */
  converted: boolean;
  /** Remove any temp artifacts. Always safe to call. */
  cleanup(): void;
}

/**
 * Ensure an image is in a format Claude vision accepts. HEIC/HEIF (the default
 * iPhone format) is converted to a temporary JPEG via macOS `sips`; the original
 * file is left untouched so it stays the source of truth and can be re-parsed
 * later. Any already-supported format passes straight through.
 *
 * Side-effecting (shells out, writes a temp file) — the pure decision lives in
 * `needsConversion`, which is unit-tested.
 */
export function prepareImage(imagePath: string): PreparedImage {
  if (!needsConversion(imagePath)) {
    return { path: imagePath, converted: false, cleanup() {} };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eatmodel-"));
  const out = path.join(tmpDir, `${path.basename(imagePath, path.extname(imagePath))}.jpg`);
  try {
    execFileSync("sips", ["-s", "format", "jpeg", imagePath, "--out", out], { stdio: "ignore" });
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `could not convert HEIC/HEIF via sips (macOS only) — convert to JPEG manually, ` +
        `or set the iPhone camera to "Most Compatible". (${(err as Error).message})`,
    );
  }

  return {
    path: out,
    converted: true,
    cleanup() {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
