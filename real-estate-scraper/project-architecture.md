# Real Estate Scraper Project Architecture

This project is an automated system for scraping off-market real estate leads from various sources, enriching them with Zillow data, scoring potential deals, and storing results in a PostgreSQL database.

## High-Level Architecture

The system follows a modular architecture with clear separation of concerns:

1. **CLI Entry Point** (`index.ts`) - Parses command-line arguments and orchestrates scraping or enrichment runs
2. **Configuration** (`src/config/index.ts`) - Centralized configuration for browser settings, scraping limits, filters, and source URLs
3. **Runner** (`src/runner.ts`) - Main orchestration logic that runs scrapers, applies enrichment, scores deals, and saves to database
4. **Scrapers** - Modular scrapers for different real estate websites
4. **Scrapers** - Modular scrapers for different real estate websites (now includes a Zillow scraper)
5. **Enrichers** - Data enrichment modules (Zillow enricher still present)
6. **Database Layer** - Prisma-based data persistence
7. **Utilities** - Browser management, logging, and shared helpers

## Folder Structure and File Descriptions

### Root Level Files

- **`index.ts`** - CLI entry point that handles command-line arguments for scraping specific sources or running enrichers. Uses yargs for argument parsing and supports options like `--source`, `--max-pages`, `--max-listings`. Imports scrapers from registry and runs them via the runner.

- **`package.json`** - Node.js project configuration with scripts for different scraping sources (craigslist, facebook, crexi, etc.), database operations, and enrichment tasks. Uses TypeScript, Playwright for browser automation, Prisma for database, and various utilities.

- **`tsconfig.json`** - TypeScript configuration targeting ES2022, with strict mode enabled and includes for src/ and index.ts.

- **`docker-compose.yaml`** - Defines services for PostgreSQL database, Adminer (database UI), and Redis. Used for local development environment.

- **`polyfill-file.js`** - Provides a polyfill for the global `File` constructor, which is needed for some browser automation libraries. Dynamically imports fetch-blob for full implementation.

- **`facebook-session.json`** - Stores Facebook session cookies for authentication when scraping Facebook marketplace or groups.

- **`prisma/schema.prisma`** - Prisma database schema defining the `Listing` model with fields for property details, enrichment data, and deal scoring.

### `src/` Directory

#### `config/index.ts`
Central configuration file containing all runtime settings:
- Browser configuration (user agent, viewport, stealth settings)
- Proxy settings
- Scraping limits (max pages, max listings, request delays)
- Filtering criteria (price ranges, property types, keywords, locations)
- Source URLs for different scraping targets (Craigslist cities, Crexi, LoopNet, etc.)

#### `db/`
- **`client.ts`** - Singleton Prisma client instance with global caching for development. Handles database connection pooling.

- **`repository.ts`** - Database operations layer. Provides `upsertListing` and `upsertMany` functions for saving scraped listings. Handles deduplication by URL and preserves enrichment data on updates.

#### `enrichers/zillow/`
- **`index.enricher.ts`** - Exports the main enrichment functions for integration with the runner.
- **`zillow.enricher.ts`** - Core Zillow enrichment logic. Uses Zillow's autocomplete API to resolve addresses to ZPIDs, then fetches property details to extract zestimates. Implements rate limiting and cookie management to avoid detection.

- **`test.ts`** and **`test.debug.ts`** - Test scripts for validating Zillow enrichment functionality.

Note: Zillow is implemented in two places now — as an independent scraper under `src/scrapers/zillow/` (parser + scraper) for extracting search/listing results, and as an enricher under `src/enrichers/zillow/` for resolving addresses → ZPID → zestimates. The runner applies the enricher to scraper results before scoring and DB upsert.

#### `scrapers/`
- **`base.scraper.ts`** - Abstract base class for all scrapers. Provides common functionality like pagination, deduplication, filtering, browser management, and result limits. Subclasses implement `scrapePage` method.

- **`registry.ts`** - Registry mapping source names to scraper factory functions. Supports aliases like "craigslist" (runs all CL cities) and "all" (runs all scrapers). Used by CLI to resolve which scrapers to run.

#### Individual Scraper Modules
Each scraper module follows the same pattern with two files:

- **`<source>.scraper.ts`** - Extends `BaseScraper`, implements site-specific scraping logic including URL construction, page navigation, and retry handling.

- **`<source>.parser.ts`** - Contains parsing logic using Cheerio to extract structured data from HTML. Handles different page layouts and normalizes data to `RawListing` format.

Available scrapers:
- **`craigslist/`** - Scrapes Craigslist real estate sections for multiple cities (Milwaukee, Columbus, Cleveland, Toledo)
- **`crexi/`** - Scrapes Crexi commercial real estate listings
- **`facebook/`** - Scrapes Facebook real estate groups
- **`investorlift/`** - Scrapes InvestorLift platform
- **`loopnet/`** - Scrapes LoopNet commercial listings
- **`marketplace/`** - Scrapes Facebook Marketplace
- **`offmarket/`** - Scrapes off-market listings
 - **`zillow/`** - Scrapes Zillow search pages (parser + scraper). The registry exposes `zillow` so you can run it via the CLI (`--source zillow`) or with the npm script `scrape:zillow`.

#### `types/listing.ts`
TypeScript type definitions:
- `PropertyType` enum for property classifications
- `DealScore` enum for deal quality assessment
- `RawListing` interface for scraper output
- `UnderwritingResult` for scoring results
- `ListingUpsertPayload` for database operations

#### `utils/`
- **`browser.ts`** - Browser automation utilities. Creates Playwright browser instances with stealth settings, proxy support, and user agent configuration. Provides helper functions for delays and jitter.

- **`logger.ts`** - Winston-based logging configuration. Logs to console with colors and to rotating files in the `logs/` directory.

### `logs/` Directory
Contains output files from scraping runs:
- HTML snapshots for debugging (e.g., `facebook_login_error.html`)
- JSON data dumps (e.g., `craigslist_milwaukee.json`)
- Parser debug logs (e.g., `crexi_parser_debug.txt`)
- Error logs with timestamps

### `prisma/` Directory
- **`schema.prisma`** - Database schema as described above

## Data Flow

1. **CLI Execution**: `index.ts` parses arguments and calls `runScrapers` in `runner.ts`
2. **Scraper Orchestration**: `runner.ts` iterates through selected scrapers from `registry.ts`
3. **Scraping**: Each scraper extends `BaseScraper` and implements `scrapePage` to extract raw listings
4. **Parsing**: Site-specific parsers convert HTML to structured `RawListing` objects
5. **Filtering**: `BaseScraper` applies relevance filters based on keywords, price, and location
6. **Enrichment**: `runner.ts` calls Zillow enricher to add zestimates to listings
7. **Scoring**: `runner.ts` calculates deal scores based on price vs. zestimate ratios
8. **Storage**: `repository.ts` upserts listings to PostgreSQL via Prisma

## Key Design Patterns

- **Factory Pattern**: `registry.ts` provides scraper factories for runtime instantiation
- **Template Method**: `BaseScraper` defines the scraping workflow with extensible `scrapePage`
- **Repository Pattern**: `repository.ts` abstracts database operations
- **Singleton**: Prisma client in `client.ts`
- **Strategy Pattern**: Different parsers for different site layouts
- **Observer Pattern**: Logger utility for consistent logging across modules

## Dependencies

- **Playwright**: Browser automation for JavaScript-heavy sites
- **Cheerio**: HTML parsing and DOM manipulation
- **Prisma**: Database ORM and migration tool
- **Winston**: Structured logging
- **Yargs**: CLI argument parsing
- **Axios**: HTTP requests for enrichment APIs
- **Puppeteer Extra**: Stealth plugins for anti-bot evasion