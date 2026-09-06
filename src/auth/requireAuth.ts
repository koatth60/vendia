import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  next();
}
