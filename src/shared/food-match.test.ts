import { test } from "node:test";
import assert from "node:assert/strict";
import { rankFoodCandidates, type FoodLite } from "./food-match";

const CATALOG: FoodLite[] = [
  { id: 1, description: "Chicken, broilers or fryers, dark meat, meat and skin, raw" },
  { id: 2, description: "Chicken, broilers or fryers, breast, meat only, cooked, roasted" },
  { id: 3, description: "Chicken nuggets, restaurant" },
  { id: 4, description: "Garlic, raw" },
  { id: 5, description: "Garlic bread" },
  { id: 6, description: "Olive oil" },
  { id: 7, description: "Oil, olive, salad or cooking" },
  { id: 8, description: "Spinach, raw" },
  { id: 9, description: "Sauce, pasta, spaghetti/marinara, ready-to-serve" },
  { id: 10, description: "Onions, raw" },
  { id: 11, description: "Soup, onion, dry, mix" },
];

test("returns the matching food in the shortlist, best first", () => {
  const out = rankFoodCandidates("garlic", CATALOG);
  assert.equal(out[0]!.id, 4); // "Garlic, raw" over "Garlic bread"
  assert.ok(out.some((c) => c.id === 5)); // garlic bread still a candidate
});

test("prefers the raw form over cooked/restaurant for the same word", () => {
  const out = rankFoodCandidates("chicken", CATALOG);
  const ids = out.map((c) => c.id);
  assert.equal(ids[0], 1); // dark meat raw ranks above cooked (2) and restaurant nuggets (3)
  assert.ok(ids.indexOf(1) < ids.indexOf(2));
  assert.ok(ids.indexOf(1) < ids.indexOf(3));
});

test("matches multi-word ingredients on either token order", () => {
  const out = rankFoodCandidates("olive oil", CATALOG);
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes(6) && ids.includes(7)); // "Olive oil" and "Oil, olive, ..."
  assert.equal(ids[0], 6); // exact/tighter match ranks first
});

test("singular ingredient matches plural food, and beats a prepared mix", () => {
  const out = rankFoodCandidates("onion", CATALOG);
  const ids = out.map((c) => c.id);
  assert.ok(ids.includes(10)); // "Onions, raw" is reachable despite the plural
  assert.equal(ids[0], 10); // and outranks "Soup, onion, dry, mix"
});

test("returns empty when nothing overlaps (honest no-candidate)", () => {
  assert.deepEqual(rankFoodCandidates("saffron", CATALOG), []);
});

test("ignores stopwords so connectives don't create false matches", () => {
  // "and" is a stopword; an ingredient that is only stopwords yields nothing.
  assert.deepEqual(rankFoodCandidates("and of the", CATALOG), []);
});

test("respects the limit", () => {
  const out = rankFoodCandidates("chicken", CATALOG, 2);
  assert.equal(out.length, 2);
});
