import { RequestHandler } from "express";
import { ZodType } from "zod";

// Validates (and strips unknown fields from) the JSON body.
export const validate =
  (schema: ZodType): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
