import type { Firestore } from "firebase-admin/firestore";
import { assertWritableMealSchema, mealCollection } from "@/lib/firebase/meals";
import { accountPath } from "@/lib/firebase/admin";
import type { MealRecord } from "@/lib/meals/types";
import { HttpError } from "@/lib/server/auth";

const LEASE_MS = 120_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[0-9a-f]{64}$/;

type ClaimOptions = {
  uid: string;
  mealId: string;
  mutationId: string;
  expectedVersion: number;
  fingerprint: string;
  nowMs?: number;
};

type AttemptMarker = {
  mutationId: string;
  expectedVersion: number;
  fingerprint: string;
  token: string;
  leaseUntil: number;
  state: "active" | "spent";
};

export type MealLookupAttempt =
  | { state: "committed"; record: MealRecord }
  | { state: "busy"; retryAfterSeconds: number }
  | { state: "claimed"; token: string }
  | { state: "fallback"; token: string };

function validUid(uid: string) {
  return uid.length > 0 && uid.length <= 128 && uid === uid.trim() && !uid.includes("/");
}

function validMarker(value: unknown): value is AttemptMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<AttemptMarker>;
  return (
    typeof marker.mutationId === "string" && uuid.test(marker.mutationId) &&
    Number.isSafeInteger(marker.expectedVersion) && marker.expectedVersion! >= 0 &&
    typeof marker.fingerprint === "string" && fingerprintPattern.test(marker.fingerprint) &&
    typeof marker.token === "string" && uuid.test(marker.token) &&
    Number.isSafeInteger(marker.leaseUntil) && marker.leaseUntil! >= 0 &&
    (marker.state === "active" || marker.state === "spent")
  );
}

function markerRef(db: Firestore, uid: string, mealId: string) {
  return db.doc(`${accountPath(uid)}/mealLookupAttempts/${mealId}`);
}

/**
 * A meal mutation can authorize external lookup only once. A retry after the
 * lease expires may save locally resolved food, but must not call USDA again.
 * The marker is intentionally durable and is replaced only by a different
 * mutation against the still-current meal version.
 */
export async function claimMealLookupAttempt(
  db: Firestore,
  options: ClaimOptions,
): Promise<MealLookupAttempt> {
  const { uid, mealId, mutationId, expectedVersion, fingerprint } = options;
  const nowMs = options.nowMs ?? Date.now();
  if (
    !validUid(uid) || !uuid.test(mealId) || !uuid.test(mutationId) ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    !fingerprintPattern.test(fingerprint) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0 ||
    !Number.isSafeInteger(nowMs + LEASE_MS)
  ) throw new HttpError(400, "invalid_request");

  const mealRef = mealCollection(db, uid).doc(mealId);
  const attemptRef = markerRef(db, uid, mealId);
  return db.runTransaction(async (tx): Promise<MealLookupAttempt> => {
    // Firestore transactions require all reads before their first write.
    const [mealSnapshot, attemptSnapshot] = await Promise.all([
      tx.get(mealRef), tx.get(attemptRef),
    ]);
    const previous = mealSnapshot.data();
    if (previous?.deleted) throw new HttpError(409, "conflict");
    if (previous?.mutationId === mutationId)
      return { state: "committed", record: previous.record as MealRecord };
    assertWritableMealSchema(previous?.record);
    if ((previous?.version ?? 0) !== expectedVersion)
      throw new HttpError(409, "conflict");

    const existing: unknown = attemptSnapshot.data();
    if (existing !== undefined && !validMarker(existing))
      throw new Error("Invalid meal lookup attempt state");
    if (existing) {
      if (existing.mutationId === mutationId) {
        if (
          existing.fingerprint !== fingerprint ||
          existing.expectedVersion !== expectedVersion
        ) throw new HttpError(409, "conflict");
        if (existing.state === "active" && existing.leaseUntil > nowMs)
          return {
            state: "busy",
            retryAfterSeconds: Math.max(1, Math.ceil((existing.leaseUntil - nowMs) / 1000)),
          };
        const token = crypto.randomUUID();
        tx.set(attemptRef, {
          mutationId, expectedVersion, fingerprint, token,
          leaseUntil: nowMs + LEASE_MS, state: "active",
        } satisfies AttemptMarker);
        return { state: "fallback", token };
      }
      if (existing.state === "active" && existing.leaseUntil > nowMs)
        return {
          state: "busy",
          retryAfterSeconds: Math.max(1, Math.ceil((existing.leaseUntil - nowMs) / 1000)),
        };
    }

    const token = crypto.randomUUID();
    tx.set(attemptRef, {
      mutationId, expectedVersion, fingerprint, token,
      leaseUntil: nowMs + LEASE_MS, state: "active",
    } satisfies AttemptMarker);
    return { state: "claimed", token };
  });
}

/** Mark a finished attempt spent without clearing a newer claim. */
export async function releaseMealLookupAttempt(
  db: Firestore,
  options: { uid: string; mealId: string; token: string },
): Promise<boolean> {
  const { uid, mealId, token } = options;
  if (!validUid(uid) || !uuid.test(mealId) || !uuid.test(token))
    throw new HttpError(400, "invalid_request");
  const ref = markerRef(db, uid, mealId);
  return db.runTransaction(async (tx) => {
    const value: unknown = (await tx.get(ref)).data();
    if (value === undefined) return false;
    if (!validMarker(value)) throw new Error("Invalid meal lookup attempt state");
    if (value.token !== token || value.state !== "active") return false;
    tx.set(ref, { ...value, state: "spent", leaseUntil: 0 } satisfies AttemptMarker);
    return true;
  });
}
