import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft } from "@/lib/meals/types";
import { commitMeal, mealCollection } from "@/lib/firebase/meals";
import {
  MAX_PHOTO_JPEG_BYTES,
  finalizePhotoAsset,
  photoAssetRef,
  reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { runPhotoMaintenanceCycle } from "@/lib/firebase/photo-maintenance-runner";
import type { ExactPhotoMetadata } from "@/lib/firebase/photo-object-store";
import { HttpError } from "@/lib/server/auth";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-maintenance-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const identity = { bucketName: policy.bucketName, projectNumber: "123456789012" };
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");

async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-maint-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}

function makeObjects() {
  return {
    metadata: vi.fn(async (): Promise<ExactPhotoMetadata> => {
      throw new HttpError(503, "photo_storage_unavailable");
    }),
    read: vi.fn(async (): Promise<Uint8Array<ArrayBuffer>> => jpeg),
    deleteGeneration: vi.fn(async () => "deleted" as const),
    verifyGenerationAbsent: vi.fn(async () => "absent" as const),
    verifyKeyAbsent: vi.fn(async () => "absent" as const),
  };
}

describe("trusted background photo maintenance runner", () => {
  it("runs all 4 bounded phases cleanly, uses absence proof, and emits no PII/paths", async () => withDb(async (db) => {
    // 1. Expired unattached asset
    const expiredUid = "aa-expired";
    const expiredInput = {
      mealId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      inputSha256: "a".repeat(64),
      inputBytes: 1000,
    };
    await reservePhotoAsset(db, expiredUid, expiredInput, policy);
    await finalizePhotoAsset(db, expiredUid, expiredInput.uploadId, {
      bucketName: policy.bucketName,
      inputSha256: expiredInput.inputSha256,
      generation: "9007199254740993",
      jpegSha256,
      width: 2,
      height: 2,
      byteSize: jpeg.byteLength,
    });
    await photoAssetRef(db, expiredUid, expiredInput.uploadId).update({
      expiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });

    // 2. Attached asset on a tombstoned meal
    const orphanUid = "bb-tombstone";
    const draft = newDraft();
    const orphanUploadId = crypto.randomUUID();
    await reservePhotoAsset(db, orphanUid, {
      mealId: draft.id,
      uploadId: orphanUploadId,
      inputSha256: "a".repeat(64),
      inputBytes: 1000,
    }, policy);
    await finalizePhotoAsset(db, orphanUid, orphanUploadId, {
      bucketName: policy.bucketName,
      inputSha256: "a".repeat(64),
      generation: "9007199254740994",
      jpegSha256,
      width: 2,
      height: 2,
      byteSize: jpeg.byteLength,
    });
    await commitMeal(db, orphanUid, {
      ...draft,
      userId: orphanUid,
      version: 1,
      mutationId: crypto.randomUUID(),
      items: createEditableFoodItems(demoFoodAnalysis.foods),
    }, 0, { kind: "attach", uploadId: orphanUploadId });
    await mealCollection(db, orphanUid).doc(draft.id).set({
      deleted: true, version: 2, mutationId: crypto.randomUUID(),
    });

    const objects = makeObjects();
    objects.deleteGeneration.mockRejectedValueOnce(new HttpError(503, "photo_storage_unavailable"));
    const nowMs = Date.now();
    const result = await runPhotoMaintenanceCycle(db, objects, {
      maxItems: 5,
      absenceProof: identity,
      now: () => nowMs,
      sleep: async () => {},
    });

    expect(result.status).toBe("completed");
    expect(result.alert).toBe(false);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.staleOver24hCount).toBe(0);
    expect(result.phases).toEqual({
      expiry: { scanned: 1, processed: 1, errors: 0, errorCodes: [] },
      attachedTombstones: { scanned: 1, processed: 1, errors: 0, errorCodes: [] },
      deletingCleanup: { scanned: 2, processed: 2, errors: 0, errorCodes: [] },
      deletedReconcile: { scanned: 2, processed: 0, errors: 0, errorCodes: [] },
    });
    expect(JSON.stringify(result)).not.toContain(expiredUid);
    expect(JSON.stringify(result)).not.toContain(orphanUid);
    expect(objects.verifyGenerationAbsent).toHaveBeenCalledTimes(1);
    expect((await photoAssetRef(db, expiredUid, expiredInput.uploadId).get()).data()?.state).toBe("deleted");
    expect((await photoAssetRef(db, orphanUid, orphanUploadId).get()).data()?.state).toBe("deleted");
  }));

  it("rejects concurrent runs while an active lease is held", async () => withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    await db.doc("kcalcuePhotoMaintenance/current").set({
      leaseRunId: "active-run",
      leaseUntil: Timestamp.fromMillis(nowMs + 60_000),
    });
    await expect(runPhotoMaintenanceCycle(db, makeObjects(), { now: () => nowMs }))
      .rejects.toMatchObject({ status: 409, code: "photo_maintenance_busy" });
  }));

  it("enforces capped exponential backoff on repeated failures and alerts on >24h stale deleting assets", async () => withDb(async (db) => {
    const uid = "cc-stale";
    const input = {
      mealId: crypto.randomUUID(),
      uploadId: crypto.randomUUID(),
      inputSha256: "a".repeat(64),
      inputBytes: 1000,
    };
    await reservePhotoAsset(db, uid, input, policy);
    await finalizePhotoAsset(db, uid, input.uploadId, {
      bucketName: policy.bucketName,
      inputSha256: input.inputSha256,
      generation: "9007199254740995",
      jpegSha256,
      width: 2,
      height: 2,
      byteSize: jpeg.byteLength,
    });
    const nowMs = Date.now();
    await photoAssetRef(db, uid, input.uploadId).update({
      state: "deleting",
      updatedAt: Timestamp.fromMillis(nowMs - 25 * 60 * 60 * 1000),
    });

    const objects = makeObjects();
    objects.deleteGeneration.mockRejectedValue(new HttpError(503, "photo_storage_unavailable"));

    const first = await runPhotoMaintenanceCycle(db, objects, {
      now: () => nowMs,
      maxPhaseRetries: 1,
      retryDelayMs: 0,
      sleep: async () => {},
    });
    expect(first.status).toBe("completed");
    expect(first.alert).toBe(true);
    expect(first.staleOver24hCount).toBe(1);
    expect(first.consecutiveFailures).toBe(1);

    // Immediate next call respects the 60s backoff window.
    const backedOff = await runPhotoMaintenanceCycle(db, objects, {
      now: () => nowMs + 10_000,
      sleep: async () => {},
    });
    expect(backedOff).toMatchObject({
      status: "backoff",
      consecutiveFailures: 1,
      retryAfterMs: 50_000,
    });

    // After backoff expires and deletion succeeds, failure count resets.
    objects.deleteGeneration.mockResolvedValue("deleted");
    await photoAssetRef(db, uid, input.uploadId).update({
      updatedAt: Timestamp.fromMillis(nowMs),
    });
    const recovered = await runPhotoMaintenanceCycle(db, objects, {
      now: () => nowMs + 61_000,
      sleep: async () => {},
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.consecutiveFailures).toBe(0);
  }));
});
