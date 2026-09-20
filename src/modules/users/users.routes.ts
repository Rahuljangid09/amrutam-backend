import { Router } from "express";
import { Request, Response } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate } from "../../common/auth";
import { validate } from "../../common/validate";
import { authLimiter } from "../../common/rateLimit";
import { changePasswordSchema, updateProfileSchema } from "./users.schema";
import * as service from "./users.service";

export const usersRouter = Router();

usersRouter.get("/me", authenticate, asyncHandler(async (req: Request, res: Response) => {
  res.json({ user: await service.getProfile(req.user!.id) });
}));

usersRouter.patch("/me", authenticate, validate(updateProfileSchema), asyncHandler(async (req: Request, res: Response) => {
  res.json({ user: await service.updateProfile(req.user!.id, req.body, auditContext(req)) });
}));

usersRouter.post("/me/password", authenticate, authLimiter, validate(changePasswordSchema), asyncHandler(async (req: Request, res: Response) => {
  await service.changePassword(req.user!.id, req.body, auditContext(req));
  res.status(204).send();
}));
