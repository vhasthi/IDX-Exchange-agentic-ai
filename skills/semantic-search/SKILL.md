---
name: semantic-search
description: "Find active listings by meaning, not keywords: describe the feel of a home ('charming craftsman with mountain views and character', 'bright modern home with an open floor plan') and get the most similar listings, ranked by OpenAI embedding similarity of their descriptions. Use when the user describes style, vibe or features in their own words. For exact filters only (city, price, beds), use mls-search."
metadata: { "openclaw": { "emoji": "✨", "requires": { "bins": ["node", "npm"], "env": ["OPENAI_API_KEY"] } } }
---

# Semantic Search

Ranks active `rets_property` listings by how close their description (`L_Remarks`
plus key facts) is in meaning to the user's words, using OpenAI embeddings. The
project lives two folders up from this skill; credentials come from its `.env`.

## Run a search

Pass the user's description as-is:

```bash
npm --prefix {baseDir}/../.. run --silent semantic -- --json "charming craftsman with mountain views and character"
```

Hard facts in the text (city, "under $1.5M", "3 bedroom", "condo", "with a pool")
are applied as filters first, then the remaining listings are ranked by meaning.

Optional flags: `--top 1-50` (default 5), `--no-filters` (rank every listing, ignoring
city/price/etc. in the text), `--min-score 0-1`.

## Output (`--json`)

- `filters`: the hard filters that were applied.
- `candidates`: how many embedded listings passed the filters.
- `matches[]`: `listingId`, `score` (cosine similarity; higher = closer; compare
  scores within one search, not across searches), `card` (same fields as mls-search
  cards), `remarks` (a snippet of the listing description).
- `markdown`: ready-to-show results.

## Rules

- Only pass the user's words; never pass SQL.
- Explain matches from the `remarks` snippet (e.g. "original 1920s woodwork"), not
  from the score.
- If the result says no embedded listings match, the listings haven't been embedded
  yet: tell the user to run `npm run embed` in the project (it calls the OpenAI API,
  which costs money). Don't run it yourself.
- `Error:` with exit code 1 means a missing `OPENAI_API_KEY`, bad input, or the
  database or OpenAI being unavailable. Report it; don't retry in a loop.
