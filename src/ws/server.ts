// Neonfi backend — client-facing WebSocket server (PLACEHOLDER).
//
// TODO(Stage 10): start the WSS server here. The WS server is NOT started in
// Part 1. Stage 10 implements: ticket-validated handshake (`?token=`, single-use,
// consumed; 4001 on bad ticket), Pro-only gating (free users rejected 403),
// the symbol→[socketIds] registry (ws/registry.ts), Redis pub/sub fan-out, and
// the §2.7 message envelopes (subscribe / price_update / reconnect /
// plan_downgraded / error). Also GET /ws/health (per §6.4).
export {};
