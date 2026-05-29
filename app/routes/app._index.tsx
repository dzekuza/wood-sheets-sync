import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Banner,
  BlockStack,
  InlineStack,
  IndexTable,
  Badge,
  Thumbnail,
  Tooltip,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runSync } from "../lib/shopify-sync.server";
import { listProducts } from "../lib/shopify-graphql.server";
import { fetchSheetRows } from "../lib/google-sheets.server";
import { cancelRunningSyncLogs } from "../lib/sync-logger.server";
import type { SyncLog } from "../lib/sync-logger.server";

// ── Types ─────────────────────────────────────────────────────────────────────

type ProductRow = {
  id: string;
  title: string;
  handle: string;
  sku: string;
  price: string;
  status: string;
  image: string | null;
  synced: boolean;
  identifier: string;
};

type SyncResultRow = {
  productId: string;
  productTitle: string;
  status: string;
  syncedFields: string[];
  errorMessage: string | null;
};

type LoaderData = {
  shop: string;
  config: {
    id: string;
    sheetUrl: string;
    sheetName: string;
    skuColumn: string | null;
    matchField: string;
    mappingsCount: number;
    mappedFields: string[];
  } | null;
  lastLog: SyncLog | null;
  products: ProductRow[];
  lastSyncResults: SyncResultRow[];
  sheetError: string | null;
};

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, lastLog] = await Promise.all([
    prisma.sheetConfig.findFirst({ where: { shop }, include: { mappings: true } }),
    prisma.syncLog.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } }),
  ]);

  // Fetch per-product results from last sync
  let lastSyncResults: SyncResultRow[] = [];
  if (lastLog) {
    const raw = await prisma.syncProductResult.findMany({
      where: { syncLogId: lastLog.id },
    });
    lastSyncResults = raw.map((r) => ({
      productId: r.productId,
      productTitle: r.productTitle,
      status: r.status,
      syncedFields: r.syncedFields ? (JSON.parse(r.syncedFields) as string[]) : [],
      errorMessage: r.errorMessage,
    }));
  }

  const shopifyProducts = await listProducts(admin, 100);

  if (!config) {
    return json<LoaderData>({
      shop,
      config: null,
      lastLog,
      lastSyncResults,
      sheetError: null,
      products: shopifyProducts.map((p) => ({ ...p, synced: false, identifier: "" })),
    });
  }

  let sheetIdentifiers = new Set<string>();
  let sheetError: string | null = null;
  const matchField = config.matchField ?? "sku";

  try {
    const rows = await fetchSheetRows(config.spreadsheetId, config.sheetName);
    if (rows.length >= 2 && config.skuColumn) {
      const headers = rows[0];
      const colIndex = headers.indexOf(config.skuColumn);
      if (colIndex !== -1) {
        for (const row of rows.slice(1)) {
          const val = row[colIndex]?.trim();
          if (val) sheetIdentifiers.add(val.toLowerCase());
        }
      }
    }
  } catch (err) {
    sheetError = err instanceof Error ? err.message : "Could not load sheet data.";
  }

  const products: ProductRow[] = shopifyProducts.map((p) => {
    let identifier = "";
    let synced = false;
    if (matchField === "title") {
      identifier = p.title;
      synced = sheetIdentifiers.has(p.title.toLowerCase());
    } else if (matchField === "handle") {
      identifier = p.handle;
      synced = sheetIdentifiers.has(p.handle.toLowerCase());
    } else {
      identifier = p.sku;
      synced = Boolean(p.sku) && sheetIdentifiers.has(p.sku.toLowerCase());
    }
    return { ...p, identifier, synced };
  });

  // Deduplicate mapped fields, exclude identifier fields from column list
  const skipInTable = new Set(["title", "body_html", "sku", "barcode", "status"]);
  const mappedFields = config.mappings
    .map((m) => m.shopifyField)
    .filter((f) => !skipInTable.has(f));

  return json<LoaderData>({
    shop,
    config: {
      id: config.id,
      sheetUrl: config.sheetUrl,
      sheetName: config.sheetName,
      skuColumn: config.skuColumn,
      matchField,
      mappingsCount: config.mappings.length,
      mappedFields,
    },
    lastLog,
    lastSyncResults,
    products,
    sheetError,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "cancel") {
    await prisma.syncCancel.upsert({
      where: { shop },
      create: { shop },
      update: { createdAt: new Date() },
    });
    const stoppedLogs = await cancelRunningSyncLogs(shop);
    return json({ cancelled: true, stoppedLogs });
  }

  const result = await runSync(shop, "manual", admin);
  return json(result);
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminProductUrl(shop: string, gid: string): string {
  const storeHandle = shop.replace(".myshopify.com", "");
  const numericId = gid.split("/").pop() ?? "";
  return `https://admin.shopify.com/store/${storeHandle}/products/${numericId}`;
}

const MATCH_FIELD_LABEL: Record<string, string> = {
  sku: "SKU",
  title: "Title",
  handle: "Handle",
};

const FIELD_LABEL: Record<string, string> = {
  price: "Price",
  compare_at_price: "Compare price",
  vendor: "Vendor",
  product_type: "Type",
  tags: "Tags",
  images: "Images",
  image_1: "Image 1",
  option1_name: "Option 1",
  option1_values: "Option 1 values",
  option2_name: "Option 2",
  option2_values: "Option 2 values",
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function Index() {
  const { shop, config, lastLog, products, lastSyncResults, sheetError } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const cancelFetcher = useFetcher<{ cancelled?: boolean; stoppedLogs?: number }>();
  const isSyncing = fetcher.state !== "idle" && fetcher.formMethod === "POST";
  const isCancelling = cancelFetcher.state !== "idle";
  const syncResult = fetcher.data;
  const cancelResult = cancelFetcher.data;
  const isRunning = lastLog?.status === "running" || isSyncing;

  const syncedCount = products.filter((p) => p.synced).length;
  const matchLabel = config ? (MATCH_FIELD_LABEL[config.matchField] ?? "SKU") : "SKU";

  // Build a quick-lookup: productId → syncResult
  const resultsByProductId = new Map(lastSyncResults.map((r) => [r.productId, r]));

  // Mapped field columns to show in the table
  const fieldCols = config?.mappedFields ?? [];

  // After a sync action, use those results; otherwise use DB results
  const showSyncBanner = syncResult || lastLog;

  return (
    <Page>
      <TitleBar title="Google Sheets Sync" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {!config && (
                <Banner
                  title="No sheet configured"
                  tone="warning"
                  action={{ content: "Go to Settings", url: "/app/settings" }}
                >
                  <Text as="p" variant="bodyMd">
                    Connect a Google Sheet to start syncing product data into
                    Shopify. Head to Settings to enter your sheet URL and map columns.
                  </Text>
                </Banner>
              )}

              {sheetError && (
                <Banner title="Could not load sheet data" tone="warning">
                  <Text as="p" variant="bodyMd">{sheetError}</Text>
                </Banner>
              )}

              {config && (
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Connected Sheet</Text>
                      <InlineStack gap="300">
                        {isRunning ? (
                          <cancelFetcher.Form method="post" action="/api/sync-cancel">
                            <input type="hidden" name="intent" value="cancel" />
                            <Button
                              variant="primary"
                              tone="critical"
                              submit
                              loading={isCancelling}
                            >
                              Stop Sync
                            </Button>
                          </cancelFetcher.Form>
                        ) : (
                          <fetcher.Form method="post">
                            <Button variant="primary" submit loading={isSyncing}>
                              Sync Now
                            </Button>
                          </fetcher.Form>
                        )}
                        <Button variant="plain" onClick={() => navigate("/app/settings")}>
                          Edit settings
                        </Button>
                      </InlineStack>
                    </InlineStack>

                    <BlockStack gap="100">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">Sheet URL:</Text>
                        <Text as="span" variant="bodyMd" tone="subdued" breakWord>
                          {config.sheetUrl}
                        </Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">Tab:</Text>
                        <Text as="span" variant="bodyMd">{config.sheetName}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">Match by:</Text>
                        <Text as="span" variant="bodyMd">{matchLabel}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">Field mappings:</Text>
                        <Text as="span" variant="bodyMd">{config.mappingsCount}</Text>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">Linked products:</Text>
                        <Text as="span" variant="bodyMd">
                          {syncedCount} / {products.length}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  </BlockStack>
                </Card>
              )}

              {/* Sync result banner */}
              {syncResult && "updatedCount" in syncResult && (
                <Banner
                  title={syncResult.errorCount === 0 ? "Sync completed" : "Sync completed with errors"}
                  tone={syncResult.errorCount === 0 ? "success" : "critical"}
                >
                  <Text as="p" variant="bodyMd">
                    {syncResult.updatedCount} updated · {syncResult.skippedCount} skipped ·{" "}
                    {syncResult.errorCount} errors
                  </Text>
                </Banner>
              )}
              {cancelResult && "cancelled" in cancelResult && (
                <Banner title="Sync stopped" tone="warning">
                  <Text as="p" variant="bodyMd">Sync was stopped by user.</Text>
                </Banner>
              )}

              {lastLog && !syncResult && (
                <Banner
                  title={
                    lastLog.status === "success" ? "Last sync succeeded"
                    : lastLog.status === "running" ? "Sync in progress — click Stop Sync to cancel"
                    : "Last sync had errors"
                  }
                  tone={
                    lastLog.status === "success" ? "success"
                    : lastLog.status === "running" ? "info"
                    : "critical"
                  }
                >
                  <BlockStack gap="100">
                    {lastLog.status !== "running" && (
                      <Text as="p" variant="bodyMd">
                        {lastLog.updatedCount} updated · {lastLog.skippedCount} skipped ·{" "}
                        {lastLog.errorCount} errors
                      </Text>
                    )}
                    {lastLog.completedAt && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Completed: {new Date(lastLog.completedAt).toLocaleString()}
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}

              {/* Products table with per-field sync highlights */}
              <Card padding="0">
                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={products.length}
                  headings={[
                    { title: "" },
                    { title: "Product" },
                    { title: "Status" },
                    { title: matchLabel },
                    { title: "Price" },
                    ...fieldCols
                      .filter((f) => f !== "price")
                      .map((f) => ({ title: FIELD_LABEL[f] ?? f })),
                    { title: "Last sync" },
                  ]}
                  selectable={false}
                >
                  {products.map((product, index) => {
                    const result = resultsByProductId.get(product.id);
                    const synced = result?.status === "updated";
                    const hasError = result?.status === "error";
                    const updatedFields = new Set(result?.syncedFields ?? []);

                    return (
                      <IndexTable.Row
                        id={product.id}
                        key={product.id}
                        position={index}
                        onClick={() => window.open(adminProductUrl(shop, product.id), "_top")}
                      >
                        {/* Thumbnail */}
                        <IndexTable.Cell>
                          <Thumbnail
                            source={product.image ?? ""}
                            alt={product.title}
                            size="small"
                          />
                        </IndexTable.Cell>

                        {/* Product title + handle */}
                        <IndexTable.Cell>
                          <div style={{ maxWidth: 280, overflow: "hidden" }}>
                            <Text as="p" variant="bodyMd" fontWeight="semibold" truncate>
                              {product.title}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued" truncate>
                              {product.handle}
                            </Text>
                          </div>
                        </IndexTable.Cell>

                        {/* Active/Draft/Archived */}
                        <IndexTable.Cell>
                          <Badge
                            tone={
                              product.status === "ACTIVE" ? "success"
                              : product.status === "DRAFT" ? "info"
                              : "critical"
                            }
                          >
                            {product.status === "ACTIVE" ? "Active"
                              : product.status === "DRAFT" ? "Draft"
                              : "Archived"}
                          </Badge>
                        </IndexTable.Cell>

                        {/* Identifier (SKU / title / handle) */}
                        <IndexTable.Cell>
                          <Text as="span" variant="bodyMd" tone="subdued">
                            {product.identifier || "—"}
                          </Text>
                        </IndexTable.Cell>

                        {/* Price — highlight if synced */}
                        <IndexTable.Cell>
                          <SyncedCell
                            value={product.price ? `£${product.price}` : "—"}
                            updated={updatedFields.has("price")}
                          />
                        </IndexTable.Cell>

                        {/* Dynamic field columns */}
                        {fieldCols
                          .filter((f) => f !== "price")
                          .map((field) => (
                            <IndexTable.Cell key={field}>
                              <SyncedCell
                                value={fieldValueLabel(field)}
                                updated={updatedFields.has(field)}
                              />
                            </IndexTable.Cell>
                          ))}

                        {/* Last sync status */}
                        <IndexTable.Cell>
                          {hasError ? (
                            <Tooltip content={result?.errorMessage ?? "Error during sync"}>
                              <Badge tone="critical">Error</Badge>
                            </Tooltip>
                          ) : synced ? (
                            <Badge tone="success">Updated</Badge>
                          ) : product.synced ? (
                            <Badge tone="attention">In sheet</Badge>
                          ) : (
                            <Tooltip content="This product was not found in the sheet.">
                              <Badge>Shopify only</Badge>
                            </Tooltip>
                          )}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );
                  })}
                </IndexTable>
              </Card>

              {/* Legend */}
              {showSyncBanner && lastSyncResults.length > 0 && (
                <InlineStack gap="300" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">Legend:</Text>
                  <InlineStack gap="100" blockAlign="center">
                    <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#1a9c3e" }} />
                    <Text as="span" variant="bodySm" tone="subdued">Updated in last sync</Text>
                  </InlineStack>
                  <InlineStack gap="100" blockAlign="center">
                    <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#e0e0e0" }} />
                    <Text as="span" variant="bodySm" tone="subdued">Not changed</Text>
                  </InlineStack>
                </InlineStack>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SyncedCell({ value, updated }: { value: string; updated: boolean }) {
  if (!updated) {
    return (
      <Text as="span" variant="bodyMd" tone="subdued">
        {value}
      </Text>
    );
  }
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: "#d4f7e0",
        borderRadius: 4,
        padding: "2px 6px",
        fontWeight: 600,
        color: "#0a5c2a",
        fontSize: 13,
      }}
    >
      ↑ {value}
    </span>
  );
}

function fieldValueLabel(field: string): string {
  // For non-value fields (options, images), just show a check mark placeholder
  if (field.startsWith("option") || field === "images" || field.startsWith("image_")) {
    return "✓";
  }
  return "—";
}
