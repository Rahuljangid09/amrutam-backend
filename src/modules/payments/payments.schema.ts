import { z } from "zod";

// Mock gateway: the client (or a test) chooses the outcome. A real integration replaces this
// with a provider webhook whose signature is verified.
export const payBodySchema = z.object({ outcome: z.enum(["success", "failure"]).default("success") });
