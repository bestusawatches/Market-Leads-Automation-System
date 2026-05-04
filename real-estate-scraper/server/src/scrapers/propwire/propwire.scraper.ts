// src/scrapers/propwire/propwire.scraper.ts
//
// ── Root cause of 403 ─────────────────────────────────────────────────────────
//
// DataDome bot-protection blocks requests from server/datacenter IPs.
// The fix is to route api.propwire.com calls through a residential proxy
// AND send the datadome cookie + matching browser headers with every request.
//
// ── Token strategy ────────────────────────────────────────────────────────────
//
//   Tier 1 (RECOMMENDED) — PROPWIRE_BEARER_TOKEN env var
//     DevTools → Network → POST api.propwire.com/api/property_search
//     → Headers → Authorization: Bearer eyJ...
//     Copy everything AFTER "Bearer " into .env.
//     Expires in ~2h on basic plan. When expired: API 401 → grab a fresh one.
//
//   Tier 2 — Inertia XHR token (page JWT, ~407 chars)
//     Works for the Propwire frontend but NOT the API subdomain.
//     Kept for future use; currently skipped.
//
//   Tier 3 — Oxylabs render:html
//     Renders the page and extracts data-page token.
//     Same limitation as Tier 2.
//
// ── FASTEST SETUP ─────────────────────────────────────────────────────────────
//
//   1. Log into propwire.com in Chrome
//   2. DevTools → Network → clear → perform any search
//   3. Find: POST api.propwire.com/api/property_search
//   4. Headers → Authorization: Bearer eyJ...  (copy value after "Bearer ")
//   5. Headers → cookie: ...datadome=<value>... (copy datadome= value)
//   6. Set in .env:
//      PROPWIRE_BEARER_TOKEN=eyJ...
//      PROPWIRE_DATADOME=<datadome value>
//   7. npm run scrape:propwire
//
// ── Required .env ─────────────────────────────────────────────────────────────
//   PROPWIRE_BEARER_TOKEN=eyJ...
//   PROPWIRE_DATADOME=<value>
//   PROXY_URL=http://user:pass@host:port   ← residential proxy, bypasses DataDome
//
// ── Optional .env ─────────────────────────────────────────────────────────────
//   PROPWIRE_SESSION_COOKIE=propwire_session=eyJ...
//   PROPWIRE_XSRF_TOKEN=<value>
//   OXYLABS_USERNAME / OXYLABS_PASSWORD
//   PROPWIRE_MAX_PAGES=10
//   PROPWIRE_PAGE_SIZE=50
//   PROPWIRE_LEAD_TYPES=for_sale,preforeclosure
//
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http  from "http";
import * as tls   from "tls";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions }  from "../base.scraper";
import { BrowserHandle, sleep, jitter } from "../../utils/browser";
import { RawListing }                   from "../../types/listing";
import { logger }                       from "../../utils/logger";
import {
  parsePropwireApiResponse,
  extractPropwireToken,
} from "./propwire.parser";
import { config } from "../../config";

// ── Config ────────────────────────────────────────────────────────────────────

const BEARER_TOKEN_ENV   = process.env.PROPWIRE_BEARER_TOKEN   ?? "";
const RAW_COOKIE         = process.env.PROPWIRE_SESSION_COOKIE ?? "";
const DATADOME_COOKIE    = process.env.PROPWIRE_DATADOME       ?? "";
const XSRF_TOKEN         = process.env.PROPWIRE_XSRF_TOKEN     ?? "";
const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME        ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD        ?? "";
const PROXY_URL          = process.env.PROXY_URL               ?? "";

const MAX_PAGES          = Number(process.env.PROPWIRE_MAX_PAGES  ?? 10);
const PAGE_SIZE          = Number(process.env.PROPWIRE_PAGE_SIZE  ?? 50);

// "for_sale" → "mls_active" (confirmed from DevTools request body)
const LEAD_TYPE_MAP: Record<string, string> = {
  for_sale:       "mls_active",
  preforeclosure: "preforeclosure",
  mls_active:     "mls_active",
  mls_pending:    "mls_pending",
  absentee_owner: "absentee_owner",
  vacant_home:    "vacant_home",
  high_equity:    "high_equity",
  free_and_clear: "free_and_clear",
};

const RAW_LEAD_TYPES: string[] = (process.env.PROPWIRE_LEAD_TYPES ?? "for_sale")
  .split(",").map((s) => s.trim()).filter(Boolean);

const API_LEAD_TYPE_FILTERS: string[] = RAW_LEAD_TYPES
  .map((t) => LEAD_TYPE_MAP[t] ?? t)
  .filter((v, i, a) => a.indexOf(v) === i);

const API_ENDPOINT       = "api.propwire.com";
const OXYLABS_HOST       = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";

const API_TIMEOUT_MS     = 30_000;
const OXYLABS_TIMEOUT_MS = 120_000;
const BETWEEN_PAGE_MS    = 2_000;
const DEBUG_PAGES        = 3;

// ── Market definitions ────────────────────────────────────────────────────────

interface PropwireMarket {
  name:      string;
  state:     string;
  stateName: string;
  city?:     string;
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

// ── Decompression ─────────────────────────────────────────────────────────────

async function decompress(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (e, r) => (e ? reject(e) : resolve(r)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (e, r) => {
        if (e) zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (e, r) => (e ? reject(e) : resolve(r)));
    } else {
      resolve(buf);
    }
  });
}

// ── Proxy CONNECT tunnel ──────────────────────────────────────────────────────
//
// Opens an HTTP CONNECT tunnel through the proxy, then performs a TLS handshake
// over the tunnel socket and sends the HTTPS request manually.
// This is required because DataDome blocks datacenter IPs — the residential
// proxy IP passes the bot check.

async function httpsPostViaProxy(
  hostname:  string,
  reqPath:   string,
  headers:   Record<string, string>,
  body:      string,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<{ status: number; body: string } | null> {
  let proxyHost: string;
  let proxyPort: number;
  let proxyAuth: string | null = null;

  try {
    const u   = new URL(PROXY_URL);
    proxyHost = u.hostname;
    proxyPort = parseInt(u.port || "8080", 10);
    if (u.username && u.password) {
      proxyAuth = Buffer.from(
        `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
      ).toString("base64");
    }
  } catch {
    logger.error(`[propwire] Invalid PROXY_URL: ${PROXY_URL}`);
    return null;
  }

  return new Promise((resolve) => {
    const connectHeaders: Record<string, string> = {
      "Host":       `${hostname}:443`,
      "User-Agent": "Mozilla/5.0",
    };
    if (proxyAuth) connectHeaders["Proxy-Authorization"] = `Basic ${proxyAuth}`;

    logger.debug(`[propwire] Proxy CONNECT ${proxyHost}:${proxyPort} → ${hostname}:443`);

    const connectReq = http.request({
      host:    proxyHost,
      port:    proxyPort,
      method:  "CONNECT",
      path:    `${hostname}:443`,
      headers: connectHeaders,
    });

    const timer = setTimeout(() => {
      connectReq.destroy();
      logger.warn("[propwire] Proxy CONNECT timeout");
      resolve(null);
    }, timeoutMs);

    connectReq.on("error", (err: any) => {
      clearTimeout(timer);
      logger.error(`[propwire] Proxy CONNECT error: ${err.message}`);
      resolve(null);
    });

    connectReq.on("connect", (res: any, socket: any) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        logger.error(`[propwire] Proxy CONNECT rejected: HTTP ${res.statusCode}`);
        socket.destroy();
        resolve(null);
        return;
      }

      // TLS handshake over the tunnel
      const tlsSocket = tls.connect({
        host:               hostname,
        socket,
        servername:         hostname,
        rejectUnauthorized: true,
      });

      tlsSocket.on("error", (err: any) => {
        clearTimeout(timer);
        logger.warn(`[propwire] TLS error: ${err.message}`);
        resolve(null);
      });

      tlsSocket.on("secureConnect", () => {
        // Build raw HTTP/1.1 request
        const bodyBuf  = Buffer.from(body, "utf-8");
        const allHdrs  = { ...headers, "Content-Length": bodyBuf.length.toString() };
        const reqLines =
          `POST ${reqPath} HTTP/1.1\r\n` +
          `Host: ${hostname}\r\n` +
          Object.entries(allHdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
          "\r\n\r\n";

        tlsSocket.write(reqLines);
        tlsSocket.write(bodyBuf);

        const chunks: Buffer[] = [];
        tlsSocket.on("data",  (c: Buffer) => chunks.push(c));
        tlsSocket.on("end",   () => {
          clearTimeout(timer);
          try {
            const raw        = Buffer.concat(chunks).toString("binary");
            const headerEnd  = raw.indexOf("\r\n\r\n");
            if (headerEnd === -1) { resolve(null); return; }

            const headerSection = raw.slice(0, headerEnd);
            const statusMatch   = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
            const status        = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            const rawBodyStr    = raw.slice(headerEnd + 4);

            // Decode chunked transfer encoding if present
            const isChunked = /transfer-encoding:\s*chunked/i.test(headerSection);
            let decoded = rawBodyStr;
            if (isChunked) {
              try {
                let result = "";
                let rem    = rawBodyStr;
                while (rem.length > 0) {
                  const crlf = rem.indexOf("\r\n");
                  if (crlf === -1) break;
                  const sz = parseInt(rem.slice(0, crlf), 16);
                  if (isNaN(sz) || sz === 0) break;
                  result += rem.slice(crlf + 2, crlf + 2 + sz);
                  rem     = rem.slice(crlf + 2 + sz + 2);
                }
                decoded = result;
              } catch { /* fall through to raw */ }
            }

            // Handle content-encoding (gzip / br / deflate)
            const encMatch = headerSection.match(/content-encoding:\s*(\S+)/i);
            const enc      = encMatch?.[1]?.trim() ?? "";
            if (enc === "gzip" || enc === "br" || enc === "deflate") {
              decompress(Buffer.from(decoded, "binary"), enc)
                .then((buf) => resolve({ status, body: buf.toString("utf-8") }))
                .catch(() => resolve({ status, body: decoded }));
            } else {
              resolve({ status, body: decoded });
            }
          } catch (err: any) {
            logger.warn(`[propwire] Response parse error: ${err.message}`);
            resolve(null);
          }
        });
        tlsSocket.on("error", (err: any) => {
          clearTimeout(timer);
          logger.warn(`[propwire] TLS socket error: ${err.message}`);
          resolve(null);
        });
      });
    });

    connectReq.end();
  });
}

// ── Generic HTTPS POST (direct, no proxy) ────────────────────────────────────

async function httpsPostDirect(
  hostname:  string,
  reqPath:   string,
  headers:   Record<string, string>,
  body:      string,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path: reqPath, method: "POST", family: 4, headers },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        const enc = (res.headers["content-encoding"] ?? "").trim();
        const stream: NodeJS.ReadableStream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip())           :
          enc === "deflate" ? res.pipe(zlib.createInflate())          :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") })
        );
        stream.on("error", (err: any) => {
          logger.warn(`[propwire] stream error: ${err.message}`);
          resolve(null);
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on("error", (err: any) => {
      logger.error(`[propwire] request error [${err.code ?? "?"}]: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ── Unified POST: proxy if available, else direct ────────────────────────────

async function httpsPost(
  hostname:  string,
  reqPath:   string,
  headers:   Record<string, string>,
  body:      string,
  timeoutMs: number = API_TIMEOUT_MS
): Promise<{ status: number; body: string } | null> {
  if (PROXY_URL) {
    return httpsPostViaProxy(hostname, reqPath, headers, body, timeoutMs);
  }
  return httpsPostDirect(hostname, reqPath, headers, body, timeoutMs);
}

// ── Tier 2: Inertia XHR ───────────────────────────────────────────────────────

async function fetchPageTokenViaInertiaXhr(market: PropwireMarket): Promise<string | null> {
  const cookieStr = [
    RAW_COOKIE,
    DATADOME_COOKIE ? `datadome=${DATADOME_COOKIE}` : "",
    XSRF_TOKEN      ? `XSRF-TOKEN=${encodeURIComponent(XSRF_TOKEN)}` : "",
  ].filter(Boolean).join("; ");

  if (!cookieStr) return null;

  const filters = encodeURIComponent(JSON.stringify({
    locations: [{
      searchType: market.city ? "C" : "T",
      state:      market.state,
      stateName:  market.stateName,
      title:      market.city ? `${market.city}, ${market.state}` : `${market.stateName}, USA`,
      ...(market.city ? { city: market.city } : {}),
    }],
  }));
  const getPath = `/search?filters=${filters}`;

  logger.debug(`[propwire] Inertia XHR GET ${getPath.slice(0, 80)}…`);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "propwire.com",
        path:     getPath,
        method:   "GET",
        family:   4,
        headers: {
          "accept":            "application/json, text/plain, */*",
          "accept-encoding":   "gzip, deflate, br",
          "accept-language":   "en-US,en;q=0.9",
          "cookie":            cookieStr,
          "referer":           "https://propwire.com/search",
          "user-agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
          "x-inertia":         "true",
          "x-requested-with":  "XMLHttpRequest",
          ...(XSRF_TOKEN ? { "x-xsrf-token": XSRF_TOKEN } : {}),
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        const enc = (res.headers["content-encoding"] ?? "").trim();
        const stream: NodeJS.ReadableStream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip())           :
          enc === "deflate" ? res.pipe(zlib.createInflate())          :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          const raw    = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          logger.debug(`[propwire] Inertia XHR HTTP ${status} body=${raw.length}ch`);

          if (status === 403) {
            logger.warn("[propwire] Inertia XHR 403 — DataDome blocking.");
            resolve(null); return;
          }
          if (status !== 200) { resolve(null); return; }

          saveFile("propwire_inertia.json", raw.slice(0, 100_000));

          let parsed: any;
          try { parsed = JSON.parse(raw); }
          catch { logger.warn("[propwire] Inertia XHR: not JSON"); resolve(null); return; }

          const token =
            parsed?.props?.token ??
            parsed?.props?.auth?.token ??
            parsed?.token ?? null;

          if (token && typeof token === "string" && token.length > 50) {
            logger.info(`[propwire] ✓ Token from Inertia XHR (${token.length} chars)`);
            resolve(token);
          } else {
            resolve(null);
          }
        });
        stream.on("error", (err: any) => {
          logger.warn(`[propwire] Inertia stream: ${err.message}`);
          resolve(null);
        });
      }
    );
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on("error", (err: any) => {
      logger.error(`[propwire] Inertia XHR: ${err.message}`);
      resolve(null);
    });
    req.end();
  });
}

// ── Tier 3: Oxylabs render:html ───────────────────────────────────────────────

async function oxylabsFetchHtml(targetUrl: string): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) return null;

  const sessionCookies: Array<{ key: string; value: string }> = [];
  if (RAW_COOKIE) {
    const eqIdx = RAW_COOKIE.indexOf("=");
    sessionCookies.push(eqIdx > 0 && eqIdx < 50
      ? { key: RAW_COOKIE.slice(0, eqIdx).trim(), value: RAW_COOKIE.slice(eqIdx + 1).trim() }
      : { key: "propwire_session", value: RAW_COOKIE.trim() }
    );
  }

  const payload = {
    source:            "universal",
    url:               targetUrl,
    render:            "html",
    geo_location:      "United States",
    user_agent_type:   "desktop_chrome",
    wait_for_selector: "#app",
    wait:              5000,
    context: [
      { key: "follow_redirects", value: true },
      ...(sessionCookies.length > 0 ? [{ key: "cookies", value: sessionCookies }] : []),
    ],
  };

  const bodyStr = JSON.stringify(payload);
  const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

  logger.debug(`[propwire] Oxylabs → ${targetUrl.slice(0, 80)}…`);

  const result = await httpsPostDirect(
    OXYLABS_HOST, OXYLABS_PATH,
    {
      "Content-Type":    "application/json",
      "Authorization":   `Basic ${authStr}`,
      "Content-Length":  Buffer.byteLength(bodyStr).toString(),
      "Accept-Encoding": "gzip, deflate, br",
    },
    bodyStr, OXYLABS_TIMEOUT_MS
  );

  if (!result) return null;
  if (result.status === 400) { logger.error(`[propwire] Oxylabs 400: ${result.body.slice(0, 300)}`); return null; }
  if (result.status === 401) { logger.error("[propwire] Oxylabs 401 — invalid credentials"); return null; }
  if (result.status !== 200) { logger.warn(`[propwire] Oxylabs HTTP ${result.status}`); return null; }

  let envelope: any;
  try { envelope = JSON.parse(result.body); }
  catch { logger.warn("[propwire] Could not parse Oxylabs envelope"); return null; }

  const r0      = envelope?.results?.[0];
  const iStatus = r0?.status_code ?? 200;
  const content = r0?.content ?? "";

  logger.debug(`[propwire] Oxylabs inner=${iStatus} content=${content.length}ch`);

  if (iStatus === 403 || iStatus === 401) {
    logger.warn(`[propwire] Oxylabs inner ${iStatus} — cookie expired`);
    return null;
  }
  if (!content || content.length < 500) {
    logger.warn(`[propwire] Oxylabs short content (${content.length}ch) — blocked`);
    return null;
  }

  return content;
}

// ── Direct API call to api.propwire.com ──────────────────────────────────────

async function callPropertySearchApi(
  token:       string,
  market:      PropwireMarket,
  resultIndex: number = 0
): Promise<any | null> {
  const locationEntry: Record<string, any> = {
    searchType: market.city ? "C" : "T",
    state:      market.state,
    stateName:  market.stateName,
    title:      market.city
      ? `${market.city}, ${market.state}`
      : `${market.stateName}, USA`,
  };
  if (market.city) locationEntry.city = market.city;

  const body: Record<string, any> = {
    size:              PAGE_SIZE,
    result_index:      resultIndex,
    house:             true,
    locations:         [locationEntry],
    lead_type_filters: API_LEAD_TYPE_FILTERS,
    estimated_value:   { max: config.filter.maxPrice },
  };

  const bodyStr = JSON.stringify(body);

  // Build cookie string — datadome is required to pass bot check
  const cookieParts: string[] = [];
  if (DATADOME_COOKIE) cookieParts.push(`datadome=${DATADOME_COOKIE}`);
  if (RAW_COOKIE)      cookieParts.push(RAW_COOKIE);
  const cookieStr = cookieParts.join("; ");

  logger.debug(
    `[propwire] API POST /api/property_search ` +
    `result_index=${resultIndex} market=${market.name} ` +
    `lead_types=[${API_LEAD_TYPE_FILTERS.join(",")}] ` +
    `proxy=${PROXY_URL ? "yes" : "no"} datadome=${DATADOME_COOKIE ? "yes" : "no"}`
  );

  const requestHeaders: Record<string, string> = {
    "Content-Type":    "application/json",
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Authorization":   `Bearer ${token}`,
    "Origin":          "https://propwire.com",
    "Referer":         "https://propwire.com/",
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "sec-ch-ua":       '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-mobile":   "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest":  "empty",
    "sec-fetch-mode":  "cors",
    "sec-fetch-site":  "same-site",
    "x-user-id":       "379361",
    "priority":        "u=1, i",
  };

  if (cookieStr) requestHeaders["cookie"] = cookieStr;

  const result = await httpsPost(
    API_ENDPOINT,
    "/api/property_search",
    requestHeaders,
    bodyStr,
    API_TIMEOUT_MS
  );

  if (!result) return null;

  const { status, body: rawBody } = result;
  logger.debug(`[propwire] API HTTP ${status} body=${rawBody.length}ch`);

  if (status === 401) {
    logger.warn(
      "[propwire] API 401 — Bearer token expired.\n" +
      "[propwire] HOW TO GET A FRESH TOKEN:\n" +
      "[propwire]   1. Log into propwire.com in Chrome\n" +
      "[propwire]   2. DevTools → Network → clear → perform any search\n" +
      "[propwire]   3. Find: POST api.propwire.com/api/property_search\n" +
      "[propwire]   4. Headers → Authorization: Bearer <value>\n" +
      "[propwire]   5. Copy value after 'Bearer ' → set PROPWIRE_BEARER_TOKEN in .env\n" +
      "[propwire]   6. Also copy datadome= from cookie header → PROPWIRE_DATADOME"
    );
    return null;
  }

  if (status === 403) {
    logger.warn(`[propwire] API 403 — response: ${rawBody.slice(0, 400)}`);
    logger.warn(
      "[propwire] 403 — DataDome bot check failed. Possible causes:\n" +
      "[propwire]   • PROPWIRE_DATADOME cookie is expired — refresh from DevTools\n" +
      "[propwire]   • PROXY_URL not set or proxy IP is blocked\n" +
      "[propwire]   • Bearer token is expired — grab a fresh one from DevTools"
    );
    return null;
  }

  if (status === 429) { logger.warn("[propwire] API 429 — rate limited"); return null; }

  if (status !== 200) {
    logger.warn(`[propwire] API HTTP ${status}: ${rawBody.slice(0, 300)}`);
    return null;
  }

  try   { return JSON.parse(rawBody); }
  catch {
    logger.warn("[propwire] Could not parse API JSON");
    logger.debug(`[propwire] Raw: ${rawBody.slice(0, 300)}`);
    return null;
  }
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

function marketSlug(m: PropwireMarket): string {
  return `${m.city ?? m.state}_${m.state}`.replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class PropwireScraper extends BaseScraper {
  readonly sourceName = "propwire";
  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const markets = getMarkets();
    logger.info(
      `[propwire] ${markets.length} market(s), up to ${MAX_PAGES} page(s) × ${PAGE_SIZE}/page\n` +
      markets.map((m) => `  • ${m.name}`).join("\n")
    );
    logger.info(
      `[propwire] Lead types: [${RAW_LEAD_TYPES.join(", ")}] → API filters: [${API_LEAD_TYPE_FILTERS.join(", ")}]\n` +
      `[propwire] Max price: $${config.filter.maxPrice.toLocaleString()}`
    );
    logger.info(`[propwire] API endpoint: https://${API_ENDPOINT}/api/property_search`);
    logger.info(`[propwire] Proxy: ${PROXY_URL ? PROXY_URL.replace(/:[^:@]+@/, ":***@") : "none (direct)"}`);
    logger.info(`[propwire] DataDome cookie: ${DATADOME_COOKIE ? "set ✓" : "NOT SET ✗"}`);

    if (BEARER_TOKEN_ENV) {
      logger.info(`[propwire] Token: PROPWIRE_BEARER_TOKEN ✓ (${BEARER_TOKEN_ENV.length} chars)`);
    } else {
      logger.warn(
        "[propwire] PROPWIRE_BEARER_TOKEN not set.\n" +
        "[propwire] HOW TO GET IT:\n" +
        "[propwire]   1. Log into propwire.com in Chrome\n" +
        "[propwire]   2. DevTools → Network → clear → perform any search\n" +
        "[propwire]   3. Find: POST api.propwire.com/api/property_search\n" +
        "[propwire]   4. Request Headers → Authorization: Bearer eyJ...\n" +
        "[propwire]   5. Copy value after 'Bearer ' → .env PROPWIRE_BEARER_TOKEN\n" +
        "[propwire]   6. Copy datadome= from cookie header → .env PROPWIRE_DATADOME"
      );
    }
  }

  override async run(): Promise<RawListing[]> {
    logger.info("[propwire] Starting");
    this.visited.clear();
    this.results     = [];
    this.allListings = [];

    const markets  = getMarkets();
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    // ── Phase 1: Acquire Bearer token ────────────────────────────────────

    let token: string | null = null;
    let tokenExpired = false;

    // Tier 1: env var
    if (BEARER_TOKEN_ENV) {
      token = BEARER_TOKEN_ENV;
      logger.info(`[propwire] ✓ Tier 1: PROPWIRE_BEARER_TOKEN (${token.length} chars)`);
    }

    // Tier 2: Inertia XHR
    if (!token && (RAW_COOKIE || DATADOME_COOKIE)) {
      logger.info("[propwire] Tier 2: attempting Inertia XHR…");
      const inertiaToken = await fetchPageTokenViaInertiaXhr(markets[0]);
      if (inertiaToken && inertiaToken.length > 50) {
        token = inertiaToken;
        logger.info(`[propwire] ✓ Tier 2: Inertia XHR token (${token.length} chars)`);
      }
    }

    // Tier 3: Oxylabs
    if (!token && OXYLABS_USERNAME && OXYLABS_PASSWORD) {
      logger.info("[propwire] Tier 3: attempting Oxylabs render:html…");
      const fm = markets[0];
      const shellFilters = encodeURIComponent(JSON.stringify({
        locations: [{
          searchType: "C", state: fm.state, stateName: fm.stateName,
          title: `${fm.city}, ${fm.state}`, city: fm.city,
        }],
        lead_type: RAW_LEAD_TYPES, property_type: ["sfr", "mfr"],
      }));
      const shellHtml = await oxylabsFetchHtml(`https://propwire.com/search?filters=${shellFilters}`);
      if (shellHtml) {
        saveFile("propwire_shell.html", shellHtml);
        const parsed = extractPropwireToken(shellHtml);
        if (parsed && parsed.length > 50) {
          token = parsed;
          logger.info(`[propwire] ✓ Tier 3: Oxylabs token (${token.length} chars)`);
        }
      }
    }

    if (!token) {
      logger.error(
        "[propwire] No usable API Bearer token found.\n" +
        "[propwire] Set PROPWIRE_BEARER_TOKEN in .env — see constructor warning above."
      );
      return [];
    }

    // ── Phase 2: Scrape via api.propwire.com ─────────────────────────────

    logger.info("[propwire] Phase 2: calling api.propwire.com/api/property_search…");

    for (const market of markets) {
      if (this.results.length >= this.options.maxListings) {
        logger.info("[propwire] maxListings reached — skipping remaining markets");
        break;
      }
      if (tokenExpired) break;

      logger.info(`[propwire] ── Market: ${market.name}`);

      for (let page = 1; page <= MAX_PAGES; page++) {
        if (this.results.length >= this.options.maxListings) break;

        const resultIndex = (page - 1) * PAGE_SIZE;
        logger.info(`[propwire] ${market.name} page ${page}/${MAX_PAGES} (offset ${resultIndex})`);

        const apiData = await callPropertySearchApi(token, market, resultIndex);

        if (!apiData) {
          logger.warn(`[propwire] No data for ${market.name} p${page} — stopping market`);
          if (page === 1 && this.allListings.length === 0) {
            logger.error("[propwire] No results on first page — token likely expired or DataDome block");
            tokenExpired = true;
          }
          break;
        }

        if (page <= DEBUG_PAGES) {
          saveFile(
            `propwire_api_${marketSlug(market)}_p${page}.json`,
            JSON.stringify(apiData, null, 2)
          );
        }

        const { listings, hasMore } = parsePropwireApiResponse(apiData, resultIndex);

        logger.info(
          `[propwire] ${market.name} p${page}: ${listings.length} listings | hasMore=${hasMore}`
        );

        this.allListings.push(...listings);

        for (const listing of listings) {
          if (this.results.length >= this.options.maxListings) break;
          if (!listing.url)                  { rejected.push({ listing, reason: "no_url" });    continue; }
          if (this.visited.has(listing.url)) { rejected.push({ listing, reason: "duplicate" }); continue; }
          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(`[propwire] ✗ filtered: ${listing.address} @ $${listing.price}`);
            continue;
          }
          this.visited.add(listing.url);
          this.results.push(listing);
          logger.info(
            `[propwire] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address} @ $${listing.price?.toLocaleString() ?? "?"} ` +
            (listing.propwireEstimate ? `| AVM $${listing.propwireEstimate.toLocaleString()}` : "| no AVM")
          );
        }

        if (!hasMore || listings.length === 0) {
          logger.info(`[propwire] ${market.name}: no more pages`);
          break;
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }
    }

    logger.info(`[propwire] Done — ${this.results.length} accepted, ${rejected.length} rejected`);

    saveFile(
      `${this.sourceName}.json`,
      JSON.stringify(
        {
          accepted:    this.results,
          rejected,
          allListings: this.allListings,
          generatedAt: new Date().toISOString(),
        },
        null, 2
      )
    );

    const withAvm = this.results.filter((l) => l.propwireEstimate != null).length;
    logger.info(
      `[propwire] Finished — ${this.results.length} listings | AVM coverage: ${withAvm}/${this.results.length}`
    );
    return this.results;
  }

  protected async scrapePage(_h: BrowserHandle, _p: number): Promise<RawListing[]> { return []; }
  protected shouldContinue(_p: number): boolean { return false; }
}