// Turns parsed filters into a parameterized query against rets_property.
// Values are always passed as ? parameters, never concatenated into the SQL string.
//
// The handbook lists "True" for PoolPrivateYN / ViewYN, but the imported data stores
// yes as "1" (otherwise "" or NULL), so those flags are matched against "1".
const DB_YES = "1";

import type { Pool } from "mysql2/promise";
import type { PropertyFilters } from "./parsePropertyQuery.js";
import { decodeCursor, encodeCursor, SORTS, type SortKey } from "./pagination.js";

export const MAX_PAGE_SIZE = 50;
const MAX_OFFSET_PAGE = 100; // deeper than this, use the cursor

export interface ListingRow {
  L_ListingID: string | number;
  L_DisplayId: string | null;
  L_Address: string | null;
  L_City: string | null;
  L_Zip: string | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  type: string | null;
  status: string | null;
  lat: number | null;
  lng: number | null;
  YearBuilt: number | null;
  AssociationFee: number | null;
  DaysOnMarket: number | null;
  PoolPrivateYN: string | null;
  ViewYN: string | null;
  FireplaceYN: string | null;
  PhotoCount: number | null;
  LA1_UserFirstName: string | null;
  LA1_UserLastName: string | null;
  LO1_OrganizationName: string | null;
}

export interface SearchOptions {
  limit?: number; // results per page, 1–50 (default 10)
  sort?: SortKey; // default price_asc
  cursor?: string | null; // nextCursor from the previous page (preferred)
  page?: number; // 1-based page number, if not using the cursor
}

const COLUMNS =
  "L_ListingID, L_DisplayId, L_Address, L_City, L_Zip, " +
  "L_SystemPrice AS price, L_Keyword2 AS beds, LM_Dec_3 AS baths, " +
  "LM_Int2_3 AS sqft, L_Type_ AS type, L_Status AS status, " +
  "LMD_MP_Latitude AS lat, LMD_MP_Longitude AS lng, " +
  "YearBuilt, AssociationFee, DaysOnMarket, " +
  "PoolPrivateYN, ViewYN, FireplaceYN, PhotoCount, " +
  "LA1_UserFirstName, LA1_UserLastName, LO1_OrganizationName";

function wholeNumber(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export function buildPropertySql(filters: PropertyFilters, options: SearchOptions = {}) {
  const sort = options.sort ?? "price_asc";
  if (!Object.hasOwn(SORTS, sort)) throw new Error(`Unknown sort: ${sort}`);
  const order = SORTS[sort];
  const limit = wholeNumber(options.limit, "limit", 1, MAX_PAGE_SIZE, 10);
  const page = wholeNumber(options.page, "page", 1, MAX_OFFSET_PAGE, 1);

  // Only active listings. Bound as a parameter: a double-quoted "Active" in the
  // SQL text is read as a column name when MySQL runs with ANSI_QUOTES.
  const where: string[] = ["L_Status = ?"];
  const params: (string | number)[] = ["Active"];

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

  // Rows without a sort value can't be paged by keyset, so leave them out.
  where.push(`${order.column} IS NOT NULL`);

  let offset = 0;
  if (options.cursor) {
    const c = decodeCursor(options.cursor, sort);
    const op = order.dir === "ASC" ? ">" : "<";
    where.push(`(${order.column} ${op} ? OR (${order.column} = ? AND L_ListingID ${op} ?))`);
    params.push(c.v, c.v, c.id);
  } else {
    offset = (page - 1) * limit;
  }

  // L_ListingID breaks ties so the order is stable and no row is skipped or repeated.
  // One extra row is fetched to tell whether another page exists without a COUNT(*).
  // limit and offset are validated integers above, so inlining them is safe.
  const sql =
    `SELECT ${COLUMNS} FROM rets_property WHERE ${where.join(" AND ")}` +
    ` ORDER BY ${order.column} ${order.dir}, L_ListingID ${order.dir}` +
    ` LIMIT ${limit + 1}` +
    (offset ? ` OFFSET ${offset}` : "");

  return { sql, params, limit, sort };
}

export interface SearchResult {
  rows: ListingRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function searchProperties(
  pool: Pool,
  filters: PropertyFilters,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const { sql, params, limit, sort } = buildPropertySql(filters, options);
  const [result] = await pool.query(sql, params);
  const rows = result as ListingRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1] as unknown as Record<string, unknown>;
    nextCursor = encodeCursor({
      s: sort,
      v: Number(last[SORTS[sort].rowField]),
      id: last.L_ListingID as string | number,
    });
  }
  return { rows: page, hasMore, nextCursor };
}
