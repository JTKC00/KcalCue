import { beforeEach, describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { newDraft, type MealRecord } from "./types";
import {
  changeSyncState, changeSyncStateAndClearPhotos, clearSyncState,
  enqueuePhotoMeal, markPhotoUploadStaged, readPhotoPayload,
  type PendingMeal, type PhotoUploadIntent,
} from "./outbox";

const photo = (content: string) => new Blob([content], { type: "image/jpeg" });
const job = (uid: string, uploadId = crypto.randomUUID(), mutationId = crypto.randomUUID()):
  Omit<PendingMeal, "photoUpload"> & { photoUpload: Pick<PhotoUploadIntent, "uploadId" | "pipelineVersion"> } => {
  const record: MealRecord = {
    ...newDraft(), userId: uid, mutationId, updatedAt: "2026-09-27T00:00:00.000Z", version: 1,
  };
  return { id: mutationId, kind: "save", record, expectedVersion: 0,
    photoUpload: { uploadId, pipelineVersion: 1 } };
};
async function version() {
  return new Promise<number>((resolve, reject) => {
    const request = indexedDB.open("kcalcue-sync");
    request.onsuccess = () => {
      const value = request.result.version;
      request.result.close();
      resolve(value);
    };
    request.onerror = () => reject(request.error);
  });
}

beforeEach(async () => {
  await clearSyncState("a");
  await clearSyncState("b");
});

describe("photo outbox transaction", () => {
  it("upgrades only for a photo and commits the job with its JPEG Blob", async () => {
    const ordinary = job("a");
    await changeSyncState("a", (state) => ({ ...state, jobs: [{ ...ordinary, photoUpload: undefined }] }));
    expect(await version()).toBe(1);
    const queued = job("a");
    const bytes = photo("private image");
    const state = await enqueuePhotoMeal("a", queued, bytes);
    expect(await version()).toBe(2);
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs[1].photoUpload).toMatchObject({
      uploadId: queued.photoUpload.uploadId, pipelineVersion: 1, status: "pending",
      byteSize: bytes.size, sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const stored = await readPhotoPayload("a", queued.photoUpload.uploadId);
    expect(stored?.type).toBe("image/jpeg");
    expect(await stored?.text()).toBe("private image");
    expect((await changeSyncState("a")).jobs).toEqual(state.jobs);
  });

  it("reuses an exact mutation and bytes, preserving staged state; rejects changed intent or content", async () => {
    const first = job("a");
    await enqueuePhotoMeal("a", first, photo("same"));
    await markPhotoUploadStaged("a", first.photoUpload.uploadId);
    const retry = { ...first, record: { ...first.record, updatedAt: "2026-09-27T01:00:00.000Z" } };
    const reused = await enqueuePhotoMeal("a", retry, photo("same"));
    expect(reused.jobs).toHaveLength(1);
    expect(reused.jobs[0].photoUpload?.status).toBe("staged");
    await expect(enqueuePhotoMeal("a", retry, photo("different"))).rejects.toThrow("Conflicting photo mutation");
    await expect(enqueuePhotoMeal("a", { ...retry, record: { ...retry.record, time: "21:00" } }, photo("same")))
      .rejects.toThrow("Conflicting photo mutation");
    await expect(enqueuePhotoMeal("a", { ...retry, photoUpload: { ...retry.photoUpload, uploadId: crypto.randomUUID() } }, photo("same")))
      .rejects.toThrow("Conflicting photo mutation");
    expect((await changeSyncState("a")).jobs).toHaveLength(1);
    expect(await readPhotoPayload("a", first.photoUpload.uploadId)).not.toBeNull();
  });

  it("rejects a mutation already acknowledged by the server", async () => {
    const first = job("a");
    await enqueuePhotoMeal("a", first, photo("original"));
    await changeSyncStateAndClearPhotos("a", (state) => ({
      ...state, remote: [first.record], jobs: [],
    }), [first.photoUpload.uploadId]);
    const changed = { ...first, record: { ...first.record, time: "21:00" },
      photoUpload: { ...first.photoUpload, uploadId: crypto.randomUUID() } };
    await expect(enqueuePhotoMeal("a", changed, photo("replacement")))
      .rejects.toThrow("Mutation already acknowledged");
    const state = await changeSyncState("a");
    expect(state.jobs).toEqual([]);
    expect(state.remote).toEqual([first.record]);
    expect(await readPhotoPayload("a", changed.photoUpload.uploadId)).toBeNull();
  });

  it("clears an acknowledged photo atomically and leaves another UID alone", async () => {
    const a = job("a");
    const b = job("b", a.photoUpload.uploadId);
    await enqueuePhotoMeal("a", a, photo("a photo"));
    await enqueuePhotoMeal("b", b, photo("b photo"));
    await expect(changeSyncStateAndClearPhotos("a", (state) => state, [a.photoUpload.uploadId]))
      .rejects.toThrow("Cannot clear a queued photo payload");
    expect(await readPhotoPayload("a", a.photoUpload.uploadId)).not.toBeNull();
    await changeSyncStateAndClearPhotos("a", (state) => ({ ...state, jobs: [] }), [a.photoUpload.uploadId]);
    expect(await readPhotoPayload("a", a.photoUpload.uploadId)).toBeNull();
    expect(await (await readPhotoPayload("b", b.photoUpload.uploadId))?.text()).toBe("b photo");
    await clearSyncState("b");
    expect(await readPhotoPayload("b", b.photoUpload.uploadId)).toBeNull();
    expect((await changeSyncState("b")).jobs).toEqual([]);
  });

  it("rejects invalid JPEG size/type before writing a job or upgrading", async () => {
    const queued = job("a");
    const before = await version();
    await expect(enqueuePhotoMeal("a", queued, new Blob(["png"], { type: "image/png" })))
      .rejects.toThrow("Invalid photo upload intent");
    await expect(enqueuePhotoMeal("a", { ...queued, photoUpload: { uploadId: "not-a-uuid", pipelineVersion: 1 } }, photo("jpeg")))
      .rejects.toThrow("Invalid photo upload intent");
    await expect(enqueuePhotoMeal("a", { ...queued, photoUpload: { ...queued.photoUpload, pipelineVersion: 2 } }, photo("jpeg")))
      .rejects.toThrow("Invalid photo upload intent");
    expect(await version()).toBe(before);
    expect((await changeSyncState("a")).jobs).toEqual([]);
  });

  it("does not stage a job when its local Blob is missing", async () => {
    const queued = job("a");
    await enqueuePhotoMeal("a", queued, photo("private"));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kcalcue-sync");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("photoPayloads", "readwrite");
      tx.objectStore("photoPayloads").delete(["a", queued.photoUpload.uploadId]);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    await expect(markPhotoUploadStaged("a", queued.photoUpload.uploadId))
      .rejects.toThrow("Photo upload payload missing");
    expect((await changeSyncState("a")).jobs[0].photoUpload?.status).toBe("pending");
  });

  it("fails a blocked photo upgrade without leaving a queued job", async () => {
    const currentVersion = await version();
    const oldTab = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kcalcue-sync", currentVersion + 1);
      request.onupgradeneeded = () => {
        if (request.result.objectStoreNames.contains("photoPayloads"))
          request.result.deleteObjectStore("photoPayloads");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const queued = job("a");
      await expect(enqueuePhotoMeal("a", queued, photo("private")))
        .rejects.toThrow("Photo storage upgrade blocked by another tab");
    } finally {
      oldTab.close();
    }
    expect((await changeSyncState("a")).jobs).toEqual([]);
  });
});
