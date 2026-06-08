// Neonfi backend — standard response envelopes (Build Guide §2.3 / §0.4).
//
// Success: { data, meta? }   Error: { error: { code, message } }
// The frontend reads `err.error.code` / `err.error.message` (lib/api.ts). Never
// leak stack traces — in production the error formatter emits generic messages.

export interface SuccessEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export function ok<T>(data: T, meta?: Record<string, unknown>): SuccessEnvelope<T> {
  return meta === undefined ? { data } : { data, meta };
}

export function err(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}
