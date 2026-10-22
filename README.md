# IDX Exchange Agent

AI Agentic Engineer Intern project (Summer 2026): a natural-language property search and market statistics agent over MLS data, served through OpenClaw.

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
| `skills/mls-search/SKILL.md` | OpenClaw skill: property search |
| `skills/market-stats/SKILL.md` | OpenClaw skill: market statistics |
| `src/tools/getCurrentTime.ts` | Handbook basic tool example |
| `src/db.ts` | MySQL connection pool from `.env` |
| `src/cli.ts` | Command-line entry point for trying searches |
| `src/marketCli.ts` | Command-line entry point for market questions |

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
