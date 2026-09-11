import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { sessionMiddleware } from "../auth/sessionMiddleware";
import { realtimeEvents } from "./events";

function businessRoom(businessId: string): string {
  return `business:${businessId}`;
}

// Runs express-session directly on the Socket.IO handshake request (Socket.IO 4.6+, engine.io
// middleware support) so a connecting browser tab authenticates with the exact same session cookie
// it already sends on every /admin/api/* fetch - no separate token scheme. A socket without
// session.businessId (not logged in, or a stale/expired session) never gets in.
export function setupRealtime(server: HttpServer): void {
  const io = new SocketIOServer(server);
  io.engine.use(sessionMiddleware);

  io.use((socket, next) => {
    const session = (socket.request as { session?: { businessId?: string } }).session;
    if (!session?.businessId) {
      next(new Error("unauthorized"));
      return;
    }
    next();
  });

  io.on("connection", (socket) => {
    const session = (socket.request as { session?: { businessId?: string } }).session;
    const businessId = session?.businessId;
    if (!businessId) {
      socket.disconnect(true);
      return;
    }
    socket.join(businessRoom(businessId));
  });

  const forward = (event: string) => (businessId: string, payload: unknown) => {
    io.to(businessRoom(businessId)).emit(event, payload);
  };

  realtimeEvents.on("message:new", forward("message:new"));
  realtimeEvents.on("conversation:new", forward("conversation:new"));
  realtimeEvents.on("conversation:updated", forward("conversation:updated"));
  realtimeEvents.on("order:new", forward("order:new"));
  realtimeEvents.on("order:updated", forward("order:updated"));
  realtimeEvents.on("delivery:failed", forward("delivery:failed"));
}
