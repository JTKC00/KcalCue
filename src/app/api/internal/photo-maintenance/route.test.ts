import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  admin: vi.fn(),
  runCycle: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  adminServices: fixture.admin,
}));
vi.mock("@/lib/firebase/photo-maintenance-runner", () => ({
  runPhotoMaintenanceCycle: fixture.runCycle,
}));

import { POST } from "./route";

const savedEnv = { ...process.env };
const validSecret = "a".repeat(32);

describe("internal photo maintenance route", () => {
  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.KCALCUE_MEAL_PHOTO_BUCKET;
    delete process.env.KCALCUE_MEAL_PHOTO_BUCKET_PROJECT_NUMBER;
    delete process.env.KCALCUE_PHOTO_MAINTENANCE_SECRET;
    fixture.admin.mockReset().mockReturnValue({
      db: {},
      storage: { app: { options: { credential: { getAccessToken: vi.fn() } } } },
    });
    fixture.runCycle.mockReset().mockResolvedValue({
      status: "completed",
      elapsedMs: 12,
      alert: false,
      consecutiveFailures: 0,
      staleOver24hCount: 0,
      phases: {
        expiry: { scanned: 0, processed: 0, errors: 0, errorCodes: [] },
        attachedTombstones: { scanned: 0, processed: 0, errors: 0, errorCodes: [] },
        deletingCleanup: { scanned: 0, processed: 0, errors: 0, errorCodes: [] },
        deletedReconcile: { scanned: 0, processed: 0, errors: 0, errorCodes: [] },
      },
    });
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("fails closed with 503 when bucket or maintenance secret is not configured", async () => {
    const response = await POST(
      new Request("http://localhost/api/internal/photo-maintenance", {
        method: "POST",
        headers: { Authorization: `Bearer ${validSecret}` },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "photo_maintenance_disabled" } });
    expect(fixture.runCycle).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid bearer authorization with 401", async () => {
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-maintenance-fixture";
    process.env.KCALCUE_PHOTO_MAINTENANCE_SECRET = validSecret;

    const missing = await POST(
      new Request("http://localhost/api/internal/photo-maintenance", { method: "POST" }),
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(
      new Request("http://localhost/api/internal/photo-maintenance", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-secret" },
      }),
    );
    expect(wrong.status).toBe(401);
    expect(fixture.runCycle).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON or out-of-range maxItems with 400", async () => {
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-maintenance-fixture";
    process.env.KCALCUE_PHOTO_MAINTENANCE_SECRET = validSecret;

    const bad = await POST(
      new Request("http://localhost/api/internal/photo-maintenance", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ maxItems: 99 }),
      }),
    );
    expect(bad.status).toBe(400);
    expect(fixture.runCycle).not.toHaveBeenCalled();
  });

  it("runs bounded maintenance with absenceProof when authorized", async () => {
    process.env.KCALCUE_MEAL_PHOTO_BUCKET = "private-maintenance-fixture";
    process.env.KCALCUE_MEAL_PHOTO_BUCKET_PROJECT_NUMBER = "123456789012";
    process.env.KCALCUE_PHOTO_MAINTENANCE_SECRET = validSecret;

    const response = await POST(
      new Request("http://localhost/api/internal/photo-maintenance", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${validSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ maxItems: 5 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(fixture.runCycle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        maxItems: 5,
        absenceProof: {
          bucketName: "private-maintenance-fixture",
          projectNumber: "123456789012",
        },
      },
    );
  });
});
