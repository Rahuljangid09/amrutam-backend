import { Request, Response, Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idParamSchema } from "../../common/schemas";
import { validate } from "../../common/validate";
import { cancelSchema, completeSchema, listConsultationsQuerySchema } from "./consultations.schema";
import * as service from "./consultations.service";

export const consultationsRouter = Router();
const anyRole = authorize("PATIENT", "DOCTOR", "ADMIN");
const actorOf = (req: Request) => ({ id: req.user!.id, role: req.user!.role });

consultationsRouter.get("/", authenticate, anyRole, asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listConsultations(actorOf(req), listConsultationsQuerySchema.parse(req.query)));
}));

consultationsRouter.get("/:id", authenticate, anyRole, asyncHandler(async (req: Request, res: Response) => {
  res.json({ consultation: await service.getConsultation(actorOf(req), idParamSchema.parse(req.params).id, auditContext(req)) });
}));

consultationsRouter.post("/:id/cancel", authenticate, anyRole, validate(cancelSchema), asyncHandler(async (req: Request, res: Response) => {
  res.json({ consultation: await service.cancelConsultation(actorOf(req), idParamSchema.parse(req.params).id, req.body.reason, auditContext(req)) });
}));

consultationsRouter.post("/:id/start", authenticate, authorize("DOCTOR"), asyncHandler(async (req: Request, res: Response) => {
  res.json({ consultation: await service.startConsultation(req.user!.id, idParamSchema.parse(req.params).id, auditContext(req)) });
}));

consultationsRouter.post("/:id/complete", authenticate, authorize("DOCTOR"), validate(completeSchema), asyncHandler(async (req: Request, res: Response) => {
  res.json({ consultation: await service.completeConsultation(req.user!.id, idParamSchema.parse(req.params).id, req.body.notes, auditContext(req)) });
}));

consultationsRouter.post("/:id/no-show", authenticate, authorize("DOCTOR"), asyncHandler(async (req: Request, res: Response) => {
  res.json({ consultation: await service.markNoShow(req.user!.id, idParamSchema.parse(req.params).id, auditContext(req)) });
}));
