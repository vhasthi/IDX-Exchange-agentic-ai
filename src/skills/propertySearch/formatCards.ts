// Turns database rows into property cards for downstream agents: clean structured
// fields plus a ready-to-show markdown block. mysql2 returns DECIMAL columns as
// strings, so every number goes through toNum().

import type { ListingRow } from "./searchProperties.js";
import type { SoldRow } from "./soldComps.js";

export interface ListingCard {
  kind: "active";
  id: string;
  mlsNumber: string | null;
  address: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  pricePerSqft: number | null;
  type: string | null;
  yearBuilt: number | null;
  hoaMonthly: number | null;
  daysOnMarket: number | null;
  features: string[];
  location: { lat: number; lng: number } | null;
  photoCount: number;
  agent: string | null;
  office: string | null;
  markdown: string;
}

export interface SoldCard {
  kind: "sold";
  id: string;
  address: string;
  closeDate: string | null;
  closePrice: number | null;
  listPrice: number | null;
  originalListPrice: number | null;
  saleToListPct: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  pricePerSqft: number | null;
  subType: string | null;
  yearBuilt: number | null;
  daysOnMarket: number | null;
  listAgent: string | null;
  listOffice: string | null;
  buyerOffice: string | null;
  markdown: string;
}

export interface CompStats {
  count: number;
  medianClosePrice: number | null;
  medianPricePerSqft: number | null;
  avgDaysOnMarket: number | null;
  avgSaleToListPct: number | null;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const money = (n: number | null) => (n === null ? "—" : usd.format(n));
const isYes = (v: unknown) => String(v ?? "").trim() === "1";
const perSqft = (price: number | null, sqft: number | null) => (price && sqft ? Math.round(price / sqft) : null);

function join(parts: unknown[], sep = " · "): string {
  return parts.filter((p) => p !== null && p !== undefined && p !== false && p !== "").join(sep);
}

function sizeLine(beds: number | null, baths: number | null, sqft: number | null): string {
  return (
    join([beds !== null && `${beds} bd`, baths !== null && `${baths} ba`, sqft !== null && `${int.format(sqft)} sqft`]) ||
    "details n/a"
  );
}

function isoDate(d: Date | string | null): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    // mysql2 builds DATE values at local midnight; read them back in local time.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return String(d).slice(0, 10);
}

export function toListingCard(r: ListingRow): ListingCard {
  const price = toNum(r.price);
  const beds = toNum(r.beds);
  const baths = toNum(r.baths);
  const sqft = toNum(r.sqft);
  const hoa = toNum(r.AssociationFee);
  const dom = toNum(r.DaysOnMarket);
  const year = toNum(r.YearBuilt);
  const lat = toNum(r.lat);
  const lng = toNum(r.lng);
  const ppsf = perSqft(price, sqft);
  const features = [isYes(r.PoolPrivateYN) && "Pool", isYes(r.ViewYN) && "View", isYes(r.FireplaceYN) && "Fireplace"]
    .filter(Boolean) as string[];
  const agent = join([r.LA1_UserFirstName, r.LA1_UserLastName], " ") || null;
  const address = join([r.L_Address?.trim(), join([r.L_City, r.L_Zip], " ")], ", ") || "Address unavailable";

  const markdown = [
    `**${money(price)}** · ${sizeLine(beds, baths, sqft)}`,
    address,
    join([
      r.type,
      year && `Built ${year}`,
      ppsf && `${usd.format(ppsf)}/sqft`,
      dom !== null && `${dom} days on market`,
      hoa ? `HOA ${usd.format(hoa)}/mo` : null,
    ]),
    features.join(" · "),
    join([agent && `Listed by ${agent}`, r.LO1_OrganizationName, r.L_DisplayId && `MLS# ${r.L_DisplayId}`]),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: "active",
    id: String(r.L_ListingID),
    mlsNumber: r.L_DisplayId,
    address,
    price,
    beds,
    baths,
    sqft,
    pricePerSqft: ppsf,
    type: r.type,
    yearBuilt: year,
    hoaMonthly: hoa,
    daysOnMarket: dom,
    features,
    location: lat !== null && lng !== null && (lat !== 0 || lng !== 0) ? { lat, lng } : null,
    photoCount: toNum(r.PhotoCount) ?? 0,
    agent,
    office: r.LO1_OrganizationName,
    markdown,
  };
}

export function toSoldCard(r: SoldRow): SoldCard {
  const close = toNum(r.ClosePrice);
  const list = toNum(r.ListPrice);
  const beds = toNum(r.BedroomsTotal);
  const baths = toNum(r.BathroomsTotalInteger);
  const sqft = toNum(r.LivingArea);
  const dom = toNum(r.DaysOnMarket);
  const year = toNum(r.YearBuilt);
  const ppsf = perSqft(close, sqft);
  const saleToList = close && list ? Math.round((close / list) * 1000) / 10 : null;
  const closeDate = isoDate(r.CloseDate);
  const address = join([r.UnparsedAddress?.trim(), r.City], ", ") || "Address unavailable";

  const markdown = [
    `**Sold ${money(close)}**${closeDate ? ` on ${closeDate}` : ""} · ${sizeLine(beds, baths, sqft)}`,
    address,
    join([
      list !== null && `List ${money(list)}`,
      saleToList !== null && `${saleToList}% of list`,
      ppsf && `${usd.format(ppsf)}/sqft`,
      dom !== null && `${dom} days on market`,
    ]),
    join([r.PropertySubType, year && `Built ${year}`]),
    join([r.ListAgentFullName && `Listed by ${r.ListAgentFullName}`, r.ListOfficeName, r.BuyerOfficeName && `Buyer: ${r.BuyerOfficeName}`]),
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: "sold",
    id: String(r.ListingKey),
    address,
    closeDate,
    closePrice: close,
    listPrice: list,
    originalListPrice: toNum(r.OriginalListPrice),
    saleToListPct: saleToList,
    beds,
    baths,
    sqft,
    pricePerSqft: ppsf,
    subType: r.PropertySubType,
    yearBuilt: year,
    daysOnMarket: dom,
    listAgent: r.ListAgentFullName,
    listOffice: r.ListOfficeName,
    buyerOffice: r.BuyerOfficeName,
    markdown,
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);

export function compStats(cards: SoldCard[]): CompStats {
  const m = median(nums(cards.map((c) => c.closePrice)));
  const p = median(nums(cards.map((c) => c.pricePerSqft)));
  return {
    count: cards.length,
    medianClosePrice: m === null ? null : Math.round(m),
    medianPricePerSqft: p === null ? null : Math.round(p),
    avgDaysOnMarket: round1(mean(nums(cards.map((c) => c.daysOnMarket)))),
    avgSaleToListPct: round1(mean(nums(cards.map((c) => c.saleToListPct)))),
  };
}

export function statsLine(city: string, months: number, s: CompStats): string {
  if (!s.count) return `No residential sales found in ${city} in the last ${months} months.`;
  return join([
    `**${s.count} sales in ${city}, last ${months} months**`,
    s.medianClosePrice !== null && `median ${money(s.medianClosePrice)}`,
    s.medianPricePerSqft !== null && `${money(s.medianPricePerSqft)}/sqft`,
    s.avgDaysOnMarket !== null && `avg ${s.avgDaysOnMarket} days on market`,
    s.avgSaleToListPct !== null && `avg ${s.avgSaleToListPct}% of list`,
  ]);
}
