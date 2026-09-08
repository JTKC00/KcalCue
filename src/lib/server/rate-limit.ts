export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export const ANALYZE_RATE_LIMIT: RateLimitConfig = {
  limit: 5,
  windowMs: 60_000,
};

export const NUTRITION_RATE_LIMIT: RateLimitConfig = {
  limit: 20,
  windowMs: 60_000,
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const store = new Map<string, Bucket>();
const MAX_KEYS = 5_000;
const IDLE_MS = 5 * 60_000;

export function clearRateLimitStore() {
  store.clear();
}

export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = headers.get("x-real-ip")?.trim();
  return realIp || "unknown";
}

export function consumeRateLimit(
  key: string,
  config: RateLimitConfig,
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  prune(now);

  const refillPerMs = config.limit / config.windowMs;
  const existing = store.get(key);
  const elapsed = existing ? Math.max(0, now - existing.updatedAt) : config.windowMs;
  const tokens = Math.min(
    config.limit,
    (existing?.tokens ?? config.limit) + elapsed * refillPerMs,
  );

  if (tokens < 1) {
    store.set(key, { tokens, updatedAt: now });
    return { allowed: false, remaining: 0 };
  }

  const remaining = tokens - 1;
  store.set(key, { tokens: remaining, updatedAt: now });
  return { allowed: true, remaining: Math.floor(remaining) };
}

export function rateLimitedJsonResponse(retryAfterSeconds = 60) {
  return {
    body: { error: { code: "rate_limited" as const } },
    status: 429 as const,
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

function prune(now: number) {
  if (store.size < MAX_KEYS) return;

  for (const [key, bucket] of store) {
    if (now - bucket.updatedAt > IDLE_MS) store.delete(key);
  }

  if (store.size < MAX_KEYS) return;
  const excess = store.size - Math.floor(MAX_KEYS / 2);
  let removed = 0;
  for (const key of store.keys()) {
    store.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}
