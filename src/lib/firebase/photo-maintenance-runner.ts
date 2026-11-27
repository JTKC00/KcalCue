import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import type { ExactPhotoObjectStore, PhotoBucketIdentity } from "./photo-object-store";
import { runPhotoExpiryBatch } from "./photo-expiry-scanner";
import { runAttachedPhotoTombstoneBatch } from "./photo-attached-tombstone-scanner";
import { runDeletingPhotoCleanupBatch } from "./photo-cleanup-scanner";
import { runDeletedPhotoReconcileBatch } from "./photo-deleted-scanner";

const maintenancePath = "kcalcuePhotoMaintenance/current";
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_CYCLE_MS = 90_000;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 3_600_000;
const STALE_ALERT_FAILURE_THRESHOLD = 3;

export interface PhotoMaintenancePhaseSummary {
  scanned: number;
  processed: number;
  errors: number;
  errorCodes: string[];
}

export interface PhotoMaintenanceCycleResult {
  status: "completed" | "backoff";
  elapsedMs: number;
  alert: boolean;
  consecutiveFailures: number;
  retryAfterMs?: number;
  staleOver24hCount: number;
  budgetExceeded?: boolean;
  phases?: {
    expiry: PhotoMaintenancePhaseSummary;
    attachedTombstones: PhotoMaintenancePhaseSummary;
    deletingCleanup: PhotoMaintenancePhaseSummary;
    deletedReconcile: PhotoMaintenancePhaseSummary;
  };
}

export interface PhotoMaintenanceOptions {
  maxItems?: number;
  absenceProof?: PhotoBucketIdentity;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  leaseMs?: number;
  maxCycleMs?: number;
  maxPhaseRetries?: number;
  retryDelayMs?: number;
}

function isTransientBatchError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true;
  if (error.code === "photo_maintenance_lease_lost") return false;
  return error.status === 503 || error.status === 409;
}

async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  maxPhaseRetries: number,
  retryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
  canRetry?: () => Promise<boolean>,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxPhaseRetries || !isTransientBatchError(error)) {
        throw error;
      }
      if (canRetry && !(await canRetry())) {
        throw error;
      }
      attempt += 1;
      await sleep(retryDelayMs * attempt);
      if (canRetry && !(await canRetry())) {
        throw error;
      }
    }
  }
}

function summarizeOutcomes(
  outcomes: Array<{ result: string; code?: string }>,
  scanned: number,
  successResults: Set<string>,
): PhotoMaintenancePhaseSummary {
  const errorCodes = new Set<string>();
  let processed = 0;
  let errors = 0;
  for (const outcome of outcomes) {
    if (outcome.result === "error" || outcome.result === "invalid_path") {
      errors += 1;
      errorCodes.add(outcome.code ?? outcome.result);
    } else if (successResults.has(outcome.result)) {
      processed += 1;
    }
  }
  return {
    scanned,
    processed,
    errors,
    errorCodes: [...errorCodes],
  };
}

function failedPhaseSummary(error: unknown): PhotoMaintenancePhaseSummary {
  return {
    scanned: 0,
    processed: 0,
    errors: 1,
    errorCodes: [error instanceof HttpError ? error.code : "service_unavailable"],
  };
}

// Runs one bounded 4-phase photo maintenance cycle under a renewable Firestore
// lease with time budget enforcement, capped exponential backoff, and
// fail-closed monitoring metrics.
export async function runPhotoMaintenanceCycle(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read" | "deleteGeneration"> &
    Partial<Pick<ExactPhotoObjectStore, "verifyGenerationAbsent" | "verifyKeyAbsent">>,
  options: PhotoMaintenanceOptions = {},
): Promise<PhotoMaintenanceCycleResult> {
  const maxItems = options.maxItems ?? 5;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10)
    throw new HttpError(400, "invalid_photo_maintenance_batch");
  const leaseMs = Math.max(2_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  const maxCycleMs = Math.max(1_000, Math.min(options.maxCycleMs ?? DEFAULT_MAX_CYCLE_MS, leaseMs - 1_000));
  const maxPhaseRetries = Math.min(2, Math.max(0, options.maxPhaseRetries ?? 1));
  const retryDelayMs = options.retryDelayMs ?? 250;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startMs = now();
  const stateRef = db.doc(maintenancePath);
  const runId = crypto.randomUUID();

  const acquisition = await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    const data = snap.data();
    const leaseUntil = data?.leaseUntil instanceof Timestamp ? data.leaseUntil.toMillis() : 0;
    if (leaseUntil > startMs && typeof data?.leaseRunId === "string") {
      throw new HttpError(409, "photo_maintenance_busy");
    }
    const backoffUntil = data?.backoffUntil instanceof Timestamp ? data.backoffUntil.toMillis() : 0;
    const rawFailures = data?.consecutiveFailures;
    const consecutiveFailures = Number.isInteger(rawFailures) && (rawFailures as number) >= 0
      ? (rawFailures as number)
      : 0;
    if (backoffUntil > startMs) {
      return {
        backedOff: true as const,
        retryAfterMs: backoffUntil - startMs,
        consecutiveFailures,
      };
    }
    tx.set(stateRef, {
      leaseRunId: runId,
      leaseUntil: Timestamp.fromMillis(startMs + leaseMs),
      lastRunAt: Timestamp.fromMillis(startMs),
      consecutiveFailures,
    }, { merge: true });
    return { backedOff: false as const, consecutiveFailures };
  });

  if (acquisition.backedOff) {
    const result: PhotoMaintenanceCycleResult = {
      status: "backoff",
      elapsedMs: Math.max(0, now() - startMs),
      alert: acquisition.consecutiveFailures >= STALE_ALERT_FAILURE_THRESHOLD,
      consecutiveFailures: acquisition.consecutiveFailures,
      retryAfterMs: acquisition.retryAfterMs,
      staleOver24hCount: 0,
    };
    console.warn(JSON.stringify({ event: "photo_maintenance", ...result }));
    return result;
  }

  let leaseUntilMs = startMs + leaseMs;
  let expirySummary: PhotoMaintenancePhaseSummary = { scanned: 0, processed: 0, errors: 0, errorCodes: [] };
  let attachedSummary: PhotoMaintenancePhaseSummary = { scanned: 0, processed: 0, errors: 0, errorCodes: [] };
  let deletingSummary: PhotoMaintenancePhaseSummary = { scanned: 0, processed: 0, errors: 0, errorCodes: [] };
  let deletedSummary: PhotoMaintenancePhaseSummary = { scanned: 0, processed: 0, errors: 0, errorCodes: [] };
  let staleOver24hCount = 0;
  let budgetExceeded = false;

  async function renewLeaseIfWithinBudget(): Promise<boolean> {
    const currentMs = now();
    if (currentMs >= leaseUntilMs) {
      throw new HttpError(409, "photo_maintenance_lease_lost");
    }
    if (currentMs - startMs >= maxCycleMs) {
      budgetExceeded = true;
      return false;
    }
    await db.runTransaction(async (tx) => {
      const current = await tx.get(stateRef);
      const data = current.data();
      const storedLeaseUntil = data?.leaseUntil instanceof Timestamp ? data.leaseUntil.toMillis() : 0;
      if (data?.leaseRunId !== runId || storedLeaseUntil <= currentMs) {
        throw new HttpError(409, "photo_maintenance_lease_lost");
      }
      tx.set(stateRef, {
        leaseUntil: Timestamp.fromMillis(currentMs + leaseMs),
      }, { merge: true });
    });
    leaseUntilMs = currentMs + leaseMs;
    return true;
  }

  try {
    try {
      const expiry = await withBoundedRetry(
        () => runPhotoExpiryBatch(db, maxItems, Timestamp.fromMillis(now())),
        maxPhaseRetries, retryDelayMs, sleep, renewLeaseIfWithinBudget,
      );
      expirySummary = summarizeOutcomes(expiry.outcomes, expiry.scanned, new Set(["deleting"]));
    } catch (error) {
      if (error instanceof HttpError && error.code === "photo_maintenance_lease_lost") throw error;
      expirySummary = failedPhaseSummary(error);
    }

    if (!budgetExceeded && await renewLeaseIfWithinBudget()) {
      try {
        const attached = await withBoundedRetry(
          () => runAttachedPhotoTombstoneBatch(db, maxItems),
          maxPhaseRetries, retryDelayMs, sleep, renewLeaseIfWithinBudget,
        );
        attachedSummary = summarizeOutcomes(attached.outcomes, attached.scanned, new Set(["deleting"]));
      } catch (error) {
        if (error instanceof HttpError && error.code === "photo_maintenance_lease_lost") throw error;
        attachedSummary = failedPhaseSummary(error);
      }
    }

    if (!budgetExceeded && await renewLeaseIfWithinBudget()) {
      try {
        const deleting = await withBoundedRetry(
          () => runDeletingPhotoCleanupBatch(db, objects, maxItems, {
            absenceProof: options.absenceProof,
            nowMs: now(),
            beforeItem: renewLeaseIfWithinBudget,
          }),
          maxPhaseRetries, retryDelayMs, sleep, renewLeaseIfWithinBudget,
        );
        staleOver24hCount = deleting.staleOver24hCount;
        deletingSummary = summarizeOutcomes(
          deleting.outcomes,
          deleting.scanned,
          new Set(["deleted", "already_deleted"]),
        );
      } catch (error) {
        if (error instanceof HttpError && error.code === "photo_maintenance_lease_lost") throw error;
        deletingSummary = failedPhaseSummary(error);
      }
    }

    if (!budgetExceeded && await renewLeaseIfWithinBudget()) {
      try {
        const deleted = await withBoundedRetry(
          () => runDeletedPhotoReconcileBatch(db, objects, maxItems, {
            absenceProof: options.absenceProof,
            beforeItem: renewLeaseIfWithinBudget,
          }),
          maxPhaseRetries, retryDelayMs, sleep, renewLeaseIfWithinBudget,
        );
        deletedSummary = summarizeOutcomes(
          deleted.outcomes,
          deleted.scanned,
          new Set(["deleted_late_generation", "already_reconciled", "confirmed_absent"]),
        );
      } catch (error) {
        if (error instanceof HttpError && error.code === "photo_maintenance_lease_lost") throw error;
        deletedSummary = failedPhaseSummary(error);
      }
    }
  } finally {
    const finishMs = now();
    const totalErrors =
      expirySummary.errors +
      attachedSummary.errors +
      deletingSummary.errors +
      deletedSummary.errors;
    const nextFailures = totalErrors > 0 ? acquisition.consecutiveFailures + 1 : 0;
    const backoffMs = nextFailures > 0
      ? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** (nextFailures - 1)))
      : 0;

    await db.runTransaction(async (tx) => {
      const current = await tx.get(stateRef);
      if (current.data()?.leaseRunId !== runId) return;
      tx.set(stateRef, {
        leaseRunId: null,
        leaseUntil: null,
        consecutiveFailures: nextFailures,
        backoffUntil: backoffMs > 0 ? Timestamp.fromMillis(finishMs + backoffMs) : null,
        ...(totalErrors === 0 && !budgetExceeded ? { lastSucceededAt: Timestamp.fromMillis(finishMs) } : {}),
        lastSummary: {
          elapsedMs: Math.max(0, finishMs - startMs),
          staleOver24hCount,
          budgetExceeded,
          expiry: expirySummary,
          attachedTombstones: attachedSummary,
          deletingCleanup: deletingSummary,
          deletedReconcile: deletedSummary,
        },
      }, { merge: true });
    });
  }

  const totalErrors =
    expirySummary.errors +
    attachedSummary.errors +
    deletingSummary.errors +
    deletedSummary.errors;
  const consecutiveFailures = totalErrors > 0 ? acquisition.consecutiveFailures + 1 : 0;
  const alert =
    staleOver24hCount > 0 ||
    totalErrors > 0 ||
    budgetExceeded ||
    consecutiveFailures >= STALE_ALERT_FAILURE_THRESHOLD;

  const summary: PhotoMaintenanceCycleResult = {
    status: "completed",
    elapsedMs: Math.max(0, now() - startMs),
    alert,
    consecutiveFailures,
    staleOver24hCount,
    ...(budgetExceeded ? { budgetExceeded: true } : {}),
    phases: {
      expiry: expirySummary,
      attachedTombstones: attachedSummary,
      deletingCleanup: deletingSummary,
      deletedReconcile: deletedSummary,
    },
  };
  if (alert) {
    console.warn(JSON.stringify({ event: "photo_maintenance", ...summary }));
  } else {
    console.info(JSON.stringify({ event: "photo_maintenance", ...summary }));
  }
  return summary;
}
