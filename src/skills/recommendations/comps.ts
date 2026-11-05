// Week 7: check a listing's price against recent sold comps in california_sold.
//
// Handbook validate_with_comps(): average price per sq ft of residential sales in the
// same city, within ±20% of the listing's living area, closed in the last 6 months;
// comp price = that average × the listing's sq ft. Changes from the handbook:
// - Comps also match the property type (a condo isn't priced like a house), and fall
//   back to all types when there are fewer than MIN_COMPS of the same type.
// - No comps, or no sq ft, gives comp price null instead of dividing by zero.
// - Uses the market-stats WHERE (bound params, no future-dated typos in CloseDate).

import type { Pool } from "mysql2/promise";
import { soldWhere } from "../marketStats/marketSql.js";
import { toNum } from "../marketStats/stats.js";

export const COMP_MONTHS = 6;
export const MIN_COMPS = 3;
const SQFT_BAND = 0.2; // ±20%
const IN_LINE_PCT = 5; // within ±5% of comp price counts as in line

export type Assessment = "below comps" | "in line with comps" | "above comps" | "not enough comps";

export interface CompValidation {
  compPrice: number | null; // avg $/sq ft of comps × listing sq ft
  listPrice: number | null;
  compCount: number;
  avgPricePerSqft: number | null;
  deltaPct: number | null; // (list − comp) ÷ comp × 100; positive = priced above comps
  assessment: Assessment;
  matchedType: boolean; // comps were limited to the listing's property type
  months: number;
}

export interface CompInput {
  city: string | null;
  sqft: number | string | null;
  price: number | string | null;
  type?: string | null;
}

export function buildCompValidationSql(city: string, sqft: number, type: string | null) {
  const scope = soldWhere({ city, type, months: COMP_MONTHS });
  const sql =
    "SELECT AVG(ClosePrice / NULLIF(LivingArea, 0)) AS avgPpsf, COUNT(*) AS compCount " +
    `FROM california_sold WHERE ${scope.where} AND LivingArea BETWEEN ? AND ?`;
  const params = [...scope.params, Math.round(sqft * (1 - SQFT_BAND)), Math.round(sqft * (1 + SQFT_BAND))];
  return { sql, params };
}

export function assess(listPrice: number | null, compPrice: number | null, compCount: number) {
  if (listPrice === null || compPrice === null || compPrice <= 0 || compCount < MIN_COMPS) {
    return { deltaPct: null, assessment: "not enough comps" as Assessment };
  }
  const deltaPct = Math.round(((listPrice - compPrice) / compPrice) * 1000) / 10;
  const assessment: Assessment =
    deltaPct > IN_LINE_PCT ? "above comps" : deltaPct < -IN_LINE_PCT ? "below comps" : "in line with comps";
  return { deltaPct, assessment };
}

export async function validateWithComps(pool: Pool, input: CompInput): Promise<CompValidation> {
  const sqft = toNum(input.sqft);
  const listPrice = toNum(input.price);
  const empty: CompValidation = {
    compPrice: null,
    listPrice,
    compCount: 0,
    avgPricePerSqft: null,
    deltaPct: null,
    assessment: "not enough comps",
    matchedType: false,
    months: COMP_MONTHS,
  };
  if (!input.city || sqft === null || sqft <= 0) return empty;

  const run = async (type: string | null) => {
    const { sql, params } = buildCompValidationSql(input.city!, sqft, type);
    const [rows] = await pool.query(sql, params);
    const row = (rows as Record<string, unknown>[])[0] ?? {};
    return { avgPpsf: toNum(row.avgPpsf), count: toNum(row.compCount) ?? 0 };
  };

  let matchedType = Boolean(input.type);
  let result = await run(input.type ?? null);
  if (matchedType && result.count < MIN_COMPS) {
    matchedType = false;
    result = await run(null);
  }

  const compPrice = result.avgPpsf === null || result.count === 0 ? null : Math.round(result.avgPpsf * sqft);
  return {
    ...empty,
    compPrice,
    compCount: result.count,
    avgPricePerSqft: result.avgPpsf === null ? null : Math.round(result.avgPpsf),
    matchedType,
    ...assess(listPrice, compPrice, result.count),
  };
}
