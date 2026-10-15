// Recent sold comparables from california_sold, for "what are homes selling for" questions.

import type { Pool } from "mysql2/promise";

export const MAX_COMPS = 50;

export interface SoldRow {
  ListingKey: string;
  UnparsedAddress: string | null;
  City: string | null;
  CloseDate: Date | string | null;
  ClosePrice: number | null;
  OriginalListPrice: number | null;
  ListPrice: number | null;
  DaysOnMarket: number | null;
  BedroomsTotal: number | null;
  BathroomsTotalInteger: number | null;
  LivingArea: number | null;
  PropertyType: string | null;
  PropertySubType: string | null;
  YearBuilt: number | null;
  ListAgentFullName: string | null;
  ListOfficeName: string | null;
  BuyerOfficeName: string | null;
}

export interface CompOptions {
  months?: number; // look-back window, 1–60 (default 12)
  limit?: number; // 1–50 (default 50)
  beds?: number | null; // minimum bedrooms
  subType?: string | null; // e.g. "Condominium" (same values the parser produces for type)
}

export function buildSoldCompsSql(city: string, options: CompOptions = {}) {
  if (!city || !city.trim()) throw new Error("A city is required for sold comps");
  const months = options.months ?? 12;
  const limit = options.limit ?? MAX_COMPS;
  if (!Number.isInteger(months) || months < 1 || months > 60) throw new Error("months must be 1–60");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COMPS) throw new Error(`limit must be 1–${MAX_COMPS}`);

  const where = ["City = ?", "CloseDate >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)", "PropertyType = ?"];
  const params: (string | number)[] = [city.trim(), months, "Residential"];

  if (options.beds != null) {
    where.push("BedroomsTotal >= ?");
    params.push(options.beds);
  }
  if (options.subType) {
    where.push("PropertySubType = ?");
    params.push(options.subType);
  }

  const sql =
    "SELECT ListingKey, UnparsedAddress, City, CloseDate, ClosePrice, " +
    "OriginalListPrice, ListPrice, DaysOnMarket, " +
    "BedroomsTotal, BathroomsTotalInteger, LivingArea, " +
    "PropertyType, PropertySubType, YearBuilt, " +
    "ListAgentFullName, ListOfficeName, BuyerOfficeName " +
    `FROM california_sold WHERE ${where.join(" AND ")} ` +
    `ORDER BY CloseDate DESC, ListingKey DESC LIMIT ${limit}`;

  return { sql, params };
}

export async function getSoldComps(pool: Pool, city: string, options: CompOptions = {}): Promise<SoldRow[]> {
  const { sql, params } = buildSoldCompsSql(city, options);
  const [rows] = await pool.query(sql, params);
  return rows as SoldRow[];
}
