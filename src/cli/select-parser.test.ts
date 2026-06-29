import { test } from "node:test";
import assert from "node:assert/strict";
import { selectParser } from "./select-parser";

test("uses the mock parser only when explicitly requested", () => {
  assert.equal(selectParser({ EATMODEL_PARSER: "mock" }).name, "mock");
});

test("uses the LLM parser when a key is present (llm is the default)", () => {
  assert.equal(selectParser({ EATMODEL_PARSER: "llm", ANTHROPIC_API_KEY: "sk-test" }).name, "llm");
  assert.equal(selectParser({ ANTHROPIC_API_KEY: "sk-test" }).name, "llm");
});

test("fails loudly instead of silently falling back to mock when the key is missing", () => {
  assert.throws(() => selectParser({}), /ANTHROPIC_API_KEY/);
  assert.throws(() => selectParser({ EATMODEL_PARSER: "llm" }), /ANTHROPIC_API_KEY/);
});

test("rejects an unknown parser choice", () => {
  assert.throws(() => selectParser({ EATMODEL_PARSER: "bogus", ANTHROPIC_API_KEY: "x" }), /unknown/);
});
