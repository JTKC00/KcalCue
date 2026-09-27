/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyzeImage = vi.fn();
const authorize = vi.fn();
vi.mock("@/lib/server/auth", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/server/auth")>(), authenticated: (...args: unknown[]) => authorize(...args),
}));

vi.mock("@/lib/server/live-analysis-admission", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/server/live-analysis-admission")>(),
  acquireLiveAnalysis: vi.fn(),
}));

vi.mock("@/lib/server/durable-analysis-quota", () => ({
  reserveDailyLiveAnalysis: vi.fn(),
}));

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
import { acquireLiveAnalysis, createLiveAnalysisAdmission } from "@/lib/server/live-analysis-admission";
import { reserveDailyLiveAnalysis } from "@/lib/server/durable-analysis-quota";
import { POST } from "./route";
import { provenanceMetadata } from "@/test/provenance-fixture";

function imageRequest(
  bytes: Uint8Array,
  name = "meal.jpg",
  type = "image/jpeg",
  headers?: HeadersInit,
  attemptId?: string,
) {
  const form = new FormData();
  const blobBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(blobBytes).set(bytes);
  form.set("image", new File([blobBytes], name, { type }));
  if (attemptId !== undefined) form.set("attemptId", attemptId);
  return new Request("http://localhost/api/analyze", {
    method: "POST",
    headers,
    body: form,
  });
}

function jpegRequest(name = "meal.jpg", type = "image/jpeg", headers?: HeadersInit, attemptId?: string) {
  return imageRequest(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), name, type, headers, attemptId);
}

function heifBytes(brand = "mif1"): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set([..."ftyp"].map((character) => character.charCodeAt(0)), 4);
  bytes.set([...brand].map((character) => character.charCodeAt(0)), 8);
  bytes.set([..."mif1"].map((character) => character.charCodeAt(0)), 16);
  return bytes;
}

function deferredAnalysis() {
  let resolve!: (analysis: typeof demoFoodAnalysis) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof demoFoodAnalysis>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function distinctIpRequest(index: number) {
  return jpegRequest("meal.jpg", "image/jpeg", {
    "x-forwarded-for": `198.51.100.${index}`,
    "x-user-id": `untrusted-user-${index}`,
  });
}

describe("POST /api/analyze", () => {
  beforeEach(() => {
    analyzeImage.mockReset();
    authorize.mockReset().mockResolvedValue({ db: { fixture: true }, user: { id: "test-user" } });
    vi.mocked(acquireLiveAnalysis).mockReset().mockImplementation(createLiveAnalysisAdmission());
    vi.mocked(reserveDailyLiveAnalysis).mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    clearRateLimitStore();
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("pauses paid analysis while preserving demo and account authorization", async () => {
    vi.stubEnv("KCALCUE_ANALYSIS_ENABLED", "false");
    const { HttpError } = await import("@/lib/server/auth");
    authorize.mockRejectedValueOnce(new HttpError(401, "login_required"));
    const unauthenticated = await POST(jpegRequest());
    expect(unauthenticated.status).toBe(401);
    expect((await unauthenticated.json()).error.code).toBe("login_required");
    const response = await POST(jpegRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("analysis_paused");
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(analyzeImage).not.toHaveBeenCalled();
    const form = new FormData(); form.set("mode", "demo");
    const demo = await POST(new Request("http://localhost/api/analyze", { method: "POST", body: form }));
    expect(demo.status).toBe(200);
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
    expect(authorize).not.toHaveBeenCalled();
    expect(acquireLiveAnalysis).not.toHaveBeenCalled();
    expect(reserveDailyLiveAnalysis).not.toHaveBeenCalled();
  });

  it("requires a verified account before live image analysis", async () => {
    const { HttpError } = await import("@/lib/server/auth");
    authorize.mockRejectedValueOnce(new HttpError(401, "login_required"));
    const response = await POST(jpegRequest());
    expect(response.status).toBe(401);
    expect(analyzeImage).not.toHaveBeenCalled();
    expect(acquireLiveAnalysis).not.toHaveBeenCalled();
    expect(reserveDailyLiveAnalysis).not.toHaveBeenCalled();
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
    expect(acquireLiveAnalysis).not.toHaveBeenCalled();
    expect(reserveDailyLiveAnalysis).not.toHaveBeenCalled();
  });

  it("returns a validated live analysis", async () => {
    analyzeImage.mockResolvedValueOnce(demoFoodAnalysis);

    const response = await POST(jpegRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("live");
    expect(body.analysis.analysisStatus).toBe("success");
    expect(reserveDailyLiveAnalysis).toHaveBeenCalledWith({ fixture: true }, "test-user", undefined, undefined, undefined);
    expect(analyzeImage).toHaveBeenCalledWith(
      {
        data: expect.any(String),
        mimeType: "image/jpeg",
      },
      { signal: expect.any(AbortSignal), onMetadata: expect.any(Function) },
    );
  });

  it("passes a validated attempt fingerprint and blocks a duplicate before the paid provider", async () => {
    const id = "9cded041-a32e-4f85-8d88-ff4ec9913ac7";
    analyzeImage.mockResolvedValue(demoFoodAnalysis);
    expect((await POST(jpegRequest("meal.jpg", "image/jpeg", undefined, id))).status).toBe(200);
    expect(reserveDailyLiveAnalysis).toHaveBeenCalledWith(
      { fixture: true }, "test-user", undefined, undefined,
      { id, imageDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    );
    vi.mocked(reserveDailyLiveAnalysis).mockResolvedValueOnce({
      allowed: false, retryAfterSeconds: 0, duplicate: "same",
    });
    const duplicate = await POST(jpegRequest("meal.jpg", "image/jpeg", undefined, id));
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe("analysis_outcome_unknown");
    expect(analyzeImage).toHaveBeenCalledOnce();
  });

  it("normalizes an uppercase UUID before reserving an attempt", async () => {
    const id = "9CDED041-A32E-4F85-8D88-FF4EC9913AC7";
    analyzeImage.mockResolvedValueOnce(demoFoodAnalysis);
    expect((await POST(jpegRequest("meal.jpg", "image/jpeg", undefined, id))).status).toBe(200);
    expect(reserveDailyLiveAnalysis).toHaveBeenCalledWith(
      { fixture: true }, "test-user", undefined, undefined,
      { id: id.toLowerCase(), imageDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    );
  });

  it("rejects invalid attempt IDs and same IDs reused for different images", async () => {
    const invalid = await POST(jpegRequest("meal.jpg", "image/jpeg", undefined, "not-a-uuid"));
    expect(invalid.status).toBe(400);
    expect(reserveDailyLiveAnalysis).not.toHaveBeenCalled();
    vi.mocked(reserveDailyLiveAnalysis).mockResolvedValueOnce({
      allowed: false, retryAfterSeconds: 0, duplicate: "mismatch",
    });
    const mismatch = await POST(jpegRequest("meal.jpg", "image/jpeg", undefined,
      "9cded041-a32e-4f85-8d88-ff4ec9913ac7"));
    expect(mismatch.status).toBe(400);
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("returns separate metadata only from the provider hook, with legacy providers remaining unknown", async () => {
    analyzeImage.mockImplementationOnce(async (_image, options) => {
      options.onMetadata(provenanceMetadata);
      return demoFoodAnalysis;
    });
    const response = await POST(jpegRequest());
    expect(await response.json()).toMatchObject({ analysis: demoFoodAnalysis, analysisProvenance: provenanceMetadata });
    analyzeImage.mockResolvedValueOnce(demoFoodAnalysis);
    expect((await (await POST(jpegRequest())).json()).analysisProvenance).toBeNull();
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
      { signal: expect.any(AbortSignal), onMetadata: expect.any(Function) },
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
      { signal: expect.any(AbortSignal), onMetadata: expect.any(Function) },
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
    expect(acquireLiveAnalysis).not.toHaveBeenCalled();
    expect(reserveDailyLiveAnalysis).not.toHaveBeenCalled();
  });

  it("returns a UTC-day retry window before invoking the provider when daily quota is exhausted", async () => {
    vi.mocked(reserveDailyLiveAnalysis).mockResolvedValueOnce({
      allowed: false,
      retryAfterSeconds: 3600,
    });

    const response = await POST(jpegRequest());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(await response.json()).toEqual({ error: { code: "rate_limited" } });
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("fails closed when Firestore cannot reserve the paid provider attempt", async () => {
    vi.mocked(reserveDailyLiveAnalysis).mockRejectedValueOnce(new Error("private firestore details"));
    const logged = vi.spyOn(console, "error");

    const response = await POST(jpegRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "service_unavailable" } });
    expect(analyzeImage).not.toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).toContain("[kcalcue:analysis-quota]");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private firestore details");
    expect((await POST(jpegRequest())).status).toBe(200);
  });

  it("shares verified UID quota across different IPs and ignores untrusted user headers", async () => {
    analyzeImage.mockResolvedValue(demoFoodAnalysis);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await POST(distinctIpRequest(attempt))).status).toBe(200);
    }
    const blocked = await POST(distinctIpRequest(5));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(await blocked.json()).toEqual({ error: { code: "rate_limited" } });
    expect(analyzeImage).toHaveBeenCalledTimes(5);
    expect(acquireLiveAnalysis).toHaveBeenCalledTimes(6);
    expect(vi.mocked(acquireLiveAnalysis).mock.calls.every(([uid]) => uid === "test-user")).toBe(true);
  });

  it("keeps another verified user's quota independent", async () => {
    analyzeImage.mockResolvedValue(demoFoodAnalysis);
    for (let attempt = 0; attempt < 5; attempt++) await POST(distinctIpRequest(attempt));
    authorize.mockResolvedValueOnce({ user: { id: "another-verified-user" } });
    expect((await POST(distinctIpRequest(5))).status).toBe(200);
    expect((await POST(distinctIpRequest(6))).status).toBe(429);
    expect(analyzeImage).toHaveBeenCalledTimes(6);
  });

  it("blocks simultaneous work for one UID while another UID can proceed, then releases after success", async () => {
    const pending = deferredAnalysis();
    analyzeImage.mockReturnValueOnce(pending.promise).mockResolvedValue(demoFoodAnalysis);
    const first = POST(distinctIpRequest(0));
    await vi.waitFor(() => expect(analyzeImage).toHaveBeenCalledOnce());
    expect((await POST(distinctIpRequest(1))).status).toBe(429);
    expect(analyzeImage).toHaveBeenCalledOnce();
    authorize.mockResolvedValueOnce({ user: { id: "another-verified-user" } });
    expect((await POST(distinctIpRequest(2))).status).toBe(200);
    pending.resolve(demoFoodAnalysis);
    expect((await first).status).toBe(200);
    expect((await POST(distinctIpRequest(3))).status).toBe(200);
    expect(analyzeImage).toHaveBeenCalledTimes(3);
  });

  it.each(["throw", "reject"])("releases after provider %s without refunding the attempt", async (failure) => {
    const error = new FoodVisionError("service_unavailable", "Synthetic provider failure");
    analyzeImage.mockImplementation(() => {
      if (failure === "throw") throw error;
      return Promise.reject(error);
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await POST(distinctIpRequest(attempt))).status).toBe(503);
    }
    expect((await POST(distinctIpRequest(5))).status).toBe(429);
    expect(analyzeImage).toHaveBeenCalledTimes(5);
  });

  it("keeps cancelled work reserved until the provider settles, then allows another attempt", async () => {
    const pending = deferredAnalysis();
    const controller = new AbortController();
    analyzeImage.mockReturnValueOnce(pending.promise).mockResolvedValue(demoFoodAnalysis);
    const first = POST(new Request(distinctIpRequest(0), { signal: controller.signal }));
    await vi.waitFor(() => expect(analyzeImage).toHaveBeenCalledOnce());
    controller.abort();
    expect(analyzeImage.mock.calls[0][1].signal.aborted).toBe(true);
    expect((await POST(distinctIpRequest(1))).status).toBe(429);
    expect(analyzeImage).toHaveBeenCalledOnce();
    pending.reject(new FoodVisionError("network_timeout", "Synthetic cancellation"));
    expect((await first).status).toBe(504);
    expect((await POST(distinctIpRequest(2))).status).toBe(200);
    expect(analyzeImage).toHaveBeenCalledTimes(2);
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
    expect(acquireLiveAnalysis).not.toHaveBeenCalled();
  });

  it.each([undefined, "8"])(
    "cancels oversized streamed multipart before parsing with content-length %s",
    async (contentLength) => {
      const parse = vi.spyOn(Response.prototype, "formData");
      const cancel = vi.fn();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(pulls === 1 ? 1 : 10 * 1024 * 1024 + 512 * 1024));
        },
        cancel,
      }, { highWaterMark: 0 });
      const headers = new Headers({ "content-type": "multipart/form-data; boundary=test" });
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      const response = await POST(new Request("http://localhost/api/analyze", {
        method: "POST", headers, body: stream, duplex: "half",
      } as RequestInit));

      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: { code: "file_too_large" } });
      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBe(2);
      expect(parse).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(analyzeImage).not.toHaveBeenCalled();
    },
  );

  it("accepts demo multipart exactly at the total byte cap", async () => {
    const prefix = Buffer.from('--test\r\nContent-Disposition: form-data; name="mode"\r\n\r\ndemo\r\n--test\r\nContent-Disposition: form-data; name="padding"; filename="padding.bin"\r\n\r\n');
    const suffix = Buffer.from("\r\n--test--\r\n");
    const limit = 10 * 1024 * 1024 + 512 * 1024;
    const bytes = Buffer.concat([prefix, Buffer.alloc(limit - prefix.length - suffix.length), suffix]);
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: bytes,
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).mode).toBe("demo");
    expect(authorize).not.toHaveBeenCalled();
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("returns a controlled error for malformed multipart", async () => {
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: "--test\r\nunfinished-private-input",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_file" } });
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("returns a controlled error for an interrupted input stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("private transport details")); },
    });
    const response = await POST(new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: stream,
      duplex: "half",
    } as RequestInit));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_file" } });
    expect(authorize).not.toHaveBeenCalled();
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});
