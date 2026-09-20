import { Request, Response, Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idParamSchema } from "../../common/schemas";
import { validate } from "../../common/validate";
import { auditQuerySchema, listUsersQuerySchema, rangeQuerySchema, topDoctorsQuerySchema, updateUserSchema } from "./admin.schema";
import * as analytics from "./analytics.service";
import * as service from "./admin.service";

export const adminRouter = Router();
adminRouter.use(authenticate, authorize("ADMIN"));

adminRouter.get("/analytics/overview", asyncHandler(async (req: Request, res: Response) => {
  const q = rangeQuerySchema.parse(req.query);
  res.json(await analytics.overview(q.from, q.to));
}));

adminRouter.get("/analytics/daily", asyncHandler(async (req: Request, res: Response) => {
  const q = rangeQuerySchema.parse(req.query);
  res.json(await analytics.dailyStats(q.from, q.to));
}));

adminRouter.get("/analytics/top-doctors", asyncHandler(async (req: Request, res: Response) => {
  const q = topDoctorsQuerySchema.parse(req.query);
  res.json(await analytics.topDoctors(q.from, q.to, q.limit));
}));

adminRouter.get("/audit-logs", asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listAuditLogs(auditQuerySchema.parse(req.query)));
}));

adminRouter.get("/users", asyncHandler(async (req: Request, res: Response) => {
  res.json(await service.listUsers(listUsersQuerySchema.parse(req.query)));
}));

adminRouter.patch("/users/:id", validate(updateUserSchema), asyncHandler(async (req: Request, res: Response) => {
  res.json({ user: await service.updateUser(req.user!.id, idParamSchema.parse(req.params).id, req.body, auditContext(req)) });
}));
