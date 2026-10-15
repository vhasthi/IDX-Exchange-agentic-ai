---
name: mls-search
description: "Search IDX MLS data: active listings (rets_property) and recent sold comps (california_sold) from a natural-language home-search question; returns formatted property cards. Use for home searches, price checks, and what-did-it-sell-for questions."
metadata: { "openclaw": { "emoji": "🏠", "requires": { "bins": ["node", "npm"] } } }
---

# MLS Search

Answers home-search questions from the IDX Exchange MySQL database. The project
lives two folders up from this skill; database credentials come from its `.env`.

## Run a search

Pass the user's question as-is. Use `--json` so you get structured cards back:

```bash
npm --prefix {baseDir}/../.. run --silent search -- --json "3-bedroom condos in Irvine under \$1.5M with a pool"
```

The question is parsed into filters (city, max price, beds, baths, sq ft, type,
pool, view) and routed automatically:

- Listing searches ("condos in Irvine under 1M") → active listings.
- Sales questions ("what did homes in Irvine sell for in the last 6 months",
  "comps in Irvine") → sold comps with summary stats. These need a city.
- Questions about both → both.

Optional flags: `--sold`, `--active` or `--both` to force the route; `--sort
price_asc|price_desc|newest|sqft_desc`; `--limit 1-50` (default 10); `--months 1-60`
(sold window, default 12).

## Paging

When `active.hasMore` is true, get the next page by repeating the **same** question
and sort with `--cursor <active.nextCursor>`. A cursor from a different sort is rejected.

## Output (`--json`)

- `intent`, `filters`: what was searched.
- `active.cards[]`: price, beds, baths, sqft, pricePerSqft, type, yearBuilt,
  hoaMonthly, daysOnMarket, features, location, agent, office, mlsNumber, and
  `markdown` (a ready-to-show card).
- `sold.cards[]` and `sold.stats`: count, median price, median $/sqft, average days on
  market, average sale-to-list %.
- `markdown`: every card, formatted. Show this to the user unless you need to reshape it.

## Rules

- Never write SQL or pass SQL to this command; only pass the user's question.
- A message starting with `Error:` and exit code 1 means the question was missing
  something (e.g. no city for comps) or the database is unavailable. Ask the user or
  report it; don't retry in a loop.
