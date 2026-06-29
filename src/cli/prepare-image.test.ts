import { test } from "node:test";
import assert from "node:assert/strict";
import { needsConversion } from "./prepare-image";

test("HEIC/HEIF need conversion (case-insensitive)", () => {
  assert.equal(needsConversion("IMG_1234.HEIC"), true);
  assert.equal(needsConversion("photo.heif"), true);
});

test("formats Claude vision accepts do not need conversion", () => {
  for (const f of ["a.jpg", "a.jpeg", "a.png", "a.webp", "a.gif"]) {
    assert.equal(needsConversion(f), false);
  }
});
