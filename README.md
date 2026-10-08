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
```

Run tests and the type check:

```bash
npm test
npm run typecheck
```

## Layout

| Path | Purpose |
|---|---|
| `src/skills/propertySearch/parsePropertyQuery.ts` | Week 2: free-text query → structured filters |
| `src/skills/propertySearch/searchProperties.ts` | Filters → parameterized SQL against `rets_property` |
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
