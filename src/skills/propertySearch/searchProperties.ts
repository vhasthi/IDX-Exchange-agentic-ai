// Turns parsed filters into a parameterized query against rets_property.
// Values are always passed as ? parameters, never concatenated into the SQL string.
//
// The handbook lists "True" for PoolPrivateYN / ViewYN, but the imported data stores
// yes as "1" (otherwise "" or NULL), so those flags are matched against "1".
const DB_YES = "1";

import type { Pool } from "mysql2/promise";
import type { PropertyFilters } from "./parsePropertyQuery.js";

export function buildPropertySql(filters: PropertyFilters, limit = 20) {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.city) {
    where.push("L_City = ?");
    params.push(filters.city);
  }
  if (filters.maxPrice !== null) {
    where.push("L_SystemPrice <= ?");
    params.push(filters.maxPrice);
  }
  if (filters.beds !== null) {
    where.push("L_Keyword2 >= ?");
    params.push(filters.beds);
  }
  if (filters.baths !== null) {
    where.push("LM_Dec_3 >= ?");
    params.push(filters.baths);
  }
  if (filters.sqft !== null) {
    where.push("LM_Int2_3 >= ?");
    params.push(filters.sqft);
  }
  if (filters.type) {
    where.push("L_Type_ = ?");
    params.push(filters.type);
  }
  if (filters.pool) {
    where.push("PoolPrivateYN = ?");
    params.push(DB_YES);
  }
  if (filters.hasView) {
    where.push("ViewYN = ?");
    params.push(DB_YES);
  }

  const sql =
    "SELECT L_ListingID, L_Address, L_City, L_SystemPrice, L_Keyword2 AS beds, " +
    "LM_Dec_3 AS baths, LM_Int2_3 AS sqft, L_Type_ AS type " +
    "FROM rets_property" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY L_SystemPrice ASC" +
    ` LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}`;

  return { sql, params };
}

export async function searchProperties(pool: Pool, filters: PropertyFilters, limit = 20) {
  const { sql, params } = buildPropertySql(filters, limit);
  const [rows] = await pool.query(sql, params);
  return rows;
}
