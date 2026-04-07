import { chromium, Browser, BrowserContext, Page } from "playwright";

export async function launchBrowser(
  headless = true,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  return { browser, context };
}

export async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  return page;
}
