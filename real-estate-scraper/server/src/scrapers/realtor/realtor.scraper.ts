// src/scrapers/realtor/realtor.scraper.ts
//
// ── Strategy ──────────────────────────────────────────────────────────────────
//
// After parsing each search-results page, we immediately fetch every listing's
// detail page via Oxylabs (render:html) and extract the Realtor Estimate from
// __NEXT_DATA__.props.pageProps.property.estimates.estimate.
//
// Detail fetches run in a small concurrent pool (DETAIL_CONCURRENCY = 3) so
// a page of 42 listings takes ~14 Oxylabs calls in parallel batches rather
// than 42 sequential ones. Each call is capped at 120 s.
//
// The estimate is stored on listing.zestimate so the rest of the pipeline
// (scorer, DB upsert) receives it with zero changes elsewhere.
//
// Required .env:
//   OXYLABS_USERNAME=your_api_user
//   OXYLABS_PASSWORD=your_api_password
//
// Optional .env:
//   REALTOR_SEARCH_URLS     — comma-separated search URLs
//   REALTOR_MAX_PAGES       — per-URL page cap (default 10)
//   REALTOR_MAX_LISTINGS    — hard cap per run  (default 200)
//   REALTOR_FETCH_ESTIMATES — set to "false" to skip detail fetches (faster,
//                             no estimates)
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
  parseRealtorResults,
  extractEstimateFromDetailNextData,
  MAX_DAYS_OLD,
} from "./realtor.parser";

// ── Config ────────────────────────────────────────────────────────────────────

const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD ?? "";
const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

const REQUEST_TIMEOUT_MS  = 120_000;
const BETWEEN_PAGE_MS     = 3_000;
const FETCH_ESTIMATES     = process.env.REALTOR_FETCH_ESTIMATES !== "false";

// How many detail pages to fetch simultaneously.
const DETAIL_CONCURRENCY  = 3;

// Save raw HTML + JSON for first N pages
const DEBUG_PAGES = 3;

// ── Source-type retry sequence ────────────────────────────────────────────────
//
// "universal_ecommerce" is intentionally removed from the sequence.
// It does not support JS rendering (is_render_forced=false) so it can never
// deliver __NEXT_DATA__ from Realtor.com's React/Next.js pages — it will
// always return 613 (faulted). We use only "universal" with render:html and
// correct browser_instructions for the wait-for-element step.

const SOURCE_TYPE_SEQUENCE = [
  "universal", // JS-rendering path with render:html + wait_for_element
] as const;

type SourceType = (typeof SOURCE_TYPE_SEQUENCE)[number];

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

// ── Oxylabs client ────────────────────────────────────────────────────────────

async function decompressBuffer(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (err, result) => err ? reject(err) : resolve(result));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (err, result) => {
        if (err) {
          zlib.inflateRaw(buf, (err2, result2) => err2 ? reject(err2) : resolve(result2));
        } else {
          resolve(result);
        }
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (err, result) => err ? reject(err) : resolve(result));
    } else {
      resolve(buf);
    }
  });
}

function rawHttpPost(bodyStr: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

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
          const rawBuf  = Buffer.concat(chunks);
          const encoding = (res.headers["content-encoding"] ?? "").trim();

          let decompressed: Buffer;
          try {
            decompressed = encoding
              ? await decompressBuffer(rawBuf, encoding)
              : rawBuf;
          } catch (e) {
            logger.warn(`[realtor] Decompression failed (${encoding}): ${e} — using raw bytes`);
            decompressed = rawBuf;
          }

          resolve({
            statusCode: res.statusCode ?? 0,
            headers:    res.headers,
            body:       decompressed.toString("utf-8"),
          });
        });

        res.on("error", reject);
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("Request timed out"));
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── buildPayload ──────────────────────────────────────────────────────────────
//
// FIX: The Oxylabs browser_instructions selector schema requires:
//   { type: "css"|"xpath"|"text", value: "..." }
//
// The `timeout_s` and `wait_time_s` fields belong at the TOP LEVEL of the
// instruction object, NOT inside the selector object.
//
// INCORRECT (caused HTTP 400 "Field required: selector.type / selector.value"):
//   {
//     type: "wait_for_element",
//     selector: { selector: "#__NEXT_DATA__", timeout_s: 15 }
//   }
//
// CORRECT:
//   {
//     type: "wait_for_element",
//     selector: { type: "css", value: "#__NEXT_DATA__" },
//     timeout_s: 15
//   }

function buildPayload(
  targetUrl:  string,
  sourceType: SourceType,
  sessionId?: string,
  geoState?:  string
): Record<string, any> {
  const payload: Record<string, any> = {
    source:          sourceType,
    url:             targetUrl,
    render:          "html",
    geo_location:    geoState ? `${geoState}, United States` : "United States",
    user_agent_type: "desktop_chrome",
    locale:          "en-US",
    context: [
      { key: "follow_redirects", value: true },
    ],
    // FIX: correct selector schema — type + value at selector level,
    // timeout_s at instruction level (not nested inside selector).
    browser_instructions: [
      {
        type:      "wait_for_element",
        selector:  { type: "css", value: "#__NEXT_DATA__" },
        timeout_s: 15,
      },
    ],
  };

  if (sessionId) payload.session_id = sessionId;

  return payload;
}

// ── geoStateFromUrl ───────────────────────────────────────────────────────────

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

function geoStateFromUrl(url: string): string | undefined {
  const match = url.match(/\/[A-Za-z_]+-?_([A-Z]{2})\//);
  if (!match) return undefined;
  return STATE_MAP[match[1]];
}

// ── oxylabsFetch ──────────────────────────────────────────────────────────────

async function oxylabsFetch(
  targetUrl:  string,
  sessionId?: string,
  _startIdx = 0
): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[realtor] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  const geoState = geoStateFromUrl(targetUrl);

  for (let i = _startIdx; i < SOURCE_TYPE_SEQUENCE.length; i++) {
    const sourceType = SOURCE_TYPE_SEQUENCE[i];
    let retryCount = 0;

    while (retryCount <= 1) {
      const payload    = buildPayload(targetUrl, sourceType, sessionId, geoState);
      const bodyStr    = JSON.stringify(payload);

      logger.debug(
        `[realtor] Oxylabs request → source=${sourceType} ` +
        `geo="${payload.geo_location}" url=${targetUrl} retry=${retryCount}`
      );

      let resp: { statusCode: number; headers: http.IncomingHttpHeaders; body: string };
      try {
        resp = await rawHttpPost(bodyStr);
      } catch (err: any) {
        logger.error(`[realtor] HTTP transport error [${err.code ?? "?"}]: ${err.message}`);
        break;
      }

      const { statusCode, body } = resp;

      if (statusCode !== 200) {
        const preview = body.slice(0, 500).replace(/\s+/g, " ");
        logger.warn(
          `[realtor] Oxylabs HTTP ${statusCode} for ${targetUrl} | body: ${preview}`
        );
        if (statusCode === 401) {
          logger.error("[realtor] Oxylabs credentials rejected (401) — aborting all retries");
          return null;
        }
        if (statusCode === 429) {
          logger.warn("[realtor] Oxylabs rate-limited (429) — waiting 10s before retry");
          await sleep(10_000);
        }
        break;
      }

      let envelope: any;
      try {
        envelope = JSON.parse(body);
      } catch {
        const preview = body.slice(0, 300).replace(/\s+/g, " ");
        logger.warn(`[realtor] Could not parse Oxylabs envelope — raw: ${preview}`);
        break;
      }

      logger.debug(
        `[realtor] Envelope keys: ${Object.keys(envelope ?? {}).join(", ")} | ` +
        `results count: ${Array.isArray(envelope?.results) ? envelope.results.length : "n/a"}`
      );

      const result0 = envelope?.results?.[0];
      if (!result0) {
        const preview = body.slice(0, 300).replace(/\s+/g, " ");
        logger.warn(
          `[realtor] No results[0] in envelope for ${targetUrl} | body: ${preview}`
        );
        break;
      }

      logger.debug(
        `[realtor] results[0] keys: ${Object.keys(result0).join(", ")} | ` +
        `status_code: ${result0.status_code ?? "n/a"} | ` +
        `is_render_forced: ${result0.is_render_forced ?? "n/a"}`
      );

      const innerStatus: number = result0.status_code ?? result0.statusCode ?? 200;

      if (innerStatus === 401) {
        logger.error("[realtor] Inner 401 — credential issue, aborting");
        return null;
      }
      if (innerStatus === 403) {
        logger.warn(`[realtor] Inner 403 (blocked) for ${targetUrl} via ${sourceType}`);
        break;
      }
      if (innerStatus === 429) {
        logger.warn(
          `[realtor] Inner 429 (rate-limited) for ${targetUrl} via ${sourceType} — ` +
          "waiting 10s"
        );
        await sleep(10_000);
        break;
      }
      if (innerStatus === 613) {
        if (retryCount < 1) {
          logger.warn(`[realtor] 613 (faulted) for ${targetUrl} — retrying same source`);
          retryCount++;
          await sleep(2_000);
          continue;
        } else {
          logger.warn(`[realtor] 613 again for ${targetUrl} — giving up`);
          break;
        }
      }
      if (innerStatus !== 200 && innerStatus !== 0) {
        logger.warn(
          `[realtor] Inner HTTP ${innerStatus} for ${targetUrl} via ${sourceType}`
        );
      }

      const content: string =
        result0.content           ??
        result0.html              ??
        result0.results?.[0]?.content ??
        result0.results?.[0]?.html    ??
        "";

      const contentLen = content.length;
      logger.debug(
        `[realtor] Content length: ${contentLen} chars for ${targetUrl} ` +
        `(source=${sourceType})`
      );

      if (contentLen === 0) {
        const dump = JSON.stringify(result0).slice(0, 600).replace(/\s+/g, " ");
        logger.warn(
          `[realtor] Empty content from Oxylabs for ${targetUrl} via ${sourceType}\n` +
          `  result0 dump: ${dump}`
        );
        break;
      }

      if (contentLen < 5_000) {
        logger.warn(
          `[realtor] Suspiciously short content (${contentLen} chars) for ${targetUrl} ` +
          `via ${sourceType}`
        );
      }

      logger.debug(
        `[realtor] ✓ Content received (${contentLen} chars) via ${sourceType}`
      );
      return content;
    }
  }

  logger.warn(
    `[realtor] All source types exhausted for ${targetUrl} — giving up`
  );
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
  if (sig)
    return { blocked: true, reason: `signal: ${sig}` };

  if (
    html.length < 5_000 &&
    !html.includes("__NEXT_DATA__") &&
    !html.includes("realtor.com")
  )
    return { blocked: true, reason: `too short (${html.length} chars)` };

  return { blocked: false, reason: "" };
}

// ── Concurrent detail-page estimate fetcher ───────────────────────────────────

async function attachEstimates(
  listings:  RawListing[],
  sessionId: string
): Promise<void> {
  if (!FETCH_ESTIMATES || listings.length === 0) return;

  logger.info(
    `[realtor] Fetching estimates for ${listings.length} listings ` +
    `(concurrency=${DETAIL_CONCURRENCY})…`
  );

  let hit  = 0;
  let miss = 0;

  for (let i = 0; i < listings.length; i += DETAIL_CONCURRENCY) {
    const batch = listings.slice(i, i + DETAIL_CONCURRENCY);

    await Promise.all(
      batch.map(async (listing) => {
        const html = await oxylabsFetch(listing.url, sessionId);

        if (!html) {
          miss++;
          logger.debug(`[realtor] No HTML for detail: ${listing.url}`);
          return;
        }

        const { blocked, reason } = detectBlock(html);
        if (blocked) {
          miss++;
          logger.warn(`[realtor] Detail page blocked (${reason}): ${listing.url}`);
          return;
        }

        const nextData = extractNextData(html);
        if (!nextData) {
          miss++;
          logger.debug(`[realtor] No __NEXT_DATA__ on detail page: ${listing.url}`);
          return;
        }

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
            `[realtor] ✓ Estimate for ${listing.address ?? listing.url}: ` +
            `$${est.estimate.toLocaleString()}` +
            (est.estimateLow  ? ` ($${est.estimateLow.toLocaleString()}`   : "") +
            (est.estimateHigh ? ` – $${est.estimateHigh.toLocaleString()})` : "")
          );
        } else {
          miss++;
          logger.debug(`[realtor] No estimate on detail page: ${listing.url}`);
        }
      })
    );

    if (i + DETAIL_CONCURRENCY < listings.length) {
      await sleep(800 + Math.random() * 400);
    }
  }

  logger.info(
    `[realtor] Estimates: ${hit} found, ${miss} missing ` +
    `out of ${listings.length} listings`
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

  private stopPaging = false;
  private knownPages = 0;

  private readonly sessionId =
    `realtor_${Date.now()}_${Math.floor(Math.random() * 9_999)}`;
  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const urls = getSearchUrls();
    logger.info(
      `[realtor] ${urls.length} search URL(s), up to ${this.options.maxPages} page(s) each\n` +
      urls.map((u) => `  • ${u}`).join("\n")
    );
    logger.info(
      `[realtor] Fetch mode: Oxylabs Realtime API | ` +
      `Estimates: ${FETCH_ESTIMATES ? `enabled (concurrency=${DETAIL_CONCURRENCY})` : "disabled"}`
    );
    logger.info(
      `[realtor] Source-type sequence: ${SOURCE_TYPE_SEQUENCE.join(" → ")}`
    );

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error(
        "[realtor] OXYLABS_USERNAME / OXYLABS_PASSWORD not set — " +
        "add to .env and restart"
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

        logger.info(`[realtor] Page ${page}: ${pageListings.length} raw listings`);
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

          const est = (listing as any).zestimate;
          logger.info(
            `[realtor] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address ?? listing.title} @ ` +
            `$${listing.price?.toLocaleString() ?? "?"} ` +
            (est ? `| Estimate $${est.toLocaleString()}` : "| no estimate")
          );
        }

        if (!this.shouldContinuePaging(page, pageListings)) {
          logger.info(`[realtor] No more pages`);
          break;
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }

      if (urlIdx < searchUrls.length - 1) {
        const pause = 5_000 + Math.random() * 3_000;
        logger.debug(
          `[realtor] Pausing ${Math.round(pause / 1_000)}s before next URL…`
        );
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
    logger.info(`[realtor] Oxylabs → ${pageUrl}`);

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

    if (
      !html.includes("__NEXT_DATA__") &&
      !html.includes("realtor.com")
    ) {
      logger.error(`[realtor] Page ${pageNumber} doesn't look like Realtor.com`);
      saveFile(`realtor_unexpected_p${pageNumber}.html`, html);
      this.stopPaging = true;
      return [];
    }

    const nextData = extractNextData(html);
    if (!nextData) {
      logger.warn(`[realtor] No __NEXT_DATA__ on page ${pageNumber}`);
      saveFile(`realtor_no_nextdata_p${pageNumber}.html`, html);
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
        `[realtor] ${totalPages} total pages (capped at ${this.knownPages})`
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

  private shouldContinuePaging(
    page: number,
    last: RawListing[]
  ): boolean {
    if (this.stopPaging)                                 return false;
    if (last.length === 0)                               return false;
    if (page >= this.options.maxPages)                               return false;
    if (this.knownPages > 0 && page >= this.knownPages) return false;
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