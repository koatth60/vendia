import type { Request, Response, NextFunction } from "express";

export function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (req.session.role !== "OWNER") {
    res.status(403).json({ error: "Esta accion es solo para el dueño de la cuenta" });
    return;
  }
  next();
}
