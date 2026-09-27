// ============================================================================
// Sheets -> Shopify product sync, run manually from a spreadsheet menu.
//
// Setup (one-time):
//   1. In your app's Dev Dashboard (dev.shopify.com/dashboard) -> Settings ->
//      copy the Client ID and Client secret. Confirm write_products is in the
//      app version's Admin API scopes.
//      Requires the app and the target store to be in the same Shopify
//      organization (client credentials grant only works within one org) --
//      if calls fail with "shop_not_permitted", use a store-level Custom App
//      admin token instead (Settings > Apps > Develop apps in the store admin).
//   2. In this script: Project Settings (gear icon) -> Script Properties -> Add:
//        SHOPIFY_SHOP            = your-store.myshopify.com
//        SHOPIFY_CLIENT_ID       = from the Dev Dashboard
//        SHOPIFY_CLIENT_SECRET   = from the Dev Dashboard
//   3. Reload the spreadsheet. A "Shopify Sync" menu appears.
//      Run "Test connection" first, then "Sync ... to Shopify".
//
// No OAuth redirect, no server, no merchant install screen: the script
// exchanges the client ID/secret for a short-lived (24h) access token itself
// on every run, via the client credentials grant.
//
// Row shape expected (standard Shopify product-export CSV columns). A row
// with no Handle is skipped. Rows sharing a Handle are one product; each
// row can contribute a variant combo (if it has Option values), an image
// (if it has Image Src), or just product-level fields on the first row.
// ============================================================================

const SHEET_NAME = "products_export_1 (2)";
const API_VERSION = "2026-07";

const COL = {
  HANDLE: "Handle",
  TITLE: "Title",
  BODY_HTML: "Body (HTML)",
  VENDOR: "Vendor",
  TYPE: "Type",
  TAGS: "Tags",
  STATUS: "Status",
  OPTION1_NAME: "Option1 Name",
  OPTION1_VALUE: "Option1 Value",
  OPTION2_NAME: "Option2 Name",
  OPTION2_VALUE: "Option2 Value",
  OPTION3_NAME: "Option3 Name",
  OPTION3_VALUE: "Option3 Value",
  SKU: "Variant SKU",
  PRICE: "Variant Price",
  COMPARE_AT: "Variant Compare At Price",
  BARCODE: "Variant Barcodes",
  IMAGE_SRC: "Image Src",
  IMAGE_POSITION: "Image Position",
};

// ── Menu ─────────────────────────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Shopify Sync")
    .addItem('Sync "' + SHEET_NAME + '" to Shopify', "syncToShopify")
    .addItem("Test connection", "testConnection")
    .addToUi();
}

function testConnection() {
  const ui = SpreadsheetApp.getUi();
  try {
    const data = shopifyGraphQL_(
      "#graphql\nquery { shop { name myshopifyDomain } }",
      {}
    );
    ui.alert(
      "Connected",
      "Shop: " + data.shop.name + " (" + data.shop.myshopifyDomain + ")",
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert("Connection failed", e.message, ui.ButtonSet.OK);
  }
}

function syncToShopify() {
  const ui = SpreadsheetApp.getUi();

  let config;
  try {
    config = getConfig_();
  } catch (e) {
    ui.alert("Setup needed", e.message, ui.ButtonSet.OK);
    return;
  }

  const { idx, rows } = readRows_();
  const groups = groupByHandle_(idx, rows);

  if (!groups.length) {
    ui.alert(
      'Nothing to sync — no rows with a Handle found in "' + SHEET_NAME + '".'
    );
    return;
  }

  const confirm = ui.alert(
    "Sync to Shopify",
    "About to sync " +
      groups.length +
      ' product(s) from "' +
      SHEET_NAME +
      '" to ' +
      config.shop +
      ". This creates/updates live products. Continue?",
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const log = [];
  groups.forEach((g) => {
    try {
      syncProduct_(g, log);
    } catch (e) {
      log.push([g.handle, "error", e.message]);
    }
    Utilities.sleep(300);
  });

  writeLog_(log);

  const errorCount = log.filter((r) => r[1] === "error").length;
  ui.alert(
    "Sync complete",
    log.length +
      " product(s) processed, " +
      errorCount +
      ' error(s). See the "Sync Log" tab for details.',
    ui.ButtonSet.OK
  );
}

// ── Config / transport ──────────────────────────────────────────────────

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const shop = props.getProperty("SHOPIFY_SHOP");
  const clientId = props.getProperty("SHOPIFY_CLIENT_ID");
  const clientSecret = props.getProperty("SHOPIFY_CLIENT_SECRET");
  if (!shop || !clientId || !clientSecret) {
    throw new Error(
      "Missing config. Open Extensions > Apps Script > Project Settings > " +
        'Script Properties and add SHOPIFY_SHOP (e.g. "your-store.myshopify.com"), ' +
        "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (from your app's Dev Dashboard " +
        "Settings page)."
    );
  }
  return { shop, clientId, clientSecret };
}

// Exchanges the app's client ID/secret for a short-lived access token via the
// client credentials grant (works only when the app and the store are in the
// same Shopify organization) — no merchant install, no redirect. Cached for
// most of its ~24h lifetime so repeated calls in one run don't refetch it.
function getAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get("SHOPIFY_TOKEN");
  if (cached) return cached;

  const { shop, clientId, clientSecret } = getConfig_();
  const url = "https://" + shop + "/admin/oauth/access_token";
  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    },
    muteHttpExceptions: true,
  });

  const body = JSON.parse(response.getContentText());
  if (!body.access_token) {
    throw new Error(
      "Failed to get access token: " +
        response.getContentText() +
        '. If this says "shop_not_permitted", the app and this store are not ' +
        "in the same Shopify organization — use a store-level Custom App " +
        "admin token instead (see the setup comment at the top of this file)."
    );
  }

  const ttl = Math.min(Math.max(60, (body.expires_in || 3600) - 60), 21600);
  cache.put("SHOPIFY_TOKEN", body.access_token, ttl);
  return body.access_token;
}

function shopifyGraphQL_(query, variables) {
  const { shop } = getConfig_();
  const url =
    "https://" + shop + "/admin/api/" + API_VERSION + "/graphql.json";

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      headers: { "X-Shopify-Access-Token": getAccessToken_() },
      payload: JSON.stringify({ query, variables }),
      muteHttpExceptions: true,
    });
    const body = JSON.parse(response.getContentText());

    const throttled =
      body.errors &&
      body.errors.some(
        (e) => e.extensions && e.extensions.code === "THROTTLED"
      );
    if (throttled && attempt < 2) {
      Utilities.sleep(1500 * (attempt + 1));
      continue;
    }
    if (body.errors) {
      throw new Error("GraphQL error: " + JSON.stringify(body.errors));
    }
    return body.data;
  }
}

function checkErrors_(errors, label) {
  if (errors && errors.length) {
    throw new Error("[" + label + "] " + errors.map((e) => e.message).join("; "));
  }
}

// ── Reading + grouping sheet rows ───────────────────────────────────────

function readRows_() {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Tab "' + SHEET_NAME + '" not found.');
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));
  return { idx, rows: values.slice(1) };
}

function cell_(row, idx, colName) {
  const i = idx[colName];
  if (i === undefined) return "";
  const v = row[i];
  return v === null || v === undefined ? "" : String(v).trim();
}

// One entry per distinct Handle, built up from every row that shares it.
function groupByHandle_(idx, rows) {
  const groups = {};
  const order = [];

  rows.forEach((row) => {
    const handle = cell_(row, idx, COL.HANDLE);
    if (!handle) return; // no Handle -> can't tell which product this row belongs to

    if (!groups[handle]) {
      groups[handle] = {
        handle,
        title: "",
        bodyHtml: "",
        vendor: "",
        productType: "",
        tags: "",
        status: "",
        option1Name: "",
        option2Name: "",
        option3Name: "",
        optionValues: [[], [], []],
        images: [],
        variants: [],
      };
      order.push(handle);
    }
    const g = groups[handle];

    if (!g.title) g.title = cell_(row, idx, COL.TITLE);
    if (!g.bodyHtml) g.bodyHtml = cell_(row, idx, COL.BODY_HTML);
    if (!g.vendor) g.vendor = cell_(row, idx, COL.VENDOR);
    if (!g.productType) g.productType = cell_(row, idx, COL.TYPE);
    if (!g.tags) g.tags = cell_(row, idx, COL.TAGS);
    if (!g.status) g.status = cell_(row, idx, COL.STATUS);

    const o1n = cell_(row, idx, COL.OPTION1_NAME);
    const o2n = cell_(row, idx, COL.OPTION2_NAME);
    const o3n = cell_(row, idx, COL.OPTION3_NAME);
    if (o1n) g.option1Name = o1n;
    if (o2n) g.option2Name = o2n;
    if (o3n) g.option3Name = o3n;

    const o1v = cell_(row, idx, COL.OPTION1_VALUE);
    const o2v = cell_(row, idx, COL.OPTION2_VALUE);
    const o3v = cell_(row, idx, COL.OPTION3_VALUE);

    if (o1v && g.optionValues[0].indexOf(o1v) === -1) g.optionValues[0].push(o1v);
    if (o2v && g.optionValues[1].indexOf(o2v) === -1) g.optionValues[1].push(o2v);
    if (o3v && g.optionValues[2].indexOf(o3v) === -1) g.optionValues[2].push(o3v);

    const imgSrc = cell_(row, idx, COL.IMAGE_SRC);
    if (imgSrc) {
      const posRaw = cell_(row, idx, COL.IMAGE_POSITION);
      const pos = Number(posRaw) || g.images.length + 1;
      g.images.push({ url: imgSrc, position: pos });
    }

    if (o1v || o2v || o3v) {
      g.variants.push({
        option1: o1v,
        option2: o2v,
        option3: o3v,
        sku: cell_(row, idx, COL.SKU),
        price: cell_(row, idx, COL.PRICE),
        compareAtPrice: cell_(row, idx, COL.COMPARE_AT),
        barcode: cell_(row, idx, COL.BARCODE),
      });
    }
  });

  order.forEach((h) => groups[h].images.sort((a, b) => a.position - b.position));

  return order.map((h) => groups[h]);
}

function splitTags_(raw) {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function normalizeStatus_(raw) {
  const s = (raw || "").toLowerCase();
  if (s === "draft") return "DRAFT";
  if (s === "archived") return "ARCHIVED";
  return "ACTIVE";
}

// Loose match key for option values: "Grey Oil", "grey-oil" and "grey_oil"
// all collapse to "greyoil". Sheets sometimes hold a slugified value (e.g.
// copied from an image filename) instead of the exact Shopify option label.
function normKey_(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Money columns occasionally contain stray text (a placeholder like
// "manual" left while a sheet is still being filled in). Sending that to
// productVariantsBulkCreate/Update fails the WHOLE batch, so validate first.
function isValidMoney_(s) {
  return /^\d+(\.\d{1,2})?$/.test(String(s).trim());
}

// ── GraphQL operations ───────────────────────────────────────────────────

const GQL = {
  FIND_PRODUCT_BY_HANDLE:
    "#graphql\n" +
    "query($handle: String!) {\n" +
    "  productByHandle(handle: $handle) {\n" +
    "    id\n" +
    "    options { id name values linkedMetafield { namespace key } }\n" +
    "  }\n" +
    "}",

  CREATE_PRODUCT:
    "#graphql\n" +
    "mutation($product: ProductCreateInput!) {\n" +
    "  productCreate(product: $product) {\n" +
    "    product { id }\n" +
    "    userErrors { field message }\n" +
    "  }\n" +
    "}",

  UPDATE_PRODUCT:
    "#graphql\n" +
    "mutation($input: ProductInput!) {\n" +
    "  productUpdate(input: $input) {\n" +
    "    product { id }\n" +
    "    userErrors { field message }\n" +
    "  }\n" +
    "}",

  CREATE_OPTIONS:
    "#graphql\n" +
    "mutation($productId: ID!, $options: [OptionCreateInput!]!) {\n" +
    "  productOptionsCreate(productId: $productId, options: $options) {\n" +
    "    product { id options { id name values } }\n" +
    "    userErrors { field message code }\n" +
    "  }\n" +
    "}",

  UPDATE_OPTION:
    "#graphql\n" +
    "mutation($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!], $variantStrategy: ProductOptionUpdateVariantStrategy) {\n" +
    "  productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd, variantStrategy: $variantStrategy) {\n" +
    "    product { id options { id name values } }\n" +
    "    userErrors { field message code }\n" +
    "  }\n" +
    "}",

  GET_VARIANTS:
    "#graphql\n" +
    "query($id: ID!, $cursor: String) {\n" +
    "  product(id: $id) {\n" +
    "    variants(first: 100, after: $cursor) {\n" +
    "      pageInfo { hasNextPage endCursor }\n" +
    "      edges { node { id selectedOptions { name value } } }\n" +
    "    }\n" +
    "  }\n" +
    "}",

  CREATE_VARIANTS_BULK:
    "#graphql\n" +
    "mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n" +
    "  productVariantsBulkCreate(productId: $productId, variants: $variants) {\n" +
    "    productVariants { id }\n" +
    "    userErrors { field message }\n" +
    "  }\n" +
    "}",

  UPDATE_VARIANTS_BULK:
    "#graphql\n" +
    "mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {\n" +
    "  productVariantsBulkUpdate(productId: $productId, variants: $variants) {\n" +
    "    productVariants { id }\n" +
    "    userErrors { field message }\n" +
    "  }\n" +
    "}",

  GET_IMAGES:
    "#graphql\n" +
    "query($id: ID!) {\n" +
    "  product(id: $id) {\n" +
    "    media(first: 20) {\n" +
    "      edges { node { ... on MediaImage { image { url } } } }\n" +
    "    }\n" +
    "  }\n" +
    "}",

  CREATE_MEDIA:
    "#graphql\n" +
    "mutation($media: [CreateMediaInput!]!, $productId: ID!) {\n" +
    "  productCreateMedia(media: $media, productId: $productId) {\n" +
    "    media { alt mediaContentType status }\n" +
    "    mediaUserErrors { field message }\n" +
    "  }\n" +
    "}",

  GET_COLOR_PATTERN_METAOBJECTS:
    "#graphql\n" +
    "query($cursor: String) {\n" +
    "  metaobjects(type: \"shopify--color-pattern\", first: 250, after: $cursor) {\n" +
    "    pageInfo { hasNextPage endCursor }\n" +
    "    nodes { id displayName }\n" +
    "  }\n" +
    "}",
};

// Lazily-fetched, run-scoped cache of the shared "Color" swatch library
// (metaobject type shopify--color-pattern) keyed by normKey_(label).
// A linked option (see upsertOptions_) can only add values that already
// exist in this library -- there is no display name/hex/image to invent one.
let colorPatternMetaobjectCache_ = null;

function getColorPatternMetaobjectMap_() {
  if (colorPatternMetaobjectCache_) return colorPatternMetaobjectCache_;
  const map = {};
  let cursor = null;
  do {
    const data = shopifyGraphQL_(GQL.GET_COLOR_PATTERN_METAOBJECTS, { cursor });
    data.metaobjects.nodes.forEach((n) => {
      map[normKey_(n.displayName)] = { id: n.id, label: n.displayName };
    });
    cursor = data.metaobjects.pageInfo.hasNextPage
      ? data.metaobjects.pageInfo.endCursor
      : null;
  } while (cursor);
  colorPatternMetaobjectCache_ = map;
  return map;
}

function findProductByHandle_(handle) {
  const data = shopifyGraphQL_(GQL.FIND_PRODUCT_BY_HANDLE, { handle });
  return data.productByHandle;
}

// ── Per-product sync ─────────────────────────────────────────────────────

function syncProduct_(group, log) {
  const existing = findProductByHandle_(group.handle);
  let productId;
  let existingOptions = [];

  if (!existing) {
    const input = {
      title: group.title || group.handle,
      handle: group.handle,
      status: normalizeStatus_(group.status),
    };
    if (group.bodyHtml) input.descriptionHtml = group.bodyHtml;
    if (group.vendor) input.vendor = group.vendor;
    if (group.productType) input.productType = group.productType;
    if (group.tags) input.tags = splitTags_(group.tags);

    const data = shopifyGraphQL_(GQL.CREATE_PRODUCT, { product: input });
    checkErrors_(data.productCreate.userErrors, "product create");
    productId = data.productCreate.product.id;
  } else {
    productId = existing.id;
    existingOptions = existing.options || [];

    const input = { id: productId };
    if (group.title) input.title = group.title;
    if (group.bodyHtml) input.descriptionHtml = group.bodyHtml;
    if (group.vendor) input.vendor = group.vendor;
    if (group.productType) input.productType = group.productType;
    if (group.tags) input.tags = splitTags_(group.tags);

    const data = shopifyGraphQL_(GQL.UPDATE_PRODUCT, { input });
    checkErrors_(data.productUpdate.userErrors, "product update");
  }

  const desiredOptions = [];
  if (group.option1Name && group.optionValues[0].length)
    desiredOptions.push({ name: group.option1Name, values: group.optionValues[0] });
  if (group.option2Name && group.optionValues[1].length)
    desiredOptions.push({ name: group.option2Name, values: group.optionValues[1] });
  if (group.option3Name && group.optionValues[2].length)
    desiredOptions.push({ name: group.option3Name, values: group.optionValues[2] });

  if (desiredOptions.length) {
    upsertOptions_(productId, existingOptions, desiredOptions, log);
  }

  if (group.images.length) {
    attachImages_(
      productId,
      group.images.map((i) => i.url),
      group.title || group.handle
    );
  }

  if (group.variants.length) {
    syncVariants_(productId, group, desiredOptions, existingOptions, log);
  }

  log.push([group.handle, "ok", productId]);
}

function upsertOptions_(productId, existingOptions, desiredOptions, log) {
  const existingByName = {};
  existingOptions.forEach((o) => (existingByName[o.name.toLowerCase()] = o));

  const toCreate = [];
  const toUpdate = [];

  desiredOptions.forEach((opt) => {
    const match = existingByName[opt.name.toLowerCase()];
    if (!match) {
      toCreate.push(opt);
      return;
    }
    const existingVals = new Set(match.values.map(normKey_));
    const newVals = opt.values.filter((v) => !existingVals.has(normKey_(v)));
    if (newVals.length) {
      toUpdate.push({
        id: match.id,
        name: opt.name,
        newValues: newVals,
        linkedMetafield: match.linkedMetafield,
      });
    }
  });

  if (toCreate.length) {
    const data = shopifyGraphQL_(GQL.CREATE_OPTIONS, {
      productId,
      options: toCreate.map((o) => ({
        name: o.name,
        values: o.values.map((v) => ({ name: v })),
      })),
    });
    checkErrors_(data.productOptionsCreate.userErrors, "option create");
  }

  // Adding values to an existing option is a separate argument from the
  // option itself — OptionUpdateInput (the `option` arg) only renames it.
  toUpdate.forEach((opt) => {
    const linked = opt.linkedMetafield;
    let optionValuesToAdd;

    if (linked) {
      // Linked options (e.g. "Oil Colour" -> the shared Color swatch
      // library) reject plain {name}: every value must reference an
      // existing metaobject entry via linkedMetafieldValue instead.
      const swatchMap = getColorPatternMetaobjectMap_();
      const resolved = [];
      const unresolved = [];
      opt.newValues.forEach((v) => {
        const entry = swatchMap[normKey_(v)];
        if (entry) resolved.push({ linkedMetafieldValue: entry.id });
        else unresolved.push(v);
      });
      if (unresolved.length) {
        log.push([
          opt.name,
          "warn",
          "Skipped adding " +
            unresolved.join(", ") +
            " — no matching swatch in the Color library yet. " +
            "Add it in Shopify Admin (Settings > Custom data > Color, or " +
            "via a product's option editor) first, then re-run.",
        ]);
      }
      if (!resolved.length) return;
      optionValuesToAdd = resolved;
    } else {
      optionValuesToAdd = opt.newValues.map((v) => ({ name: v }));
    }

    const data = shopifyGraphQL_(GQL.UPDATE_OPTION, {
      productId,
      option: { id: opt.id, name: opt.name },
      optionValuesToAdd,
      variantStrategy: "LEAVE_AS_IS",
    });
    checkErrors_(data.productOptionUpdate.userErrors, "option update");
  });
}

// Builds, per option slot (aligned with desiredOptions / option1-3), a
// lookup from normKey_(raw sheet value) -> the exact label Shopify already
// uses, so a slugified sheet cell ("grey-oil") resolves to the real option
// value ("Grey Oil") instead of being treated as a brand-new one.
function buildOptionValueCanonicalizers_(desiredOptions, existingOptions) {
  const existingByName = {};
  existingOptions.forEach((o) => (existingByName[o.name.toLowerCase()] = o));

  return desiredOptions.map((opt) => {
    const match = existingByName[opt.name.toLowerCase()];
    const byKey = {};
    if (match) {
      match.values.forEach((v) => {
        byKey[normKey_(v)] = v;
      });
      if (match.linkedMetafield) {
        const swatchMap = getColorPatternMetaobjectMap_();
        Object.keys(swatchMap).forEach((k) => {
          if (!byKey[k]) byKey[k] = swatchMap[k].label;
        });
      }
    }
    return function (raw) {
      if (!raw) return raw;
      return byKey[normKey_(raw)] || raw;
    };
  });
}

function fetchAllVariantEdges_(productId) {
  const edges = [];
  let cursor = null;
  do {
    const data = shopifyGraphQL_(GQL.GET_VARIANTS, { id: productId, cursor });
    edges.push(...data.product.variants.edges);
    cursor = data.product.variants.pageInfo.hasNextPage
      ? data.product.variants.pageInfo.endCursor
      : null;
  } while (cursor);
  return edges;
}

function syncVariants_(productId, group, desiredOptions, existingOptions, log) {
  const edges = fetchAllVariantEdges_(productId);
  const canonicalize = buildOptionValueCanonicalizers_(desiredOptions, existingOptions);

  function keyFromSelectedOptions(selectedOptions) {
    return desiredOptions
      .map((o) => {
        const found = selectedOptions.find(
          (s) => s.name.toLowerCase() === o.name.toLowerCase()
        );
        return normKey_(found ? found.value : "");
      })
      .join("|||");
  }

  const existingByKey = {};
  edges.forEach((e) => {
    existingByKey[keyFromSelectedOptions(e.node.selectedOptions)] = e.node.id;
  });

  function keyFromValues(values) {
    return desiredOptions.map((_, i) => normKey_(values[i] || "")).join("|||");
  }

  const toCreate = [];
  const toUpdate = [];

  group.variants.forEach((v) => {
    const values = [v.option1, v.option2, v.option3].map((raw, i) => canonicalize[i](raw));
    const key = keyFromValues(values);
    const existingId = existingByKey[key];

    const fields = {};
    if (v.sku) fields.inventoryItem = { sku: v.sku };
    if (v.price) {
      if (isValidMoney_(v.price)) {
        fields.price = v.price;
      } else {
        log.push([
          group.handle,
          "warn",
          'Skipped variant "' +
            values.filter(Boolean).join(" / ") +
            '" — invalid price "' +
            v.price +
            '" in the sheet (expected a plain number). Fix the cell and re-run.',
        ]);
        return;
      }
    }
    if (v.compareAtPrice === "" || v.compareAtPrice === "0") {
      fields.compareAtPrice = null;
    } else if (v.compareAtPrice) {
      if (isValidMoney_(v.compareAtPrice)) {
        fields.compareAtPrice = v.compareAtPrice;
      } else {
        log.push([
          group.handle,
          "warn",
          'Skipped variant "' +
            values.filter(Boolean).join(" / ") +
            '" — invalid compare-at price "' +
            v.compareAtPrice +
            '" in the sheet. Fix the cell and re-run.',
        ]);
        return;
      }
    }
    if (v.barcode) fields.barcode = v.barcode;

    if (existingId) {
      toUpdate.push(Object.assign({ id: existingId }, fields));
    } else {
      const optionValues = desiredOptions
        .map((o, i) => ({ optionName: o.name, name: values[i] }))
        .filter((ov) => ov.name);
      toCreate.push(Object.assign({ optionValues }, fields));
    }
  });

  if (toCreate.length) {
    const created = shopifyGraphQL_(GQL.CREATE_VARIANTS_BULK, { productId, variants: toCreate });
    checkErrors_(created.productVariantsBulkCreate.userErrors, "variant create");
  }
  if (toUpdate.length) {
    const updated = shopifyGraphQL_(GQL.UPDATE_VARIANTS_BULK, { productId, variants: toUpdate });
    checkErrors_(updated.productVariantsBulkUpdate.userErrors, "variant update");
  }
}

function attachImages_(productId, urls, altText) {
  const data = shopifyGraphQL_(GQL.GET_IMAGES, { id: productId });
  const existing = (data.product.media.edges || [])
    .map((e) => (e.node.image ? e.node.image.url : ""))
    .filter(Boolean);

  const toAdd = urls.filter(
    (u) => u && !existing.some((ex) => ex.indexOf(u) !== -1 || u.indexOf(ex) !== -1)
  );
  if (!toAdd.length) return;

  const media = toAdd.map((url) => ({
    originalSource: url,
    alt: altText,
    mediaContentType: "IMAGE",
  }));

  const result = shopifyGraphQL_(GQL.CREATE_MEDIA, { productId, media });
  checkErrors_(result.productCreateMedia.mediaUserErrors, "image");
}

// ── Logging ──────────────────────────────────────────────────────────────

function writeLog_(log) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("Sync Log");
  if (!sheet) sheet = ss.insertSheet("Sync Log");
  sheet.clear();
  sheet.appendRow(["Timestamp", "Handle", "Status", "Detail"]);
  const now = new Date();
  log.forEach((row) => sheet.appendRow([now, row[0], row[1], row[2]]));
}
