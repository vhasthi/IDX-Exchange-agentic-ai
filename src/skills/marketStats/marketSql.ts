// Week 5: parameterized SQL for market statistics.
//
// Same rules as Week 3: every user value is a bound ? parameter, string constants
// ('Residential', 'Active') are bound too (double-quoted literals break under
// ANSI_QUOTES), and the only things inlined into the SQL text are column names from
// a fixed whitelist and validated integers.
//
// california_sold stores CloseDate as VARCHAR 'YYYY-MM-DD', so LEFT(CloseDate, 7)
// is the close month and string/date comparisons against CURDATE() work.

export interface MarketScope {
  city?: string | null;
  zip?: string | null; // 5-digit ZIP (PostalCode / L_Zip)
  type?: string | null; // PropertySubType / L_Type_, e.g. "Condominium"
  months?: number; // look-back window in months, 1–60 (default 12)
}

/** What to group by. "none" = one row for the whole scope. */
export type GroupBy = "none" | "city" | "zip" | "type" | "month";

// Whitelisted group keys (never built from user input).
const GROUP_COLUMNS: Record<Exclude<GroupBy, "none">, string> = {
  city: "City",
  zip: "PostalCode",
  type: "PropertySubType",
  month: "LEFT(CloseDate, 7)",
};

export const MAX_GROUPS = 60;

export function isGroupBy(v: unknown): v is GroupBy {
  return typeof v === "string" && (v === "none" || Object.hasOwn(GROUP_COLUMNS, v));
}

function wholeNumber(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function shortText(v: string | null | undefined, name: string): string | null {
  if (v === null || v === undefined || !String(v).trim()) return null;
  const s = String(v).trim();
  if (s.length > 80) throw new Error(`${name} must be short text`);
  return s;
}

function checkZip(zip: string | null | undefined): string | null {
  if (zip === null || zip === undefined || zip === "") return null;
  if (!/^\d{5}$/.test(String(zip))) throw new Error("zip must be a 5-digit ZIP code");
  return String(zip);
}

/** WHERE clause for closed residential sales in the scope and window. */
export function soldWhere(scope: MarketScope) {
  const months = wholeNumber(scope.months, "months", 1, 60, 12);
  const where = [
    "PropertyType = ?",
    "ClosePrice > 0",
    "CloseDate >= DATE_SUB(CURDATE(), INTERVAL ? MONTH)",
    "CloseDate <= CURDATE()", // the data has a few far-future close dates (typos)
  ];
  const params: (string | number)[] = ["Residential", months];

  const city = shortText(scope.city, "city");
  const zip = checkZip(scope.zip);
  const type = shortText(scope.type, "type");
  if (city) {
    where.push("City = ?");
    params.push(city);
  }
  if (zip) {
    where.push("PostalCode = ?");
    params.push(zip);
  }
  if (type) {
    where.push("PropertySubType = ?");
    params.push(type);
  }
  return { where: where.join(" AND "), params, months };
}

// Price per sq ft only where LivingArea is real; list-to-close only where the ratio is
// plausible (a few rows have list prices off by 10x, which would wreck the average).
const PPSF = "ClosePrice / NULLIF(LivingArea, 0)";
const RATIO = "CASE WHEN ListPrice > 0 AND ClosePrice / ListPrice BETWEEN 0.5 AND 2 THEN ClosePrice / ListPrice END";
const ORIG_RATIO =
  "CASE WHEN OriginalListPrice > 0 AND ClosePrice / OriginalListPrice BETWEEN 0.5 AND 2 THEN ClosePrice / OriginalListPrice END";

/**
 * Averages, grouped. This is the handbook's city market summary query, generalized:
 * group by city, ZIP, property type, close month, or nothing. Medians come from
 * buildPriceListSql (MySQL has no MEDIAN aggregate).
 */
export function buildAggregateSql(scope: MarketScope, groupBy: GroupBy = "none", options: { minSales?: number; limit?: number } = {}) {
  if (!isGroupBy(groupBy)) throw new Error(`Unknown groupBy: ${String(groupBy)}`);
  const minSales = wholeNumber(options.minSales, "minSales", 1, 10_000, groupBy === "none" || groupBy === "month" ? 1 : 5);
  const limit = wholeNumber(options.limit, "limit", 1, MAX_GROUPS, groupBy === "month" ? 60 : 20);
  const { where, params } = soldWhere(scope);

  const key = groupBy === "none" ? null : GROUP_COLUMNS[groupBy];
  const select = [
    key ? `${key} AS grp` : null,
    "COUNT(*) AS sales",
    "AVG(ClosePrice) AS avgClosePrice",
    `AVG(${PPSF}) AS avgPricePerSqft`,
    "AVG(DaysOnMarket) AS avgDaysOnMarket",
    `AVG(${RATIO}) AS avgListToClose`,
    `AVG(${ORIG_RATIO}) AS avgOrigListToClose`,
    "MIN(CloseDate) AS firstClose",
    "MAX(CloseDate) AS lastClose",
  ].filter(Boolean);

  let sql = `SELECT ${select.join(", ")} FROM california_sold WHERE ${where}`;
  if (key) {
    sql += ` AND ${key} IS NOT NULL AND ${key} <> ? GROUP BY grp HAVING COUNT(*) >= ${minSales}`;
    params.push("");
    sql += groupBy === "month" ? " ORDER BY grp ASC" : " ORDER BY sales DESC, grp ASC";
    sql += ` LIMIT ${limit}`;
  }
  return { sql, params };
}

/** Raw close prices (and $/sqft) per group, for medians computed in TypeScript. */
export const MAX_PRICE_ROWS = 200_000;

export function buildPriceListSql(scope: MarketScope, groupBy: GroupBy = "none") {
  if (!isGroupBy(groupBy)) throw new Error(`Unknown groupBy: ${String(groupBy)}`);
  const { where, params } = soldWhere(scope);
  const key = groupBy === "none" ? "NULL" : GROUP_COLUMNS[groupBy];
  const sql =
    `SELECT ${key} AS grp, ClosePrice AS price, ${PPSF} AS ppsf ` +
    `FROM california_sold WHERE ${where} LIMIT ${MAX_PRICE_ROWS}`;
  return { sql, params };
}

/** Active inventory from rets_property for the same city / ZIP / type. */
export function buildActiveInventorySql(scope: MarketScope) {
  const where = ["L_Status = ?"];
  const params: string[] = ["Active"];
  const city = shortText(scope.city, "city");
  const zip = checkZip(scope.zip);
  const type = shortText(scope.type, "type");
  if (city) {
    where.push("L_City = ?");
    params.push(city);
  }
  if (zip) {
    where.push("L_Zip = ?");
    params.push(zip);
  }
  if (type) {
    where.push("L_Type_ = ?");
    params.push(type);
  }
  const sql =
    "SELECT COUNT(*) AS activeCount, AVG(L_SystemPrice) AS avgListPrice, " +
    "AVG(L_SystemPrice / NULLIF(LM_Int2_3, 0)) AS avgListPricePerSqft " +
    `FROM rets_property WHERE ${where.join(" AND ")}`;
  return { sql, params };
}
