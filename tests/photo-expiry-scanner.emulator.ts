import { describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import {
  MAX_PHOTO_JPEG_BYTES, finalizePhotoAsset, photoAssetRef, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { runPhotoExpiryBatch } from "@/lib/firebase/photo-expiry-scanner";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-expiry-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-expiry-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}
async function reserved(db: Firestore, uid: string, expiresAt: Timestamp, staged = false) {
  const input = { mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    inputSha256: "a".repeat(64), inputBytes: 1000 };
  await reservePhotoAsset(db, uid, input, policy);
  if (staged) await finalizePhotoAsset(db, uid, input.uploadId, {
    bucketName: policy.bucketName, inputSha256: input.inputSha256,
    generation: "9007199254740993", jpegSha256: "b".repeat(64),
    width: 640, height: 480, byteSize: 100_000,
  });
  const ref = photoAssetRef(db, uid, input.uploadId);
  await ref.update({ expiresAt });
  return ref;
}

describe("bounded abandoned photo reservation expiry", () => {
  it("transitions expired uploading/staged assets without touching future or attached assets", async () => withDb(async (db) => {
    const past = Timestamp.fromMillis(Date.now() - 10_000);
    const future = Timestamp.fromMillis(Date.now() + 10_000);
    const uploading = await reserved(db, "aa-owner", past);
    const staged = await reserved(db, "bb-owner", past, true);
    const unexpired = await reserved(db, "cc-owner", future);
    const attached = await reserved(db, "dd-owner", past, true);
    await attached.update({ state: "attached" });
    const result = await runPhotoExpiryBatch(db, 10);
    expect(result.scanned).toBe(2);
    expect(result.outcomes.map((outcome) => outcome.result)).toEqual(["deleting", "deleting"]);
    expect((await uploading.get()).data()?.state).toBe("deleting");
    expect((await staged.get()).data()?.state).toBe("deleting");
    expect((await unexpired.get()).data()?.state).toBe("uploading");
    expect((await attached.get()).data()?.state).toBe("attached");
    for (const uid of ["aa-owner", "bb-owner"]) {
      expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
        pendingCount: 0, reservedBytes: MAX_PHOTO_JPEG_BYTES,
      });
    }
    expect((await runPhotoExpiryBatch(db, 10)).scanned).toBe(0);
    expect((await db.doc(`${accountPath("aa-owner")}/photoQuota/current`).get()).data()?.pendingCount)
      .toBe(0);
  }));

  it("persists pagination through a foreign path and wraps to the poison item", async () => withDb(async (db) => {
    const past = Timestamp.fromMillis(Date.now() - 10_000);
    const foreign = db.doc(`aaa/foreign/photoAssets/${crypto.randomUUID()}`);
    await foreign.set({ state: "uploading", expiresAt: past, ownerUid: "bb-owner" });
    const good = await reserved(db, "bb-owner", past);
    const first = await runPhotoExpiryBatch(db, 1);
    expect(first.outcomes).toEqual([{ path: foreign.path, result: "invalid_path" }]);
    const second = await runPhotoExpiryBatch(db, 1);
    expect(second.outcomes).toEqual([{ path: good.path, result: "deleting" }]);
    const third = await runPhotoExpiryBatch(db, 1);
    expect(third.wrapped).toBe(true);
    expect(third.outcomes).toEqual([{ path: foreign.path, result: "invalid_path" }]);
  }));

  it("rejects a corrupt cursor and oversized batch", async () => withDb(async (db) => {
    await expect(runPhotoExpiryBatch(db, 11))
      .rejects.toMatchObject({ status: 400, code: "invalid_photo_expiry_batch" });
    await db.doc("kcalcuePhotoExpiry/current").set({ lastPath: "wrong", lastExpiresAt: Timestamp.now() });
    await expect(runPhotoExpiryBatch(db, 1))
      .rejects.toMatchObject({ status: 503, code: "photo_expiry_cursor_corrupt" });
  }));
});
