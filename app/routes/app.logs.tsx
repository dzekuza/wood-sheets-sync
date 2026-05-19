import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  DataTable,
  Badge,
  EmptyState,
  BlockStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getRecentLogs } from "../lib/sync-logger.server";
import type { SyncLog } from "../lib/sync-logger.server";

type SerializedLog = Omit<SyncLog, "startedAt" | "completedAt"> & {
  startedAt: string;
  completedAt: string | null;
};

type LoaderData = {
  logs: SerializedLog[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const logs = await getRecentLogs(shop, 50);

  return json<LoaderData>({
    logs: logs.map((log) => ({
      ...log,
      startedAt: log.startedAt.toISOString(),
      completedAt: log.completedAt?.toISOString() ?? null,
    })),
  });
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "success":
      return <Badge tone="success">Success</Badge>;
    case "partial":
      return <Badge tone="warning">Partial</Badge>;
    case "failed":
      return <Badge tone="critical">Failed</Badge>;
    case "running":
      return <Badge tone="info">Running</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

export default function Logs() {
  const { logs } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  if (logs.length === 0) {
    return (
      <Page
        backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
        title="Sync Logs"
      >
        <TitleBar title="Sync Logs" />
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="No syncs yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <Text as="p" variant="bodyMd">
                  Click "Sync Now" on the dashboard to run your first sync.
                </Text>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const rows = logs.map((log) => [
    new Date(log.startedAt).toLocaleString(),
    log.triggeredBy === "manual" ? "Manual" : "Scheduled",
    <StatusBadge key={log.id} status={log.status} />,
    log.updatedCount,
    log.skippedCount,
    log.errorCount,
  ]);

  return (
    <Page
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      title="Sync Logs"
    >
      <TitleBar title="Sync Logs" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd" tone="subdued">
              Showing the last {logs.length} sync{logs.length === 1 ? "" : "s"}.
            </Text>
            <Card padding="0">
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                  "numeric",
                ]}
                headings={[
                  "Date",
                  "Triggered By",
                  "Status",
                  "Updated",
                  "Skipped",
                  "Errors",
                ]}
                rows={rows}
              />
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
