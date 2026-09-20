import { Prisma } from "@prisma/client";

// Every code path that changes a slot's state (book, pay, cancel, expire) takes this row lock FIRST,
// then touches consultation and payment rows. One lock order everywhere = no deadlocks, and
// concurrent operations on the same slot are serialized.
export async function lockSlot(tx: Prisma.TransactionClient, slotId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM availability_slots WHERE id = ${slotId}::uuid FOR UPDATE`;
}
