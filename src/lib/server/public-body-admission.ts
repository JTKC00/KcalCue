import type { RateLimitConfig } from "./rate-limit";

type PublicBodyRoute = "analyze" | "nutrition";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface Config {
  maxConcurrent: number;
  routes: Record<PublicBodyRoute, RateLimitConfig>;
}

const config: Config = {
  // The trial service allows four requests per instance. Leave capacity for
  // meal and status APIs even when public callers stall during body upload.
  maxConcurrent: 2,
  // These are broad process-local backstops, independent of forwarded IPs.
  // The narrower per-IP and durable paid-provider limits still apply.
  routes: {
    analyze: { limit: 60, windowMs: 60_000 },
    nutrition: { limit: 180, windowMs: 60_000 },
  },
};

export function createPublicBodyAdmission(settings: Config = config) {
  const buckets = new Map<PublicBodyRoute, Bucket>();
  let inFlight = 0;

  return function acquire(route: PublicBodyRoute):
    | { release: () => void; retryAfterSeconds?: never }
    | { release?: never; retryAfterSeconds: number } {
    if (inFlight >= settings.maxConcurrent) return { retryAfterSeconds: 5 };

    const now = Date.now();
    const { limit, windowMs } = settings.routes[route];
    const previous = buckets.get(route);
    const tokens = Math.min(limit,
      (previous?.tokens ?? limit) +
      Math.max(0, now - (previous?.updatedAt ?? now)) * limit / windowMs);
    if (tokens < 1) {
      buckets.set(route, { tokens, updatedAt: now });
      return { retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) * windowMs / limit / 1000)) };
    }

    buckets.set(route, { tokens: tokens - 1, updatedAt: now });
    inFlight++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        inFlight--;
      },
    };
  };
}

export const acquirePublicBody = createPublicBodyAdmission();
