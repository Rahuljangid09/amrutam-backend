import { z } from "zod";
import { uuidSchema } from "../../common/schemas";

export const createBookingSchema = z.object({ slotId: uuidSchema });
