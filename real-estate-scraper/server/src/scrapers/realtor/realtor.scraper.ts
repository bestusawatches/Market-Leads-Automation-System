// src/scrapers/realtor/realtor.scraper.ts
//
// ── Root cause of 613 / is_render_forced: false ───────────────────────────────
//
// Oxylabs confirmed Realtor.com IS accessible via the Web Scraper API.
// The 613 with is_render_forced: false means Oxylabs' auto-detection decided
// rendering wasn't needed and then the job faulted when the page turned out
// to require JS.  The previous fix attempts addressed the wrong layer.
//
// The actual fix is three-part:
//
//   1. Always send render: "html" — never rely on Oxylabs auto-detection for
//      Realtor.com.  Their auto-detect gets it wrong on this domain.
//
//   2. Send javascript: true explicitly (some plan tiers require this flag in
//      addition to render: "html" to actually execute JS).
//
//   3. Send a realistic set of browser headers via force_headers: true so the
//      page is served the same content a real Chrome session would receive.
//      Without these, Realtor.com may serve a bot-detection page instead of
//      the real SSR HTML, and __NEXT_DATA__ will be absent or minimal.
//
//   4. Use a state-specific geo_location so the CDN edge serves the correct
//      regional content.
//
//   5. Keep browser_instructions out — wait_for_element was the direct cause
//      of 613 when is_render_forced was false.  Use a top-level wait (ms int)
//      instead.
//
// ── Architecture ──────────────────────────────────────────────────────────────
//
// Realtor.com uses Next.js with full server-side rendering.  All search
// results are embedded in the initial HTML inside a <script id="__NEXT_DATA__">
// tag.  There are no separate XHR/API calls for the listing data — the React
// app hydrates from that embedded JSON.  This means:
//
//   • We fetch the search HTML page via Oxylabs (render: html).
//   • We extract __NEXT_DATA__ from the HTML.
//   • We parse props.pageProps.properties[] for listings.
//   • For estimates we fetch each detail page the same way and read
//     props.pageProps.property.estimates.estimate.
//
// ── Required .env ─────────────────────────────────────────────────────────────
//   OXYLABS_USERNAME=your_api_user
//   OXYLABS_PASSWORD=your_api_password
//
// ── Optional .env ─────────────────────────────────────────────────────────────
//   REALTOR_SEARCH_URLS     — comma-separated search URLs
//   REALTOR_MAX_PAGES       — per-URL page cap (default 10)
//   REALTOR_MAX_LISTINGS    — hard cap per run (default 200)
//   REALTOR_FETCH_ESTIMATES — set "false" to skip detail fetches
//

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
  parseRealtorResults,
  extractEstimateFromDetailNextData,
  MAX_DAYS_OLD,
} from "./realtor.parser";

// ── Config ────────────────────────────────────────────────────────────────────

const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD ?? "";
const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

const REQUEST_TIMEOUT_MS  = 180_000;
const BETWEEN_PAGE_MS     = 3_000;
const FETCH_ESTIMATES     = process.env.REALTOR_FETCH_ESTIMATES !== "false";
const DETAIL_CONCURRENCY  = 3;
const DEBUG_PAGES         = 3;

// ── Default search URLs ───────────────────────────────────────────────────────

const DEFAULT_SEARCH_URLS: string[] = [
  "https://www.realtor.com/realestateandhomes-search/Columbus_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Cleveland_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Toledo_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Milwaukee_WI/?price_max=300000&type=single_family,multi_family",
];

function getSearchUrls(): string[] {
  const env     = process.env.REALTOR_SEARCH_URLS ?? "";
  const fromEnv = env.split(",").map((u) => u.trim()).filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_SEARCH_URLS;
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildPageUrl(baseUrl: string, pageNumber: number): string {
  if (pageNumber <= 1) return baseUrl;
  try {
    const u         = new URL(baseUrl);
    const cleanPath = u.pathname.replace(/\/pg-\d+\/?$/, "").replace(/\/$/, "");
    u.pathname      = `${cleanPath}/pg-${pageNumber}`;
    return u.toString();
  } catch {
    const [base, qs] = baseUrl.split("?");
    const cleanBase  = base.replace(/\/pg-\d+\/?$/, "").replace(/\/$/, "");
    return qs ? `${cleanBase}/pg-${pageNumber}?${qs}` : `${cleanBase}/pg-${pageNumber}`;
  }
}

// ── Geo state ─────────────────────────────────────────────────────────────────

const STATE_MAP: Record<string, string> = {
  AL: "Alabama",    AK: "Alaska",    AZ: "Arizona",    AR: "Arkansas",
  CA: "California", CO: "Colorado",  CT: "Connecticut", DE: "Delaware",
  FL: "Florida",    GA: "Georgia",   HI: "Hawaii",     ID: "Idaho",
  IL: "Illinois",   IN: "Indiana",   IA: "Iowa",       KS: "Kansas",
  KY: "Kentucky",   LA: "Louisiana", ME: "Maine",      MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri",   MT: "Montana",   NE: "Nebraska",   NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon",     PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas",   UT: "Utah",
  VT: "Vermont",    VA: "Virginia",   WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin",  WY: "Wyoming",
};

function geoStateFromUrl(url: string): string {
  const match = url.match(/\/[A-Za-z_]+-?_([A-Z]{2})\//);
  if (match?.[1] && STATE_MAP[match[1]]) {
    return `${STATE_MAP[match[1]]}, United States`;
  }
  return "United States";
}

// ── Oxylabs transport ─────────────────────────────────────────────────────────

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

function rawHttpPost(
  bodyStr: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers: {
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
          try {
            dec = encoding ? await decompressBuffer(buf, encoding) : buf;
          } catch (e) {
            logger.warn(`[realtor] Decompression failed (${encoding}): ${e} — using raw`);
            dec = buf;
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers:    res.headers,
            body:       dec.toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () =>
      req.destroy(new Error("Request timed out"))
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Oxylabs payload builder ───────────────────────────────────────────────────
//
// KEY FIXES vs. the broken version:
//
//   render: "html"       always explicit — never rely on auto-detection
//   javascript: true     force JS execution on all plan tiers
//   force_headers: true  serve real Chrome headers → Realtor.com returns SSR
//   wait: 3000           simple ms wait, no browser_instructions (avoids 613)
//   geo_location         state-specific so CDN returns correct regional content

function buildPayload(
  targetUrl:  string,
  sessionId?: string
): Record<string, any> {
  const payload: Record<string, any> = {
    source:          "universal",
    url:             targetUrl,
    render:          "html",
    javascript:      true,
    geo_location:    geoStateFromUrl(targetUrl),
    user_agent_type: "desktop_chrome",
    locale:          "en-US",
    wait:            3_000,
    force_headers:   true,
    headers: {
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language":           "en-US,en;q=0.9",
      "Accept-Encoding":           "gzip, deflate, br",
      "Cache-Control":             "no-cache",
      "Pragma":                    "no-cache",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    context: [
      { key: "follow_redirects", value: true },
    ],
  };

  if (sessionId) payload.session_id = sessionId;

  return payload;
}

// ── oxylabsFetch ──────────────────────────────────────────────────────────────
//
// Single-strategy fetch — no fallback chain needed now that the root cause
// is understood.  Retries once on 613 since it can be a transient fault.
//
// If is_render_forced=false persists, that means the Oxylabs account does not
// have render:html enabled for realtor.com — contact support with the exact
// message logged below.

async function oxylabsFetch(
  targetUrl:  string,
  sessionId?: string
): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[realtor] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  for (let attempt = 0; attempt <= 1; attempt++) {
    const payload = buildPayload(targetUrl, sessionId);
    const bodyStr = JSON.stringify(payload);

    logger.debug(
      `[realtor] Oxylabs attempt=${attempt} render=html javascript=true ` +
      `force_headers=true geo="${payload.geo_location}" url=${targetUrl}`
    );

    let resp: { statusCode: number; headers: http.IncomingHttpHeaders; body: string };
    try {
      resp = await rawHttpPost(bodyStr);
    } catch (err: any) {
      logger.error(`[realtor] Transport error [${err.code ?? "?"}]: ${err.message}`);
      return null;
    }

    const { statusCode, body } = resp;

    if (statusCode === 401) {
      logger.error("[realtor] Oxylabs 401 — check credentials");
      return null;
    }
    if (statusCode === 429) {
      logger.warn("[realtor] Oxylabs 429 — waiting 15s");
      await sleep(15_000);
      continue;
    }
    if (statusCode !== 200) {
      logger.warn(`[realtor] Oxylabs HTTP ${statusCode} | ${body.slice(0, 400).replace(/\s+/g, " ")}`);
      return null;
    }

    let envelope: any;
    try {
      envelope = JSON.parse(body);
    } catch {
      logger.warn(`[realtor] Cannot parse Oxylabs envelope: ${body.slice(0, 300)}`);
      return null;
    }

    const result0        = envelope?.results?.[0];
    const innerStatus: number = result0?.status_code ?? result0?.statusCode ?? 200;
    const isRenderForced = result0?.is_render_forced;

    logger.debug(
      `[realtor] inner=${innerStatus} is_render_forced=${isRenderForced ?? "n/a"} attempt=${attempt}`
    );

    // Detect the plan-level render block and give an actionable message
    if (isRenderForced === false) {
      logger.warn(
        `[realtor] is_render_forced=false — Oxylabs ignored render:html.\n` +
        `  ↳ Reply to the Oxylabs support ticket:\n` +
        `    "We are sending render:'html' and javascript:true but getting\n` +
        `     is_render_forced=false and status 613 for realtor.com. Please\n` +
        `     enable JS rendering for this domain on our account."`
      );
    }

    if (innerStatus === 401) { logger.error("[realtor] Inner 401"); return null; }
    if (innerStatus === 403) { logger.warn(`[realtor] Inner 403 for ${targetUrl}`); return null; }
    if (innerStatus === 429) {
      logger.warn("[realtor] Inner 429 — waiting 15s");
      await sleep(15_000);
      continue;
    }
    if (innerStatus === 613) {
      if (attempt === 0) {
        logger.warn(`[realtor] 613 for ${targetUrl} — retrying once after 3s`);
        await sleep(3_000);
        continue;
      }
      logger.warn(
        `[realtor] 613 on both attempts for ${targetUrl}.\n` +
        `  is_render_forced=${isRenderForced} — if always false, reply to\n` +
        `  Oxylabs support: "Please enable render:html for realtor.com on our account.\n` +
        `  We are getting 613 with is_render_forced=false despite sending render:'html'."`
      );
      return null;
    }
    if (innerStatus !== 200 && innerStatus !== 0) {
      logger.warn(`[realtor] Inner ${innerStatus} for ${targetUrl}`);
      return null;
    }

    const content: string =
      result0?.content ??
      result0?.html    ??
      result0?.results?.[0]?.content ??
      "";

    if (!content) {
      logger.warn(`[realtor] Empty content for ${targetUrl}`);
      return null;
    }

    if (content.length < 5_000) {
      logger.warn(`[realtor] Short content (${content.length}ch) for ${targetUrl}`);
    }

    if (content.includes("__NEXT_DATA__")) {
      logger.debug(`[realtor] ✓ __NEXT_DATA__ found (${content.length}ch)`);
      return content;
    }

    // Got content but no __NEXT_DATA__ — likely a bot-detection page
    const pageTitle = content.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? "(none)";
    logger.warn(
      `[realtor] No __NEXT_DATA__ in ${content.length}-char response.\n` +
      `  Page title: "${pageTitle}"\n` +
      `  Saving to logs/realtor_no_nextdata_${attempt}.html for inspection.`
    );
    saveFile(`realtor_no_nextdata_${attempt}.html`, content);
    return null;
  }

  return null;
}

// ── __NEXT_DATA__ extractor ───────────────────────────────────────────────────

function extractNextData(html: string): any | null {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    logger.warn(`[realtor] Failed to parse __NEXT_DATA__: ${e}`);
    return null;
  }
}

// ── Block detection ───────────────────────────────────────────────────────────

const BLOCK_TITLES = [
  "access denied", "attention required", "just a moment",
  "security check", "are you a robot",
];
const BLOCK_SIGNALS = [
  'id="px-captcha"', 'id="_pxCaptcha"',
  "challenges.cloudflare.com", "errors.edgesuite.net",
  "Enable JavaScript and cookies to continue",
  "__KASADA__", "kasada.io",
];

function detectBlock(html: string): { blocked: boolean; reason: string } {
  const title = (
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""
  ).toLowerCase();

  if (BLOCK_TITLES.some((t) => title.includes(t)))
    return { blocked: true, reason: `title: "${title}"` };

  const sig = BLOCK_SIGNALS.find((s) =>
    html.toLowerCase().includes(s.toLowerCase())
  );
  if (sig) return { blocked: true, reason: `signal: ${sig}` };

  if (
    html.length < 5_000 &&
    !html.includes("__NEXT_DATA__") &&
    !html.includes("realtor.com")
  )
    return { blocked: true, reason: `too short (${html.length}ch)` };

  return { blocked: false, reason: "" };
}

// ── Concurrent detail-page estimate fetcher ───────────────────────────────────

async function attachEstimates(
  listings:  RawListing[],
  sessionId: string
): Promise<void> {
  if (!FETCH_ESTIMATES || listings.length === 0) return;

  logger.info(
    `[realtor] Fetching estimates for ${listings.length} listing(s) ` +
    `(concurrency=${DETAIL_CONCURRENCY})…`
  );

  let hit = 0, miss = 0;

  for (let i = 0; i < listings.length; i += DETAIL_CONCURRENCY) {
    const batch = listings.slice(i, i + DETAIL_CONCURRENCY);

    await Promise.all(
      batch.map(async (listing) => {
        const html = await oxylabsFetch(listing.url, sessionId);
        if (!html) { miss++; return; }

        const { blocked, reason } = detectBlock(html);
        if (blocked) {
          miss++;
          logger.warn(`[realtor] Detail blocked (${reason}): ${listing.url}`);
          return;
        }

        const nextData = extractNextData(html);
        if (!nextData) { miss++; return; }

        const est = extractEstimateFromDetailNextData(
          nextData,
          listing.address ?? listing.url
        );

        if (est) {
          (listing as any).zestimate      = est.estimate;
          (listing as any).zestimateLow   = est.estimateLow;
          (listing as any).zestimateHigh  = est.estimateHigh;
          (listing as any).estimateSource = est.provider ?? "realtor";
          hit++;
          logger.info(
            `[realtor] ✓ Estimate ${listing.address}: ` +
            `$${est.estimate.toLocaleString()}` +
            (est.estimateLow
              ? ` ($${est.estimateLow.toLocaleString()} – $${est.estimateHigh?.toLocaleString()})`
              : "")
          );
        } else {
          miss++;
        }
      })
    );

    if (i + DETAIL_CONCURRENCY < listings.length) {
      await sleep(800 + Math.random() * 400);
    }
  }

  logger.info(
    `[realtor] Estimates: ${hit} found, ${miss} missing out of ${listings.length}`
  );
}

// ── File helpers ──────────────────────────────────────────────────────────────

function saveFile(filename: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    logger.info(`[realtor] Saved → logs/${filename}`);
  } catch (e) {
    logger.warn(`[realtor] Could not save ${filename}: ${e}`);
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class RealtorScraper extends BaseScraper {
  readonly sourceName = "realtor";

  private stopPaging  = false;
  private knownPages  = 0;
  private allListings: RawListing[] = [];

  private readonly sessionId =
    `realtor_${Date.now()}_${Math.floor(Math.random() * 9_999)}`;

  constructor(options: ScraperOptions = {}) {
    super(options);

    const urls = getSearchUrls();
    logger.info(
      `[realtor] ${urls.length} search URL(s), up to ${this.options.maxPages} page(s) each\n` +
      urls.map((u) => `  • ${u}`).join("\n")
    );
    logger.info(
      `[realtor] Fetch mode: Oxylabs render:html + javascript:true + force_headers:true\n` +
      `[realtor] Estimates: ${FETCH_ESTIMATES ? `enabled (concurrency=${DETAIL_CONCURRENCY})` : "disabled"}`
    );

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error(
        "[realtor] OXYLABS_USERNAME / OXYLABS_PASSWORD not set — add to .env"
      );
    }
  }

  override async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting`);
    this.visited.clear();
    this.results     = [];
    this.allListings = [];
    this.stopPaging  = false;

    const searchUrls = getSearchUrls();
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    for (let urlIdx = 0; urlIdx < searchUrls.length; urlIdx++) {
      const baseUrl = searchUrls[urlIdx];
      logger.info(`[realtor] ── URL ${urlIdx + 1}/${searchUrls.length}: ${baseUrl}`);

      this.stopPaging = false;
      this.knownPages = 0;

      for (let page = 1; page <= this.options.maxPages; page++) {
        if (this.results.length >= this.options.maxListings) {
          logger.info(`[realtor] maxListings (${this.options.maxListings}) reached`);
          break;
        }

        logger.info(`[realtor] Page ${page}`);

        let pageListings: RawListing[] = [];
        try {
          pageListings = await this.scrapeOnePage(baseUrl, page);
        } catch (err) {
          logger.error(`[realtor] Page ${page} error: ${err}`);
          break;
        }

        logger.info(`[realtor] Page ${page}: ${pageListings.length} raw listing(s)`);
        this.allListings.push(...pageListings);

        await attachEstimates(pageListings, this.sessionId);

        for (const listing of pageListings) {
          if (this.results.length >= this.options.maxListings) break;

          if (!listing.url) {
            rejected.push({ listing, reason: "no_url" });
            continue;
          }
          if (this.visited.has(listing.url)) {
            rejected.push({ listing, reason: "duplicate" });
            continue;
          }
          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(`[realtor] ✗ ${listing.address} @ ${listing.price}`);
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);

          const est = (listing as any).zestimate as number | undefined;
          logger.info(
            `[realtor] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address ?? listing.title} @ ` +
            `$${listing.price?.toLocaleString() ?? "?"} ` +
            (est ? `| Estimate $${est.toLocaleString()}` : "| no estimate")
          );
        }

        if (!this.shouldContinuePaging(page, pageListings)) {
          logger.info(`[realtor] No more pages for this URL`);
          break;
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }

      if (urlIdx < searchUrls.length - 1) {
        const pause = 5_000 + Math.random() * 3_000;
        logger.debug(`[realtor] Pausing ${Math.round(pause / 1_000)}s before next URL…`);
        await sleep(pause);
      }
    }

    const withEstimate = this.results.filter(
      (l) => (l as any).zestimate != null
    ).length;
    logger.info(
      `[realtor] Finished — ${this.results.length} accepted, ` +
      `${rejected.length} rejected | ` +
      `${withEstimate}/${this.results.length} have an estimate`
    );

    saveFile(
      "realtor.json",
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

    return this.results;
  }

  private async scrapeOnePage(
    baseUrl:    string,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (this.stopPaging) return [];

    const pageUrl = buildPageUrl(baseUrl, pageNumber);
    logger.info(`[realtor] Fetching → ${pageUrl}`);

    const html = await oxylabsFetch(pageUrl, this.sessionId);
    if (!html) {
      logger.warn(`[realtor] No HTML for page ${pageNumber} — stopping`);
      this.stopPaging = true;
      return [];
    }

    if (pageNumber <= DEBUG_PAGES) {
      const slug = baseUrl
        .replace(/https?:\/\/[^/]+\/[^/]+\//, "")
        .replace(/\W+/g, "_")
        .slice(0, 30);
      saveFile(`realtor_html_p${pageNumber}_${slug}.html`, html);
    }

    const { blocked, reason } = detectBlock(html);
    if (blocked) {
      logger.error(`[realtor] Blocked on page ${pageNumber}: ${reason}`);
      saveFile(`realtor_blocked_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    if (!html.includes("__NEXT_DATA__")) {
      logger.error(`[realtor] No __NEXT_DATA__ on page ${pageNumber}`);
      saveFile(`realtor_no_nextdata_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    const nextData = extractNextData(html);
    if (!nextData) {
      logger.warn(`[realtor] Could not parse __NEXT_DATA__ on page ${pageNumber}`);
      this.stopPaging = true;
      return [];
    }

    if (pageNumber <= DEBUG_PAGES) {
      const slug = baseUrl
        .replace(/https?:\/\/[^/]+\/[^/]+\//, "")
        .replace(/\W+/g, "_")
        .slice(0, 30);
      saveFile(
        `realtor_json_p${pageNumber}_${slug}.json`,
        JSON.stringify(nextData, null, 2)
      );
    }

    const { listings, allStale, totalPages } = parseRealtorResults(nextData);

    if (pageNumber === 1 && totalPages > 0) {
      this.knownPages = Math.min(totalPages, this.options.maxPages);
      logger.info(
        `[realtor] ${totalPages} total page(s) (capped at ${this.knownPages})`
      );
    }

    logger.info(
      `[realtor] Page ${pageNumber}: ${listings.length} listing(s) within ` +
      `${MAX_DAYS_OLD}d` +
      (allStale ? " — all stale" : "")
    );

    if (allStale) this.stopPaging = true;
    return listings.map((l) => ({ ...l, source: this.sourceName }));
  }

  private shouldContinuePaging(page: number, last: RawListing[]): boolean {
    if (this.stopPaging)                                  return false;
    if (last.length === 0)                                return false;
    if (page >= this.options.maxPages)                    return false;
    if (this.knownPages > 0 && page >= this.knownPages)  return false;
    return true;
  }

  protected async scrapePage(
    _h: BrowserHandle,
    _p: number
  ): Promise<RawListing[]> {
    return [];
  }

  protected shouldContinue(_p: number): boolean {
    return false;
  }
}