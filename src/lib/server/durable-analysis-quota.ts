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

/** Reserve one provider attempt before calling the paid Live provider. */
export async function reserveDailyLiveAnalysis(
  db: Firestore,
  uid: string,
  now = Date.now(),
  limits: DailyAnalysisQuotaLimits = DAILY_ANALYSIS_QUOTA,
): Promise<DailyAnalysisAdmission> {
  if (
    !uid ||
    !Number.isFinite(now) ||
    !Number.isSafeInteger(limits.perUser) ||
    limits.perUser < 1 ||
    !Number.isSafeInteger(limits.project) ||
    limits.project < 1
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

  return db.runTransaction(async (transaction) => {
    const [daySnapshot, userSnapshot] = await Promise.all([
      transaction.get(dayRef),
      transaction.get(userRef),
    ]);
    const projectCount = countFrom(daySnapshot.data());
    const userCount = countFrom(userSnapshot.data());
    if (projectCount >= limits.project || userCount >= limits.perUser) {
      return { allowed: false, retryAfterSeconds };
    }

    // Both counters share one transaction. Retries caused by contention cannot
    // over-admit either cap, and a rejected attempt performs no Firestore write.
    transaction.set(dayRef, { count: projectCount + 1 });
    transaction.set(userRef, { count: userCount + 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  });
}
