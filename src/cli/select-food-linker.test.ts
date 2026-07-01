import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFoodLinker } from "./select-food-linker";
import { MockFoodLinker } from "../parser/food-linker-mock";

test("uses the mock food linker only when explicitly requested", () => {
  assert.equal(selectFoodLinker({ EATMODEL_FOOD_LINKER: "mock" }).name, "mock");
});

test("uses the LLM food linker when a key is present (llm is the default)", () => {
  assert.equal(
    selectFoodLinker({ EATMODEL_FOOD_LINKER: "llm", ANTHROPIC_API_KEY: "sk-test" }).name,
    "llm",
  );
  assert.equal(selectFoodLinker({ ANTHROPIC_API_KEY: "sk-test" }).name, "llm");
});

test("fails loudly instead of silently falling back to mock when the key is missing", () => {
  assert.throws(() => selectFoodLinker({}), /ANTHROPIC_API_KEY/);
});

test("rejects an unknown food linker choice", () => {
  assert.throws(() => selectFoodLinker({ EATMODEL_FOOD_LINKER: "bogus", ANTHROPIC_API_KEY: "x" }), /unknown/);
});

test("mock linker proposes the top candidate, or abstains when the shortlist is empty", async () => {
  const linker = new MockFoodLinker();
  const picked = await linker.choose({
    ingredientName: "garlic",
    candidates: [
      { id: 411, description: "Garlic, raw" },
      { id: 5, description: "Garlic bread" },
    ],
  });
  assert.equal(picked.foodId, 411);

  const abstained = await linker.choose({ ingredientName: "saffron", candidates: [] });
  assert.equal(abstained.foodId, null);
});
