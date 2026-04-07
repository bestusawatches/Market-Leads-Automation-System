// src/scrapers/craigslist/craigslist.parser.ts
import * as cheerio from "cheerio";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/[$,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

function extractBedsBathsSqft(text: string): {
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
} {
  const beds = text.match(/(\d+)\s*br/i);
  const baths = text.match(/(\d+(?:\.\d+)?)\s*ba/i);
  const sqft = text.match(/(\d[\d,]*)\s*ft/i);
  return {
    bedrooms: beds ? parseInt(beds[1], 10) : undefined,
    bathrooms: baths ? parseFloat(baths[1]) : undefined,
    squareFeet: sqft ? parseInt(sqft[1].replace(/,/g, ""), 10) : undefined,
  };
}

// ── Search results page ────────────────────────────────────────────────────

/**
 * Parse a Craigslist real-estate search results page.
 * Handles all three known layouts:
 *   1. Static (li.cl-static-search-result)  — served via proxies / no JS
 *   2. New 2023+ (li[data-pid])
 *   3. Classic (li.result-row)
 */
export function parseCraigslistSearchPage(
  html: string,
  baseUrl: string
): Omit<RawListing, "source">[] {
  const $ = cheerio.load(html);
  const results: Omit<RawListing, "source">[] = [];

  // ── Layout 1: static ──────────────────────────────────────────────────────
  const staticItems = $("li.cl-static-search-result");
  if (staticItems.length > 0) {
    logger.debug(`[cl-parser] static layout: ${staticItems.length} items`);
    staticItems.each((_, el) => {
      const anchor = $(el).find("a").first();
      const href = anchor.attr("href");
      if (!href) return;
      results.push({
        url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
        title: $(el).find(".title").text().trim() || anchor.text().trim(),
        price: parsePrice($(el).find(".price").text()),
        location: $(el).find(".location").text().trim() || undefined,
      });
    });
    return results;
  }

  // ── Layout 2: new (data-pid) ───────────────────────────────────────────────
  const newItems = $("li[data-pid]");
  if (newItems.length > 0) {
    logger.debug(`[cl-parser] new layout: ${newItems.length} items`);
    newItems.each((_, el) => {
      const anchor =
        $(el).find("a.cl-app-anchor, a[data-id]").first() ||
        $(el).find("a").first();
      const href = anchor.attr("href");
      if (!href) return;

      const housingText = $(el).find(".housing").text();
      const { bedrooms, bathrooms, squareFeet } = extractBedsBathsSqft(housingText);

      results.push({
        url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
        title: anchor.text().trim() || undefined,
        price: parsePrice($(el).find(".priceinfo, .price").first().text()),
        location:
          $(el)
            .find(".supertitle")
            .text()
            .trim()
            .replace(/[()]/g, "")
            .trim() || undefined,
        postedDate: $(el).find("time").attr("datetime")
          ? new Date($(el).find("time").attr("datetime")!)
          : undefined,
        bedrooms,
        bathrooms,
        squareFeet,
      });
    });
    return results;
  }

  // ── Layout 3: classic (result-row) ────────────────────────────────────────
  const classicItems = $("li.result-row");
  logger.debug(`[cl-parser] classic layout: ${classicItems.length} items`);
  classicItems.each((_, el) => {
    const anchor = $(el).find("a.result-title").first();
    const href = anchor.attr("href");
    if (!href) return;

    const housingText = $(el).find(".housing").text();
    const { bedrooms, bathrooms, squareFeet } = extractBedsBathsSqft(housingText);

    results.push({
      url: href.startsWith("http") ? href : new URL(href, baseUrl).toString(),
      title: anchor.text().trim() || undefined,
      price: parsePrice($(el).find(".result-price").first().text()),
      location:
        $(el)
          .find(".result-hood")
          .text()
          .trim()
          .replace(/[()]/g, "")
          .trim() || undefined,
      postedDate: $(el).find("time").attr("datetime")
        ? new Date($(el).find("time").attr("datetime")!)
        : undefined,
      bedrooms,
      bathrooms,
      squareFeet,
    });
  });

  return results;
}

// ── Detail page ────────────────────────────────────────────────────────────

export interface CraigslistDetail {
  description?: string;
  address?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
}

export function parseCraigslistDetailPage(html: string): CraigslistDetail {
  const $ = cheerio.load(html);

  // Description — remove QR code boilerplate
  const bodyEl = $("#postingbody");
  bodyEl.find(".print-qrcode-container, .printqrcode").remove();
  const description = bodyEl.text().trim() || undefined;

  // Address
  const address =
    $("div.mapaddress, .postingtitletext .mapaddress").first().text().trim() ||
    undefined;

  // Beds / baths / sqft from attribute groups
  let bedrooms: number | undefined;
  let bathrooms: number | undefined;
  let squareFeet: number | undefined;

  $("p.attrgroup, .attrgroup").each((_, group) => {
    $(group)
      .find("span")
      .each((_, span) => {
        const txt = $(span).text().toLowerCase();
        const { bedrooms: b, bathrooms: ba, squareFeet: s } =
          extractBedsBathsSqft(txt);
        if (b && !bedrooms) bedrooms = b;
        if (ba && !bathrooms) bathrooms = ba;
        if (s && !squareFeet) squareFeet = s;
      });
  });

  return { description, address, bedrooms, bathrooms, squareFeet };
}
