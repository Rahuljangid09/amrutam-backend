export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "APP_ERROR",
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new AppError(404, `${what} not found`, "NOT_FOUND");
export const forbidden = (message = "Forbidden") => new AppError(403, message, "FORBIDDEN");
export const conflict = (message: string, code: string) => new AppError(409, message, code);
