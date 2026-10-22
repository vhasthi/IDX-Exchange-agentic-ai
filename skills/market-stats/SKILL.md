---
name: market-stats
description: "California housing market statistics from IDX MLS data: median and average sale prices, price per sq ft, days on market, list-to-close ratio, inventory and months of supply, and month-over-month / year-over-year trends, by city, ZIP or property type. Use for questions like 'Is now a good time to buy in San Diego?' or 'What is the average price per sq ft in Pasadena?'. For finding specific homes or comps, use mls-search instead."
metadata: { "openclaw": { "emoji": "📈", "requires": { "bins": ["node", "npm"] } } }
---

# Market Stats

Answers market questions from the IDX Exchange MySQL database: closed sales from
`california_sold` and active inventory from `rets_property`. The project lives two
folders up from this skill; database credentials come from its `.env`.

## Run it

Pass the user's question as-is, with `--json`:

```bash
npm --prefix {baseDir}/../.. run --silent market -- --json "Is now a good time to buy in San Diego?"
```

The question is parsed for a city, a 5-digit ZIP, a property type (condo,
townhouse, single family), a window ("last 6 months", default 12) and a grouping
("by zip", "by city", "by property type"). No city or ZIP = all of California.

Optional flags override the parsing: `--city "San Diego"`, `--zip 92101`,
`--type Condominium|Townhouse|SingleFamilyResidence`, `--months 1-60`,
`--group-by none|city|zip|type`.

## Output (`--json`)

- `scope`: city, zip, type, months, groupBy that were used.
- `focus`: what the question was mainly about (`buy`, `sell`, `pricePerSqft`, `price`,
  `daysOnMarket`, `listToClose`, `inventory`, `trend`, `summary`).
- `overall`: sales, avg/median close price, avg/median $/sqft, avg days on market,
  `listToClosePct` (close ÷ final list, 100 = at asking), `origListToClosePct`.
- `trend[]`: the same per month, with `changes.<metric>.mom` and `.yoy` in percent.
- `inventory`: active listings, avg list price, avg monthly sales, months of supply.
- `breakdown[]`: per city / ZIP / type when grouped.
- `read`: `marketType` (seller's / balanced / buyer's market), `signals[]`, `summary`.
- `notes[]`: data caveats (partial months, missing YoY, missing inventory).
- `markdown`: a ready-to-show answer. Show this unless you need to reshape it.

## Rules

- Never write SQL or pass SQL to this command; only pass the user's question or flags.
- Lead with the direct answer, then the supporting numbers. Mention the notes that
  affect the answer (e.g. YoY not available).
- The market read is a rule of thumb. Say it's informational, not financial advice;
  don't tell the user to buy or sell.
- `Error:` with exit code 1 means bad input (e.g. a bad ZIP) or the database is
  down. Ask the user or report it; don't retry in a loop.
