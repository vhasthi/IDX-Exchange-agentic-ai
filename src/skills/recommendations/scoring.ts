// Week 7: hybrid similarity score between a listing the user likes and a candidate.
//
// Handbook model: up to 60 points for structured similarity (price, beds, city, sq ft)
// plus up to 40 points for semantic similarity (cosine of the two listing embeddings).
// Missing values earn no points instead of crashing (the handbook's abs(a - b) fails
// on NULL), and a negative cosine counts as 0 rather than subtracting points.

import { toNum } from "../marketStats/stats.js";

export interface ScoredFields {
  price: number | string | null;
  beds: number | string | null;
  city: string | null;
  sqft: number | string | null;
}

export interface ScoreBreakdown {
  price: number; // 0, 5, 12 or 20
  beds: number; // 0 or 15
  city: number; // 0 or 15
  sqft: number; // 0, 5 or 10
  structured: number; // sum of the above, max 60
  semantic: number | null; // cosine × 40, max 40; null when either listing has no embedding
  total: number; // structured + semantic, rounded to 2 decimals
}

export const STRUCTURED_MAX = 60;
export const SEMANTIC_MAX = 40;

export function pricePoints(a: unknown, b: unknown): number {
  const x = toNum(a);
  const y = toNum(b);
  if (x === null || y === null) return 0;
  const diff = Math.abs(x - y);
  if (diff < 50_000) return 20;
  if (diff < 150_000) return 12;
  if (diff < 300_000) return 5;
  return 0;
}

export function sqftPoints(a: unknown, b: unknown): number {
  const x = toNum(a);
  const y = toNum(b);
  if (x === null || y === null || x <= 0 || y <= 0) return 0;
  const diff = Math.abs(x - y);
  if (diff < 300) return 10;
  if (diff < 700) return 5;
  return 0;
}

export function scoreListing(
  target: ScoredFields,
  candidate: ScoredFields,
  cosineSimilarity: number | null = null,
): ScoreBreakdown {
  const tBeds = toNum(target.beds);
  const cBeds = toNum(candidate.beds);
  const tCity = target.city?.trim().toLowerCase();
  const cCity = candidate.city?.trim().toLowerCase();

  const price = pricePoints(target.price, candidate.price);
  const beds = tBeds !== null && tBeds === cBeds ? 15 : 0;
  const city = tCity && tCity === cCity ? 15 : 0;
  const sqft = sqftPoints(target.sqft, candidate.sqft);
  const structured = price + beds + city + sqft;
  const semantic = cosineSimilarity === null ? null : Math.max(0, Math.min(1, cosineSimilarity)) * SEMANTIC_MAX;

  return {
    price,
    beds,
    city,
    sqft,
    structured,
    semantic: semantic === null ? null : Math.round(semantic * 100) / 100,
    total: Math.round((structured + (semantic ?? 0)) * 100) / 100,
  };
}
