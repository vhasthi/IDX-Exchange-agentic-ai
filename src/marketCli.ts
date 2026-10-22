// Ask the Market Statistics Agent from the terminal (this is also what the OpenClaw
// market-stats skill runs):
//   npm run market -- 'Is now a good time to buy in San Diego?'
//   npm run market -- 'What is the average price per sq ft in Pasadena?'
//   npm run market -- --json --months 6 'condo prices in Irvine by zip'
//
// Flags: --json (full JSON instead of markdown), --city, --zip, --type, --months 1-60,
// --group-by none|city|zip|type, --sql (print the SQL).

import { createPool } from "./db.js";
import { runMarketStats, parseMarketQuery, type MarketStatsInput } from "./skills/marketStats/index.js";
import { buildAggregateSql, type GroupBy } from "./skills/marketStats/marketSql.js";

const args = process.argv.slice(2);
const flags = new Set<string>();
const values: Record<string, string> = {};
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--city", "--zip", "--type", "--months", "--group-by"].includes(a)) values[a.slice(2)] = args[++i] ?? "";
  else if (a.startsWith("--")) flags.add(a.slice(2));
  else words.push(a);
}

const query = words.join(" ");
if (!query && !values.city && !values.zip) {
  console.error("Usage: npm run market -- [--json] 'Is now a good time to buy in San Diego?'");
  process.exit(1);
}

const input: MarketStatsInput = {
  query: query || undefined,
  city: values.city || undefined,
  zip: values.zip || undefined,
  type: values.type || undefined,
  months: values.months ? Number(values.months) : undefined,
  groupBy: (values["group-by"] || undefined) as GroupBy | undefined,
};

if (flags.has("sql")) {
  const p = query ? parseMarketQuery(query) : null;
  const scope = { city: input.city ?? p?.city, zip: input.zip ?? p?.zip, type: input.type ?? p?.type, months: input.months ?? p?.months ?? 12 };
  console.error("SQL:", buildAggregateSql(scope, "month").sql);
}

const pool = createPool();
try {
  const result = await runMarketStats(pool, input);
  console.log(flags.has("json") ? JSON.stringify(result, null, 2) : result.markdown);
} catch (err) {
  // Short message for the agent; never echo credentials.
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
