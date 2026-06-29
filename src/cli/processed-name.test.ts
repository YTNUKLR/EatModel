import { test } from "node:test";
import assert from "node:assert/strict";
import { processedName } from "./processed-name";

test("prefixes with a short content hash so same-named images don't collide", () => {
  const a = processedName("aaaaaaaaaaaa1111", "IMG_0001.jpg");
  const b = processedName("bbbbbbbbbbbb2222", "IMG_0001.jpg");
  assert.notEqual(a, b); // different content → different processed name
  assert.equal(a, "aaaaaaaaaaaa-IMG_0001.jpg");
});

test("identical content yields a stable name (idempotent re-runs)", () => {
  assert.equal(
    processedName("deadbeefcafe0000", "receipt.png"),
    processedName("deadbeefcafe0000", "receipt.png"),
  );
});
