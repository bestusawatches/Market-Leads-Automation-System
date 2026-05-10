// src/config/index.ts

function urlListFromEnv(envVar: string, defaults: string[]): string[] {
  const raw = (process.env[envVar] ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return raw.length > 0 ? raw : defaults;
}

export const config = {

  // ── Browser ───────────────────────────────────────────────────────────────
  browser: {
    headless:   true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport:   { width: 1440, height: 900 },
    locale:     "en-US",
    timezoneId: "America/New_York",
    extraHeaders: {
      "Accept-Language":           "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Connection:                  "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
    },
    useStealth: true,
  },

  // ── Proxy ─────────────────────────────────────────────────────────────────
  proxyUrl: process.env.PROXY_URL || null,

  // ── Global scraping limits ────────────────────────────────────────────────
  maxPages:     Number(process.env.MAX_PAGES        ?? 10),
  maxListings:  Number(process.env.MAX_LISTINGS     ?? 100),
  requestDelay: Number(process.env.REQUEST_DELAY_MS ?? 2_000),

  // ── Filtering criteria ────────────────────────────────────────────────────
  filter: {
    minPrice: 50_000,
    maxPrice: 300_000,
    allowedPropertyTypes: [
      "single_family",
      "multi_family",
      "duplex",
    ] as string[],
    keywords: [
      "single family", "single-family", "single family home",
      "investment", "rental", "duplex", "multi-family", "multifamily",
    ],
    propertyTypeTokens: [
      "single family", "single-family", "sfh", "duplex", "multi-family", "multifamily",
    ],
    allowedLocations: [
      "ohio", "oh", "cleveland", "columbus", "toledo", "milwaukee", "wisconsin", "wi",
    ],
  },

  // ── Sources ───────────────────────────────────────────────────────────────
  sources: {

    propwire: {
      markets: [
        { name: "Columbus, OH",  state: "OH", stateName: "Ohio",      city: "Columbus"  },
        { name: "Cleveland, OH", state: "OH", stateName: "Ohio",      city: "Cleveland" },
        { name: "Toledo, OH",    state: "OH", stateName: "Ohio",      city: "Toledo"    },
        { name: "Milwaukee, WI", state: "WI", stateName: "Wisconsin", city: "Milwaukee" },
      ] as Array<{ name: string; state: string; stateName: string; city?: string }>,

      maxPages:      Number(process.env.PROPWIRE_MAX_PAGES     ?? 10),
      detailLimit:   Number(process.env.PROPWIRE_DETAIL_LIMIT  ?? 20),
    },

    craigslist: {
      milwaukee: "https://milwaukee.craigslist.org/search/rea",
      columbus:  "https://columbus.craigslist.org/search/rea",
      cleveland: "https://cleveland.craigslist.org/search/rea",
      toledo:    "https://toledo.craigslist.org/search/rea",
    },

    // ── Zillow — off-market only ───────────────────────────────────────────
    //
    // Each market entry targets one off-market listing type.
    // listingType drives the filterState flags in buildPageUrl():
    //
    //   "pre_foreclosure"  →  pf=true,   fore=false
    //   "foreclosure"      →  fore=true, pf=false
    //
    // fsba / fsbo / nc / cmsn / auc are all set to false in every request
    // so Zillow returns ONLY the off-market type, no active MLS listings.
    //
    // To add cities: duplicate an entry and change baseUrl to the city path,
    // e.g. "https://www.zillow.com/columbus-oh/" — Zillow accepts both state
    // and city-level paths with the same searchQueryState override.
    //
    // Override page depth at runtime:
    //   ZILLOW_MAX_PAGES=10   — pages scraped per market (default 20)
    //   ZILLOW_DETAIL_LIMIT=5 — per-listing detail fetches for extra fields
    //                           (0 = disabled, each fetch costs 1 Oxylabs credit)
    zillow: {
      markets: [
        {
          name:        "Ohio - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/oh/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Ohio - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/oh/",
          listingType: "foreclosure" as const,
        },
        {
          name:        "Wisconsin - Pre-Foreclosure",
          baseUrl:     "https://www.zillow.com/wi/",
          listingType: "pre_foreclosure" as const,
        },
        {
          name:        "Wisconsin - Foreclosure (REO)",
          baseUrl:     "https://www.zillow.com/wi/",
          listingType: "foreclosure" as const,
        },
      ] as Array<{
        name:        string;
        baseUrl:     string;
        listingType: "pre_foreclosure" | "foreclosure";
      }>,

      maxPagesPerMarket: Number(process.env.ZILLOW_MAX_PAGES    ?? 20),
      // Set > 0 to fetch each listing's detail page for loan balance,
      // auction date, and other fields not present in search results.
      detailFetchLimit:  Number(process.env.ZILLOW_DETAIL_LIMIT ?? 0),
    },

    realtor: {
      searchUrls: urlListFromEnv("REALTOR_SEARCH_URLS", [
        "https://www.realtor.com/realestateandhomes-search/Columbus_OH/?price_max=300000&type=single_family,multi_family",
        "https://www.realtor.com/realestateandhomes-search/Cleveland_OH/?price_max=300000&type=single_family,multi_family",
        "https://www.realtor.com/realestateandhomes-search/Toledo_OH/?price_max=300000&type=single_family,multi_family",
        "https://www.realtor.com/realestateandhomes-search/Milwaukee_WI/?price_max=300000&type=single_family,multi_family",
      ]),
      maxPagesPerUrl:   Number(process.env.REALTOR_MAX_PAGES    ?? 10),
      detailFetchLimit: Number(process.env.REALTOR_DETAIL_LIMIT ?? 50),
    },

    redfin: {
      markets: [
        { name: "Cleveland, OH",  regionId: 4145,  regionType: 6 },
        { name: "Columbus, OH",   regionId: 4664,  regionType: 6 },
        { name: "Toledo, OH",     regionId: 19458, regionType: 6 },
        { name: "Milwaukee, WI",  regionId: 35759, regionType: 6 },
      ] as Array<{ name: string; regionId: number; regionType: number }>,

      uipt: [1, 4] as number[],

      pageSize:          Number(process.env.REDFIN_PAGE_SIZE    ?? 50),
      maxPagesPerMarket: Number(process.env.REDFIN_MAX_PAGES    ?? 5),
      detailFetchLimit:  Number(process.env.REDFIN_DETAIL_LIMIT ?? 10),
    },

    crexi: {
      searchUrls: urlListFromEnv("CREXI_SEARCH_URLS", [
        "https://www.crexi.com/properties/OH/Multifamily",
        "https://www.crexi.com/properties/OH/Columbus_",
        "https://www.crexi.com/properties/OH/Cleveland",
        "https://www.crexi.com/properties/OH/Toledo",
        "https://www.crexi.com/properties/WI/Milwaukee",
        "https://www.crexi.com/properties/WI/Multifamily",
      ]),
    },

    loopnet: {
      searchUrls: urlListFromEnv("LOOPNET_SEARCH_URLS", [
        "https://www.loopnet.com/search/multifamily-properties/oh/for-sale/",
        "https://www.loopnet.com/search/apartment-buildings/oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/columbus-oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/cleveland-oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/toledo-oh/for-sale/",
        "https://www.loopnet.com/search/multifamily-properties/milwaukee-wi/for-sale/",
        "https://www.loopnet.com/search/apartment-buildings/wi/for-sale/",
      ]),
      maxPagesPerUrl: Number(process.env.LOOPNET_MAX_PAGES ?? 3),
    },

  },
} as const;

export type Config = typeof config;