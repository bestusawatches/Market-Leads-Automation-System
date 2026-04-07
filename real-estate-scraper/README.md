# Real Estate Scraper

Minimal TypeScript scaffold for the real-estate-scraper project.

Quick start

1. Install dependencies:

```bash
cd real-estate-scraper
npm install
```

2. Copy `.env.example` to `.env` (SQLite example):

```bash
cp .env.example .env
```

3. Generate Prisma client and migrate (creates `dev.db`):

```bash
npx prisma generate
npx prisma migrate dev --name init
```

4. Run in dev mode:

```bash
npm run dev -- craigslist
```

Notes

- Fill in scraper logic in `src/scrapers/*`.
- Use `npm run build` then `npm start` for production.
