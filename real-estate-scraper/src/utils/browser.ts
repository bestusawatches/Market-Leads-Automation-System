// src/utils/browser.ts
// ─────────────────────────────────────────────────────────────────────────────
// Centralised Playwright browser factory.
// Every scraper calls `createBrowser()` and gets a fully-configured instance
// with stealth, proxy, and realistic headers already applied.
// ─────────────────────────────────────────────────────────────────────────────

import { Browser, BrowserContext, Page, chromium } from "playwright";
import { config } from "../config";
import { logger } from "./logger";

/** Parse "http://user:pass@host:port" into a Playwright proxy object */
function parseProxy(
  proxyUrl: string | null
): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  const m = proxyUrl.match(/^https?:\/\/([^:]+):([^@]+)@(.+)$/);
  if (m) {
    const [, username, password, host] = m;
    return { server: `http://${host}`, username, password };
  }
  return { server: proxyUrl };
}

/** Minimal stealth init script — applied when playwright-extra isn't available */
const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  window.chrome = { runtime: {} };
`;

export interface BrowserHandle {
  browser: Browser;
  context: BrowserContext;
  /** Create a new stealth-patched page inside the shared context */
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

/**
 * Create a browser instance shared across all pages in one scrape run.
 * Call `handle.close()` when finished.
 */
export async function createBrowser(): Promise<BrowserHandle> {
  const proxy = parseProxy(config.proxyUrl);

  if (proxy) {
    logger.info(`[browser] Using proxy: ${proxy.server}`);
  } else {
    logger.info("[browser] No proxy — scraping direct");
  }

  const browser = await chromium.launch({
    headless: config.browser.headless,
    ...(proxy ? { proxy } : {}),
  });

  const context = await browser.newContext({
    userAgent: config.browser.userAgent,
    viewport: { ...config.browser.viewport },
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    extraHTTPHeaders: { ...config.browser.extraHeaders },
  });

  if (config.browser.useStealth) {
    await context.addInitScript(STEALTH_SCRIPT);
    logger.debug("[browser] Stealth init script applied to context");
  }

  return {
    browser,
    context,
    async newPage(): Promise<Page> {
      return context.newPage();
    },
    async close(): Promise<void> {
      await browser.close();
      logger.debug("[browser] Browser closed");
    },
  };
}

/** Sleep helper used by scrapers between requests */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random jitter within ±jitterMs of base */
export function jitter(baseMs: number, jitterMs = 2000): number {
  return baseMs + Math.random() * jitterMs;
}
