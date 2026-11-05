import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "mysql2/promise";
import {
  cleanText,
  cosine,
  fromBlob,
  listingText,
  textHash,
  toBlob,
  type Embedder,
  type ListingTextRow,
} from "../src/skills/semanticSearch/embeddings.js";
import { buildIndexPageSql, indexListings } from "../src/skills/semanticSearch/store.js";
import { buildCandidateSql, buildDetailsSql, rankBySimilarity, semanticSearch } from "../src/skills/semanticSearch/index.js";
import { parsePropertyQuery } from "../src/skills/propertySearch/parsePropertyQuery.js";

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

// A tiny stand-in for OpenAI: words with related meanings land on the same axis, so
// "craftsman" and "bungalow" are close even though they share no letters.
const CONCEPTS = [
  ["craftsman", "bungalow", "1920s", "woodwork", "character", "charming", "historic"],
  ["mountain", "mountains", "hills", "foothills", "views", "vistas"],
  ["modern", "contemporary", "sleek", "minimalist"],
  ["beach", "ocean", "coastal", "surf"],
];
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: "fake-embedding",
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((t) => {
        const words = t.toLowerCase().split(/[^a-z0-9]+/);
        const v = CONCEPTS.map((group) => words.filter((w) => group.includes(w)).length);
        return [...v, 0.01]; // small constant so no vector is all zeros
      });
    },
  };
}

// ---------- text and vectors ----------

test("listing text follows the handbook template and skips missing fields", () => {
  const row: ListingTextRow = {
    L_ListingID: 1, L_Type_: "SingleFamilyResidence", L_City: "Pasadena", L_Keyword2: 3, LM_Dec_3: "2.00",
    LM_Int2_3: 1850, YearBuilt: 1924, L_SystemPrice: "1495000.00", L_Remarks: "Charming 1920s craftsman.\nOriginal woodwork.",
  };
  assert.equal(
    listingText(row),
    "SingleFamilyResidence in Pasadena, CA. 3 beds, 2 baths. 1,850 sq ft. Built 1924. Price: $1,495,000. Charming 1920s craftsman. Original woodwork.",
  );
  const sparse = listingText({ ...row, L_Keyword2: null, LM_Dec_3: null, YearBuilt: null, L_SystemPrice: null, L_Remarks: null });
  assert.ok(!sparse.includes("null") && !sparse.includes("NaN") && !sparse.includes("$"));
  assert.equal(cleanText("a".repeat(9000)).length, 8000);
});

test("vectors round-trip through a float32 BLOB, even when unaligned", () => {
  const v = [0.25, -1.5, 3, 0.125];
  const blob = toBlob(v);
  assert.equal(blob.length, 16);
  const unaligned = Buffer.concat([Buffer.from([9]), blob]).subarray(1); // byteOffset 1
  assert.deepEqual([...fromBlob(unaligned)], v);
});

test("cosine similarity matches the definition", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 2]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
  assert.throws(() => cosine([1], [1, 2]));
});

test("ranking returns top-k by cosine, highest first, and skips wrong-size vectors", () => {
  const ranked = rankBySimilarity(
    [1, 0],
    [
      { id: "a", vec: [0, 1] },
      { id: "b", vec: [5, 1] },
      { id: "c", vec: [1, 1] },
      { id: "d", vec: [1, 0, 0] },
    ],
    2,
  );
  assert.deepEqual(ranked.map((r) => r.id), ["b", "c"]);
  assert.ok(ranked[0].score > ranked[1].score);
});

// ---------- safe SQL ----------

test("candidate SQL reuses the Week 3 filters, all bound as parameters", () => {
  const f = parsePropertyQuery("charming craftsman in Pasadena' OR '1'='1 under $1.5M with 3 beds");
  const { sql, params } = buildCandidateSql(f, "text-embedding-3-small");
  assert.equal(placeholders(sql), params.length);
  assert.equal(params[0], "text-embedding-3-small");
  assert.ok(params.includes("Active") && params.includes(1_500_000) && params.includes(3));
  assert.ok(!sql.includes("Pasadena") && !sql.includes('"'));
  const det = buildDetailsSql(["1", "2"]);
  assert.equal(placeholders(det.sql), 2);
  const page = buildIndexPageSql(0, 200, "m", "Irvine");
  assert.equal(placeholders(page.sql), page.params.length);
  assert.throws(() => buildIndexPageSql(0, 5000, "m"));
});

// ---------- indexing and search with a fake database ----------

const LISTINGS = [
  { id: 1, city: "Pasadena", price: 1_400_000, remarks: "Charming 1920s bungalow with original woodwork and views of the foothills." },
  { id: 2, city: "Pasadena", price: 2_100_000, remarks: "Sleek contemporary build, minimalist finishes." },
  { id: 3, city: "Irvine", price: 1_200_000, remarks: "Modern townhome near shopping." },
  { id: 4, city: "Laguna Beach", price: 3_500_000, remarks: "Coastal retreat steps from the ocean and surf." },
];

function fakeDb() {
  const store = new Map<number, { model: string; text_hash: string; embedding: Buffer }>();
  const calls: string[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push(sql);
      if (sql.startsWith("CREATE TABLE")) return [[], []];
      if (sql.startsWith("INSERT INTO listing_embeddings")) {
        for (const [id, model, hash, , blob] of params[0] as [number, string, string, number, Buffer][]) {
          store.set(id, { model, text_hash: hash, embedding: blob });
        }
        return [{}, []];
      }
      if (sql.includes("LEFT JOIN listing_embeddings")) {
        const [model, , afterId] = params as [string, string, number];
        const rows = LISTINGS.filter((l) => l.id > afterId).map((l) => ({
          L_ListingID: l.id, L_Type_: "SingleFamilyResidence", L_City: l.city, L_Keyword2: 3, LM_Dec_3: 2,
          LM_Int2_3: 1800, YearBuilt: 1990, L_SystemPrice: l.price, L_Remarks: l.remarks,
          storedHash: store.get(l.id)?.model === model ? store.get(l.id)!.text_hash : null,
        }));
        return [rows, []];
      }
      if (sql.includes("FROM listing_embeddings e JOIN")) {
        // Apply the city and max-price filters the way MySQL would.
        const city = sql.includes("L_City = ?") ? (params[2] as string) : null;
        const maxPrice = sql.includes("L_SystemPrice <= ?") ? (params[city ? 3 : 2] as number) : null;
        const rows = LISTINGS.filter((l) => (!city || l.city === city) && (maxPrice === null || l.price <= maxPrice))
          .filter((l) => store.has(l.id))
          .map((l) => ({ id: l.id, embedding: store.get(l.id)!.embedding }));
        return [rows, []];
      }
      if (sql.includes("WHERE L_ListingID IN")) {
        const rows = LISTINGS.filter((l) => (params as string[]).includes(String(l.id))).map((l) => ({
          L_ListingID: l.id, L_DisplayId: `MLS${l.id}`, L_Address: `${l.id} Main St`, L_City: l.city, L_Zip: "91101",
          price: l.price, beds: 3, baths: 2, sqft: 1800, type: "SingleFamilyResidence", status: "Active",
          lat: null, lng: null, YearBuilt: 1990, AssociationFee: null, DaysOnMarket: 5, PoolPrivateYN: "", ViewYN: "",
          FireplaceYN: "", PhotoCount: 10, LA1_UserFirstName: "Ana", LA1_UserLastName: "Lee", LO1_OrganizationName: "Realty",
          L_Remarks: l.remarks,
        }));
        return [rows, []];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as Pool;
  return { pool, store, calls };
}

test("indexing embeds each listing once and skips unchanged ones on re-run", async () => {
  const { pool, store } = fakeDb();
  const embedder = fakeEmbedder();
  const first = await indexListings(pool, embedder, { batchSize: 3 });
  assert.deepEqual(first, { scanned: 4, embedded: 4, skipped: 0 });
  assert.equal(store.size, 4);
  assert.equal(store.get(1)!.text_hash, textHash(embedder.calls[0][0]));
  const second = await indexListings(pool, embedder, { batchSize: 3 });
  assert.deepEqual(second, { scanned: 4, embedded: 0, skipped: 4 });
});

test("semantic search finds the craftsman with no keyword overlap", async () => {
  const { pool } = fakeDb();
  const embedder = fakeEmbedder();
  await indexListings(pool, embedder);
  const out = await semanticSearch(pool, embedder, { query: "charming craftsman with mountain views and character", topK: 2 });
  assert.equal(out.candidates, 4);
  assert.equal(out.matches[0].listingId, "1"); // "bungalow ... foothills", not "craftsman ... mountain"
  assert.match(out.matches[0].remarks!, /1920s bungalow/);
  assert.match(out.markdown, /similarity/);
});

test("hard facts in the query filter before ranking", async () => {
  const { pool } = fakeDb();
  const embedder = fakeEmbedder();
  await indexListings(pool, embedder);
  const out = await semanticSearch(pool, embedder, { query: "modern home in Pasadena under $3M", topK: 5 });
  assert.equal(out.filters.city, "Pasadena");
  assert.deepEqual(out.matches.map((m) => m.listingId), ["2", "1"]); // Irvine's modern townhome is filtered out
  const all = await semanticSearch(pool, embedder, { query: "modern home in Pasadena under $3M", useFilters: false, topK: 2 });
  assert.equal(all.candidates, 4);
});

test("empty index and bad input give clear messages", async () => {
  const { pool } = fakeDb();
  const embedder = fakeEmbedder();
  const out = await semanticSearch(pool, embedder, { query: "craftsman" });
  assert.equal(out.matches.length, 0);
  assert.match(out.markdown, /npm run embed/);
  await assert.rejects(semanticSearch(pool, embedder, { query: "   " }), /Describe/);
  await assert.rejects(semanticSearch(pool, embedder, { query: "craftsman", topK: 0 }), /topK/);
});
