// src/scrapers/facebook/facebook.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// Facebook Groups is a React SPA with aggressive anti-bot detection.
//
// Facebook does NOT render structured data attributes like offmarket.com does.
// Posts are rendered as deeply nested divs with machine-generated class names
// that change on every deploy (e.g. "x1n2onr6 x1qjc9v5 xws9l8a").
//
// Strategy:
//   1. Use aria-label and data-* where available (more stable than class names)
//   2. Extract post text and parse fields from free text using regex
//   3. Extract links from post text / href attributes
//   4. Price, address, beds/baths come entirely from regex on the post body
//
// This parser is intentionally tolerant of missing fields — it captures
// whatever it can find rather than failing on missing structure.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function extractPrice(text: string): number | undefined {
  // Match "$150,000", "$150k", "$1.5M" patterns common in RE posts
  const m =
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/) ||  // $150k
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/) ||  // $1.5M
    text.match(/\$\s*([\d,]+)/);                         // $150,000

  if (!m) return undefined;
  let val = parseFloat(m[1].replace(/,/g, ""));
  const suffix = text[text.indexOf(m[0]) + m[0].length - 1]?.toLowerCase();
  if (suffix === "k") val *= 1000;
  if (suffix === "m") val *= 1_000_000;
  return Math.round(val);
}

function extractBedsBaths(text: string): { bedrooms?: number; bathrooms?: number } {
  const beds = text.match(/(\d+)\s*(?:bd|bed|br|bedroom)/i);
  const baths = text.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath|bathroom)/i);
  // Also catch "3/2" or "3BR/2BA" shorthand
  const shorthand = text.match(/(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:br|ba|bed|bath)?/i);
  return {
    bedrooms: beds ? parseInt(beds[1], 10) : shorthand ? parseInt(shorthand[1], 10) : undefined,
    bathrooms: baths ? parseFloat(baths[1]) : shorthand ? parseFloat(shorthand[2]) : undefined,
  };
}

function extractSqft(text: string): number | undefined {
  const m = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf|square\s*feet)/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function detectPropertyType(text: string): PropertyType {
  const t = text.toLowerCase();
  if (t.includes("single family") || t.includes("sfh") || t.includes("single-family")) return "single_family";
  if (t.includes("duplex")) return "duplex";
  if (t.includes("multi") || t.includes("triplex") || t.includes("fourplex") || t.includes("4plex")) return "multi_family";
  if (t.includes("condo")) return "condo";
  if (t.includes("townhome") || t.includes("townhouse")) return "townhouse";
  return "unknown";
}

function extractPhone(text: string): string | undefined {
  const m = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].trim() : undefined;
}

/**
 * Try to extract a US address from post text.
 * Real estate posts often include an address or at least city/state.
 */
function extractAddress(text: string): string | undefined {
  // "123 Main St, Columbus, OH 43215"
  const fullAddr = text.match(
    /\d+\s+[A-Z][a-zA-Z\s]+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl|Circle|Court|Place|Drive|Street|Avenue)\b[^,\n]*,?\s*[A-Z][a-zA-Z\s]+,\s*[A-Z]{2}\s*\d{5}/i
  );
  if (fullAddr) return fullAddr[0].trim();

  // "Columbus, OH" or "Milwaukee, WI"
  const cityState = text.match(/[A-Z][a-zA-Z\s]+,\s*(?:OH|WI)\b/);
  return cityState ? cityState[0].trim() : undefined;
}

function isRelevantPost(text: string): boolean {
  const lower = text.toLowerCase();
  const investmentKeywords = [
    "seller financ", "owner financ", "for sale", "asking", "arv",
    "investment", "rental", "cash flow", "flip", "wholesale", "deal",
    "single family", "sfh", "duplex", "multi", "buy", "property",
    "motivated seller", "off market", "off-market",
  ];
  const locationKeywords = ["ohio", "oh ", "milwaukee", "wisconsin", "wi "];
  const hasInvestment = investmentKeywords.some((k) => lower.includes(k));
  const hasLocation = locationKeywords.some((k) => lower.includes(k));
  return hasInvestment || hasLocation; // either is enough given we're in targeted groups
}

// ── Main parser ────────────────────────────────────────────────────────────

/**
 * Parse Facebook Group posts from rendered HTML.
 *
 * Facebook's class names are machine-generated and unstable, so we rely on:
 * - aria-label="Story" or role="article" for post containers
 * - data-ft attributes (sometimes present on feed items)
 * - The actual text content of posts for all field extraction
 */
export function parseFacebookGroupPosts(
  html: string,
  groupUrl: string,
  source: string
): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];

  // ── Find post containers ─────────────────────────────────────────────────
  // Facebook uses role="article" on each post — the most stable selector
  let posts = $("[role='article']");

  // Some group layouts use aria-label="Story" or data-ft with post IDs
  if (posts.length === 0) {
    posts = $("[aria-label='Story'], [data-ft]");
  }

  // Broad fallback: any div with a substantial amount of text
  if (posts.length === 0) {
    logger.warn("[fb-parser] No role=article posts found — trying broad fallback");
    posts = $("div").filter((_, el) => {
      const text = $(el).text();
      return text.length > 100 && text.length < 5000;
    });
  }

  logger.debug(`[fb-parser] Found ${posts.length} post candidates`);

  const seen = new Set<string>();

  posts.each((_, el) => {
    const post = $(el);
    const text = post.text().trim();

    if (text.length < 30) return; // skip tiny fragments
    if (!isRelevantPost(text)) return;

    // Deduplicate by text content (Facebook renders posts multiple times for
    // different UI states — mobile preview, expanded, etc.)
    const textKey = text.slice(0, 120);
    if (seen.has(textKey)) return;
    seen.add(textKey);

    // Try to find a direct post URL from the timestamp link
    // Facebook post URLs follow: /groups/{id}/posts/{postId}/ or /permalink/{id}/
    const postLinkEl = post.find(
      "a[href*='/posts/'], a[href*='/permalink/'], a[href*='/groups/']"
    ).first();
    const rawHref = postLinkEl.attr("href") ?? "";
    const url = rawHref.startsWith("http")
      ? rawHref
      : rawHref
      ? `https://www.facebook.com${rawHref}`
      : `${groupUrl}#post-${seen.size}`; // fallback synthetic URL

    // Extract fields from post text
    const price = extractPrice(text);
    const { bedrooms, bathrooms } = extractBedsBaths(text);
    const squareFeet = extractSqft(text);
    const address = extractAddress(text);
    const propertyType = detectPropertyType(text);
    const ownerPhone = extractPhone(text);

    // Try to get poster name (the person who made the post)
    // Facebook renders this in an h2 or strong tag near the top of the article
    const nameEl = post.find("h2, h3, strong, b, [role='heading']").first();
    const ownerName = nameEl.text().trim() || undefined;

    // Only include posts that have at least a price OR a clear property reference
    if (!price && propertyType === "unknown" && !address) return;

    results.push({
      url,
      source,
      title: text.slice(0, 120).replace(/\s+/g, " ").trim(),
      price,
      address,
      location: address, // address often contains city/state for FB posts
      propertyType,
      bedrooms,
      bathrooms,
      squareFeet,
      description: text.slice(0, 2000),
      ownerName,
      ownerPhone,
    });
  });

  logger.debug(`[fb-parser] ${results.length} relevant listings extracted`);
  return results;
}