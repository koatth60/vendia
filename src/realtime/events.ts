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
  // `name` es el autoritativo y editable; `displayName` es lo que se pinta (name -> nombre de perfil de
  // WhatsApp -> numero). Van los dos porque el panel EDITA name pero MUESTRA displayName: si mandaramos
  // uno solo, abrir "editar nombre" precargaria el nombre de WhatsApp como si el dueno lo hubiera puesto.
  customer: { id: string; phoneNumber: string; name: string | null; displayName: string; tags: string[] };
  lastMessage: { role: string; content: string; createdAt: Date } | null;
}

// One row per customer for the admin panel's Conversaciones list, grouping that customer's
// Conversation rows (see [[onix-conversations-group-by-customer]]) so a customer whose last sale
// already closed doesn't show up as a second, unrelated-looking row the next time they write in.
// `cycles` is the compact per-conversation list the frontend needs to map an incoming
// conversationId (from message:new/conversation:updated) back to the customer row it belongs to,
// without a second fetch.
export interface CustomerRow {
  customerId: string;
  activeConversationId: string;
  status: string;
  intent: string | null;
  humanControl: boolean;
  updatedAt: Date;
  unreadCount: number;
  orderCount: number;
  // `name` es el autoritativo y editable; `displayName` es lo que se pinta (name -> nombre de perfil de
  // WhatsApp -> numero). Van los dos porque el panel EDITA name pero MUESTRA displayName: si mandaramos
  // uno solo, abrir "editar nombre" precargaria el nombre de WhatsApp como si el dueno lo hubiera puesto.
  customer: { id: string; phoneNumber: string; name: string | null; displayName: string; tags: string[] };
  lastMessage: { role: string; content: string; createdAt: Date } | null;
  cycles: { id: string; status: string; updatedAt: Date }[];
}

export function emitNewMessage(
  businessId: string,
  conversationId: string,
  customerId: string,
  message: MessageEventPayload,
  unreadCount: number
): void {
  realtimeEvents.emit("message:new", businessId, { conversationId, customerId, message, unreadCount });
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

export interface DeliveryFailureRow {
  id: string;
  recipientPhone: string;
  errorMessage: string;
  critical: boolean;
  createdAt: Date;
}

export function emitDeliveryFailure(businessId: string, failure: DeliveryFailureRow): void {
  realtimeEvents.emit("delivery:failed", businessId, failure);
}
