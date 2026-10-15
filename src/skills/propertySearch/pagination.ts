// Keyset ("seek") pagination for rets_property.
//
// OFFSET makes MySQL read and throw away every skipped row, so page 50 is much
// slower than page 1. Instead, the next page starts right after the last row
// of the previous one:  WHERE (sortValue, L_ListingID) > (lastValue, lastId).
// The cursor handed to the agent is an opaque base64url token that is decoded
// and type-checked before any of it reaches SQL (and even then only as ? params).

export type SortKey = "price_asc" | "price_desc" | "newest" | "sqft_desc";

/** Whitelisted sort orders. Column names never come from user input. */
export const SORTS: Record<SortKey, { column: string; dir: "ASC" | "DESC"; rowField: string }> = {
  price_asc: { column: "L_SystemPrice", dir: "ASC", rowField: "price" },
  price_desc: { column: "L_SystemPrice", dir: "DESC", rowField: "price" },
  newest: { column: "DaysOnMarket", dir: "ASC", rowField: "DaysOnMarket" },
  sqft_desc: { column: "LM_Int2_3", dir: "DESC", rowField: "sqft" },
};

export function isSortKey(value: unknown): value is SortKey {
  return typeof value === "string" && Object.hasOwn(SORTS, value);
}

export interface Cursor {
  s: SortKey; // sort the cursor belongs to
  v: number; // last row's sort value
  id: string | number; // last row's L_ListingID (tiebreaker)
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(token: string, sort: SortKey): Cursor {
  let c: Partial<Cursor> | null = null;
  try {
    c = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    /* handled below */
  }
  if (
    !c ||
    typeof c.v !== "number" ||
    !Number.isFinite(c.v) ||
    (typeof c.id !== "string" && typeof c.id !== "number")
  ) {
    throw new Error("Invalid cursor");
  }
  if (c.s !== sort) {
    throw new Error("This cursor belongs to a different sort order; start again without a cursor");
  }
  return c as Cursor;
}
