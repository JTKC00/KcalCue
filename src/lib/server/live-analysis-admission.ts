import { ANALYZE_RATE_LIMIT } from "./rate-limit";

const MAX_USERS = 5_000;

interface UserBucket {
  tokens: number;
  updatedAt: number;
  inFlight: boolean;
}

/** Process-local trial protection, not a durable or cross-instance spending cap. */
export function createLiveAnalysisAdmission() {
  // Keep verified-user quotas separate from the public IP limiter's eviction.
  const users = new Map<string, UserBucket>();
  const { limit, windowMs } = ANALYZE_RATE_LIMIT;
  const availableTokens = (bucket: UserBucket, now: number) => Math.min(
    limit,
    bucket.tokens + Math.max(0, now - bucket.updatedAt) * limit / windowMs,
  );

  // Call only with a verified UID, after validating the Live image.
  return function acquireLiveAnalysis(uid: string): (() => void) | null {
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

export const acquireLiveAnalysis = createLiveAnalysisAdmission();
