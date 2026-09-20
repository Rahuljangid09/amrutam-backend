import { Request, Response, Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { auditContext } from "../../common/audit";
import { authenticate, authorize } from "../../common/auth";
import { idempotency } from "../../common/idempotency";
import { idParamSchema } from "../../common/schemas";
import { validate } from "../../common/validate";
import { payBodySchema } from "./payments.schema";
import * as service from "./payments.service";

export const paymentsRouter = Router();

paymentsRouter.post("/:id/pay", authenticate, authorize("PATIENT"), validate(payBodySchema), idempotency({ required: true }), asyncHandler(async (req: Request, res: Response) => {
  const { id } = idParamSchema.parse(req.params);
  res.json(await service.payBooking(id, req.user!.id, req.body.outcome, auditContext(req)));
}));
