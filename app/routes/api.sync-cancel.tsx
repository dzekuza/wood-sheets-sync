import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { cancelRunningSyncLogs } from "~/lib/sync-logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  await prisma.syncCancel.upsert({
    where: { shop },
    create: { shop },
    update: { createdAt: new Date() },
  });
  const stoppedLogs = await cancelRunningSyncLogs(shop);

  return json({ cancelled: true, stoppedLogs });
};
