import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useState } from "react";
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
    mappings: FieldMapping[];
  } | null;
};

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
          mappings: config.mappings.map((m) => ({
            sheetColumn: m.sheetColumn,
            shopifyField: m.shopifyField,
          })),
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const sheetUrl = formData.get("sheetUrl") as string;
  const sheetName = (formData.get("sheetName") as string) || "Sheet1";
  const skuColumn = formData.get("skuColumn") as string;

  if (!sheetUrl || !skuColumn) {
    return json({ error: "Sheet URL and SKU column are required." }, { status: 400 });
  }

  let spreadsheetId: string;
  try {
    spreadsheetId = extractSpreadsheetId(sheetUrl);
  } catch (e: unknown) {
    return json({ error: (e as Error).message }, { status: 400 });
  }

  // Collect field mappings from form data
  const mappings: FieldMapping[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("field_mapping_") && value && value !== "__skip__") {
      const sheetColumn = key.replace("field_mapping_", "");
      mappings.push({ sheetColumn, shopifyField: value as string });
    }
  }

  // Upsert SheetConfig
  const existing = await prisma.sheetConfig.findFirst({ where: { shop } });

  let configId: string;
  if (existing) {
    await prisma.sheetConfig.update({
      where: { id: existing.id },
      data: { sheetUrl, sheetName, skuColumn, spreadsheetId },
    });
    configId = existing.id;
  } else {
    const created = await prisma.sheetConfig.create({
      data: { shop, sheetUrl, sheetName, skuColumn, spreadsheetId },
    });
    configId = created.id;
  }

  // Deduplicate by shopifyField — if user maps two columns to the same field, last one wins
  const uniqueMappings = Array.from(
    new Map(mappings.map((m) => [m.shopifyField, m])).values()
  );

  // Replace field mappings
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

const SHOPIFY_FIELD_OPTIONS = [
  { label: "— skip —", value: "__skip__" },
  ...SHOPIFY_FIELDS.map((f) => ({ label: f.label, value: f.value })),
];

export default function Settings() {
  const { config } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  // Sheet URL form state
  const [sheetUrl, setSheetUrl] = useState(config?.sheetUrl ?? "");
  const [sheetName, setSheetName] = useState(config?.sheetName ?? "Sheet1");

  // Headers fetcher
  const headersFetcher = useFetcher<{ headers?: string[]; error?: string }>();
  const headers: string[] = headersFetcher.data?.headers ?? [];

  // Already-loaded headers from existing config
  const initialHeaders = config?.mappings.map((m) => m.sheetColumn) ?? [];
  const displayHeaders = headers.length > 0 ? headers : initialHeaders;

  // SKU column selection
  const [skuColumn, setSkuColumn] = useState(config?.skuColumn ?? "");

  // Mapping state: column name → shopify field
  const [mappings, setMappings] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const m of config?.mappings ?? []) {
      initial[m.sheetColumn] = m.shopifyField;
    }
    return initial;
  });

  // Save form fetcher
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const isSaving = saveFetcher.state !== "idle";
  const saveSuccess = saveFetcher.data?.success;
  const saveError = saveFetcher.data?.error;

  function loadColumns() {
    headersFetcher.submit(
      { sheetUrl, sheetName },
      {
        method: "POST",
        action: "/api/sheet-headers",
        encType: "application/json",
      },
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
    for (const [column, field] of Object.entries(mappings)) {
      formData.append(`field_mapping_${column}`, field);
    }
    saveFetcher.submit(formData, { method: "POST" });
  }

  const skuOptions = [
    { label: "— select SKU column —", value: "" },
    ...displayHeaders.map((h) => ({ label: h, value: h })),
  ];

  const isLoadingHeaders =
    headersFetcher.state !== "idle";

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

            {/* Step 1: Sheet URL */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Step 1: Connect your Google Sheet
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Enter the URL of your public Google Sheet. Make sure the sheet
                  is shared with "Anyone with the link can view".
                </Text>
                <TextField
                  label="Google Sheet URL"
                  value={sheetUrl}
                  onChange={setSheetUrl}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  autoComplete="off"
                />
                <TextField
                  label="Tab name"
                  value={sheetName}
                  onChange={setSheetName}
                  placeholder="Sheet1"
                  autoComplete="off"
                  helpText="The name of the tab/sheet to read from."
                />
                {headersFetcher.data?.error && (
                  <Banner title="Could not load columns" tone="critical">
                    <Text as="p" variant="bodyMd">
                      {headersFetcher.data.error}
                    </Text>
                  </Banner>
                )}
                <InlineStack>
                  <Button
                    onClick={loadColumns}
                    loading={isLoadingHeaders}
                    disabled={!sheetUrl}
                  >
                    Load columns
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Step 2: Column mapping */}
            {displayHeaders.length > 0 && (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Step 2: Map columns to Shopify fields
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Choose which sheet column contains the SKU (used to identify
                    products), then map other columns to Shopify product fields.
                  </Text>

                  <Select
                    label="SKU column (identifier)"
                    options={skuOptions}
                    value={skuColumn}
                    onChange={setSkuColumn}
                    helpText="This column's value will be used to look up the product in Shopify."
                  />

                  <Divider />

                  <Text as="h3" variant="headingSm">
                    Field mappings
                  </Text>

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
