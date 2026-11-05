// Embed active listings into the listing_embeddings table (run before semantic search).
//   npm run embed -- --limit 200            # cheap first run
//   npm run embed -- --city Pasadena        # one city
//   npm run embed                           # everything; re-runs only embed new/changed listings
//
// Needs OPENAI_API_KEY in .env. Cost with text-embedding-3-small is roughly
// $0.02 per 1M tokens (~250 tokens per listing).

import { createPool } from "./db.js";
import { openAiEmbedder } from "./skills/semanticSearch/embeddings.js";
import { indexListings } from "./skills/semanticSearch/store.js";

const args = process.argv.slice(2);
const values: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (["--city", "--limit", "--batch"].includes(args[i])) values[args[i].slice(2)] = args[++i] ?? "";
}

const limit = values.limit ? Number(values.limit) : undefined;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.error("--limit must be a positive whole number");
  process.exit(1);
}

const pool = createPool();
try {
  const embedder = openAiEmbedder();
  const start = Date.now();
  const result = await indexListings(pool, embedder, {
    city: values.city || null,
    limit,
    batchSize: values.batch ? Number(values.batch) : undefined,
    onProgress: (done, embedded) => process.stderr.write(`\r${done} listings checked, ${embedded} embedded`),
  });
  process.stderr.write("\n");
  console.log(
    `Done in ${((Date.now() - start) / 1000).toFixed(1)} s: ${result.scanned} active listings checked, ` +
      `${result.embedded} embedded with ${embedder.model}, ${result.skipped} already up to date.`,
  );
} catch (err) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
