import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "mysql2/promise";
import {
  buildActiveInventorySql,
  buildAggregateSql,
  buildPriceListSql,
  soldWhere,
} from "../src/skills/marketStats/marketSql.js";
import { buildGroupStats, buildInventory, buildTrend, pctChange, readMarket, type GroupStats } from "../src/skills/marketStats/stats.js";
import { parseMarketQuery, runMarketStats } from "../src/skills/marketStats/index.js";

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

// ---------- safe SQL ----------

test("market SQL binds every value and has no double-quoted literals", () => {
  const evil = "San Diego' OR '1'='1";
  const scope = { city: evil, zip: "92101", type: "Condominium", months: 6 };
  for (const g of ["none", "city", "zip", "type", "month"] as const) {
    for (const q of [buildAggregateSql(scope, g), buildPriceListSql(scope, g)]) {
      assert.equal(placeholders(q.sql), q.params.length, g);
      assert.ok(!q.sql.includes("San Diego") && !q.sql.includes('"'), g);
      assert.ok(q.params.includes(evil) && q.params.includes("Residential"));
    }
  }
  const inv = buildActiveInventorySql(scope);
  assert.equal(placeholders(inv.sql), inv.params.length);
  assert.deepEqual(inv.params, ["Active", evil, "92101", "Condominium"]);
});

test("bad scope values are rejected before any SQL is built", () => {
  assert.throws(() => soldWhere({ months: 0 }));
  assert.throws(() => soldWhere({ months: 61 }));
  assert.throws(() => soldWhere({ zip: "9210; DROP" }));
  assert.throws(() => buildAggregateSql({}, "City; DROP TABLE x" as never));
  assert.throws(() => buildAggregateSql({}, "city", { limit: 1000 }));
});

test("window excludes future-dated closings and groups months by LEFT(CloseDate, 7)", () => {
  const { sql } = buildAggregateSql({ city: "Pasadena" }, "month");
  assert.match(sql, /CloseDate <= CURDATE\(\)/);
  assert.match(sql, /LEFT\(CloseDate, 7\) AS grp/);
  assert.match(sql, /ORDER BY grp ASC/);
});

// ---------- stats ----------

const g = (key: string, sales: number, ppsf: number, dom: number, price = ppsf * 1000): GroupStats => ({
  key, sales, avgClosePrice: price, medianClosePrice: price, avgPricePerSqft: ppsf, medianPricePerSqft: ppsf,
  avgDaysOnMarket: dom, listToClosePct: 100, origListToClosePct: 98, firstClose: null, lastClose: null,
});

test("pctChange works like pandas pct_change * 100", () => {
  assert.equal(pctChange(100, 110), 10);
  assert.equal(pctChange(200, 150), -25);
  assert.equal(pctChange(0, 5), null);
  assert.equal(pctChange(null, 5), null);
});

test("MoM and YoY are matched by calendar month, not row position", () => {
  const trend = buildTrend([g("2025-03", 10, 500, 30), g("2026-01", 10, 600, 20), g("2026-03", 12, 660, 15)]);
  const mar = trend.find((t) => t.month === "2026-03")!;
  assert.equal(mar.changes.medianPricePerSqft.mom, null); // Feb 2026 missing → no MoM
  assert.equal(mar.changes.medianPricePerSqft.yoy, 32); // vs Mar 2025: 500 → 660
  assert.deepEqual(trend.map((t) => t.month), ["2025-03", "2026-01", "2026-03"]);
});

test("medians come from raw prices; DECIMAL strings are converted", () => {
  const [s] = buildGroupStats(
    [{ grp: "Pasadena", sales: "3", avgClosePrice: "1000000.5", avgPricePerSqft: "700", avgDaysOnMarket: "20", avgListToClose: "1.0123", avgOrigListToClose: null }],
    [
      { grp: "Pasadena", price: "900000", ppsf: "600" },
      { grp: "Pasadena", price: 1_000_000, ppsf: 700 },
      { grp: "Pasadena", price: 3_000_000, ppsf: null },
      { grp: "Other", price: 1, ppsf: 1 },
    ],
  );
  assert.equal(s.sales, 3);
  assert.equal(s.medianClosePrice, 1_000_000);
  assert.equal(s.medianPricePerSqft, 650);
  assert.equal(s.listToClosePct, 101.2);
  assert.equal(s.origListToClosePct, null);
});

test("months of supply uses the real span of close dates (partial months don't skew it)", () => {
  // 608 sales between Mar 18 and Sep 15 (182 days) = ~101.6 sales per 30.4 days
  const overall = { ...g("all", 608, 600, 20), firstClose: "2026-03-18", lastClose: "2026-09-15" };
  const inv = buildInventory({ activeCount: 203, avgListPrice: "1200000" }, overall);
  assert.equal(inv.avgMonthlySales, 101.6);
  assert.equal(inv.monthsOfSupply, 2);
  assert.equal(inv.avgListPrice, 1_200_000);
  // no active data for the area → unknown, not "0 months"
  assert.equal(buildInventory({ activeCount: 0 }, overall).monthsOfSupply, null);
});

test("market read: tight supply + over-asking + rising prices = seller's market", () => {
  const trend = buildTrend([
    g("2026-03", 100, 600, 30), g("2026-04", 100, 600, 30), g("2026-05", 100, 600, 30),
    g("2026-06", 100, 660, 20), g("2026-07", 100, 660, 20), g("2026-08", 100, 660, 20),
  ]);
  const overall = { ...g("all", 600, 630, 25), listToClosePct: 102, firstClose: "2026-03-01", lastClose: "2026-08-31" };
  const inv = buildInventory({ activeCount: 150 }, overall); // ~100 sales/month → 1.5 months
  const read = readMarket(overall, inv, trend);
  assert.equal(read.marketType, "seller's market");
  assert.equal(read.signals.length, 4);
});

test("market read: lots of supply + under-asking = buyer's market", () => {
  const trend = buildTrend([g("2026-07", 10, 600, 60), g("2026-08", 10, 600, 60), g("2026-09", 10, 600, 60)]);
  const overall = { ...g("all", 30, 600, 60), listToClosePct: 96, firstClose: "2026-07-01", lastClose: "2026-09-30" };
  const inv = buildInventory({ activeCount: 100 }, overall); // ~10 sales/month → 10 months
  const read = readMarket(overall, inv, trend);
  assert.equal(read.marketType, "buyer's market");
});

// ---------- parsing ----------

test("handbook questions parse to the right scope and focus", () => {
  const a = parseMarketQuery("Is now a good time to buy in San Diego?");
  assert.equal(a.city, "San Diego");
  assert.equal(a.focus, "buy");
  const b = parseMarketQuery("What is the average price per sq ft in Pasadena?");
  assert.equal(b.city, "Pasadena");
  assert.equal(b.focus, "pricePerSqft");
  const c = parseMarketQuery("median condo prices in Irvine by zip over the last 6 months");
  assert.deepEqual([c.city, c.type, c.groupBy, c.months], ["Irvine", "Condominium", "zip", 6]);
  const d = parseMarketQuery("price trends in the last year by city");
  assert.deepEqual([d.city, d.groupBy, d.months, d.focus], [null, "city", 12, "trend"]);
  assert.equal(parseMarketQuery("average days on market in 92101").zip, "92101");
});

// ---------- end to end with a fake pool ----------

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

const MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

test("runMarketStats answers 'good time to buy' with stats, inventory and trend", async () => {
  const { pool, calls } = fakePool((sql) => {
    if (sql.includes("rets_property")) return [{ activeCount: 300, avgListPrice: "1100000", avgListPricePerSqft: "700" }];
    if (sql.includes("COUNT(*)") && sql.includes("GROUP BY"))
      return MONTHS.map((m, i) => ({ grp: m, sales: 100, avgClosePrice: 1_000_000 + i * 10_000, avgPricePerSqft: 650 + i * 5, avgDaysOnMarket: 30 - i, avgListToClose: "1.01", avgOrigListToClose: "0.99" }));
    if (sql.includes("COUNT(*)"))
      return [{ sales: 700, avgClosePrice: "1030000", avgPricePerSqft: "665", avgDaysOnMarket: "27", avgListToClose: "1.01", avgOrigListToClose: "0.99", firstClose: "2026-03-18", lastClose: "2026-09-15" }];
    return MONTHS.flatMap((m, i) => [{ grp: m, price: 950_000 + i * 10_000, ppsf: 640 + i * 5 }, { grp: m, price: 1_050_000 + i * 10_000, ppsf: 660 + i * 5 }]);
  });

  const out = await runMarketStats(pool, { query: "Is now a good time to buy in San Diego?", now: new Date(2026, 9, 22) });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((c) => c.params.includes("San Diego")));
  assert.equal(out.scope.city, "San Diego");
  assert.equal(out.overall?.sales, 700);
  assert.equal(out.overall?.listToClosePct, 101);
  assert.equal(out.trend.length, 7);
  assert.equal(out.trend[1].changes.sales.mom, 0);
  assert.equal(out.inventory.avgMonthlySales, 116.9); // 700 sales over 182 days
  assert.equal(out.inventory.monthsOfSupply, 2.6);
  assert.ok(out.read.marketType);
  assert.match(out.markdown, /Is now a good time to buy in San Diego\?/);
  assert.match(out.markdown, /\| 2026-09 \|/);
  assert.match(out.markdown, /YoY shows "—"/);
  assert.match(out.markdown, /2026-03 and 2026-09 are partial months/);
});

test("breakdown runs two extra queries; empty results give a clear message", async () => {
  const { pool, calls } = fakePool(() => []);
  const out = await runMarketStats(pool, { query: "home prices in Atlantis by zip" });
  assert.equal(calls.length, 6);
  assert.equal(out.overall, null);
  assert.match(out.markdown, /No residential sales found for Atlantis/);
});

test("bad input fails before touching the database", async () => {
  const { pool, calls } = fakePool(() => []);
  await assert.rejects(runMarketStats(pool, { city: "Irvine", months: 100 }), /months/);
  await assert.rejects(runMarketStats(pool, { city: "Irvine", groupBy: "L_City" as never }), /groupBy/);
  assert.equal(calls.length, 0);
});

test("without inventory data the read only calls a clear trend", () => {
  const trend = buildTrend([
    g("2026-03", 100, 600, 25), g("2026-04", 100, 600, 25), g("2026-05", 100, 600, 25),
    g("2026-06", 100, 585, 29), g("2026-07", 100, 585, 29), g("2026-08", 100, 585, 29),
  ]);
  const overall = { ...g("all", 600, 590, 27), listToClosePct: 99.5 };
  const read = readMarket(overall, buildInventory({ activeCount: 0 }, overall), trend);
  assert.equal(read.marketType, "balanced market");
  assert.match(read.summary, /leaning slightly toward buyers/);
  assert.match(read.summary, /sales trends only/);
});
