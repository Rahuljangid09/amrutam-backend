import { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "./errors";

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: "VALIDATION_ERROR", message: "Invalid input", details: err.issues },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) },
    });
    return;
  }
  // body-parser errors (malformed JSON, payload too large) carry a 4xx status
  const status = (err as { status?: number }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const code = (err as { type?: string }).type === "entity.too.large" ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST";
    res.status(status).json({ error: { code, message: status === 413 ? "Payload too large" : "Malformed request" } });
    return;
  }

  // Unexpected: log everything, tell the client nothing.
  req.log.error({ err }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong" } });
};
