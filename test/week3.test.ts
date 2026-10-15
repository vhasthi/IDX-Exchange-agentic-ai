import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "mysql2/promise";
import { parsePropertyQuery, type PropertyFilters } from "../src/skills/propertySearch/parsePropertyQuery.js";
import { buildPropertySql, searchProperties, type ListingRow } from "../src/skills/propertySearch/searchProperties.js";
import { buildSoldCompsSql, type SoldRow } from "../src/skills/propertySearch/soldComps.js";
import { decodeCursor, encodeCursor } from "../src/skills/propertySearch/pagination.js";
import { compStats, toListingCard, toSoldCard } from "../src/skills/propertySearch/formatCards.js";
import { detectIntent, parseMonths, runPropertySearch } from "../src/skills/propertySearch/index.js";

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;
const NONE: PropertyFilters = {
  city: null, maxPrice: null, beds: null, baths: null, sqft: null, type: null, pool: null, hasView: null,
};

// ---------- safe SQL ----------

test("injection attempts stay in params, never in the SQL text", () => {
  const evil = "Irvine' OR '1'='1";
  const { sql, params } = buildPropertySql({ ...NONE, city: evil, type: "x; DROP TABLE rets_property" });
  assert.ok(!sql.includes("Irvine") && !sql.includes("DROP"));
  assert.ok(params.includes(evil));
  assert.equal(placeholders(sql), params.length);
});

test("placeholders match params with every filter and sort", () => {
  const f = parsePropertyQuery("3 bed 2 bath condos in Irvine under $1.5M, 1,800 sq ft with a pool and a view");
  for (const sort of ["price_asc", "price_desc", "newest", "sqft_desc"] as const) {
    const { sql, params } = buildPropertySql(f, { sort });
    assert.equal(placeholders(sql), params.length, sort);
  }
});

test("only active listings, and no double-quoted string literals", () => {
  const { sql, params } = buildPropertySql(NONE);
  assert.match(sql, /WHERE L_Status = \?/);
  assert.equal(params[0], "Active");
  assert.ok(!sql.includes('"'));
});

test("unknown sort and out-of-range sizes are rejected", () => {
  assert.throws(() => buildPropertySql(NONE, { sort: "L_SystemPrice; DROP" as never }));
  assert.throws(() => buildPropertySql(NONE, { limit: 51 }));
  assert.throws(() => buildPropertySql(NONE, { limit: 2.5 }));
  assert.throws(() => buildPropertySql(NONE, { page: 101 }));
});

// ---------- pagination ----------

test("fetches one extra row, with a unique tiebreaker", () => {
  const { sql } = buildPropertySql(NONE, { limit: 10, sort: "price_desc" });
  assert.match(sql, /ORDER BY L_SystemPrice DESC, L_ListingID DESC LIMIT 11$/);
});

test("page numbers use OFFSET", () => {
  assert.match(buildPropertySql(NONE, { limit: 10, page: 3 }).sql, /LIMIT 11 OFFSET 20$/);
});

test("cursor seeks past the last row instead of using OFFSET", () => {
  const cursor = encodeCursor({ s: "price_asc", v: 750000, id: 123 });
  const { sql, params } = buildPropertySql(NONE, { cursor });
  assert.match(sql, /\(L_SystemPrice > \? OR \(L_SystemPrice = \? AND L_ListingID > \?\)\)/);
  assert.deepEqual(params.slice(-3), [750000, 750000, 123]);
  assert.ok(!sql.includes("OFFSET"));
  const desc = buildPropertySql(NONE, { sort: "sqft_desc", cursor: encodeCursor({ s: "sqft_desc", v: 2000, id: 9 }) });
  assert.match(desc.sql, /LM_Int2_3 < \? OR \(LM_Int2_3 = \? AND L_ListingID < \?\)/);
});

test("tampered or mismatched cursors are rejected", () => {
  assert.throws(() => decodeCursor("garbage", "price_asc"));
  const bad = Buffer.from(JSON.stringify({ s: "price_asc", v: "1 OR 1=1", id: 1 })).toString("base64url");
  assert.throws(() => decodeCursor(bad, "price_asc"));
  assert.throws(() => decodeCursor(encodeCursor({ s: "newest", v: 1, id: 1 }), "price_asc"), /different sort/);
});

/** A stand-in for the mysql2 pool: records each query and returns canned rows. */
function fakePool(handler: (sql: string, params: unknown[]) => unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      return [handler(sql, params), []];
    },
  } as unknown as Pool;
  return { pool, calls };
}

const listing = (id: number, price: number | string): ListingRow => ({
  L_ListingID: id, L_DisplayId: `OC${id}`, L_Address: `${id} Elm St`, L_City: "Irvine", L_Zip: "92618",
  price: price as number, beds: 3, baths: "2.50" as unknown as number, sqft: 1850, type: "Condominium", status: "Active",
  lat: 33.68, lng: -117.79, YearBuilt: 1998, AssociationFee: "250.00" as unknown as number, DaysOnMarket: 12,
  PoolPrivateYN: "1", ViewYN: "", FireplaceYN: null, PhotoCount: 24,
  LA1_UserFirstName: "Jane", LA1_UserLastName: "Doe", LO1_OrganizationName: "Coastal Realty",
});

test("paging through results with nextCursor returns every row exactly once", async () => {
  const all = [1, 2, 3, 4, 5].map((i) => listing(i, i <= 3 ? 500_000 : 600_000)); // ties on price
  const { pool } = fakePool((sql, params) => {
    let rows = all;
    if (sql.includes("L_ListingID >")) {
      const [v, , id] = params.slice(-3) as number[];
      rows = all.filter((r) => Number(r.price) > v || (Number(r.price) === v && Number(r.L_ListingID) > id));
    }
    const limit = Number(sql.match(/LIMIT (\d+)/)![1]);
    return rows.slice(0, limit);
  });

  const seen: number[] = [];
  let cursor: string | null = null;
  do {
    const page = await searchProperties(pool, NONE, { limit: 2, cursor });
    seen.push(...page.rows.map((r) => Number(r.L_ListingID)));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

// ---------- sold comps ----------

test("sold comps query is parameterized and bounded", () => {
  const { sql, params } = buildSoldCompsSql("Irvine", { months: 6, beds: 3, subType: "Condominium", limit: 25 });
  assert.equal(placeholders(sql), params.length);
  assert.deepEqual(params, ["Irvine", 6, "Residential", 3, "Condominium"]);
  assert.match(sql, /LIMIT 25$/);
  assert.ok(!sql.includes('"'));
  assert.throws(() => buildSoldCompsSql(""));
  assert.throws(() => buildSoldCompsSql("Irvine", { months: 120 }));
});

// ---------- cards ----------

test("listing card: numbers from DECIMAL strings, features from \"1\" flags", () => {
  const c = toListingCard(listing(7, "1250000.00"));
  assert.equal(c.price, 1_250_000);
  assert.equal(c.baths, 2.5);
  assert.equal(c.pricePerSqft, 676);
  assert.deepEqual(c.features, ["Pool"]);
  assert.equal(
    c.markdown,
    [
      "**$1,250,000** · 3 bd · 2.5 ba · 1,850 sqft",
      "7 Elm St, Irvine 92618",
      "Condominium · Built 1998 · $676/sqft · 12 days on market · HOA $250/mo",
      "Pool",
      "Listed by Jane Doe · Coastal Realty · MLS# OC7",
    ].join("\n"),
  );
});

test("listing card tolerates missing data", () => {
  const c = toListingCard({ ...listing(8, 0), price: null, beds: null, baths: null, sqft: null, L_Address: null,
    lat: 0, lng: 0, LA1_UserFirstName: null, LA1_UserLastName: null, AssociationFee: null, PoolPrivateYN: null });
  assert.equal(c.location, null);
  assert.equal(c.agent, null);
  assert.ok(c.markdown.startsWith("**—** · details n/a\nIrvine 92618"));
});

const sold = (price: number, list: number, sqft: number, dom: number): SoldRow => ({
  ListingKey: `K${price}`, UnparsedAddress: "5 Oak Ave", City: "Irvine", CloseDate: new Date(2026, 7, 1),
  ClosePrice: price, OriginalListPrice: list, ListPrice: list, DaysOnMarket: dom,
  BedroomsTotal: 3, BathroomsTotalInteger: 2, LivingArea: sqft, PropertyType: "Residential",
  PropertySubType: "Condominium", YearBuilt: 2001, ListAgentFullName: "Sam Lee",
  ListOfficeName: "Harbor Homes", BuyerOfficeName: "Bay Realty",
});

test("sold card and comp stats", () => {
  const c = toSoldCard(sold(1_000_000, 980_000, 2000, 10));
  assert.equal(c.saleToListPct, 102);
  assert.match(c.markdown, /^\*\*Sold \$1,000,000\*\* on 2026-08-01 · 3 bd · 2 ba · 2,000 sqft/);
  const stats = compStats([sold(1_000_000, 980_000, 2000, 10), sold(1_200_000, 1_250_000, 2400, 30), sold(900_000, 900_000, 1500, 20)].map(toSoldCard));
  assert.deepEqual(stats, {
    count: 3,
    medianClosePrice: 1_000_000,
    medianPricePerSqft: 500,
    avgDaysOnMarket: 20,
    avgSaleToListPct: 99.3, // (102 + 96 + 100) / 3
  });
});

// ---------- the skill end to end ----------

test("intent and look-back window come from the question", () => {
  assert.equal(detectIntent("3 bed condos in Irvine under 1M"), "active");
  assert.equal(detectIntent("what did homes in Irvine sell for"), "sold");
  assert.equal(detectIntent("recent comps in Irvine"), "sold");
  assert.equal(detectIntent("listings in Irvine and what similar homes sold for"), "both");
  assert.equal(parseMonths("sold in the last 6 months"), 6);
  assert.equal(parseMonths("over the past 2 years"), 24);
  assert.equal(parseMonths("in the past year"), 12);
  assert.equal(parseMonths("condos in Irvine"), null);
});

test("active question queries rets_property and returns cards", async () => {
  const { pool, calls } = fakePool(() => [listing(1, 900_000), listing(2, 950_000), listing(3, 990_000)]);
  const out = await runPropertySearch(pool, { query: "3-bedroom condos in Irvine under $1M with a pool", limit: 2 });
  assert.equal(out.intent, "active");
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM rets_property/);
  assert.deepEqual(calls[0].params, ["Active", "Irvine", 1_000_000, 3, "Condominium", "1"]);
  assert.equal(out.active!.cards.length, 2);
  assert.equal(out.active!.hasMore, true);
  assert.ok(out.active!.nextCursor);
  assert.match(out.markdown, /^### Active listings \(2\+\)/);
});

test("sold question queries california_sold with the parsed window", async () => {
  const { pool, calls } = fakePool(() => [sold(1_000_000, 980_000, 2000, 10)]);
  const out = await runPropertySearch(pool, { query: "what did 3 bedroom condos in Irvine sell for in the last 6 months" });
  assert.equal(out.intent, "sold");
  assert.match(calls[0].sql, /FROM california_sold/);
  assert.deepEqual(calls[0].params, ["Irvine", 6, "Residential", 3, "Condominium"]);
  assert.equal(out.sold!.stats.count, 1);
  assert.match(out.markdown, /\*\*1 sales in Irvine, last 6 months\*\*/);
});

test("both: runs the two queries together", async () => {
  const { pool, calls } = fakePool((sql) => (sql.includes("california_sold") ? [] : []));
  const out = await runPropertySearch(pool, { query: "condos in Irvine", intent: "both" });
  assert.equal(calls.length, 2);
  assert.match(out.markdown, /No active listings match/);
  assert.match(out.markdown, /No residential sales found in Irvine in the last 12 months/);
});

test("bad input fails before any query runs", async () => {
  const { pool, calls } = fakePool(() => []);
  await assert.rejects(runPropertySearch(pool, { query: "what sold recently" }), /need a city/);
  await assert.rejects(runPropertySearch(pool, { filters: { beds: -1 } }), /beds/);
  await assert.rejects(runPropertySearch(pool, { query: "condos in Irvine", sort: "bogus" as never }), /sort/);
  assert.equal(calls.length, 0);
});
