// Week 5: turn aggregate rows into market stats, monthly trends with MoM / YoY
// changes (the TypeScript version of the handbook's pandas pct_change), and a
// simple buyer's / seller's market read.

export interface AggregateRow {
  grp?: string | null;
  sales: number | string;
  avgClosePrice: number | string | null;
  avgPricePerSqft: number | string | null;
  avgDaysOnMarket: number | string | null;
  avgListToClose: number | string | null;
  avgOrigListToClose: number | string | null;
  firstClose?: string | Date | null;
  lastClose?: string | Date | null;
}

export interface PriceRow {
  grp: string | null;
  price: number | string | null;
  ppsf: number | string | null;
}

export interface GroupStats {
  key: string | null; // city / ZIP / type / "YYYY-MM"; null for the whole scope
  sales: number;
  avgClosePrice: number | null;
  medianClosePrice: number | null;
  avgPricePerSqft: number | null;
  medianPricePerSqft: number | null;
  avgDaysOnMarket: number | null;
  listToClosePct: number | null; // close / final list price, as a percent (100 = at asking)
  origListToClosePct: number | null; // close / original list price
  firstClose: string | null; // earliest / latest close date in the group (YYYY-MM-DD)
  lastClose: string | null;
}

export interface Change {
  mom: number | null; // % change vs the previous month
  yoy: number | null; // % change vs the same month a year earlier
}

export interface TrendPoint extends GroupStats {
  month: string;
  changes: { medianClosePrice: Change; medianPricePerSqft: Change; avgDaysOnMarket: Change; sales: Change };
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round = (n: number | null, digits = 0) => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
const pct = (ratio: number | null) => (ratio === null ? null : round(ratio * 100, 1));

function dateText(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/** Merge SQL averages with medians computed from the raw price rows. */
export function buildGroupStats(aggRows: AggregateRow[], priceRows: PriceRow[]): GroupStats[] {
  const prices = new Map<string | null, number[]>();
  const ppsfs = new Map<string | null, number[]>();
  for (const r of priceRows) {
    const key = r.grp ?? null;
    const p = toNum(r.price);
    const s = toNum(r.ppsf);
    if (p !== null && p > 0) (prices.get(key) ?? prices.set(key, []).get(key)!).push(p);
    if (s !== null && s > 0) (ppsfs.get(key) ?? ppsfs.set(key, []).get(key)!).push(s);
  }

  return aggRows.map((r) => {
    const key = r.grp ?? null;
    return {
      key,
      sales: toNum(r.sales) ?? 0,
      avgClosePrice: round(toNum(r.avgClosePrice)),
      medianClosePrice: round(median(prices.get(key) ?? [])),
      avgPricePerSqft: round(toNum(r.avgPricePerSqft)),
      medianPricePerSqft: round(median(ppsfs.get(key) ?? [])),
      avgDaysOnMarket: round(toNum(r.avgDaysOnMarket), 1),
      listToClosePct: pct(toNum(r.avgListToClose)),
      origListToClosePct: pct(toNum(r.avgOrigListToClose)),
      firstClose: dateText(r.firstClose),
      lastClose: dateText(r.lastClose),
    };
  });
}

/** Percent change from `before` to `after`, like pandas pct_change() * 100. */
export function pctChange(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before === null || before === undefined || after === null || after === undefined || before === 0) return null;
  return round(((after - before) / before) * 100, 1);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Monthly stats → trend points with MoM and YoY changes. Changes are matched by
 * calendar month, not by row position, so a month with no sales gives null rather
 * than comparing against the wrong month (pct_change on a gappy series would).
 */
export function buildTrend(monthly: GroupStats[]): TrendPoint[] {
  const byMonth = new Map(monthly.filter((m) => m.key).map((m) => [m.key as string, m]));
  const metrics = ["medianClosePrice", "medianPricePerSqft", "avgDaysOnMarket", "sales"] as const;

  return [...byMonth.keys()].sort().map((month) => {
    const cur = byMonth.get(month)!;
    const prev = byMonth.get(shiftMonth(month, -1));
    const lastYear = byMonth.get(shiftMonth(month, -12));
    const changes = Object.fromEntries(
      metrics.map((k) => [k, { mom: pctChange(prev?.[k], cur[k]), yoy: pctChange(lastYear?.[k], cur[k]) }]),
    ) as TrendPoint["changes"];
    return { ...cur, month, changes };
  });
}

// ---------- inventory and market read ----------

export interface Inventory {
  activeListings: number;
  avgListPrice: number | null;
  avgListPricePerSqft: number | null;
  avgMonthlySales: number | null; // closed sales per 30.4 days over the data's actual date span
  monthsOfSupply: number | null; // active listings / avg monthly sales (null when no active data)
}

const DAY_MS = 86_400_000;

/**
 * Months of supply = active inventory / average monthly sales. The sales rate uses
 * the real span of close dates (first to last sale), not calendar months, because
 * the first and last months of the data are partial and would drag a per-month
 * average down. With no active listings for the area (rets_property doesn't cover
 * it), months of supply is unknown rather than 0.
 */
export function buildInventory(activeRow: Record<string, unknown> | undefined, overall: GroupStats | null | undefined): Inventory {
  const active = toNum(activeRow?.activeCount) ?? 0;
  let rate: number | null = null;
  if (overall?.sales && overall.firstClose && overall.lastClose) {
    const days = (Date.parse(overall.lastClose) - Date.parse(overall.firstClose)) / DAY_MS + 1;
    if (Number.isFinite(days) && days >= 1) rate = (overall.sales / Math.max(days, 30.4)) * 30.4;
  }
  return {
    activeListings: active,
    avgListPrice: round(toNum(activeRow?.avgListPrice)),
    avgListPricePerSqft: round(toNum(activeRow?.avgListPricePerSqft)),
    avgMonthlySales: round(rate, 1),
    monthsOfSupply: rate && active > 0 ? round(active / rate, 1) : null,
  };
}

export type MarketType = "seller's market" | "balanced market" | "buyer's market";

export interface MarketRead {
  marketType: MarketType | null;
  signals: string[]; // one plain sentence per signal
  summary: string;
}

/**
 * A rule-of-thumb read, not advice. Months of supply is the main signal (under 3 =
 * seller's, over 6 = buyer's — the common NAR-style thresholds), nudged by whether
 * homes sell over or under list and by the recent price and days-on-market trend.
 */
export function readMarket(overall: GroupStats | undefined, inventory: Inventory | null, trend: TrendPoint[]): MarketRead {
  const signals: string[] = [];
  let score = 0; // positive = favors sellers, negative = favors buyers
  let weight = 0;

  const mos = inventory?.monthsOfSupply ?? null;
  if (mos !== null) {
    weight += 2;
    if (mos < 3) score += 2;
    else if (mos > 6) score -= 2;
    signals.push(
      `${mos} months of supply (${inventory!.activeListings} active listings vs ~${inventory!.avgMonthlySales} sales/month)` +
        (mos < 3 ? ": inventory is tight." : mos > 6 ? ": plenty of inventory." : ": roughly balanced."),
    );
  }

  const ltc = overall?.listToClosePct ?? null;
  if (ltc !== null) {
    weight += 1;
    if (ltc >= 100) score += 1;
    else if (ltc < 98) score -= 1;
    signals.push(
      `Homes closed at ${ltc}% of list price on average` +
        (ltc >= 100 ? ", so buyers are often paying asking or more." : ltc < 98 ? ", so there is room to negotiate." : "."),
    );
  }

  // Compare the last 3 months with the 3 before them (needs 6 months of data).
  const last = trend.slice(-6);
  if (last.length >= 4) {
    const half = Math.floor(last.length / 2);
    const avg = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const early = last.slice(0, half);
    const late = last.slice(half);
    const priceChg = pctChange(avg(early.map((t) => t.medianPricePerSqft)), avg(late.map((t) => t.medianPricePerSqft)));
    const domChg = pctChange(avg(early.map((t) => t.avgDaysOnMarket)), avg(late.map((t) => t.avgDaysOnMarket)));
    if (priceChg !== null) {
      weight += 1;
      if (priceChg > 2) score += 1;
      else if (priceChg < -2) score -= 1;
      signals.push(`Median $/sqft is ${priceChg >= 0 ? "up" : "down"} ${Math.abs(priceChg)}% over recent months.`);
    }
    if (domChg !== null) {
      weight += 1;
      if (domChg < -10) score += 1;
      else if (domChg > 10) score -= 1;
      signals.push(`Days on market are ${domChg >= 0 ? "up" : "down"} ${Math.abs(domChg)}% over the same period.`);
    }
  }

  if (!weight) return { marketType: null, signals, summary: "Not enough data for a market read." };
  const s = score / weight;
  // Months of supply is the main signal; without it, only call a clear trend.
  const cut = mos === null ? 0.75 : 0.4;
  const marketType: MarketType = s >= cut ? "seller's market" : s <= -cut ? "buyer's market" : "balanced market";
  let summary =
    marketType === "seller's market"
      ? "It's a seller's market: expect competition, quick sales and little room to negotiate."
      : marketType === "buyer's market"
        ? "It's a buyer's market: buyers have more choice, more time and more negotiating room."
        : "The market looks balanced: neither buyers nor sellers have a clear edge.";
  if (marketType === "balanced market" && Math.abs(s) >= 0.25) {
    summary = `The market looks balanced, leaning slightly toward ${s > 0 ? "sellers" : "buyers"}.`;
  }
  if (mos === null) summary += " (Active inventory wasn't available, so this is based on sales trends only.)";
  return { marketType, signals, summary };
}
