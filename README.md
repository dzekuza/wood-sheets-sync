# wood-sheets-sync

Shopify admin app that syncs product data from a public Google Sheet into Shopify. One-way sync: Sheets → Shopify.

---

## What it does

1. Merchant pastes a public Google Sheet URL in Settings
2. App fetches the sheet column headers
3. Merchant maps each column to a Shopify product field
4. Merchant clicks **Sync Now** on the dashboard — or sets an automatic schedule
5. App reads every sheet row, finds the matching Shopify product by SKU, and updates it
6. If no product with that SKU exists, it creates one

---

## Tech stack

| Layer | Technology |
|---|---|
| Framework | Remix (via Shopify CLI template) + TypeScript |
| UI | @shopify/polaris v12 + @shopify/app-bridge-react |
| Database | Prisma + SQLite (dev) |
| Sheets | Google Sheets API v4 — native fetch, API key only (public sheets) |
| Scheduler | node-cron |
| Shopify API | Admin GraphQL API (2026-07) |

---

## Project structure

```
app/
  routes/
    app.tsx                   # AppBridge + Polaris shell, nav menu
    app._index.tsx            # Dashboard: sync status + Sync Now button
    app.settings.tsx          # Sheet URL input → column mapping
    app.schedule.tsx          # Auto-sync interval configuration
    app.logs.tsx              # Last 50 sync runs
    api.sheet-headers.tsx     # POST: fetch sheet column headers
    api.sync.tsx              # POST: trigger manual sync

  lib/
    validators.ts             # Zod schemas + extractSpreadsheetId() + SHOPIFY_FIELDS
    google-sheets.server.ts   # fetchSheetHeaders(), fetchSheetRows()
    shopify-graphql.server.ts # findVariantBySku(), updateProductFields(), updateVariantFields(), createProduct()
    shopify-sync.server.ts    # runSync() — full orchestrator
    sync-logger.server.ts     # createSyncLog(), updateSyncLog(), getRecentLogs()
    scheduler.server.ts       # startScheduler(), rescheduleJob() via node-cron

prisma/
  schema.prisma               # All models
  migrations/                 # Applied migrations
```

---

## Database models

### SheetConfig
One row per shop. Stores the connected sheet URL and tab name.

| Field | Type | Notes |
|---|---|---|
| id | String | cuid |
| shop | String | unique — myshopify.com domain |
| sheetUrl | String | full Google Sheets URL |
| spreadsheetId | String | extracted from URL |
| sheetName | String | tab name, default "Sheet1" |
| skuColumn | String? | which header column is the SKU |

### FieldMapping
One row per mapped column. Links a sheet column name to a Shopify field.

| Field | Type | Notes |
|---|---|---|
| sheetColumn | String | e.g. "Product Name" |
| shopifyField | String | one of 9 supported values (see below) |

### SyncSchedule
One row per shop. Controls automatic sync cadence.

| Field | Type | Notes |
|---|---|---|
| intervalHours | Int? | null = disabled; valid: 1, 2, 4, 6, 12, 24 |
| isEnabled | Boolean | master on/off switch |
| nextRunAt | DateTime? | informational |

### SyncLog
One row per sync run. Used for the Logs page.

| Field | Type | Notes |
|---|---|---|
| triggeredBy | String | "manual" or "scheduled" |
| status | String | "running" / "success" / "partial" / "failed" |
| totalRows | Int | |
| updatedCount | Int | products created or updated |
| skippedCount | Int | rows with no SKU value |
| errorCount | Int | rows that failed |
| errorMessages | String? | JSON array of error strings |

---

## Supported Shopify field mappings

| Value | Shopify field |
|---|---|
| title | Product title |
| body_html | Description (HTML) |
| vendor | Vendor |
| product_type | Product type |
| tags | Tags (comma-separated in sheet) |
| price | Variant price |
| compare_at_price | Variant compare-at price |
| sku | Variant SKU (also used as the lookup key) |
| barcode | Variant barcode |

---

## Sync logic

```
runSync(shop, triggeredBy, admin)
  1. createSyncLog() → status = "running"
  2. Load SheetConfig + FieldMappings from DB
  3. fetchSheetRows(spreadsheetId, sheetName) — one API call
  4. Build header index: column name → column index
  5. For each data row:
     a. Extract SKU from skuColumn
     b. Build productPayload (title, description, vendor, type, tags)
     c. Build variantPayload (price, compareAtPrice, barcode)
     d. findVariantBySku(admin, sku)
        → found:  updateProductFields() + updateVariantFields()
        → not found: createProduct() — creates with ACTIVE status, then updates variant
     e. 100ms delay between rows (rate limit protection)
  6. updateSyncLog() with final counts and status
```

---

## Google Sheets API

- **Endpoint**: `GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}`
- **Auth**: API key only (sheet must be shared as "Anyone with the link can view")
- **Range format**: `'SheetName'!A:Z` — single quotes handle tab names with spaces
- **Key env var**: `GOOGLE_SHEETS_API_KEY`

---

## Shopify GraphQL operations

All validated against Admin API schema (2026-07).

| Operation | Mutation/Query | Scope |
|---|---|---|
| Find variant by SKU | `productVariants(query: "sku:\"...\"")` | read_products |
| Update product fields | `productUpdate(product, identifier)` | write_products |
| Update variant fields | `productVariantsBulkUpdate` | write_products |
| Create new product | `productCreate` + `productVariantsBulkUpdate` | write_products |

Required scopes: `write_products` (includes `read_products`).

---

## Scheduler

- Uses `node-cron` with a global singleton guard (`global.__schedulerStarted`) to prevent duplicate jobs on hot reload
- `startScheduler()` is called from `entry.server.tsx` on boot — reads all enabled `SyncSchedule` rows from DB and registers jobs
- `rescheduleJob(shop, intervalHours, isEnabled)` is called immediately when a merchant saves a new schedule
- Background jobs use `unauthenticated.admin(shop)` which reads the stored offline session token from the Prisma session table

---

## Environment variables

```env
SHOPIFY_API_KEY=           # set automatically by shopify app dev
SHOPIFY_API_SECRET=        # set automatically by shopify app dev
SHOPIFY_APP_URL=           # set automatically by shopify app dev (tunnel URL)
SCOPES=write_products
DATABASE_URL=file:dev.sqlite
GOOGLE_SHEETS_API_KEY=     # Google Cloud Console → Credentials → API key
```

---

## Setup & development

```bash
# Install dependencies
npm install

# Run database migrations
npx prisma migrate dev

# Start dev server (opens tunnel + Shopify admin prompt)
shopify app dev
```

The dev server will ask you to select a store, install the app, then open it in Shopify Admin.

---

## Known constraints

- **Public sheets only** — the Google Sheet must be shared as "Anyone with the link can view". Private sheets require Google OAuth (not implemented).
- **SKU is the match key** — every sheet row must have a value in the SKU column. Rows without a SKU are skipped.
- **One-way sync** — changes in Shopify are not written back to the sheet.
- **Rate limiting** — a 100ms delay is added between rows. For large sheets (500+ products) a sync run may take several minutes.
- **New products are created as ACTIVE** — visible in Shopify Admin immediately but must be published to a sales channel separately.
- **Duplicate field mappings** — if two sheet columns are mapped to the same Shopify field, the last one wins (deduplicated on save).
- **Tab name is case-sensitive** — must match the sheet tab exactly. Default is "Sheet1".
