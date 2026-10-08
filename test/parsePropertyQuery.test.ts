import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePropertyQuery } from "../src/skills/propertySearch/parsePropertyQuery.js";
import { buildPropertySql } from "../src/skills/propertySearch/searchProperties.js";

test("handbook example query", () => {
  assert.deepEqual(parsePropertyQuery("Show me 3-bedroom condos in Irvine under $1.5M with a pool."), {
    city: "Irvine",
    maxPrice: 1_500_000,
    beds: 3,
    baths: null,
    sqft: null,
    type: "Condominium",
    pool: "True",
    hasView: null,
  });
});

test("multi-word city, k prices, baths, sqft with commas, view", () => {
  const f = parsePropertyQuery("single family homes in Newport Beach under 900k, 2.5 baths, 1,800 sq ft with a view");
  assert.equal(f.city, "Newport Beach");
  assert.equal(f.maxPrice, 900_000);
  assert.equal(f.baths, 2.5);
  assert.equal(f.sqft, 1800);
  assert.equal(f.type, "SingleFamilyResidence");
  assert.equal(f.hasView, "True");
});

test("query with no filters", () => {
  const f = parsePropertyQuery("what's on the market?");
  assert.ok(Object.values(f).every((v) => v === null));
});

test("SQL uses parameters, not inlined values", () => {
  const { sql, params } = buildPropertySql(parsePropertyQuery("condos in Irvine under $1M"));
  assert.ok(!sql.includes("Irvine"));
  assert.deepEqual(params, ["Irvine", 1_000_000, "Condominium"]);
});
