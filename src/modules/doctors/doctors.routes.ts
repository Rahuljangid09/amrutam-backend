import { Request, Response, Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idempotency } from "../../common/idempotency";
import { idParamSchema } from "../../common/schemas";
import { validate } from "../../common/validate";
import { createDoctorSchema, listDoctorsQuerySchema, updateDoctorSchema } from "./doctors.schema";
import * as service from "./doctors.service";

export const doctorsRouter = Router();

// admin creates doctors (public sign-up can only create patients)
doctorsRouter.post("/", authenticate, authorize("ADMIN"), validate(createDoctorSchema), idempotency({ required: false }), asyncHandler(async (req: Request, res: Response) => {
  res.status(201).json({ doctor: await service.createDoctor(req.body, auditContext(req)) });
}));

// doctor edits their own fee / bio
doctorsRouter.patch("/me", authenticate, authorize("DOCTOR"), validate(updateDoctorSchema), asyncHandler(async (req: Request, res: Response) => {
  res.json({ doctor: await service.updateOwnDoctorProfile(req.user!.id, req.body, auditContext(req)) });
}));

// search + filter + pagination
doctorsRouter.get("/", authenticate, asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listDoctors(listDoctorsQuerySchema.parse(req.query)));
}));

doctorsRouter.get("/:id", authenticate, asyncHandler(async (req: Request, res: Response) => {
  res.json({ doctor: await service.getDoctor(idParamSchema.parse(req.params).id) });
}));
