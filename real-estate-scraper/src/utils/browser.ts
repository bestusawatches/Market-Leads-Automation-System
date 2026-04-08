import { Browser, BrowserContext, Page, chromium } from "playwright";
import { config } from "../config";
import { logger } from "./logger";

function parseProxy(
  proxyUrl: string | null,
): { server: string; username?: string; password?: string } | undefined {
  if (!proxyUrl) return undefined;
  const m = proxyUrl.match(/^https?:\/\/([^:]+):([^@]+)@(.+)$/);
  if (m) {
    const [, username, password, host] = m;
    return { server: `http://${host}`, username, password };
  }
  return { server: proxyUrl };
}

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
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export async function createBrowser(): Promise<BrowserHandle> {
  const proxy = parseProxy(config.proxyUrl);
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_PATH || "/usr/bin/chromium-browser";

  logger.info(`[browser] Using executable: ${executablePath}`);
  if (proxy) {
    logger.info(`[browser] Using proxy: ${proxy.server}`);
  } else {
    logger.info("[browser] No proxy — scraping direct");
  }

  const browser = await chromium.launch({
    executablePath,
    headless: config.browser.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
    ],
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(baseMs: number, jitterMs = 2000): number {
  return baseMs + Math.random() * jitterMs;
}
