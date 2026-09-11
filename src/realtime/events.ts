import { EventEmitter } from "node:events";

// Decouples the service layer from Socket.IO - conversation/service.ts and orders/service.ts emit
// domain events here without knowing a socket server exists; src/realtime/socket.ts is the only thing
// that listens and forwards into the right business's room. With no listeners attached (e.g. in tests,
// or before setupRealtime runs), emitting is a no-op - existing behavior is unaffected.
export const realtimeEvents = new EventEmitter();

export interface MessageEventPayload {
  id: string;
  role: "CUSTOMER" | "ASSISTANT" | "SYSTEM";
  content: string;
  mediaUrl: string | null;
  mediaType: "IMAGE" | "VIDEO" | "AUDIO" | null;
  createdAt: Date;
}

export interface ConversationRow {
  id: string;
  status: string;
  intent: string | null;
  humanControl: boolean;
  updatedAt: Date;
  unreadCount: number;
  customer: { id: string; phoneNumber: string; name: string | null; tags: string[] };
  lastMessage: { role: string; content: string; createdAt: Date } | null;
}

export function emitNewMessage(businessId: string, conversationId: string, message: MessageEventPayload, unreadCount: number): void {
  realtimeEvents.emit("message:new", businessId, { conversationId, message, unreadCount });
}

export function emitNewConversation(businessId: string, conversation: ConversationRow): void {
  realtimeEvents.emit("conversation:new", businessId, conversation);
}

export function emitConversationUpdated(businessId: string, conversation: ConversationRow): void {
  realtimeEvents.emit("conversation:updated", businessId, conversation);
}

// Lean on purpose - orders are low-frequency, and the frontend just refetches the orders list on
// either event rather than duplicating the orders-table row shape here.
export function emitOrderNew(businessId: string, orderId: string): void {
  realtimeEvents.emit("order:new", businessId, { id: orderId });
}

export function emitOrderUpdated(businessId: string, orderId: string): void {
  realtimeEvents.emit("order:updated", businessId, { id: orderId });
}
