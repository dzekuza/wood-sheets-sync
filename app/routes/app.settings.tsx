import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Button,
  Select,
  BlockStack,
  InlineStack,
  Banner,
  Divider,
  Checkbox,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { extractSpreadsheetId, SHOPIFY_FIELDS } from "../lib/validators";

type FieldMapping = {
  sheetColumn: string;
  shopifyField: string;
};

type LoaderData = {
  config: {
    sheetUrl: string;
    sheetName: string;
    skuColumn: string | null;
    matchField: string;
    updateOnly: boolean;
    mappings: FieldMapping[];
  } | null;
};

// ── Auto-detect Shopify field from column name ────────────────────────────────

const COLUMN_ALIASES: Record<string, string> = {
  description: "body_html",
  "body html": "body_html",
  "product description": "body_html",
  "compare at price": "compare_at_price",
  "compare_at_price": "compare_at_price",
  "product type": "product_type",
  "product_type": "product_type",
  "image url": "images",
  "image urls": "images",
  "image src": "images",
  "image srcs": "images",
};

function autoDetectMapping(col: string): string {
  const normalized = col.toLowerCase().trim();
  for (const field of SHOPIFY_FIELDS) {
    if (normalized === field.value) return field.value;
  }
  return COLUMN_ALIASES[normalized] ?? "__skip__";
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await prisma.sheetConfig.findFirst({
    where: { shop },
    include: { mappings: true },
  });

  return json<LoaderData>({
    config: config
      ? {
          sheetUrl: config.sheetUrl,
          sheetName: config.sheetName,
          skuColumn: config.skuColumn,
          matchField: config.matchField ?? "sku",
          updateOnly: config.updateOnly ?? false,
          mappings: config.mappings.map((m) => ({
            sheetColumn: m.sheetColumn,
            shopifyField: m.shopifyField,
          })),
        }
      : null,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const sheetUrl = formData.get("sheetUrl") as string;
  const sheetName = (formData.get("sheetName") as string) || "Sheet1";
  const skuColumn = formData.get("skuColumn") as string;
  const matchField = (formData.get("matchField") as string) || "sku";
  const updateOnly = formData.get("updateOnly") === "true";

  if (!sheetUrl || !skuColumn) {
    return json({ error: "Sheet URL and identifier column are required." }, { status: 400 });
  }

  let spreadsheetId: string;
  try {
    spreadsheetId = extractSpreadsheetId(sheetUrl);
  } catch (e: unknown) {
    return json({ error: (e as Error).message }, { status: 400 });
  }

  const mappings: FieldMapping[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("field_mapping_") && value && value !== "__skip__") {
      const sheetColumn = key.replace("field_mapping_", "");
      mappings.push({ sheetColumn, shopifyField: value as string });
    }
  }

  const existing = await prisma.sheetConfig.findFirst({ where: { shop } });

  let configId: string;
  if (existing) {
    await prisma.sheetConfig.update({
      where: { id: existing.id },
      data: { sheetUrl, sheetName, skuColumn, spreadsheetId, matchField, updateOnly },
    });
    configId = existing.id;
  } else {
    const created = await prisma.sheetConfig.create({
      data: { shop, sheetUrl, sheetName, skuColumn, spreadsheetId, matchField, updateOnly },
    });
    configId = created.id;
  }

  const uniqueMappings = Array.from(
    new Map(mappings.map((m) => [m.shopifyField, m])).values()
  );

  await prisma.fieldMapping.deleteMany({ where: { sheetConfigId: configId } });
  if (uniqueMappings.length > 0) {
    await prisma.fieldMapping.createMany({
      data: uniqueMappings.map((m) => ({
        sheetConfigId: configId,
        sheetColumn: m.sheetColumn,
        shopifyField: m.shopifyField,
      })),
    });
  }

  return json({ success: true });
};

// ── Constants ─────────────────────────────────────────────────────────────────

const SHOPIFY_FIELD_OPTIONS = [
  { label: "— skip —", value: "__skip__" },
  ...SHOPIFY_FIELDS.map((f) => ({ label: f.label, value: f.value })),
];

// ── Component ─────────────────────────────────────────────────────────────────

export default function Settings() {
  const { config } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const [sheetUrl, setSheetUrl] = useState(config?.sheetUrl ?? "");
  const [sheetName, setSheetName] = useState(config?.sheetName ?? "Sheet1");
  const [matchField, setMatchField] = useState(config?.matchField ?? "sku");
  const [skuColumn, setSkuColumn] = useState(config?.skuColumn ?? "");
  const [updateOnly, setUpdateOnly] = useState(config?.updateOnly ?? false);

  const headersFetcher = useFetcher<{ headers?: string[]; error?: string }>();
  const fetchedHeaders: string[] = headersFetcher.data?.headers ?? [];

  // Fallback: show previously-mapped column names while fresh headers load
  const savedColumns = config?.mappings.map((m) => m.sheetColumn) ?? [];
  const displayHeaders = fetchedHeaders.length > 0 ? fetchedHeaders : savedColumns;

  // Auto-fetch headers on mount if config already exists
  useEffect(() => {
    if (config?.sheetUrl && config?.sheetName && headersFetcher.state === "idle" && fetchedHeaders.length === 0) {
      headersFetcher.submit(
        { sheetUrl: config.sheetUrl, sheetName: config.sheetName },
        { method: "POST", action: "/api/sheet-headers", encType: "application/json" },
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mapping state: column → shopify field
  const [mappings, setMappings] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const m of config?.mappings ?? []) {
      initial[m.sheetColumn] = m.shopifyField;
    }
    return initial;
  });

  // Auto-detect mappings when headers become available
  useEffect(() => {
    if (displayHeaders.length === 0) return;
    setMappings((prev) => {
      const next = { ...prev };
      for (const col of displayHeaders) {
        if (!next[col] || next[col] === "__skip__") {
          const detected = autoDetectMapping(col);
          if (detected !== "__skip__") next[col] = detected;
        }
      }
      return next;
    });
    // Also auto-set identifier column if not set
    setSkuColumn((prev) => {
      if (prev) return prev;
      // Look for a column that maps to 'sku' or 'title'
      for (const col of displayHeaders) {
        const det = autoDetectMapping(col);
        if (det === "sku" || det === "title") return col;
      }
      return prev;
    });
  }, [displayHeaders.join(",")]);

  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const isSaving = saveFetcher.state !== "idle";
  const saveSuccess = saveFetcher.data?.success;
  const saveError = saveFetcher.data?.error;

  function loadColumns() {
    headersFetcher.submit(
      { sheetUrl, sheetName },
      { method: "POST", action: "/api/sheet-headers", encType: "application/json" },
    );
  }

  function handleMappingChange(column: string, value: string) {
    setMappings((prev) => ({ ...prev, [column]: value }));
  }

  function handleSave() {
    const formData = new FormData();
    formData.append("sheetUrl", sheetUrl);
    formData.append("sheetName", sheetName);
    formData.append("skuColumn", skuColumn);
    formData.append("matchField", matchField);
    formData.append("updateOnly", String(updateOnly));
    for (const [column, field] of Object.entries(mappings)) {
      formData.append(`field_mapping_${column}`, field);
    }
    saveFetcher.submit(formData, { method: "POST" });
  }

  const skuOptions = [
    { label: "— select identifier column —", value: "" },
    ...displayHeaders.map((h) => ({ label: h, value: h })),
  ];

  const isLoadingHeaders = headersFetcher.state !== "idle";

  return (
    <Page
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      title="Sheet Settings"
    >
      <TitleBar title="Sheet Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {saveSuccess && (
              <Banner title="Settings saved" tone="success">
                <Text as="p" variant="bodyMd">
                  Your sheet configuration has been saved successfully.
                </Text>
              </Banner>
            )}
            {saveError && (
              <Banner title="Error saving settings" tone="critical">
                <Text as="p" variant="bodyMd">{saveError}</Text>
              </Banner>
            )}

            {/* Sheet URL & Tab */}
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Sheet URL &amp; Tab</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Paste your Google Sheet URL and tab name. Make sure the
                    sheet is shared as "Anyone with the link can view".
                  </Text>
                </BlockStack>
                <TextField
                  label="Google Sheet URL"
                  value={sheetUrl}
                  onChange={setSheetUrl}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  autoComplete="off"
                  helpText="Paste the full URL from your browser's address bar."
                />
                <TextField
                  label="Tab name"
                  value={sheetName}
                  onChange={setSheetName}
                  placeholder="Sheet1"
                  autoComplete="off"
                  helpText="The exact tab name at the bottom of your spreadsheet."
                />
                {headersFetcher.data?.error && (
                  <Banner title="Could not load columns" tone="critical">
                    <Text as="p" variant="bodyMd">{headersFetcher.data.error}</Text>
                  </Banner>
                )}
                <InlineStack>
                  <Button onClick={loadColumns} loading={isLoadingHeaders} disabled={!sheetUrl}>
                    {displayHeaders.length > 0 ? "Reload columns" : "Load columns"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Column mapping */}
            {displayHeaders.length > 0 && (
              <Card>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">Column mapping</Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Columns have been auto-mapped based on their names. Adjust
                      any that are incorrect, then save.
                    </Text>
                  </BlockStack>

                  <Select
                    label="Match type"
                    options={[
                      { label: "Variant SKU", value: "sku" },
                      { label: "Product title", value: "title" },
                      { label: "Product handle", value: "handle" },
                    ]}
                    value={matchField}
                    onChange={setMatchField}
                    helpText="How to find existing Shopify products. Use 'Product title' if products were imported without SKUs."
                  />

                  <Select
                    label="Identifier column"
                    options={skuOptions}
                    value={skuColumn}
                    onChange={setSkuColumn}
                    helpText={
                      matchField === "sku"
                        ? "Sheet column whose value matches the variant SKU in Shopify."
                        : matchField === "title"
                        ? "Sheet column whose value matches the product title in Shopify."
                        : "Sheet column whose value matches the product handle (URL slug)."
                    }
                  />

                  <Checkbox
                    label="Update only — don't create new products"
                    helpText="When enabled, rows with no matching Shopify product are skipped instead of creating a new product."
                    checked={updateOnly}
                    onChange={setUpdateOnly}
                  />

                  <Divider />

                  <Text as="h3" variant="headingSm">Field mappings</Text>

                  <BlockStack gap="300">
                    {displayHeaders.map((col) => (
                      <Select
                        key={col}
                        label={col}
                        options={SHOPIFY_FIELD_OPTIONS}
                        value={mappings[col] ?? "__skip__"}
                        onChange={(val) => handleMappingChange(col, val)}
                      />
                    ))}
                  </BlockStack>

                  <InlineStack>
                    <Button
                      variant="primary"
                      onClick={handleSave}
                      loading={isSaving}
                      disabled={!skuColumn}
                    >
                      Save settings
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
