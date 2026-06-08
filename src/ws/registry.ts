// Neonfi backend — WebSocket subscription registry (PLACEHOLDER).
//
// Real implementation: Stage 10. Holds the symbol→[socketIds] map in Redis (so
// the backend stays horizontally scalable) with reference-counted Coinbase
// subscriptions. Concrete Redis key/channel names are design-time and kept
// internal here (Appendix item 7).
export {};
