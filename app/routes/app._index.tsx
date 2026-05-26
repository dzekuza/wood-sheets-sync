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
import type { SyncLog } from "../lib/sync-logger.server";

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

type LoaderData = {
  shop: string;
  config: {
    id: string;
    sheetUrl: string;
    sheetName: string;
    skuColumn: string | null;
    matchField: string;
    mappingsCount: number;
  } | null;
  lastLog: SyncLog | null;
  products: ProductRow[];
  sheetError: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [config, lastLog] = await Promise.all([
    prisma.sheetConfig.findFirst({ where: { shop }, include: { mappings: true } }),
    prisma.syncLog.findFirst({ where: { shop }, orderBy: { startedAt: "desc" } }),
  ]);

  // Fetch Shopify products
  const shopifyProducts = await listProducts(admin, 100);

  // If no config, all products are "shopify only"
  if (!config) {
    return json<LoaderData>({
      shop,
      config: null,
      lastLog,
      sheetError: null,
      products: shopifyProducts.map((p) => ({
        ...p,
        synced: false,
        identifier: "",
      })),
    });
  }

  // Fetch sheet rows and build identifier set
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

  return json<LoaderData>({
    shop,
    config: {
      id: config.id,
      sheetUrl: config.sheetUrl,
      sheetName: config.sheetName,
      skuColumn: config.skuColumn,
      matchField,
      mappingsCount: config.mappings.length,
    },
    lastLog,
    products,
    sheetError,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const result = await runSync(session.shop, "manual", admin);
  return json(result);
};

const MATCH_FIELD_LABEL: Record<string, string> = {
  sku: "SKU",
  title: "Title",
  handle: "Handle",
};

export default function Index() {
  const { config, lastLog, products, sheetError } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const isSyncing = fetcher.state !== "idle" && fetcher.formMethod === "POST";
  const syncResult = fetcher.data;

  const syncedCount = products.filter((p) => p.synced).length;
  const matchLabel = config ? (MATCH_FIELD_LABEL[config.matchField] ?? "SKU") : "SKU";

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
                    Shopify. Head to Settings to enter your sheet URL and map
                    columns.
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
                        <fetcher.Form method="post">
                          <Button variant="primary" submit loading={isSyncing}>
                            Sync Now
                          </Button>
                        </fetcher.Form>
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

              {syncResult && (
                <Banner
                  title={syncResult.errorCount === 0 ? "Sync completed" : "Sync completed with errors"}
                  tone={syncResult.errorCount === 0 ? "success" : "critical"}
                >
                  <Text as="p" variant="bodyMd">
                    {syncResult.updatedCount} updated, {syncResult.skippedCount} skipped,{" "}
                    {syncResult.errorCount} errors.
                  </Text>
                </Banner>
              )}

              {lastLog && !syncResult && (
                <Banner
                  title={
                    lastLog.status === "success"
                      ? "Last sync succeeded"
                      : lastLog.status === "running"
                      ? "Sync in progress"
                      : "Last sync had errors"
                  }
                  tone={
                    lastLog.status === "success"
                      ? "success"
                      : lastLog.status === "running"
                      ? "info"
                      : "critical"
                  }
                >
                  <BlockStack gap="100">
                    {lastLog.status !== "running" && (
                      <Text as="p" variant="bodyMd">
                        {lastLog.updatedCount} updated, {lastLog.skippedCount} skipped,{" "}
                        {lastLog.errorCount} errors.
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
                    { title: "Sheet sync" },
                  ]}
                  selectable={false}
                >
                  {products.map((product, index) => (
                    <IndexTable.Row
                      id={product.id}
                      key={product.id}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <Thumbnail
                          source={product.image ?? ""}
                          alt={product.title}
                          size="small"
                        />
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            {product.title}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {product.handle}
                          </Text>
                        </BlockStack>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Badge
                          tone={
                            product.status === "ACTIVE"
                              ? "success"
                              : product.status === "DRAFT"
                              ? "info"
                              : "critical"
                          }
                        >
                          {product.status === "ACTIVE"
                            ? "Active"
                            : product.status === "DRAFT"
                            ? "Draft"
                            : "Archived"}
                        </Badge>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd" tone="subdued">
                          {product.identifier || "—"}
                        </Text>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">
                          {product.price ? `$${product.price}` : "—"}
                        </Text>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        {product.synced ? (
                          <Badge tone="success">Synced</Badge>
                        ) : (
                          <Tooltip content="This product's identifier was not found in the sheet. It will be updated from Shopify only.">
                            <Badge tone="attention">Shopify only</Badge>
                          </Tooltip>
                        )}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
