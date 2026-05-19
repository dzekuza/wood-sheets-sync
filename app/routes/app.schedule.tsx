import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  Text,
  Select,
  Checkbox,
  Button,
  Banner,
  BlockStack,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { rescheduleJob } from "../lib/scheduler.server";

type SyncScheduleData = {
  id: string;
  intervalHours: number | null;
  isEnabled: boolean;
  nextRunAt: string | null;
};

type LoaderData = {
  schedule: SyncScheduleData | null;
  hasConfig: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const config = await prisma.sheetConfig.findFirst({
    where: { shop },
    include: { schedule: true },
  });

  return json<LoaderData>({
    hasConfig: config !== null,
    schedule: config?.schedule
      ? {
          id: config.schedule.id,
          intervalHours: config.schedule.intervalHours,
          isEnabled: config.schedule.isEnabled,
          nextRunAt: config.schedule.nextRunAt?.toISOString() ?? null,
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const intervalRaw = formData.get("intervalHours");
  const intervalHours =
    intervalRaw && intervalRaw !== "0"
      ? parseInt(intervalRaw as string, 10)
      : null;
  const isEnabled = formData.get("isEnabled") === "true";

  const config = await prisma.sheetConfig.findFirst({ where: { shop } });
  if (!config) {
    return json({ error: "No sheet configuration found." }, { status: 400 });
  }

  // Compute next run time
  const nextRunAt =
    isEnabled && intervalHours
      ? new Date(Date.now() + intervalHours * 60 * 60 * 1000)
      : null;

  // Upsert schedule
  await prisma.syncSchedule.upsert({
    where: { sheetConfigId: config.id },
    create: {
      sheetConfigId: config.id,
      intervalHours,
      isEnabled,
      nextRunAt,
    },
    update: {
      intervalHours,
      isEnabled,
      nextRunAt,
    },
  });

  // Update the in-process cron scheduler
  rescheduleJob(shop, intervalHours, isEnabled);

  return json({ success: true });
};

const INTERVAL_OPTIONS = [
  { label: "Disabled", value: "0" },
  { label: "Every 1 hour", value: "1" },
  { label: "Every 2 hours", value: "2" },
  { label: "Every 4 hours", value: "4" },
  { label: "Every 6 hours", value: "6" },
  { label: "Every 12 hours", value: "12" },
  { label: "Every 24 hours", value: "24" },
];

export default function Schedule() {
  const { schedule, hasConfig } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();

  const [intervalHours, setIntervalHours] = useState(
    String(schedule?.intervalHours ?? "0"),
  );
  const [isEnabled, setIsEnabled] = useState(schedule?.isEnabled ?? false);

  const isSaving = saveFetcher.state !== "idle";
  const saveSuccess = saveFetcher.data?.success;
  const saveError = saveFetcher.data?.error;

  function handleSave() {
    const formData = new FormData();
    formData.append("intervalHours", intervalHours);
    formData.append("isEnabled", String(isEnabled));
    saveFetcher.submit(formData, { method: "POST" });
  }

  return (
    <Page
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      title="Sync Schedule"
    >
      <TitleBar title="Sync Schedule" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            {!hasConfig && (
              <Banner
                title="No sheet configured"
                tone="warning"
                action={{ content: "Go to Settings", url: "/app/settings" }}
              >
                <Text as="p" variant="bodyMd">
                  You need to connect a Google Sheet before you can configure
                  automatic sync scheduling.
                </Text>
              </Banner>
            )}

            {saveSuccess && (
              <Banner title="Schedule saved" tone="success">
                <Text as="p" variant="bodyMd">
                  Your sync schedule has been updated.
                </Text>
              </Banner>
            )}

            {saveError && (
              <Banner title="Error saving schedule" tone="critical">
                <Text as="p" variant="bodyMd">{saveError}</Text>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Automatic sync interval
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Choose how often the app should automatically sync your Google
                  Sheet data into Shopify products. Select "Disabled" to turn
                  off automatic sync and run syncs manually from the dashboard.
                </Text>

                <Select
                  label="Sync interval"
                  options={INTERVAL_OPTIONS}
                  value={intervalHours}
                  onChange={setIntervalHours}
                  disabled={!hasConfig}
                />

                <Checkbox
                  label="Enable automatic sync"
                  checked={isEnabled}
                  onChange={setIsEnabled}
                  disabled={!hasConfig || intervalHours === "0"}
                  helpText={
                    intervalHours === "0"
                      ? "Select an interval to enable automatic sync."
                      : undefined
                  }
                />

                {schedule?.nextRunAt && isEnabled && (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Next scheduled run:{" "}
                    {new Date(schedule.nextRunAt).toLocaleString()}
                  </Text>
                )}

                <InlineStack>
                  <Button
                    variant="primary"
                    onClick={handleSave}
                    loading={isSaving}
                    disabled={!hasConfig}
                  >
                    Save schedule
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
