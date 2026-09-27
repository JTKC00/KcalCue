import { describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import {
  MAX_PHOTO_JPEG_BYTES, finalizePhotoAsset, photoAssetRef, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { HttpError } from "@/lib/server/auth";

const fixture = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: fixture.auth,
}));
import { POST } from "@/app/api/meals/photo/status/route";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-status-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-status-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}
function request(input: { mealId: string; uploadId: string; inputSha256: string; inputBytes: number }) {
  return new Request("http://localhost/api/meals/photo/status", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
async function reservation(db: Firestore, uid: string) {
  const input = { mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    inputSha256: "a".repeat(64), inputBytes: 1000 };
  await reservePhotoAsset(db, uid, input, policy);
  return input;
}

describe("owner-bound private photo registry status", () => {
  it("returns only the exact reservation state without revealing private object metadata or writing", async () => withDb(async (db) => {
    const uid = "status-owner";
    fixture.auth.mockResolvedValue({ db, user: { id: uid } });
    const input = await reservation(db, uid);
    const ref = photoAssetRef(db, uid, input.uploadId);
    const before = await ref.get();
    const pending = await POST(request(input));
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("private, no-store");
    expect(await pending.json()).toEqual({ registryState: "uploading" });
    expect((await ref.get()).updateTime?.isEqual(before.updateTime!)).toBe(true);

    await finalizePhotoAsset(db, uid, input.uploadId, {
      bucketName: policy.bucketName, inputSha256: input.inputSha256,
      generation: "9007199254740993", jpegSha256: "b".repeat(64),
      width: 640, height: 480, byteSize: 100_000,
    });
    expect(await (await POST(request(input))).json()).toEqual({ registryState: "staged" });
    await ref.update({ state: "deleting" });
    expect(await (await POST(request(input))).json()).toEqual({ registryState: "deleting" });
    await ref.update({ state: "deleted" });
    expect(await (await POST(request(input))).json()).toEqual({ registryState: "deleted" });
  }));

  it("rejects another UID, changed meal or input, invalid body and unauthenticated access", async () => withDb(async (db) => {
    const uid = "original-owner";
    const input = await reservation(db, uid);
    fixture.auth.mockResolvedValue({ db, user: { id: "other-owner" } });
    expect((await POST(request(input))).status).toBe(404);
    fixture.auth.mockResolvedValue({ db, user: { id: uid } });
    for (const changed of [
      { ...input, mealId: crypto.randomUUID() },
      { ...input, inputSha256: "b".repeat(64) },
      { ...input, inputBytes: input.inputBytes + 1 },
    ]) {
      const response = await POST(request(changed));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "photo_upload_conflict" } });
    }
    const invalid = await POST(new Request("http://localhost/api/meals/photo/status", {
      method: "POST", body: "{}",
    }));
    expect(invalid.status).toBe(400);
    const oversized = await POST(new Request("http://localhost/api/meals/photo/status", {
      method: "POST", body: " ".repeat(513),
    }));
    expect(oversized.status).toBe(413);
    const extra = await POST(new Request("http://localhost/api/meals/photo/status", {
      method: "POST", body: JSON.stringify({ ...input, bucketName: "leak" }),
    }));
    expect(extra.status).toBe(400);
    fixture.auth.mockRejectedValueOnce(new HttpError(401, "login_required"));
    expect((await POST(request(input))).status).toBe(401);
  }));

  it("fails closed on corrupt staged metadata instead of claiming upload completion", async () => withDb(async (db) => {
    const uid = "corrupt-owner";
    fixture.auth.mockResolvedValue({ db, user: { id: uid } });
    const input = await reservation(db, uid);
    const ref = photoAssetRef(db, uid, input.uploadId);
    await ref.update({ state: "staged", generation: null });
    const response = await POST(request(input));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "photo_registry_corrupt" } });
    expect((await ref.get()).data()?.state).toBe("staged");
  }));
});
