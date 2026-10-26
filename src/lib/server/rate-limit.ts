import { isIP } from "node:net";

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

export interface ClientIpTrustOptions {
  /**
   * Number of trusted reverse-proxy hops that append to X-Forwarded-For.
   * Defaults to KCALCUE_TRUSTED_PROXY_HOPS when set, or 0 (untrusted) when
   * multiple entry points with different hop counts are active.
   */
  trustedProxyHops?: number;
}

export const ANALYZE_RATE_LIMIT: RateLimitConfig = {
  limit: 5,
  windowMs: 60_000,
};

export const NUTRITION_RATE_LIMIT: RateLimitConfig = {
  limit: 20,
  windowMs: 60_000,
};

export const PHOTO_PREPARATION_RATE_LIMIT: RateLimitConfig = {
  limit: 12,
  windowMs: 60_000,
};

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const store = new Map<string, Bucket>();
const MAX_KEYS = 5_000;
const IDLE_MS = 5 * 60_000;
const MAX_FORWARDED_FOR_LENGTH = 512;
const MAX_FORWARDED_FOR_HOPS = 16;
const MAX_IP_TOKEN_LENGTH = 64;
const MAX_TRUSTED_PROXY_HOPS = 8;
const PROTECTED_KEYS = new Set(["analyze:anonymous", "nutrition:anonymous"]);

export function clearRateLimitStore() {
  store.clear();
}

function resolveTrustedProxyHops(options?: ClientIpTrustOptions): number {
  if (options?.trustedProxyHops !== undefined) {
    const hops = options.trustedProxyHops;
    return Number.isSafeInteger(hops) && hops >= 1 && hops <= MAX_TRUSTED_PROXY_HOPS
      ? hops
      : 0;
  }
  const raw = process.env.KCALCUE_TRUSTED_PROXY_HOPS?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_TRUSTED_PROXY_HOPS
    ? parsed
    : 0;
}

function normalizeIpAddress(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_IP_TOKEN_LENGTH) return null;
  const candidate =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (!candidate || candidate.includes("%")) return null;

  const version = isIP(candidate);
  if (version === 4) {
    return candidate === "0.0.0.0" ? null : candidate;
  }
  if (version !== 6) {
    return null;
  }

  let canonical: string;
  try {
    const host = new URL(`http://[${candidate}]`).hostname;
    if (!host.startsWith("[") || !host.endsWith("]")) return null;
    canonical = host.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
  if (canonical === "::") return null;

  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    return ipv4 === "0.0.0.0" ? null : ipv4;
  }
  return canonical;
}

export function clientIpFromHeaders(
  headers: Headers,
  options?: ClientIpTrustOptions,
): string {
  const trustedProxyHops = resolveTrustedProxyHops(options);
  if (trustedProxyHops < 1) return "unknown";

  const proto = headers.get("x-forwarded-proto");
  if (proto !== null) {
    const normalizedProto = proto.trim().toLowerCase();
    if (normalizedProto !== "https" && normalizedProto !== "http") {
      return "unknown";
    }
  }

  const forwarded = headers.get("x-forwarded-for");
  if (
    !forwarded ||
    forwarded.length > MAX_FORWARDED_FOR_LENGTH ||
    /[^\x20-\x7e]/.test(forwarded)
  ) {
    return "unknown";
  }

  const hops = forwarded.split(",").map((entry) => entry.trim());
  if (hops.length < trustedProxyHops || hops.length > MAX_FORWARDED_FOR_HOPS) {
    return "unknown";
  }

  const trustedChain = hops.slice(hops.length - trustedProxyHops);
  const normalizedChain: string[] = [];
  for (const hop of trustedChain) {
    const normalized = normalizeIpAddress(hop);
    if (!normalized) return "unknown";
    normalizedChain.push(normalized);
  }

  return normalizedChain[0];
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

function isProtectedKey(key: string): boolean {
  return (
    PROTECTED_KEYS.has(key) ||
    key.includes(":uid:") ||
    key.includes(":uid-reject:")
  );
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
    if (isProtectedKey(key)) continue;
    store.delete(key);
    removed += 1;
    if (removed >= excess) break;
  }
}
