// src/scrapers/loopnet/test-scraperapi.ts
//
// Diagnoses why ScraperAPI requests are failing silently.
// Run with:
//   npm run test:scraperapi
//   — or —
//   node -r ./polyfill-file.js -r ts-node/register src/scrapers/loopnet/test-scraperapi.ts

// Load .env FIRST — before any other imports read process.env.
// This file is run directly (not via index.ts) so dotenv isn't loaded yet.
import * as dotenv from "dotenv";
import * as path   from "path";
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as dns   from "dns";
import * as net   from "net";

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY ?? "";
const TEST_URL        = "https://www.loopnet.com/search/multifamily-properties/oh/for-sale/";

// ── 1. Check env var ──────────────────────────────────────────────────────────
console.log("\n=== ScraperAPI Diagnostic ===\n");
console.log(`SCRAPER_API_KEY set: ${SCRAPER_API_KEY ? `YES (${SCRAPER_API_KEY.slice(0, 8)}…)` : "NO ← this is your problem"}`);
if (!SCRAPER_API_KEY) {
  console.log("\nFix: Add SCRAPER_API_KEY=your_key to your .env file and re-run.");
  process.exit(1);
}

// ── 2. DNS resolution ─────────────────────────────────────────────────────────
async function testDns(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n[1] DNS lookup for ${hostname}…`);
    dns.lookup(hostname, (err, address) => {
      if (err) {
        console.log(`    ✗ DNS FAILED: ${err.message}`);
        console.log("    → Your network may be blocking outbound DNS for this host");
        resolve(false);
      } else {
        console.log(`    ✓ Resolved to: ${address}`);
        resolve(true);
      }
    });
  });
}

// ── 3. TCP connectivity ───────────────────────────────────────────────────────
async function testTcp(hostname: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n[2] TCP connect to ${hostname}:${port}…`);
    const socket = new net.Socket();
    socket.setTimeout(8_000);

    socket.on("connect", () => {
      console.log("    ✓ TCP connection established");
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      console.log("    ✗ TCP TIMEOUT — port is filtered or host unreachable");
      socket.destroy();
      resolve(false);
    });

    socket.on("error", (err) => {
      console.log(`    ✗ TCP ERROR: ${err.message}`);
      resolve(false);
    });

    socket.connect(port, hostname);
  });
}

// ── 4. Simple HTTPS GET (no ScraperAPI) ──────────────────────────────────────
async function testDirectHttps(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n[3] Direct HTTPS GET to ${url}…`);
    const parsed = new URL(url);

    const req = https.request(
      { hostname: parsed.hostname, path: "/", method: "GET" },
      (res) => {
        console.log(`    ✓ HTTP status: ${res.statusCode}`);
        res.resume();
        resolve(true);
      }
    );

    req.setTimeout(10_000, () => {
      console.log("    ✗ HTTPS TIMEOUT");
      req.destroy();
      resolve(false);
    });

    req.on("error", (err: any) => {
      console.log(`    ✗ HTTPS ERROR: ${err.message}`);
      if (err.code === "ECONNREFUSED") console.log("    → Connection refused (firewall?)");
      if (err.code === "ENOTFOUND")    console.log("    → DNS resolution failed");
      if (err.code === "ETIMEDOUT")    console.log("    → Connection timed out (firewall/egress block)");
      if (err.code === "CERT_")        console.log("    → TLS/certificate error");
      resolve(false);
    });

    req.end();
  });
}

// ── 5. ScraperAPI — cheapest possible call (httpbin, no render) ───────────────
async function testScraperApiBasic(): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n[4] ScraperAPI test — fetching httpbin.org/ip (cheapest possible call)…`);

    const params = new URLSearchParams({
      api_key: SCRAPER_API_KEY,
      url:     "https://httpbin.org/ip",
      render:  "false",
    });

    const fullUrl = `https://api.scraperapi.com/?${params}`;
    const parsed  = new URL(fullUrl);

    const req = https.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   "GET",
        headers:  { "User-Agent": "Mozilla/5.0 diagnostic-test" },
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
        (stream as NodeJS.ReadableStream).on("end",   () => {
          const body   = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          console.log(`    HTTP status: ${status}`);
          console.log(`    Body: ${body.slice(0, 300)}`);

          if (status === 200) {
            console.log("    ✓ ScraperAPI is reachable and key is valid");
            resolve(true);
          } else if (status === 401) {
            console.log("    ✗ HTTP 401 — INVALID API KEY");
            console.log("    → Double-check SCRAPER_API_KEY in your .env");
            resolve(false);
          } else if (status === 403) {
            console.log("    ✗ HTTP 403 — quota exceeded or plan issue");
            resolve(false);
          } else {
            console.log(`    ✗ Unexpected status ${status}`);
            resolve(false);
          }
        });
        (stream as NodeJS.ReadableStream).on("error", (err: any) => {
          console.log(`    ✗ Stream error: ${err.message}`);
          resolve(false);
        });
      }
    );

    req.setTimeout(30_000, () => {
      console.log("    ✗ ScraperAPI TIMEOUT after 30s");
      console.log("    → api.scraperapi.com is unreachable from this machine");
      console.log("    → Check if your firewall/ISP blocks outbound HTTPS to this host");
      req.destroy();
      resolve(false);
    });

    req.on("error", (err: any) => {
      console.log(`    ✗ ScraperAPI request error: [${err.code}] ${err.message}`);
      if (err.code === "ENOTFOUND")  console.log("    → DNS can't resolve api.scraperapi.com");
      if (err.code === "ETIMEDOUT")  console.log("    → Outbound connection blocked by firewall/egress");
      if (err.code === "ECONNRESET") console.log("    → Connection reset — possible proxy/firewall interference");
      resolve(false);
    });

    req.end();
  });
}

// ── 6. ScraperAPI — actual LoopNet fetch ─────────────────────────────────────
async function testScraperApiLoopNet(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n[5] ScraperAPI test — fetching LoopNet URL with render=true…`);
    console.log(`    (This uses ~5-10 API credits and may take 30-60s)`);

    const params = new URLSearchParams({
      api_key:      SCRAPER_API_KEY,
      url:          TEST_URL,
      render:       "true",
      country_code: "us",
      premium:      "true",
    });

    const fullUrl = `https://api.scraperapi.com/?${params}`;
    const parsed  = new URL(fullUrl);

    const req = https.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   "GET",
        headers:  { "User-Agent": "Mozilla/5.0" },
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
        (stream as NodeJS.ReadableStream).on("end",   () => {
          const body   = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          console.log(`    HTTP status:  ${status}`);
          console.log(`    Body length:  ${body.length} chars`);

          const titleMatch = body.match(/<title[^>]*>([^<]+)/i);
          const title = titleMatch?.[1]?.trim() ?? "(no title)";
          console.log(`    Page title:   "${title}"`);

          const isBlocked =
            body.toLowerCase().includes("access denied") ||
            body.toLowerCase().includes("edgesuite.net") ||
            title.toLowerCase().includes("access denied");

          const hasListings =
            body.includes("listing-card") ||
            body.includes("listingCard") ||
            body.includes("application/ld+json");

          if (status === 200 && !isBlocked && hasListings) {
            console.log("    ✓ SUCCESS — LoopNet listings page returned with content");
          } else if (isBlocked) {
            console.log("    ✗ BLOCKED — Akamai still blocking even via ScraperAPI");
            console.log("    → Try upgrading to ScraperAPI 'Ultra Premium' plan");
            console.log("    → Or switch to Brightdata / Oxylabs residential proxy");
          } else if (status === 200 && body.length < 5_000) {
            console.log("    ✗ Body too short — ScraperAPI may have returned an error page");
            console.log(`    Body preview: ${body.slice(0, 500)}`);
          } else {
            console.log(`    ? Unexpected result — check body preview:`);
            console.log(`    ${body.slice(0, 500)}`);
          }

          resolve();
        });
        (stream as NodeJS.ReadableStream).on("error", (err: any) => {
          console.log(`    ✗ Stream error: ${err.message}`);
          resolve();
        });
      }
    );

    req.setTimeout(90_000, () => {
      console.log("    ✗ TIMEOUT after 90s waiting for ScraperAPI render");
      req.destroy();
      resolve();
    });

    req.on("error", (err: any) => {
      console.log(`    ✗ Request error: [${err.code ?? "?"}] ${err.message}`);
      resolve();
    });

    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const dnsOk = await testDns("api.scraperapi.com");
  if (!dnsOk) {
    console.log("\n⛔ DNS resolution failed — all subsequent tests will also fail.");
    console.log("   Check your network/firewall settings.\n");
    process.exit(1);
  }

  const tcpOk = await testTcp("api.scraperapi.com", 443);
  await testDirectHttps("https://api.scraperapi.com");

  const basicOk = await testScraperApiBasic();

  if (basicOk) {
    await testScraperApiLoopNet();
  } else {
    console.log("\n⛔ Skipping LoopNet test — fix basic connectivity first.");
  }

  console.log("\n=== Diagnostic complete ===\n");
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});