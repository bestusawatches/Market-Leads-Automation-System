// src/config/index.ts
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for all runtime settings.
// Import this everywhere — never hardcode values in scrapers or parsers.
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  // ── Browser ────────────────────────────────────────────────────────────────
  browser: {
    headless: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    },
    useStealth: true,
  },

  // ── Proxy ──────────────────────────────────────────────────────────────────
  // Set to null to scrape without a proxy (recommended for initial testing).
  // Format: "http://user:pass@host:port"
  // http://uiqydusn:ayprrg8k3u13@23.95.150.145:6114/

  // proxyUrl: "http://fkmevgky:lmza5a3m78uw@107.172.163.27:6543",
  proxyUrl: "",
  
  // proxyUrl:"",

  // https://ipv4.webshare.io/
  // ── Scraping limits ────────────────────────────────────────────────────────
  maxPages: Number(process.env.MAX_PAGES ?? 5),
  maxListings: Number(process.env.MAX_LISTINGS ?? 20),
  requestDelay: Number(process.env.REQUEST_DELAY_MS ?? 2000), // ms

  
  // ── Filtering criteria ────────────────────────────────────────────────────
  filter: {
    minPrice: 50_000,
    maxPrice: 300_000,
    allowedPropertyTypes: [
      "single_family",
      "multi_family",
      "duplex",
    ] as string[],
    // Keywords used to detect relevant listings from title / description
    keywords: [
      "single family",
      "single-family",
      "single family home",
      "investment",
      "rental",
      "duplex",
      "multi-family",
      "multifamily",
    ],
    propertyTypeTokens: [
      "single family",
      "single-family",
      "sfh",
      "duplex",
      "multi-family",
      "multifamily",
    ],
    // Tokens (lowercased) matched against parsed `address` / `location`.
    // Include state names, abbreviations, and major cities we accept.
    allowedLocations: [
      "ohio",
      "oh",
      "cleveland",
      "columbus",
      "toledo",
      "milwaukee",
      "wisconsin",
      "wi"
    ],
  },

  // ── Source URLs ───────────────────────────────────────────────────────────
  sources: {
    craigslist: {
      milwaukee: "https://milwaukee.craigslist.org/search/rea",
      columbus: "https://columbus.craigslist.org/search/rea",
      cleveland: "https://cleveland.craigslist.org/search/rea",
      toledo: "https://toledo.craigslist.org/search/rea",
    },
    zillow:
      "https://www.zillow.com/oh/?searchQueryState=%7B%22filterState%22%3A%7B%22price%22%3A%7B%22max%22%3A300000%7D%7D%7D",
    crexi: {
      // Crexi search URLs for multifamily and key markets (Ohio + Wisconsin)
      searchUrls: (process.env.CREXI_SEARCH_URLS ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
        .length > 0
        ? (process.env.CREXI_SEARCH_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean)
        : [
            "https://www.crexi.com/properties/OH/Multifamily",
            "https://www.crexi.com/properties/OH/Columbus_",
            "https://www.crexi.com/properties/OH/Cleveland",
            "https://www.crexi.com/properties/OH/Toledo",
            "https://www.crexi.com/properties/WI/Milwaukee",
            "https://www.crexi.com/properties/WI/Multifamily",
          ],
    },
    loopnet: {
      // LoopNet search URLs for multifamily and key markets (Ohio + Wisconsin)
      searchUrls: (process.env.LOOPNET_SEARCH_URLS ?? "")
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean)
        .length > 0
        ? (process.env.LOOPNET_SEARCH_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean)
        : [
            "https://www.loopnet.com/search/multifamily-properties/oh/for-sale/",
            "https://www.loopnet.com/search/apartment-buildings/oh/for-sale/",
            "https://www.loopnet.com/search/multifamily-properties/columbus-oh/for-sale/",
            "https://www.loopnet.com/search/multifamily-properties/cleveland-oh/for-sale/",
            "https://www.loopnet.com/search/multifamily-properties/toledo-oh/for-sale/",
            "https://www.loopnet.com/search/multifamily-properties/milwaukee-wi/for-sale/",
            "https://www.loopnet.com/search/apartment-buildings/wi/for-sale/",
          ],
      maxPagesPerUrl: Number(process.env.LOOPNET_MAX_PAGES ?? 3),
    },
  },
} as const;

export type Config = typeof config;
