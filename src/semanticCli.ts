// Semantic property search from the terminal (also what the OpenClaw skill runs):
//   npm run semantic -- 'charming craftsman with mountain views and character'
//   npm run semantic -- --top 10 'modern home with an open floor plan in Irvine under $2M'
//   npm run semantic -- --json --no-filters 'quiet cottage near the beach'
//
// Flags: --json (full JSON), --top 1-50 (default 5), --no-filters (ignore city/price/etc.
// in the text and rank every embedded listing), --min-score 0-1.
// Run `npm run embed` first so listings have embeddings.

import { createPool } from "./db.js";
import { openAiEmbedder } from "./skills/semanticSearch/embeddings.js";
import { semanticSearch } from "./skills/semanticSearch/index.js";

const args = process.argv.slice(2);
const flags = new Set<string>();
const values: Record<string, string> = {};
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--top", "--min-score"].includes(a)) values[a.slice(2)] = args[++i] ?? "";
  else if (a.startsWith("--")) flags.add(a.slice(2));
  else words.push(a);
}

const query = words.join(" ");
if (!query) {
  console.error("Usage: npm run semantic -- [--json] [--top 5] 'charming craftsman with mountain views'");
  process.exit(1);
}

const pool = createPool();
try {
  const result = await semanticSearch(pool, openAiEmbedder(), {
    query,
    topK: values.top ? Number(values.top) : undefined,
    minScore: values["min-score"] ? Number(values["min-score"]) : undefined,
    useFilters: !flags.has("no-filters"),
  });
  console.log(flags.has("json") ? JSON.stringify(result, null, 2) : result.markdown);
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
