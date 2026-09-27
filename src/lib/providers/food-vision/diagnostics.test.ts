import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64ByteLength,
  extractOpenAIErrorDetails,
  logFoodVisionDiagnostic,
  logFoodVisionUsage,
  sanitizeDiagnosticMessage,
} from "./diagnostics";

describe("food-vision diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts API keys, bearer tokens and long base64 from messages", () => {
    const message = [
      "status 401 OPENAI_API_KEY=sk-proj-DummyValueForTestsOnly123456789",
      "Authorization: Bearer super-secret-token",
      "data: /9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    ].join(" ");

    const sanitized = sanitizeDiagnosticMessage(message);
    expect(sanitized).not.toMatch(/sk-proj-DummyValue/);
    expect(sanitized).not.toContain("super-secret-token");
    expect(sanitized).not.toContain("OPENAI_API_KEY=sk-");
    expect(sanitized).toContain("[redacted]");
  });

  it("extracts OpenAI HTTP status and error code from an SDK JSON payload", () => {
    const error = Object.assign(new Error(
      JSON.stringify({
        error: {
          code: 400,
          message: "Request contains an invalid parameter.",
          type: "invalid_request_error",
        },
      }),
    ), { name: "APIError", status: 400 });

    expect(extractOpenAIErrorDetails(error)).toMatchObject({
      errorClass: "APIError",
      httpStatus: 400,
      openaiErrorCode: "invalid_request_error",
      safeMessage: "Request contains an invalid parameter.",
    });
  });

  it("computes decoded image size from base64 without keeping the payload", () => {
    expect(base64ByteLength("YWJjZA==")).toBe(4);
    expect(base64ByteLength("")).toBe(0);
  });

  it("logs only the public-safe diagnostic fields", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    logFoodVisionDiagnostic({
      stage: "openai_request",
      errorClass: "APIError",
      httpStatus: 400,
      openaiErrorCode: "invalid_request_error",
      safeMessage: "Request contains an invalid parameter.",
      model: "gpt-5.6-luna",
      imageMimeType: "image/jpeg",
      imageByteSize: 2048,
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toBe("[kcalcue:food-vision]");
    expect(spy.mock.calls[0]?.[1]).toEqual({
      stage: "openai_request",
      errorClass: "APIError",
      httpStatus: 400,
      openaiErrorCode: "invalid_request_error",
      safeMessage: "Request contains an invalid parameter.",
      model: "gpt-5.6-luna",
      imageMimeType: "image/jpeg",
      imageByteSize: 2048,
    });
    expect(JSON.stringify(spy.mock.calls[0])).not.toMatch(/sk-|input_image|authorization/i);
  });

  it("logs only bounded model labels and nonnegative token counts", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logFoodVisionUsage({
      requestedModel: "gpt-6-sol",
      reportedModel: "gpt-sk-proj-DummySecretValueForTestsOnly123456789",
      analysisVersion: "food-vision-v2",
      foodVisionMs: 125.6,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: -1 },
        output_tokens: 42,
        total_tokens: Number.POSITIVE_INFINITY,
      },
    });
    expect(spy).toHaveBeenCalledExactlyOnceWith("[kcalcue:food-vision-usage]", {
      stage: "provider_response",
      requestedModel: "gpt-6-sol",
      reportedModel: null,
      analysisVersion: "food-vision-v2",
      inputTokens: 100,
      cachedInputTokens: null,
      outputTokens: 42,
      totalTokens: null,
      foodVisionMs: 126,
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("DummySecretValueForTestsOnly");
  });

  it("does not log unknown model suffixes that could contain private IDs", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logFoodVisionUsage({
      requestedModel: "gpt-6-sol-private-account-123",
      reportedModel: "gpt-6-sol-2026-09-28",
      analysisVersion: "food-vision-v2",
      foodVisionMs: 1,
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      requestedModel: null,
      reportedModel: "gpt-6-sol",
    });
  });
});
