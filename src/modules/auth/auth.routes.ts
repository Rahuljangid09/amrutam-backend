import { Router } from "express";
import { asyncHandler } from "../../common/asyncHandler";
import { validate } from "../../common/validate";
import { authenticate } from "../../common/auth";
import { authLimiter } from "../../common/rateLimit";
import { loginSchema, mfaCodeSchema, mfaDisableSchema, mfaVerifySchema, refreshSchema, registerSchema } from "./auth.schema";
import * as c from "./auth.controller";

export const authRouter = Router();

authRouter.post("/register", authLimiter, validate(registerSchema), asyncHandler(c.register));
authRouter.post("/login", authLimiter, validate(loginSchema), asyncHandler(c.login));
authRouter.post("/refresh", authLimiter, validate(refreshSchema), asyncHandler(c.refresh));
authRouter.post("/logout", validate(refreshSchema), asyncHandler(c.logout));
authRouter.get("/me", authenticate, asyncHandler(c.me));

// MFA (TOTP)
authRouter.post("/mfa/setup", authenticate, asyncHandler(c.mfaSetup));
authRouter.post("/mfa/enable", authenticate, validate(mfaCodeSchema), asyncHandler(c.mfaEnable));
authRouter.post("/mfa/disable", authenticate, authLimiter, validate(mfaDisableSchema), asyncHandler(c.mfaDisable));
authRouter.post("/mfa/verify", authLimiter, validate(mfaVerifySchema), asyncHandler(c.mfaVerify));
