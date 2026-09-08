/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyzeImage = vi.fn();

vi.mock("@/lib/providers/food-vision/factory", () => ({
  createFoodVisionProvider: () => ({
    id: "openai",
    mode: "live",
    analyzeImage,
  }),
}));

vi.mock("@/lib/server/env", () => ({
  getOpenAIServerConfig: () => ({
    apiKey: "test-only-key",
    model: "gpt-5.6-luna",
  }),
}));

import { FoodVisionError } from "@/lib/providers/food-vision/errors";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { ANALYZE_RATE_LIMIT, clearRateLimitStore } from "@/lib/server/rate-limit";
import { POST } from "./route";

function imageRequest(
  bytes: Uint8Array,
  name = "meal.jpg",
  type = "image/jpeg",
  headers?: HeadersInit,
) {
  const form = new FormData();
  const blobBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(blobBytes).set(bytes);
  form.set("image", new File([blobBytes], name, { type }));
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers,
    body: form,
  });
}

function jpegRequest(name = "meal.jpg", type = "image/jpeg", headers?: HeadersInit) {
  return imageRequest(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), name, type, headers);
}

function heifBytes(brand = "mif1"): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set([..."ftyp"].map((character) => character.charCodeAt(0)), 4);
  bytes.set([...brand].map((character) => character.charCodeAt(0)), 8);
  bytes.set([..."mif1"].map((character) => character.charCodeAt(0)), 16);
  return bytes;
}

describe("POST /api/analyze", () => {
  beforeEach(() => {
    analyzeImage.mockReset();
    clearRateLimitStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs demo mode without requiring or reading an image", async () => {
    const form = new FormData();
    form.set("mode", "demo");

    const response = await POST(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        body: form,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("demo");
    expect(body.analysis.analysisStatus).toBe("success");
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("returns a missing-image error for live requests without a file", async () => {
    const form = new FormData();

    const response = await POST(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        body: form,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ error: { code: "missing_image" } });
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("returns a validated live analysis", async () => {
    analyzeImage.mockResolvedValueOnce(demoFoodAnalysis);

    const response = await POST(jpegRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("live");
    expect(body.analysis.analysisStatus).toBe("success");
    expect(analyzeImage).toHaveBeenCalledWith(
      {
        data: expect.any(String),
        mimeType: "image/jpeg",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("maps provider errors to public-safe status codes only", async () => {
    analyzeImage.mockRejectedValueOnce(
      new FoodVisionError("invalid_response", "OpenAI returned malformed JSON.", {
        diagnostic: {
          stage: "parse_json",
          errorClass: "SyntaxError",
          httpStatus: null,
          openaiErrorCode: null,
          safeMessage: "OpenAI returned malformed JSON.",
          model: "gpt-5.6-luna",
          imageMimeType: "image/jpeg",
          imageByteSize: 4,
        },
      }),
    );

    const response = await POST(jpegRequest());
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toEqual({ error: { code: "invalid_response" } });
    expect(JSON.stringify(body)).not.toContain("malformed JSON");
  });

  it("logs a development diagnostic for untyped failures without leaking secrets", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    analyzeImage.mockRejectedValueOnce(
      new Error("boom OPENAI_API_KEY=sk-proj-ShouldNeverAppearInLogs12345"),
    );

    const response = await POST(jpegRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: { code: "unknown" } });
    expect(spy).toHaveBeenCalled();
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("[kcalcue:food-vision]");
    expect(logged).toContain("image/jpeg");
    expect(logged).not.toContain("sk-proj-ShouldNeverAppearInLogs12345");
    expect(logged).not.toContain("test-only-key");
  });

  it("accepts raw HEIC bytes and forwards the detected MIME type", async () => {
    analyzeImage.mockResolvedValueOnce(demoFoodAnalysis);

    const response = await POST(imageRequest(heifBytes("heic"), "meal.heic", "image/heic"));

    expect(response.status).toBe(200);
    expect(analyzeImage).toHaveBeenCalledWith(
      {
        data: expect.any(String),
        mimeType: "image/heic",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("recovers when a browser leaves the MIME type blank", async () => {
    analyzeImage.mockResolvedValueOnce(demoFoodAnalysis);

    const response = await POST(imageRequest(heifBytes(), "meal.heif", ""));

    expect(response.status).toBe(200);
    expect(analyzeImage).toHaveBeenCalledWith(
      {
        data: expect.any(String),
        mimeType: "image/heif",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("rejects bytes that are not a supported image container", async () => {
    const response = await POST(
      imageRequest(new Uint8Array([1, 2, 3, 4]), "meal.heic", "image/heic"),
    );
    const body = await response.json();

    expect(response.status).toBe(415);
    expect(body).toEqual({ error: { code: "invalid_file" } });
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("returns 429 after the analyze rate limit is exceeded", async () => {
    analyzeImage.mockResolvedValue(demoFoodAnalysis);
    const headers = { "x-forwarded-for": "203.0.113.40, 10.0.0.1" };

    for (let index = 0; index < ANALYZE_RATE_LIMIT.limit; index += 1) {
      const allowed = await POST(jpegRequest("meal.jpg", "image/jpeg", headers));
      expect(allowed.status).toBe(200);
    }

    const blocked = await POST(jpegRequest("meal.jpg", "image/jpeg", headers));
    const body = await blocked.json();

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(body).toEqual({ error: { code: "rate_limited" } });
    expect(analyzeImage).toHaveBeenCalledTimes(ANALYZE_RATE_LIMIT.limit);
  });

  it("rejects an oversized multipart request before parsing the body", async () => {
    const response = await POST(
      new Request("http://localhost/api/analyze", {
        method: "POST",
        headers: { "content-length": String(11 * 1024 * 1024) },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body).toEqual({ error: { code: "file_too_large" } });
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});
