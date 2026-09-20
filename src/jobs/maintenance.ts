import { prisma } from "../config/prisma";
import { logger } from "../config/logger";
import { refreshDailyStats, startOfUtcDay } from "../modules/admin/analytics.service";

const DAY_MS = 24 * 60 * 60 * 1000;

// audit_logs is partitioned by month. Rows that arrive for a month with no partition would land in the
// DEFAULT partition (a safety net, not a home), so we keep the next few months created ahead of time.
// The SQL function is idempotent: safe to call on every boot and every hour, from any number of instances.
export async function ensureAuditPartitions(monthsAhead = 3): Promise<number> {
  const rows = await prisma.$queryRaw<{ created: number }[]>`
    SELECT ensure_audit_partitions(date_trunc('month', now())::date, ${monthsAhead}::int) AS created`;
  const created = Number(rows[0]?.created ?? 0);
  if (created > 0) logger.info({ created }, "created audit_logs partitions");
  return created;
}

// Re-aggregate yesterday and today so the admin dashboards read pre-computed rows instead of scanning
// millions of consultations. Idempotent upsert, so overlapping runs are harmless.
export async function refreshRecentDailyStats(): Promise<void> {
  const today = startOfUtcDay(new Date());
  await refreshDailyStats(new Date(today.getTime() - DAY_MS), new Date(today.getTime() + DAY_MS));
}

const PURGE_BATCH = 5000;
const PURGE_MAX_ROUNDS = 20; // bounds the work of a single run; the next hourly run continues

// Housekeeping so support tables do not grow without bound. Deletes in small batches (short locks, small WAL bursts).
async function purgeInBatches(delete_: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let round = 0; round < PURGE_MAX_ROUNDS; round++) {
    const n = await delete_();
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

export async function purgeStaleRows() {
  // idempotency keys are only useful while a client could still retry: they carry their own expiry
  const idempotencyKeys = await purgeInBatches(
    () => prisma.$executeRaw`DELETE FROM idempotency_keys WHERE id IN (SELECT id FROM idempotency_keys WHERE expires_at < now() LIMIT ${PURGE_BATCH})`,
  );
  // expired or revoked refresh tokens are kept 30 days (useful when investigating a theft report), then dropped
  const refreshTokens = await purgeInBatches(
    () =>
      prisma.$executeRaw`DELETE FROM refresh_tokens WHERE id IN (
        SELECT id FROM refresh_tokens
         WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days' LIMIT ${PURGE_BATCH})`,
  );
  // delivered outbox events are kept 14 days for debugging; DEAD events are never purged automatically (they need a human)
  const outboxEvents = await purgeInBatches(
    () =>
      prisma.$executeRaw`DELETE FROM outbox_events WHERE id IN (
        SELECT id FROM outbox_events WHERE status = 'PROCESSED' AND processed_at < now() - interval '14 days' LIMIT ${PURGE_BATCH})`,
  );
  if (idempotencyKeys + refreshTokens + outboxEvents > 0) logger.info({ idempotencyKeys, refreshTokens, outboxEvents }, "purged stale rows");
  return { idempotencyKeys, refreshTokens, outboxEvents };
}
