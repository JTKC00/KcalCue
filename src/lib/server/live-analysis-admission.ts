import { ANALYZE_RATE_LIMIT, type RateLimitConfig } from "./rate-limit";

const MAX_USERS = 5_000;

interface UserBucket {
  tokens: number;
  updatedAt: number;
  inFlight: boolean;
}

/** Process-local verified-UID work admission, not a durable spending cap. */
export function createUserWorkAdmission(config: RateLimitConfig) {
  // Keep verified-user quotas separate from the public IP limiter's eviction.
  const users = new Map<string, UserBucket>();
  const { limit, windowMs } = config;
  const availableTokens = (bucket: UserBucket, now: number) => Math.min(
    limit,
    bucket.tokens + Math.max(0, now - bucket.updatedAt) * limit / windowMs,
  );

  // Call only with a verified UID. Live analysis does so after image
  // validation; photo preparation does so before reading the body.
  return function acquire(uid: string): (() => void) | null {
    const now = Date.now();
    let bucket = users.get(uid);
    if (bucket?.inFlight) return null;

    if (!bucket) {
      if (users.size >= MAX_USERS) {
        for (const [key, candidate] of users) {
          if (!candidate.inFlight && availableTokens(candidate, now) === limit) {
            users.delete(key);
          }
        }
      }
      // Never evict active work or unexpired quota to admit another user.
      if (users.size >= MAX_USERS) return null;
      bucket = { tokens: limit, updatedAt: now, inFlight: false };
      users.set(uid, bucket);
    }

    const tokens = availableTokens(bucket, now);
    if (tokens < 1) return null;
    bucket.tokens = tokens - 1;
    bucket.updatedAt = now;
    bucket.inFlight = true;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      // An attempted provider call keeps its token even when its result is unknown.
      bucket.inFlight = false;
    };
  };
}

export function createLiveAnalysisAdmission() {
  return createUserWorkAdmission(ANALYZE_RATE_LIMIT);
}

export const acquireLiveAnalysis = createLiveAnalysisAdmission();
