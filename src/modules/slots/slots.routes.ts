import { Request, Response, Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idempotency } from "../../common/idempotency";
import { validate } from "../../common/validate";
import { createSlotsSchema, doctorIdParamSchema, listSlotsQuerySchema, mySlotsQuerySchema, slotIdParamSchema } from "./slots.schema";
import * as service from "./slots.service";

export const slotsRouter = Router();

slotsRouter.post("/slots", authenticate, authorize("DOCTOR"), validate(createSlotsSchema), idempotency({ required: false }), asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ slots: await service.createSlots(req.user!.id, req.body, auditContext(req)) });
}));

slotsRouter.delete("/slots/:id", authenticate, authorize("DOCTOR"), asyncHandler(async (req: Request, res: Response) => {
  await service.cancelSlot(req.user!.id, slotIdParamSchema.parse(req.params).id, auditContext(req));
  res.status(204).send();
}));

// must be registered before "/doctors/:doctorId/slots" so "me" is not read as an id
slotsRouter.get("/doctors/me/slots", authenticate, authorize("DOCTOR"), asyncHandler(async (req: Request, res: Response) => {
  res.json({ slots: await service.listOwnSlots(req.user!.id, mySlotsQuerySchema.parse(req.query)) });
}));

slotsRouter.get("/doctors/:doctorId/slots", authenticate, asyncHandler(async (req: Request, res: Response) => {
  const { doctorId } = doctorIdParamSchema.parse(req.params);
  res.json({ slots: await service.listAvailableSlots(doctorId, listSlotsQuerySchema.parse(req.query)) });
}));
