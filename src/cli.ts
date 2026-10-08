// Try a search from the terminal:
//   npm run search -- '3-bedroom condos in Irvine under $1.5M with a pool'

import { createPool } from "./db.js";
import { parsePropertyQuery } from "./skills/propertySearch/parsePropertyQuery.js";
import { buildPropertySql, searchProperties } from "./skills/propertySearch/searchProperties.js";

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: npm run search -- '3-bedroom condos in Irvine under $1.5M with a pool'");
  process.exit(1);
}

const filters = parsePropertyQuery(query);
console.log("Filters:", filters);
console.log("SQL:", buildPropertySql(filters).sql);

const pool = createPool();
try {
  const rows = await searchProperties(pool, filters);
  console.table(rows);
} finally {
  await pool.end();
}
