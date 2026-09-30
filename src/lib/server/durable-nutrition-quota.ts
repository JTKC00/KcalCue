import { createHash } from "node:crypto";
import type { DocumentData, Firestore } from "firebase-admin/firestore";

export const HOURLY_USDA_QUOTA = {
  perUser: 120,
  project: 600,
} as const;

export interface HourlyUsdaQuotaLimits {
  perUser: number;
  project: number;
}

export interface HourlyUsdaAdmission {
  allowed: boolean;
  retryAfterSeconds: number;
}

function countFrom(data: DocumentData | undefined): number {
  if (!data) return 0;
  const count: unknown = data.count;
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    // Never reset a corrupt counter and accidentally admit paid provider work.
    throw new Error("Invalid USDA quota state");
  }
  return count as number;
}

/** Reserve one USDA provider call across all server instances before fetching. */
export async function reserveHourlyUsdaCall(
  db: Firestore,
  uid: string,
  now = Date.now(),
  limits: HourlyUsdaQuotaLimits = HOURLY_USDA_QUOTA,
): Promise<HourlyUsdaAdmission> {
  if (
    typeof uid !== "string" ||
    !uid.trim() ||
    !Number.isSafeInteger(now) ||
    !Number.isFinite(new Date(now).getTime()) ||
    !Number.isSafeInteger(limits?.perUser) ||
    limits.perUser < 1 ||
    !Number.isSafeInteger(limits?.project) ||
    limits.project < 1
  ) {
    throw new Error("Invalid USDA quota input");
  }

  const hour = new Date(now).toISOString().slice(0, 13);
  const nextHour = Date.parse(`${hour}:00:00.000Z`) + 3_600_000;
  const retryAfterSeconds = Math.max(1, Math.ceil((nextHour - now) / 1_000));
  const hourRef = db.collection("kcalcueUsdaUsage").doc(hour);
  const userRef = hourRef
    .collection("users")
    .doc(createHash("sha256").update(uid).digest("hex"));

  return db.runTransaction(async (transaction) => {
    const [hourSnapshot, userSnapshot] = await Promise.all([
      transaction.get(hourRef),
      transaction.get(userRef),
    ]);
    const projectCount = countFrom(hourSnapshot.data());
    const userCount = countFrom(userSnapshot.data());
    if (projectCount >= limits.project || userCount >= limits.perUser) {
      return { allowed: false, retryAfterSeconds };
    }

    // A rejected reservation writes nothing; concurrent transactions retry
    // against the committed count rather than over-admitting either cap.
    transaction.set(hourRef, { count: projectCount + 1 });
    transaction.set(userRef, { count: userCount + 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  });
}
