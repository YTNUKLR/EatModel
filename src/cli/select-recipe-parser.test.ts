import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRecipeParser } from "./select-recipe-parser";

test("uses the mock recipe parser only when explicitly requested", () => {
  assert.equal(selectRecipeParser({ EATMODEL_RECIPE_PARSER: "mock" }).name, "mock");
});

test("uses the LLM recipe parser when a key is present (llm is the default)", () => {
  assert.equal(
    selectRecipeParser({ EATMODEL_RECIPE_PARSER: "llm", ANTHROPIC_API_KEY: "sk-test" }).name,
    "llm",
  );
  assert.equal(selectRecipeParser({ ANTHROPIC_API_KEY: "sk-test" }).name, "llm");
});

test("fails loudly instead of silently falling back to mock when the key is missing", () => {
  assert.throws(() => selectRecipeParser({}), /ANTHROPIC_API_KEY/);
  assert.throws(() => selectRecipeParser({ EATMODEL_RECIPE_PARSER: "llm" }), /ANTHROPIC_API_KEY/);
});

test("rejects an unknown recipe parser choice", () => {
  assert.throws(
    () => selectRecipeParser({ EATMODEL_RECIPE_PARSER: "bogus", ANTHROPIC_API_KEY: "x" }),
    /unknown/,
  );
});
