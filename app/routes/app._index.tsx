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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { runSync } from "../lib/shopify-sync.server";
import type { SyncLog } from "../lib/sync-logger.server";

type SheetConfigWithCount = {
  id: string;
  sheetUrl: string;
  sheetName: string;
  skuColumn: string | null;
  mappingsCount: number;
};

type LoaderData = {
  shop: string;
  config: SheetConfigWithCount | null;
  lastLog: SyncLog | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await prisma.sheetConfig.findFirst({
    where: { shop },
    include: { mappings: true },
  });

  const lastLog = await prisma.syncLog.findFirst({
    where: { shop },
    orderBy: { startedAt: "desc" },
  });

  return json<LoaderData>({
    shop,
    config: config
      ? {
          id: config.id,
          sheetUrl: config.sheetUrl,
          sheetName: config.sheetName,
          skuColumn: config.skuColumn,
          mappingsCount: config.mappings.length,
        }
      : null,
    lastLog,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const result = await runSync(session.shop, "manual", admin);
  return json(result);
};

export default function Index() {
  const { config, lastLog } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();

  const isSyncing =
    fetcher.state !== "idle" && fetcher.formMethod === "POST";

  const syncResult = fetcher.data;

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

              {config && (
                <Card>
                  <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">
                      Connected Sheet
                    </Text>
                    <BlockStack gap="200">
                      <InlineStack gap="200" align="start">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          URL:
                        </Text>
                        <Text as="span" variant="bodyMd">
                          {config.sheetUrl}
                        </Text>
                      </InlineStack>
                      <InlineStack gap="200" align="start">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          Tab:
                        </Text>
                        <Text as="span" variant="bodyMd">
                          {config.sheetName}
                        </Text>
                      </InlineStack>
                      <InlineStack gap="200" align="start">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          Field mappings:
                        </Text>
                        <Text as="span" variant="bodyMd">
                          {config.mappingsCount}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                    <InlineStack gap="300">
                      <fetcher.Form method="post">
                        <Button
                          variant="primary"
                          submit
                          loading={isSyncing}
                        >
                          Sync Now
                        </Button>
                      </fetcher.Form>
                      <Button
                        variant="plain"
                        onClick={() => navigate("/app/settings")}
                      >
                        Edit settings
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              )}

              {syncResult && (
                <Banner
                  title={
                    syncResult.errorCount === 0
                      ? "Sync completed successfully"
                      : "Sync completed with errors"
                  }
                  tone={syncResult.errorCount === 0 ? "success" : "critical"}
                >
                  <Text as="p" variant="bodyMd">
                    {syncResult.updatedCount} products updated,{" "}
                    {syncResult.skippedCount} skipped,{" "}
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
                        {lastLog.updatedCount} products updated,{" "}
                        {lastLog.skippedCount} skipped,{" "}
                        {lastLog.errorCount} errors.
                      </Text>
                    )}
                    {lastLog.completedAt && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Completed:{" "}
                        {new Date(lastLog.completedAt).toLocaleString()}
                      </Text>
                    )}
                    {lastLog.errorCount > 0 && lastLog.errorMessages && (
                      <Text as="p" variant="bodyMd">
                        {(() => {
                          try {
                            const msgs = JSON.parse(lastLog.errorMessages) as string[];
                            return msgs.slice(0, 3).join(" | ");
                          } catch {
                            return lastLog.errorMessages;
                          }
                        })()}
                      </Text>
                    )}
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
