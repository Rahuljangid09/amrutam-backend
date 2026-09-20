import { Request, Response } from "express";
import { auditContext } from "../../common/audit";
import * as service from "./auth.service";

export async function register(req: Request, res: Response) {
  res.status(201).json({ user: await service.register(req.body, auditContext(req)) });
}

export async function login(req: Request, res: Response) {
  res.json(await service.login(req.body.email, req.body.password, auditContext(req)));
}

export async function refresh(req: Request, res: Response) {
  res.json(await service.refresh(req.body.refreshToken, auditContext(req)));
}

export async function logout(req: Request, res: Response) {
  await service.logout(req.body.refreshToken);
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  res.json({ user: await service.getMe(req.user!.id) });
}

export async function mfaSetup(req: Request, res: Response) {
  res.json(await service.mfaSetup(req.user!.id));
}

export async function mfaEnable(req: Request, res: Response) {
  await service.mfaEnable(req.user!.id, req.body.code, auditContext(req));
  res.json({ mfaEnabled: true });
}

export async function mfaDisable(req: Request, res: Response) {
  await service.mfaDisable(req.user!.id, req.body.password, req.body.code, auditContext(req));
  res.json({ mfaEnabled: false });
}

export async function mfaVerify(req: Request, res: Response) {
  res.json(await service.mfaVerifyLogin(req.body.mfaToken, req.body.code, auditContext(req)));
}
