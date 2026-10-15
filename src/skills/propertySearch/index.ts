// Week 3 skill entry point: natural-language query (or Week 2 filters) in,
// property cards out. Picks rets_property, california_sold, or both.

import type { Pool } from "mysql2/promise";
import { parsePropertyQuery, type PropertyFilters } from "./parsePropertyQuery.js";
import { isSortKey, type SortKey } from "./pagination.js";
import { searchProperties } from "./searchProperties.js";
import { getSoldComps } from "./soldComps.js";
import { compStats, statsLine, toListingCard, toSoldCard, type CompStats, type ListingCard, type SoldCard } from "./formatCards.js";

export type Intent = "active" | "sold" | "both";

export interface PropertySearchInput {
  query?: string; // free text, parsed with the Week 2 parser
  filters?: Partial<PropertyFilters>; // or filters directly (override what the parser found)
  intent?: Intent; // default: detected from the query, else "active"
  months?: number; // sold look-back window (default: from the query, else 12)
  sort?: SortKey;
  limit?: number;
  cursor?: string | null;
  page?: number;
}

export interface PropertySearchOutput {
  intent: Intent;
  filters: PropertyFilters;
  active?: { cards: ListingCard[]; hasMore: boolean; nextCursor: string | null };
  sold?: { months: number; cards: SoldCard[]; stats: CompStats };
  markdown: string;
}

const SOLD_WORDS = /\b(sold|sales|comps?|comparables?|closed|sell(?:ing)? for|went for)\b/i;
const ACTIVE_WORDS = /\b(for sale|listings?|available|on the market|active)\b/i;

/** Decide which table(s) a free-text question is about. */
export function detectIntent(query: string): Intent {
  const sold = SOLD_WORDS.test(query);
  if (!sold) return "active";
  return ACTIVE_WORDS.test(query) ? "both" : "sold";
}

/** "last 6 months", "past 2 years", "past year" → months (1–60). */
export function parseMonths(query: string): number | null {
  const m = query.match(/\b(?:last|past)\s+(\d+)?\s*(month|year)s?\b/i);
  if (!m) return null;
  const n = (m[1] ? Number(m[1]) : 1) * (m[2].toLowerCase() === "year" ? 12 : 1);
  return Math.min(Math.max(n, 1), 60);
}

const EMPTY: PropertyFilters = {
  city: null, maxPrice: null, beds: null, baths: null, sqft: null, type: null, pool: null, hasView: null,
};

function checkFilters(f: PropertyFilters): PropertyFilters {
  for (const key of ["maxPrice", "beds", "baths", "sqft"] as const) {
    const v = f[key];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new Error(`${key} must be a non-negative number`);
    }
  }
  for (const key of ["city", "type"] as const) {
    const v = f[key];
    if (v !== null && (typeof v !== "string" || v.length > 80)) throw new Error(`${key} must be short text`);
  }
  for (const key of ["pool", "hasView"] as const) {
    if (f[key] !== null && f[key] !== "True") throw new Error(`${key} must be "True" or null`);
  }
  return f;
}

export async function runPropertySearch(pool: Pool, input: PropertySearchInput): Promise<PropertySearchOutput> {
  const query = input.query ?? "";
  const filters = checkFilters({ ...EMPTY, ...(query ? parsePropertyQuery(query) : {}), ...(input.filters ?? {}) });
  const intent: Intent = input.intent ?? (query ? detectIntent(query) : "active");
  if (!["active", "sold", "both"].includes(intent)) throw new Error(`Unknown intent: ${intent}`);
  if (input.sort !== undefined && !isSortKey(input.sort)) throw new Error(`Unknown sort: ${input.sort}`);
  const months = input.months ?? parseMonths(query) ?? 12;

  const wantActive = intent !== "sold";
  const wantSold = intent !== "active";
  if (wantSold && !filters.city) throw new Error("Which city? Sold comps need a city.");

  const [active, soldRows] = await Promise.all([
    wantActive
      ? searchProperties(pool, filters, { sort: input.sort, limit: input.limit, cursor: input.cursor, page: input.page })
      : null,
    wantSold ? getSoldComps(pool, filters.city!, { months, beds: filters.beds, subType: filters.type }) : null,
  ]);

  const out: PropertySearchOutput = { intent, filters, markdown: "" };
  const sections: string[] = [];

  if (active) {
    const cards = active.rows.map(toListingCard);
    out.active = { cards, hasMore: active.hasMore, nextCursor: active.nextCursor };
    sections.push(
      cards.length
        ? [`### Active listings (${cards.length}${active.hasMore ? "+" : ""})`, ...cards.map((c) => c.markdown)].join("\n\n") +
            (active.hasMore ? "\n\n_More results available: pass `nextCursor` for the next page._" : "")
        : "### Active listings\n\nNo active listings match these filters.",
    );
  }

  if (soldRows) {
    const cards = soldRows.map(toSoldCard);
    const stats = compStats(cards);
    out.sold = { months, cards, stats };
    sections.push(["### Recent sales", statsLine(filters.city!, months, stats), ...cards.map((c) => c.markdown)].join("\n\n"));
  }

  out.markdown = sections.join("\n\n---\n\n");
  return out;
}
