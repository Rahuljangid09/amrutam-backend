import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "./errors";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: Role; mfa: boolean };
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new AppError(401, "Missing token", "UNAUTHENTICATED"));
  }
  try {
    const payload = jwt.verify(header.slice(7), env.JWT_ACCESS_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    // an MFA challenge token must never work as an access token
    if (payload.typ !== "access" || !payload.sub) throw new Error("wrong token type");
    req.user = { id: payload.sub, role: payload.role as Role, mfa: payload.mfa === true };
    next();
  } catch {
    next(new AppError(401, "Invalid or expired token", "UNAUTHENTICATED"));
  }
}

// RBAC. When MFA_ENFORCE_STAFF is on, doctor and admin routes additionally need an MFA-verified session.
export const authorize =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, "Forbidden", "FORBIDDEN"));
    }
    if (env.MFA_ENFORCE_STAFF && req.user.role !== "PATIENT" && !req.user.mfa) {
      return next(new AppError(403, "MFA required: enable MFA and log in with a code", "MFA_REQUIRED"));
    }
    next();
  };
