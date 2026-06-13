// Neonfi backend — WebSocket subscription registry.
//
// In-memory tracking for connected sockets and their symbol subscriptions.
// Per-socket symbol sets drive reference-counted Coinbase subscriptions and
// Redis subs:SYMBOL SETs (see server.ts §1.3 for refcount logic).

import type { WebSocket } from 'ws';

/** userId → Set of socketIds */
export const socketsByUser = new Map<number, Set<string>>();
/** socketId → WebSocket instance */
export const wsBySocketId = new Map<string, WebSocket>();
/** socketId → symbols this socket is subscribed to */
export const symbolsBySocket = new Map<string, Set<string>>();

export function registerSocket(socketId: string, userId: number, ws: WebSocket): void {
  wsBySocketId.set(socketId, ws);
  symbolsBySocket.set(socketId, new Set());
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId)!.add(socketId);
}

export function unregisterSocket(socketId: string, userId: number): void {
  symbolsBySocket.delete(socketId);
  wsBySocketId.delete(socketId);
  const userSockets = socketsByUser.get(userId);
  if (userSockets) {
    userSockets.delete(socketId);
    if (userSockets.size === 0) socketsByUser.delete(userId);
  }
}

export function clearRegistry(): void {
  socketsByUser.clear();
  wsBySocketId.clear();
  symbolsBySocket.clear();
}
