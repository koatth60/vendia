import type { Request, Response, NextFunction } from "express";

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.platformAdmin) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  next();
}
