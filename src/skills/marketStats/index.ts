// Week 5 skill entry point: Market Statistics Agent.
// Answers questions like "Is now a good time to buy in San Diego?" or "What is the
// average price per sq ft in Pasadena?" from california_sold (closed sales) and
// rets_property (active inventory).

import type { Pool } from "mysql2/promise";
import { parsePropertyQuery } from "../propertySearch/parsePropertyQuery.js";
import { parseMonths } from "../propertySearch/index.js";
import {
  buildActiveInventorySql,
  buildAggregateSql,
  buildPriceListSql,
  isGroupBy,
  type GroupBy,
  type MarketScope,
} from "./marketSql.js";
import {
  buildGroupStats,
  buildInventory,
  buildTrend,
  readMarket,
  type AggregateRow,
  type GroupStats,
  type Inventory,
  type MarketRead,
  type PriceRow,
  type TrendPoint,
} from "./stats.js";

export interface MarketStatsInput {
  query?: string; // free-text question
  city?: string | null; // or the scope directly (overrides what the parser found)
  zip?: string | null;
  type?: string | null;
  months?: number; // default: from the query ("last 6 months"), else 12
  groupBy?: GroupBy; // default: from the query ("by ZIP", "by property type"), else none
  now?: Date; // for tests
}

export type Focus = "buy" | "sell" | "pricePerSqft" | "price" | "daysOnMarket" | "listToClose" | "inventory" | "trend" | "summary";

export interface MarketStatsOutput {
  scope: { city: string | null; zip: string | null; type: string | null; months: number; groupBy: GroupBy };
  focus: Focus;
  overall: GroupStats | null;
  trend: TrendPoint[];
  inventory: Inventory;
  breakdown?: GroupStats[];
  read: MarketRead;
  notes: string[];
  markdown: string;
}

// Words the city regex can pick up that aren't cities ("trends in the last year").
const NOT_A_CITY = new Set(["the", "my", "this", "that", "general", "california", "ca", "socal", "norcal", "total"]);

/** Free text → scope, grouping and what the user mainly asked about. */
export function parseMarketQuery(query: string) {
  const parsed = parsePropertyQuery(query);
  // The Week 2 city regex doesn't stop at "by" ("prices in Irvine by zip").
  const rawCity = parsed.city?.replace(/\s+(by|vs|versus|compared|right|now|today|this)\b.*$/i, "").trim() || null;
  const city = rawCity && !NOT_A_CITY.has(rawCity.toLowerCase()) ? rawCity : null;
  const zip = query.match(/\b(9[0-6]\d{3})\b/)?.[1] ?? null; // California ZIPs are 90000–96199

  const q = query.toLowerCase();
  let groupBy: GroupBy = "none";
  if (/\bby (zip|zip ?codes?|postal codes?|zips)\b|\bwhich zip/.test(q)) groupBy = "zip";
  else if (/\bby (city|cities)\b|\b(which|compare|top) cities\b/.test(q)) groupBy = "city";
  else if (/\bby (property |home )?types?\b|\b(condos? vs|vs\.? condos?|single[- ]family vs)\b/.test(q)) groupBy = "type";

  let focus: Focus = "summary";
  if (/\b(good|right|bad|best) time to buy\b|\bshould i buy\b|\bbuyer'?s market\b/.test(q)) focus = "buy";
  else if (/\b(good|right|bad|best) time to sell\b|\bshould i sell\b|\bseller'?s market\b/.test(q)) focus = "sell";
  else if (/price per (sq|square)|\$ ?\/ ?(sq|sf)|\bppsf\b|per sq\.? ?ft/.test(q)) focus = "pricePerSqft";
  else if (/days on (the )?market|\bdom\b|how (fast|quickly|long)/.test(q)) focus = "daysOnMarket";
  else if (/list[- ]to[- ](close|sale)|sale[- ]to[- ]list|over (asking|list)|under (asking|list)/.test(q)) focus = "listToClose";
  else if (/\binventory\b|months? of supply|how many (homes|listings)/.test(q)) focus = "inventory";
  else if (/\btrends?\b|month over month|year over year|\bmom\b|\byoy\b|over time/.test(q)) focus = "trend";
  else if (/\b(average|median|typical|avg)\b.*\bprice\b|\bhome (prices|values)\b|\bwhat do homes (cost|sell for)/.test(q)) focus = "price";

  return { city, zip, type: parsed.type, months: parseMonths(query), groupBy, focus };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : usd.format(n));
const signed = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n}%`);
const orDash = (v: unknown) => (v === null || v === undefined ? "—" : String(v));

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function rows<T>(pool: Pool, q: { sql: string; params: unknown[] }): Promise<T[]> {
  const [r] = await pool.query(q.sql, q.params);
  return r as T[];
}

export async function runMarketStats(pool: Pool, input: MarketStatsInput): Promise<MarketStatsOutput> {
  const parsed = input.query ? parseMarketQuery(input.query) : null;
  const groupBy = input.groupBy ?? parsed?.groupBy ?? "none";
  if (!isGroupBy(groupBy)) throw new Error(`Unknown groupBy: ${String(groupBy)}`);
  const scope: Required<Pick<MarketScope, "months">> & MarketScope = {
    city: input.city !== undefined ? input.city : (parsed?.city ?? null),
    zip: input.zip !== undefined ? input.zip : (parsed?.zip ?? null),
    type: input.type !== undefined ? input.type : (parsed?.type ?? null),
    months: input.months ?? parsed?.months ?? 12,
  };
  const focus: Focus = parsed?.focus ?? "summary";

  // Build every query first, so bad input fails before anything hits the database.
  const monthlyAggQ = buildAggregateSql(scope, "month");
  const monthlyPriceQ = buildPriceListSql(scope, "month");
  const inventoryQ = buildActiveInventorySql(scope);
  const wantBreakdown = groupBy !== "none" && groupBy !== "month";
  const breakdownAggQ = wantBreakdown ? buildAggregateSql(scope, groupBy) : null;
  const breakdownPriceQ = wantBreakdown ? buildPriceListSql(scope, groupBy) : null;
  const overallAggQ = buildAggregateSql(scope, "none");

  const [overallAgg, monthlyAgg, monthlyPrices, activeRows, breakdownAgg, breakdownPrices] = await Promise.all([
    rows<AggregateRow>(pool, overallAggQ),
    rows<AggregateRow>(pool, monthlyAggQ),
    rows<PriceRow>(pool, monthlyPriceQ),
    rows<Record<string, unknown>>(pool, inventoryQ),
    breakdownAggQ ? rows<AggregateRow>(pool, breakdownAggQ) : Promise.resolve(null),
    breakdownPriceQ ? rows<PriceRow>(pool, breakdownPriceQ) : Promise.resolve(null),
  ]);

  // Overall medians use every price row (the month key is dropped).
  const overall =
    buildGroupStats(
      overallAgg.map((r) => ({ ...r, grp: null })),
      monthlyPrices.map((r) => ({ ...r, grp: null })),
    )[0] ?? null;
  const usableOverall = overall && overall.sales > 0 ? overall : null;
  const trend = buildTrend(buildGroupStats(monthlyAgg, monthlyPrices));
  const currentMonth = monthKey(input.now ?? new Date());
  const inventory = buildInventory(activeRows[0], usableOverall);
  const breakdown = breakdownAgg && breakdownPrices ? buildGroupStats(breakdownAgg, breakdownPrices) : undefined;
  const read = readMarket(usableOverall ?? undefined, inventory, trend);

  const notes: string[] = [];
  if (trend.length && trend.every((t) => t.changes.medianPricePerSqft.yoy === null)) {
    notes.push(`Year-over-year changes need 13+ months of sales; this data starts in ${trend[0].month}, so YoY shows "—".`);
  }
  if (usableOverall?.firstClose && usableOverall.lastClose) {
    const partial = [usableOverall.firstClose, usableOverall.lastClose].filter((d, i) =>
      i === 0 ? !d.endsWith("-01") : d.slice(0, 7) >= currentMonth || Number(d.slice(8, 10)) < 25,
    );
    if (partial.length) {
      notes.push(
        `Sales in this data run from ${usableOverall.firstClose} to ${usableOverall.lastClose}, so ` +
          `${[...new Set(partial.map((d) => d.slice(0, 7)))].join(" and ")} ${partial.length > 1 ? "are partial months" : "is a partial month"} (low sales counts).`,
      );
    }
  }
  if (!inventory.activeListings) notes.push("No active listings found in rets_property for this area, so months of supply is unknown.");
  notes.push("Market stats are informational, not financial advice.");

  const out: MarketStatsOutput = {
    scope: { city: scope.city ?? null, zip: scope.zip ?? null, type: scope.type ?? null, months: scope.months, groupBy },
    focus,
    overall: usableOverall,
    trend,
    inventory,
    breakdown,
    read,
    notes,
    markdown: "",
  };
  out.markdown = formatMarkdown(out);
  return out;
}

// ---------- markdown ----------

function placeName(s: MarketStatsOutput["scope"]): string {
  const where = [s.zip ? `ZIP ${s.zip}` : null, s.city].filter(Boolean).join(", ") || "California (all cities)";
  return s.type ? `${s.type} homes in ${where}` : where;
}

function headline(o: GroupStats, months: number): string {
  return [
    `**${int.format(o.sales)} sales in the last ${months} months**`,
    `median ${money(o.medianClosePrice)} (avg ${money(o.avgClosePrice)})`,
    o.medianPricePerSqft !== null && `median ${money(o.medianPricePerSqft)}/sqft (avg ${money(o.avgPricePerSqft)})`,
    o.avgDaysOnMarket !== null && `avg ${o.avgDaysOnMarket} days on market`,
    o.listToClosePct !== null && `closed at ${o.listToClosePct}% of list`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function answerLine(out: MarketStatsOutput): string | null {
  const o = out.overall;
  const place = placeName(out.scope);
  const last = out.trend[out.trend.length - 1];
  switch (out.focus) {
    case "buy":
    case "sell":
      return `**Is now a good time to ${out.focus} in ${place}?** ${out.read.summary}` +
        (out.read.marketType === null ? "" : out.focus === "buy"
          ? out.read.marketType === "buyer's market" ? " Conditions favor buyers right now." : out.read.marketType === "seller's market" ? " Buyers should be ready to move fast and bid at or above asking." : " Buyers can usually negotiate on homes that have sat for a while."
          : out.read.marketType === "seller's market" ? " Conditions favor sellers right now." : out.read.marketType === "buyer's market" ? " Sellers should price carefully and expect longer marketing times." : " Well-priced homes should sell at close to asking.");
    case "pricePerSqft":
      return o && `**Price per sq ft in ${place}:** median ${money(o.medianPricePerSqft)}/sqft, average ${money(o.avgPricePerSqft)}/sqft over ${int.format(o.sales)} sales in the last ${out.scope.months} months.` +
        (last?.changes.medianPricePerSqft.mom != null ? ` Latest month (${last.month}): ${money(last.medianPricePerSqft)}/sqft, ${signed(last.changes.medianPricePerSqft.mom)} vs the month before.` : "");
    case "price":
      return o && `**Home prices in ${place}:** median close price ${money(o.medianClosePrice)}, average ${money(o.avgClosePrice)} (${int.format(o.sales)} sales, last ${out.scope.months} months).`;
    case "daysOnMarket":
      return o && `**Days on market in ${place}:** homes took ${orDash(o.avgDaysOnMarket)} days on average to sell over the last ${out.scope.months} months.`;
    case "listToClose":
      return o && `**List-to-close in ${place}:** homes closed at ${orDash(o.listToClosePct)}% of their final list price and ${orDash(o.origListToClosePct)}% of their original list price on average.`;
    case "inventory":
      return `**Inventory in ${place}:** ${int.format(out.inventory.activeListings)} active listings vs ~${orDash(out.inventory.avgMonthlySales)} sales per month` +
        (out.inventory.monthsOfSupply !== null ? `, about ${out.inventory.monthsOfSupply} months of supply.` : ".");
    default:
      return null;
  }
}

function trendTable(trend: TrendPoint[]): string {
  const header =
    "| Month | Sales | Median price | Median $/sqft | MoM $/sqft | YoY $/sqft | Avg DOM | List-to-close |\n" +
    "|---|---:|---:|---:|---:|---:|---:|---:|";
  const lines = trend.map(
    (t) =>
      `| ${t.month} | ${int.format(t.sales)} | ${money(t.medianClosePrice)} | ${money(t.medianPricePerSqft)} | ` +
      `${signed(t.changes.medianPricePerSqft.mom)} | ${signed(t.changes.medianPricePerSqft.yoy)} | ` +
      `${orDash(t.avgDaysOnMarket)} | ${t.listToClosePct === null ? "—" : `${t.listToClosePct}%`} |`,
  );
  return [header, ...lines].join("\n");
}

function breakdownTable(groupBy: GroupBy, groups: GroupStats[]): string {
  const label = { city: "City", zip: "ZIP", type: "Property type", month: "Month", none: "" }[groupBy];
  const header =
    `| ${label} | Sales | Median price | Avg price | Median $/sqft | Avg DOM | List-to-close |\n` + "|---|---:|---:|---:|---:|---:|---:|";
  const lines = groups.map(
    (g) =>
      `| ${g.key} | ${int.format(g.sales)} | ${money(g.medianClosePrice)} | ${money(g.avgClosePrice)} | ` +
      `${money(g.medianPricePerSqft)} | ${orDash(g.avgDaysOnMarket)} | ${g.listToClosePct === null ? "—" : `${g.listToClosePct}%`} |`,
  );
  return [header, ...lines].join("\n");
}

export function formatMarkdown(out: MarketStatsOutput): string {
  const place = placeName(out.scope);
  if (!out.overall) {
    return `### Market stats: ${place}\n\nNo residential sales found for ${place} in the last ${out.scope.months} months. Check the spelling of the city, or try a longer window.`;
  }
  const inv = out.inventory;
  const parts = [`### Market stats: ${place}`];
  const answer = answerLine(out);
  if (answer) parts.push(answer);
  parts.push(headline(out.overall, out.scope.months));
  parts.push(
    `**Inventory:** ${int.format(inv.activeListings)} active listings` +
      (inv.avgListPrice !== null ? ` (avg list ${money(inv.avgListPrice)})` : "") +
      ` vs ~${orDash(inv.avgMonthlySales)} sales/month` +
      (inv.monthsOfSupply !== null ? ` → ${inv.monthsOfSupply} months of supply.` : "."),
  );
  if (out.read.marketType) {
    parts.push(`**Market read: ${out.read.marketType}.** ${out.read.signals.join(" ")}`);
  }
  if (out.breakdown?.length) parts.push(`#### By ${out.scope.groupBy}\n\n${breakdownTable(out.scope.groupBy, out.breakdown)}`);
  if (out.trend.length) parts.push(`#### Monthly trend\n\n${trendTable(out.trend)}`);
  parts.push(out.notes.map((n) => `_${n}_`).join("\n"));
  return parts.join("\n\n");
}
