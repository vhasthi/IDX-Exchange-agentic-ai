// Week 2: turn a free-text real estate query into structured filters for rets_property.
// Based on the handbook parser, with a few fixes noted inline.

export interface PropertyFilters {
  city: string | null;
  maxPrice: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  type: string | null;
  pool: "True" | null;
  hasView: "True" | null;
}

const TYPE_MAP: Record<string, string> = {
  condo: "Condominium",
  townhome: "Townhouse",
  townhouse: "Townhouse",
  "single family": "SingleFamilyResidence",
  "single-family": "SingleFamilyResidence",
  land: "UnimprovedLand",
};

export function parsePropertyQuery(query: string): PropertyFilters {
  // The handbook PDF wraps this regex across two lines; it must be a single line.
  const cityMatch = query.match(/\bin ([A-Za-z\s]+?)(?:\s+under|\s+with|\s+at|\s+for|[,.?!]|$)/i);
  const priceMatch = query.match(/under \$?([\d,.]+)\s*(k|m)?/i);
  const bedsMatch = query.match(/(\d+)[\s-]*(bed|beds|bedroom|bedrooms|br)\b/i);
  const bathsMatch = query.match(/(\d+(?:\.5)?)[\s-]*(bath|baths|bathroom|bathrooms|ba)\b/i);
  // Handbook used (\d+), which reads "1,800 sq ft" as 800; allow commas.
  const sqftMatch = query.match(/([\d,]+)\s*(sqft|sq ft|sq\. ft\.|square feet)/i);
  const lower = query.toLowerCase();
  const typeKey = Object.keys(TYPE_MAP).find((k) => lower.includes(k));

  let maxPrice: number | null = null;
  if (priceMatch) {
    maxPrice = Number(priceMatch[1].replace(/,/g, ""));
    const unit = priceMatch[2]?.toLowerCase();
    if (unit === "k") maxPrice *= 1_000;
    if (unit === "m") maxPrice *= 1_000_000;
  }

  return {
    city: cityMatch?.[1]?.trim() || null,
    maxPrice,
    beds: bedsMatch ? Number(bedsMatch[1]) : null,
    baths: bathsMatch ? Number(bathsMatch[1]) : null,
    sqft: sqftMatch ? Number(sqftMatch[1].replace(/,/g, "")) : null,
    type: typeKey ? TYPE_MAP[typeKey] : null,
    pool: /\bpool\b/i.test(query) ? "True" : null,
    hasView: /\bview\b/i.test(query) ? "True" : null,
  };
}
