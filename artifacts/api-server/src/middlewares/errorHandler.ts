import { Request, Response, NextFunction } from "express";

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  req.log.error({ err }, "Unhandled error");
  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
}
