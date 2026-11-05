// Week 6: keep listing embeddings in MySQL, next to the listings, so they are
// computed once (and paid for once) instead of on every search.

import type { Pool } from "mysql2/promise";
import { listingText, textHash, toBlob, type Embedder, type ListingTextRow } from "./embeddings.js";

export const EMBEDDING_TABLE = "listing_embeddings";

export const CREATE_TABLE_SQL =
  `CREATE TABLE IF NOT EXISTS ${EMBEDDING_TABLE} (` +
  "L_ListingID BIGINT NOT NULL PRIMARY KEY, " +
  "model VARCHAR(64) NOT NULL, " +
  "text_hash CHAR(64) NOT NULL, " +
  "dims SMALLINT UNSIGNED NOT NULL, " +
  "embedding MEDIUMBLOB NOT NULL, " +
  "updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
  ")";

export interface IndexOptions {
  city?: string | null; // only embed listings in this city
  limit?: number; // stop after this many listings (for a cheap first run)
  batchSize?: number; // listings read from MySQL per round (default 200)
  onProgress?: (done: number, embedded: number) => void;
}

export interface IndexResult {
  scanned: number; // active listings looked at
  embedded: number; // new or changed listings sent to the API
  skipped: number; // already embedded with the same text and model
}

const TEXT_COLUMNS =
  "p.L_ListingID, p.L_Type_, p.L_City, p.L_Keyword2, p.LM_Dec_3, p.LM_Int2_3, " +
  "p.YearBuilt, p.L_SystemPrice, p.L_Remarks";

/** One page of active listings after `afterId`, with any stored hash for this model. */
export function buildIndexPageSql(afterId: number | string, batchSize: number, model: string, city?: string | null) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("batchSize must be 1–1000");
  const where = ["p.L_Status = ?", "p.L_ListingID > ?"];
  const params: (string | number)[] = [model, "Active", afterId];
  if (city) {
    where.push("p.L_City = ?");
    params.push(city);
  }
  const sql =
    `SELECT ${TEXT_COLUMNS}, e.text_hash AS storedHash ` +
    `FROM rets_property p LEFT JOIN ${EMBEDDING_TABLE} e ON e.L_ListingID = p.L_ListingID AND e.model = ? ` +
    `WHERE ${where.join(" AND ")} ORDER BY p.L_ListingID LIMIT ${batchSize}`;
  return { sql, params };
}

/**
 * Embed every active listing that is new or whose text changed since the last run.
 * Safe to re-run: unchanged listings are skipped, and it pages by L_ListingID so it
 * can be stopped and restarted.
 */
export async function indexListings(pool: Pool, embedder: Embedder, options: IndexOptions = {}): Promise<IndexResult> {
  await pool.query(CREATE_TABLE_SQL);
  const batchSize = options.batchSize ?? 200;
  const limit = options.limit ?? Infinity;
  const result: IndexResult = { scanned: 0, embedded: 0, skipped: 0 };
  let afterId: number | string = 0;

  while (result.scanned < limit) {
    const size = Math.min(batchSize, limit - result.scanned);
    const { sql, params } = buildIndexPageSql(afterId, size, embedder.model, options.city);
    const [rows] = await pool.query(sql, params);
    const page = rows as (ListingTextRow & { storedHash: string | null })[];
    if (!page.length) break;
    afterId = page[page.length - 1].L_ListingID;
    result.scanned += page.length;

    const todo = page
      .map((row) => ({ row, text: listingText(row) }))
      .map((t) => ({ ...t, hash: textHash(t.text) }))
      .filter((t) => t.hash !== t.row.storedHash);
    result.skipped += page.length - todo.length;

    if (todo.length) {
      const vectors = await embedder.embed(todo.map((t) => t.text));
      const values = todo.map((t, i) => [t.row.L_ListingID, embedder.model, t.hash, vectors[i].length, toBlob(vectors[i])]);
      await pool.query(
        `INSERT INTO ${EMBEDDING_TABLE} (L_ListingID, model, text_hash, dims, embedding) VALUES ? ` +
          "ON DUPLICATE KEY UPDATE model = VALUES(model), text_hash = VALUES(text_hash), " +
          "dims = VALUES(dims), embedding = VALUES(embedding)",
        [values],
      );
      result.embedded += todo.length;
    }
    options.onProgress?.(result.scanned, result.embedded);
  }
  return result;
}
