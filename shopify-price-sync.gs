// ============================================================
// Shopify Price Sync — Google Apps Script
// Paste this into your sheet's Script Editor:
//   Extensions → Apps Script → paste → Save → Run setupTriggers
// ============================================================

// ── CONFIG — fill these in ───────────────────────────────────
const SHOP_DOMAIN      = "wood-123252.myshopify.com";
const ACCESS_TOKEN     = "";   // ← paste your Admin API token here
const PRICE_SHEET      = "Prices";   // name of the pricing tab (created below)
const SPREADSHEET_ID   = "15Pnf9k6uNhNikz-XuSljv5JFPv1ZNNOuViX1m9UF0oA";
const PRODUCTS_SHEET   = "products_export 6";  // tab with all product/variant data
// ──────────────────────────────────────────────────────────────

// Column indices in the Prices sheet (1-based)
const COL_SKU             = 1;   // A — Variant SKU
const COL_PRICE           = 2;   // B — Price (put your formulas here)
const COL_COMPARE_AT      = 3;   // C — Compare At Price (optional)
const COL_LAST_SYNCED     = 4;   // D — Last synced timestamp (auto-filled)
const COL_STATUS          = 5;   // E — Status (OK / Error / Pending)

// ── SETUP ─────────────────────────────────────────────────────

/**
 * Run this ONCE to:
 *  1. Create the Prices sheet with headers
 *  2. Install the on-edit trigger
 *  3. Add the "Shopify Sync" menu
 */
function setupTriggers() {
  createPricesSheet_();
  installOnEditTrigger_();
  Logger.log("Setup complete! Prices sheet created and on-edit trigger installed.");
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("🛍 Shopify Sync")
    .addItem("Import SKUs from Products sheet", "importSkusFromProducts")
    .addSeparator()
    .addItem("Sync All Prices Now", "syncAllPrices")
    .addItem("Sync Selected Rows", "syncSelectedRows")
    .addSeparator()
    .addItem("Setup / Reset", "setupTriggers")
    .addToUi();
}

/**
 * Reads all SKUs + current prices from the products sheet and
 * populates the Prices tab. Skips rows with no SKU.
 * Existing rows in Prices are preserved (won't overwrite).
 */
function importSkusFromProducts() {
  const ss = getSpreadsheet_();
  const srcSheet = ss.getSheetByName(PRODUCTS_SHEET);
  if (!srcSheet) {
    Logger.log("Products sheet '" + PRODUCTS_SHEET + "' not found.");
    try { SpreadsheetApp.getUi().alert("Products sheet '" + PRODUCTS_SHEET + "' not found."); } catch(e) {}
    return;
  }

  const priceSheet = ss.getSheetByName(PRICE_SHEET) || createPricesSheet_();

  // Find column indices in the products sheet header row
  const headers = srcSheet.getRange(1, 1, 1, srcSheet.getLastColumn()).getValues()[0];
  const skuCol   = headers.indexOf("Variant SKU");
  const priceCol = headers.indexOf("Variant Price");

  if (skuCol === -1) {
    Logger.log("Could not find 'Variant SKU' column in products sheet.");
    try { SpreadsheetApp.getUi().alert("Could not find 'Variant SKU' column."); } catch(e) {}
    return;
  }

  // Get all data rows from products sheet
  const data = srcSheet.getRange(2, 1, srcSheet.getLastRow() - 1, srcSheet.getLastColumn()).getValues();

  // Build set of SKUs already in Prices sheet to avoid duplicates
  const existingSkus = new Set();
  const priceLastRow = priceSheet.getLastRow();
  if (priceLastRow > 1) {
    const existing = priceSheet.getRange(2, COL_SKU, priceLastRow - 1, 1).getValues();
    existing.forEach(r => { if (r[0]) existingSkus.add(String(r[0]).trim()); });
  }

  // Collect new rows to add
  const newRows = [];
  data.forEach(row => {
    const sku = String(row[skuCol] ?? "").trim();
    if (!sku || existingSkus.has(sku)) return;
    const price = priceCol !== -1 ? (row[priceCol] ?? "") : "";
    newRows.push([sku, price, "", "", "Pending"]);
    existingSkus.add(sku);
  });

  if (newRows.length === 0) {
    Logger.log("No new SKUs to import.");
    try { SpreadsheetApp.getUi().alert("No new SKUs to import — all SKUs already exist in the Prices sheet."); } catch(e) {}
    return;
  }

  // Append to Prices sheet
  const startRow = priceSheet.getLastRow() + 1;
  priceSheet.getRange(startRow, 1, newRows.length, 5).setValues(newRows);
  SpreadsheetApp.flush();

  Logger.log("Imported " + newRows.length + " SKUs into the Prices sheet.");
  try { SpreadsheetApp.getUi().alert("✅ Imported " + newRows.length + " SKUs into the Prices sheet.\n\nNow add your price formulas in column B."); } catch(e) {}
}

// ── SHEET CREATION ────────────────────────────────────────────

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function createPricesSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(PRICE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PRICE_SHEET);
  }

  // Write headers if the sheet is empty
  if (sheet.getLastRow() === 0) {
    const headers = ["SKU", "Price", "Compare At Price", "Last Synced", "Status"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight("bold")
      .setBackground("#f3f3f3");
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL_SKU, 180);
    sheet.setColumnWidth(COL_PRICE, 100);
    sheet.setColumnWidth(COL_COMPARE_AT, 130);
    sheet.setColumnWidth(COL_LAST_SYNCED, 160);
    sheet.setColumnWidth(COL_STATUS, 120);
    SpreadsheetApp.flush();
  }
  return sheet;
}

// ── TRIGGER INSTALLATION ──────────────────────────────────────

function installOnEditTrigger_() {
  const ss = getSpreadsheet_();
  // Remove existing onEdit triggers for this script to avoid duplicates
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "onEditTrigger")
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger("onEditTrigger")
    .forSpreadsheet(ss)
    .onEdit()
    .create();
}

// ── ON-EDIT TRIGGER ───────────────────────────────────────────

/**
 * Fires on any edit. Only acts on the Prices sheet, columns B or C (Price / Compare At).
 */
function onEditTrigger(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== PRICE_SHEET) return;

  const col = e.range.getColumn();
  if (col !== COL_PRICE && col !== COL_COMPARE_AT) return;

  const row = e.range.getRow();
  if (row <= 1) return; // skip header

  syncRow_(sheet, row);
}

// ── SYNC ALL ──────────────────────────────────────────────────

function syncAllPrices() {
  if (!checkConfig_()) return;
  const sheet = getSpreadsheet_().getSheetByName(PRICE_SHEET);
  if (!sheet) { Logger.log("No 'Prices' sheet found. Run Setup first."); return; }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log("No data rows found in the Prices sheet."); return; }

  let updated = 0, skipped = 0, errors = 0;

  for (let row = 2; row <= lastRow; row++) {
    const result = syncRow_(sheet, row);
    if (result === "ok") updated++;
    else if (result === "skip") skipped++;
    else errors++;
  }

  Logger.log(`Sync complete! Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  try {
    SpreadsheetApp.getUi().alert(
      `Sync complete!\n\n✅ Updated: ${updated}\n⏭ Skipped: ${skipped}\n❌ Errors: ${errors}`
    );
  } catch(e) { /* running from editor, no UI available */ }
}

// ── SYNC SELECTED ROWS ────────────────────────────────────────

function syncSelectedRows() {
  if (!checkConfig_()) return;
  const sheet = getSpreadsheet_().getActiveSheet();
  if (sheet.getName() !== PRICE_SHEET) {
    alert_("Please select rows in the Prices sheet first.");
    return;
  }
  const selection = sheet.getActiveRange();
  if (!selection) { Logger.log("No rows selected."); return; }

  const startRow = Math.max(selection.getRow(), 2);
  const endRow   = selection.getLastRow();
  let updated = 0, skipped = 0, errors = 0;

  for (let row = startRow; row <= endRow; row++) {
    const result = syncRow_(sheet, row);
    if (result === "ok") updated++;
    else if (result === "skip") skipped++;
    else errors++;
  }

  Logger.log(`Sync complete! Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors}`);
  try {
    SpreadsheetApp.getUi().alert(
      `Sync complete!\n\n✅ Updated: ${updated}\n⏭ Skipped: ${skipped}\n❌ Errors: ${errors}`
    );
  } catch(e) { /* running from editor */ }
}

// ── CORE SYNC ROW ─────────────────────────────────────────────

/**
 * Syncs a single row. Returns "ok", "skip", or "error".
 */
function syncRow_(sheet, row) {
  const values = sheet.getRange(row, 1, 1, 3).getValues()[0];
  const sku         = String(values[COL_SKU - 1] ?? "").trim();
  const priceRaw    = values[COL_PRICE - 1];
  const compareRaw  = values[COL_COMPARE_AT - 1];

  if (!sku) return "skip";

  const price = parsePrice_(priceRaw);
  if (price === null) return "skip"; // no price set

  const compareAtPrice = parsePrice_(compareRaw); // null = don't change

  // Look up the variant by SKU
  const variantInfo = findVariantBySku_(sku);
  if (!variantInfo) {
    setStatus_(sheet, row, "❌ SKU not found");
    return "error";
  }

  // Update via GraphQL
  const result = updateVariantPrice_(
    variantInfo.productId,
    variantInfo.variantId,
    price,
    compareAtPrice
  );

  if (result.success) {
    setStatus_(sheet, row, "✅ OK");
    sheet.getRange(row, COL_LAST_SYNCED).setValue(new Date());
    return "ok";
  } else {
    setStatus_(sheet, row, "❌ " + result.error.substring(0, 50));
    return "error";
  }
}

// ── SHOPIFY API ───────────────────────────────────────────────

function findVariantBySku_(sku) {
  const query = `{
    productVariants(first: 1, query: "sku:\\"${sku.replace(/"/g, '\\"')}\\"") {
      edges {
        node {
          id
          product { id }
        }
      }
    }
  }`;

  const response = shopifyGraphQL_(query);
  const edge = response?.data?.productVariants?.edges?.[0];
  if (!edge) return null;

  return {
    variantId: edge.node.id,
    productId: edge.node.product.id,
  };
}

function updateVariantPrice_(productId, variantId, price, compareAtPrice) {
  const variantInput = { id: variantId, price: String(price) };
  if (compareAtPrice !== null) {
    variantInput.compareAtPrice = compareAtPrice === 0 ? null : String(compareAtPrice);
  }

  const mutation = `
    mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        userErrors { field message }
      }
    }
  `;

  const response = shopifyGraphQL_(mutation, {
    productId,
    variants: [variantInput],
  });

  const errors = response?.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length > 0) {
    return { success: false, error: errors.map(e => e.message).join("; ") };
  }
  return { success: true };
}

function shopifyGraphQL_(query, variables) {
  const url = `https://${SHOP_DOMAIN}/admin/api/2025-01/graphql.json`;
  const payload = JSON.stringify({ query, variables: variables || {} });

  const options = {
    method: "POST",
    contentType: "application/json",
    headers: {
      "X-Shopify-Access-Token": ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    payload,
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();

  if (code !== 200) {
    throw new Error(`Shopify API error ${code}: ${response.getContentText().substring(0, 200)}`);
  }

  return JSON.parse(response.getContentText());
}

// ── HELPERS ───────────────────────────────────────────────────

function parsePrice_(val) {
  if (val === "" || val === null || val === undefined) return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function setStatus_(sheet, row, status) {
  sheet.getRange(row, COL_STATUS).setValue(status);
}

function checkConfig_() {
  if (!ACCESS_TOKEN || ACCESS_TOKEN === "") {
    Logger.log("ACCESS_TOKEN is not set. Paste your Shopify Admin API token into the script.");
    try { SpreadsheetApp.getUi().alert("ACCESS_TOKEN is not set.\n\nGo to Extensions → Apps Script and paste your Shopify Admin API token."); } catch(e) {}
    return false;
  }
  return true;
}
