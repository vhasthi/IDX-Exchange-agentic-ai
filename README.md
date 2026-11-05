# IDX Exchange Agent

AI Agentic Engineer Intern project (Summer 2026): a natural-language and semantic property search and market statistics agent over MLS data, served through OpenClaw.

## Setup

1. Import the MLS dumps into a local MySQL database named `idx_exchange` (tables `rets_property` and `california_sold`). The `.sql` files are **not** in this repo.
2. Copy `.env.example` to `.env` and fill in your MySQL credentials.
3. Install dependencies:

   ```bash
   npm install
   ```

## Usage

Search from the terminal:

```bash
npm run search -- '3-bedroom condos in Irvine under $1.5M with a pool'
npm run search -- 'what did homes in Irvine sell for in the last 6 months'
npm run search -- --json --sort price_desc --limit 5 'condos in Irvine'
npm run search -- --cursor <nextCursor> 'condos in Irvine'   # next page
```

Ask market questions (Week 5):

```bash
npm run market -- 'Is now a good time to buy in San Diego?'
npm run market -- 'What is the average price per sq ft in Pasadena?'
npm run market -- 'median condo prices in Irvine by zip over the last 6 months'
npm run market -- --json --city Pasadena --group-by type
```

Semantic search (Week 6). Add `OPENAI_API_KEY` to `.env`, embed the listings once, then search by meaning:

```bash
npm run embed -- --limit 200        # try it on 200 listings first
npm run embed                       # all active listings (re-runs only embed new/changed ones)
npm run semantic -- 'charming craftsman with mountain views and character'
npm run semantic -- --top 10 'bright modern home with an open floor plan in Irvine under $2M'
```

Search flags: `--json`, `--sold` / `--active` / `--both`, `--sort price_asc|price_desc|newest|sqft_desc`,
`--limit 1-50`, `--page N`, `--cursor TOKEN`, `--months 1-60`, `--sql`.

Run tests and the type check:

```bash
npm test
npm run typecheck
```

## Layout

| Path | Purpose |
|---|---|
| `src/skills/propertySearch/parsePropertyQuery.ts` | Week 2: free-text query → structured filters |
| `src/skills/propertySearch/searchProperties.ts` | Week 3: filters → parameterized, paginated SQL against active `rets_property` listings |
| `src/skills/propertySearch/soldComps.ts` | Week 3: sold comps from `california_sold` |
| `src/skills/propertySearch/pagination.ts` | Week 3: sort whitelist and keyset (cursor) pagination |
| `src/skills/propertySearch/formatCards.ts` | Week 3: rows → property cards (structured fields + markdown) and comp stats |
| `src/skills/propertySearch/index.ts` | Week 3: skill entry point; routes a question to active, sold, or both |
| `src/skills/marketStats/marketSql.ts` | Week 5: parameterized market SQL (grouped averages, price lists for medians, active inventory) |
| `src/skills/marketStats/stats.ts` | Week 5: medians, MoM / YoY trends, months of supply, buyer's / seller's market read |
| `src/skills/marketStats/index.ts` | Week 5: skill entry point; question → scope → stats → markdown answer |
| `src/skills/semanticSearch/embeddings.ts` | Week 6: listing text, OpenAI embeddings (batched), float32 storage, cosine similarity |
| `src/skills/semanticSearch/store.ts` | Week 6: `listing_embeddings` table and incremental indexing of active listings |
| `src/skills/semanticSearch/index.ts` | Week 6: hybrid search: structured filters, then ranking by cosine similarity |
| `skills/mls-search/SKILL.md` | OpenClaw skill: property search |
| `skills/market-stats/SKILL.md` | OpenClaw skill: market statistics |
| `skills/semantic-search/SKILL.md` | OpenClaw skill: semantic search |
| `src/tools/getCurrentTime.ts` | Handbook basic tool example |
| `src/db.ts` | MySQL connection pool from `.env` |
| `src/cli.ts` | Command-line entry point for trying searches |
| `src/marketCli.ts` | Command-line entry point for market questions |
| `src/embedCli.ts`, `src/semanticCli.ts` | Command-line entry points for embedding listings and semantic search |

## Filter → column mapping

| Intent | Column |
|---|---|
| city | `L_City` |
| max price | `L_SystemPrice` |
| min bedrooms | `L_Keyword2` |
| min bathrooms | `LM_Dec_3` |
| min sq ft | `LM_Int2_3` |
| property type | `L_Type_` |
| pool | `PoolPrivateYN` |
| view | `ViewYN` |

## OpenClaw

Point OpenClaw at this project's `skills/` folder in `~/.openclaw/openclaw.json`:

```json5
{ skills: { load: { extraDirs: ["~/Desktop/idx/skills"] } } }
```

The agent then runs `npm run search -- --json "<question>"` for home searches and `npm run market -- --json "<question>"` for market questions.

## Week 3 notes

- Only `L_Status = 'Active'` listings are returned. Status, property type and every user value are bound `?` parameters;
  the handbook's `"Active"` breaks when MySQL runs with `ANSI_QUOTES`.
- Sort columns come from a fixed whitelist; `limit`/`page` are validated integers.
- Paging uses a cursor (`WHERE (price, id) > (last price, last id)`) instead of `OFFSET`, so later pages stay fast and
  ties on price never skip or repeat rows. One extra row is fetched to know whether there is a next page.
- Recommended indexes (ask before adding):
  `CREATE INDEX idx_active_city_price ON rets_property (L_Status, L_City, L_SystemPrice, L_ListingID);`
  `CREATE INDEX idx_sold_city_date ON california_sold (City, PropertyType, CloseDate);`

## Week 5 notes: Market Statistics Agent

- Metrics: average and median close price, average and median price per sq ft, average days on market,
  list-to-close ratio (close ÷ final list, and close ÷ original list), monthly trends with MoM and YoY changes,
  and active inventory (`rets_property`) vs sold volume (`california_sold`) as months of supply.
- Scope: city, ZIP (`PostalCode` / `L_Zip`), property type (`PropertySubType` / `L_Type_`), window of 1–60 months;
  group by city, ZIP, type or month. Group columns come from a whitelist; all values are bound parameters.
- The handbook's city summary query is `buildAggregateSql(scope, "city")`. MySQL has no `MEDIAN`, so medians are computed
  in TypeScript from a second, light query (group key, price, $/sqft).
- The handbook's pandas `pct_change` is `buildTrend()`, which matches months by calendar month, so a missing month gives
  no change instead of comparing against the wrong month.
- `CloseDate` is a `VARCHAR` (`YYYY-MM-DD`); months are `LEFT(CloseDate, 7)`. A few rows have future close dates
  (e.g. 2072), so the window also requires `CloseDate <= CURDATE()`.
- List-to-close averages skip implausible ratios (outside 0.5–2), which come from list prices entered off by 10×.
- The current sold data covers about March–September 2026, so YoY is empty until there is 13+ months of history, and the
  first and last months are partial. Months of supply uses the real span of close dates for the sales rate.
- Market read: under 3 months of supply = seller's market, over 6 = buyer's market, adjusted by list-to-close and the
  recent price and days-on-market trend. Without inventory data it only calls clear trends. It is informational, not advice.
- Recommended index (ask before adding): `CREATE INDEX idx_sold_city_zip_date ON california_sold (City, PostalCode, CloseDate);`

## Week 6 notes: Semantic search with embeddings

- Each active listing is turned into the handbook's text (type, city, beds, baths, sq ft, year, price, then `L_Remarks`)
  and embedded with `text-embedding-3-small`. Missing fields are skipped instead of printing `null` (the handbook's
  `f"{price:,}"` fails on a NULL price).
- Embeddings are stored once in a `listing_embeddings` table (`npm run embed` creates it) as float32 BLOBs, 6 KB per
  listing. Each row keeps a SHA-256 of the text, so re-running `npm run embed` only pays for new or changed listings.
  Requests are batched 100 texts at a time.
- Search is hybrid: hard facts in the query (city, max price, beds, baths, sq ft, type, pool, view) go through the same
  parser and parameterized `WHERE` as the keyword search, then the remaining listings are ranked by cosine similarity
  to the embedded query. Only the top results' full rows are loaded.
- Cosine similarity is computed in TypeScript with normalized vectors (one dot product per listing), instead of the
  handbook's per-row `sklearn` call, which is slow over thousands of listings.
- Cost: about $0.02 per million tokens; a listing is roughly 150–300 tokens, so embedding 10,000 listings costs
  around $0.05. Each search embeds only the query.
- Scores are only meaningful relative to each other within one search; OpenAI similarities for related text are
  often in the 0.3–0.6 range.
- `OPENAI_API_KEY` lives in `.env` (git-ignored). Never commit it.
