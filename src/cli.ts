// Try a search from the terminal (this is also what the OpenClaw skill runs):
//   npm run search -- '3-bedroom condos in Irvine under $1.5M with a pool'
//   npm run search -- 'what did homes in Irvine sell for in the last 6 months'
//   npm run search -- --json --sort price_desc --limit 5 'condos in Irvine'
//   npm run search -- --cursor <nextCursor> 'condos in Irvine'
//
// Flags: --json (full JSON instead of cards), --sold | --both | --active (override
// the detected intent), --sort, --limit, --page, --cursor, --months, --sql (print SQL).

import { createPool } from "./db.js";
import { runPropertySearch, type Intent, type PropertySearchInput } from "./skills/propertySearch/index.js";
import { buildPropertySql } from "./skills/propertySearch/searchProperties.js";
import { parsePropertyQuery } from "./skills/propertySearch/parsePropertyQuery.js";
import type { SortKey } from "./skills/propertySearch/pagination.js";

const args = process.argv.slice(2);
const flags = new Set<string>();
const values: Record<string, string> = {};
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--sort", "--limit", "--page", "--cursor", "--months"].includes(a)) values[a.slice(2)] = args[++i] ?? "";
  else if (a.startsWith("--")) flags.add(a.slice(2));
  else words.push(a);
}

const query = words.join(" ");
if (!query) {
  console.error("Usage: npm run search -- [--json] [--sold|--both] '3-bedroom condos in Irvine under $1.5M with a pool'");
  process.exit(1);
}

const intent = (["active", "sold", "both"] as const).find((i) => flags.has(i)) as Intent | undefined;
const input: PropertySearchInput = {
  query,
  intent,
  sort: values.sort as SortKey | undefined,
  limit: values.limit ? Number(values.limit) : undefined,
  page: values.page ? Number(values.page) : undefined,
  cursor: values.cursor || undefined,
  months: values.months ? Number(values.months) : undefined,
};

if (flags.has("sql")) console.error("SQL:", buildPropertySql(parsePropertyQuery(query), input).sql);

const pool = createPool();
try {
  const result = await runPropertySearch(pool, input);
  console.log(flags.has("json") ? JSON.stringify(result, null, 2) : result.markdown);
  if (!flags.has("json") && result.active?.nextCursor) console.log(`\nnextCursor: ${result.active.nextCursor}`);
} catch (err) {
  // Print a short message for the agent; never echo credentials or the whole SQL.
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
