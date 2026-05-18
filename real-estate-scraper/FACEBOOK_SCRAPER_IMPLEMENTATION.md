# Facebook Scraper Implementation

## Overview

The Facebook Scraper (`FacebookScraper`) is a specialized web scraper that extracts real estate listings from Facebook groups. It extends the `BaseScraper` class and implements a multi-step process: authentication, session management, group navigation, feed scrolling, content parsing, and deduplication.

**Key File:** `server/src/scrapers/facebook/facebook.scraper.ts`

---

## Architecture & Design

### Class Structure

```typescript
export class FacebookScraper extends BaseScraper {
  readonly sourceName = "facebook";
  // ... implementation
}
```

The `FacebookScraper` extends `BaseScraper`, inheriting:
- Proxy management
- Pagination control
- Listing filtering and deduplication
- Error handling and logging

### Configuration

**Environment Variables Required:**
```env
FACEBOOK_USERNAME=<your-email@example.com>
FACEBOOK_PASSWORD=<your-password>
FACEBOOK_GROUP_URLS=<comma-separated group URLs>
PROXY_URLS=<comma-separated proxy URLs>  # Optional; uses first proxy only
```

**Session Persistence:**
- Session file: `facebook-session.json` (root directory)
- Stores cookies and localStorage for authentication
- Survives across scraper runs (persistent login)
- Automatically deleted if session expires

---

## Core Methods

### 1. Constructor

```typescript
constructor(options: ScraperOptions = {}) {
  super({ ...options, headless: false });
  // Runs browser in non-headless mode for debugging
  // Validates environment variables and parses group URLs
}
```

**Features:**
- Disables headless mode (`headless: false`) to show browser UI
- Validates `FACEBOOK_USERNAME` and `FACEBOOK_PASSWORD` are set
- Parses and normalizes group URLs from `FACEBOOK_GROUP_URLS`
- Logs number of target groups

### 2. `getEffectiveProxy()`

```typescript
protected getEffectiveProxy(): string | null {
  if (config.proxyUrls && config.proxyUrls.length > 0) {
    return config.proxyUrls[0];  // Always use FIRST proxy
  }
  if (config.proxyUrl) {
    return config.proxyUrl;
  }
  return null;
}
```

**Why First Proxy Only:**
- Facebook is sensitive to IP rotation
- Using the same proxy across all groups reduces rate-limiting
- Maintains session consistency

---

## Session Management

### Session File Structure

Stores Playwright browser context state:
```json
{
  "cookies": [...],
  "origins": [...]
}
```

### Key Methods

#### `sessionExists()`
Checks if session file exists at `facebook-session.json`

#### `loadSession(storageState)`
- Normalizes cookie `sameSite` attributes (required by Playwright)
- Re-scopes origins: `web.facebook.com` → `www.facebook.com`
- Returns processed cookies and origins for context restoration

#### `verifySession(page)`
- Navigates to Facebook homepage
- Checks if redirected to login page
- Returns `true` if logged in, `false` if session expired

---

## Authentication Flow

### `login(page: Page): Promise<boolean>`

**Steps:**

1. **Navigate to Facebook Homepage**
   - Timeout: 60 seconds
   - Waits for DOM to load

2. **Dismiss Cookie Consent Dialog**
   - Tries multiple selectors to find "Accept" button
   - Waits 2 seconds for page to stabilize

3. **Fill Email/Username**
   - Tries 4 different selectors (evolving FB UI)
   - Fills with `FACEBOOK_USERNAME`
   - Randomized delay: 600-1100ms

4. **Fill Password**
   - Character-by-character typing with random delays
   - Mimics human typing (75-150ms per character)
   - Helps evade bot detection

5. **Submit & Wait for Navigation**
   - Presses Enter key
   - Waits up to 30 seconds for navigation
   - Waits additional 3.5-5.5 seconds for page stabilization

6. **Handle 2FA/Checkpoint**
   - Detects checkpoint/2FA redirects
   - Saves session file for manual intervention
   - (Manual completion required in headless=false mode)

7. **Validate Login**
   - Checks if URL contains "login" or error indicators
   - Saves session cookies to `facebook-session.json`
   - Returns `true` on success, `false` on failure

**Error Handling:**
- Saves HTML debug files to `logs/` for troubleshooting
- Logs all significant steps with `logger`

---

## Group Navigation & Scraping

### `navigateToGroup(page, groupUrl): Promise<boolean>`

**Purpose:** Navigate to a Facebook group and verify the feed is loaded

**Steps:**

1. **Navigate to Group URL**
   - Timeout: 90 seconds (accounts for slow connections)
   - Waits for `domcontentloaded`

2. **Dismiss Modals**
   - Removes popups/notifications (via Escape key)
   - Tries multiple close button selectors

3. **Verify Feed Loaded**
   - Tries multiple feed selectors:
     - `[role='feed']` (standard feed)
     - `[data-pagelet='GroupFeed']` (Facebook group feed)
     - `a[href*='/posts/']` (post links)
   - Timeout per selector: 15 seconds
   - Saves debug HTML to `logs/`

4. **Return Status**
   - `true` if feed loaded successfully
   - `false` if feed didn't render or redirected to login

---

### `scrollFeed(page)`

**Purpose:** Lazy-load all posts on the group feed

**Algorithm:**

1. **Initial State**
   - Max 50 scroll passes
   - Each scroll: 1200px down
   - Delay: 1800-2800ms (random) per scroll

2. **Post Counting**
   - Counts visible post links after each scroll
   - If count stable for 3 consecutive passes → stop scrolling
   - Logs post count per iteration

3. **Smart Delays**
   - Every 5th scroll: 4-second delay
   - Other scrolls: 1800-2800ms random delay
   - Mimics human reading behavior

4. **Completion**
   - Scrolls back to top
   - Waits 1.5 seconds for final render

**Why This Works:**
- Facebook lazy-loads posts as user scrolls
- Stable post count indicates all posts loaded
- Random delays avoid detection algorithms

---

### `expandPosts(page)`

**Purpose:** Click "See more" buttons to reveal hidden text in posts

**Implementation:**

1. Finds all "See more" buttons using:
   - `[data-ad-rendering-role="story_message"] [role="button"]:has-text("See more")`
   - `[aria-label="See more"]`

2. Clicks first 30 buttons (limit to avoid excessive time)

3. Per-button delays: 250ms

**Why Limited to 30:**
- Time efficiency
- Most important listings appear first
- Avoids detection from excessive interactions

---

### `scrapeGroup(page, groupUrl): Promise<RawListing[]>`

**Orchestrates the group scraping flow:**

```
1. Navigate to group
   ↓ (if fails, return [])
2. Scroll feed (lazy-load all posts)
   ↓
3. Expand "See more" buttons
   ↓
4. Dismiss modals
   ↓
5. Capture final HTML
   ↓
6. Parse listings from HTML
   ↓
7. Log and return results
```

**Parsing:** Uses `parseFacebookGroupPosts(html, groupUrl, "facebook")` to extract:
- Property addresses
- Prices
- Descriptions
- URLs (for deduplication)

---

## Main Scraping Method

### `scrapePage(handle, pageNumber): Promise<RawListing[]>`

**Key Design:**
- Only runs on page 1 (single-page scraper)
- Returns empty array if `pageNumber !== 1`

**Flow:**

1. **Load or Create Session**
   ```
   Session exists?
   ├─ YES: Load cookies → Verify session is valid
   │       ├─ Valid: Use existing session
   │       └─ Expired: Delete & re-login
   └─ NO: Perform fresh login
   ```

2. **Iterate Through All Groups**
   - For each group URL:
     - Check if stop requested (can be interrupted)
     - Scrape group
     - Accumulate listings
     - Wait 5-9 seconds before next group
     - Check stop requested between groups

3. **Save Updated Session**
   - After all groups, update session cookies
   - Ensures next run can reuse this session

4. **Deduplicate Across Groups**
   - Remove duplicate listings found in multiple groups
   - Uses stable key from description/title
   - Logs how many duplicates removed

5. **Return Results**
   - Only listings that passed deduplication
   - All listings logged individually
   - Page closed in `finally` block (always executes)

---

## Deduplication

### `deduplicateAcrossGroups(listings): RawListing[]`

**Purpose:** Remove duplicate listings found across multiple groups

**Algorithm:**

1. Creates a `Set<string>` to track seen listings
2. For each listing:
   - Computes stable key from description/title
   - If key already seen → skip (log as duplicate)
   - If key not seen → add to set and include in results

3. Logs dedup count

**Why This Matters:**
- Same property often posted to multiple groups
- Deduplication ensures accurate listing counts
- Improves data quality in database

---

## Utility Methods

### `dismissModals(page)`

**Purpose:** Remove popup dialogs that block content

**Strategy:**

1. Check if modal exists: `div[role='dialog']` or `div[aria-modal='true']`
2. Try Escape key first
3. If still open, try clicking close buttons from:
   ```typescript
   [
     '[aria-label="Close"]',
     '[aria-label="close"]',
     "div[role='dialog'] div[role='button']:has-text('Not Now')",
     // ... more selectors
   ]
   ```
4. Stop after first successful close

---

### `handleTwoFactorOrCheckpoint(page)`

**Purpose:** Handle 2FA/checkpoint detection

**Current Implementation:**
- Logs warning message
- Notes that headless mode can't complete 2FA
- Saves partial session for manual intervention
- In headless=false mode, user can complete 2FA manually in browser window

**Future Enhancement:**
- Could integrate with SMS/email 2FA providers
- Could use OCR for CAPTCHA solving

---

### `saveDebug(html, label)`

**Purpose:** Save HTML snapshots for debugging

**Files Created:**
```
logs/facebook_<label>.html
```

**Debug Points:**
- `homepage_loaded` - After Facebook homepage loads
- `after_login_attempt` - After login submission
- `logged_in` - After successful login
- `checkpoint` - If 2FA detected
- `group_page_<group_name>` - Before scrolling group
- `final_<group_name>` - After scrolling group
- `group_page_no_feed` - If feed didn't render

**Usage:**
- Open these files in browser to see exact page state
- Useful for diagnosing parsing failures
- Helps identify UI changes by Facebook

---

### `slugify(url)`

Converts group URL to filename:
```
https://www.facebook.com/groups/1185152819072240/
→ "1185152819072240" (first 40 chars)
```

---

## Error Handling & Logging

### Log Levels

**ERROR** (critical failures):
- Could not find email/password inputs
- Login failed
- Navigation failed
- Parsing failed

**WARN** (recoverable issues):
- Session expired
- Feed didn't load
- 2FA/Checkpoint detected
- Modal didn't close

**INFO** (progress):
- Login successful
- Session verified
- Group navigated
- Posts counted
- Listings found

**DEBUG** (detailed):
- Stealth script applied
- Browser closed
- Selectors matched

---

## Configuration & Proxy

### Proxy System

**First Proxy Only Approach:**
```typescript
protected getEffectiveProxy(): string | null {
  if (config.proxyUrls && config.proxyUrls.length > 0) {
    return config.proxyUrls[0];  // ← ALWAYS first
  }
  // ...
}
```

**Why Not Rotate:**
- Changing IP between groups causes session invalidation
- Facebook detects and blocks rapid IP changes
- Consistent proxy maintains authentication across groups
- Reduces rate-limiting (same IP = trusted client)

---

## Browser Configuration

### Launch Arguments
```typescript
args: [
  "--no-sandbox",                    // Allow running in containers
  "--disable-setuid-sandbox",        // Required for Linux
  "--disable-dev-shm-usage",         // Use disk instead of /dev/shm
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",              // Hide automation banner
  "--disable-gpu",                   // Disable GPU acceleration
  "--no-zygote",                     // Disable zygote process
  "--window-size=1440,900",          // Realistic window size
  "--start-maximized",               // Start maximized
  "--disable-features=IsolateOrigins,SiteIsolationTrials",
  "--use-gl=swiftshader",            // Software rendering
  "--enable-webgl",                  // Enable WebGL
  "--ignore-gpu-blocklist",          // Allow WebGL without GPU
]
```

### Context Configuration
```typescript
{
  userAgent: "Mozilla/5.0...",       // Realistic user agent
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/New_York",
  extraHTTPHeaders: {...},           // Custom headers
  ignoreHTTPSErrors: true,           // Handle cert issues
  colorScheme: "light"               // Light theme
}
```

### Stealth Mode
- Puppeteer-extra stealth plugin
- Comprehensive evasion script injected into every page
- Masks webdriver detection
- Simulates realistic browser properties

---

## Performance & Timing

### Typical Execution

| Step | Time | Notes |
|------|------|-------|
| Load homepage | 2-3s | Includes initial wait |
| Dismiss consent | 2s | Wait for dialog |
| Fill credentials | 2s | Character-by-character typing |
| Navigate & redirect | 3-5s | Post-login wait |
| Navigate to group | 3s | Load + modal dismiss |
| Scroll feed | 60-120s | 50 passes × variable delays |
| Expand posts | 5-10s | 30 buttons × 250ms |
| Parse & dedupe | 1-2s | HTML parsing |

**Total Per Group:** ~75-150s (1.5-2.5 min)

**Total For 28 Groups:** ~35-70 minutes

---

## Session Persistence

### Flow

**First Run:**
```
Start → No session file → Login → Save session
```

**Subsequent Runs:**
```
Start → Load session cookies → Verify on homepage → Use session
                                    ↓
                                  Expired?
                                    ↓
                                  Re-login
```

### Session File Format

```json
{
  "cookies": [
    {
      "name": "c_user",
      "value": "...",
      "domain": "facebook.com",
      "path": "/",
      "expires": 9999999999,
      "httpOnly": true,
      "secure": true,
      "sameSite": "None"
    },
    // ... more cookies
  ],
  "origins": [
    {
      "origin": "https://www.facebook.com",
      "localStorage": [...]
    }
  ]
}
```

---

## Known Limitations & Workarounds

### Limitation 1: 2FA Detection
**Problem:** When 2FA is detected, automatic completion isn't possible in headless mode.

**Workaround:** 
- Run with `headless: false` to see browser
- Complete 2FA manually
- Session auto-saves

### Limitation 2: IP Blocking
**Problem:** Facebook may block proxy IPs after many requests.

**Workaround:**
- Use rotating proxy service with multiple IPs
- Increase inter-group delays
- Use first proxy (consistent IP) to avoid "new IP" blocks

### Limitation 3: Dynamic Content
**Problem:** Some listings are dynamically rendered.

**Workaround:**
- Scroll extensively (50 passes)
- Click "See more" buttons
- Wait for stable post counts

### Limitation 4: Rate Limiting
**Problem:** Too many requests → temporary IP ban.

**Workaround:**
- 5-9 second delays between groups
- Random delays in scrolling
- User-agent and browser properties match real browser

---

## Debugging Tips

### Enable Full Logging

Check logs in `server/logs/`:
- `facebook_*.html` - Page snapshots at key points
- Console output shows step-by-step progress

### Inspect Debug HTML Files

1. Download HTML file from logs
2. Open in browser
3. Check if content is present
4. Inspect selectors with DevTools

### Check Session File

```bash
cat facebook-session.json | jq '.cookies[0]'
```

If session is stale or missing, delete file to force re-login:

```bash
rm facebook-session.json
```

### Monitor Browser Window

With `headless: false`, watch:
- Login progress
- Group navigation
- Scrolling behavior
- 2FA/Checkpoint prompts

---

## Future Enhancements

1. **Parallel Group Scraping**
   - Use multiple pages/contexts
   - Scrape 3-5 groups simultaneously
   - Reduce total execution time by 3-5x

2. **JavaScript Rendering**
   - Detect dynamically-rendered content
   - Increase post count accuracy

3. **Checkpoint Automation**
   - Integrate with SMS/email providers
   - Auto-solve simple CAPTCHAs

4. **Adaptive Scrolling**
   - Detect page height dynamically
   - Adjust scroll step based on content density

5. **Proxy Rotation Per Session**
   - Use different proxy for each group
   - Implement IP reputation scoring
   - Switch proxy if rate-limited

---

## Configuration Examples

### Minimal Setup
```env
FACEBOOK_USERNAME=your-email@gmail.com
FACEBOOK_PASSWORD=your-password
FACEBOOK_GROUP_URLS=https://www.facebook.com/groups/1185152819072240/
```

### Production Setup
```env
FACEBOOK_USERNAME=business-account@company.com
FACEBOOK_PASSWORD=complex-password-with-2fa
FACEBOOK_GROUP_URLS=https://www.facebook.com/groups/group1/,https://www.facebook.com/groups/group2/,...
PROXY_URLS=http://user:pass@proxy1.com:8080,http://user:pass@proxy2.com:8080,...
```

---

## References

- [Playwright Documentation](https://playwright.dev)
- [Puppeteer-Extra Stealth Plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/extract-stealth-evasions)
- [Facebook Groups API Limitations](https://developers.facebook.com/docs/graph-api)

