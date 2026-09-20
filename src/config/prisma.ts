import { PrismaClient } from "@prisma/client";

// One shared client: a client per request would exhaust database connections.
export const prisma = new PrismaClient();
