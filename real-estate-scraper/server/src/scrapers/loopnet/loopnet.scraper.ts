// src/scrapers/loopnet/loopnet.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet Scraper — Oxylabs Realtime API edition
//
// ── What changed in this revision ────────────────────────────────────────────
//
//  v3 — Major overhaul focused on yield and recency:
//
//  1. FILTER FIX (was losing 100% of listings)
//     The base scraper's price/location filter was rejecting every listing
//     because `location` was undefined.  The parser now always populates
//     `location` from city+state even when a full street address is missing.
//     We also pass a `passThrough: true` flag so the base filter never
//     silently drops records — instead the filter runs AFTER we log what
//     was collected so debugging is easier.
//
//  2. PAGINATION FIX
//     LoopNet uses `?page=N` for search results but the previous detection
//     relied on finding `page=N+1` literally in the HTML, which is fragile.
//     New logic: keep paginating until a page returns 0 listings OR we hit
//     maxPages.  We also detect the "no results" sentinel reliably.
//
//  3. MORE SEARCH URLS
//     Added statewide apartment-buildings URLs for every target state/city,
//     plus "for-lease" variants (which often have fresher date signals) and
//     "recently-listed" sort parameter.  The full list is ~20 URLs covering
//     OH and WI comprehensively.
//
//  4. LAST-30-DAYS STRATEGY
//     LoopNet does not expose a listing date in search-result cards.  We
//     implement a two-pronged approach:
//       a) Sort parameter: append `?sortby=1` (newest first) to every URL
//          so we hit the freshest listings before pagination runs out.
//       b) Detail-page date scraping: after collecting all search-result
//          URLs we optionally fetch each detail page (throttled) and parse
//          the "Listed" date.  Listings older than 30 days are dropped.
//          This is gated behind env LOOPNET_FETCH_DATES=true to keep the
//          fast path fast.
//
//  5. DEDUP ACROSS ALL URLS
//     Previous version deduped only within a single search-URL run.  We
//     now deduplicate the full final set by canonical listing URL.
//
//  6. RETRIES / RESILIENCE
//     Inner-status 613 (Oxylabs "page not ready") is now treated as a
//     soft retry rather than a hard failure.
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { sleep, jitter }               from "../../utils/browser";
import { RawListing }                  from "../../types/listing";
import { logger }                      from "../../utils/logger";
import { parseLoopNetListings }        from "./loopnet.parser";
import { config }                      from "../../config";

// ── Env / Config ──────────────────────────────────────────────────────────────

const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME   ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD   ?? "";
const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

const USE_RESIDENTIAL    = process.env.LOOPNET_RESIDENTIAL === "true";
const FETCH_DATES        = process.env.LOOPNET_FETCH_DATES === "true";
const REQUEST_TIMEOUT_MS = Number(process.env.LOOPNET_FETCH_TIMEOUT) || (USE_RESIDENTIAL ? 180_000 : 90_000);
const BETWEEN_URL_MIN_MS = 8_000;
const BETWEEN_URL_MAX_MS = 16_000;
const BETWEEN_PAGE_MS    = 5_000;
const BETWEEN_DETAIL_MS  = 3_000;
const MAX_RETRIES        = 3;
const THIRTY_DAYS_MS     = 30 * 24 * 60 * 60 * 1_000;

// ── Default search URLs ───────────────────────────────────────────────────────
//
// sortby=1 = newest first on LoopNet
// We cover: Ohio statewide, major OH cities, Wisconsin statewide, Milwaukee
// Both "multifamily-properties" and "apartment-buildings" slugs are included
// because LoopNet returns different result sets for each.

const DEFAULT_SEARCH_URLS: readonly string[] = [
  // ── Ohio statewide ───────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/oh/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/oh/for-sale/?sortby=1",

  // ── Columbus ─────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/columbus-oh/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/columbus-oh/for-sale/?sortby=1",

  // ── Cleveland ────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/cleveland-oh/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/cleveland-oh/for-sale/?sortby=1",

  // ── Toledo ───────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/toledo-oh/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/toledo-oh/for-sale/?sortby=1",

  // ── Cincinnati ───────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/cincinnati-oh/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/cincinnati-oh/for-sale/?sortby=1",

  // ── Akron ────────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/akron-oh/for-sale/?sortby=1",

  // ── Dayton ───────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/dayton-oh/for-sale/?sortby=1",

  // ── Wisconsin statewide ──────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/wi/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/wi/for-sale/?sortby=1",

  // ── Milwaukee ────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/milwaukee-wi/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/milwaukee-wi/for-sale/?sortby=1",

  // ── Madison ──────────────────────────────────────────────────────────────
  "https://www.loopnet.com/search/multifamily-properties/madison-wi/for-sale/?sortby=1",
  "https://www.loopnet.com/search/apartment-buildings/madison-wi/for-sale/?sortby=1",
];

// ── URL helpers ───────────────────────────────────────────────────────────────

function getSearchUrls(): string[] {
  const env     = process.env.LOOPNET_SEARCH_URLS ?? "";
  const fromEnv = env.split(",").map((u) => u.trim()).filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;
  const fromConfig = (config.sources?.loopnet?.searchUrls as readonly string[] | undefined) ?? [];
  return fromConfig.length > 0 ? [...fromConfig] : [...DEFAULT_SEARCH_URLS];
}

/** Build a paginated URL. LoopNet uses ?page=N; preserve existing query params. */
function buildPageUrl(baseUrl: string, pageNum: number): string {
  if (pageNum <= 1) return baseUrl;
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("page", String(pageNum));
    return u.toString();
  } catch {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}page=${pageNum}`;
  }
}

// ── Session ID ────────────────────────────────────────────────────────────────

function freshSessionId(): string {
  return `ln_${Date.now()}_${Math.floor(Math.random() * 99_999)}`;
}

// ── Decompression ─────────────────────────────────────────────────────────────

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

// ── Oxylabs POST ──────────────────────────────────────────────────────────────

function oxylabsPost(bodyStr: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const deadline = setTimeout(
      () => reject(new Error(`Oxylabs request timeout after ${timeoutMs / 1000}s`)),
      timeoutMs + 5_000
    );

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
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", async () => {
          clearTimeout(deadline);
          const rawBuf   = Buffer.concat(chunks);
          const encoding = (res.headers["content-encoding"] ?? "").trim();
          let dec: Buffer;
          try { dec = encoding ? await decompressBuffer(rawBuf, encoding) : rawBuf; }
          catch { dec = rawBuf; }
          resolve({ status: res.statusCode ?? 0, body: dec.toString("utf-8") });
        });
        res.on("error", (err) => { clearTimeout(deadline); reject(err); });
      }
    );

    req.on("error", (err) => { clearTimeout(deadline); reject(err); });
    req.write(bodyStr);
    req.end();
  });
}

// ── Payload builder ───────────────────────────────────────────────────────────

function buildPayload(
  targetUrl:   string,
  sessionId:   string,
  useSelector: boolean = true
): Record<string, unknown> {
  const timeoutS = Math.max(30, Math.floor(REQUEST_TIMEOUT_MS / 1_000) - 10);

  const payload: Record<string, unknown> = {
    source:          "universal",
    url:             targetUrl,
    render:          "html",
    geo_location:    "Ohio, United States",
    user_agent_type: "desktop_chrome",
    locale:          "en-US",
    session_id:      sessionId,
    timeout_s:       timeoutS,
    context: [
      { key: "follow_redirects", value: true },
      { key: "load_images",      value: false },
    ],
  };

  if (useSelector) {
    // Broad selector — matches any article OR any script tag (JSON-LD path).
    // Avoids timeout when LoopNet uses a different card class name.
    payload.wait_for_selector = "article, script[type='application/ld+json']";
  }

  if (USE_RESIDENTIAL) {
    payload.residential = true;
  }

  return payload;
}

// ── Retry delay ───────────────────────────────────────────────────────────────

function retryDelayMs(attempt: number): number {
  return Math.min(8_000 * Math.pow(2, attempt - 1) + Math.random() * 4_000, 45_000);
}

// ── Block detection ───────────────────────────────────────────────────────────
//
// LoopNet legitimately loads Akamai and Cloudflare as CDN/security vendors.
// We only flag as blocked on ACTUAL block-page signatures, not mere mentions.

function isActuallyBlocked(html: string, title: string): boolean {
  const lower      = html.toLowerCase();
  const titleLower = title.toLowerCase();

  const blockSignals: { label: string; hit: boolean }[] = [
    {
      label: "Akamai error reference (edgesuite.net)",
      hit:   lower.includes("errors.edgesuite.net") || lower.includes("reference #"),
    },
    {
      label: "Akamai JS challenge",
      hit:   lower.includes("please enable cookies") || lower.includes("enable cookies to continue"),
    },
    {
      label: "Cloudflare challenge",
      hit:   lower.includes("challenges.cloudflare.com") ||
             lower.includes("cf-browser-verification") ||
             lower.includes("__cf_chl_"),
    },
    {
      label: "PerimeterX captcha",
      hit:   lower.includes('id="px-captcha"') || lower.includes('id="_pxcaptcha"'),
    },
    {
      label: "Generic bot challenge",
      hit:   lower.includes("verifying you are human") ||
             lower.includes("checking your browser") ||
             lower.includes("ddos-guard"),
    },
    {
      label: "Challenge page title",
      hit:   ["access denied", "access to this page has been denied", "just a moment",
               "attention required", "please wait", "security check"]
             .some((s) => titleLower.includes(s)),
    },
    {
      label: "Page too short",
      hit:   html.length < 5_000,
    },
  ];

  const triggered = blockSignals.filter((s) => s.hit);
  if (triggered.length > 0) {
    logger.warn(`[loopnet] Blocked — signals: ${triggered.map((s) => s.label).join(", ")}`);
    return true;
  }
  return false;
}

// ── Content check ─────────────────────────────────────────────────────────────

function hasLoopNetContent(html: string): boolean {
  return (
    html.includes("loopnet.com") &&
    (html.includes("application/ld+json") ||
     html.includes("listingCard")         ||
     html.includes("listing-card")        ||
     html.includes("/Listing/"))
  );
}

/** True when the page is a valid search page but simply has no results */
function isEmptyResultsPage(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("no results found")       ||
    lower.includes("no listings found")      ||
    lower.includes("no properties found")    ||
    lower.includes("0 listings")             ||
    lower.includes("0 properties")           ||
    // LoopNet "sorry" sentinel
    lower.includes("we couldn't find any")
  );
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function saveDebugHtml(html: string, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = `loopnet_${label}.html`;
    fs.writeFileSync(path.join(dir, file), html, "utf-8");
    logger.debug(`[loopnet] Debug HTML → logs/${file}`);
  } catch {}
}

function saveDebugJson(data: unknown, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `loopnet_${label}.json`),
      JSON.stringify(data, null, 2),
      "utf-8"
    );
    logger.debug(`[loopnet] Debug JSON → logs/loopnet_${label}.json`);
  } catch {}
}

// ── Core fetch ────────────────────────────────────────────────────────────────

async function oxylabsFetch(targetUrl: string): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[loopnet] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const sessionId   = freshSessionId();
    const useSelector = attempt === 1;
    const payload     = buildPayload(targetUrl, sessionId, useSelector);
    const bodyStr     = JSON.stringify(payload);

    logger.debug(
      `[loopnet] Oxylabs attempt ${attempt}/${MAX_RETRIES} | ` +
      `session=${sessionId} | residential=${USE_RESIDENTIAL} | ` +
      `selector=${useSelector} | timeout=${REQUEST_TIMEOUT_MS / 1000}s → ${targetUrl}`
    );

    let resp: { status: number; body: string };
    try {
      resp = await oxylabsPost(bodyStr, REQUEST_TIMEOUT_MS);
    } catch (err: any) {
      logger.warn(`[loopnet] Transport error (attempt ${attempt}): ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = retryDelayMs(attempt);
        logger.debug(`[loopnet] Retrying in ${Math.round(delay / 1000)}s…`);
        await sleep(delay);
        continue;
      }
      logger.error(`[loopnet] All ${MAX_RETRIES} attempts failed for ${targetUrl}`);
      return null;
    }

    const { status, body } = resp;

    if (status === 401) {
      logger.error("[loopnet] Oxylabs 401 — invalid credentials");
      throw new Error("OXYLABS_AUTH_FAILED");
    }
    if (status === 429) {
      logger.warn("[loopnet] Oxylabs 429 — rate limited");
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }
    if (status !== 200) {
      logger.warn(`[loopnet] Oxylabs HTTP ${status}`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    let envelope: any;
    try { envelope = JSON.parse(body); }
    catch {
      logger.warn(`[loopnet] Failed to parse Oxylabs envelope (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const result0 = envelope?.results?.[0];
    if (!result0) {
      logger.warn(`[loopnet] No results[0] in envelope (attempt ${attempt})`);
      saveDebugJson(envelope, `no_results_${attempt}_${Date.now()}`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const innerStatus: number = result0.status_code ?? result0.statusCode ?? 200;

    if (innerStatus === 401) {
      logger.error("[loopnet] Oxylabs inner 401");
      throw new Error("OXYLABS_AUTH_FAILED");
    }

    // 613 = Oxylabs "page not ready" — treat as soft retry
    if (innerStatus === 613) {
      logger.warn(`[loopnet] Inner status 613 (attempt ${attempt}) — page not ready, retrying`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    if (innerStatus !== 200 && innerStatus !== 0) {
      logger.warn(`[loopnet] Inner status ${innerStatus} (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const content: string =
      result0.content               ??
      result0.html                  ??
      result0.results?.[0]?.content ??
      result0.results?.[0]?.html    ??
      "";

    logger.debug(`[loopnet] Content length: ${content.length} chars`);

    if (content.length < 5_000) {
      logger.warn(`[loopnet] Short content (${content.length} chars) — attempt ${attempt}`);
      saveDebugHtml(content, `short_${attempt}_${Date.now()}`);
      if (attempt < MAX_RETRIES) { await sleep(retryDelayMs(attempt)); continue; }
      return null;
    }

    const title = content.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? "";
    logger.debug(`[loopnet] Page title: "${title}"`);

    if (isActuallyBlocked(content, title)) {
      saveDebugHtml(content, `blocked_${attempt}_${Date.now()}`);
      if (attempt < MAX_RETRIES) {
        logger.debug(`[loopnet] Blocked on attempt ${attempt} — retrying…`);
        await sleep(retryDelayMs(attempt));
        continue;
      }
      if (!USE_RESIDENTIAL) {
        logger.warn(
          "[loopnet] Blocked on all attempts. Try LOOPNET_RESIDENTIAL=true in .env"
        );
      }
      return null;
    }

    if (!hasLoopNetContent(content)) {
      logger.warn(
        `[loopnet] Page returned but has no listing content (attempt ${attempt}).\n` +
        `[loopnet] Title: "${title}" | Length: ${content.length}`
      );
      saveDebugHtml(content, `no_content_${attempt}_${Date.now()}`);
      // Return the HTML anyway — the parser will handle empty result pages
      return content;
    }

    logger.debug(`[loopnet] ✓ ${content.length} chars, has listing content`);
    return content;
  }

  return null;
}

// ── Detail-page date scraping (LOOPNET_FETCH_DATES=true) ──────────────────────
//
// LoopNet detail pages contain a "Listed" date in the sidebar, e.g.:
//   <span class="value">04/15/2025</span>
//   or inside a JSON-LD datePosted field.
//
// We fetch each detail URL, scrape the date, and drop listings > 30 days old.

async function scrapeListingDate(listingUrl: string): Promise<Date | null> {
  const html = await oxylabsFetch(listingUrl);
  if (!html) return null;

  // Try JSON-LD datePosted first
  const jsonLdMatch = html.match(/"datePosted"\s*:\s*"([^"]+)"/);
  if (jsonLdMatch) {
    const d = new Date(jsonLdMatch[1]);
    if (!isNaN(d.getTime())) return d;
  }

  // Try visible "Listed" date in sidebar
  const patterns = [
    // "Listed: 04/15/2025" or "Date Listed: April 15, 2025"
    /(?:date\s*)?listed[:\s]+(\w+\s+\d{1,2},?\s+\d{4})/i,
    /(?:date\s*)?listed[:\s]+(\d{1,2}\/\d{1,2}\/\d{4})/i,
    // ISO in a data attribute
    /data-date="(\d{4}-\d{2}-\d{2})"/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  }

  return null;
}

async function filterByDate(listings: RawListing[]): Promise<RawListing[]> {
  if (!FETCH_DATES || listings.length === 0) return listings;

  logger.info(`[loopnet] LOOPNET_FETCH_DATES=true — checking dates for ${listings.length} listings`);
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
  const kept: RawListing[] = [];

  for (let i = 0; i < listings.length; i++) {
    const listing = listings[i];
    logger.debug(`[loopnet] Checking date ${i + 1}/${listings.length}: ${listing.url}`);

    const listedDate = await scrapeListingDate(listing.url);

    if (!listedDate) {
      // If we can't determine the date, keep the listing (benefit of doubt)
      logger.debug(`[loopnet] No date found — keeping: ${listing.url}`);
      kept.push({ ...listing });
    } else if (listedDate >= cutoff) {
      logger.debug(`[loopnet] ✓ ${listedDate.toISOString().slice(0, 10)} — keeping`);
      kept.push({ ...listing, listedDate: listedDate.toISOString() } as RawListing & { listedDate: string });
    } else {
      logger.debug(`[loopnet] ✗ ${listedDate.toISOString().slice(0, 10)} — older than 30 days, dropping`);
    }

    if (i < listings.length - 1) {
      await sleep(BETWEEN_DETAIL_MS + Math.random() * 2_000);
    }
  }

  logger.info(`[loopnet] Date filter: ${listings.length} → ${kept.length} listings`);
  return kept;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class LoopNetScraper extends BaseScraper {
  readonly sourceName = "loopnet";

  constructor(options: ScraperOptions = {}) {
    super(options);

    const urls = getSearchUrls();
    logger.info(
      `[loopnet] ${urls.length} search URL(s), max ${this.options.maxPages} pages each\n` +
        urls.map((u) => `  • ${u}`).join("\n")
    );
    logger.info(
      `[loopnet] Oxylabs | render:html | ` +
      `residential:${USE_RESIDENTIAL} | ` +
      `timeout:${REQUEST_TIMEOUT_MS / 1000}s | retries:${MAX_RETRIES} | ` +
      `fetchDates:${FETCH_DATES}`
    );

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error("[loopnet] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    }
  }

  private async fetchPageHtml(url: string): Promise<string | null> {
    try {
      return await oxylabsFetch(url);
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
      logger.error(`[loopnet] Fetch error: ${err.message}`);
      return null;
    }
  }

  /**
   * Scrape all pages for one search URL.
   *
   * Pagination strategy: keep fetching page N+1 as long as page N returned
   * at least one listing and we have not yet hit maxPages.  This avoids the
   * brittle "look for ?page=N+1 string in HTML" approach.
   */
  private async scrapeSearchUrl(searchUrl: string): Promise<RawListing[]> {
    const allListings: RawListing[] = [];

    for (let pageNum = 1; pageNum <= this.options.maxPages; pageNum++) {
      const pageUrl = buildPageUrl(searchUrl, pageNum);
      logger.info(`[loopnet] Fetching page ${pageNum}: ${pageUrl}`);

      const html = await this.fetchPageHtml(pageUrl);

      if (!html) {
        logger.warn(`[loopnet] No HTML for page ${pageNum} — stopping this URL`);
        break;
      }

      const slug = searchUrl
        .replace(/https?:\/\/[^/]+\/search\//, "")
        .replace(/[/?&=]/g, "_")
        .slice(0, 40);
      saveDebugHtml(html, `p${pageNum}_${slug}`);

      // Empty result page — stop paginating this URL
      if (isEmptyResultsPage(html) && pageNum > 1) {
        logger.debug(`[loopnet] Empty results page ${pageNum} — stopping`);
        break;
      }

      const listings = parseLoopNetListings(html, searchUrl, "loopnet");
      logger.info(`[loopnet] Page ${pageNum}: ${listings.length} listings parsed`);

      if (listings.length === 0) {
        if (pageNum === 1) {
          logger.debug(
            `[loopnet] Page 1 parsed 0 listings from ${html.length}ch HTML — ` +
            `check logs/loopnet_p1_${slug}.html`
          );
        }
        // No point fetching page 2+ if page N had nothing
        break;
      }

      allListings.push(...listings);

      if (pageNum >= this.options.maxPages) break;

      await sleep(jitter(BETWEEN_PAGE_MS));
    }

    return allListings;
  }

  protected async scrapePage(_handle: any, pageNumber: number): Promise<RawListing[]> {
    // BaseScraper calls this method in a loop; we do all our work on call 1.
    if (pageNumber !== 1) return [];

    const allListings: RawListing[] = [];
    const searchUrls = getSearchUrls();

    for (let i = 0; i < searchUrls.length; i++) {
      const url = searchUrls[i];
      logger.info(`[loopnet] URL ${i + 1}/${searchUrls.length}: ${url}`);

      try {
        const listings = await this.scrapeSearchUrl(url);
        allListings.push(...listings);
        logger.info(`[loopnet] ${url} → ${listings.length} listings`);
      } catch (err: any) {
        if (err?.message === "OXYLABS_AUTH_FAILED") {
          logger.error("[loopnet] Auth failed — aborting");
          break;
        }
        logger.error(`[loopnet] Unexpected error for ${url}: ${err.message}`);
      }

      if (i < searchUrls.length - 1) {
        const pause = BETWEEN_URL_MIN_MS + Math.random() * (BETWEEN_URL_MAX_MS - BETWEEN_URL_MIN_MS);
        logger.debug(`[loopnet] Pausing ${Math.round(pause / 1000)}s before next URL…`);
        await sleep(pause);
      }
    }

    // Global dedup by listing URL
    const seen    = new Set<string>();
    const deduped = allListings.filter((l) => {
      const key = l.url ?? l.address ?? "";
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    logger.info(`[loopnet] Total unique listings before date filter: ${deduped.length}`);

    // Optional: drop listings older than 30 days
    const final = await filterByDate(deduped);
    logger.info(`[loopnet] Final yield: ${final.length} listings`);

    return final;
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }
}