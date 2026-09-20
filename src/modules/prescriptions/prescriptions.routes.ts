import { Request, Response, Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idempotency } from "../../common/idempotency";
import { idParamSchema, pageQuery } from "../../common/schemas";
import { validate } from "../../common/validate";
import { createPrescriptionSchema } from "./prescriptions.schema";
import * as service from "./prescriptions.service";

export const prescriptionsRouter = Router();
const listQuery = z.object(pageQuery);

// doctor issues a prescription for their consultation (Idempotency-Key required)
prescriptionsRouter.post("/consultations/:id/prescription", authenticate, authorize("DOCTOR"), validate(createPrescriptionSchema), idempotency({ required: true }), asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ prescription: await service.createPrescription(req.user!.id, idParamSchema.parse(req.params).id, req.body, auditContext(req)) });
}));

// patient or issuing doctor reads it (audited)
prescriptionsRouter.get("/consultations/:id/prescription", authenticate, authorize("PATIENT", "DOCTOR"), asyncHandler(async (req: Request, res: Response) => {
  res.json({ prescription: await service.getPrescription({ id: req.user!.id, role: req.user!.role }, idParamSchema.parse(req.params).id, auditContext(req)) });
}));

prescriptionsRouter.get("/prescriptions", authenticate, authorize("PATIENT", "DOCTOR"), asyncHandler(async (req: Request, res: Response) => {
  const q = listQuery.parse(req.query);
  res.json(await service.listMine({ id: req.user!.id, role: req.user!.role }, q.page, q.limit));
}));
