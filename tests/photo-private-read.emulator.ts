import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { newDraft, type MealRecord, type PhotoRef } from "@/lib/meals/types";
import { MAX_PHOTO_JPEG_BYTES, reservePhotoAsset, finalizePhotoAsset } from "@/lib/firebase/photo-assets";
import { readPrivatePhoto } from "@/lib/firebase/photo-read";

const fixture = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), authenticated: fixture.auth,
}));
import { POST } from "@/app/api/meals/route";
import { GET } from "@/app/api/meals/[id]/photo/route";
import { DELETE } from "@/app/api/meals/[id]/route";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const app = initializeApp({ projectId: "demo-kcalcue-photo-read" }, "photo-read-emulator-test");
const db = getFirestore(app);
const previousBucket = process.env.KCALCUE_MEAL_PHOTO_BUCKET;
const policy = {
  uploadsEnabled: true,
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const inputSha = "a".repeat(64);
let bytes = Buffer.from("fixture jpeg bytes");
const storage = {
  bucket: vi.fn((bucket: string) => ({
    file: vi.fn((key: string, options: { generation: number }) => ({
      createReadStream: vi.fn((readOptions: unknown) => {
        fixture.read(bucket, key, options.generation, readOptions);
        return Readable.from([bytes]);
      }),
    })),
  })),
};
function asUid(uid: string) {
  fixture.auth.mockResolvedValue({ db, storage, user: { id: uid } });
}
function draft() {
  return { ...newDraft(), mutationId: crypto.randomUUID(),
    items: createEditableFoodItems(demoFoodAnalysis.foods) };
}
function post(payload: unknown) {
  return POST(new Request("http://localhost/api/meals", {
    method: "POST", body: JSON.stringify(payload),
  }));
}
function photo(id: string) {
  return GET(new Request(`http://localhost/api/meals/${id}/photo`),
    { params: Promise.resolve({ id }) });
}
async function attached(uid: string) {
  asUid(uid);
  const first = draft();
  const uploadId = crypto.randomUUID();
  await reservePhotoAsset(db, uid, {
    mealId: first.id, uploadId, inputSha256: inputSha, inputBytes: 1000,
  }, policy);
  await finalizePhotoAsset(db, uid, uploadId, {
    inputSha256: inputSha, generation: "112233445566", width: 10, height: 10,
    jpegSha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length,
  });
  const response = await post({ ...first, photoAction: { kind: "attach", uploadId } });
  expect(response.status).toBe(200);
  return (await response.json()).record as MealRecord;
}
afterAll(async () => {
  if (previousBucket === undefined) delete process.env.KCALCUE_MEAL_PHOTO_BUCKET;
  else process.env.KCALCUE_MEAL_PHOTO_BUCKET = previousBucket;
  await db.terminate();
  await deleteApp(app);
});

describe("authenticated private History photo read", () => {
  it("serves only the attached generation with private no-store headers", async () => {
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-meal-fixture";
    bytes = Buffer.from("fixture jpeg bytes");
    const uid = `owner-${crypto.randomUUID()}`;
    const record = await attached(uid);
    fixture.read.mockClear();
    const response = await photo(record.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(fixture.read).toHaveBeenCalledWith(
      "private-meal-fixture", expect.stringContaining(`/${record.id}/`),
      112233445566, { validation: "crc32c" },
    );
  });

  it("hides cross-account, absent and deleted meals before touching Storage", async () => {
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-meal-fixture";
    bytes = Buffer.from("fixture jpeg bytes");
    const uid = `owner-${crypto.randomUUID()}`;
    const record = await attached(uid);
    fixture.read.mockClear();
    asUid(`other-${crypto.randomUUID()}`);
    expect((await photo(record.id)).status).toBe(404);
    expect((await photo(crypto.randomUUID())).status).toBe(404);
    expect(fixture.read).not.toHaveBeenCalled();
    asUid(uid);
    const deletion = await DELETE(new Request(
      `http://localhost/api/meals/${record.id}?version=${record.version}&mutationId=${crypto.randomUUID()}`,
      { method: "DELETE" },
    ), { params: Promise.resolve({ id: record.id }) });
    expect(deletion.status).toBe(200);
    expect((await photo(record.id)).status).toBe(404);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("fails closed when bucket is unset or object bytes do not match the registry", async () => {
    bytes = Buffer.from("fixture jpeg bytes");
    const uid = `owner-${crypto.randomUUID()}`;
    const record = await attached(uid);
    delete process.env.KCALCUE_MEAL_PHOTO_BUCKET;
    fixture.read.mockClear();
    expect((await photo(record.id)).status).toBe(503);
    expect(fixture.read).not.toHaveBeenCalled();
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-meal-fixture";
    bytes = Buffer.from("tampered bytes");
    const mismatch = await photo(record.id);
    expect(mismatch.status).toBe(503);
    expect((await mismatch.json()).error.code).toBe("photo_unavailable");
  });

  it("requires authentication before Firestore or Storage access", async () => {
    const { HttpError } = await import("@/lib/server/auth");
    fixture.auth.mockRejectedValueOnce(new HttpError(401, "login_required"));
    fixture.read.mockClear();
    const response = await photo(crypto.randomUUID());
    expect(response.status).toBe(401);
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("rejects a generation the installed Storage SDK would round", async () => {
    storage.bucket.mockClear();
    const ref: PhotoRef = {
      attachmentId: crypto.randomUUID(), generation: "9007199254740993",
      contentType: "image/jpeg", width: 10, height: 10, byteSize: bytes.length,
    };
    await expect(readPrivatePhoto(
      storage as never, "private-meal-fixture", "private-key", ref,
      createHash("sha256").update(bytes).digest("hex"),
    )).rejects.toMatchObject({ status: 503, code: "photo_unavailable" });
    expect(storage.bucket).not.toHaveBeenCalled();
    await expect(readPrivatePhoto(
      storage as never, "private-meal-fixture", "private-key",
      { ...ref, generation: "0" }, createHash("sha256").update(bytes).digest("hex"),
    )).rejects.toMatchObject({ status: 503, code: "photo_unavailable" });
    expect(storage.bucket).not.toHaveBeenCalled();
  });

  it("stops an oversized or already-cancelled object read", async () => {
    const ref: PhotoRef = {
      attachmentId: crypto.randomUUID(), generation: "112233445566",
      contentType: "image/jpeg", width: 10, height: 10, byteSize: 12,
    };
    bytes = Buffer.alloc(13, 0x41);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    await expect(readPrivatePhoto(
      storage as never, "private-meal-fixture", "private-key", ref, expectedHash,
    )).rejects.toMatchObject({ status: 503, code: "photo_unavailable" });
    const controller = new AbortController();
    controller.abort();
    await expect(readPrivatePhoto(
      storage as never, "private-meal-fixture", "private-key", ref, expectedHash,
      controller.signal,
    )).rejects.toMatchObject({ status: 503, code: "photo_unavailable" });
  });
});
