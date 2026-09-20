import { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// Transactional outbox: call inside the same transaction as the state change.
// The worker delivers events asynchronously (at-least-once, retried with backoff).
export async function emitEvent(
  db: Db,
  type: string,
  aggregateId: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  await db.outboxEvent.create({ data: { type, aggregateId, payload }, select: { id: true } });
}
