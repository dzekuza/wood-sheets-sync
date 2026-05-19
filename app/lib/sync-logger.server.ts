import prisma from "~/db.server";
import type { SyncLog } from "@prisma/client";

// Re-export the Prisma type so callers can import it from here.
export type { SyncLog };

/**
 * Create a new SyncLog record with status "running".
 * Returns the generated log ID.
 */
export async function createSyncLog(
  shop: string,
  triggeredBy: "manual" | "scheduled"
): Promise<string> {
  const log = await prisma.syncLog.create({
    data: {
      shop,
      triggeredBy,
      status: "running",
      totalRows: 0,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      errorMessages: "[]",
    },
  });
  return log.id;
}

/**
 * Update an existing SyncLog with the final sync results.
 */
export async function updateSyncLog(
  id: string,
  data: {
    status: "success" | "partial" | "failed";
    totalRows: number;
    updatedCount: number;
    skippedCount: number;
    errorCount: number;
    errorMessages: string[];
    completedAt: Date;
  }
): Promise<void> {
  await prisma.syncLog.update({
    where: { id },
    data: {
      status: data.status,
      totalRows: data.totalRows,
      updatedCount: data.updatedCount,
      skippedCount: data.skippedCount,
      errorCount: data.errorCount,
      errorMessages: JSON.stringify(data.errorMessages),
      completedAt: data.completedAt,
    },
  });
}

/**
 * Return the most recent N sync logs for a shop, newest first.
 */
export async function getRecentLogs(
  shop: string,
  limit = 50
): Promise<SyncLog[]> {
  return prisma.syncLog.findMany({
    where: { shop },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
