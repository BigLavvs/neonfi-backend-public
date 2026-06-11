// Neonfi backend — Auth module: plan-based access control (Stage 1A skeleton).
//
// This middleware is a no-op pass-through until Stage 3 (subscriptions module).
// It exists so future per-endpoint call sites can be wired now and activated in
// Stage 3 without touching every route file.
//
// TODO(Stage 3): once the Subscription module exists, read the user's active
// subscription plan and check it against `allowed`. Return 403 with code
// PLAN_REQUIRED if the user's plan is not in `allowed`. The user object is
// guaranteed to be on context by this point because requireAuth runs first.

import type { Context, Next, MiddlewareHandler } from 'hono';
import type { AuthEnv } from './middleware.js';

export const requirePlan =
  (_allowed: ('free' | 'pro')[]): MiddlewareHandler<AuthEnv> =>
  async (_c: Context<AuthEnv>, next: Next) => {
    await next();
  };
