// src/scrapers/loopnet/loopnet.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet scraper — ScraperAPI edition
//
// WHY THE PLAYWRIGHT APPROACH FAILS:
//   LoopNet uses Akamai Bot Manager Premier. Akamai's primary gate is IP
//   reputation — it blocklists datacenter CIDR ranges (AWS, DO, GCP, most
//   Webshare pools) before the browser ever gets to run JS. The warm-up
//   landing on "Access Denied" in the logs confirms this: Akamai rejected
//   the IP at the TCP handshake level, so no amount of stealth JS patching
//   or human-like behaviour can help.
//
// THE FIX — two options (ordered by reliability):
//
//   OPTION A (recommended): ScraperAPI with `render=true`
//     ScraperAPI maintains a pool of residential IPs and handles Akamai
//     challenge solving automatically. We send them the LoopNet URL and
//     they return the fully-rendered HTML. No proxy credential management
//     on our end.
//     Set env var: SCRAPER_API_KEY=<your key>
//     https://www.scraperapi.com/ — free tier: 5,000 requests/month
//
//   OPTION B: Dedicated residential proxy (manual)
//     If you have a Brightdata / Oxylabs / Smartproxy residential proxy,
//     set LOOPNET_PROXY_URL=http://user:pass@gate.host:port and the
//     Playwright path will be used instead of ScraperAPI.
//     Note: "residential" means ISP-assigned IPs, NOT Webshare datacenter.
//
// Both options are handled by this file — it picks whichever is configured.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium }   from "playwright-extra";
import StealthPlugin  from "puppeteer-extra-plugin-stealth";
import { Browser }    from "playwright";
import * as https     from "https";
import * as http      from "http";
import * as zlib      from "zlib";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep }        from "../../utils/browser";
import { RawListing }                  from "../../types/listing";
import { logger }                      from "../../utils/logger";
import { parseLoopNetListings }        from "./loopnet.parser";
import { config }                      from "../../config";
import * as fs   from "fs";
import * as path from "path";

chromium.use(StealthPlugin());

// ── Configuration ─────────────────────────────────────────────────────────────

const SCRAPER_API_KEY: string =
  process.env.SCRAPER_API_KEY ?? (config as any).scraperApiKey ?? "";

// Only used if SCRAPER_API_KEY is absent — requires a true residential proxy
const LOOPNET_PROXY_URL: string =
  process.env.LOOPNET_PROXY_URL ??
  (config as any).loopnetProxyUrl ??
  config.proxyUrl ??
  "";

const SEARCH_URLS: string[]     = config.sources.loopnet.searchUrls;
const MAX_PAGES_PER_URL: number = config.sources.loopnet.maxPagesPerUrl;
const REQUEST_TIMEOUT_MS        = 60_000;
const AKAMAI_WAIT_MS            = 20_000;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
];

// ── ScraperAPI HTTP fetch ──────────────────────────────────────────────────────
//
// ScraperAPI proxies requests through their residential pool and handles
// Akamai/Cloudflare challenges automatically. `render=true` means they spin
// up a headless browser on their end and return the fully-rendered HTML.

interface FetchResult {
  status: number;
  body:   string;
}

function scraperApiFetch(targetUrl: string, render = true): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      api_key:        SCRAPER_API_KEY,
      url:            targetUrl,
      render:         render ? "true" : "false",
      country_code:   "us",
      // Tell ScraperAPI to handle Akamai specifically
      premium:        "true",
      session_number: String(Math.floor(Math.random() * 9_999)),
    });

    const apiUrl = `https://api.scraperapi.com/?${params.toString()}`;
    const parsed = new URL(apiUrl);

    const req = https.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   "GET",
        headers:  {
          "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
          Accept:       "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      },
      (res: http.IncomingMessage) => {
        const enc    = (res.headers["content-encoding"] ?? "").toLowerCase();
        const chunks: Buffer[] = [];
        const stream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip()) :
          enc === "deflate" ? res.pipe(zlib.createInflate()) :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        (stream as NodeJS.ReadableStream).on("data",  (c: Buffer) => chunks.push(c));
        (stream as NodeJS.ReadableStream).on("end",   () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") })
        );
        (stream as NodeJS.ReadableStream).on("error", reject);
      }
    );

    req.on("error", reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`ScraperAPI timeout: ${targetUrl}`)));
    req.end();
  });
}

// ── Akamai block detection ────────────────────────────────────────────────────

function isAkamaiBlocked(html: string, url: string, title: string): boolean {
  const lower = html.toLowerCase();
  const conditions = [
    { label: '"access denied" in html',          hit: lower.includes("access denied") },
    { label: '"edgesuite.net" in html',           hit: lower.includes("edgesuite.net") },
    { label: '"akamai" in html',                  hit: lower.includes("akamai") },
    { label: '"cloudflare" in html',              hit: lower.includes("cloudflare") },
    { label: '"please enable cookies" in html',   hit: lower.includes("please enable cookies") },
    { label: '"checking your browser" in html',   hit: lower.includes("checking your browser") },
    { label: '"just a moment" in html',           hit: lower.includes("just a moment") },
    { label: '"__cf_chl" in url',                 hit: url.includes("__cf_chl") },
    {
      label: "challenge page title",
      hit: ["just a moment", "attention required", "please wait", "security check", "access denied"]
        .some((s) => title.toLowerCase().includes(s)),
    },
  ];
  const triggered = conditions.filter((c) => c.hit);
  if (triggered.length > 0) {
    logger.warn(
      `[loopnet] Block conditions triggered (${triggered.length}):\n` +
        triggered.map((c) => `  ✗ ${c.label}`).join("\n")
    );
    return true;
  }
  return false;
}

// ── ScraperAPI path ───────────────────────────────────────────────────────────

async function fetchViaScraperApi(url: string): Promise<string | null> {
  logger.debug(`[loopnet] ScraperAPI fetch: ${url}`);

  try {
    const { status, body } = await scraperApiFetch(url, true);

    if (status === 200 && body.length > 5_000) {
      const titleMatch = body.match(/<title[^>]*>([^<]+)/i);
      const title = titleMatch?.[1]?.trim() ?? "";

      if (isAkamaiBlocked(body, url, title)) {
        logger.warn(`[loopnet] ScraperAPI returned blocked page for: ${url}`);
        logger.warn(`[loopnet] → Check your ScraperAPI plan includes 'premium' residential IPs`);
        return null;
      }

      logger.debug(`[loopnet] ScraperAPI OK — ${body.length} chars, title: "${title}"`);
      return body;
    }

    logger.warn(`[loopnet] ScraperAPI HTTP ${status} for: ${url}`);
    if (status === 401) logger.error(`[loopnet] Invalid SCRAPER_API_KEY — check your .env`);
    if (status === 403) logger.error(`[loopnet] ScraperAPI quota exceeded or plan limitation`);
    if (status === 500) logger.warn(`[loopnet] ScraperAPI failed to render — retrying without render…`);

    // Retry without JS render (faster + cheaper) if render=true failed
    if (status === 500) {
      const { status: s2, body: b2 } = await scraperApiFetch(url, false);
      if (s2 === 200 && b2.length > 5_000) return b2;
    }

    return null;
  } catch (err: any) {
    logger.error(`[loopnet] ScraperAPI request failed: ${err.message}`);
    return null;
  }
}

// ── Playwright + residential proxy path ───────────────────────────────────────
//
// Only used when LOOPNET_PROXY_URL is set to a genuine residential proxy.
// This is OPTION B from the strategy comment at the top.

async function fetchViaPlaywright(
  url: string,
  proxyUrl: string
): Promise<string | null> {
  logger.debug(`[loopnet] Playwright fetch via residential proxy: ${url}`);

  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      headless: true,
      proxy: { server: proxyUrl },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--window-size=1440,900",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    }) as unknown as Browser;

    const ua      = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const width   = 1280 + Math.floor(Math.random() * 200);
    const height  = 800  + Math.floor(Math.random() * 100);

    const context = await browser.newContext({
      viewport:   { width, height },
      locale:     "en-US",
      timezoneId: "America/New_York",
      userAgent:  ua,
    });

    const page = await context.newPage();

    // Anti-detection init
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
      Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages",  { get: () => ["en-US", "en"] });
      (window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} };
      Object.defineProperty(navigator, "connection", {
        get: () => ({ effectiveType: "4g", rtt: 50, downlink: 10, saveData: false }),
      });
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language":           "en-US,en;q=0.9",
      "Accept":                    "text/html,application/xhtml+xml,*/*;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
    });

    // Warm up on homepage first
    try {
      logger.debug("[loopnet] Warming up on homepage…");
      await page.goto("https://www.loopnet.com/", {
        waitUntil: "domcontentloaded",
        timeout:   30_000,
      });
      await sleep(3_000 + Math.random() * 2_000);
      await page.evaluate("window.scrollBy(0, 300)");
      await sleep(800);
      const warmTitle = await page.title();
      logger.debug(`[loopnet] Warm-up title: "${warmTitle}"`);
    } catch {
      logger.warn("[loopnet] Warm-up navigation failed — continuing to target URL");
    }

    // Navigate to target
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(2_500 + Math.random() * 1_500);

    const title = await page.title();
    let   html  = await page.content();

    // Wait for Akamai challenge to self-resolve
    if (isAkamaiBlocked(html, page.url(), title)) {
      logger.info("[loopnet] Waiting for Akamai challenge to clear…");
      const deadline = Date.now() + AKAMAI_WAIT_MS;

      while (Date.now() < deadline) {
        await sleep(2_000);
        html = await page.content();
        const t = await page.title();
        if (!isAkamaiBlocked(html, page.url(), t)) {
          logger.info("[loopnet] Akamai challenge cleared");
          break;
        }
        logger.info(`[loopnet] Still blocked (${Math.round((Date.now() - (deadline - AKAMAI_WAIT_MS)) / 1000)}s)…`);
      }

      html = await page.content();
      if (isAkamaiBlocked(html, page.url(), await page.title())) {
        logger.warn("[loopnet] Residential proxy also blocked by Akamai — try a different proxy provider");
        return null;
      }
    }

    // Scroll to trigger lazy-loaded cards
    for (let i = 0; i < 4; i++) {
      await page.evaluate(`window.scrollBy(0, ${500 + Math.random() * 300})`);
      await sleep(600);
    }
    await page.evaluate("window.scrollTo(0, 0)");
    await sleep(500);

    return await page.content();

  } catch (err: any) {
    logger.error(`[loopnet] Playwright fetch error: ${err.message}`);
    return null;
  } finally {
    await browser?.close();
  }
}

// ── Page URL builder ──────────────────────────────────────────────────────────

function buildPageUrl(baseUrl: string, pageNum: number): string {
  if (pageNum <= 1) return baseUrl;
  // LoopNet pagination: append ?page=N
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}page=${pageNum}`;
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function saveDebugHtml(html: string, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `loopnet_${label}.html`);
    fs.writeFileSync(file, html, "utf-8");
    logger.debug(`[loopnet] Debug HTML saved → ${file}`);
  } catch {}
}

// ── Scraper class ─────────────────────────────────────────────────────────────

export class LoopNetScraper extends BaseScraper {
  readonly sourceName = "loopnet";

  constructor(options: ScraperOptions = {}) {
    super(options);

    const mode = SCRAPER_API_KEY
      ? `ScraperAPI (key: ${SCRAPER_API_KEY.slice(0, 6)}…)`
      : LOOPNET_PROXY_URL
      ? `Playwright + residential proxy`
      : "⚠️  NO PROXY / API KEY — will be blocked by Akamai";

    logger.info(
      `[loopnet] ${SEARCH_URLS.length} target URL(s), up to ${MAX_PAGES_PER_URL} page(s) each:\n` +
        SEARCH_URLS.map((u) => `  • ${u}`).join("\n")
    );
    logger.info(`[loopnet] Fetch mode: ${mode}`);

    if (!SCRAPER_API_KEY && !LOOPNET_PROXY_URL) {
      logger.warn(
        "[loopnet] ──────────────────────────────────────────────────────────\n" +
        "[loopnet] ACTION REQUIRED: LoopNet requires bypassing Akamai Bot Manager.\n" +
        "[loopnet] Option A (easiest): Add SCRAPER_API_KEY=<key> to your .env\n" +
        "[loopnet]   Get a free key at https://www.scraperapi.com/\n" +
        "[loopnet] Option B: Add LOOPNET_PROXY_URL=http://user:pass@host:port\n" +
        "[loopnet]   Must be a RESIDENTIAL proxy (Brightdata, Oxylabs, Smartproxy)\n" +
        "[loopnet]   Datacenter proxies (most Webshare plans) will not work.\n" +
        "[loopnet] ──────────────────────────────────────────────────────────"
      );
    }
  }

  // ── Fetch a single page's HTML via whichever method is configured ─────────

  private async fetchPageHtml(url: string): Promise<string | null> {
    if (SCRAPER_API_KEY) {
      return fetchViaScraperApi(url);
    }

    if (LOOPNET_PROXY_URL) {
      return fetchViaPlaywright(url, LOOPNET_PROXY_URL);
    }

    // No credentials configured — log clearly and bail
    logger.error(
      "[loopnet] Cannot fetch — set SCRAPER_API_KEY or LOOPNET_PROXY_URL in .env"
    );
    return null;
  }

  // ── Scrape a single search URL across all its pages ───────────────────────

  private async scrapeSearchUrl(searchUrl: string): Promise<RawListing[]> {
    const allListings: RawListing[] = [];

    for (let pageNum = 1; pageNum <= MAX_PAGES_PER_URL; pageNum++) {
      const pageUrl = buildPageUrl(searchUrl, pageNum);
      logger.info(`[loopnet] ── Fetching page ${pageNum}: ${pageUrl}`);

      const html = await this.fetchPageHtml(pageUrl);

      if (!html) {
        logger.warn(`[loopnet] No HTML returned for page ${pageNum} — stopping pagination`);
        break;
      }

      const slug = searchUrl.replace(/https?:\/\/[^/]+\/search\//, "").replace(/\//g, "_").slice(0, 40);
      saveDebugHtml(html, `raw_p${pageNum}_${slug}`);

      const listings = parseLoopNetListings(html, searchUrl, "loopnet");
      logger.info(`[loopnet] Page ${pageNum}: ${listings.length} listings parsed`);

      allListings.push(...listings);

      // Stop if no results or no "next page" signal
      const hasMore =
        listings.length > 0 &&
        pageNum < MAX_PAGES_PER_URL &&
        (html.includes(`page=${pageNum + 1}`) ||
          html.includes('aria-label="Next"') ||
          html.includes('rel="next"'));

      if (!hasMore) {
        logger.debug(`[loopnet] No more pages after page ${pageNum}`);
        break;
      }

      const pause = 3_000 + Math.random() * 2_000;
      logger.debug(`[loopnet] Pausing ${Math.round(pause / 1_000)}s before page ${pageNum + 1}…`);
      await sleep(pause);
    }

    return allListings;
  }

  // ── BaseScraper entry point ───────────────────────────────────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    // All pagination is handled internally — BaseScraper only calls once
    if (pageNumber !== 1) return [];

    const allListings: RawListing[] = [];

    for (let i = 0; i < SEARCH_URLS.length; i++) {
      const url = SEARCH_URLS[i];
      logger.info(`[loopnet] ── URL ${i + 1}/${SEARCH_URLS.length}: ${url}`);

      const listings = await this.scrapeSearchUrl(url);
      allListings.push(...listings);
      logger.info(`[loopnet] ${url} → ${listings.length} listings`);

      if (i < SEARCH_URLS.length - 1) {
        const pause = 5_000 + Math.random() * 3_000;
        logger.info(`[loopnet] Pausing ${Math.round(pause / 1_000)}s before next URL…`);
        await sleep(pause);
      }
    }

    // Deduplicate by URL
    const seen    = new Set<string>();
    const deduped = allListings.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    logger.info(`[loopnet] Total: ${deduped.length} unique listings across all URLs`);
    return deduped;
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }
}