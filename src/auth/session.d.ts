import "express-session";

declare module "express-session" {
  interface SessionData {
    businessId?: string;
    role?: "OWNER" | "EMPLOYEE";
  }
}
