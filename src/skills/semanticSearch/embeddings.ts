// Week 6: OpenAI embeddings for listings and search queries.
//
// The handbook builds one text per listing from its key fields plus the free-text
// L_Remarks, embeds it with text-embedding-3-small, and compares it to the embedded
// query with cosine similarity. This file is the TypeScript version of
// get_embedding() and build_listing_embedding().

import { createHash } from "node:crypto";
import OpenAI from "openai";

export const DEFAULT_MODEL = "text-embedding-3-small";
const MAX_CHARS = 8000; // handbook's token-safety cut (~2k tokens, well under the 8k limit)
const BATCH_SIZE = 100; // texts per API request

/** Anything that turns texts into vectors. Tests use a fake one; the app uses OpenAI. */
export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Handbook get_embedding() clean-up: one line, trimmed, capped length. */
export function cleanText(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
}

export function openAiEmbedder(model = process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODEL): Embedder {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env (see .env.example).");
  }
  const client = new OpenAI(); // reads OPENAI_API_KEY from the environment
  return {
    model,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      // Batched: one request per 100 texts instead of one per listing.
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE).map(cleanText);
        const res = await client.embeddings.create({ model, input: batch });
        // The API returns one item per input, tagged with its position.
        for (const item of [...res.data].sort((a, b) => a.index - b.index)) out.push(item.embedding);
      }
      return out;
    },
  };
}

export interface ListingTextRow {
  L_ListingID: string | number;
  L_Type_: string | null;
  L_City: string | null;
  L_Keyword2: number | string | null;
  LM_Dec_3: number | string | null;
  LM_Int2_3: number | string | null;
  YearBuilt: number | string | null;
  L_SystemPrice: number | string | null;
  L_Remarks: string | null;
}

const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Handbook build_listing_embedding() text. Missing fields are left out instead of
 * printing "null beds" (and the handbook's f"{price:,}" would crash on a NULL price;
 * mysql2 also returns DECIMAL prices as strings).
 */
export function listingText(row: ListingTextRow): string {
  const beds = num(row.L_Keyword2);
  const baths = num(row.LM_Dec_3);
  const sqft = num(row.LM_Int2_3);
  const year = num(row.YearBuilt);
  const price = num(row.L_SystemPrice);
  const lines = [
    [row.L_Type_ ?? "Home", row.L_City ? `in ${row.L_City}, CA.` : "in CA."].join(" "),
    [beds !== null && `${beds} beds`, baths !== null && `${baths} baths`].filter(Boolean).join(", ") + ".",
    [sqft !== null && `${int.format(sqft)} sq ft.`, year !== null && `Built ${year}.`].filter(Boolean).join(" "),
    price !== null ? `Price: $${int.format(price)}.` : "",
    row.L_Remarks ?? "",
  ];
  return cleanText(lines.filter((l) => l && l !== ".").join("\n"));
}

/** Hash of the embedded text, so unchanged listings aren't re-embedded (and re-billed). */
export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------- vectors ----------

/** Store vectors as float32 bytes: 1536 dims = 6 KB per listing instead of ~30 KB of JSON. */
export function toBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function fromBlob(buf: Buffer | Uint8Array): Float32Array {
  // Copy into an aligned buffer; a MySQL BLOB's byteOffset may not be a multiple of 4.
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);
  return new Float32Array(bytes.buffer);
}

export function normalize(vec: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/** Cosine similarity, same as sklearn's cosine_similarity for a single pair. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`Vector sizes differ: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
