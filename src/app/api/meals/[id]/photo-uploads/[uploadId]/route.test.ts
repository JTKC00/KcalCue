import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";
import { PHOTO_UPLOAD_RATE_LIMIT } from "@/lib/server/rate-limit";

const fixture = vi.hoisted(() => ({
  auth: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: fixture.auth,
}));
vi.mock("@/lib/firebase/photo-upload", () => ({
  uploadPrivateMealPhoto: fixture.upload,
}));

import { POST } from "./route";

const savedEnv = { ...process.env };

function enableUploadEnv() {
  process.env.KCALCUE_PHOTO_UPLOADS_ENABLED = "true";
  process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-upload-fixture";
  process.env.KCALCUE_PHOTO_MAX_PENDING_PER_UID = "5";
  process.env.KCALCUE_PHOTO_MAX_RESERVED_BYTES_PER_UID = "10485760";
  process.env.KCALCUE_PHOTO_MAX_RESERVED_BYTES_PROJECT = "104857600";
}

function makeContext(id = crypto.randomUUID(), uploadId = crypto.randomUUID()) {
  return { params: Promise.resolve({ id, uploadId }) };
}

describe("disabled-by-default private photo upload route", () => {
  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.KCALCUE_PHOTO_UPLOADS_ENABLED;
    delete process.env.KCALCUE_MEAL_PHOTO_BUCKET;
    delete process.env.KCALCUE_PHOTO_MAX_PENDING_PER_UID;
    delete process.env.KCALCUE_PHOTO_MAX_RESERVED_BYTES_PER_UID;
    delete process.env.KCALCUE_PHOTO_MAX_RESERVED_BYTES_PROJECT;
    fixture.auth.mockReset().mockResolvedValue({
      db: {},
      storage: { app: { options: { credential: { getAccessToken: vi.fn() } } } },
      user: { id: crypto.randomUUID() },
    });
    fixture.upload.mockReset();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("fails closed with 503 when disabled by default before parsing any body", async () => {
    const parse = vi.spyOn(Response.prototype, "formData");
    const response = await POST(
      new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST", body: "ignored" }),
      makeContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "photo_uploads_disabled" } });
    expect(parse).not.toHaveBeenCalled();
    expect(fixture.upload).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("fails closed with 503 when enabled without bounded quota configuration", async () => {
    process.env.KCALCUE_PHOTO_UPLOADS_ENABLED = "true";
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-upload-fixture";
    const response = await POST(
      new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST" }),
      makeContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "photo_quota_not_configured" } });
  });

  it("rejects unauthenticated requests and malformed route UUIDs", async () => {
    enableUploadEnv();
    fixture.auth.mockRejectedValueOnce(new HttpError(401, "login_required"));
    const unauth = await POST(
      new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST" }),
      makeContext(),
    );
    expect(unauth.status).toBe(401);

    const badIds = await POST(
      new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST" }),
      makeContext("not-a-uuid", "also-bad"),
    );
    expect(badIds.status).toBe(400);
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("rejects spoofed image files with zero storage upload calls", async () => {
    enableUploadEnv();
    const data = new FormData();
    data.set("image", new Blob(["not an image"], { type: "image/jpeg" }));
    const response = await POST(
      new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST", body: data }),
      makeContext(),
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: { code: "invalid_file" } });
    expect(fixture.upload).not.toHaveBeenCalled();
  });

  it("enforces per-UID admission limit before parsing multipart body", async () => {
    enableUploadEnv();
    const uid = crypto.randomUUID();
    fixture.auth.mockResolvedValue({
      db: {},
      storage: { app: { options: { credential: { getAccessToken: vi.fn() } } } },
      user: { id: uid },
    });
    for (let i = 0; i < PHOTO_UPLOAD_RATE_LIMIT.limit; i++) {
      const response = await POST(
        new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST", body: "invalid" }),
        makeContext(),
      );
      expect(response.status).toBe(400);
    }
    const blocked = await POST(
      new Request("http://localhost/api/meals/m/photo-uploads/u", { method: "POST", body: "invalid" }),
      makeContext(),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("10");
  });

  it("returns staged upload metadata with private no-store headers on valid upload", async () => {
    enableUploadEnv();
    const mealId = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const expiresAt = new Date("2026-11-27T00:00:00.000Z");
    const photoRef = {
      attachmentId: uploadId,
      generation: "9007199254740993",
      contentType: "image/jpeg" as const,
      width: 16,
      height: 12,
      byteSize: 512,
    };
    fixture.upload.mockResolvedValue({
      asset: {
        state: "staged",
        expiresAt: { toDate: () => expiresAt },
      },
      photoRef,
    });

    const source = await sharp({
      create: { width: 16, height: 12, channels: 3, background: "green" },
    }).jpeg().toBuffer();
    const data = new FormData();
    data.set("image", new Blob([new Uint8Array(source)], { type: "image/jpeg" }));

    const response = await POST(
      new Request(`http://localhost/api/meals/${mealId}/photo-uploads/${uploadId}`, {
        method: "POST",
        body: data,
      }),
      makeContext(mealId, uploadId),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      uploadId,
      state: "staged",
      photoRef,
      expiresAt: expiresAt.toISOString(),
    });
    expect(fixture.upload).toHaveBeenCalledTimes(1);
  });
});
