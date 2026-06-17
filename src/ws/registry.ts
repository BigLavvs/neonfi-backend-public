// Neonfi backend — WebSocket connection registry.
//
// In-memory tracking for connected sockets (retrofit-28: broadcast firehose).
// Per-socket symbol subscriptions are gone — the server broadcasts every price to
// every connected Pro client, so the only state we keep is socketId → ws and
// userId → socketIds (the latter drives plan_downgraded targeting).

import type { WebSocket } from 'ws';

/** userId → Set of socketIds */
export const socketsByUser = new Map<number, Set<string>>();
/** socketId → WebSocket instance */
export const wsBySocketId = new Map<string, WebSocket>();

export function registerSocket(socketId: string, userId: number, ws: WebSocket): void {
  wsBySocketId.set(socketId, ws);
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId)!.add(socketId);
}

export function unregisterSocket(socketId: string, userId: number): void {
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
}
