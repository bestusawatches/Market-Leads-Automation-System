// src/scrapers/offmarket/offmarket.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// offmarket.com runs the ListingPro WordPress theme.
// Confirmed class names from the site's own CSS:
//   Card container : .classic-view-grid-container
//   Title/link     : .classic-view-grid-content-area h4 a
//   Price          : .lp-price-main, .lp-listing-price, [class*='price']
//   Address        : .lp-listing-address, .propertyAddress
//   Specs (bed/bath/sqft): .pFormFields, .pFormFieldsWrap
//   Property type  : .propertyFor, .lp-listing-type
//   Listing URL    : h4 a href or .classic-thumbnail-url href
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

const BASE = "https://www.offmarket.com";

// ── Helpers ────────────────────────────────────────────────────────────────

function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.replace(/[$,\s]/g, "").match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex")) return "duplex";
  if (t.includes("multi") || t.includes("triplex") || t.includes("fourplex")) return "multi_family";
  if (t.includes("condo")) return "condo";
  if (t.includes("town")) return "townhouse";
  return "unknown";
}

function extractBedsBathsSqft(text: string) {
  const beds = text.match(/(\d+)\s*(?:bd|bed|br|bedroom)/i);
  const baths = text.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|bathroom)/i);
  const sqft = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf|square\s*feet)/i);
  return {
    bedrooms: beds ? parseInt(beds[1], 10) : undefined,
    bathrooms: baths ? parseFloat(baths[1]) : undefined,
    squareFeet: sqft ? parseInt(sqft[1].replace(/,/g, ""), 10) : undefined,
  };
}

function absoluteUrl(href: string): string {
  if (!href) return "";
  if (href.startsWith("http")) return href;
  return `${BASE}${href.startsWith("/") ? "" : "/"}${href}`;
}

// ── Search results page ────────────────────────────────────────────────────

export function parseOffmarketSearchPage(
  html: string,
): Omit<RawListing, "source">[] {
  const $ = cheerio.load(html);
  const results: Omit<RawListing, "source">[] = [];

  // ── Step 1: ListingPro theme selectors (confirmed from site CSS) ─────────
  const listingproSelectors = [
    ".classic-view-grid-container",   // main card container
    ".lp-grid-box-contianer",         // alternative container (note: typo in theme)
    ".lp-listing",                    // listing row in list view
    ".vertical_view .lp-price-main",  // vertical layout
    "article.hentry",                 // WP post fallback
  ];

  let cards = $();
  let matchedSelector = "";

  for (const sel of listingproSelectors) {
    try {
      const found = $(sel);
      if (found.length > 0) {
        cards = found;
        matchedSelector = sel;
        logger.debug(`[om-parser] ${found.length} cards via ListingPro selector: "${sel}"`);
        break;
      }
    } catch {
      // skip
    }
  }

  // ── Step 2: Generic fallback selectors ──────────────────────────────────
  if (cards.length === 0) {
    const genericSelectors = [
      "article.property-card",
      ".property-card",
      ".listing-card",
      "[class*='property-card']",
      "[class*='listing-card']",
      "[data-testid='property-card']",
    ];
    for (const sel of genericSelectors) {
      try {
        const found = $(sel);
        if (found.length > 0) {
          cards = found;
          matchedSelector = sel;
          logger.debug(`[om-parser] ${found.length} cards via generic selector: "${sel}"`);
          break;
        }
      } catch {
        // skip
      }
    }
  }

  // ── Step 3: Link-pattern fallback ───────────────────────────────────────
  if (cards.length === 0) {
    logger.debug("[om-parser] No cards found — trying link-pattern fallback");

    // offmarket.com listing URLs contain the listing slug under /listing-category/ parent
    // Individual listings are at paths like /listing/property-name/
    const propertyLinks = $("a[href*='/listing/']");

    if (propertyLinks.length > 0) {
      logger.debug(`[om-parser] Found ${propertyLinks.length} listing links`);

      const seen = new Set<string>();
      propertyLinks.each((_, el) => {
        const anchor = $(el);
        const href = anchor.attr("href") ?? "";
        const url = absoluteUrl(href);
        if (!url || seen.has(url)) return;
        seen.add(url);

        const parent = anchor.closest("li, article, div, .col-md-4, .col-sm-6");
        const context = parent.length ? parent : anchor;
        const fullText = context.text();

        const priceMatch = fullText.match(/\$[\d,]+/);
        const price = priceMatch ? parsePrice(priceMatch[0]) : undefined;
        const address = anchor.text().trim() || undefined;
        const { bedrooms, bathrooms, squareFeet } = extractBedsBathsSqft(fullText);

        results.push({
          url,
          title: address,
          price,
          address,
          propertyType: detectPropertyType(fullText),
          bedrooms,
          bathrooms,
          squareFeet,
        });
      });

      logger.debug(`[om-parser] Link fallback: ${results.length} listings`);
      return results;
    }

    // Log CSS classes for debugging
    const allClasses = new Set<string>();
    $("[class]").each((_, el) => {
      const cls = $(el).attr("class") ?? "";
      cls.split(/\s+/).forEach((c) => {
        if (c.length > 3 && c.length < 50 && !c.startsWith("mm-") && !c.startsWith("heateor")) {
          allClasses.add(c);
        }
      });
    });
    const classPreview = [...allClasses].slice(0, 40).join(", ");
    logger.warn(`[om-parser] No listings. Classes on page: ${classPreview || "(none)"}`);

    return [];
  }

  // ── Step 4: Parse matched cards ─────────────────────────────────────────
  cards.each((_, el) => {
    const card = $(el);

    // URL — ListingPro uses h4 a for title links, or .classic-thumbnail-url
    const titleLink = card.find(".classic-view-grid-content-area h4 a, .lp-listing-content-grid h4 a").first();
    const thumbLink = card.find(".classic-thumbnail-url, a.classic-thumbnail-url").first();
    const anyLink = card.find("a[href*='/listing/']").first();

    const anchor = titleLink.length ? titleLink : thumbLink.length ? thumbLink : anyLink;
    const href = anchor.attr("href") ?? card.find("a[href]").first().attr("href") ?? "";
    const url = absoluteUrl(href);
    if (!url || url === BASE + "/" || url === BASE) return;

    // Price — ListingPro uses .lp-price-main or data-price
    const priceEl = card.find(".lp-price-main, [class*='lp-price'], [class*='price-main'], .titlePrice").first();
    const priceText = priceEl.text() || card.find("[data-price]").attr("data-price") || "";
    const price = parsePrice(priceText) ||
      parsePrice(card.text().match(/\$[\d,]+/)?.[0]);

    // Address — ListingPro uses .lp-listing-address or .propertyAddress
    const addressEl = card
      .find(".lp-listing-address, .propertyAddress, [class*='address'], .lp-address")
      .first();
    const address = addressEl.text().trim() || anchor.text().trim() || undefined;

    // Location
    const locationEl = card.find(".lp-listing-location, [class*='location'], .lp-city").first();
    const location = locationEl.text().trim() || undefined;

    // Property type — ListingPro uses .propertyFor badge
    const typeEl = card.find(".propertyFor, [class*='propertyFor'], [class*='property-type'], .lp-listing-type").first();
    const fullText = card.text();
    const propertyType = typeEl.text().trim()
      ? detectPropertyType(typeEl.text())
      : detectPropertyType(fullText);

    // Beds/baths/sqft — ListingPro uses .pFormFields spans
    const specsText = card.find(".pFormFieldsWrap, .pFormFields, [class*='pForm']").text();
    const { bedrooms, bathrooms, squareFeet } = extractBedsBathsSqft(specsText || fullText);

    // Posted date
    const dateEl = card.find("time").first();
    const postedDate = dateEl.attr("datetime")
      ? new Date(dateEl.attr("datetime")!)
      : undefined;

    results.push({
      url,
      title: address || anchor.text().trim() || undefined,
      price,
      address,
      location,
      propertyType,
      bedrooms,
      bathrooms,
      squareFeet,
      postedDate,
    });
  });

  logger.debug(`[om-parser] Parsed ${results.length} listings via "${matchedSelector}"`);
  return results;
}

// ── Detail page ────────────────────────────────────────────────────────────

export interface OffmarketDetail {
  description?: string;
  address?: string;
  location?: string;
  propertyType?: PropertyType;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  ownerName?: string;
  ownerPhone?: string;
}

export function parseOffmarketDetailPage(html: string): OffmarketDetail {
  const $ = cheerio.load(html);

  // ListingPro detail page selectors
  const descEl = $(
    ".lp-listing-desription, .lp-listing-description, [class*='description'], .entry-content",
  ).first();
  const description = descEl.text().trim() || undefined;

  const addrEl = $(
    ".propertyAddress, .lp-listing-address, [class*='address'], h1.lp-listing-name",
  ).first();
  const address = addrEl.text().trim() || undefined;

  const locEl = $(
    ".lp-listing-location, [class*='location'], [class*='city']",
  ).first();
  const location = locEl.text().trim() || undefined;

  const typeEl = $(
    ".propertyFor, [class*='propertyFor'], [class*='property-type']",
  ).first();
  const bodyText = $("body").text();
  const propertyType = typeEl.text().trim()
    ? detectPropertyType(typeEl.text())
    : detectPropertyType(bodyText);

  const specsText = $(".pFormFieldsWrap, .pFormFields, [class*='pForm'], [class*='spec'], [class*='feature']")
    .text()
    .toLowerCase();
  const { bedrooms, bathrooms, squareFeet } = extractBedsBathsSqft(specsText || bodyText);

  // Contact info — ListingPro shows seller/agent in .lp-listing-leadform or .formFieldsInner
  const contactSection = $(
    ".lp-listing-leadform, .lp-agent-contact, [class*='contact'], [class*='seller'], [class*='agent']",
  ).text();

  const phoneMatch = contactSection.match(
    /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
  );
  const ownerPhone = phoneMatch ? phoneMatch[0].trim() : undefined;

  const nameMatch = contactSection.match(
    /(?:contact|seller|owner|agent|listed by|broker)[:\s]+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/i,
  );
  const ownerName = nameMatch ? nameMatch[1].trim() : undefined;

  return {
    description,
    address,
    location,
    propertyType,
    bedrooms,
    bathrooms,
    squareFeet,
    ownerName,
    ownerPhone,
  };
}

// ── Pagination helper ──────────────────────────────────────────────────────

export function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  const selectors = [
    "a[rel='next']",
    "a[aria-label*='next' i]",
    ".next-page",
    ".nav-next a",
    ".page-numbers.next",
    "[class*='pagination'] .next",
    // ListingPro pagination
    ".lp-pagination .next",
    "a.next.page-numbers",
  ];
  for (const sel of selectors) {
    try {
      if ($(sel).length > 0) return true;
    } catch {
      // skip
    }
  }
  return false;
}