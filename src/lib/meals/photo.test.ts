// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const authorizedFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/firebase/client", () => ({ authorizedFetch }));
import { PhotoPreparationError, preparePhoto } from "./photo";

beforeEach(() => {
  authorizedFetch.mockReset();
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("decode unavailable")));
});
afterEach(() => vi.unstubAllGlobals());

it("passes a server pixel-limit response to the photo UI as a typed error", async () => {
  authorizedFetch.mockResolvedValue(Response.json(
    { error: { code: "image_dimensions_too_large" } }, { status: 413 },
  ));
  const file = new File(["phone photo"], "meal.jpg", { type: "image/jpeg" });

  await expect(preparePhoto(file, crypto.randomUUID())).rejects.toMatchObject({
    code: "image_dimensions_too_large",
  });
  expect(authorizedFetch).toHaveBeenCalledOnce();
});

it("keeps unknown server failures generic and retryable", async () => {
  authorizedFetch.mockResolvedValue(Response.json(
    { error: { code: "service_unavailable" } }, { status: 503 },
  ));
  const file = new File(["phone photo"], "meal.jpg", { type: "image/jpeg" });

  await expect(preparePhoto(file, crypto.randomUUID())).rejects.toEqual(
    new PhotoPreparationError("photo_failed"),
  );
});

it("preserves a preparation rate-limit response for a delayed retry notice", async () => {
  authorizedFetch.mockResolvedValue(Response.json(
    { error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "10" } },
  ));
  const file = new File(["phone photo"], "meal.jpg", { type: "image/jpeg" });

  await expect(preparePhoto(file, crypto.randomUUID())).rejects.toEqual(
    new PhotoPreparationError("photo_rate_limited"),
  );
});
