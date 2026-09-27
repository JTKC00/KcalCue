import { describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  MAX_PHOTO_JPEG_BYTES, expireUnattachedPhotoAsset, finalizePhotoAsset,
  photoAssetRef, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { runDeletingPhotoCleanupBatch } from "@/lib/firebase/photo-cleanup-scanner";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-cleanup-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-scan-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}
async function deleting(db: Firestore, uid: string, known: boolean) {
  const input = { mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    inputSha256: "a".repeat(64), inputBytes: 1000 };
  await reservePhotoAsset(db, uid, input, policy);
  await photoAssetRef(db, uid, input.uploadId).update({
    expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  });
  await expireUnattachedPhotoAsset(db, uid, input.uploadId);
  if (known) await finalizePhotoAsset(db, uid, input.uploadId, {
    bucketName: policy.bucketName, inputSha256: input.inputSha256,
    generation: "9007199254740993", jpegSha256: "b".repeat(64),
    width: 640, height: 480, byteSize: 100_000,
  });
  return input;
}

describe("bounded private photo cleanup scanner", () => {
  it("checkpoints a poison page and wraps after reaching the end", async () => withDb(async (db) => {
    const poison = await deleting(db, "aa-poison", false);
    const good = await deleting(db, "bb-good", true);
    const objects = { deleteGeneration: vi.fn(async () => "deleted" as const) };
    const first = await runDeletingPhotoCleanupBatch(db, objects, 1);
    expect(first).toMatchObject({ scanned: 1, wrapped: false,
      outcomes: [{ result: "awaiting_generation" }] });
    expect(first.cursor).toContain(`/${poison.uploadId}`);
    expect(objects.deleteGeneration).not.toHaveBeenCalled();
    const second = await runDeletingPhotoCleanupBatch(db, objects, 1); // Same durable cursor, new worker invocation.
    expect(second).toMatchObject({ scanned: 1, wrapped: false,
      outcomes: [{ result: "deleted" }] });
    expect(second.cursor).toContain(`/${good.uploadId}`);
    expect(objects.deleteGeneration).toHaveBeenCalledTimes(1);
    const third = await runDeletingPhotoCleanupBatch(db, objects, 1);
    expect(third).toMatchObject({ scanned: 1, wrapped: true,
      outcomes: [{ result: "awaiting_generation" }] });
  }));

  it("skips a foreign photoAssets path without using its claimed owner, then advances", async () => withDb(async (db) => {
    const foreign = db.doc(`aaa/foreign/photoAssets/${crypto.randomUUID()}`);
    await foreign.set({ state: "deleting", ownerUid: "bb-good" });
    const good = await deleting(db, "bb-good", true);
    const objects = { deleteGeneration: vi.fn(async () => "deleted" as const) };
    expect((await runDeletingPhotoCleanupBatch(db, objects, 1)).outcomes)
      .toEqual([{ path: foreign.path, result: "invalid_path" }]);
    expect(objects.deleteGeneration).not.toHaveBeenCalled();
    expect((await runDeletingPhotoCleanupBatch(db, objects, 1)).outcomes)
      .toEqual([{ path: photoAssetRef(db, "bb-good", good.uploadId).path, result: "deleted" }]);
  }));

  it("rejects a corrupt persisted cursor and unbounded batch input", async () => withDb(async (db) => {
    const objects = { deleteGeneration: vi.fn(async () => "deleted" as const) };
    await expect(runDeletingPhotoCleanupBatch(db, objects, 11))
      .rejects.toMatchObject({ status: 400, code: "invalid_photo_cleanup_batch" });
    await db.doc("kcalcuePhotoCleanup/current").set({ lastPath: "../wrong" });
    await expect(runDeletingPhotoCleanupBatch(db, objects, 1))
      .rejects.toMatchObject({ status: 503, code: "photo_cleanup_cursor_corrupt" });
    expect(objects.deleteGeneration).not.toHaveBeenCalled();
  }));
});
