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
  maxPages:     Number(process.env.MAX_PAGES        ?? 5),
  maxListings:  Number(process.env.MAX_LISTINGS     ?? 20),
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

    craigslist: {
      milwaukee: "https://milwaukee.craigslist.org/search/rea",
      columbus:  "https://columbus.craigslist.org/search/rea",
      cleveland: "https://cleveland.craigslist.org/search/rea",
      toledo:    "https://toledo.craigslist.org/search/rea",
    },

    zillow:
      "https://www.zillow.com/oh/?searchQueryState=%7B%22filterState%22%3A%7B%22price%22%3A%7B%22max%22%3A300000%7D%7D%7D",

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

    // ── Redfin ──────────────────────────────────────────────────────────────
    //
    // The scraper uses Redfin's internal GIS JSON API, NOT HTML pages.
    //
    // markets[]  — one entry per city. The scraper builds GIS API URLs from
    //              these; it never visits the searchUrls directly.
    //
    //   name        — human-readable label used in logs
    //   regionId    — Redfin's numeric city ID (visible in any Redfin city URL,
    //                 e.g. /city/3514/OH/Cleveland → regionId 3514)
    //   regionType  — 6 = city  |  2 = state  (almost always 6)
    //
    // uipt[]  — Redfin property-type codes to include in every GIS request:
    //   1 = House  |  2 = Condo  |  3 = Townhouse
    //   4 = Multi-family  |  5 = Land  |  6 = Other  |  7 = Mobile
    //
    // pageSize          — listings per GIS API call (max 350, 50 is stable)
    // maxPagesPerMarket — pagination cap per city
    // detailFetchLimit  — max detail-page fetches for AVM enrichment
    //                     (each detail fetch costs 1 Oxylabs credit + ~15s)
    //
    // Override at runtime via .env:
    //   REDFIN_MAX_PAGES=10
    //   REDFIN_PAGE_SIZE=100
    //   REDFIN_DETAIL_LIMIT=20
    redfin: {
      markets: [
        { name: "Cleveland, OH",  regionId: 4145,  regionType: 6 },
    { name: "Columbus, OH",   regionId: 4664,  regionType: 6 },
    { name: "Toledo, OH",     regionId: 19458, regionType: 6 },
    { name: "Milwaukee, WI",  regionId: 35759, regionType: 6 },
      ] as Array<{ name: string; regionId: number; regionType: number }>,

      // Property types: House (1) + Multi-family (4)
      // Add 2 (Condo) or 3 (Townhouse) here if you want them included
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