import session from "express-session";
import { env } from "../config/env";

// Extracted from src/index.ts so the exact same middleware instance can also run on Socket.IO's
// handshake request (io.engine.use(sessionMiddleware)) - same cookie, same in-memory session store,
// no separate auth scheme to maintain for realtime connections.
export const sessionMiddleware = session({
  secret: env.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  },
});
