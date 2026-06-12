// Neonfi backend — Stripe SDK singleton (Stage 3A).
//
// Singleton rule (same as Prisma/Redis): no other file constructs new Stripe(...).
// The check-singletons.mjs guard enforces this at build time.
//
// API version is pinned to the SDK's LATEST_API_VERSION at install time so that
// Stripe's behavior is locked and changes only happen deliberately.

import Stripe from 'stripe';
import { config } from './config.js';

export const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
  apiVersion: '2026-05-27.dahlia',
  typescript: true,
});
