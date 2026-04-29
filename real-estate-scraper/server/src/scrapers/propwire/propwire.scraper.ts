// src/scrapers/propwire/propwire.scraper.ts
//
// ── Strategy ──────────────────────────────────────────────────────────────────
//
// Propwire is a React SPA that:
//   1. Requires a free account (session cookie) to return property data
//   2. Embeds all search results in __NEXT_DATA__ inside the rendered HTML
//   3. Uses a URL-encoded JSON `filters` query param for search configuration
//
// We fetch pages via Oxylabs (render:html) which:
//   - Handles JS rendering so __NEXT_DATA__ is populated
//   - Rotates residential IPs to avoid rate limits
//   - We inject the session cookie via Oxylabs context with force_cookies:true
//
// COOKIE FORMAT (Oxylabs requirement):
//   Cookies must be passed as an array of {key, value} objects, NOT as a
//   cookie string. force_cookies:true must also be set. Passing a raw
//   "session=xxx" string causes Oxylabs to return HTTP 400.
//
//   Correct format:
//   context: [
//     { key: "force_cookies", value: true },
//     { key: "cookies", value: [{ key: "laravel_session", value: "eyJ..." }] },
//   ]
//
// SEARCH URL PATTERN:
//   https://propwire.com/search?filters=<URL-encoded JSON>&page=<N>
//
//   Filters JSON shape:
//   {
//     "locations": [
//       { "searchType": "C", "state": "OH", "title": "Columbus, OH",
//         "stateName": "Ohio", "city": "Columbus" }
//     ],
//     "lead_type":      ["for_sale"],
//     "property_type":  ["sfr","mfr"],
//     "estimated_value": { "max": 300000 },
//     "mls_status":     ["Active"]
//   }
//
// AUTHENTICATION:
//   Propwire requires a logged-in session cookie to return data.
//   Set PROPWIRE_SESSION_COOKIE=<value> in .env.
//
//   HOW TO GET THE CORRECT COOKIE VALUE:
//     1. Open Chrome and log into propwire.com
//     2. Open DevTools (F12) → Application tab → Cookies → https://propwire.com
//     3. Look for a cookie named "laravel_session" (most common) or "session"
//        or "__Secure-session". It will have a long encoded value.
//     4. Copy only the VALUE (not the name), paste into .env:
//        PROPWIRE_SESSION_COOKIE=eyJpdiI6...
//
//   HOW TO VERIFY THE COOKIE IS WORKING:
//     Run: npm run scrape:propwire
//     Check logs/propwire_search_columbus_oh_p1.html
//     - If it contains "__NEXT_DATA__" and property objects → cookie is valid
//     - If it contains "Sign In" or "Don't have an account" → cookie is expired
//     - If the file is missing → Oxylabs call failed (check credentials)
//
//   COOKIE EXPIRY: Propwire session cookies typically expire after 2 hours of
//   inactivity. If you get empty results, refresh the cookie by logging in
//   again and copying the new value.
//
// Required .env:
//   OXYLABS_USERNAME=your_api_user
//   OXYLABS_PASSWORD=your_api_password
//   PROPWIRE_SESSION_COOKIE=<laravel_session cookie value from DevTools>
//
// Optional .env:
//   PROPWIRE_MAX_PAGES=10
//   PROPWIRE_DETAIL_LIMIT=20
//   PROPWIRE_LEAD_TYPES=for_sale,preforeclosure   (comma-separated)
//
// ── Debug artefacts → logs/ ───────────────────────────────────────────────────
//   propwire_search_<market>_p<N>.html   — raw rendered search page HTML
//   propwire_json_<market>_p<N>.json     — __NEXT_DATA__ from search page
//   propwire_detail_<id>.html            — detail page HTML (Phase 2)
//   propwire_detail_<id>.json            — __NEXT_DATA__ from detail page
//   propwire.json                        — final accepted + rejected dump
//
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions }  from "../base.scraper";
import { BrowserHandle, sleep, jitter } from "../../utils/browser";
import { RawListing }                   from "../../types/listing";
import { logger }                       from "../../utils/logger";
import {
  parsePropwireSearchPage,
  extractEstimateFromDetailPage,
  extractNextData,
  MAX_DAYS_OLD,
} from "./propwire.parser";
import { config } from "../../config";

// ── Config ────────────────────────────────────────────────────────────────────

const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME   ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD   ?? "";
const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

const SESSION_COOKIE     = process.env.PROPWIRE_SESSION_COOKIE ?? "";

const REQUEST_TIMEOUT_MS = 120_000;
const BETWEEN_PAGE_MS    = 3_000;
const BETWEEN_DETAIL_MS  = 2_000;
const DEBUG_PAGES        = 3;

const MAX_PAGES          = Number(process.env.PROPWIRE_MAX_PAGES    ?? 10);
const DETAIL_LIMIT       = Number(process.env.PROPWIRE_DETAIL_LIMIT ?? 20);

// Lead types to search for — covers both on-market and motivated sellers
const LEAD_TYPES: string[] = (process.env.PROPWIRE_LEAD_TYPES ?? "for_sale")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Market definitions ────────────────────────────────────────────────────────

interface PropwireMarket {
  name:      string;   // human-readable label for logs
  state:     string;   // two-letter state code
  stateName: string;   // full state name
  city?:     string;   // optional city-level filter
}

const DEFAULT_MARKETS: PropwireMarket[] = [
  { name: "Columbus, OH",  state: "OH", stateName: "Ohio",      city: "Columbus"  },
  { name: "Cleveland, OH", state: "OH", stateName: "Ohio",      city: "Cleveland" },
  { name: "Toledo, OH",    state: "OH", stateName: "Ohio",      city: "Toledo"    },
  { name: "Milwaukee, WI", state: "WI", stateName: "Wisconsin", city: "Milwaukee" },
];

function getMarkets(): PropwireMarket[] {
  return (config.sources as any)?.propwire?.markets ?? DEFAULT_MARKETS;
}

// ── Search URL builder ────────────────────────────────────────────────────────

function buildSearchUrl(market: PropwireMarket, page: number): string {
  const locationEntry: Record<string, any> = {
    searchType: market.city ? "C" : "T",
    state:      market.state,
    stateName:  market.stateName,
    title:      market.city
      ? `${market.city}, ${market.state}`
      : `${market.stateName}, USA`,
  };
  if (market.city) locationEntry.city = market.city;

  const filters: Record<string, any> = {
    locations:      [locationEntry],
    lead_type:      LEAD_TYPES,
    property_type:  ["sfr", "mfr"],
    estimated_value: { max: config.filter.maxPrice },
  };

  if (LEAD_TYPES.includes("for_sale")) {
    filters.mls_status = ["Active"];
  }

  const params = new URLSearchParams({ filters: JSON.stringify(filters) });
  if (page > 1) params.set("page", String(page));

  return `https://propwire.com/search?${params.toString()}`;
}

// ── Cookie parser ─────────────────────────────────────────────────────────────
//
// Converts PROPWIRE_SESSION_COOKIE env var into the Oxylabs cookie array
// format: [{ key: "laravel_session", value: "eyJ..." }]
//
// The env var can be in two forms:
//   1. Raw value only:  "eyJpdiI6..."
//      → assumed to be laravel_session (Propwire's primary auth cookie)
//   2. name=value pair: "laravel_session=eyJpdiI6..."
//      → split on first "=" and use as-is
//
// If multiple cookies are needed, separate them with ";" in the env var:
//   PROPWIRE_SESSION_COOKIE=laravel_session=eyJ...;XSRF-TOKEN=abc...

function parseCookieEnv(raw: string): Array<{ key: string; value: string }> {
  if (!raw) return [];

  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eqIdx = part.indexOf("=");
      if (eqIdx === -1) {
        // No "=" — treat entire string as the laravel_session value
        return { key: "laravel_session", value: part };
      }
      return {
        key:   part.slice(0, eqIdx).trim(),
        value: part.slice(eqIdx + 1).trim(),
      };
    });
}

// ── Oxylabs client ────────────────────────────────────────────────────────────
//
// Cookie injection uses Oxylabs' force_cookies context flag with the
// cookies array format. Passing a raw cookie string causes HTTP 400.
//
// Correct Oxylabs cookie context shape:
//   { key: "force_cookies", value: true }
//   { key: "cookies", value: [{ key: "laravel_session", value: "eyJ..." }] }

async function decompressBuffer(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (err, r) => (err ? reject(err) : resolve(r)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (err, r) => {
        if (err) zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (err, r) => (err ? reject(err) : resolve(r)));
    } else {
      resolve(buf);
    }
  });
}

async function oxylabsFetch(
  targetUrl:    string,
  sessionCookie = SESSION_COOKIE
): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[propwire] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  if (!sessionCookie) {
    logger.error(
      "[propwire] PROPWIRE_SESSION_COOKIE not set — Propwire returns empty results without auth.\n" +
      "[propwire] Log into propwire.com → DevTools → Application → Cookies → " +
      "copy 'laravel_session' value → add to .env"
    );
    return null;
  }

  // Build cookie array in the format Oxylabs requires.
  // force_cookies:true must be a separate context entry — omitting it causes
  // the cookies to be ignored even if the array is correctly formed.
  const cookieArray = parseCookieEnv(sessionCookie);

  const payload: Record<string, any> = {
    source:          "universal",
    url:             targetUrl,
    render:          "html",
    geo_location:    "United States",
    user_agent_type: "desktop_chrome",
    context: [
      { key: "follow_redirects", value: true },
      { key: "force_cookies",    value: true },
      { key: "cookies",          value: cookieArray },
    ],
  };

  const bodyStr = JSON.stringify(payload);
  const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

  logger.debug(`[propwire] Oxylabs → ${targetUrl}`);
  logger.debug(`[propwire] Cookie keys: [${cookieArray.map((c) => c.key).join(", ")}]`);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":    "application/json",
          "Authorization":   `Basic ${authStr}`,
          "Content-Length":  Buffer.byteLength(bodyStr).toString(),
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", async () => {
          const buf      = Buffer.concat(chunks);
          const encoding = (res.headers["content-encoding"] ?? "").trim();
          let dec: Buffer;
          try { dec = encoding ? await decompressBuffer(buf, encoding) : buf; }
          catch { dec = buf; }

          const raw    = dec.toString("utf-8");
          const status = res.statusCode ?? 0;

          if (status === 400) {
            // Log the body so we can see what Oxylabs rejected
            logger.error(
              `[propwire] Oxylabs HTTP 400 — malformed request payload.\n` +
              `[propwire] Response: ${raw.slice(0, 500)}`
            );
            resolve(null); return;
          }
          if (status === 401) {
            logger.error("[propwire] Oxylabs 401 — check OXYLABS_USERNAME / OXYLABS_PASSWORD");
            resolve(null); return;
          }
          if (status === 429) {
            logger.warn("[propwire] Oxylabs 429 — rate limited");
            resolve(null); return;
          }
          if (status !== 200) {
            logger.warn(`[propwire] Oxylabs HTTP ${status}: ${raw.slice(0, 300)}`);
            resolve(null); return;
          }

          let envelope: any;
          try { envelope = JSON.parse(raw); }
          catch {
            logger.warn("[propwire] Could not parse Oxylabs envelope");
            resolve(null); return;
          }

          const result0     = envelope?.results?.[0];
          const innerStatus = result0?.status_code ?? 200;
          const content     = result0?.content ?? "";

          if (innerStatus === 401 || innerStatus === 403) {
            logger.warn(`[propwire] Inner HTTP ${innerStatus} — session cookie may be expired`);
            resolve(null); return;
          }
          if (innerStatus === 429) {
            logger.warn("[propwire] Inner 429 — waiting 10s");
            await sleep(10_000);
            resolve(null); return;
          }
          if (!content || content.length < 3_000) {
            logger.warn(
              `[propwire] Short content (${content.length} chars) — possible auth failure.\n` +
              `[propwire] Check logs/propwire_search_*.html for login page indicators.`
            );
            resolve(null); return;
          }

          logger.debug(`[propwire] Oxylabs OK — ${content.length} chars, inner=${innerStatus}`);
          resolve(content);
        });
        res.on("error", (err: any) => {
          logger.warn(`[propwire] Stream error: ${err.message}`);
          resolve(null);
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.warn(`[propwire] Oxylabs timeout after ${REQUEST_TIMEOUT_MS / 1_000}s`);
      req.destroy();
      resolve(null);
    });
    req.on("error", (err: any) => {
      logger.error(`[propwire] Request error [${err.code ?? "?"}]: ${err.message}`);
      resolve(null);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── Block / auth detection ────────────────────────────────────────────────────

const BLOCK_SIGNALS = [
  "challenges.cloudflare.com",
  'id="px-captcha"',
  "Enable JavaScript and cookies to continue",
  "Just a moment",
  "__KASADA__",
];

function detectIssue(html: string): { blocked: boolean; noAuth: boolean; reason: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase();

  const sig = BLOCK_SIGNALS.find((s) => html.toLowerCase().includes(s.toLowerCase()));
  if (sig) return { blocked: true, noAuth: false, reason: `block signal: ${sig}` };

  if (["access denied", "just a moment", "security check"].some((t) => title.includes(t)))
    return { blocked: true, noAuth: false, reason: `block title: "${title}"` };

  // Propwire-specific: page loads but shows login prompt — cookie is bad/expired
  if (
    html.includes("Sign In") &&
    html.includes("Don't have an account") &&
    !html.includes("__NEXT_DATA__")
  ) {
    return {
      blocked: false,
      noAuth:  true,
      reason:  "login page — session cookie expired or invalid. " +
               "Refresh PROPWIRE_SESSION_COOKIE: log into propwire.com → " +
               "DevTools → Application → Cookies → copy 'laravel_session' value",
    };
  }

  return { blocked: false, noAuth: false, reason: "" };
}

// ── File helpers ──────────────────────────────────────────────────────────────

function saveFile(filename: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    logger.info(`[propwire] Saved → logs/${filename}`);
  } catch (err) {
    logger.warn(`[propwire] Could not save ${filename}: ${err}`);
  }
}

function marketSlug(market: PropwireMarket): string {
  return `${market.city ?? market.state}_${market.state}`
    .replace(/[^a-z0-9]/gi, "_")
    .toLowerCase();
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class PropwireScraper extends BaseScraper {
  readonly sourceName = "propwire";

  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const markets = getMarkets();
    logger.info(
      `[propwire] ${markets.length} market(s), up to ${MAX_PAGES} page(s) each\n` +
        markets.map((m) => `  • ${m.name}`).join("\n")
    );
    logger.info(
      `[propwire] Lead types: [${LEAD_TYPES.join(", ")}] | ` +
      `Max price: $${config.filter.maxPrice.toLocaleString()}`
    );
    logger.info(
      `[propwire] Fetch mode: Oxylabs render:html | ` +
      `Detail enrichment: ${DETAIL_LIMIT} listings`
    );

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error("[propwire] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    }
    if (!SESSION_COOKIE) {
      logger.error(
        "[propwire] PROPWIRE_SESSION_COOKIE not set in .env — results will be empty.\n" +
        "[propwire] Log into propwire.com → DevTools → Application → Cookies → " +
        "copy 'laravel_session' cookie value → add to .env as PROPWIRE_SESSION_COOKIE=<value>"
      );
    } else {
      // Log which cookie names were parsed so user can verify at startup
      const parsed = parseCookieEnv(SESSION_COOKIE);
      logger.info(`[propwire] Session cookies loaded: [${parsed.map((c) => c.key).join(", ")}]`);
    }
  }

  override async run(): Promise<RawListing[]> {
    logger.info(`[propwire] Starting`);
    this.visited.clear();
    this.results     = [];
    this.allListings = [];

    const markets  = getMarkets();
    const rejected: Array<{ listing: RawListing; reason: string }> = [];
    let   authFailed = false;

    // ── Phase 1: Search pages per market ──────────────────────────────────

    for (const market of markets) {
      if (authFailed) break;
      if (this.results.length >= this.options.maxListings) {
        logger.info(`[propwire] maxListings reached — skipping remaining markets`);
        break;
      }

      logger.info(`[propwire] ── Market: ${market.name}`);
      let knownPages = 0;

      for (let page = 1; page <= MAX_PAGES; page++) {
        if (this.results.length >= this.options.maxListings) break;
        if (knownPages > 0 && page > knownPages) {
          logger.info(`[propwire] All ${knownPages} pages fetched for ${market.name}`);
          break;
        }

        const url = buildSearchUrl(market, page);
        logger.info(`[propwire] ${market.name} page ${page}/${MAX_PAGES} → ${url}`);

        const html = await oxylabsFetch(url);
        if (!html) {
          logger.warn(`[propwire] No HTML for ${market.name} page ${page} — stopping`);
          break;
        }

        if (page <= DEBUG_PAGES) {
          saveFile(`propwire_search_${marketSlug(market)}_p${page}.html`, html);
        }

        const { blocked, noAuth, reason } = detectIssue(html);
        if (blocked) {
          logger.error(`[propwire] Blocked on ${market.name} p${page}: ${reason}`);
          saveFile(`propwire_blocked_${marketSlug(market)}_p${page}.html`, html);
          break;
        }
        if (noAuth) {
          logger.error(`[propwire] Auth failed — ${reason}`);
          authFailed = true;
          break;
        }

        if (!html.includes("__NEXT_DATA__") && !html.includes("propwire")) {
          logger.warn(`[propwire] Page doesn't look like Propwire — saving for inspection`);
          saveFile(`propwire_unexpected_${marketSlug(market)}_p${page}.html`, html);
          break;
        }

        const nextData = extractNextData(html);
        if (!nextData) {
          logger.warn(`[propwire] No __NEXT_DATA__ on ${market.name} p${page}`);
          saveFile(`propwire_no_nextdata_${marketSlug(market)}_p${page}.html`, html);
          break;
        }

        if (page <= DEBUG_PAGES) {
          saveFile(
            `propwire_json_${marketSlug(market)}_p${page}.json`,
            JSON.stringify(nextData, null, 2)
          );
        }

        const { listings, allStale, totalPages } =
          parsePropwireSearchPage(nextData);

        if (page === 1 && totalPages > 0) {
          knownPages = Math.min(totalPages, MAX_PAGES);
          logger.info(`[propwire] ${market.name}: ${totalPages} total pages (cap ${knownPages})`);
        }

        logger.info(
          `[propwire] ${market.name} p${page}: ${listings.length} listing(s)` +
          (allStale ? " — all stale" : "")
        );

        this.allListings.push(...listings);

        for (const listing of listings) {
          if (this.results.length >= this.options.maxListings) break;

          if (!listing.url) {
            rejected.push({ listing, reason: "no_url" }); continue;
          }
          if (this.visited.has(listing.url)) {
            rejected.push({ listing, reason: "duplicate" }); continue;
          }
          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(`[propwire] ✗ ${listing.address} @ ${listing.price}`);
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);
          logger.info(
            `[propwire] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address} @ $${listing.price?.toLocaleString() ?? "?"} ` +
            ((listing as any).propwireEstimate
              ? `| AVM $${(listing as any).propwireEstimate.toLocaleString()}`
              : "| no AVM")
          );
        }

        if (allStale || listings.length === 0) break;

        await sleep(jitter(BETWEEN_PAGE_MS));
      }
    }

    logger.info(
      `[propwire] Phase 1 done — ${this.results.length} accepted, ${rejected.length} rejected`
    );

    // ── Phase 2: Detail page enrichment ───────────────────────────────────

    if (!authFailed) {
      const needsDetail = this.results
        .filter((l) => (l as any).propwireEstimate == null)
        .slice(0, DETAIL_LIMIT);

      if (needsDetail.length > 0) {
        logger.info(
          `[propwire] Phase 2: detail enrichment for ${needsDetail.length} listing(s)`
        );

        for (let i = 0; i < needsDetail.length; i++) {
          const listing = needsDetail[i];
          const label   = `[${i + 1}/${needsDetail.length}]`;

          logger.info(`[propwire] ${label} Detail: ${listing.address}`);

          const html = await oxylabsFetch(listing.url);
          if (!html) {
            logger.warn(`[propwire] ${label} No HTML for detail page`);
            await sleep(jitter(BETWEEN_DETAIL_MS));
            continue;
          }

          if (i < DEBUG_PAGES) {
            const id = (listing as any)._propwireId ?? i;
            saveFile(`propwire_detail_${id}.html`, html);
          }

          const { noAuth, blocked, reason } = detectIssue(html);
          if (noAuth || blocked) {
            logger.warn(`[propwire] ${label} Detail issue: ${reason}`);
            if (noAuth) { authFailed = true; break; }
            await sleep(jitter(BETWEEN_DETAIL_MS));
            continue;
          }

          const nextData = extractNextData(html);
          if (!nextData) {
            logger.debug(`[propwire] ${label} No __NEXT_DATA__ on detail page`);
            await sleep(jitter(BETWEEN_DETAIL_MS));
            continue;
          }

          if (i < DEBUG_PAGES) {
            const id = (listing as any)._propwireId ?? i;
            saveFile(`propwire_detail_${id}.json`, JSON.stringify(nextData, null, 2));
          }

          const est = extractEstimateFromDetailPage(nextData, listing.address ?? listing.url);
          if (est) {
            (listing as any).propwireEstimate = est.estimatedValue;
            (listing as any)._estimatedEquity = est.estimatedEquity;
            (listing as any)._taxAssessment   = est.taxAssessment;
            logger.info(
              `[propwire] ${label} ✓ AVM $${est.estimatedValue.toLocaleString()} ` +
              `for ${listing.address}` +
              (est.estimatedEquity ? ` | equity $${est.estimatedEquity.toLocaleString()}` : "")
            );
          } else {
            logger.debug(`[propwire] ${label} No AVM on detail page`);
          }

          await sleep(jitter(BETWEEN_DETAIL_MS));
        }

        const withAvm = this.results.filter((l) => (l as any).propwireEstimate != null).length;
        logger.info(
          `[propwire] Phase 2 done — AVM coverage: ${withAvm}/${this.results.length}`
        );
      }
    }

    // ── JSON dump ─────────────────────────────────────────────────────────
    saveFile(
      `${this.sourceName}.json`,
      JSON.stringify(
        {
          accepted:    this.results,
          rejected,
          allListings: this.allListings,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    logger.info(`[propwire] Finished — ${this.results.length} listings`);
    return this.results;
  }

  protected async scrapePage(_h: BrowserHandle, _p: number): Promise<RawListing[]> {
    return [];
  }
  protected shouldContinue(_p: number): boolean {
    return false;
  }
}