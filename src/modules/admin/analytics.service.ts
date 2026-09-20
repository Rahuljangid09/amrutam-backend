import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
export const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function defaultRange(from?: Date, to?: Date) {
  const end = to ?? new Date(startOfUtcDay(new Date()).getTime() + DAY_MS);
  const start = from ?? new Date(end.getTime() - 7 * DAY_MS);
  return { from: start, to: end };
}

// Live numbers for a range (indexed queries; fine for a dashboard).
export async function overview(fromIn?: Date, toIn?: Date) {
  const { from, to } = defaultRange(fromIn, toIn);
  const [byStatus, revenue, refunds, newPatients, activeDoctors] = await Promise.all([
    prisma.consultation.groupBy({ by: ["status"], where: { scheduledAt: { gte: from, lt: to } }, _count: { _all: true } }),
    prisma.payment.aggregate({ where: { status: "SUCCEEDED", updatedAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { status: "REFUNDED", updatedAt: { gte: from, lt: to } }, _sum: { amount: true } }),
    prisma.user.count({ where: { role: "PATIENT", createdAt: { gte: from, lt: to } } }),
    prisma.doctor.count({ where: { isVerified: true, user: { isActive: true } } }),
  ]);
  const consultations = Object.fromEntries(byStatus.map((g) => [g.status, g._count._all]));
  return {
    range: { from, to },
    consultations: { total: byStatus.reduce((n, g) => n + g._count._all, 0), byStatus: consultations },
    revenue: (revenue._sum.amount ?? new Prisma.Decimal(0)).toString(),
    refunds: (refunds._sum.amount ?? new Prisma.Decimal(0)).toString(),
    newPatients,
    activeDoctors,
  };
}

// Aggregates the days in [from, to) (UTC, day-aligned) into daily_stats. Idempotent (upsert),
// so several workers or repeated calls are harmless.
export async function refreshDailyStats(from: Date, to: Date) {
  const counts = await prisma.$queryRaw<{ day: Date; total: number; completed: number; cancelled: number; no_show: number }[]>`
    SELECT date_trunc('day', scheduled_at) AS day,
           count(*)::int AS total,
           (count(*) FILTER (WHERE status = 'COMPLETED'))::int AS completed,
           (count(*) FILTER (WHERE status = 'CANCELLED'))::int AS cancelled,
           (count(*) FILTER (WHERE status = 'NO_SHOW'))::int AS no_show
    FROM consultations
    WHERE scheduled_at >= ${from} AND scheduled_at < ${to}
    GROUP BY 1`;
  const money = await prisma.$queryRaw<{ day: Date; revenue: Prisma.Decimal }[]>`
    SELECT date_trunc('day', updated_at) AS day, COALESCE(sum(amount), 0) AS revenue
    FROM payments
    WHERE status = 'SUCCEEDED' AND updated_at >= ${from} AND updated_at < ${to}
    GROUP BY 1`;

  const countByDay = new Map(counts.map((r) => [dayKey(new Date(r.day)), r]));
  const moneyByDay = new Map(money.map((r) => [dayKey(new Date(r.day)), r.revenue]));

  const upserts: Prisma.PrismaPromise<unknown>[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const day = new Date(t);
    const k = dayKey(day);
    const c = countByDay.get(k);
    const data = {
      total: c?.total ?? 0,
      completed: c?.completed ?? 0,
      cancelled: c?.cancelled ?? 0,
      noShow: c?.no_show ?? 0,
      revenue: moneyByDay.get(k) ?? 0,
    };
    upserts.push(prisma.dailyStat.upsert({ where: { day }, update: data, create: { day, ...data } }));
  }
  await prisma.$transaction(upserts);
}

// Reads pre-aggregated rows. Missing days, and days that were computed before they ended, are refreshed first.
export async function dailyStats(fromIn?: Date, toIn?: Date) {
  const range = defaultRange(fromIn, toIn);
  const from = startOfUtcDay(range.from);
  const to = new Date(startOfUtcDay(new Date(range.to.getTime() - 1)).getTime() + DAY_MS);

  const existing = await prisma.dailyStat.findMany({ where: { day: { gte: from, lt: to } } });
  const byDay = new Map(existing.map((r) => [dayKey(r.day), r]));
  const now = Date.now();
  const stale: number[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
    const row = byDay.get(dayKey(new Date(t)));
    const finalized = row && row.updatedAt.getTime() >= t + DAY_MS + 3600_000;
    const freshEnough = row && now - row.updatedAt.getTime() < 60_000;
    if (!row || (!finalized && !freshEnough)) stale.push(t);
  }
  if (stale.length > 0) await refreshDailyStats(new Date(Math.min(...stale)), new Date(Math.max(...stale) + DAY_MS));

  const rows = await prisma.dailyStat.findMany({ where: { day: { gte: from, lt: to } }, orderBy: { day: "asc" } });
  return {
    items: rows.map((r) => ({ day: dayKey(r.day), total: r.total, completed: r.completed, cancelled: r.cancelled, noShow: r.noShow, revenue: r.revenue.toString() })),
  };
}

export async function topDoctors(fromIn: Date | undefined, toIn: Date | undefined, limit: number) {
  const { from, to } = defaultRange(fromIn, toIn);
  const groups = await prisma.consultation.groupBy({
    by: ["doctorId"],
    where: { scheduledAt: { gte: from, lt: to }, status: { in: ["CONFIRMED", "IN_PROGRESS", "COMPLETED", "NO_SHOW"] } },
    _count: { _all: true },
    orderBy: { _count: { doctorId: "desc" } },
    take: limit,
  });
  const ids = groups.map((g) => g.doctorId);
  const [doctors, slotGroups] = await Promise.all([
    prisma.doctor.findMany({ where: { id: { in: ids } }, select: { id: true, specialization: true, user: { select: { profile: { select: { fullName: true } } } } } }),
    prisma.availabilitySlot.groupBy({ by: ["doctorId", "status"], where: { doctorId: { in: ids }, startTime: { gte: from, lt: to }, status: { not: "CANCELLED" } }, _count: { _all: true } }),
  ]);
  const byId = new Map(doctors.map((d) => [d.id, d]));
  return {
    range: { from, to },
    items: groups.map((g) => {
      const slots = slotGroups.filter((s) => s.doctorId === g.doctorId);
      const total = slots.reduce((n, s) => n + s._count._all, 0);
      const booked = slots.find((s) => s.status === "BOOKED")?._count._all ?? 0;
      const d = byId.get(g.doctorId);
      return {
        doctorId: g.doctorId,
        name: d?.user.profile?.fullName ?? null,
        specialization: d?.specialization ?? null,
        consultations: g._count._all,
        slotUtilization: total === 0 ? 0 : Math.round((booked / total) * 100) / 100,
      };
    }),
  };
}
