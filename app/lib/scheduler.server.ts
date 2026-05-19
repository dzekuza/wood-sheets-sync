import cron from "node-cron";
import prisma from "~/db.server";
import { runSync } from "~/lib/shopify-sync.server";
import { unauthenticated } from "~/shopify.server";

// ── Global singleton guard ─────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __schedulerStarted: boolean | undefined;
}

// Track active cron jobs keyed by shop domain
const activeJobs = new Map<string, ReturnType<typeof cron.schedule>>();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert an interval in hours to a cron expression.
 * Examples: 1h = "0 * * * *", 6h = "0 every6 * * *", 24h = "0 0 * * *"
 */
function intervalToCron(hours: number): string {
  if (hours === 24) return "0 0 * * *";
  if (hours === 1) return "0 * * * *";
  return `0 */${hours} * * *`;
}

/**
 * Execute a scheduled sync for a shop using a stored offline session.
 */
async function runSyncForShop(shop: string): Promise<void> {
  try {
    // Verify an offline session exists for the shop before attempting sync
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });

    if (!session) {
      console.warn(
        `[scheduler] No offline session found for shop "${shop}". Skipping scheduled sync.`
      );
      return;
    }

    // Use unauthenticated.admin() which reads the stored access token from the
    // session table — no HTTP request context needed for background jobs.
    const { admin } = await unauthenticated.admin(shop);

    await runSync(shop, "scheduled", admin);
    console.log(`[scheduler] Completed scheduled sync for "${shop}".`);
  } catch (err) {
    console.error(
      `[scheduler] Error during scheduled sync for "${shop}":`,
      err instanceof Error ? err.message : err
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start, update, or stop the cron job for a specific shop.
 *
 * - If a job already exists for this shop, it is stopped first.
 * - If isEnabled && intervalHours != null, a new job is scheduled.
 * - Otherwise the slot is simply cleared.
 */
export function rescheduleJob(
  shop: string,
  intervalHours: number | null,
  isEnabled: boolean
): void {
  // Stop existing job if any
  const existing = activeJobs.get(shop);
  if (existing) {
    existing.stop();
    activeJobs.delete(shop);
    console.log(`[scheduler] Stopped existing job for "${shop}".`);
  }

  if (!isEnabled || intervalHours === null) {
    return;
  }

  const expression = intervalToCron(intervalHours);
  console.log(
    `[scheduler] Scheduling job for "${shop}" with cron "${expression}" (every ${intervalHours}h).`
  );

  const task = cron.schedule(expression, () => {
    void runSyncForShop(shop);
  });

  activeJobs.set(shop, task);
}

/**
 * Boot the scheduler once per process.
 * Reads all enabled SyncSchedule rows from DB and schedules cron jobs.
 * Should be called from the app entry point (e.g. entry.server.tsx or root loader).
 */
export async function startScheduler(): Promise<void> {
  if (global.__schedulerStarted) return;
  global.__schedulerStarted = true;

  console.log("[scheduler] Starting scheduler…");

  try {
    const schedules = await prisma.syncSchedule.findMany({
      where: { isEnabled: true },
      include: {
        sheetConfig: {
          select: { shop: true },
        },
      },
    });

    for (const schedule of schedules) {
      const shop = schedule.sheetConfig?.shop;
      if (!shop) continue;

      rescheduleJob(shop, schedule.intervalHours, schedule.isEnabled);
    }

    console.log(
      `[scheduler] Initialised ${schedules.length} scheduled job(s).`
    );
  } catch (err) {
    console.error(
      "[scheduler] Failed to load schedules from DB:",
      err instanceof Error ? err.message : err
    );
  }
}
