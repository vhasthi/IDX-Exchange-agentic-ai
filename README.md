# IDX Exchange Agent

AI Agentic Engineer Intern project (Summer 2026): a natural-language property search agent over MLS data, served through OpenClaw.

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

Flags: `--json`, `--sold` / `--active` / `--both`, `--sort price_asc|price_desc|newest|sqft_desc`,
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
| `skills/mls-search/SKILL.md` | OpenClaw skill definition |
| `src/tools/getCurrentTime.ts` | Handbook basic tool example |
| `src/db.ts` | MySQL connection pool from `.env` |
| `src/cli.ts` | Command-line entry point for trying searches |

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

The agent then runs `npm run search -- --json "<question>"` in this folder and gets property cards back.

## Week 3 notes

- Only `L_Status = 'Active'` listings are returned. Status, property type and every user value are bound `?` parameters;
  the handbook's `"Active"` breaks when MySQL runs with `ANSI_QUOTES`.
- Sort columns come from a fixed whitelist; `limit`/`page` are validated integers.
- Paging uses a cursor (`WHERE (price, id) > (last price, last id)`) instead of `OFFSET`, so later pages stay fast and
  ties on price never skip or repeat rows. One extra row is fetched to know whether there is a next page.
- Recommended indexes (ask before adding):
  `CREATE INDEX idx_active_city_price ON rets_property (L_Status, L_City, L_SystemPrice, L_ListingID);`
  `CREATE INDEX idx_sold_city_date ON california_sold (City, PropertyType, CloseDate);`
