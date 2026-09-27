import { createHash } from "node:crypto";
import type { DocumentData, Firestore } from "firebase-admin/firestore";

export const DAILY_ANALYSIS_QUOTA = {
  perUser: 50,
  project: 1_000,
} as const;

export interface DailyAnalysisQuotaLimits {
  perUser: number;
  project: number;
}

export interface DailyAnalysisAdmission {
  allowed: boolean;
  retryAfterSeconds: number;
  duplicate?: "same" | "mismatch";
}

export interface AnalysisAttempt {
  id: string;
  imageDigest: string;
}

function countFrom(data: DocumentData | undefined): number {
  if (!data) return 0;
  const count: unknown = data.count;
  // Corrupt or unexpected quota state must never silently reset the cap.
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new Error("Invalid analysis quota state");
  }
  return count as number;
}

const ATTEMPT_RETENTION_MS = 48 * 60 * 60 * 1_000;
const MAX_ATTEMPTS_PER_USER = 200;

interface StoredAttempt {
  imageDigest: string;
  createdAt: number;
}

function attemptsFrom(data: DocumentData | undefined): Record<string, StoredAttempt> {
  const attempts: unknown = data?.attempts;
  if (attempts === undefined) return {};
  if (!attempts || typeof attempts !== "object" || Array.isArray(attempts))
    throw new Error("Invalid analysis attempt state");
  if (Object.keys(attempts).length > MAX_ATTEMPTS_PER_USER)
    throw new Error("Invalid analysis attempt state");
  for (const [key, entry] of Object.entries(attempts)) {
    if (!/^[0-9a-f]{64}$/.test(key) || !entry || typeof entry !== "object" || Array.isArray(entry) ||
      !/^[0-9a-f]{64}$/.test((entry as StoredAttempt).imageDigest) ||
      !Number.isSafeInteger((entry as StoredAttempt).createdAt))
      throw new Error("Invalid analysis attempt state");
  }
  return attempts as Record<string, StoredAttempt>;
}

/** Reserve one provider attempt before calling the paid Live provider. */
export async function reserveDailyLiveAnalysis(
  db: Firestore,
  uid: string,
  now = Date.now(),
  limits: DailyAnalysisQuotaLimits = DAILY_ANALYSIS_QUOTA,
  attempt?: AnalysisAttempt,
): Promise<DailyAnalysisAdmission> {
  if (
    !uid ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(limits.perUser) ||
    limits.perUser < 1 ||
    !Number.isSafeInteger(limits.project) ||
    limits.project < 1 ||
    (attempt !== undefined &&
      (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempt.id) ||
        !/^[0-9a-f]{64}$/.test(attempt.imageDigest)))
  ) {
    throw new Error("Invalid analysis quota input");
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const nextDay = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
  const retryAfterSeconds = Math.max(1, Math.ceil((nextDay - now) / 1_000));
  const dayRef = db.collection("kcalcueAnalysisUsage").doc(day);
  // Never persist raw UID in a spending-control path.
  const userRef = dayRef
    .collection("users")
    .doc(createHash("sha256").update(uid).digest("hex"));
  // Every UTC day contends on this one private, bounded per-user document.
  // Reading and writing it in the quota transaction closes the midnight race.
  const ledgerRef = db.collection("kcalcueAnalysisAttemptLedger").doc(userRef.id);
  const attemptKey = attempt
    ? createHash("sha256").update(uid).update("\0").update(attempt.id.toLowerCase()).digest("hex")
    : null;

  return db.runTransaction(async (transaction) => {
    const [daySnapshot, userSnapshot, ledgerSnapshot] = await Promise.all([
      transaction.get(dayRef),
      transaction.get(userRef),
      attempt ? transaction.get(ledgerRef) : Promise.resolve(null),
    ]);
    const projectCount = countFrom(daySnapshot.data());
    const userCount = countFrom(userSnapshot.data());
    const attempts = attempt ? attemptsFrom(ledgerSnapshot?.data()) : {};
    if (attempt && attemptKey) {
      const known = attempts[attemptKey];
      if (known && known.createdAt >= now - ATTEMPT_RETENTION_MS) return {
        allowed: false,
        retryAfterSeconds: 0,
        duplicate: known.imageDigest === attempt.imageDigest ? "same" : "mismatch",
      };
    }
    if (projectCount >= limits.project || userCount >= limits.perUser) {
      return { allowed: false, retryAfterSeconds };
    }

    // Both counters share one transaction. Retries caused by contention cannot
    // over-admit either cap, and a rejected attempt performs no Firestore write.
    transaction.set(dayRef, { count: projectCount + 1 });
    transaction.set(userRef, { count: userCount + 1 });
    if (attempt && attemptKey) {
      const retained = Object.fromEntries(Object.entries(attempts)
        .filter(([, entry]) => entry.createdAt >= now - ATTEMPT_RETENTION_MS));
      const updated = { ...retained, [attemptKey]: { imageDigest: attempt.imageDigest, createdAt: now } };
      if (Object.keys(updated).length > MAX_ATTEMPTS_PER_USER)
        throw new Error("Invalid analysis attempt state");
      transaction.set(ledgerRef, { attempts: updated });
    }
    return { allowed: true, retryAfterSeconds: 0 };
  });
}
