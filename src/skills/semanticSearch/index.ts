// Week 6 skill entry point: semantic property search.
//
// "charming craftsman with mountain views and character" has few words in common
// with a listing that says "1920s bungalow, original woodwork, gorgeous views of the
// San Gabriels", but their embeddings are close. We embed the query, compare it with
// every stored listing embedding by cosine similarity, and return the top matches.
//
// Hybrid search: hard facts in the query (city, max price, beds, baths, sq ft, type,
// pool) are applied as normal SQL filters first, using the same parser and WHERE
// builder as the keyword search, so "craftsman in Pasadena under $1.5M" never returns
// a $3M home in Irvine. The embedding then ranks what's left by meaning.

import type { Pool } from "mysql2/promise";
import { parsePropertyQuery, type PropertyFilters } from "../propertySearch/parsePropertyQuery.js";
import { buildFilterWhere, COLUMNS, type ListingRow } from "../propertySearch/searchProperties.js";
import { toListingCard, type ListingCard } from "../propertySearch/formatCards.js";
import { cleanText, fromBlob, normalize, type Embedder } from "./embeddings.js";
import { EMBEDDING_TABLE } from "./store.js";

export const MAX_TOP_K = 50;
const MAX_CANDIDATES = 100_000; // safety cap on embeddings loaded per search

export interface SemanticSearchInput {
  query: string;
  topK?: number; // default 5 (the handbook's top_k)
  filters?: Partial<PropertyFilters>; // override what the parser found
  useFilters?: boolean; // default true; false = rank every embedded listing
  minScore?: number; // drop matches below this cosine similarity (default 0)
}

export interface SemanticMatch {
  listingId: string;
  score: number; // cosine similarity, higher = closer in meaning
  card: ListingCard;
  remarks: string | null;
}

export interface SemanticSearchOutput {
  query: string;
  filters: PropertyFilters;
  model: string;
  candidates: number; // embedded listings that passed the filters
  matches: SemanticMatch[];
  markdown: string;
}

const NO_FILTERS: PropertyFilters = {
  city: null, maxPrice: null, beds: null, baths: null, sqft: null, type: null, pool: null, hasView: null,
};

/** Candidates: embedded, active listings that pass the structured filters. */
export function buildCandidateSql(filters: PropertyFilters, model: string) {
  const { where, params } = buildFilterWhere(filters);
  const sql =
    "SELECT e.L_ListingID AS id, e.embedding " +
    `FROM ${EMBEDDING_TABLE} e JOIN rets_property ON rets_property.L_ListingID = e.L_ListingID ` +
    `WHERE e.model = ? AND ${where.join(" AND ")} LIMIT ${MAX_CANDIDATES}`;
  return { sql, params: [model, ...params] };
}

/** Full rows for the winners only (cards + remarks), so we don't load text for everything. */
export function buildDetailsSql(ids: (string | number)[]) {
  if (!ids.length) throw new Error("No listing ids");
  const sql = `SELECT ${COLUMNS}, L_Remarks FROM rets_property WHERE L_ListingID IN (${ids.map(() => "?").join(", ")})`;
  return { sql, params: ids };
}

/**
 * Top-k by cosine similarity. Vectors are normalized once, so each score is a single
 * dot product; this replaces the handbook's per-row sklearn cosine_similarity call,
 * which is very slow over thousands of listings.
 */
export function rankBySimilarity(
  query: ArrayLike<number>,
  candidates: { id: string; vec: ArrayLike<number> }[],
  topK: number,
  minScore = 0,
): { id: string; score: number }[] {
  const q = normalize(query);
  const scored: { id: string; score: number }[] = [];
  for (const c of candidates) {
    if (c.vec.length !== q.length) continue; // embedded with a different model or size
    const v = normalize(c.vec);
    let dot = 0;
    for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
    if (dot >= minScore) scored.push({ id: c.id, score: dot });
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, topK);
}

function snippet(text: string | null, max = 240): string | null {
  if (!text) return null;
  const t = cleanText(text);
  return t.length > max ? `${t.slice(0, max).replace(/\s+\S*$/, "")}…` : t;
}

export async function semanticSearch(pool: Pool, embedder: Embedder, input: SemanticSearchInput): Promise<SemanticSearchOutput> {
  const query = cleanText(input.query ?? "");
  if (!query) throw new Error("Describe the home you're looking for.");
  const topK = input.topK ?? 5;
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_TOP_K) throw new Error(`topK must be 1–${MAX_TOP_K}`);

  const filters: PropertyFilters =
    input.useFilters === false ? { ...NO_FILTERS } : { ...NO_FILTERS, ...parsePropertyQuery(query), ...(input.filters ?? {}) };

  // Embed the query and load candidates at the same time.
  const cand = buildCandidateSql(filters, embedder.model);
  const [[queryVec], [rows]] = await Promise.all([embedder.embed([query]), pool.query(cand.sql, cand.params)]);
  const candidates = (rows as { id: string | number; embedding: Buffer }[]).map((r) => ({
    id: String(r.id),
    vec: fromBlob(r.embedding),
  }));

  const top = rankBySimilarity(queryVec, candidates, topK, input.minScore ?? 0);

  let matches: SemanticMatch[] = [];
  if (top.length) {
    const det = buildDetailsSql(top.map((t) => t.id));
    const [detailRows] = await pool.query(det.sql, det.params);
    const byId = new Map((detailRows as (ListingRow & { L_Remarks: string | null })[]).map((r) => [String(r.L_ListingID), r]));
    matches = top
      .filter((t) => byId.has(t.id))
      .map((t) => {
        const row = byId.get(t.id)!;
        return { listingId: t.id, score: Math.round(t.score * 1000) / 1000, card: toListingCard(row), remarks: snippet(row.L_Remarks) };
      });
  }

  const out: SemanticSearchOutput = { query, filters, model: embedder.model, candidates: candidates.length, matches, markdown: "" };
  out.markdown = formatMarkdown(out);
  return out;
}

function filterSummary(f: PropertyFilters): string {
  const parts = [
    f.city && `in ${f.city}`,
    f.maxPrice !== null && `under $${f.maxPrice.toLocaleString("en-US")}`,
    f.beds !== null && `${f.beds}+ beds`,
    f.baths !== null && `${f.baths}+ baths`,
    f.sqft !== null && `${f.sqft.toLocaleString("en-US")}+ sq ft`,
    f.type,
    f.pool && "pool",
    f.hasView && "view",
  ].filter(Boolean);
  return parts.length ? ` (filtered: ${parts.join(", ")})` : "";
}

export function formatMarkdown(out: SemanticSearchOutput): string {
  const head = `### Listings similar to "${out.query}"${filterSummary(out.filters)}`;
  if (!out.candidates) {
    return `${head}\n\nNo embedded listings match these filters. If you haven't yet, run \`npm run embed\` to embed the active listings.`;
  }
  if (!out.matches.length) return `${head}\n\nNo listings were similar enough to this description.`;
  const cards = out.matches.map(
    (m, i) => `**${i + 1}.** _similarity ${m.score.toFixed(3)}_\n${m.card.markdown}` + (m.remarks ? `\n> ${m.remarks}` : ""),
  );
  return [head, `_Ranked ${out.candidates.toLocaleString("en-US")} listings by similarity of meaning._`, ...cards].join("\n\n");
}
