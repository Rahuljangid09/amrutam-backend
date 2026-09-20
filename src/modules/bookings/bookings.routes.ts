import { Request, Response, Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idempotency } from "../../common/idempotency";
import { validate } from "../../common/validate";
import { createBookingSchema } from "./bookings.schema";
import * as service from "./bookings.service";

export const bookingsRouter = Router();

// Idempotency-Key is REQUIRED: a retried or double-clicked request must never create two bookings.
bookingsRouter.post("/", authenticate, authorize("PATIENT"), validate(createBookingSchema), idempotency({ required: true }), asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json(await service.createBooking(req.user!.id, req.body.slotId, auditContext(req)));
}));
